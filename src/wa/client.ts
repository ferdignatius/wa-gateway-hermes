import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from 'qrcode-terminal';
import { broadcast, setWaStatus, setLatestQr } from '../server/adminRouter';

// Static Desktop Chrome userAgent — mencegah fingerprinting/ban
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth',
    }),
    puppeteer: {
        // executablePath: path Chromium di Ubuntu Docker, fallback ke env var untuk dev lokal
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',  // penting di Docker
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--no-zygote',              // stabilitas di environment tanpa display
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--mute-audio',
            '--disable-accelerated-2d-canvas',
        ],
    },
    webVersionCache: {
        type: 'local',
    },
    userAgent: DESKTOP_UA,
});

export async function initClient(maxRetries: number = 5): Promise<void> {
    client.on('qr', (qr) => {
        console.log('[WA] QR Code generated — waiting for scan...');
        qrcode.generate(qr, { small: true });
        setWaStatus('qr');
        setLatestQr(qr);
        broadcast({ type: 'qr', data: qr });
        broadcast({ type: 'status', data: 'qr' });
    });

    client.on('ready', () => {
        console.log('[WA] Client ready!');
        setWaStatus('connected');
        broadcast({ type: 'status', data: 'connected' });
    });

    client.on('auth_failure', (err) => {
        console.error('[WA] Auth failure:', err);
        setWaStatus('disconnected');
        broadcast({ type: 'status', data: 'auth_failure' });
        process.exit(1);
    });

    client.on('disconnected', async (reason) => {
        console.error('[WA] Client disconnected:', reason);
        setWaStatus('disconnected');
        broadcast({ type: 'status', data: 'disconnected' });
        console.log('[WA] Cleaning up and reconnecting in 5s...');
        try {
            await client.destroy();
        } catch {
            // ignore cleanup error
        }
        setTimeout(() => {
            client.initialize().catch(e => {
                console.error('[WA] Reconnect failed:', e.message);
            });
        }, 5000);
    });

    // Retry initialize — WA Web kadang reload page saat startup
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await client.initialize();
            return; // sukses
        } catch (err: any) {
            const isRecoverable =
                err.message?.includes('Execution context was destroyed') ||
                err.message?.includes('Protocol error') ||
                err.message?.includes('browser is already running');

            if (isRecoverable && attempt < maxRetries) {
                console.warn(`[WA] Init attempt ${attempt}/${maxRetries} failed, retrying in 10s...`);
                try { await client.destroy(); } catch { /* ignore */ }
                await new Promise(resolve => setTimeout(resolve, 10000));
            } else {
                throw err;
            }
        }
    }
}

// Catch unhandled Puppeteer/navigation errors agar app tidak crash di runtime
process.on('unhandledRejection', (reason: any) => {
    if (
        reason?.message?.includes('Execution context was destroyed') ||
        reason?.message?.includes('Protocol error') ||
        reason?.message?.includes('navigation')
    ) {
        console.warn('[WA] Page navigated, ignoring error');
    } else {
        console.error('[WA] Unhandled rejection:', reason);
    }
});

export { client };
