import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { Client } from 'whatsapp-web.js';
import { loadConfig } from '../config/env';
import { splitMessage } from '../wa/reply';
import adminRouter from './adminRouter';

const config = loadConfig();

/**
 * Buat Express app dengan:
 * - CORS yang dibatasi ke ALLOWED_ORIGIN
 * - POST /send — Hermes push endpoint (outbound WA)
 * - /admin/* — Admin REST API (CRUD users, logs, status)
 */
export function createExpressApp(client: Client): Express {
    const app = express();

    // CORS — hanya izinkan origin dari Admin Panel yang terdaftar
    const allowedOrigins = config.allowedOrigin.split(',').map(o => o.trim());

    app.use(cors({
        origin: (origin, callback) => {
            if (!origin) {
                return callback(null, true);
            }

            const isAllowed = allowedOrigins.some(allowedOpt => {
                if (allowedOpt === '*') return true;
                try {
                    const allowedUrl = allowedOpt.startsWith('http://') || allowedOpt.startsWith('https://')
                        ? new URL(allowedOpt)
                        : new URL(`https://${allowedOpt}`);

                    const requestUrl = new URL(origin);
                    return requestUrl.origin === allowedUrl.origin;
                } catch {
                    return false;
                }
            });

            if (isAllowed) {
                callback(null, true);
            } else {
                callback(null, false);
            }
        },
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-hermes-secret'],
        credentials: true,
    }));

    app.use(express.json());

    // ── Health check ──────────────────────────────────────────────
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ── Hermes Push Endpoint (Outbound: Hermes → WA) ─────────────
    app.post('/send', async (req: Request, res: Response) => {
        const secret = req.headers['x-hermes-secret'];
        if (!secret || secret !== config.hermesSecret) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const { chat_id, message } = req.body;
        if (!chat_id || !message) {
            return res.status(400).json({ success: false, error: 'Missing chat_id or message' });
        }

        try {
            const chunks = splitMessage(String(message));
            for (const chunk of chunks) {
                await client.sendMessage(chat_id, chunk);
            }
            return res.status(200).json({ success: true });
        } catch (err: any) {
            console.error('[Push] Failed to send:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    // ── Admin API ─────────────────────────────────────────────────
    app.use('/admin', adminRouter);

    return app;
}
