require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
    console.log('🌱 Starting database seed (JavaScript)...');

    // ==========================================
    // SILAKAN EDIT KREDENSIAL DI SINI:
    // ==========================================
    const defaultUsername = 'admin'; // Username untuk login ke Admin Panel
    const defaultPassword = 'admin123'; // Password untuk login ke Admin Panel
    const ownerWhatsAppNumber = '628xxxxxxxxxx'; // Ganti dengan nomor WhatsApp Anda (tanpa + atau @c.us) untuk menerima OTP dan otorisasi bot
    // ==========================================

    const passwordHash = await bcrypt.hash(defaultPassword, 12);

    const admin = await prisma.adminUser.upsert({
        where: { username: defaultUsername },
        update: {
            passwordHash,
        },
        create: {
            username: defaultUsername,
            passwordHash,
        },
    });

    console.log(`✅ Admin user created/updated: ${admin.username}`);

    // Buat WhatsApp owner jika ownerWhatsAppNumber berbentuk nomor HP/JID
    const ownerJid = ownerWhatsAppNumber.includes('@')
        ? ownerWhatsAppNumber
        : /^\d+$/.test(ownerWhatsAppNumber.replace(/\D/g, '')) && ownerWhatsAppNumber.replace(/\D/g, '').length >= 9
            ? `${ownerWhatsAppNumber.replace(/\D/g, '')}@c.us`
            : null;

    if (ownerJid) {
        const user = await prisma.user.upsert({
            where: { whatsappId: ownerJid },
            update: {
                role: 'owner',
            },
            create: {
                whatsappId: ownerJid,
                name: 'Owner (Auto-seeded)',
                role: 'owner',
            },
        });
        console.log(`✅ WhatsApp owner created/updated: ${user.whatsappId}`);
    } else {
        console.log(`⚠️  Skip seeding default WhatsApp owner: Username "${ownerWhatsAppNumber}" is not a valid phone number/JID.`);
    }

    console.log(`⚠️  Silakan login dengan kredensial di atas!`);
}

main()
    .catch((err) => {
        console.error('❌ Seed failed:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
