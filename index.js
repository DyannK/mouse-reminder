const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const readline = require('readline');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const { loadConfig, saveConfig } = require('./configManager');
const { handleCommand, resolveTargetsToJids, isAuthorized, handleListCommand } = require('./commandHandler');
const { generateAIText, generateTagReply, parseIntentFromText } = require('./geminiClient');
const { computeTriggerTimestamp, milestoneKey } = require('./deadlineParser');
const { computeNextCronFire, formatCronKeTeks } = require('./timeParser');
const { recordSample, buildStyleInstruction } = require('./styleProfiler');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const AI_BUFFER_MINUTES = 10;
const TAG_COOLDOWN_MS = 10000;

let scheduledTasks = [];
const pendingContacts = {};
const pendingConfirmations = {}; // Menyimpan status konfirmasi jadwal dua langkah sementara
let lastTagReplyAt = 0;
let botJidNumber = null;

async function ownerNotify(sock, text) {
    const config = loadConfig();
    try {
        await sock.sendMessage(config.ownerJid, { text });
    } catch (err) {
        console.error('Gagal kirim notifikasi ke owner:', err);
    }
}

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

async function deliverToJids(sock, reminder, targetTextMap) {
    for (const [jid, text] of Object.entries(targetTextMap)) {
        try {
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

            if (reminder.mediaPath && fs.existsSync(reminder.mediaPath)) {
                // Mengirimkan media bersama teks takarir dalam satu gelembung pesan tunggal
                const mediaBuffer = fs.readFileSync(reminder.mediaPath);
                const messageOptions = { caption: text };
                if (reminder.mediaType === 'image') messageOptions.image = mediaBuffer;
                else if (reminder.mediaType === 'video') messageOptions.video = mediaBuffer;
                
                await sock.sendMessage(jid, messageOptions);
            } else {
                await sock.sendMessage(jid, { text });
            }
            console.log(`[${reminder.id}] Terkirim ke ${jid}`);
        } catch (err) {
            console.error(`[${reminder.id}] Gagal kirim ke ${jid}:`, err);
        }
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }
}

async function handleGroupTeamDistribution(sock, reminder, milestone, config) {
    try {
        const groupMeta = await sock.groupMetadata(config.groupJid);
        const members = groupMeta.participants || [];
        
        for (const member of members) {
            const memberJid = member.id;
            // Lewati nomor bot dan nomor pengirim utama agar tidak menembak diri sendiri
            if (memberJid.split(':')[0] === botJidNumber || memberJid === config.ownerJid) continue;

            const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto };
            const messageTemplate = milestone.isAuto ? reminder.nowMessage : reminder.message;
            const manualFallback = milestone.isAuto ? reminder.nowManualFallback : reminder.manualFallback;

            const { text } = await resolveTemplateForJid(messageTemplate, manualFallback, memberJid, context, reminder.formal);
            
            await sock.sendMessage(memberJid, { 
                text: `${text}\n\n*Catatan:* Balas pesan pribadi ini untuk memberikan konfirmasi keaktifan kamu di grup.` 
            });
            
            // Inisialisasi memori pelacakan keaktifan di berkas konfigurasi
            if (!reminder.teamTracking) reminder.teamTracking = {};
            if (!reminder.teamTracking[memberJid]) {
                reminder.teamTracking[memberJid] = { status: 'Pasif', message: '-' };
            }
        }
    } catch (err) {
        console.error('Gagal mendistribusikan pengingat pribadi ke anggota tim:', err);
    }
}

async function generateAndSendTeamReport(sock, reminder, config) {
    let report = `*[Laporan Keaktifan Kelompok]*\n`;
    report += `Agenda: *[${reminder.judul}]*\n\n`;

    const groupMeta = await sock.groupMetadata(config.groupJid);
    const members = groupMeta.participants || [];
    const mappedReport = {};

    for (const member of members) {
        const jid = member.id;
        if (jid.split(':')[0] === botJidNumber) continue;

        // Cek pemetaan nama berdasarkan nomor telepon tunggal atau ganda
        const ownerName = config.accountMapping[jid] || (jid === config.ownerJid ? 'Pemilik' : jid.split('@')[0]);
        
        if (!mappedReport[ownerName]) {
            mappedReport[ownerName] = { active: false, details: '-' };
        }

        const track = reminder.teamTracking?.[jid];
        if (track && track.status === 'Aktif') {
            mappedReport[ownerName].active = true;
            mappedReport[ownerName].details = track.message;
        }
    }

    report += `*Anggota Aktif:*\n`;
    Object.entries(mappedReport).forEach(([name, data]) => {
        if (data.active) report += `• ${name} (Respon: "${data.details}")\n`;
    });

    report += `\n*Anggota Pasif (Belum Merespon):*\n`;
    Object.entries(mappedReport).forEach(([name, data]) => {
        if (!data.active) report += `• ${name}\n`;
    });

    await sock.sendMessage(config.groupJid, { text: report.trim() });
}

let isCheckingDeadlines = false;
async function checkDeadlines(sock) {
    if (isCheckingDeadlines) return;
    isCheckingDeadlines = true;

    try {
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

                if (Date.now() >= triggerTs) {
                    // Jika agenda kelompok, picu distribusi pesan pribadi ke masing-masing anggota
                    if (reminder.scope === 'group') {
                        await handleGroupTeamDistribution(sock, reminder, milestone, config);
                    }

                    // Jika masuk waktu target utama (Sekarang), buat laporan keaktifan di grup
                    if (milestone.isAuto && reminder.scope === 'group') {
                        await generateAndSendTeamReport(sock, reminder, config);
                    }

                    const targetJids = resolveTargetsToJids(config, reminder.targets || ['group']);
                    const targetTextMap = {};
                    const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto };
                    const messageTemplate = milestone.isAuto ? reminder.nowMessage : reminder.message;
                    const manualFallback = milestone.isAuto ? reminder.nowManualFallback : reminder.manualFallback;

                    for (const jid of targetJids) {
                        const preGen = reminder.pendingAITexts[key]?.textsByJid?.[jid];
                        targetTextMap[jid] = preGen || (await resolveTemplateForJid(messageTemplate, manualFallback, jid, context, reminder.formal)).text;
                    }

                    await deliverToJids(sock, reminder, targetTextMap);
                    reminder.firedMilestones.push(key);
                    delete reminder.pendingAITexts[key];
                    changed = true;
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
        }

        if (changed) saveConfig(config);
    } catch (err) {
        console.error(err);
    } finally {
        isCheckingDeadlines = false;
    }
}

function setupSchedules(sock) {
    scheduledTasks.forEach(task => task.stop());
    scheduledTasks = [];
    const config = loadConfig();

    config.reminders.forEach((reminder) => {
        if (reminder.type === 'deadline') return;
        const task = cron.schedule(reminder.cronPattern, () => {
            setTimeout(async () => {
                const targetJids = resolveTargetsToJids(config, reminder.targets || ['group']);
                const targetTextMap = {};
                for (const jid of targetJids) {
                    targetTextMap[jid] = (await resolveTemplateForJid(reminder.message, reminder.manualFallback, jid, {}, reminder.formal)).text;
                }
                await deliverToJids(sock, reminder, targetTextMap);
            }, Math.random() * (reminder.jitterSeconds ?? 15) * 1000);
        }, { timezone: 'Asia/Jakarta' });
        scheduledTasks.push(task);
    });

    scheduledTasks.push(cron.schedule('* * * * *', () => checkDeadlines(sock), { timezone: 'Asia/Jakarta' }));
    console.log(`Scheduler aktif: ${config.reminders.length} terdaftar.`);
}

async function handleCasualAIRequest(sock, msg, fromJid, text, config) {
    const isGroup = fromJid.endsWith('@g.us');
    
    // Deteksi niat kalimat bebas menggunakan fungsi pemotong intent dari Gemini
    const intent = await parseIntentFromText(text);

    if (intent.isReminder && intent.waktu) {
        // Skema data pembentukan pengingat sementara untuk konfirmasi dua langkah
        const tempId = `ai_${Date.now().toString().slice(-4)}`;
        pendingConfirmations[fromJid] = {
            id: tempId,
            judul: intent.judul || 'Agenda Otomatis AI',
            type: intent.type || 'deadline',
            waktuRaw: intent.waktu,
            milestonesRaw: intent.milestones || '1hari,2jam',
            scope: intent.isGroupTask || isGroup ? 'group' : 'personal'
        };

        const targetScope = pendingConfirmations[fromJid].scope === 'group' ? 'Kelompok' : 'Pribadi';
        await sock.sendMessage(fromJid, { 
            text: `Jadwal [${pendingConfirmations[fromJid].judul}] (${targetScope}) buat jam ${intent.waktu} udah gue siapin nih. Udah bener belum? Balas *iya* kalau oke ya.` 
        }, { quoted: msg });
    } else {
        // Jika hanya obrolan biasa atau AI bingung, langsung membalas adaptif mengikuti alur obrolan
        const styleInstruction = buildStyleInstruction(isGroup ? '__bot__' : fromJid);
        const reply = intent.replyPasif || (await generateTagReply(text, styleInstruction));
        if (reply) {
            await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
        }
    }
}

async function processMediaReminderDownload(sock, msg, fromJid, captionText, config) {
    try {
        const messageType = Object.keys(msg.message)[0];
        const mediaMessage = msg.message[messageType];
        
        const stream = await downloadContentFromMessage(mediaMessage, messageType.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const ext = messageType === 'imageMessage' ? 'jpg' : 'mp4';
        const filename = `media_${Date.now()}.${ext}`;
        const localPath = path.join('./', filename);
        fs.writeFileSync(localPath, buffer);

        // Memotong kalimat caption untuk mendapatkan intent waktu
        const intent = await parseIntentFromText(captionText);
        const targetTime = intent.waktu || "07:00";

        const tempId = `media_${Date.now().toString().slice(-4)}`;
        config.reminders.push({
            id: tempId,
            type: 'recurring',
            scope: 'personal',
            cronPattern: `0 ${targetTime.split(':')[1]} ${targetTime.split(':')[0]} * * *`,
            judul: 'Pengingat Media Pribadi',
            message: captionText,
            manualFallback: 'Pengingat media kamu tiba!',
            targets: [fromJid],
            mediaPath: localPath,
            mediaType: messageType === 'imageMessage' ? 'image' : 'video',
            teamTracking: {}
        });

        saveConfig(config);
        setupSchedules(sock);
        await sock.sendMessage(fromJid, { text: 'Siap, berkas media sama caption-nya udah gue gabungin ke pengingat pribadi lu ya.' }, { quoted: msg });
    } catch (err) {
        console.error('Gagal mengolah media pengingat:', err);
        await sock.sendMessage(fromJid, { text: 'Gagal nge-download berkas medianya nih.' });
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });

    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Masukkan nomor WA bot: ');
        console.log('Pairing code:', await sock.requestPairingCode(phoneNumber.trim()));
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if ((lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            botJidNumber = sock.user.id.split(':')[0];
            setupSchedules(sock);
            rl.close();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const fromJid = msg.key.remoteJid;
        const isGroup = fromJid.endsWith('@g.us');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';
        let config = loadConfig();

        // --- Logika Pelacakan Respon Obrolan Pribadi Anggota Tim ---
        if (!isGroup && !text.startsWith('/')) {
            let tracked = false;
            config.reminders.forEach(r => {
                if (r.teamTracking && r.teamTracking[fromJid] && r.teamTracking[fromJid].status !== 'Aktif') {
                    r.teamTracking[fromJid] = { status: 'Aktif', message: text };
                    tracked = true;
                }
            });
            if (tracked) {
                saveConfig(config);
                await sock.sendMessage(fromJid, { text: 'siap' }); // Konfirmasi pendek otomatis ke pengirim
                return;
            }
        }

        // --- Logika Pendeteksi Konfirmasi Dua Langkah Sementara ---
        if (pendingConfirmations[fromJid] && text.trim().toLowerCase() === 'iya') {
            const data = pendingConfirmations[fromJid];
            if (data.type === 'deadline') {
                // Konversi tanggal manual dari intent parser kecerdasan buatan
                const ts = Date.now() + 24 * 3600 * 1000; // Default besok jika format tipis
                config.reminders.push({
                    id: data.id, type: 'deadline', scope: data.scope, targetTimestamp: ts,
                    judul: data.judul, message: `⏰ {sisa} menuju \"{judul}\"!`, manualFallback: data.judul,
                    nowMessage: `🔔 Sekarang waktunya \"{judul}\"!`, nowManualFallback: data.judul,
                    milestones: [{ type: 'durasi', totalMinutes: 0, label: 'Sekarang', isAuto: true }],
                    firedMilestones: [], pendingAITexts: {}, targets: [isGroup ? 'group' : fromJid], teamTracking: {}
                });
            }
            saveConfig(config);
            delete pendingConfirmations[fromJid];
            setupSchedules(sock);
            await sock.sendMessage(fromJid, { text: 'Jadwal udah gue simpen secara permanen ya.' });
            return;
        }

        // --- Interseptor Khusus Pengingat Berkas Media Tunggal Pemilik ---
        if (!isGroup && fromJid === config.ownerJid && (msg.message.imageMessage || msg.message.videoMessage)) {
            await processMediaReminderDownload(sock, msg, fromJid, text, config);
            return;
        }

        if (text.startsWith('/')) {
            await handleCommand(sock, text, fromJid, () => setupSchedules(sock));
            return;
        }

        // --- Kendali Filter Pemicu Respon berbasis Pemanggilan ---
        if (isGroup) {
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentionedJids.some(j => j.split(':')[0] === botJidNumber)) {
                await handleCasualAIRequest(sock, msg, fromJid, text, config);
            }
        } else {
            if (isAuthorized(config, fromJid)) {
                await handleCasualAIRequest(sock, msg, fromJid, text, config);
            } else {
                await sock.sendMessage(fromJid, { text: 'Akses terbatas. Gunakan perintah /daftar <password> untuk mendaftarkan akun.' });
            }
        }

        if (text && (isGroup || isAuthorized(config, fromJid))) {
            recordSample(isGroup ? (msg.key.participant || fromJid) : fromJid, text);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();