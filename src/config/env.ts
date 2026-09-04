import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
    hermesApiUrl: string;
    hermesApiKey: string;
    hermesSecret: string;
    expressPort: number;
    jwtSecret: string;
    allowedOrigin: string;
    logRetentionDays: number;
}

export function loadConfig(): AppConfig {
    const required = [
        'HERMES_API_URL',
        'HERMES_API_KEY',
        'HERMES_SECRET',
        'EXPRESS_PORT',
        'JWT_SECRET',
        'DATABASE_URL',
    ];

    for (const key of required) {
        if (!process.env[key]) {
            throw new Error(`Missing required env variable: ${key}`);
        }
    }

    return {
        hermesApiUrl: process.env.HERMES_API_URL!,
        hermesApiKey: process.env.HERMES_API_KEY!,
        hermesSecret: process.env.HERMES_SECRET!,
        expressPort: parseInt(process.env.EXPRESS_PORT!, 10) || 4849,
        jwtSecret: process.env.JWT_SECRET!,
        allowedOrigin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
        logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
    };
}
