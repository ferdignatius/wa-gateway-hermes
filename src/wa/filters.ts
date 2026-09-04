import { Message } from "whatsapp-web.js";

/**
 * DM filter — hanya drop kalau:
 * - Pesan dari bot sendiri (fromMe)
 * - Status broadcast
 * - Tipe data bukan string
 */
export function shouldProcessDM(message: Message): boolean {
    if (message.fromMe) return false;
    if (message.from === 'status@broadcast') return false;
    if (typeof message.body !== 'string') return false;
    return true;
}

/**
 * Group filter — proses hanya jika nomor bot di-tag/mention atau pesan me-reply bot.
 * Anti-loop: drop jika fromMe.
 */
export async function shouldProcessGroup(
    message: Message,
    botId: string,
    botNumber: string
): Promise<{ process: boolean; cleanedBody: string }> {
    // Anti bot-loop
    if (message.fromMe) return { process: false, cleanedBody: '' };

    // Proteksi tipe data body
    if (typeof message.body !== 'string') return { process: false, cleanedBody: '' };

    const cleanBotNumber = botNumber.replace(/\D/g, '');
    let isTagged = false;

    // 1. Cek WhatsApp native mentionedIds (@user)
    const mentionedIds = message.mentionedIds || [];
    if (
        mentionedIds.includes(botId) ||
        mentionedIds.some(id => id.replace(/\D/g, '').endsWith(cleanBotNumber))
    ) {
        isTagged = true;
    }

    // 2. Cek apakah teks pesan mengandung mention nomor bot
    if (!isTagged && cleanBotNumber) {
        const mentionTextRegex = new RegExp(`@${cleanBotNumber}\\b`, 'i');
        if (mentionTextRegex.test(message.body)) {
            isTagged = true;
        }
    }

    // 3. Cek apakah pesan merupakan reply terhadap pesan dari bot
    if (!isTagged && message.hasQuotedMsg) {
        try {
            const quoted = await message.getQuotedMessage();
            if (quoted) {
                const quotedAuthor = quoted.author || quoted.from || '';
                if (
                    quoted.fromMe ||
                    quotedAuthor === botId ||
                    quotedAuthor.replace(/\D/g, '').endsWith(cleanBotNumber)
                ) {
                    isTagged = true;
                }
            }
        } catch {
            // Abaikan error fetch quoted message
        }
    }

    if (!isTagged) {
        return { process: false, cleanedBody: '' };
    }

    // Bersihkan teks tag mention bot dari body pesan
    let cleanedBody = message.body;
    if (cleanBotNumber) {
        const removeMentionRegex = new RegExp(`@${cleanBotNumber}\\s*`, 'gi');
        cleanedBody = cleanedBody.replace(removeMentionRegex, '');
    }
    cleanedBody = cleanedBody.trim();

    // Jika pesan hanya tag bot kosong tanpa pertanyaan
    if (!cleanedBody) {
        cleanedBody = 'Halo! Ada yang bisa saya bantu?';
    }

    return { process: true, cleanedBody };
}