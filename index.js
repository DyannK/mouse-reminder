const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const readline = require('readline');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const { loadConfig, saveConfig } = require('./configManager');
const { handleCommand, resolveTargetsToJids, isAuthorized, handleListCommand } = require('./commandHandler');
const { computeTriggerTimestamp, milestoneKey } = require('./deadlineParser');
const { computeNextCronFire, formatCronKeTeks } = require('./timeParser');
const { recordSample, buildStyleInstruction } = require('./styleProfiler');
const { initTelegramScraper } = require('./telegramScraper');

const { logGroupMessage, getGroupLogs } = require('./chatLogger');
const { generateAIText, parseIntentFromText, generateMimicReply, summarizeChatLog } = require('./geminiClient');

const userStates = {};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

let scheduledTasks = [];
let botJidNumber = null;
let isCheckingDeadlines = false;

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
        }, 10 * 60 * 1000)
    };
}

// MESIN PENERJEMAH TEMPLATE MANUAL DAN GENERATOR AI
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

// TRANSMISI PESAN DENGAN KAMAR AUDIO VISUAL DAN MEDIA BUFFER
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

// DISTRIBUSI DEADLINE KE ANGGOTA KELOMPOK SECARA MANDIRI
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

// GENERATOR LAPORAN JURNAL KEAKTIFAN ANGGOTA TIM
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

// EVALUATOR CRON DEADLINE BESERTA PELAPORAN OTOMATIS TIM
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

// PENYELARAS TUGAS CRON REMINDER RUTIN BESERTA JITTER SECONDS
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

// GERBANG UNDUHAN OTOMATIS UNTUK MEDIA REMINDER
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

// INITIALISASI CORE ENGINE BAILEYS
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
        const senderName = msg.pushName || 'orang';
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        let config = loadConfig();

        if (isGroup && text) {
            logGroupMessage(senderName, text);
        }

        // PENCEGAT MEDIA DOWNLOAD UNTUK CAPTION JADWAL
        const messageType = Object.keys(msg.message)[0];
        if ((messageType === 'imageMessage' || messageType === 'videoMessage') && text.includes(':')) {
            await processMediaReminderDownload(sock, msg, fromJid, text, config);
            return;
        }

        // 1. GERBANG MANUAL UTAMA (PENCEGAT SLASH & MENU HELP)
        if (text.startsWith('/')) {
            resetState(fromJid);
            if (text.trim().toLowerCase() === '/help') {
                const menuHelp = `🛠 *MENU UTAMA BANTUAN REMINDER BOT*\n` +
                    `--------------------------------------------------------\n\n` +
                    `📌 *PERINTAH MANUAL (SLASH COMMAND)*\n` +
                    `• */list* : Menampilkan semua daftar agenda aktif di database.\n` +
                    `• */daftar* : Registrasi akun lu biar dapet izin akses penuh.\n` +
                    `• */tambah* : Membuat pengingat rutin secara manual.\n` +
                    `• */tambahdeadline* : Membuat target deadline manual.\n` +
                    `• */editpesan [id] [teks]* : Mengubah template durasi (bisa pakai *AI:* atau *{judul}*).\n` +
                    `• */editpesannow [id] [teks]* : Mengubah template eksekusi.\n\n` +
                    `🤖 *FITUR KASUAL CERDAS (AI MODE)*\n` +
                    `Tag bot di grup atau japri langsung pakai bahasa sehari-hari:\n` +
                    `• *Bikin Jadwal* : "buatin gue jadwal mancing jam 18:15 ntar malem"\n` +
                    `• *Cek Agenda* : "coba liat dong gimana aja listnya"\n` +
                    `• *Rangkum Chat* : "200 bubble ke atas kita ngomongin apa rangkumin"\n\n` +
                    `💬 *ATURAN SESI CHAT & MIMICKING*\n` +
                    `• Sesi obrolan otomatis mati jika didiamkan selama 10 menit.\n` +
                    `• Putus sesi obrolan kapan saja dengan mengetik kata penutup (*sip*, *oke*, *udahan*, dll).`;

                await sock.sendMessage(fromJid, { text: menuHelp }, { quoted: msg });
                return;
            }
            await handleCommand(sock, text, fromJid, () => setupSchedules(sock));
            return;
        }

        const lowText = text.trim().toLowerCase();

        // 2. KONDISI LOCK MUTLAK: JIKA SEDANG MENUNGGU IJIN KONFIRMASI JADWAL
        if (userStates[fromJid] && userStates[fromJid].mode === 'confirm_schedule') {
            const state = userStates[fromJid];
            
            if (['gajadi', 'batal', 'cancel', 'ntar aja'].some(w => lowText.includes(w))) {
                resetState(fromJid);
                await sock.sendMessage(fromJid, { text: 'oke bray, pembuatan jadwal dibatalin ya.' }, { quoted: msg });
                return;
            }

            if (lowText === 'iya' || lowText === 'y') {
                const data = state.data;
                let targetTimestamp = Date.now();
                
                if (data.waktu && data.waktu.includes(':')) {
                    const [hour, minute] = data.waktu.split(':').map(Number);
                    const hariIni = new Date();
                    const targetDate = new Date(hariIni.getFullYear(), hariIni.getMonth(), hariIni.getDate(), hour, minute, 0);
                    
                    if (targetDate.getTime() <= Date.now()) {
                        targetDate.setDate(targetDate.getDate() + 1);
                    }
                    targetTimestamp = targetDate.getTime();
                }

                config.reminders.push({
                    id: `ai_${Date.now().toString().slice(-4)}`,
                    type: 'deadline',
                    scope: isGroup ? 'group' : 'personal',
                    targetTimestamp: targetTimestamp,
                    judul: data.judul || 'Agenda Kasual',
                    message: `waktunya {judul} bentar lagi nih!`,
                    manualFallback: data.judul || 'Agenda Kasual',
                    nowMessage: `sekarang waktunya {judul} coy!`,
                    nowManualFallback: data.judul || 'Agenda Kasual',
                    milestones: [{ type: 'durasi', totalMinutes: 0, label: 'sekarang', isAuto: true }],
                    firedMilestones: [],
                    pendingAITexts: {},
                    targets: [isGroup ? 'group' : fromJid],
                    mediaPath: null,
                    mediaType: null,
                    teamTracking: {}
                });

                saveConfig(config);
                resetState(fromJid);
                setupSchedules(sock);
                await sock.sendMessage(fromJid, { text: 'jadwal udah gue simpen permanen ya coy.' });
            } else if (lowText === 'chatan') {
                setState(fromJid, 'chat');
                await sock.sendMessage(fromJid, { text: 'oke gas, mau ngobrolin apaan nih?' });
            } else {
                await sock.sendMessage(fromJid, { text: 'mau lanjut chatan aja, atau fix buat agenda nih? balas iya atau chatan' });
            }
            return;
        }

        // 3. JALUR UMUM DETEKSI RADAR INTENT (BERLAKU SETIAP CHAT MASUK)
        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isBotMentioned = mentionedJids.some(j => j.split(':')[0] === botJidNumber);

        if (!isGroup || isBotMentioned) {
            if (!isGroup && !isAuthorized(config, fromJid)) {
                await sock.sendMessage(fromJid, { text: 'akses terbatas. daftar pake /daftar dulu cuy.' });
                return;
            }

            const intentData = await parseIntentFromText(text);

            if (intentData.intent === 'create_schedule') {
                setState(fromJid, 'confirm_schedule', intentData);
                await sock.sendMessage(fromJid, { text: `gue nangkep lu mau bikin jadwal ${intentData.judul} jam ${intentData.waktu}. mau lanjut chatan aja, atau fix buat agenda nih? bales iya kalau fix.` });
            
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
                resetState(fromJid);
                await handleCommand(sock, '/list', fromJid, () => setupSchedules(sock));
                
            } else {
                // JALUR EVALUASI BASA-BASI (CHAT MODE)
                if (['udahan', 'sip', 'oke dah', 'oke deh', 'makasih', 'thanks', 'yaudah', 'bray', 'oke'].some(w => lowText === w || lowText.includes(w))) {
                    if (userStates[fromJid] && userStates[fromJid].mode === 'chat') {
                        resetState(fromJid);
                        await sock.sendMessage(fromJid, { text: 'oke siap, obrolan gue tutup ya bray.' }, { quoted: msg });
                        return;
                    }
                }

                setState(fromJid, 'chat');
                const samples = config.styleProfiles?.[fromJid]?.samples || [];
                const reply = await generateMimicReply(text, samples);
                await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
            }
        }
        
        if (text && (!isGroup || isBotMentioned)) {
            recordSample(isGroup ? (msg.key.participant || fromJid) : fromJid, text);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();