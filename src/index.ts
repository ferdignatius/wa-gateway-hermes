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

// Interval untuk log pruning (hapus log > 30 hari)
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

            // 2. Cek apakah pengirim terdaftar di DB
            const user = await prisma.user.findUnique({ where: { whatsappId: senderId } });
            if (!user) {
                console.log(`[GROUP] DROPPED — sender ${senderId} not in DB`);
                return;
            }

            console.log(`[GROUP] chat="${chat.name}" sender=${senderId} role=${user.role}`);

            // ── Redis Guards ────────────────────────────────────────────
            const isNewMsg = await checkDedup(message.id._serialized);
            if (!isNewMsg) return;

            const allowed = await checkRateLimit(senderId);
            if (!allowed) {
                await message.reply('⏱️ Terlalu banyak pesan. Silakan tunggu sebentar.').catch(() => {});
                return;
            }

            enqueue(chat.id._serialized, async () => {
                const stopTyping = startTypingLoop(chat);
                let contact;
                let replyText = '';
                let logStatus = 'success';
                let logError: string | undefined;

                try {
                    contact = await message.getContact();
                    const senderName = contact.pushname || contact.name || senderId;

                    // Inject context quoted message jika ada
                    let messageText = result.cleanedBody;
                    if (message.hasQuotedMsg) {
                        const quoted = await message.getQuotedMessage();
                        const quotedContact = await quoted.getContact();
                        const quotedName = quotedContact.pushname || quotedContact.name || 'Unknown';
                        messageText = `[Replying to ${quotedName}: "${(quoted.body || '').slice(0, 500)}"]\n\n${messageText}`;
                    }

                    const payload: HermesPayload = {
                        source: 'whatsapp',
                        chat_type: 'group',
                        chat_id: chat.id._serialized,
                        chat_name: chat.name,
                        sender: senderId,
                        sender_name: senderName,
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
                    const senderName = contact?.pushname || contact?.name || senderId;
                    await prisma.activityLog.create({
                        data: {
                            sender: senderId,
                            senderName,
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

            // DB auth: hanya owner yang terdaftar yang bisa lanjut di DM
            const user = await prisma.user.findUnique({ where: { whatsappId: senderId } });
            if (!user || user.role !== 'owner') {
                console.log(`[DM] DROPPED — sender ${senderId} not in DB or role is not owner`);
                return;
            }

            console.log(`[DM] sender=${senderId} role=owner`);

            // ── Redis Guards ────────────────────────────────────────────
            const isNewDm = await checkDedup(message.id._serialized);
            if (!isNewDm) return;

            const dmAllowed = await checkRateLimit(senderId);
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
                        sender: senderId,
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
                            sender: senderId,
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

    // 4. Log pruning — hapus ActivityLog > 30 hari, jalankan setiap 24 jam
    setInterval(async () => {
        const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
        const { count } = await prisma.activityLog.deleteMany({
            where: { timestamp: { lt: cutoff } },
        });
        if (count > 0) {
            console.log(`[Log Pruner] Deleted ${count} old log entries (older than 30 days)`);
        }
    }, 24 * 60 * 60 * 1000); // setiap 24 jam

    // 5. Graceful shutdown
    const shutdown = async () => {
        console.log('[Server] Shutting down gracefully...');
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
