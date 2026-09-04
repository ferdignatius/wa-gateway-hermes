import http from 'http';
import { loadConfig } from './config/env';
import { client, initClient } from './wa/client';
import { shouldProcessDM, shouldProcessGroup } from './wa/filters';
import { enqueue } from './queue/messageQueue';
import { callHermes } from './hermes/adapter';
import { HermesPayload } from './hermes/types';
import { sendReply, startTypingLoop } from './wa/reply';
import { createExpressApp } from './server/pushEndpoint';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { checkRateLimit, checkDedup } from './lib/rateLimiter';


async function main() {
    const config = loadConfig();

    // 1. Init WA Client (Chromium headless)
    await initClient();

    // 2. Register message listener
    client.on('message_create', async (message) => {
        const chat = await message.getChat();
        const isGroup = chat.isGroup;
        const botId = client.info.wid._serialized;

        console.log(
            `[MSG] from=${message.from} isGroup=${isGroup} ` +
            `fromMe=${message.fromMe} body="${(message.body || '').slice(0, 50)}"`
        );

        if (isGroup) {
            // ── GROUP FLOW ──────────────────────────────────────────────
            const result = shouldProcessGroup(message, botId);
            if (!result.process) return;

            // 1. Cek apakah grup ini diperbolehkan
            const groupAllowed = await prisma.allowedGroup.findUnique({ where: { groupId: chat.id._serialized } });
            if (!groupAllowed) {
                console.log(`[GROUP] DROPPED — group ${chat.id._serialized} ("${chat.name}") not allowed in DB`);
                return;
            }

            const senderId = message.author || '';

            // 2. Resolusi contact untuk mendapatkan nomor telepon aktual (mengatasi masalah @lid vs @c.us)
            let contact = await message.getContact().catch(() => null);
            const contactNumber = contact?.number ? `${contact.number}@c.us` : '';

            // Cek apakah pengirim terdaftar di DB (cek via senderId maupun nomor telepon aktual)
            const user = await prisma.user.findFirst({
                where: {
                    OR: [
                        { whatsappId: senderId },
                        ...(contactNumber ? [{ whatsappId: contactNumber }] : []),
                    ],
                },
            });
            if (!user) {
                console.log(`[GROUP] DROPPED — sender ${senderId} (${contactNumber || 'unknown'}) not in DB`);
                return;
            }

            const senderName = contact?.pushname || contact?.name || user.name || senderId;
            console.log(`[GROUP] chat="${chat.name}" sender=${senderId} (${senderName}) role=${user.role}`);

            // ── Redis Guards ────────────────────────────────────────────
            const isNewMsg = await checkDedup(message.id._serialized);
            if (!isNewMsg) return;

            const rateLimitKey = contactNumber || senderId;
            const allowed = await checkRateLimit(rateLimitKey);
            if (!allowed) {
                await message.reply('⏱️ Terlalu banyak pesan. Silakan tunggu sebentar.').catch(() => {});
                return;
            }

            enqueue(chat.id._serialized, async () => {
                const stopTyping = startTypingLoop(chat);
                let replyText = '';
                let logStatus = 'success';
                let logError: string | undefined;

                try {
                    // Refresh contact jika sebelumnya belum didapatkan
                    if (!contact) {
                        contact = await message.getContact().catch(() => null);
                    }
                    const activeSenderName = contact?.pushname || contact?.name || user.name || senderId;

                    // Inject context quoted message jika ada
                    let messageText = result.cleanedBody;
                    if (message.hasQuotedMsg) {
                        const quoted = await message.getQuotedMessage();
                        const quotedContact = await quoted.getContact().catch(() => null);
                        const quotedName = quotedContact?.pushname || quotedContact?.name || 'Unknown';
                        messageText = `[Replying to ${quotedName}: "${(quoted.body || '').slice(0, 500)}"]\n\n${messageText}`;
                    }

                    const payload: HermesPayload = {
                        source: 'whatsapp',
                        chat_type: 'group',
                        chat_id: chat.id._serialized,
                        chat_name: chat.name,
                        sender: user.whatsappId,
                        sender_name: activeSenderName,
                        role: user.role,
                        message: messageText,
                    };

                    const response = await callHermes(payload);
                    replyText = response.reply;
                    stopTyping();
                    await sendReply(chat, message, response.reply, true);
                } catch (err: any) {
                    stopTyping();
                    logStatus = 'error';
                    logError = err.message;
                    const errMsg = err.code === 'ECONNABORTED'
                        ? '⏳ Maaf, request timeout. Coba lagi nanti.'
                        : '❌ Terjadi kesalahan saat memproses pesan.';
                    replyText = errMsg;
                    await message.reply(errMsg).catch(() => {});
                } finally {
                    stopTyping();
                    // Tulis ke activity log
                    const logSenderName = contact?.pushname || contact?.name || user.name || senderId;
                    await prisma.activityLog.create({
                        data: {
                            sender: user.whatsappId,
                            senderName: logSenderName,
                            chatId: chat.id._serialized,
                            chatName: chat.name,
                            isGroup: true,
                            message: result.cleanedBody,
                            reply: replyText,
                            status: logStatus,
                            errorMsg: logError,
                        },
                    }).catch(e => console.error('[Log] Failed to write activity log:', e.message));
                }
            });

        } else {
            // ── DM FLOW ─────────────────────────────────────────────────
            if (!shouldProcessDM(message)) return;

            const senderId = message.from;

            // Resolusi contact untuk DM
            let contact = await message.getContact().catch(() => null);
            const contactNumber = contact?.number ? `${contact.number}@c.us` : '';

            // DB auth: hanya owner yang terdaftar yang bisa lanjut di DM
            const user = await prisma.user.findFirst({
                where: {
                    OR: [
                        { whatsappId: senderId },
                        ...(contactNumber ? [{ whatsappId: contactNumber }] : []),
                    ],
                },
            });
            if (!user || user.role !== 'owner') {
                console.log(`[DM] DROPPED — sender ${senderId} (${contactNumber || 'unknown'}) not in DB or role is not owner`);
                return;
            }

            console.log(`[DM] sender=${senderId} role=owner`);

            // ── Redis Guards ────────────────────────────────────────────
            const isNewDm = await checkDedup(message.id._serialized);
            if (!isNewDm) return;

            const dmRateLimitKey = contactNumber || senderId;
            const dmAllowed = await checkRateLimit(dmRateLimitKey);
            if (!dmAllowed) {
                await chat.sendMessage('⏱️ Terlalu banyak pesan. Silakan tunggu sebentar.').catch(() => {});
                return;
            }

            enqueue(chat.id._serialized, async () => {
                const stopTyping = startTypingLoop(chat);
                let replyText = '';
                let logStatus = 'success';
                let logError: string | undefined;

                try {
                    // Inject context quoted message jika ada
                    let messageText = message.body;
                    if (message.hasQuotedMsg) {
                        const quoted = await message.getQuotedMessage();
                        messageText = `[Replying to: "${(quoted.body || '').slice(0, 500)}"]\n\n${messageText}`;
                    }

                    const payload: HermesPayload = {
                        source: 'whatsapp',
                        chat_type: 'dm',
                        chat_id: chat.id._serialized,
                        sender: user.whatsappId,
                        sender_name: user.name,
                        role: user.role,
                        message: messageText,
                    };

                    const response = await callHermes(payload);
                    replyText = response.reply;
                    stopTyping();
                    await sendReply(chat, null, response.reply, false);
                } catch (err: any) {
                    stopTyping();
                    logStatus = 'error';
                    logError = err.message;
                    const errMsg = err.code === 'ECONNABORTED'
                        ? '⏳ Maaf, request timeout. Coba lagi nanti.'
                        : '❌ Terjadi kesalahan saat memproses pesan.';
                    replyText = errMsg;
                    await chat.sendMessage(errMsg).catch(() => {});
                } finally {
                    stopTyping();
                    await prisma.activityLog.create({
                        data: {
                            sender: user.whatsappId,
                            senderName: user.name,
                            chatId: chat.id._serialized,
                            chatName: user.name,
                            isGroup: false,
                            message: message.body,
                            reply: replyText,
                            status: logStatus,
                            errorMsg: logError,
                        },
                    }).catch(e => console.error('[Log] Failed to write activity log:', e.message));
                }
            });
        }
    });

    // 3. Buat HTTP server (Express REST API + SSE di port yang sama)
    const expressApp = createExpressApp(client);
    const httpServer = http.createServer(expressApp);

    httpServer.listen(config.expressPort, () => {
        console.log(`[Server] HTTP running on port ${config.expressPort} (with SSE support)`);
    });

    // 4. Log pruning — hapus ActivityLog > N hari (default: 30 hari / 1 bulan)
    const retentionMs = config.logRetentionDays * 24 * 60 * 60 * 1000;
    const pruneOldLogs = async () => {
        try {
            const cutoff = new Date(Date.now() - retentionMs);
            const { count } = await prisma.activityLog.deleteMany({
                where: { timestamp: { lt: cutoff } },
            });
            if (count > 0) {
                console.log(`[Log Pruner] Berhasil menghapus ${count} log lama (> ${config.logRetentionDays} hari)`);
            }
        } catch (err: any) {
            console.error('[Log Pruner] Gagal membersihkan log lama:', err.message);
        }
    };

    // Jalankan pembersihan langsung saat startup
    await pruneOldLogs();

    // Jadwalkan pembersihan otomatis berjalan setiap 24 jam
    const prunerInterval = setInterval(pruneOldLogs, 24 * 60 * 60 * 1000);

    // 5. Graceful shutdown
    const shutdown = async () => {
        console.log('[Server] Shutting down gracefully...');
        clearInterval(prunerInterval);
        await client.destroy().catch(() => {});
        await prisma.$disconnect().catch(() => {});
        await redis.quit().catch(() => {});
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[Fatal] Error during startup:', err);
    process.exit(1);
});
