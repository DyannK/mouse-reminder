const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const readline = require('readline');
const cron = require('node-cron');

const { loadConfig, saveConfig } = require('./configManager');
const { handleCommand, resolveTargetsToJids, isAuthorized } = require('./commandHandler');
const { generateAIText } = require('./geminiClient');
const { computeTriggerTimestamp, milestoneKey } = require('./deadlineParser');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

let scheduledTasks = [];
// Menyimpan siapa saja yang baru saja share-contact dan sedang ditunggu balasan nama-nya.
// Key: fromJid (pengirim), Value: JID kontak yang mau disimpan.
const pendingContacts = {};

/**
 * Resolve teks pesan final yang mau dikirim. Kalau reminder.message diawali "AI:",
 * generate teks pakai Gemini berdasarkan tema. Kalau enggak, pakai teks statis dengan
 * placeholder {sisa} dan {judul} yang sudah disubstitusi.
 */
async function resolveMessageText(reminder, context = {}) {
    if ((reminder.message || '').startsWith('AI:')) {
        const tema = reminder.message.replace('AI:', '').trim();
        return await generateAIText(tema, context);
    }
    let text = reminder.message || '';
    if (context.sisa) text = text.replace(/{sisa}/g, context.sisa);
    if (context.judul) text = text.replace(/{judul}/g, context.judul);
    return text;
}

async function sendToTargets(sock, reminderId, targets, messageText) {
    const freshConfig = loadConfig();
    const targetJids = resolveTargetsToJids(freshConfig, targets || ['group']);

    for (const jid of targetJids) {
        try {
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
            await sock.sendMessage(jid, { text: messageText });
            console.log(`[${reminderId}] Terkirim ke ${jid}:`, new Date().toLocaleString('id-ID'));
        } catch (err) {
            console.error(`[${reminderId}] Gagal kirim ke ${jid}:`, err);
        }
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }
}

/**
 * Dicek tiap menit: loop semua deadline reminder, cek milestone mana yang waktunya sudah
 * lewat tapi belum pernah dikirim, lalu kirim dan tandai sudah terkirim.
 */
async function checkDeadlines(sock) {
    const config = loadConfig();
    let changed = false;

    for (const reminder of config.reminders) {
        if (reminder.type !== 'deadline') continue;

        for (const milestone of reminder.milestones) {
            const key = milestoneKey(milestone);
            if (reminder.firedMilestones.includes(key)) continue;

            const triggerTs = computeTriggerTimestamp(milestone, reminder.targetTimestamp);
            if (Date.now() >= triggerTs) {
                const messageText = await resolveMessageText(reminder, { sisa: milestone.label, judul: reminder.judul });
                await sendToTargets(sock, reminder.id, reminder.targets, messageText);
                reminder.firedMilestones.push(key);
                changed = true;
            }
        }
    }

    if (changed) saveConfig(config);
}

function setupSchedules(sock) {
    // hentikan semua task lama dulu sebelum bikin ulang, biar gak dobel kirim
    scheduledTasks.forEach(task => task.stop());
    scheduledTasks = [];

    const config = loadConfig();

    config.reminders.forEach((reminder) => {
        if (reminder.type === 'deadline') return; // deadline reminder ditangani checkDeadlines(), bukan di sini

        const task = cron.schedule(reminder.cronPattern, async () => {
            const jitterMs = Math.random() * (reminder.jitterSeconds ?? 15) * 1000;
            console.log(`[${reminder.id}] Menunggu jitter ${(jitterMs / 1000).toFixed(1)} detik...`);

            setTimeout(async () => {
                const messageText = await resolveMessageText(reminder);
                await sendToTargets(sock, reminder.id, reminder.targets, messageText);
            }, jitterMs);
        }, { timezone: 'Asia/Jakarta' });

        scheduledTasks.push(task);
    });

    const deadlineChecker = cron.schedule('* * * * *', () => checkDeadlines(sock), { timezone: 'Asia/Jakarta' });
    scheduledTasks.push(deadlineChecker);

    console.log(`Scheduler aktif: ${config.reminders.length} reminder terdaftar.`);
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Masukkan nomor WA bot (format: 628xxxxxxxxxx): ');
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log('Pairing code kamu:', code);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, reconnect:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Berhasil terhubung ke WhatsApp!');
            setupSchedules(sock);
            rl.close();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return; // abaikan pesan yang dikirim bot/nomor bot sendiri, cegah self-echo

        const fromJid = msg.key.remoteJid;
        const contactMsg = msg.message.contactMessage;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // --- Langkah 1: ada kontak yang di-share ---
        if (contactMsg) {
            const config = loadConfig();
            if (!isAuthorized(config, fromJid)) {
                await sock.sendMessage(fromJid, { text: '🔒 Kamu belum terdaftar. Ketik /daftar <password> dulu.' });
                return;
            }

            const vcard = contactMsg.vcard;
            const phoneMatch = vcard.match(/waid=(\d+)/);
            if (!phoneMatch) {
                await sock.sendMessage(fromJid, { text: '❌ Gagal baca nomor dari kontak yang di-share. Coba share ulang.' });
                return;
            }

            const contactJid = `${phoneMatch[1]}@s.whatsapp.net`;
            pendingContacts[fromJid] = contactJid;
            await sock.sendMessage(fromJid, { text: '📇 Kontak diterima! Kontak ini mau disimpan dengan nama apa?\n\nBalas pesan ini dengan nama saja, contoh: budi' });
            return;
        }

        // --- Langkah 2: user sedang ditunggu balasan nama untuk kontak ---
        if (pendingContacts[fromJid] && text && !text.startsWith('/')) {
            const name = text.trim();
            const cfg = loadConfig();
            cfg.contacts.push({ name, jid: pendingContacts[fromJid] });
            saveConfig(cfg);
            delete pendingContacts[fromJid];
            await sock.sendMessage(fromJid, { text: `✅ Kontak "${name}" tersimpan. Sekarang bisa dipakai sebagai target reminder.` });
            return;
        }

        // --- Command teks biasa ---
        if (text.startsWith('/')) {
            await handleCommand(sock, text, fromJid, () => setupSchedules(sock));
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();