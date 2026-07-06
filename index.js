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
const { initTelegramScraper } = require('./telegramScraper');

const { logGroupMessage, getGroupLogs } = require('./chatLogger');
const { parseIntentFromText, generateMimicReply, summarizeChatLog } = require('./geminiClient');

const userStates = {};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

let scheduledTasks = [];
const pendingConfirmations = {};
let botJidNumber = null;

let isCheckingDeadlines = false;

const CANCEL_WORDS = ['gajadi', 'batal', 'ntar aja', 'udahan', 'cancel'];

function resetState(jid) {
    if (userStates[jid]?.timer) clearTimeout(userStates[jid].timer);
    delete userStates[jid];
}

function setState(jid, mode, data = {}) {
    if (userStates[jid]?.timer) clearTimeout(userStates[jid].timer);
    userStates[jid] = {
        mode,
        data,
        timer: setTimeout(() => {
            resetState(jid);
            console.log(`state ${jid} kereset otomatis karena 10 menit ga ada respon.`);
        }, 10 * 60 * 1000) // 10 menit auto reset
    };
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
                const mediaBuffer = fs.readFileSync(reminder.mediaPath);
                const messageOptions = { caption: text };
                if (reminder.mediaType === 'image') messageOptions.image = mediaBuffer;
                else if (reminder.mediaType === 'video') messageOptions.video = mediaBuffer;
                
                await sock.sendMessage(jid, messageOptions);
            } else {
                await sock.sendMessage(jid, { text });
            }
            console.log(`[${reminder.id}] terkirim ke ${jid}`);
        } catch (err) {
            console.error(`[${reminder.id}] gagal kirim ke ${jid}:`, err);
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
            if (memberJid.split(':')[0] === botJidNumber || memberJid === config.ownerJid) continue;

            const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto };
            const messageTemplate = milestone.isAuto ? reminder.nowMessage : reminder.message;
            const manualFallback = milestone.isAuto ? reminder.nowManualFallback : reminder.manualFallback;

            const { text } = await resolveTemplateForJid(messageTemplate, manualFallback, memberJid, context, reminder.formal);
            
            await sock.sendMessage(memberJid, { 
                text: `${text}\n\n*catatan:* balas pesan pribadi ini buat ngasih konfirmasi keaktifan lu di grup.` 
            });
            
            if (!reminder.teamTracking) reminder.teamTracking = {};
            if (!reminder.teamTracking[memberJid]) {
                reminder.teamTracking[memberJid] = { status: 'Pasif', message: '-' };
            }
        }
    } catch (err) {
        console.error('gagal distribusi ke tim:', err);
    }
}

async function generateAndSendTeamReport(sock, reminder, config) {
    let report = `*[laporan keaktifan kelompok]*\nagenda: *[${reminder.judul}]*\n\n`;

    const groupMeta = await sock.groupMetadata(config.groupJid);
    const members = groupMeta.participants || [];
    const mappedReport = {};

    for (const member of members) {
        const jid = member.id;
        if (jid.split(':')[0] === botJidNumber) continue;

        const ownerName = config.accountMapping[jid] || (jid === config.ownerJid ? 'Pemilik' : jid.split('@')[0]);
        if (!mappedReport[ownerName]) mappedReport[ownerName] = { active: false, details: '-' };

        const track = reminder.teamTracking?.[jid];
        if (track && track.status === 'Aktif') {
            mappedReport[ownerName].active = true;
            mappedReport[ownerName].details = track.message;
        }
    }

    report += `*anggota aktif:*\n`;
    Object.entries(mappedReport).forEach(([name, data]) => {
        if (data.active) report += `- ${name} (respon: ${data.details})\n`;
    });

    report += `\n*anggota pasif (belum respon):*\n`;
    Object.entries(mappedReport).forEach(([name, data]) => {
        if (!data.active) report += `- ${name}\n`;
    });

    await sock.sendMessage(config.groupJid, { text: report.trim() });
}

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
                    if (reminder.scope === 'group') await handleGroupTeamDistribution(sock, reminder, milestone, config);
                    if (milestone.isAuto && reminder.scope === 'group') await generateAndSendTeamReport(sock, reminder, config);

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
    console.log(`scheduler aktif: ${config.reminders.length} terdaftar.`);
}

async function processMediaReminderDownload(sock, msg, fromJid, captionText, config) {
    try {
        const messageType = Object.keys(msg.message)[0];
        const mediaMessage = msg.message[messageType];
        
        const stream = await downloadContentFromMessage(mediaMessage, messageType.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        const ext = messageType === 'imageMessage' ? 'jpg' : 'mp4';
        const localPath = path.join('./', `media_${Date.now()}.${ext}`);
        fs.writeFileSync(localPath, buffer);

        const intent = await parseIntentFromText(captionText);
        const targetTime = intent.waktu || "07:00";

        config.reminders.push({
            id: `media_${Date.now().toString().slice(-4)}`,
            type: 'recurring',
            scope: 'personal',
            cronPattern: `0 ${targetTime.split(':')[1]} ${targetTime.split(':')[0]} * * *`,
            judul: 'Pengingat Media',
            message: captionText,
            manualFallback: 'pengingat media tiba',
            targets: [fromJid],
            mediaPath: localPath,
            mediaType: messageType === 'imageMessage' ? 'image' : 'video',
            teamTracking: {}
        });

        saveConfig(config);
        setupSchedules(sock);
        await sock.sendMessage(fromJid, { text: 'siap, media sama caption udah gue gabungin ke pengingat pribadi lu.' }, { quoted: msg });
    } catch (err) {
        console.error('gagal olah media:', err);
    }
}

async function handleCasualAIRequest(sock, msg, fromJid, text, config) {
    const isGroup = fromJid.endsWith('@g.us');
    const intent = await parseIntentFromText(text);

    if (intent.isReminder && intent.waktu && intent.judul) {
        const tempId = `ai_${Date.now().toString().slice(-4)}`;
        pendingConfirmations[fromJid] = {
            id: tempId,
            judul: intent.judul,
            type: intent.type || 'deadline',
            waktuRaw: intent.waktu,
            milestonesRaw: intent.milestones || '1hari,2jam',
            scope: intent.isGroupTask || isGroup ? 'group' : 'personal'
        };

        const targetScope = pendingConfirmations[fromJid].scope === 'group' ? 'kelompok' : 'pribadi';
        await sock.sendMessage(fromJid, { 
            text: `jadwal [${pendingConfirmations[fromJid].judul}] (${targetScope}) buat jam ${intent.waktu} udah gue siapin nih. udah bener belum? balas iya kalau oke ya.` 
        }, { quoted: msg });
    } else {
        const styleInstruction = buildStyleInstruction(isGroup ? '__bot__' : fromJid);
        const reply = intent.replyPasif || (await generateTagReply(text, styleInstruction));
        if (reply) await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });

    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('masukkan nomor wa bot: ');
        console.log('pairing code:', await sock.requestPairingCode(phoneNumber.trim()));
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if ((lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            botJidNumber = sock.user.id.split(':')[0];
            setupSchedules(sock);
            await initTelegramScraper(sock);
            rl.close();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const fromJid = msg.key.remoteJid;
    const isGroup = fromJid.endsWith('@g.us');
    const senderName = msg.pushName || 'Orang';
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    
    let config = loadConfig();

    // PENYADAP PASIF GRUP (Merekam di background terus-terusan)
    if (isGroup && text) {
        logGroupMessage(senderName, text);
    }

    // GERBANG MUTLAK SLASH COMMAND
    if (text.startsWith('/')) {
        resetState(fromJid); // reset state kalau dia mendadak pakai slash
        await handleCommand(sock, text, fromJid, () => setupSchedules(sock));
        return;
    }

    // DETEKSI KATA BATAL
    const isCancel = CANCEL_WORDS.some(w => text.toLowerCase().includes(w));
    if (isCancel && userStates[fromJid]) {
        resetState(fromJid);
        await sock.sendMessage(fromJid, { text: 'oke, gajadi ya. gue reset nih.' }, { quoted: msg });
        return;
    }

    // HANDLE STATE YANG LAGI JALAN (Obrolan ngunci di sini)
    if (userStates[fromJid]) {
        const state = userStates[fromJid];
        
        if (state.mode === 'confirm_schedule') {
            if (text.toLowerCase() === 'iya') {
                // ... (Eksekusi simpan jadwal pakai logika yang lama, lalu reset state)
                resetState(fromJid);
                await sock.sendMessage(fromJid, { text: 'jadwal udah gue simpen secara permanen ya.' });
            } else if (text.toLowerCase() === 'chatan') {
                setState(fromJid, 'chat');
                await sock.sendMessage(fromJid, { text: 'oke gas, mau ngobrolin apaan nih?' });
            } else {
                await sock.sendMessage(fromJid, { text: 'mau lanjut chatan ajaa, atau fix buat agenda nih? balas "iya" atau "chatan"' });
            }
            return;
        }

        if (state.mode === 'chat') {
            const samples = config.styleProfiles[fromJid]?.samples || [];
            const reply = await generateMimicReply(text, samples);
            await sock.sendMessage(fromJid, { text: reply });
            // Perbarui timer karena dia masih asik ngobrol
            setState(fromJid, 'chat'); 
            return;
        }
    }

    // PEMROSESAN AWAL KASUAL (Kalau belum ada state)
    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isBotMentioned = mentionedJids.some(j => j.split(':')[0] === botJidNumber);

    if (!isGroup || isBotMentioned) {
        const intentData = await parseIntentFromText(text);

        if (intentData.intent === 'create_schedule') {
            setState(fromJid, 'confirm_schedule', intentData);
            await sock.sendMessage(fromJid, { text: `gue nangkep lu mau bikin jadwal "${intentData.judul}" jam ${intentData.waktu}. mau lanjut chatan aja, atau fix buat agenda nih? bales "iya" kalau fix.` });
        
        } else if (intentData.intent === 'summarize') {
            const logs = getGroupLogs(intentData.jumlahChat || 200);
            if (logs.length === 0) {
                await sock.sendMessage(fromJid, { text: 'belum ada obrolan yang kerekam nih coy.' });
            } else {
                await sock.sendMessage(fromJid, { text: 'bentar, gue baca-baca dulu ya...' });
                const summary = await summarizeChatLog(logs);
                await sock.sendMessage(fromJid, { text: summary });
            }
            
        } else if (intentData.intent === 'read_schedule') {
            // Biar gampang, kita paksa aja masuk ke perintah manual /list di background
            await handleCommand(sock, '/list', fromJid, () => setupSchedules(sock));
            
        } else {
            // Intent chat biasa, langsung masuk mode obrolan panjang
            setState(fromJid, 'chat');
            const samples = config.styleProfiles[fromJid]?.samples || [];
            const reply = await generateMimicReply(text, samples);
            await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
        }
    }
});

    sock.ev.on('creds.update', saveCreds);
}

startBot();