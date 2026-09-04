// In-Memory Rate Limiter & Message Deduplication
// Zero-dependency, super cepat (0.001ms), dan otomatis membersihkan memori yang expired.

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // window 1 menit
const RATE_LIMIT_MAX_REQUESTS = 10;     // maks 10 pesan per user per menit
const DEDUP_TTL_MS = 30 * 1000;         // TTL deduplikasi 30 detik

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const seenMessages = new Map<string, number>();

// Pembersihan berkala setiap 1 menit agar memory tetap bersih
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
        if (now > entry.resetAt) {
            rateLimitMap.delete(key);
        }
    }
    for (const [key, expiresAt] of seenMessages.entries()) {
        if (now > expiresAt) {
            seenMessages.delete(key);
        }
    }
}, 60 * 1000).unref();

/**
 * Cek apakah senderId masih dalam batas rate limit.
 * @returns true jika masih diizinkan, false jika melebihi batas
 */
export async function checkRateLimit(senderId: string): Promise<boolean> {
    const now = Date.now();
    const entry = rateLimitMap.get(senderId);

    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(senderId, {
            count: 1,
            resetAt: now + RATE_LIMIT_WINDOW_MS,
        });
        return true;
    }

    entry.count += 1;
    if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
        console.warn(`[RateLimit] BLOCKED — sender=${senderId} count=${entry.count}/${RATE_LIMIT_MAX_REQUESTS} per 60s`);
        return false;
    }

    return true;
}

/**
 * Cek duplikasi pesan (cegah pesan yang sama diproses dua kali).
 * @returns true jika pesan baru (boleh diproses), false jika duplikat
 */
export async function checkDedup(messageId: string): Promise<boolean> {
    const now = Date.now();
    const expiresAt = seenMessages.get(messageId);

    if (expiresAt && now < expiresAt) {
        console.warn(`[Dedup] DUPLICATE message detected, dropping: msgId=${messageId}`);
        return false;
    }

    seenMessages.set(messageId, now + DEDUP_TTL_MS);
    return true;
}
