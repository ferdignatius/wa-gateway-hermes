import http from 'http';
import { loadConfig, isOwner, isAllowedUser, isGroupAllowed } from './config/env';
import { client, initClient } from './wa/client';
import { shouldProcessDM, shouldProcessGroup } from './wa/filters';
import { enqueue } from './queue/messageQueue';
import { callHermes } from './hermes/adapter';
import { HermesPayload } from './hermes/types';
import { sendReply, startTypingLoop } from './wa/reply';
import { createExpressApp } from './server/pushEndpoint';
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
        const botNumber = client.info.wid.user;

        console.log(
            `[MSG] from=${message.from} isGroup=${isGroup} ` +
            `fromMe=${message.fromMe} body="${(message.body || '').slice(0, 50)}"`
        );

        if (isGroup) {
            // ── GROUP FLOW ──────────────────────────────────────────────
            // 1. Cek apakah grup ini diizinkan (Allowed Company / Group)
            if (!isGroupAllowed(chat.id._serialized)) {
                return;
            }

            const senderId = message.author || message.from || '';

            // 2. Resolusi contact untuk mendapatkan nomor telepon aktual
            let contact = await message.getContact().catch(() => null);
            const contactNumber = contact?.number ? `${contact.number}@c.us` : '';
            const checkSenderId = contactNumber || senderId;

            // 3. Cek apakah pengirim diizinkan (Allowed User: Owner atau terdaftar di ALLOWED_USERS)
            if (!isAllowedUser(checkSenderId)) {
                return;
            }

            // 4. Cek apakah nomor bot di-tag / di-mention atau pesan me-reply bot
            const result = await shouldProcessGroup(message, botId, botNumber);
            if (!result.process) return;

            // Role: Owner jika terdaftar di OWNER_NUMBER, selain itu Member
            const userRole: 'owner' | 'member' = isOwner(checkSenderId) ? 'owner' : 'member';
            const senderName = contact?.pushname || contact?.name || checkSenderId;

            console.log(`[GROUP] TAGGED in "${chat.name}" by ${checkSenderId} (${senderName}) role=${userRole}`);

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

                try {
                    // Refresh contact jika sebelumnya belum didapatkan
                    if (!contact) {
                        contact = await message.getContact().catch(() => null);
                    }
                    const activeSenderName = contact?.pushname || contact?.name || senderName;

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
                        sender: checkSenderId,
                        sender_name: activeSenderName,
                        role: userRole,
                        message: messageText,
                    };

                    const response = await callHermes(payload);
                    replyText = response.reply;
                    stopTyping();
                    await sendReply(chat, message, response.reply, true);
                    console.log(`[GROUP REPLY] to="${activeSenderName}" in="${chat.name}": "${replyText.slice(0, 80)}"`);
                } catch (err: any) {
                    stopTyping();
                    console.error('[GROUP ERROR]', err.message);
                    const errMsg = err.code === 'ECONNABORTED'
                        ? '⏳ Maaf, request timeout. Coba lagi nanti.'
                        : '❌ Terjadi kesalahan saat memproses pesan.';
                    replyText = errMsg;
                    await message.reply(errMsg).catch(() => {});
                } finally {
                    stopTyping();
                }
            });

        } else {
            // ── DM FLOW ─────────────────────────────────────────────────
            if (!shouldProcessDM(message)) return;

            const senderId = message.from;

            // Resolusi contact untuk DM
            let contact = await message.getContact().catch(() => null);
            const contactNumber = contact?.number ? `${contact.number}@c.us` : '';
            const checkSenderId = contactNumber || senderId;

            // Hanya owner yang dilayani di DM
            if (!isOwner(checkSenderId)) {
                console.log(`[DM] DROPPED — sender ${checkSenderId} is not configured as owner`);
                return;
            }

            const senderName = contact?.pushname || contact?.name || 'Owner';
            console.log(`[DM] sender=${checkSenderId} (${senderName}) role=owner`);

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
                        sender: checkSenderId,
                        sender_name: senderName,
                        role: 'owner',
                        message: messageText,
                    };

                    const response = await callHermes(payload);
                    replyText = response.reply;
                    stopTyping();
                    await sendReply(chat, null, response.reply, false);
                    console.log(`[DM REPLY] to="${senderName}": "${replyText.slice(0, 80)}"`);
                } catch (err: any) {
                    stopTyping();
                    console.error('[DM ERROR]', err.message);
                    const errMsg = err.code === 'ECONNABORTED'
                        ? '⏳ Maaf, request timeout. Coba lagi nanti.'
                        : '❌ Terjadi kesalahan saat memproses pesan.';
                    replyText = errMsg;
                    await chat.sendMessage(errMsg).catch(() => {});
                } finally {
                    stopTyping();
                }
            });
        }
    });

    // 3. Buat HTTP server (Express REST API: /health, /send)
    const expressApp = createExpressApp(client);
    const httpServer = http.createServer(expressApp);

    httpServer.listen(config.expressPort, () => {
        console.log(`[Server] HTTP running on port ${config.expressPort}`);
    });

    // 4. Graceful shutdown
    const shutdown = async () => {
        console.log('[Server] Shutting down gracefully...');
        await client.destroy().catch(() => {});
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[Fatal] Error during startup:', err);
    process.exit(1);
});
