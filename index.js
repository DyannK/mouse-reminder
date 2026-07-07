const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const readline = require('readline');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const { loadConfig, saveConfig } = require('./configManager');
const { handleCommand, isAuthorized, handleListCommand } = require('./commandHandler');
const { computeTriggerTimestamp, milestoneKey } = require('./deadlineParser');
const { computeNextCronFire, formatCronKeTeks } = require('./timeParser');
const { recordSample, buildStyleInstruction } = require('./styleProfiler');
const { initTelegramScraper } = require('./telegramScraper');

const { logGroupMessage, getGroupLogs } = require('./chatLogger');
const { generateAIText, generateTagReply, parseIntentFromText, generateMimicReply, generateDynamicStateText, summarizeChatLog } = require('./geminiClient');

const userStates = {};
const chatMemory = {};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

let scheduledTasks = [];
let botJidNumber = null;
let isCheckingDeadlines = false;

function pushToMemory(jid, sender, text) {
    if (!chatMemory[jid]) chatMemory[jid] = [];
    chatMemory[jid].push(`${sender}: ${text}`);
    if (chatMemory[jid].length > 12) chatMemory[jid].shift();
}

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

function getNick(jid, pushName, config) {
    const nameMap = {
        'dyan': 'yan',
        'medista': 'med',
        'fizar': 'zar',
        'prayoga': 'yog',
        'helmi': 'hel',
        'azanta': 'zan',
        'nadirah': 'nad',
        'samuel': 'sam'
    };
    
    let mappedName = config.accountMapping[jid];
    if (!mappedName && jid === config.ownerJid) mappedName = 'dyan';
    if (!mappedName) mappedName = pushName || 'coy';
    
    let firstName = mappedName.trim().split(/\s+/)[0].toLowerCase();
    
    if (nameMap[firstName]) return nameMap[firstName];
    for (const [key, val] of Object.entries(nameMap)) {
        if (firstName.includes(key)) return val;
    }
    
    if (firstName.length <= 4) return firstName;
    
    const isVowel = (ch) => ['a','e','i','o','u'].includes(ch);
    
    if (!isVowel(firstName[2]) && !isVowel(firstName[3])) {
        return firstName.slice(0, 3);
    }
    if (!isVowel(firstName[2])) {
        return firstName.slice(0, 3);
    }
    return firstName.slice(0, 2);
}

function getJakartaDateComponents(baseDate = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
    });
    const parts = formatter.formatToParts(baseDate);
    return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function calculateMilestonesArray(waktuTarget, waktuMulaiStr, intervalMin) {
    if (!waktuTarget || !waktuTarget.includes(':')) {
        return [{ type: 'durasi', totalMinutes: 0, label: 'sekarang', isAuto: true }];
    }
    
    const now = new Date();
    const tParts = getJakartaDateComponents(now);
    const [tHour, tMin] = waktuTarget.split(':').map(Number);
    
    let targetDate = new Date(`${tParts.year}-${tParts.month.padStart(2, '0')}-${tParts.day.padStart(2, '0')}T${String(tHour).padStart(2, '0')}:${String(tMin).padStart(2, '0')}:00+07:00`);
    if (targetDate.getTime() <= now.getTime()) {
        targetDate.setDate(targetDate.getDate() + 1);
    }

    let startDate = new Date(now.getTime());
    if (waktuMulaiStr && waktuMulaiStr.includes(':')) {
        const [sHour, sMin] = waktuMulaiStr.split(':').map(Number);
        let customStart = new Date(`${tParts.year}-${tParts.month.padStart(2, '0')}-${tParts.day.padStart(2, '0')}T${String(sHour).padStart(2, '0')}:${String(sMin).padStart(2, '0')}:00+07:00`);
        if (customStart.getTime() > targetDate.getTime()) {
            customStart.setDate(customStart.getDate() - 1);
        }
        startDate = customStart;
    }

    const diffMs = targetDate.getTime() - startDate.getTime();
    const diffMin = Math.floor(diffMs / (60 * 1000));
    let step = (intervalMin && intervalMin > 0) ? intervalMin : 0;

    if (diffMin <= 0 || step === 0) {
        return [{ type: 'durasi', totalMinutes: 0, label: 'sekarang', isAuto: true }];
    }

    let milestones = [];
    for (let minRemaining = 0; minRemaining <= diffMin; minRemaining += step) {
        milestones.push({
            type: 'durasi',
            totalMinutes: minRemaining,
            label: minRemaining === 0 ? 'sekarang' : `${minRemaining} menit lagi`,
            isAuto: minRemaining === 0
        });
    }

    return milestones.sort((a, b) => b.totalMinutes - a.totalMinutes);
}

async function sendDetailedConfirmation(sock, fromJid, data, quotedMsg) {
    const config = loadConfig();
    const isGroup = fromJid.endsWith('@g.us');
    
    let targetName = 'pribadi (gue)';
    if (data.extractedTarget) {
        const foundContact = config.contacts.find(c => c.name.toLowerCase() === data.extractedTarget.toLowerCase());
        if (foundContact) targetName = `personal ke nomor ${foundContact.name.toLowerCase()} (${foundContact.jid.split('@')[0]})`;
        else targetName = `personal ke ${data.extractedTarget.toLowerCase()} (belum ada di daftar kontak)`;
    } else if (isGroup) {
        try {
            const metadata = await sock.groupMetadata(fromJid);
            const memberNames = metadata.participants.map(p => config.accountMapping[p.id] || p.id.split('@')[0]);
            targetName = `kelompok di grup ini (anggota: ${memberNames.slice(0, 6).join(', ').toLowerCase()}${memberNames.length > 6 ? '... dan lainnya' : ''})`;
        } catch {
            targetName = `kelompok kelompok`;
        }
    }

    const intervalVal = data.intervalMinutes || 1;
    const milestones = calculateMilestonesArray(data.waktu, data.startTime, intervalVal);

    let confirmationText = `📋 *[KONFIRMASI AGENDA]*\n` +
        `• *judul aktivitas*: ${data.judul || 'agenda kasual'}\n` +
        `• *waktu sasaran*: jam ${data.waktu || 'belum diset'} wib\n` +
        `• *target penerima*: ${targetName}\n` +
        `• *skema alarm*: ${milestones.length} kali pengingat beruntun (interval tiap ${intervalVal} menit dari waktu mulai)\n` +
        `• *template durasi (mundur)*: "${data.pesanDurasi || `waktunya {judul} bentar lagi nih!`}"\n` +
        `• *template eksekusi (sekarang)*: "${data.pesanNow || `sekarang waktunya {judul} coy!`}"\n\n` +
        `📝 *sistem pengubah parameter diterima*:\n` +
        `lu bisa ketik kalimat kasual untuk mengubah manifes di atas secara langsung. contoh:\n` +
        `- _"ganti judul jadi rapat kelompok"_\n` +
        `- _"ganti jam jadi 15:45"_\n` +
        `- _"ganti pesan durasi jadi ai:ingetin santai bray"_\n` +
        `- _"ganti pesan sekarang jadi bray buruan kumpul"_\n` +
        `- _"ganti interval jadi 5 menit"_\n\n` +
        `balas *iya* untuk mengunci memori dan menyimpan agenda ini.`;

    await sock.sendMessage(fromJid, { text: confirmationText.toLowerCase() }, { quoted: quotedMsg });
}

function translateCronToHuman(cronPattern) {
    const parts = cronPattern.split(' ');
    if (parts.length !== 5) return cronPattern;
    const [min, hour, date, month, day] = parts;
    let desc = 'berjalan';
    if (min === '*' && hour === '*') desc += ' setiap menit';
    else if (min.startsWith('*/') && hour === '*') desc += ` kelipatan ${min.split('/')[1]} menit`;
    else desc += ` setiap jam ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    
    if (date !== '*') desc += ` pada tanggal ${date}`;
    if (month !== '*') desc += ` di bulan ke-${month}`;
    if (day !== '*') {
        const daysArr = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
        desc += ` setiap hari ${daysArr[parseInt(day, 10)] || day}`;
    }
    return desc.toLowerCase();
}

async function handleListDetail(sock, fromJid) {
    const config = loadConfig();
    const reminders = config.reminders || [];
    if (reminders.length === 0) {
        await sock.sendMessage(fromJid, { text: 'jadwal lu lagi kosong bersih bray.' });
        return;
    }
    let msg = `📋 *[DAFTAR AGENDA DETAIL]*\n\n`;
    reminders.forEach((r, idx) => {
        msg += `*${idx + 1}. [${r.judul}]* (ID: ${r.id})\n`;
        msg += `• tipe: ${r.type}\n`;
        msg += `• scope: ${r.scope}\n`;
        if (r.targetTimestamp) {
            const d = new Date(r.targetTimestamp);
            msg += `• waktu: ${d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} wib\n`;
        }
        if (r.cronPattern) msg += `• aturan pengulangan: ${translateCronToHuman(r.cronPattern)}\n`;
        msg += `• template durasi: "${r.message}"\n`;
        msg += `• template eksekusi: "${r.nowMessage || '-'}"\n`;
        if (r.milestones && r.milestones.length > 0) {
            msg += `• milestones:\n`;
            r.milestones.forEach(m => {
                msg += `  - [${m.label}] (durasi: ${m.totalMinutes || 0} mnt)\n`;
            });
        }
        if (r.mediaPath) msg += `• berkas media: ${path.basename(r.mediaPath)}\n`;
        msg += `-------------------------------------------\n`;
    });
    await sock.sendMessage(fromJid, { text: msg.trim().toLowerCase() });
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
    return { text: text.toLowerCase(), usedFallback: false };
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
            if (memberJid.includes(botJidNumber) || memberJid === config.ownerJid) continue;

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
        if (jid.includes(botJidNumber)) continue;

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

    await sock.sendMessage(config.groupJid, { text: report.trim().toLowerCase() });
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

                    const targetJids = (reminder.targets || ['group']).map(t => {
                        if (t === 'group') return config.groupJid;
                        if (t === 'personal') return config.ownerJid;
                        return t;
                    }).filter(Boolean);

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
                const targetJids = (reminder.targets || ['group']).map(t => {
                    if (t === 'group') return config.groupJid;
                    if (t === 'personal') return config.ownerJid;
                    return t;
                }).filter(Boolean);

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
        await sock.sendMessage(fromJid, { text: 'siap media sama caption udah gue gabungin ke pengingat pribadi lu bray' });
    } catch (err) {
        console.error('gagal olah media:', err);
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
            botJidNumber = sock.user.id.split(':')[0].split('@')[0];
            setupSchedules(sock);
            await initTelegramScraper(sock);
            rl.close();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const fromJid = msg.remoteJid || msg.key.remoteJid;
        const isGroup = fromJid.endsWith('@g.us');
        const senderJid = isGroup ? (msg.key.participant || fromJid) : fromJid;
        const senderName = msg.pushName || 'orang';
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';
        
        // KRUSIAL: Baris lowText ditarik ke paling atas scope pesan demi menangkal Temporal Dead Zone ReferenceError
        const lowText = text.trim().toLowerCase();
        
        let config = loadConfig();
        const samples = config.styleProfiles?.[senderJid]?.samples || [];
        const currentNick = getNick(senderJid, msg.pushName, config);

        if (isGroup && text) {
            logGroupMessage(senderName, text);
        }

        if (text) {
            pushToMemory(fromJid, currentNick, text);
        }

        // 1. GERBANG MANUAL UTAMA (SLASH INTERCEPTOR)
        if (text.startsWith('/')) {
            resetState(fromJid);
            const cmd = text.trim().toLowerCase();
            if (cmd === '/help') {
                const menuHelp = `🛠 *MENU UTAMA BANTUAN SINTAKSIS REMINDER BOT*\n` +
                    `--------------------------------------------------------\n\n` +
                    `📌 *PENGELOLAAN AGENDA MANUAL*\n` +
                    `• */tambah [Menit] [Jam] [Tgl] [Bulan] [Hari] | [Pesan]*\n` +
                    `  _Definisi_: Membuat pengingat alarm rutin jangka panjang.\n` +
                    `  _Contoh_: \`/tambah 0 7 * * * | bangun bray kuliah\`\n\n` +
                    `• */tambahdeadline [DD-MM-YYYY HH:MM] | [Judul] | [Milestones]*\n` +
                    `  _Definisi_: Membuat target deadline satu kali eksekusi.\n` +
                    `  _Contoh_: \`/tambahdeadline 07-07-2026 13:00 | uas elka | 1hari,2jam\`\n\n` +
                    `• */editpesan [id_agenda] [teks_template]*\n` +
                    `  _Definisi_: Mengubah isi teks pengingat durasi mundur.\n` +
                    `  _Contoh_: \`/editpesan ai_1510 ai:ingetin waktu kurang {sisa}\`\n\n` +
                    `• */editpesannow [id_agenda] [teks_template]*\n` +
                    `  _Definisi_: Mengubah isi teks pengingat pas waktu eksekusi.\n` +
                    `  _Contoh_: \`/editpesannow ai_1510 sekarang waktunya {judul}\`\n\n` +
                    `📌 *PENGATURAN PROFIL GAYA BAHASA*\n` +
                    `• */gayabicara [deskripsi_gaya]*\n` +
                    `  _Definisi_: Mengatur karakteristik ketikan lu secara manual di database.\n` +
                    `  _Contoh_: \`/gayabicara orangnya santai wajib pakai gue lo suka ketawa wkwk\`\n\n` +
                    `📌 *PEMERIKSAAN & ANALISIS OBROLAN*\n` +
                    `• */list* : Menampilkan seluruh daftar agenda secara singkat.\n` +
                    `• */listdetail* : Membedah parameter isi database secara transparan.\n` +
                    `• */rangkuman [jumlah_bubble]*\n` +
                    `  _Definisi_: Merangkum sejarah chat grup menjadi poin ringkas.\n` +
                    `  _Contoh_: \`/rangkuman 200\``;

                await sock.sendMessage(fromJid, { text: menuHelp.toLowerCase() }, { quoted: msg });
                return;
            }
            if (cmd === '/listdetail') {
                await handleListDetail(sock, fromJid);
                return;
            }
            if (cmd.startsWith('/rangkuman')) {
                const bubbleCount = parseInt(cmd.replace('/rangkuman', '').trim(), 10) || 200;
                const logs = getGroupLogs(bubbleCount);
                if (logs.length === 0) {
                    await sock.sendMessage(fromJid, { text: 'belum ada obrolan yang kerekam bray' });
                } else {
                    await sock.sendMessage(fromJid, { text: 'bentar gue rangkumin dulu ya' });
                    const summary = await summarizeChatLog(logs);
                    await sock.sendMessage(fromJid, { text: summary });
                }
                return;
            }
            
            if (cmd.startsWith('/tambah ') && text.includes('|')) {
                const parts = text.slice(8).split('|');
                const pattern = parts[0].trim();
                const pesan = parts[1].trim();
                const humanDesc = translateCronToHuman(pattern);
                await sock.sendMessage(fromJid, { text: `📋 *[VERIFIKASI MANUAL BACKEND]*\nsistem menerjemahkan perintah manual lu:\n• tipe: rutin berulang\n• pola kerja: ${humanDesc}\n• muatan pesan: "${pesan}"\n\nagenda langsung diamankan ke scheduler.` });
            }

            await handleCommand(sock, text, fromJid, () => setupSchedules(sock));
            return;
        }

        // 2. INTERCEPTOR BERKAS MEDIA MILIK PEMILIK
        if (!isGroup && fromJid === config.ownerJid && (msg.message.imageMessage || msg.message.videoMessage)) {
            await processMediaReminderDownload(sock, msg, fromJid, text, config);
            return;
        }

        // 3. JALUR PELACAKAN AKTIVITAS TIM KELOMPOK DENGAN BALASAN PENUTUP DYNAMIC AI MEMORY
        if (!isGroup) {
            let tracked = false;
            config.reminders.forEach(r => {
                if (r.teamTracking && r.teamTracking[fromJid] && r.teamTracking[fromJid].status !== 'Aktif') {
                    r.teamTracking[fromJid] = { status: 'Aktif', message: text };
                    tracked = true;
                }
            });
            if (tracked) {
                saveConfig(config);
                const aiReply = await generateMimicReply(text, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', aiReply);
                await sock.sendMessage(fromJid, { text: aiReply }, { quoted: msg });
                return;
            }
        }

        // 4. KONDISI LOCK INTERAKTIF: REKAYASA REVISI TEMPLATE SEBELUM DISIMPAN PERMANEN
        if (userStates[fromJid] && userStates[fromJid].mode === 'confirm_schedule') {
            const state = userStates[fromJid];
            
            if (['gajadi', 'batal', 'cancel', 'ntar aja'].some(w => lowText.includes(w))) {
                resetState(fromJid);
                const reply = await generateDynamicStateText(`oke bray pembuatan jadwal dibatalin ya ${currentNick}`, currentNick, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', reply);
                await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
                return;
            }

            if (/ganti judul|ubah judul/i.test(lowText)) {
                state.data.judul = text.replace(/ganti judul jadi|ubah judul jadi|ganti judul|ubah judul/gi, '').trim();
                await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                return;
            }
            if (/ganti jam|ubah jam|ganti waktu|ubah waktu/i.test(lowText)) {
                const foundTime = text.match(/\d{2}:\d{2}/)?.[0];
                if (foundTime) state.data.waktu = foundTime;
                await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                return;
            }
            
            if (/ganti pesan durasi|ubah pesan durasi|ganti template durasi/i.test(lowText)) {
                state.data.pesanDurasi = text.replace(/ganti pesan durasi jadi|ubah pesan durasi jadi|ganti template durasi jadi|ganti pesan durasi|ubah pesan durasi/gi, '').trim();
                await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                return;
            }
            if (/ganti pesan sekarang|ubah pesan sekarang|ganti pesan eksekusi|ubah pesan eksekusi/i.test(lowText)) {
                state.data.pesanNow = text.replace(/ganti pesan sekarang jadi|ubah pesan sekarang jadi|ganti pesan eksekusi jadi|ubah pesan eksekusi jadi|ganti pesan sekarang|ganti pesan eksekusi/gi, '').trim();
                await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                return;
            }

            if (/ganti interval|ubah interval|tiap|per/i.test(lowText)) {
                const matchDigits = lowText.match(/\d+/);
                if (matchDigits) {
                    let min = parseInt(matchDigits[0], 10);
                    if (lowText.includes('jam')) min *= 60;
                    state.data.intervalMinutes = min;
                }
                await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                return;
            }
            if (/ganti target|ubah target/i.test(lowText)) {
                state.data.extractedTarget = text.replace(/ganti target jadi|ubah target jadi|ganti target|ubah target/gi, '').trim();
                await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                return;
            }
            if (/hapus target/i.test(lowText)) {
                state.data.extractedTarget = null;
                await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                return;
            }

            const isYes = /\b(iya|ya|yoi|oke|ok|y|buat|fix|gas|bisa|iye|iyee|yee)\b/i.test(lowText) || lowText.includes('iya') || lowText.includes('iye') || lowText.includes('buat agenda');
            const isChat = /\b(chatan|ngobrol|chat|basa basi)\b/i.test(lowText) || lowText.includes('chatan');

            if (isYes) {
                const data = state.data;
                let targetTimestamp = Date.now();
                
                if (data.waktu && data.waktu.includes(':')) {
                    const [hour, minute] = data.waktu.split(':').map(Number);
                    const now = new Date();
                    const tParts = getJakartaDateComponents(now);
                    
                    let targetDate = new Date(`${tParts.year}-${tParts.month.padStart(2, '0')}-${tParts.day.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`);
                    if (targetDate.getTime() <= now.getTime()) {
                        targetDate.setDate(targetDate.getDate() + 1);
                    }
                    targetTimestamp = targetDate.getTime();
                }

                const intervalVal = data.intervalMinutes || 1;
                const finalMilestones = calculateMilestonesArray(data.waktu, data.startTime, intervalVal);

                let targetJidFinal = fromJid;
                let finalScope = isGroup ? 'group' : 'personal';
                
                if (data.extractedTarget) {
                    const foundContact = config.contacts.find(c => c.name.toLowerCase() === data.extractedTarget.toLowerCase());
                    if (foundContact) {
                        targetJidFinal = foundContact.jid;
                        finalScope = 'personal';
                    }
                }

                config.reminders.push({
                    id: `ai_${Date.now().toString().slice(-4)}`,
                    type: 'deadline',
                    scope: finalScope,
                    targetTimestamp: targetTimestamp,
                    judul: data.judul || 'agenda kasual',
                    message: data.pesanDurasi || `waktunya {judul} bentar lagi nih!`,
                    manualFallback: data.judul || 'agenda kasual',
                    nowMessage: data.pesanNow || `sekarang waktunya ${data.judul || 'agenda kasual'} coy!`,
                    nowManualFallback: data.judul || 'agenda kasual',
                    milestones: finalMilestones,
                    firedMilestones: [],
                    pendingAITexts: {},
                    targets: [finalScope === 'group' ? 'group' : targetJidFinal],
                    mediaPath: null,
                    mediaType: null,
                    teamTracking: {}
                });

                saveConfig(config);
                resetState(fromJid);
                setupSchedules(sock);
                
                const reply = await generateDynamicStateText(`jadwal udah gue simpen permanen ya ${currentNick}`, currentNick, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', reply);
                await sock.sendMessage(fromJid, { text: reply });
            } else if (isChat) {
                setState(fromJid, 'chat');
                const reply = await generateDynamicStateText(`oke gas mau ngobrolin apaan nih ${currentNick}`, currentNick, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', reply);
                await sock.sendMessage(fromJid, { text: reply });
            } else {
                const reply = await generateDynamicStateText(`mau lanjut chatan aja atau fix buat agenda nih? balas iya atau chatan ${currentNick}`, currentNick, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', reply);
                await sock.sendMessage(fromJid, { text: reply });
            }
            return;
        }

        // 5. INTERLOCK PEMBATALAN OVER-LIMIT DEBAT INTERAKTIF MILESTONES
        if (userStates[fromJid] && userStates[fromJid].mode === 'interval_correction') {
            const state = userStates[fromJid];
            const matchDigits = lowText.match(/\d+/);
            if (matchDigits) {
                let newInterval = parseInt(matchDigits[0], 10);
                if (lowText.includes('jam')) newInterval *= 60;
                
                state.data.originalData.intervalMinutes = newInterval;
                const testMilestones = calculateMilestonesArray(state.data.originalData.waktu, state.data.originalData.startTime, newInterval);
                
                if (testMilestones.length <= 30) {
                    setState(fromJid, 'confirm_schedule', state.data.originalData);
                    await sendDetailedConfirmation(sock, fromJid, state.data.originalData, msg);
                } else {
                    const reply = await generateDynamicStateText(`masih kebanyakan bray (${testMilestones.length} kali) gempor gue gila coba gedein lagi menit atau jamnya`, currentNick, samples, chatMemory[fromJid] || []);
                    pushToMemory(fromJid, 'bot', reply);
                    await sock.sendMessage(fromJid, { text: reply });
                }
            } else if (['gajadi', 'batal', 'cancel'].some(w => lowText.includes(w))) {
                resetState(fromJid);
                const reply = await generateDynamicStateText(`oke sip gue reset`, currentNick, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', reply);
                await sock.sendMessage(fromJid, { text: reply });
            } else {
                const reply = await generateDynamicStateText(`coba benerin lagi maksud lu gimana mau diganti tiap berapa menit atau berapa jam`, currentNick, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', reply);
                await sock.sendMessage(fromJid, { text: reply });
            }
            return;
        }

        // 6. JALUR UMUM UTAMA DETEKSI RADAR NIAT (HASIL AUDIT SINKRONISASI MENTION HIBRIDA INTEGRAL)
        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isBotMentioned = mentionedJids.some(j => j.includes(botJidNumber)) || lowText.includes('@bot') || lowText.includes(botJidNumber);

        if (!isGroup || isBotMentioned) {
            if (!isGroup && !isAuthorized(config, fromJid)) {
                await sock.sendMessage(fromJid, { text: 'akses terbatas daftar pake /daftar dulu cuy' });
                return;
            }

            // Pembersihan mandiri string tag @bot agar tidak merusak interpretasi parameter radar niat AI
            let processingText = text;
            if (isGroup) {
                processingText = text.replace(/@bot/gi, '').trim();
            }

            const intentData = await parseIntentFromText(processingText);

            if (intentData.intent === 'create_schedule') {
                const calculated = calculateMilestonesArray(intentData.waktu, intentData.startTime, intentData.intervalMinutes || 1);
                
                if (calculated.length > 30) {
                    setState(fromJid, 'interval_correction', { originalData: intentData, count: calculated.length });
                    const reply = await generateDynamicStateText(`ini yakin gue ngingetin ${calculated.length} kali? gempor gue gila bray, peladen bisa meledak. coba benerin lagi maksud lu gimana, mau diganti tiap berapa menit?`, currentNick, samples, chatMemory[fromJid] || []);
                    pushToMemory(fromJid, 'bot', reply);
                    await sock.sendMessage(fromJid, { text: reply });
                    return;
                }

                setState(fromJid, 'confirm_schedule', intentData);
                await sendDetailedConfirmation(sock, fromJid, intentData, msg);
            
            } else if (intentData.intent === 'summarize') {
                const logs = getGroupLogs(intentData.jumlahChat || 200);
                if (logs.length === 0) {
                    await sock.sendMessage(fromJid, { text: 'belum ada obrolan yang kerekam nih coy' });
                } else {
                    await sock.sendMessage(fromJid, { text: 'bentar gue rangkumin dulu ya' });
                    const summary = await summarizeChatLog(logs);
                    await sock.sendMessage(fromJid, { text: summary });
                }
                
            } else if (intentData.intent === 'read_schedule_detail') {
                resetState(fromJid);
                await handleListDetail(sock, fromJid);

            } else if (intentData.intent === 'read_schedule') {
                resetState(fromJid);
                await handleCommand(sock, '/list', fromJid, () => setupSchedules(sock));
                
            } else {
                if (['udahan', 'sip', 'oke dah', 'oke deh', 'makasih', 'thanks', 'yaudah', 'bray', 'oke'].some(w => lowText === w || lowText.includes(w))) {
                    if (userStates[fromJid] && userStates[fromJid].mode === 'chat') {
                        resetState(fromJid);
                        await sock.sendMessage(fromJid, { text: `oke siap obrolan gue tutup ya bray ${currentNick}` }, { quoted: msg });
                        return;
                    }
                }

                setState(fromJid, 'chat');
                const reply = await generateMimicReply(processingText, samples, chatMemory[fromJid] || []);
                pushToMemory(fromJid, 'bot', reply);
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