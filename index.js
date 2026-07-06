const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const readline = require('readline');
const cron = require('node-cron');

const { loadConfig, saveConfig } = require('./configManager');
const { handleCommand, resolveTargetsToJids, isAuthorized } = require('./commandHandler');
const { generateAIText, generateTagReply } = require('./geminiClient');
const { computeTriggerTimestamp, milestoneKey } = require('./deadlineParser');
const { computeNextCronFire } = require('./timeParser');
const { recordSample, buildStyleInstruction } = require('./styleProfiler');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const AI_BUFFER_MINUTES = 10;   // seberapa jauh sebelum jadwal, teks AI mulai di-generate
const TAG_COOLDOWN_MS = 10000;  // jeda minimal antar balasan tag-bot, biar gak gampang di-spam

let scheduledTasks = [];
const pendingContacts = {};
let lastTagReplyAt = 0;
let botJidNumber = null; // nomor bot sendiri (tanpa suffix device), buat deteksi mention

async function ownerNotify(sock, text) {
    const config = loadConfig();
    try {
        await sock.sendMessage(config.ownerJid, { text });
    } catch (err) {
        console.error('Gagal kirim notifikasi ke owner:', err);
    }
}

/**
 * Resolve teks buat SATU target jid, dari sebuah template pesan (message ATAU nowMessage).
 * Kalau template diawali "AI:", generate pakai Gemini + gaya orang itu + toggle formal.
 * Return { text, usedFallback }.
 */
async function resolveTemplateForJid(messageTemplate, manualFallback, jid, context = {}, formal = false) {
    if ((messageTemplate || '').startsWith('AI:')) {
        const tema = messageTemplate.replace('AI:', '').trim();
        const styleInstruction = buildStyleInstruction(jid);
        return await generateAIText(tema, context, styleInstruction, manualFallback, formal);
    }
    let text = messageTemplate || '';
    if (context.sisa) text = text.replace(/{sisa}/g, context.sisa);
    if (context.judul) text = text.replace(/{judul}/g, context.judul);
    return { text, usedFallback: false };
}

async function deliverToJids(sock, reminderId, targetTextMap) {
    for (const [jid, text] of Object.entries(targetTextMap)) {
        try {
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
            await sock.sendMessage(jid, { text });
            console.log(`[${reminderId}] Terkirim ke ${jid}:`, new Date().toLocaleString('id-ID'));
        } catch (err) {
            console.error(`[${reminderId}] Gagal kirim ke ${jid}:`, err);
        }
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }
}

/** Eksekusi 1 reminder berulang: pakai teks pre-generated kalau ada, else generate on-the-spot. */
async function fireRecurringReminder(sock, reminderId) {
    const config = loadConfig();
    const reminder = config.reminders.find(r => r.id === reminderId);
    if (!reminder) return;

    const targetJids = resolveTargetsToJids(config, reminder.targets || ['group']);
    const targetTextMap = {};
    let anyFallback = false;

    for (const jid of targetJids) {
        const preGen = reminder.pendingAIText?.textsByJid?.[jid];
        if (preGen) {
            targetTextMap[jid] = preGen;
        } else {
            const { text, usedFallback } = await resolveTemplateForJid(reminder.message, reminder.manualFallback, jid, {}, reminder.formal);
            targetTextMap[jid] = text;
            if (usedFallback) anyFallback = true;
        }
    }

    await deliverToJids(sock, reminder.id, targetTextMap);
    reminder.pendingAIText = null;
    saveConfig(config);

    if (anyFallback) {
        await ownerNotify(sock, `⚠️ AI gagal generate teks buat reminder "${reminder.id}" saat pengiriman, dipakai fallback. Cek /editpesan kalau perlu diganti.`);
    }
}

/** Dicek tiap menit: pre-generate teks AI reminder berulang beberapa menit sebelum jadwalnya. */
async function checkRecurringAIPreGen(sock) {
    const config = loadConfig();
    let changed = false;

    for (const reminder of config.reminders) {
        if (reminder.type === 'deadline') continue;
        if (!(reminder.message || '').startsWith('AI:')) continue;

        const nextFire = computeNextCronFire(reminder.cronPattern);
        if (nextFire === null) continue;

        const dueForPreGen = nextFire - Date.now() <= AI_BUFFER_MINUTES * 60 * 1000;
        const alreadyDone = reminder.pendingAIText?.forRunAt === nextFire;
        if (!dueForPreGen || alreadyDone) continue;

        const targetJids = resolveTargetsToJids(config, reminder.targets || ['group']);
        const textsByJid = {};
        let anyFallback = false;

        for (const jid of targetJids) {
            const { text, usedFallback } = await resolveTemplateForJid(reminder.message, reminder.manualFallback, jid, {}, reminder.formal);
            textsByJid[jid] = text;
            if (usedFallback) anyFallback = true;
        }

        reminder.pendingAIText = { forRunAt: nextFire, textsByJid };
        changed = true;

        if (anyFallback) {
            await ownerNotify(sock, `⚠️ AI gagal generate teks buat reminder "${reminder.id}" (pre-generate), dipakai fallback. Reminder tetap akan terkirim ontime.`);
        }
    }

    if (changed) saveConfig(config);
}

/**
 * Dicek tiap menit: loop semua deadline reminder & milestone-nya.
 * - Masuk buffer waktu -> pre-generate teks AI (kalau AI).
 * - Waktunya lewat -> kirim (pakai teks pre-generated kalau ada). Milestone "isAuto"
 *   (pas waktu target) pakai template nowMessage, bukan message biasa.
 * - Kalau semua milestone reminder ini udah kekirim semua -> hapus otomatis + notify owner.
 */
async function checkDeadlines(sock) {
    const config = loadConfig();
    let changed = false;
    const idsToRemove = [];

    for (const reminder of config.reminders) {
        if (reminder.type !== 'deadline') continue;
        if (!reminder.pendingAITexts) reminder.pendingAITexts = {};

        for (const milestone of reminder.milestones) {
            const key = milestoneKey(milestone);
            if (reminder.firedMilestones.includes(key)) continue;

            const triggerTs = computeTriggerTimestamp(milestone, reminder.targetTimestamp);
            const messageTemplate = milestone.isAuto ? reminder.nowMessage : reminder.message;
            const manualFallback = milestone.isAuto ? reminder.nowManualFallback : reminder.manualFallback;
            const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto };
            const isAI = (messageTemplate || '').startsWith('AI:');

            if (Date.now() >= triggerTs) {
                const targetJids = resolveTargetsToJids(config, reminder.targets || ['group']);
                const targetTextMap = {};
                let anyFallback = false;

                for (const jid of targetJids) {
                    const preGen = reminder.pendingAITexts[key]?.textsByJid?.[jid];
                    if (preGen) {
                        targetTextMap[jid] = preGen;
                    } else {
                        const { text, usedFallback } = await resolveTemplateForJid(messageTemplate, manualFallback, jid, context, reminder.formal);
                        targetTextMap[jid] = text;
                        if (usedFallback) anyFallback = true;
                    }
                }

                await deliverToJids(sock, reminder.id, targetTextMap);
                reminder.firedMilestones.push(key);
                delete reminder.pendingAITexts[key];
                changed = true;

                if (anyFallback) {
                    await ownerNotify(sock, `⚠️ AI gagal generate teks buat deadline "${reminder.id}" (milestone: ${milestone.label}), dipakai fallback.`);
                }

            } else if (isAI && Date.now() >= triggerTs - AI_BUFFER_MINUTES * 60 * 1000 && !reminder.pendingAITexts[key]) {
                const targetJids = resolveTargetsToJids(config, reminder.targets || ['group']);
                const textsByJid = {};
                let anyFallback = false;

                for (const jid of targetJids) {
                    const { text, usedFallback } = await resolveTemplateForJid(messageTemplate, manualFallback, jid, context, reminder.formal);
                    textsByJid[jid] = text;
                    if (usedFallback) anyFallback = true;
                }

                reminder.pendingAITexts[key] = { textsByJid };
                changed = true;

                if (anyFallback) {
                    await ownerNotify(sock, `⚠️ AI gagal generate teks buat deadline "${reminder.id}" (pre-generate, milestone: ${milestone.label}), dipakai fallback. Reminder tetap terkirim ontime.`);
                }
            }
        }

        if (reminder.firedMilestones.length >= reminder.milestones.length) {
            idsToRemove.push(reminder.id);
        }
    }

    if (idsToRemove.length > 0) {
        for (const id of idsToRemove) {
            const idx = config.reminders.findIndex(r => r.id === id);
            if (idx !== -1) config.reminders.splice(idx, 1);
        }
        changed = true;
        for (const id of idsToRemove) {
            await ownerNotify(sock, `✅ Deadline "${id}" udah selesai (semua milestone terkirim) dan otomatis dihapus.`);
        }
    }

    if (changed) saveConfig(config);
}

function setupSchedules(sock) {
    scheduledTasks.forEach(task => task.stop());
    scheduledTasks = [];

    const config = loadConfig();

    config.reminders.forEach((reminder) => {
        if (reminder.type === 'deadline') return;

        const task = cron.schedule(reminder.cronPattern, () => {
            const jitterMs = Math.random() * (reminder.jitterSeconds ?? 15) * 1000;
            console.log(`[${reminder.id}] Menunggu jitter ${(jitterMs / 1000).toFixed(1)} detik...`);
            setTimeout(() => fireRecurringReminder(sock, reminder.id), jitterMs);
        }, { timezone: 'Asia/Jakarta' });

        scheduledTasks.push(task);
    });

    const deadlineChecker = cron.schedule('* * * * *', () => checkDeadlines(sock), { timezone: 'Asia/Jakarta' });
    scheduledTasks.push(deadlineChecker);

    const aiPreGenChecker = cron.schedule('* * * * *', () => checkRecurringAIPreGen(sock), { timezone: 'Asia/Jakarta' });
    scheduledTasks.push(aiPreGenChecker);

    console.log(`Scheduler aktif: ${config.reminders.length} reminder terdaftar.`);
}

/** Bersihin teks mention ("@6281234567890") dari pesan biar prompt AI lebih bersih. */
function stripMentions(text) {
    return text.replace(/@\d+/g, '').trim();
}

async function handleTagMention(sock, msg, fromJid, text) {
    const now = Date.now();
    if (now - lastTagReplyAt < TAG_COOLDOWN_MS) return; // masih cooldown, diemin dulu

    const cleanText = stripMentions(text) || '(gak ada teks tambahan)';
    const styleInstruction = buildStyleInstruction('__bot__');
    const reply = await generateTagReply(cleanText, styleInstruction);
    if (!reply) return; // AI belum dikonfigurasi / gagal, diem aja daripada kasih balasan generik aneh

    lastTagReplyAt = now;
    try {
        await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
    } catch (err) {
        console.error('Gagal kirim balasan tag:', err);
    }
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
            botJidNumber = sock.user.id.split(':')[0];
            setupSchedules(sock);
            rl.close();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return;

        const fromJid = msg.key.remoteJid;
        const contactMsg = msg.message.contactMessage;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // --- Deteksi tag/mention ke bot di grup ---
        const isGroup = fromJid.endsWith('@g.us');
        if (isGroup && botJidNumber) {
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isMentioned = mentionedJids.some(j => j.split(':')[0] === botJidNumber);
            if (isMentioned) {
                await handleTagMention(sock, msg, fromJid, text);
                return;
            }
        }

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
            return;
        }

        // --- Bukan command: rekam sebagai sample gaya ketikan ---
        if (text) {
            const config = loadConfig();
            const senderJid = isGroup ? (msg.key.participant || fromJid) : fromJid;
            if (isGroup || isAuthorized(config, fromJid)) {
                recordSample(senderJid, text);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();