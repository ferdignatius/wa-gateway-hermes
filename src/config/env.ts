import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
    hermesApiUrl: string;
    hermesApiKey: string;
    hermesSecret: string;
    expressPort: number;
    ownerNumbers: string[];
    allowedGroups: string[];
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
    if (cachedConfig) {
        return cachedConfig;
    }

    const required = [
        'HERMES_API_URL',
        'HERMES_API_KEY',
        'HERMES_SECRET',
        'EXPRESS_PORT',
        'OWNER_NUMBER',
    ];

    for (const key of required) {
        if (!process.env[key]) {
            throw new Error(`Missing required env variable: ${key}`);
        }
    }

    const rawOwners = process.env.OWNER_NUMBER || '';
    const ownerNumbers = rawOwners
        .split(',')
        .map(n => n.trim().replace(/\D/g, ''))
        .filter(Boolean);

    const rawGroups = process.env.ALLOWED_GROUPS || '';
    const allowedGroups = rawGroups
        .split(',')
        .map(g => g.trim())
        .filter(Boolean);

    cachedConfig = {
        hermesApiUrl: process.env.HERMES_API_URL!,
        hermesApiKey: process.env.HERMES_API_KEY!,
        hermesSecret: process.env.HERMES_SECRET!,
        expressPort: parseInt(process.env.EXPRESS_PORT!, 10) || 4849,
        ownerNumbers,
        allowedGroups,
    };

    return cachedConfig;
}

/**
 * Mengecek apakah pengirim (nomor HP atau JID) adalah Owner
 */
export function isOwner(senderId: string): boolean {
    const config = loadConfig();
    const cleanNumber = senderId.replace(/\D/g, '');
    return config.ownerNumbers.some(owner => cleanNumber.endsWith(owner) || owner.endsWith(cleanNumber));
}

/**
 * Mengecek apakah grup diizinkan berinteraksi dengan bot
 */
export function isGroupAllowed(groupId: string): boolean {
    const config = loadConfig();
    if (config.allowedGroups.length === 0 || config.allowedGroups.includes('*')) {
        return true;
    }
    return config.allowedGroups.includes(groupId);
}
