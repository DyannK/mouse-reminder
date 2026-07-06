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
const { parseIntentFromText, generateMimicReply, summarizeChatLog } = require('./geminiClient');

const userStates = {};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

let scheduledTasks = [];
let botJidNumber = null;
let isCheckingDeadlines = false;

const CANCEL_WORDS = ['gajadi', 'batal', 'ntar aja', 'udahan', 'cancel', 'sip', 'oke', 'ok', 'thanks', 'makasih', 'yaudah'];

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

async function deliverToJids(sock, reminder, targetTextMap) {
    for (const [jid, text] of Object.entries(targetTextMap)) {
        try {
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
            await sock.sendMessage(jid, { text });
        } catch (err) {
            console.error(`gagal kirim ke ${jid}:`, err);
        }
    }
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
            for (const milestone of reminder.milestones) {
                const key = milestoneKey(milestone);
                if (reminder.firedMilestones.includes(key)) continue;

                const triggerTs = computeTriggerTimestamp(milestone, reminder.targetTimestamp);
                if (Date.now() >= triggerTs) {
                    const targetJids = resolveTargetsToJids(config, reminder.targets || ['group']);
                    const targetTextMap = {};
                    const textPesan = milestone.isAuto ? reminder.nowMessage : reminder.message;
                    
                    for (const jid of targetJids) {
                        targetTextMap[jid] = textPesan;
                    }

                    await deliverToJids(sock, reminder, targetTextMap);
                    reminder.firedMilestones.push(key);
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
                for (const jid of targetJids) targetTextMap[jid] = reminder.message;
                await deliverToJids(sock, reminder, targetTextMap);
            }, Math.random() * 15 * 1000);
        }, { timezone: 'Asia/Jakarta' });
        scheduledTasks.push(task);
    });

    scheduledTasks.push(cron.schedule('* * * * *', () => checkDeadlines(sock), { timezone: 'Asia/Jakarta' }));
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
        const senderName = msg.pushName || 'orang';
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        let config = loadConfig();

        if (isGroup && text) {
            logGroupMessage(senderName, text);
        }

        if (text.startsWith('/')) {
            resetState(fromJid);
            await handleCommand(sock, text, fromJid, () => setupSchedules(sock));
            return;
        }

        const isCancel = CANCEL_WORDS.some(w => text.toLowerCase().includes(w) || text.toLowerCase() === w);
        if (isCancel && userStates[fromJid]) {
            resetState(fromJid);
            await sock.sendMessage(fromJid, { text: 'oke sip, gue reset ya.' }, { quoted: msg });
            return;
        }

        if (userStates[fromJid]) {
            const state = userStates[fromJid];
            
            if (state.mode === 'confirm_schedule') {
                if (text.toLowerCase() === 'iya' || text.toLowerCase() === 'y') {
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
                        judul: data.judul,
                        message: `waktunya ${data.judul} bentar lagi nih!`,
                        manualFallback: data.judul,
                        nowMessage: `sekarang waktunya ${data.judul} coy!`,
                        nowManualFallback: data.judul,
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
                } else if (text.toLowerCase() === 'chatan') {
                    setState(fromJid, 'chat');
                    await sock.sendMessage(fromJid, { text: 'oke gas, mau ngobrolin apaan nih?' });
                } else {
                    await sock.sendMessage(fromJid, { text: 'mau lanjut chatan aja, atau fix buat agenda nih? balas iya atau chatan' });
                }
                return;
            }

            if (state.mode === 'chat') {
                const samples = config.styleProfiles?.[fromJid]?.samples || [];
                const reply = await generateMimicReply(text, samples);
                await sock.sendMessage(fromJid, { text: reply });
                setState(fromJid, 'chat'); 
                return;
            }
        }

        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isBotMentioned = mentionedJids.some(j => j.split(':')[0] === botJidNumber);

        if (!isGroup || isBotMentioned) {
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
                await handleCommand(sock, '/list', fromJid, () => setupSchedules(sock));
                
            } else {
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