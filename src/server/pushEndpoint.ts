import express, { Express, Request, Response } from 'express';
import { Client } from 'whatsapp-web.js';
import { loadConfig } from '../config/env';
import { splitMessage } from '../wa/reply';

const config = loadConfig();

/**
 * Express app untuk:
 * - GET /health — Healthcheck endpoint
 * - POST /send — Hermes push endpoint (outbound WA dari Hermes Agent)
 */
export function createExpressApp(client: Client): Express {
    const app = express();

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

    return app;
}
