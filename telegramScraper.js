const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig } = require('./configManager');

let client = null;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const askTerminal = (text) => new Promise((resolve) => rl.question(text, resolve));

// ====================================================================
// FUNGSI INTERNAL: DOWNLOAD MEDIA VERSI HD ASLI TANPA BURIK BRAY
// ====================================================================
async function downloadTelegramMedia(message) {
    if (!message || !message.media) return null;
    try {
        // downloadMedia tanpa parameter thumb akan otomatis menarik resolusi tertinggi bray
        const buffer = await client.downloadMedia(message.media, {});
        if (!buffer) return null;
        
        let ext = 'jpg';
        let mediaType = 'image';
        
        if (message.media.document) {
            const mime = message.media.document.mimeType || '';
            if (mime.includes('video')) {
                ext = 'mp4';
                mediaType = 'video';
            } else if (mime.includes('image')) {
                ext = 'jpg';
                mediaType = 'image';
            }
        }
        
        // Penamaan file wajib pake awalan tgmedia_ buat target auto-delete ntar yan
        const fileName = `tgmedia_${Date.now()}_${message.id}.${ext}`;
        const localPath = path.join(__dirname, fileName);
        fs.writeFileSync(localPath, buffer);
        
        return { localPath, mediaType };
    } catch (err) {
        console.error('gagal sedot media HD telegram bray:', err.message);
        return null;
    }
}

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

    // LISTENER PASIF LIVE CHAT TELEGRAM
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message) return;

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

            const cleanText = (message.message || '').trim();
            
            let whatsappPayload = `*[DITERUSKAN DARI TELEGRAM]*\n`;
            whatsappPayload += `Sumber: ${chatTitle}\n`;
            whatsappPayload += `Pengirim: ${senderName}\n\n`;
            whatsappPayload += cleanText || '_[kiriman media gambar/video]_';

            // EKSEKUSI CEK DOWNLAND MEDIA PASIF YAN
            const mediaData = await downloadTelegramMedia(message);

            if (mediaData && fs.existsSync(mediaData.localPath)) {
                const mediaBuffer = fs.readFileSync(mediaData.localPath);
                if (mediaData.mediaType === 'image') {
                    await sock.sendMessage(config.groupJid, { image: mediaBuffer, caption: whatsappPayload });
                } else if (mediaData.mediaType === 'video') {
                    await sock.sendMessage(config.groupJid, { video: mediaBuffer, caption: whatsappPayload });
                }
                console.log(`[Telegram Scraper] Berhasil meneruskan media HD dari ${senderName} di grup ${chatTitle}`);
            } else {
                if (cleanText) {
                    await sock.sendMessage(config.groupJid, { text: whatsappPayload });
                    console.log(`[Telegram Scraper] Berhasil meneruskan pesan teks dari ${senderName} di grup ${chatTitle}`);
                }
            }

        } catch (err) {
            console.error('Gagal memproses kiriman pesan dari Telegram:', err.message);
        }
    }, new NewMessage({}));
}

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
        list: messages.map(m => {
            let labelTeks = (m.message || '').trim();
            if (!labelTeks && m.media) {
                labelTeks = m.media.document ? '[🎞️ media video/berkas]' : '[🖼️ media gambar/foto]';
            }
            return { id: m.id, text: labelTeks || '[tidak ada teks]' };
        })
    };
}

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

    // SEDOT DOWNLOAD FILE HD NYA DI SINI YAN PAS DI PANGGIL MANUAL
    const mediaData = await downloadTelegramMedia(msg);

    return {
        chatTitle: foundTitle,
        senderName,
        text: (msg.message || '').trim(),
        mediaPath: mediaData ? mediaData.localPath : null,
        mediaType: mediaData ? mediaData.mediaType : null
    };
}

module.exports = { initTelegramScraper, getRecentMessages, fetchSingleMessage };