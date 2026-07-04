import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { adminAuthMiddleware, AdminRequest } from './adminAuth';

const router = Router();

// ── In-memory rate limiters (tanpa dependency tambahan) ─────────────────────
// Map<username, last_request_timestamp_ms>
const otpCooldownMap = new Map<string, number>();
// Map<username, failed_attempt_count>
const otpAttemptMap = new Map<string, number>();

const OTP_COOLDOWN_MS = 60 * 1000;     // 1 menit antar permintaan OTP
const OTP_MAX_ATTEMPTS = 5;            // Maks 5 percobaan salah sebelum OTP hangus

// ── POST /admin/auth/login ──────────────────────────────────────────────────
router.post('/auth/login', async (req: Request, res: Response) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username dan password wajib diisi' });
        }

        const admin = await prisma.adminUser.findUnique({ where: { username } });
        if (!admin) {
            return res.status(401).json({ success: false, error: 'Username atau password salah' });
        }

        const isValid = await bcrypt.compare(password, admin.passwordHash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Username atau password salah' });
        }

        const token = jwt.sign(
            { adminId: admin.id },
            process.env.JWT_SECRET!,
            { expiresIn: '7d' }
        );

        return res.json({ success: true, token, username: admin.username });
    } catch (err: any) {
        console.error('[Admin] Login error:', err.message);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ── POST /admin/auth/forgot-password ─────────────────────────────────────────
router.post('/auth/forgot-password', async (req: Request, res: Response) => {
    // Respons generik — tidak membocorkan apakah username ada atau tidak
    const GENERIC_OK = { success: true, message: 'Jika username valid, kode OTP telah dikirim ke WhatsApp Owner.' };

    try {
        const { username } = req.body;

        if (!username) {
            return res.status(400).json({ success: false, error: 'Username wajib diisi' });
        }

        // ── Rate limit: 1 request per menit per username ─────────────────────
        const lastRequest = otpCooldownMap.get(username);
        if (lastRequest && Date.now() - lastRequest < OTP_COOLDOWN_MS) {
            const remainingSec = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - lastRequest)) / 1000);
            return res.status(429).json({
                success: false,
                error: `Terlalu sering meminta OTP. Coba lagi dalam ${remainingSec} detik.`
            });
        }

        // Cek diam-diam apakah username ada (tidak expose ke response error)
        const admin = await prisma.adminUser.findUnique({ where: { username } });
        if (!admin) {
            // Catat cooldown tetap berjalan agar tidak mudah di-enumerate
            otpCooldownMap.set(username, Date.now());
            return res.json(GENERIC_OK);
        }

        if (waStatus !== 'connected') {
            return res.status(400).json({
                success: false,
                error: 'WhatsApp bot saat ini belum terhubung. Silakan hubungkan WhatsApp terlebih dahulu.'
            });
        }

        // Cari nomor WhatsApp owner yang terdaftar
        const owners = await prisma.user.findMany({ where: { role: 'owner' } });
        if (owners.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Tidak ada nomor WhatsApp owner yang terdaftar di database untuk menerima OTP.'
            });
        }

        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // Berlaku 5 menit

        // Simpan OTP + reset attempt counter
        await prisma.adminUser.update({
            where: { username },
            data: { otpCode, otpExpiresAt },
        });
        otpAttemptMap.set(username, 0);
        otpCooldownMap.set(username, Date.now());

        // Kirim OTP ke semua nomor owner yang terdaftar
        const { client } = await import('../wa/client');
        for (const owner of owners) {
            try {
                await client.sendMessage(
                    owner.whatsappId,
                    `🔐 *[WA Gateway]*\n\nKode OTP reset password Admin Panel Anda adalah: *${otpCode}*\n\nKode ini berlaku selama 5 menit. Jangan bagikan kode ini kepada siapapun.`
                );
            } catch (sendErr: any) {
                console.error(`[Admin] Gagal mengirim OTP ke ${owner.whatsappId}:`, sendErr.message);
            }
        }

        return res.json(GENERIC_OK);
    } catch (err: any) {
        console.error('[Admin] Forgot password error:', err.message);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ── POST /admin/auth/reset-password ──────────────────────────────────────────
router.post('/auth/reset-password', async (req: Request, res: Response) => {
    try {
        const { username, otp, newPassword } = req.body;

        if (!username || !otp || !newPassword) {
            return res.status(400).json({ success: false, error: 'Username, OTP, dan password baru wajib diisi' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Password baru minimal harus 6 karakter' });
        }

        // ── Brute-force protection: maks 5 percobaan per OTP session ─────────
        const attempts = otpAttemptMap.get(username) ?? 0;
        if (attempts >= OTP_MAX_ATTEMPTS) {
            // Hanguskan OTP agar harus request ulang
            await prisma.adminUser.update({
                where: { username },
                data: { otpCode: null, otpExpiresAt: null },
            }).catch(() => {});
            otpAttemptMap.delete(username);
            otpCooldownMap.delete(username);
            return res.status(429).json({
                success: false,
                error: 'Terlalu banyak percobaan OTP yang salah. Silakan minta kode OTP baru.'
            });
        }

        const admin = await prisma.adminUser.findUnique({ where: { username } });
        if (!admin || !admin.otpCode || !admin.otpExpiresAt) {
            return res.status(400).json({ success: false, error: 'Permintaan reset tidak valid atau OTP belum dikirim' });
        }

        // Cek kedaluwarsa OTP
        if (new Date() > admin.otpExpiresAt) {
            otpAttemptMap.delete(username);
            otpCooldownMap.delete(username);
            return res.status(400).json({ success: false, error: 'Kode OTP sudah kedaluwarsa. Silakan minta kode baru.' });
        }

        // Cek kecocokan OTP — increment counter dulu sebelum bandingkan
        if (admin.otpCode !== otp) {
            otpAttemptMap.set(username, attempts + 1);
            const remaining = OTP_MAX_ATTEMPTS - (attempts + 1);
            return res.status(400).json({
                success: false,
                error: `Kode OTP salah. ${remaining} percobaan tersisa sebelum OTP hangus.`
            });
        }

        // Hash password baru
        const passwordHash = await bcrypt.hash(newPassword, 12);

        // Update password, bersihkan OTP, dan hapus counter
        await prisma.adminUser.update({
            where: { username },
            data: { passwordHash, otpCode: null, otpExpiresAt: null },
        });
        otpAttemptMap.delete(username);
        otpCooldownMap.delete(username);

        return res.json({ success: true, message: 'Password berhasil diubah. Silakan masuk menggunakan password baru.' });
    } catch (err: any) {
        console.error('[Admin] Reset password error:', err.message);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Status WA client disimpan in-memory, di-update dari client.ts
let waStatus: 'connecting' | 'connected' | 'disconnected' | 'qr' = 'connecting';
let latestQr: string | null = null;

export function setWaStatus(s: typeof waStatus) { 
    waStatus = s; 
    if (s !== 'qr') {
        latestQr = null;
    }
}
export function setLatestQr(qr: string | null) { latestQr = qr; }

// SSE Clients set & broadcast
interface SseClient {
    id: number;
    res: Response;
}

const sseClients = new Set<SseClient>();

export function broadcast(data: object): void {
    if (sseClients.size === 0) return;
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        client.res.write(message);
    }
}

// ── GET /admin/status/sse ───────────────────────────────────────────────────
router.get('/status/sse', (req: Request, res: Response) => {
    try {
        const token = req.query.token as string;
        if (!token) {
            res.status(401).json({ success: false, error: 'Token is required' });
            return;
        }

        jwt.verify(token, process.env.JWT_SECRET!);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        console.log(`[SSE] Client connected. Total: ${sseClients.size + 1}`);

        // Kirim status awal
        res.write(`data: ${JSON.stringify({ type: 'status', data: waStatus })}\n\n`);
        if (waStatus === 'qr' && latestQr) {
            res.write(`data: ${JSON.stringify({ type: 'qr', data: latestQr })}\n\n`);
        }

        const client = { id: Date.now(), res };
        sseClients.add(client);

        req.on('close', () => {
            sseClients.delete(client);
            console.log(`[SSE] Client disconnected. Total: ${sseClients.size}`);
        });
    } catch (err: any) {
        console.warn('[SSE] Unauthorized connection rejected:', err.message);
        res.status(401).json({ success: false, error: 'Unauthorized' });
    }
});

// ── Semua route di bawah ini wajib autentikasi ──────────────────────────────
router.use(adminAuthMiddleware as any);

// ── GET /admin/users ────────────────────────────────────────────────────────
router.get('/users', async (_req: AdminRequest, res: Response) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' },
        });
        return res.json({ success: true, data: users });
    } catch (err: any) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /admin/users ───────────────────────────────────────────────────────
router.post('/users', async (req: AdminRequest, res: Response) => {
    try {
        const { whatsappId, name, role } = req.body;

        if (!whatsappId || !name || !role) {
            return res.status(400).json({ success: false, error: 'whatsappId, name, dan role wajib diisi' });
        }

        if (!['owner', 'member'].includes(role)) {
            return res.status(400).json({ success: false, error: 'role harus "owner" atau "member"' });
        }

        // Sanitasi whatsappId (JID):
        let sanitizedId = whatsappId.trim();
        // Jika hanya angka (nomor telepon biasa), bersihkan dan tambahkan @c.us
        if (/^\+?\d+$/.test(sanitizedId.replace(/\+/g, ''))) {
            sanitizedId = sanitizedId.replace(/\D/g, ''); // bersihkan non-angka
            if (sanitizedId.startsWith('0')) {
                sanitizedId = '62' + sanitizedId.slice(1);
            }
            sanitizedId = sanitizedId + '@c.us';
        }

        const user = await prisma.user.create({ data: { whatsappId: sanitizedId, name, role } });
        return res.status(201).json({ success: true, data: user });
    } catch (err: any) {
        if (err.code === 'P2002') {
            return res.status(409).json({ success: false, error: 'WhatsApp ID sudah terdaftar' });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── PATCH /admin/users/:id ──────────────────────────────────────────────────
router.patch('/users/:id', async (req: AdminRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { name, role } = req.body;

        if (role && !['owner', 'member'].includes(role)) {
            return res.status(400).json({ success: false, error: 'role harus "owner" atau "member"' });
        }

        const user = await prisma.user.update({
            where: { id: String(id) },
            data: {
                ...(name !== undefined && { name: name as string }),
                ...(role !== undefined && { role: role as Role }),
            },
        });

        return res.json({ success: true, data: user });
    } catch (err: any) {
        if (err.code === 'P2025') {
            return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── DELETE /admin/users/:id ─────────────────────────────────────────────────
router.delete('/users/:id', async (req: AdminRequest, res: Response) => {
    try {
        const { id } = req.params;
        await prisma.user.delete({ where: { id: String(id) } });
        return res.json({ success: true });
    } catch (err: any) {
        if (err.code === 'P2025') {
            return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /admin/groups ───────────────────────────────────────────────────────
router.get('/groups', async (_req: AdminRequest, res: Response) => {
    try {
        const groups = await prisma.allowedGroup.findMany({
            orderBy: { createdAt: 'desc' },
        });
        return res.json({ success: true, data: groups });
    } catch (err: any) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /admin/groups ──────────────────────────────────────────────────────
router.post('/groups', async (req: AdminRequest, res: Response) => {
    try {
        const { groupId, name } = req.body;

        if (!groupId || !name) {
            return res.status(400).json({ success: false, error: 'groupId dan name wajib diisi' });
        }

        let sanitizedGroupId = groupId.trim();
        // Jika hanya angka (ID grup mentah), tambahkan @g.us otomatis
        if (/^\d+$/.test(sanitizedGroupId)) {
            sanitizedGroupId = sanitizedGroupId + '@g.us';
        }

        const group = await prisma.allowedGroup.create({
            data: { groupId: sanitizedGroupId, name },
        });
        return res.status(201).json({ success: true, data: group });
    } catch (err: any) {
        if (err.code === 'P2002') {
            return res.status(409).json({ success: false, error: 'Group ID sudah terdaftar' });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── DELETE /admin/groups/:id ────────────────────────────────────────────────
router.delete('/groups/:id', async (req: AdminRequest, res: Response) => {
    try {
        const { id } = req.params;
        await prisma.allowedGroup.delete({ where: { id: String(id) } });
        return res.json({ success: true });
    } catch (err: any) {
        if (err.code === 'P2025') {
            return res.status(404).json({ success: false, error: 'Grup tidak ditemukan' });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /admin/logs ─────────────────────────────────────────────────────────
router.get('/logs', async (req: AdminRequest, res: Response) => {
    try {
        const {
            sender,
            chatName,
            status,
            isGroup,
            page = '1',
            limit = '50',
        } = req.query;

        const senderStr = Array.isArray(sender) ? sender[0] : sender as string | undefined;
        const chatNameStr = Array.isArray(chatName) ? chatName[0] : chatName as string | undefined;
        const statusStr = Array.isArray(status) ? status[0] : status as string | undefined;
        const isGroupStr = Array.isArray(isGroup) ? isGroup[0] : isGroup as string | undefined;
        const pageStr = Array.isArray(page) ? page[0] : (page as string) ?? '1';
        const limitStr = Array.isArray(limit) ? limit[0] : (limit as string) ?? '50';

        const pageNum = parseInt(String(pageStr ?? '1'), 10);
        const limitNum = parseInt(String(limitStr ?? '50'), 10);
        const skip = (pageNum - 1) * limitNum;

        const where: any = {};
        if (senderStr) where.sender = { contains: senderStr };
        if (chatNameStr) where.chatName = { contains: chatNameStr, mode: 'insensitive' };
        if (statusStr) where.status = statusStr;
        if (isGroupStr !== undefined) where.isGroup = isGroupStr === 'true';

        const [logs, total] = await Promise.all([
            prisma.activityLog.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                skip,
                take: limitNum,
            }),
            prisma.activityLog.count({ where }),
        ]);

        return res.json({
            success: true,
            data: logs,
            total,
            page: pageNum,
            limit: limitNum,
        });
    } catch (err: any) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /admin/status ───────────────────────────────────────────────────────
router.get('/status', async (_req: AdminRequest, res: Response) => {
    return res.json({ success: true, data: { waStatus, qrCode: latestQr } });
});

export default router;
