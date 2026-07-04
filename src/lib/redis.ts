import Redis from 'ioredis';

// Singleton Redis client — satu koneksi dipakai di seluruh aplikasi
const globalForRedis = globalThis as unknown as { redis: Redis | undefined };

function createRedisClient(): Redis {
    const redisUrl = process.env.REDIS_URL;

    const client = redisUrl
        ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 })
        : new Redis({ host: 'localhost', port: 6379, lazyConnect: true, maxRetriesPerRequest: 3 });

    client.on('connect', () => console.log('[Redis] Connected to redis-queue'));
    client.on('error', (err) => console.error('[Redis] Connection error:', err.message));
    client.on('close', () => console.warn('[Redis] Connection closed'));

    return client;
}

export const redis = globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== 'production') {
    globalForRedis.redis = redis;
}
