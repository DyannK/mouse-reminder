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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

let scheduledTasks = [];
const pendingConfirmations = {};
let botJidNumber = null;

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
                    targetTextMap[jid] = (await generateAIText(reminder.message, {}, null, reminder.manualFallback, reminder.formal)).text;
                }
                for (const [jid, text] of Object.entries(targetTextMap)) {
                    await sock.sendMessage(jid, { text });
                }
            }, Math.random() * (reminder.jitterSeconds ?? 15) * 1000);
        }, { timezone: 'Asia/Jakarta' });
        scheduledTasks.push(task);
    });
    console.log(`Scheduler aktif: ${config.reminders.length} terdaftar.`);
}

async function handleCasualAIRequest(sock, msg, fromJid, text, config) {
    const isGroup = fromJid.endsWith('@g.us');
    
    const intent = await parseIntentFromText(text);

    // Proteksi Ketat: Jika detail waktu atau judul tidak ditangkap sempurna oleh AI
    if (intent.isReminder && (!intent.waktu || !intent.judul)) {
        intent.isReminder = false;
        intent.replyPasif = 'Gue nangkepnya lu mau bikin pengingat, tapi detail jam atau judulnya kurang jelas nih coy. Bisa diperjelas lagi kalimatnya, atau langsung pake perintah manual aja?';
    }

    if (intent.isReminder) {
        const tempId = `ai_${Date.now().toString().slice(-4)}`;
        pendingConfirmations[fromJid] = {
            id: tempId,
            judul: intent.judul,
            type: intent.type || 'deadline',
            waktuRaw: intent.waktu,
            milestonesRaw: intent.milestones || '1hari,2jam',
            scope: intent.isGroupTask || isGroup ? 'group' : 'personal'
        };

        const targetScope = pendingConfirmations[fromJid].scope === 'group' ? 'Kelompok' : 'Pribadi';
        await sock.sendMessage(fromJid, { 
            text: `Jadwal *[${pendingConfirmations[fromJid].judul}]* (${targetScope}) buat jam ${intent.waktu} udah gue siapin nih. Udah bener belum? Balas *iya* kalau oke ya.` 
        }, { quoted: msg });
    } else {
        // Balasan penolakan rapi atau obrolan biasa jika AI tidak paham maksud kalimatnya
        const reply = intent.replyPasif || 'Aduh, gue kurang paham maksud kalimat lu barusan nih coy.';
        await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });

    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Masukkan nomor WA bot: ');
        console.log('Pairing code:', await sock.requestPairingCode(phoneNumber.trim()));
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if ((lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            botJidNumber = sock.user.id.split(':')[0].split('@')[0];
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
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        let config = loadConfig();

        // 1. PRIORITAS UTAMA: Deteksi perintah garis miring secara manual terlebih dahulu
        if (text.startsWith('/')) {
            await handleCommand(sock, text, fromJid, () => setupSchedules(sock));
            return;
        }

        // 2. JALUR KONFIRMASI JADWAL
        if (pendingConfirmations[fromJid] && text.trim().toLowerCase() === 'iya') {
            const data = pendingConfirmations[fromJid];
            let targetTimestamp = Date.now();
            
            if (data.waktuRaw && data.waktuRaw.includes(':')) {
                const [hour, minute] = data.waktuRaw.split(':').map(Number);
                const hariIni = new Date();
                const targetDate = new Date(hariIni.getFullYear(), hariIni.getMonth(), hariIni.getDate(), hour, minute, 0);
                
                // Jika jam yang diminta sudah lewat dari waktu sekarang, asumsikan itu untuk besok sore
                if (targetDate.getTime() <= Date.now()) {
                    targetDate.setDate(targetDate.getDate() + 1);
                }
                targetTimestamp = targetDate.getTime();
            }

            if (data.type === 'deadline') {
                config.reminders.push({
                    id: data.id,
                    type: 'deadline',
                    scope: data.scope,
                    targetTimestamp: targetTimestamp,
                    judul: data.judul,
                    message: `⏰ {sisa} menuju \"{judul}\"!`,
                    manualFallback: data.judul,
                    nowMessage: `🔔 Sekarang waktunya \"{judul}\"!`,
                    nowManualFallback: data.judul,
                    milestones: [{ type: 'durasi', totalMinutes: 0, label: 'Sekarang', isAuto: true }],
                    firedMilestones: [],
                    pendingAITexts: {},
                    targets: [isGroup ? 'group' : fromJid],
                    mediaPath: null,
                    mediaType: null,
                    teamTracking: {}
                });
            }

            saveConfig(config);
            delete pendingConfirmations[fromJid];
            setupSchedules(sock);
            await sock.sendMessage(fromJid, { text: 'Jadwal udah gue simpen secara permanen ya.' });
            return;
        }

        // 3. JALUR CHAT KASUAL / TAG GRUP
        if (isGroup) {
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isBotMentioned = mentionedJids.some(j => j.split(':')[0].split('@')[0] === botJidNumber);

            if (isBotMentioned) {
                await handleCasualAIRequest(sock, msg, fromJid, text, config);
            }
        } else {
            if (isAuthorized(config, fromJid)) {
                await handleCasualAIRequest(sock, msg, fromJid, text, config);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();