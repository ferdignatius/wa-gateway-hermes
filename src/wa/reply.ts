import { Chat, Message } from "whatsapp-web.js";

/**
 * Typing loop — refresh typing indicator tiap 20 detik.
 * WA typing indicator expires ~25s, kita refresh tiap 20s.
 * Returns stop function.
 */
export function startTypingLoop(chat: Chat): () => void {
    let active = true;
    let timer: NodeJS.Timeout | null = null;

    const loop = async () => {
        while (active) {
            try {
                await chat.sendStateTyping();
            } catch {
                // ignore typing errors — kadang terjadi saat reconnect
            }
            if (!active) break;
            await new Promise<void>(resolve => {
                timer = setTimeout(() => {
                    timer = null;
                    resolve();
                }, 20000);
            });
        }
    };

    loop();
    return () => {
        active = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
}

/**
 * Split pesan panjang di newline boundary.
 * Agar tidak melebihi batas karakter WA.
 */
export function splitMessage(text: string, maxLength: number = 2000): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex === 0) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex).replace(/^\n/, '');
    }
    return chunks;
}

/**
 * Anti-ban human behavior reply:
 * 1. Delay random 1500ms - 4000ms (sebelum mulai balas)
 * 2. Kirim pesan (split jika melebihi limit karakter)
 * 3. Delay kecil antar chunk jika ada banyak bagian
 */
export async function sendReply(
    chat: Chat,
    message: Message | null,
    text: string,
    quoted: boolean = false
): Promise<void> {
    const chunks = splitMessage(text);

    // Human-like delay sebelum membalas (anti-ban)
    const delay = 1500 + Math.random() * 2500; // 1500ms - 4000ms
    await new Promise(resolve => setTimeout(resolve, delay));

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (quoted && message) {
            await message.reply(chunk);
        } else {
            await chat.sendMessage(chunk);
        }

        // Delay kecil antar chunk jika ada multiple bagian
        if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
        }
    }
}