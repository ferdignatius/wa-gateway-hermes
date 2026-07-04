import { redis } from '../lib/redis';

// Rate limiter berbasis Redis sliding window
// Mencegah satu user spam ke Hermes AI terlalu cepat

const RATE_LIMIT_WINDOW_SEC = 60;   // window 1 menit
const RATE_LIMIT_MAX_REQUESTS = 10; // maks 10 pesan per user per menit

/**
 * Cek apakah senderId masih dalam batas rate limit.
 * Menggunakan pola Redis INCR + EXPIRE (atomic sliding counter).
 *
 * @returns true jika masih allowed, false jika sudah exceeded
 */
export async function checkRateLimit(senderId: string): Promise<boolean> {
    const key = `ratelimit:${senderId}`;

    try {
        const current = await redis.incr(key);

        // Set expiry hanya saat pertama kali key dibuat
        if (current === 1) {
            await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
        }

        if (current > RATE_LIMIT_MAX_REQUESTS) {
            console.warn(`[RateLimit] BLOCKED — sender=${senderId} count=${current}/${RATE_LIMIT_MAX_REQUESTS} per ${RATE_LIMIT_WINDOW_SEC}s`);
            return false;
        }

        return true;
    } catch (err: any) {
        // Jika Redis tidak tersedia, fallthrough agar tidak memblokir pesan
        console.error('[RateLimit] Redis error, bypassing rate limit:', err.message);
        return true;
    }
}

/**
 * Cek duplikasi pesan — cegah pesan yang sama diproses dua kali
 * dalam window waktu tertentu (berguna saat reconnect / event duplikat dari WA).
 *
 * @returns true jika pesan baru (boleh diproses), false jika duplikat
 */
export async function checkDedup(messageId: string): Promise<boolean> {
    const key = `dedup:${messageId}`;

    try {
        // SET NX (only set if not exists) dengan TTL 30 detik
        const result = await redis.set(key, '1', 'EX', 30, 'NX');

        if (result === null) {
            console.warn(`[Dedup] DUPLICATE message detected, dropping: msgId=${messageId}`);
            return false;
        }

        return true;
    } catch (err: any) {
        // Jika Redis tidak tersedia, fallthrough agar tidak memblokir pesan
        console.error('[Dedup] Redis error, bypassing dedup:', err.message);
        return true;
    }
}
