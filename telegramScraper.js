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

// ====================================================================
// FUNGSI BARU: MENDUKUNG FITUR INTIP OBROLAN TERAKHIR TELEGRAM YAN BRAY
// ====================================================================
async function getRecentMessages(groupNameOrId, limit = 10) {
    if (!client) throw new Error('client telegram belum aktif bray.');
    
    const dialogs = await client.getDialogs({});
    let targetEntity = null;
    let foundTitle = groupNameOrId;

    for (const dialog of dialogs) {
        const chatTitle = dialog.title || '';
        const chatIdStr = dialog.id ? dialog.id.toString() : '';
        const cleanTarget = groupNameOrId.trim().toLowerCase();

        if (chatTitle.toLowerCase() === cleanTarget || chatIdStr === cleanTarget || `-100${chatIdStr}` === cleanTarget) {
            targetEntity = dialog.entity;
            foundTitle = chatTitle;
            break;
        }
    }

    if (!targetEntity) {
        throw new Error(`grup atau channel "${groupNameOrId}" ga ketemu di daftar obrolan bray.`);
    }

    const messages = await client.getMessages(targetEntity, { limit });
    return {
        title: foundTitle,
        list: messages.map(m => ({
            id: m.id,
            text: (m.message || '').trim() || '[media / tanpa teks]'
        }))
    };
}

// ====================================================================
// FUNGSI BARU: MENARIK SATU DATA PESAN PILIHAN BERDASARKAN NOMOR ID
// ====================================================================
async function fetchSingleMessage(groupNameOrId, messageId) {
    if (!client) throw new Error('client telegram belum aktif bray.');

    const dialogs = await client.getDialogs({});
    let targetEntity = null;
    let foundTitle = groupNameOrId;

    for (const dialog of dialogs) {
        const chatTitle = dialog.title || '';
        const chatIdStr = dialog.id ? dialog.id.toString() : '';
        const cleanTarget = groupNameOrId.trim().toLowerCase();

        if (chatTitle.toLowerCase() === cleanTarget || chatIdStr === cleanTarget || `-100${chatIdStr}` === cleanTarget) {
            targetEntity = dialog.entity;
            foundTitle = chatTitle;
            break;
        }
    }

    if (!targetEntity) {
        throw new Error(`grup atau channel "${groupNameOrId}" ga ketemu bray.`);
    }

    const messages = await client.getMessages(targetEntity, { ids: [parseInt(messageId, 10)] });
    if (!messages || messages.length === 0 || !messages[0]) {
        throw new Error(`pesan dengan id ${messageId} ga ketemu di grup ${foundTitle} bray.`);
    }

    const msg = messages[0];
    let senderName = 'Anggota Grup';
    if (msg.fromId) {
        try {
            const senderEntity = await client.getEntity(msg.fromId);
            senderName = senderEntity.firstName || senderEntity.username || 'Anggota Grup';
        } catch (e) {
            // Gagal senyap bray
        }
    }

    return {
        chatTitle: foundTitle,
        senderName,
        text: (msg.message || '').trim() || '[media / tanpa teks]'
    };
}

module.exports = { initTelegramScraper, getRecentMessages, fetchSingleMessage };