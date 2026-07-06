const { TelegramClient, Api } = require('telegram');
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

    // Jika ini login pertama kali, simpan token string session agar tidak minta OTP lagi besok
    const currentSession = client.session.save();
    if (config.telegramSessionStr !== currentSession) {
        config.telegramSessionStr = currentSession;
        saveConfig(config);
        console.log('Token sesi Telegram berhasil disimpan secara permanen di berkas konfigurasi.');
    }

    console.log('Modul pengerukan Telegram aktif dan berjalan di latar belakang.');

    // Pasang pendengar kejadian untuk memantau pesan baru yang masuk
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message || !message.message) return;

        try {
            // Ambil informasi entitas asal pesan (bisa grup, channel, atau personal chat)
            const chatEntity = await client.getEntity(message.peerId);
            const chatTitle = chatEntity.title || '';
            const chatIdStr = chatEntity.id ? chatEntity.id.toString() : '';

            const targets = config.telegramTargetGroups || [];
            
            // COCOKKAN: Apakah asal grup sesuai dengan daftar target yang dipantau?
            const isMatched = targets.some(target => {
                const cleanTarget = target.toString().trim().toLowerCase();
                return chatTitle.toLowerCase() === cleanTarget || chatIdStr === cleanTarget || `-100${chatIdStr}` === cleanTarget;
            });

            if (!isMatched) return; // Abaikan pesan dari grup lain

            // Ambil informasi pengirim pesan di dalam grup
            let senderName = 'Anggota Grup';
            if (message.fromId) {
                const senderEntity = await client.getEntity(message.fromId);
                senderName = senderEntity.firstName || senderEntity.username || 'Anggota Grup';
            }

            const cleanText = message.message.trim();
            
            // Format pesan ramah layar HP untuk diteruskan ke grup WhatsApp utama
            let whatsappPayload = `*[DITERUSKAN DARI TELEGRAM]*\n`;
            whatsappPayload += `Sumber: ${chatTitle}\n`;
            whatsappPayload += `Pengirim: ${senderName}\n\n`;
            whatsappPayload += cleanText;

            // Kirim langsung hasil sadapan ke grup WhatsApp tujuan
            await sock.sendMessage(config.groupJid, { text: whatsappPayload });
            console.log(`[Telegram Scraper] Berhasil meneruskan pesan dari ${senderName} di grup ${chatTitle}`);

        } catch (err) {
            console.error('Gagal memproses kiriman pesan dari Telegram:', err.message);
        }
    }, new NewMessage({}));
}

module.exports = { initTelegramScraper };