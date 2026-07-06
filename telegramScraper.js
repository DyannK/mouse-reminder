const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const readline = require('readline');
const { loadConfig, saveConfig } = require('./configManager');

let client = null;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const askTerminal = (text) => new Promise((resolve) => rl.question(text, resolve));

async function initTelegramScraper(sock) {
    const config = loadConfig();
    
    const apiId = parseInt(config.telegramApiId, 10);
    const apiHash = config.telegramApiHash;
    const phoneNumber = config.telegramPhoneNumber;
    
    if (!apiId || !apiHash || !phoneNumber || apiHash.includes('ISI_')) {
        console.log('Modul Telegram dilewati karena data kredensial di config.json belum lengkap.');
        return;
    }

    const stringSession = new StringSession(config.telegramSessionStr || '');
    
    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5
    });

    console.log('Mencoba menghubungkan sesi ke akun Telegram pasif...');
    
    await client.start({
        phoneNumber: async () => phoneNumber,
        password: async () => await askTerminal('Masukkan password cloud Telegram (jika ada): '),
        phoneCode: async () => await askTerminal('Masukkan kode OTP verifikasi dari Telegram: '),
        onError: (err) => console.error('Kendala otentikasi Telegram:', err.message),
    });

    const currentSession = client.session.save();
    if (config.telegramSessionStr !== currentSession) {
        config.telegramSessionStr = currentSession;
        saveConfig(config);
        console.log('Token sesi Telegram berhasil disimpan secara permanen di berkas konfigurasi.');
    }

    console.log('Modul pengerukan Telegram aktif dan berjalan di latar belakang.');

    // Langkah 1: Pemanasan penyimpanan data lokal untuk memuat seluruh grup aktif di awal
    try {
        await client.getDialogs({});
        console.log('Penyimpanan data lokal grup Telegram berhasil diperbarui.');
    } catch (dialogErr) {
        console.log('Pemuatan awal daftar obrolan dilewati, sistem akan mengandalkan deteksi dinamis.');
    }

    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message || !message.message) return;

        try {
            let chatTitle = 'Grup Telegram';
            let chatIdStr = '';

            // Langkah 2a: Proteksi pencarian identitas grup agar tidak memicu galat kritis
            try {
                const chatEntity = await client.getEntity(message.peerId);
                chatTitle = chatEntity.title || 'Grup Telegram';
                chatIdStr = chatEntity.id ? chatEntity.id.toString() : '';
            } catch (chatErr) {
                if (message.peerId && message.peerId.channelId) {
                    chatIdStr = message.peerId.channelId.toString();
                } else if (message.peerId && message.peerId.chatId) {
                    chatIdStr = message.peerId.chatId.toString();
                }
                chatTitle = `Grup ID ${chatIdStr}`;
            }

            const targets = config.telegramTargetGroups || [];
            
            const isMatched = targets.some(target => {
                const cleanTarget = target.toString().trim().toLowerCase();
                return chatTitle.toLowerCase() === cleanTarget || chatIdStr === cleanTarget || `-100${chatIdStr}` === cleanTarget;
            });

            if (!isMatched) return;

            let senderName = 'Anggota Grup';

            // Langkah 2b: Proteksi pencarian nama pengirim menggunakan blok pelindung mandiri
            if (message.fromId) {
                try {
                    const senderEntity = await client.getEntity(message.fromId);
                    senderName = senderEntity.firstName || senderEntity.username || 'Anggota Grup';
                } catch (senderErr) {
                    if (message.fromId.userId) {
                        senderName = `Pengguna ID ${message.fromId.userId}`;
                    }
                }
            }

            const cleanText = message.message.trim();
            
            let whatsappPayload = `*[DITERUSKAN DARI TELEGRAM]*\n`;
            whatsappPayload += `Sumber: ${chatTitle}\n`;
            whatsappPayload += `Pengirim: ${senderName}\n\n`;
            whatsappPayload += cleanText;

            await sock.sendMessage(config.groupJid, { text: whatsappPayload });
            console.log(`[Telegram Scraper] Berhasil meneruskan pesan dari ${senderName} di grup ${chatTitle}`);

        } catch (err) {
            console.error('Gagal memproses kiriman pesan dari Telegram:', err.message);
        }
    }, new NewMessage({}));
}

module.exports = { initTelegramScraper };