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
const groupCache = {}; // Tempat simpan memori grup biar ga diblokir server
const targetPesanTerproses = new Set(); // Tameng pelindung ID pesan masuk
const memoriKontenTerproses = new Map(); // Tameng hibrida isi teks anti-retry perangkat bray


const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// ====================================================================
// PELINDUNG GLOBAL AGAR PELADEN TERMUX TIDAK MUDAH MATI TOTAL
// ====================================================================
process.on('uncaughtException', (err) => {
    console.error('terdeteksi error global bray:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('terdeteksi janji error ga ketangkap bray:', reason);
});

let scheduledTasks = [];
let botJidNumber = null;
let botLidNumber = null; 
let isCheckingDeadlines = false;
const botStartTime = Date.now(); // Rekam waktu pertama kali bot dinyalain yan

// 1. MEMORI JANGKA PENDEK RAM KHUSUS LIVE OPINI GRUP (MAKSIMAL 60 CHAT)
let groupChatMemory = {};

// 2. DATABASE FILE TERPISAH KHUSUS RANGKUMAN SEJARAH KELOMPOK (MAKSIMAL 300 CHAT)
const logFilePath = path.join(__dirname, 'group_logs.json');

function writeGroupLog(jid, sender, text) {
    let logs = {};
    if (fs.existsSync(logFilePath)) {
        try { 
            logs = JSON.parse(fs.readFileSync(logFilePath, 'utf-8')); 
        } catch (e) { 
            logs = {}; 
        }
    }
    if (!logs[jid]) logs[jid] = [];
    
    logs[jid].push({ sender, text, timestamp: Date.now() });
    
    // Kunci batas maksimal ketat di 300 bubble dari past ke now biar ga bengkak yan
    if (logs[jid].length > 300) {
        logs[jid].shift();
    }
    fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2), 'utf-8');
}

function safeExtractAndParseJSON(rawText) {
    try {
        const start = rawText.indexOf('{');
        const end = rawText.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(rawText.slice(start, end + 1));
        }
        return JSON.parse(rawText.replace(/```json|```/gi, '').trim());
    } catch (e) {
        throw new Error(`Format JSON tidak valid bray: ${rawText}`);
    }
}

function readGroupLogs(jid, count = 100) {
    if (!fs.existsSync(logFilePath)) return [];
    try {
        const logs = JSON.parse(fs.readFileSync(logFilePath, 'utf-8'));
        const groupLogs = logs[jid] || [];
        // Slice minus mengambil dari pesan paling baru ditarik mundur ke belakang bray
        return groupLogs.slice(-count);
    } catch (e) {
        return [];
    }
}



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

function getNick(jid, pushName, config, style = 'stable', groupJid = null) {
    const nameMap = {
        'dyan': { stable: 'dyan', short: 'yan', variants: ['yan', 'yann', 'dyan'] },
        'medista': { stable: 'medista', short: 'med', variants: ['med', 'medistaaa', 'meds'] },
        'fizar': { stable: 'fizar', short: 'zar', variants: ['zar', 'fizar', 'zarr'] },
        'prayoga': { stable: 'yoga', short: 'yog', variants: ['yog', 'yoga', 'yogg'] },
        'helmi': { stable: 'helmi', short: 'hel', variants: ['hel', 'helmi', 'helmm'] },
        'azanta': { stable: 'azanta', short: 'zan', variants: ['zan', 'azanta', 'zann'] },
        'nadirah': { stable: 'nadira', short: 'nad', variants: ['nad', 'nadira', 'naddd'] },
        'samuel': { stable: 'samuel', short: 'sam', variants: ['sam', 'samuel', 'samms'] }
    };
    
    // CEK JALUR KAMUS BERSARANG BERBASIS KAMAR GRUP YAN
    let mappedName = null;
    if (groupJid && config.groupMappings?.[groupJid]?.[jid]) {
        mappedName = config.groupMappings[groupJid][jid];
    }
    
    // Fallback ke kamus global bawaan lama jika sub-kamar ga ketemu bray
    if (!mappedName) mappedName = config.accountMapping?.[jid];
    if (!mappedName && jid === config.ownerJid) mappedName = 'dyan';
    if (!mappedName) mappedName = pushName || 'coy';
    
    let firstName = mappedName.trim().split(/\s+/)[0].toLowerCase();
    
    if (nameMap[firstName]) {
        const data = nameMap[firstName];
        if (style === 'short') return data.short;
        if (style === 'variant') {
            const arr = data.variants;
            return arr[Math.floor(Math.random() * arr.length)];
        }
        return data.stable;
    }
    
    if (firstName.length <= 4) return firstName;
    const isVowel = (ch) => ['a','e','i','o','u'].includes(ch);
    const autoShort = (!isVowel(firstName[2]) && !isVowel(firstName[3])) || !isVowel(firstName[2]) 
        ? firstName.slice(0, 3) 
        : firstName.slice(0, 2);
        
    if (style === 'short' || style === 'variant') return autoShort;
    return firstName;
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

function calculateMilestonesArray(waktuTarget, waktuMulaiStr, intervalMin, customMilestones = null, targetTanggal = null, withDailyReminder = false, dailyReminderStartDate = null, dailyReminderTime = null) {
    if (!waktuTarget || !waktuTarget.includes(':')) {
        return [{ type: 'durasi', totalMinutes: 0, label: 'sekarang', isAuto: true }];
    }
    
    const now = new Date();
    const tParts = getJakartaDateComponents(now);
    const [tHour, tMin] = waktuTarget.split(':').map(Number);
    
    const tglString = targetTanggal || `${tParts.year}-${tParts.month.padStart(2, '0')}-${tParts.day.padStart(2, '0')}`;
    let targetDate = new Date(`${tglString}T${String(tHour).padStart(2, '0')}:${String(tMin).padStart(2, '0')}:00+07:00`);
    
    if (!targetTanggal && targetDate.getTime() <= now.getTime()) {
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
    
    let milestones = [];
    
    const buatLabelJamDinamis = (menitMundur) => {
        if (menitMundur === 0) return `waktu utama`;
        if (menitMundur >= 1440) {
            const hari = Math.floor(menitMundur / 1440);
            return `pengingat harian ${hari} hari sebelum hari H`;
        }
        return `${menitMundur} menit lagi menuju jam (${waktuTarget})`;
    };

    // SIRKUIT 1: EKSEKUSI JALUR INTERVAL PER MENIT JIKA AKTIF
    if (intervalMin && intervalMin > 0) {
        if (diffMin > 0) {
            for (let minRemaining = 0; minRemaining <= diffMin; minRemaining += intervalMin) {
                if (!milestones.some(m => m.totalMinutes === minRemaining)) {
                    milestones.push({
                        type: 'durasi',
                        totalMinutes: minRemaining,
                        label: buatLabelJamDinamis(minRemaining),
                        isAuto: minRemaining === 0
                    });
                }
            }
        }
    } 

    // SIRKUIT 2: EKSEKUSI JALUR KUSTOM ALARM HARI H JIKA ADA
    if (customMilestones && customMilestones.length > 0) {
        customMilestones.forEach(min => {
            if (min <= diffMin && !milestones.some(m => m.totalMinutes === min)) {
                milestones.push({
                    type: 'durasi',
                    totalMinutes: min,
                    label: buatLabelJamDinamis(min),
                    isAuto: min === 0
                });
            }
        });
    }

    // VALIASI PARADOKS: Matikan otomatis pelacakan harian jika targetnya adalah hari ini bray
    const tanggalHariIniStr = `${tParts.year}-${tParts.month.padStart(2, '0')}-${tParts.day.padStart(2, '0')}`;
    const amanWithDailyReminder = (targetTanggal === tanggalHariIniStr) ? false : withDailyReminder;

    // SIRKUIT 3: EKSEKUSI JALUR HARIAN BERTAHAP JIKA LULUS VALIDASI KALENDER
    if (amanWithDailyReminder && targetTanggal) {
        const [dHour, dMin] = (dailyReminderTime && dailyReminderTime.includes(':')) ? dailyReminderTime.split(':').map(Number) : [20, 0];
        let loopDate = dailyReminderStartDate ? new Date(`${dailyReminderStartDate}T00:00:00+07:00`) : new Date(now.getTime());
        let endLoopDate = new Date(targetDate.getTime());
        
        let dStart = new Date(loopDate.getFullYear(), loopDate.getMonth(), loopDate.getDate());
        let dEnd = new Date(endLoopDate.getFullYear(), endLoopDate.getMonth(), endLoopDate.getDate());
        
        while (dStart <= dEnd) {
            let dailyReminderDate = new Date(`${dStart.getFullYear()}-${String(dStart.getMonth() + 1).padStart(2, '0')}-${String(dStart.getDate()).padStart(2, '0')}T${String(dHour).padStart(2, '0')}:${String(dMin).padStart(2, '0')}:00+07:00`);
            
            if (dailyReminderDate.getTime() > now.getTime() && dailyReminderDate.getTime() <= targetDate.getTime()) {
                const dailyDiffMin = Math.floor((targetDate.getTime() - dailyReminderDate.getTime()) / (60 * 1000));
                if (dailyDiffMin >= 0 && !milestones.some(m => m.totalMinutes === dailyDiffMin)) {
                    milestones.push({
                        type: 'durasi',
                        totalMinutes: dailyDiffMin,
                        label: buatLabelJamDinamis(dailyDiffMin),
                        isAuto: dailyDiffMin === 0
                    });
                }
            }
            dStart.setDate(dStart.getDate() + 1);
        }
    }

    // KATUP PENGAMAN UTAMA: Pastikan menit ke-0 selaku waktu masuk acara selalu wajib hadir bray
    if (!milestones.some(m => m.totalMinutes === 0)) {
        milestones.push({ type: 'durasi', totalMinutes: 0, label: buatLabelJamDinamis(0), isAuto: true });
    }

    return milestones.sort((a, b) => b.totalMinutes - a.totalMinutes);
}

async function sendDetailedConfirmation(sock, jid, data, quotedMsg = null, debugInfo = null) {
    const config = loadConfig();
    let targetText = 'kelompok di grup ini';
    
    // JALUR DINAMIS DETEKSI NAMA ASLI KAMAR GRUP TARGET BRAY
    if (data.groupJidTarget) {
        try {
            if (!groupCache[data.groupJidTarget]) {
                groupCache[data.groupJidTarget] = await sock.groupMetadata(data.groupJidTarget);
            }
            targetText = `grup sirkel: "${groupCache[data.groupJidTarget].subject}"`;
        } catch {
            targetText = 'grup sirkel kuliah';
        }
    } else if (data.extractedTarget) {
        if (data.extractedTarget === 'sender') {
            targetText = `dyan (${jid.split('@')[0]})`;
        } else {
            targetText = data.extractedTarget;
        }
    }
    
    const intervalVal = data.intervalMinutes;
    const milestones = calculateMilestonesArray(
        data.waktu, 
        data.startTime, 
        intervalVal, 
        data.customMilestones, 
        data.tanggal, 
        data.withDailyReminder, 
        data.dailyReminderStartDate, 
        data.dailyReminderTime
    );

    const jamHarianTeks = data.dailyReminderTime || '20:00';
    let skemaText = '';
    
    if (data.type === 'recurring') {
        skemaText = `${milestones.length} kali pengingat rutin (setiap pola cron berdetak)`;
    } else if (data.intervalMinutes && data.intervalMinutes > 0) {
        skemaText = `${milestones.length} kali total pengingat (aktif: interval tiap ${data.intervalMinutes} menit)`;
    } else {
        skemaText = `${milestones.length} kali total pengingat (aktif: rutin harian jam ${jamHarianTeks} & kustom hari H [${(data.customMilestones || []).join(', ')}])`;
    }

    let barisWaktuTambahan = '';
    if (data.type === 'recurring') {
        barisWaktuTambahan = `• *Pola Rutin*: ${data.cronPattern ? translateCronToHuman(data.cronPattern) : 'setiap saat'}\n`;
    } else {
        barisWaktuTambahan = `• *Tanggal Target*: ${data.tanggal || 'hari ini / esok hari'}\n`;
        if (data.withDailyReminder) {
            barisWaktuTambahan += `• *Rentang Harian*: mulai ${data.dailyReminderStartDate || 'hari ini'} (tiap jam ${jamHarianTeks} wib)\n`;
        }
    }

    if (data.targetVibes && Object.keys(data.targetVibes).length > 0) {
        barisWaktuTambahan += `• *Vibe Kustom Target*:\n`;
        Object.entries(data.targetVibes).forEach(([nama, emosi]) => {
            barisWaktuTambahan += `  - ${nama}: vibes ${emosi}\n`;
        });
    }

    let debugHeaderTeks = '';
    if (debugInfo) {
        debugHeaderTeks = `⚙️ *[LOGGING DEBUG BACKEND]*\n` +
                          `• input teks: "${debugInfo.inputText}"\n` +
                          `• keputusan ai: ${debugInfo.keputusan}\n` +
                          `• payload json ai: ${debugInfo.rawPayload}\n` +
                          `-------------------------------------------\n\n`;
    }

    let confirmationText = debugHeaderTeks + 
        `📋 *[KONFIRMASI AGENDA]*\n` +
        `• *Judul Aktivitas*: ${data.judul || 'agenda kasual'}\n` +
        `• *Pembuat Agenda*: ${data.creator || 'tidak dikenal'} (${data.creatorJid || 'tidak ada nomor'})\n` +
        `• *Waktu Sasaran*: jam ${data.waktu || 'belum diset'} wib\n` +
        barisWaktuTambahan + 
        `• *Target Penerima*: ${targetText}\n` + 
        `• *Status Pelacakan*: ${data.withTracking !== false ? 'aktif' : 'nonaktif atau silent'}\n` +
        `• *Status Laporan*: ${data.withReport !== false ? 'aktif' : 'nonaktif'}\n` +
        `• *Skema Alarm*: ${skemaText}\n` + 
        `• *Template Durasi*: "${data.pesanDurasi || `waktunya {judul} bentar lagi nih!`}"\n` +
        `• *Template Eksekusi*: "${data.pesanNow || `sekarang waktunya {judul} bray!`}"\n\n` +
        `📝 *Sistem pengubah parameter diterima*:\n` +
        `lu bisa ketik kalimat kasual untuk mengubah manifes di atas secara langsung.\n` +
        `contoh: "ganti judul...", "ganti alarm...", "matikan laporan".\n\n` +
        `balas *iya* untuk mengunci memori dan menyimpan agenda ini.`;

    await sock.sendMessage(jid, { text: confirmationText }, { quoted: quotedMsg });
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

async function handleListDetail(sock, fromJid, senderJid) {
    const config = loadConfig();
    let reminders = config.reminders || [];
    
    const isOwner = fromJid === config.ownerJid || senderJid === config.ownerJid;
    const isGroup = fromJid.endsWith('@g.us');
    
    // KATUP PENYARING HIRARKI PRIVASI GRUP BRAY
    if (isGroup) {
        reminders = reminders.filter(r => r.groupJidTarget === fromJid);
    } else if (!isOwner) {
        reminders = reminders.filter(r => r.groupJidTarget === null || (r.teamTracking && r.teamTracking[senderJid]));
    } // Owner lewat PC bebas ngintip total lintas jagat raya bray bray!

    if (reminders.length === 0) {
        await sock.sendMessage(fromJid, { text: 'jadwal lu lagi kosong bersih bray.' });
        return;
    }
    let msg = `📋 *[DAFTAR AGENDA DETAIL]*\n\n`;
    reminders.forEach((r, idx) => {
        msg += `*${idx + 1}. [${r.judul}]* (ID: ${r.id})\n`;
        msg += `• tipe: ${r.type}\n`;
        
        if (r.targets && r.targets.length > 0) {
            const listTargetBersih = r.targets.map(t => {
                if (t === 'group') return 'grup kuliah';
                const nomorMurni = t.split('@')[0];
                const namaKamus = getNick(t, '', config, 'stable', r.groupJidTarget);
                return namaKamus ? `${namaKamus} (${nomorMurni})` : nomorMurni;
            }).join(', ');
            msg += `• target penerima: ${listTargetBersih}\n`;
        } else {
            msg += `• scope: ${r.scope}\n`;
        }

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
                let labelTeksFinal = m.label;
                
                if (r.targetTimestamp && m.totalMinutes !== undefined) {
                    const waktuAlarmMs = r.targetTimestamp - (m.totalMinutes * 60 * 1000);
                    const komponenJam = getJakartaDateComponents(new Date(waktuAlarmMs));
                    const teksJamMenit = `${String(komponenJam.hour).padStart(2, '0')}:${String(komponenJam.minute).padStart(2, '0')} WIB`;
                    
                    const mKey = milestoneKey(m);
                    const sudahKirim = r.firedMilestones && r.firedMilestones.includes(mKey);
                    const kenaMiss = r.missedMilestones && r.missedMilestones.includes(mKey);
                    
                    let emojiStatus = '⏳';
                    let teksStatus = '(menunggu waktu)';
                    
                    if (kenaMiss) {
                        emojiStatus = '❌';
                        teksStatus = '(gagal/server down)';
                    } else if (sudahKirim) {
                        emojiStatus = '✅';
                        teksStatus = '(terkirim)';
                    }
                    
                    if (m.totalMinutes === 0) {
                        labelTeksFinal = `${emojiStatus} [${teksJamMenit}] agenda dimulai ${teksStatus}`;
                    } else {
                        labelTeksFinal = `${emojiStatus} [${teksJamMenit}] pengingat ${m.totalMinutes} menit ${teksStatus}`;
                    }
                }
                msg += `  - ${labelTeksFinal}\n`;
            });
        }
        if (r.mediaPath) msg += `• berkas media: ${path.basename(r.mediaPath)}\n`;
        msg += `-------------------------------------------\n`;
    });
    await sock.sendMessage(fromJid, { text: msg.trim() });
}

async function resolveTemplateForJid(messageTemplate, manualFallback, jid, context = {}, formal = false) {
    const { loadConfig } = require('./configManager');
    const config = loadConfig();
    
    let bodyText = messageTemplate || '';
    
    // 1. PROSES SUBSTUSI VARIABEL UTAMA
    if (context.sisa) bodyText = bodyText.replace(/{sisa}/g, context.sisa);
    if (context.judul) bodyText = bodyText.replace(/{judul}/g, context.judul);
    
    // 2. DETEKSI APAKAH NOMOR INI MEMILIKI REQUES EMOSI KUSTOM INDIVIDUAL YAN
    const namaKamus = config.accountMapping?.[jid] || (jid.includes('169810692436109') || jid === config.ownerJid ? 'dyan' : '');
    const adaVibeKustom = context.targetVibes && namaKamus && context.targetVibes[namaKamus.toLowerCase()];

    // 3. JALUR KHUSUS JIKA TEMPLATE MEMAKAI AWALAN PEMICU AI ATAU MEMILIKI VIBE KUSTOM TARGET
    if ((messageTemplate || '').startsWith('AI:') || adaVibeKustom) {
        const { generateAIText } = require('./geminiClient');
        const { buildStyleInstruction } = require('./styleProfiler');
        
        let tema = bodyText;
        if (bodyText.startsWith('AI:')) {
            tema = bodyText.replace('AI:', '').trim();
        } else {
            // Katup otomatis: Jika template aslinya statis tapi target punya emosi kustom, paksa konversi ke prompt AI bray bray
            tema = `ingetin buat ngerjain agenda dengan muatan dasar kalimat: "${bodyText}"`;
        }
        
        // SUNTIKKAN INTERSEPTOR EMOSI KUSTOM DI SINI YAN BRAY!
        if (adaVibeKustom) {
            const emosiSpesifik = context.targetVibes[namaKamus.toLowerCase()];
            tema += `\n\nKOREKSI GAYA BAHASA KHUSUS UNTUK TARGET ${namaKamus.toUpperCase()}: Kamu WAJIB mengabaikan seluruh instruksi emosi atau vibe umum di atas bray! Ganti dan wajib gunakan getaran emosi/vibe/karakteristik bicara secara mutlak yaitu: "${emosiSpesifik}".`;
            
            // Otomatisasi Caps Lock jika penulisan emosinya huruf besar semua
            if (emosiSpesifik === emosiSpesifik.toUpperCase() && emosiSpesifik.replace(/[^a-zA-Z]/g, '').length > 0) {
                tema += `\nAturan tambahan: Wajib gunakan HURUF KAPITAL SEMUA (ALL CAPS) untuk outputnya bray bray!`;
            }
        }

        const cleanPrompt = tema.replace(/[^a-zA-Z]/g, '');
        const isAllUps = cleanPrompt.length > 0 && tema === tema.toUpperCase();

        if (isAllUps) {
            tema += `\n\nAturan format tulisan: Kamu WAJIB menggunakan HURUF KAPITAL SEMUA (ALL CAPS/UPPERCASE) untuk seluruh teks output tanpa kecuali! Jangan pakai huruf kecil sama sekali bray!`;
        } else {
            tema += `\n\nAturan format tulisan: wajib gunakan huruf kecil semua (lowercase) untuk seluruh kalimat dan kata panggilan, KECUALI untuk singkatan teknis, istilah/definisi khusus yang jarang disebutkan, atau produk unpopular yang aslinya memang berupa kapital penuh (contoh: FIFO, LIFO). Jangan gunakan huruf kapital untuk nama orang atau di awal kalimat biasa bray.`;
        }
        
        const styleInstruction = buildStyleInstruction(jid);
        const aiRes = await generateAIText(tema, context, styleInstruction, manualFallback, formal);
        bodyText = aiRes.text;
        
        return { text: bodyText, usedFallback: false };
    }

    // 4. JALUR UTAMA TEMPLATE MANUAL STATIS TANPA AI
    return { text: bodyText, usedFallback: false };
}

async function deliverToJids(sock, reminder, targetTextMap) {
    // Jalankan seluruh pengiriman secara paralel berseling biar ga mengular sekuensial bray
    const pengirimanPromises = Object.entries(targetTextMap).map(async ([jid, text], idx) => {
        try {
            // JANGKAR STAGGER: Beri jeda luncur bertahap antar kepala nomor tanpa memblokir thread utama
            await new Promise(r => setTimeout(r, idx * (1500 + Math.random() * 1000)));

            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 1500));

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
    });

    await Promise.all(pengirimanPromises);
}

// ====================================================================
// LANGKAH 1: FUNGSI INISIALISASI STRUKTUR DATA PELACAKAN KELOMPOK BARU
// ====================================================================
async function initializeTeamTracking(sock, groupJid, config) {
    const trackingData = {};
    
    try {
        if (!groupCache[groupJid]) {
            groupCache[groupJid] = await sock.groupMetadata(groupJid);
            setTimeout(() => { delete groupCache[groupJid]; }, 10 * 60 * 1000);
        }
        
        const metadata = groupCache[groupJid];
        const members = metadata.participants || [];
        
        for (const member of members) {
            const jid = member.id;
            if (jid.includes(botJidNumber)) continue;
            
            trackingData[jid] = {
                status: 'Belum Respon',
                reason: '',
                interrogationStage: 0,
                lastMsgId: null,
                isDelivered: false,
                notifiedInGroup: false
            };
        }
    } catch (err) {
        console.error('gagal membuat struktur pelacakan tim:', err.message);
    }
    
    return trackingData;
}


async function handleGroupTeamDistribution(sock, reminder, milestone, config) {
    try {
        // AMBIL JID TARGET KAMAR INDEPENDEN YANG TERSIMPAN DI REMINDER BRAY bray
        const targetGrupJid = reminder.groupJidTarget || config.groupJid;
        if (!targetGrupJid) return;

        if (!reminder.teamTracking || Object.keys(reminder.teamTracking).length === 0) {
            reminder.teamTracking = await initializeTeamTracking(sock, targetGrupJid, config);
            saveConfig(config);
        }

        if (!groupCache[targetGrupJid]) {
            groupCache[targetGrupJid] = await sock.groupMetadata(targetGrupJid);
            setTimeout(() => { delete groupCache[targetGrupJid]; }, 10 * 60 * 1000);
        }
        
        const groupMeta = groupCache[targetGrupJid];
        const members = groupMeta.participants || [];
        
        const tugasAnggotaPromises = members.map(async (member, idx) => {
            const memberJid = member.id;
            if (memberJid.includes(botJidNumber) || memberJid === config.ownerJid) return;
            if (reminder.scope === 'tertarget' && !reminder.targets.includes(memberJid)) return;

            const userTrack = reminder.teamTracking[memberJid] || { status: 'Belum Respon' };
            if (userTrack.status === 'Absen') return;

            await new Promise(r => setTimeout(r, idx * (3000 + Math.random() * 1000)));

            const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto, targetVibes: reminder.targetVibes, groupJidTarget: targetGrupJid };
            const messageTemplate = milestone.isAuto ? reminder.nowMessage : reminder.message;
            const manualFallback = milestone.isAuto ? reminder.nowManualFallback : reminder.manualFallback;

            let { text } = await resolveTemplateForJid(messageTemplate, manualFallback, memberJid, context, reminder.formal);
            
            let catatanKaki = '';
            if (userTrack.status === 'Belum Respon') {
                catatanKaki = `\n\n*catatan:* balas pesan pribadi ini buat ngasih konfirmasi keaktifan lu di grup ya bray.`;
            } else if (userTrack.status === 'Abu-Abu') {
                catatanKaki = `\n\n*catatan:* kemaren kan lu bilang gatau, gimana jadinya bray? sekarang udah bisa dipastikan belum? bales ya!`;
            } else if (userTrack.status === 'Hadir') {
                catatanKaki = `\n\n_lu kan udah konfirmasi hadir tadi, jadi tinggal stand by aja ya pas mulai, mantap bray!_`;
            }

            const pesanFinal = `${text}${catatanKaki}`;

            const namaPanggilan = getNick(memberJid, member.pushName || 'bray', config, 'variant', targetGrupJid);
            await sock.sendMessage(memberJid, { text: namaPanggilan.toLowerCase() });

            await new Promise(r => setTimeout(r, 1000));

            await sock.sendPresenceUpdate('composing', memberJid);
            await new Promise(r => setTimeout(r, 1500));
            
            const sentMsg = await sock.sendMessage(memberJid, { text: pesanFinal });
            
            if (reminder.teamTracking[memberJid]) {
                reminder.teamTracking[memberJid].lastMsgId = sentMsg.key.id;
            }
        });

        await Promise.all(tugasAnggotaPromises);
        saveConfig(config);
    } catch (err) {
        console.error('gagal distribusi ke tim:', err);
    }
}

async function generateAndSendTeamReport(sock, reminder, config) {
    const targetGrupJid = reminder.groupJidTarget || config.groupJid;
    if (!targetGrupJid) return;

    let report = `*[laporan akhir keaktifan kelompok]*\nagenda: *[${reminder.judul}]*\n\n`;

    try {
        if (!groupCache[targetGrupJid]) {
            groupCache[targetGrupJid] = await sock.groupMetadata(targetGrupJid);
            setTimeout(() => { delete groupCache[targetGrupJid]; }, 10 * 60 * 1000);
        }

        const groupMeta = groupCache[targetGrupJid];
        const members = groupMeta.participants || [];
        
        let listHadir = [];
        let listAbsen = [];
        let listNgilang = [];
        let listPasif = [];
        let listCentangSatu = [];
        let listGagalServer = [];

        for (const member of members) {
            const jid = member.id;
            if (jid.includes(botJidNumber)) continue;
            if (reminder.scope === 'tertarget' && !reminder.targets.includes(jid)) continue;

            const namaOrang = getNick(jid, member.pushName, config, 'stable', targetGrupJid);
            const track = reminder.teamTracking?.[jid] || { status: 'Belum Respon', reason: '', isDelivered: true };
            const apakahAdaMissed = reminder.missedMilestones && reminder.missedMilestones.length > 0;

            if (track.status === 'Hadir') {
                listHadir.push(`- ${namaOrang} (respon: ${track.message || 'bisa'})`);
            } else if (track.status === 'Absen') {
                listAbsen.push(`- ${namaOrang} (alasan: ${track.reason || 'ada urusan'})`);
            } else if (track.status === 'Abu-Abu') {
                listNgilang.push(`- ${namaOrang} (awal sempet bilang: ${track.reason || 'gatau'}, abis itu ngilang)`);
            } else {
                if (apakahAdaMissed && track.interrogationStage === 0) {
                    listGagalServer.push(`- ${namaOrang} (gagal terabsen / server sempat down bray)`);
                } else if (track.isDelivered === false) {
                    listCentangSatu.push(`- ${namaOrang} (nomor ga aktif / centang 1)`);
                } else {
                    listPasif.push(`- ${namaOrang} (silent reader / menyimak)`);
                }
            }
        }

        if (listHadir.length > 0) report += `*✅ anggota hadir/aktif:*\n${listHadir.join('\n')}\n\n`;
        if (listAbsen.length > 0) report += `*❌ anggota izin/absen:*\n${listAbsen.join('\n')}\n\n`;
        if (listGagalServer.length > 0) report += `*⚠️ tidak sempat terinterogasi (sistem down):*\n${listGagalServer.join('\n')}\n\n`;
        if (listNgilang.length > 0) report += `*⚠️ tidak konsisten (ngilang):*\n${listNgilang.join('\n')}\n\n`;
        if (listPasif.length > 0) report += `*💤 silent reader (pasif):*\n${listPasif.join('\n')}\n\n`;
        if (listCentangSatu.length > 0) report += `*🚫 nomor tidak aktif (centang 1):*\n${listCentangSatu.join('\n')}\n\n`;

        const teksFinalLaporan = report.trim();
        await sock.sendMessage(targetGrupJid, { text: teksFinalLaporan });

        if (!config.reports) config.reports = [];
        
        const existingRepIdx = config.reports.findIndex(r => r.agendaId === reminder.id);
        const reportData = {
            id: existingRepIdx !== -1 ? config.reports[existingRepIdx].id : `rep_${Date.now().toString().slice(-4)}`,
            agendaId: reminder.id,
            judul: reminder.judul,
            groupJidTarget: targetGrupJid,                                        // KUNCI AMAN ID KAMAR GRUP SASARAN BRAY
            tanggal: new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' }),
            teks: teksFinalLaporan
        };

        if (existingRepIdx !== -1) {
            config.reports[existingRepIdx] = reportData;
        } else {
            config.reports.push(reportData);
        }
        
        saveConfig(config);
        console.log(`[arsip] laporan ${reminder.judul} berhasil disimpan dengan id ${reportData.id}`);

    } catch (err) {
        console.error('gagal membuat laporan akhir kelompok:', err.message);
    }
}


async function checkDeadlines(sock) {
    if (isCheckingDeadlines) return;
    if (Date.now() - botStartTime < 30 * 1000) return;

    isCheckingDeadlines = true;

    try {
        const config = loadConfig();
        let changed = false;
        const idsToRemove = [];

        for (const reminder of config.reminders) {
            if (reminder.type !== 'deadline') continue;
            if (!reminder.pendingAITexts) reminder.pendingAITexts = {};
            if (!reminder.missedMilestones) reminder.missedMilestones = [];

            // BACALAH JID TARGET DINAMIS AGENDA ITU SENDIRI YAN
            const targetGrupJid = reminder.groupJidTarget || config.groupJid;

            if (Date.now() > (reminder.targetTimestamp + 2 * 60 * 1000)) {
                idsToRemove.push(reminder.id);
                changed = true;
                console.log(`[auto-clean] menghapus senyap agenda "${reminder.judul}" karena sudah kedalwarsa pas bot offline bray.`);
                continue; 
            }
            
            let missedMilestonesThisRun = [];
            let normalMilestonesThisRun = [];

            for (const milestone of reminder.milestones) {
                const key = milestoneKey(milestone);
                if (reminder.firedMilestones.includes(key)) continue;

                const triggerTs = computeTriggerTimestamp(milestone, reminder.targetTimestamp);

                if (Date.now() >= triggerTs) {
                    if (Date.now() - triggerTs >= 60 * 1000) {
                        missedMilestonesThisRun.push(milestone);
                    } else {
                        normalMilestonesThisRun.push(milestone);
                    }
                }
            }

            if (missedMilestonesThisRun.length > 0) {
                let jamMissedArr = missedMilestonesThisRun.map(m => {
                    const waktuAlarmMs = reminder.targetTimestamp - (m.totalMinutes * 60 * 1000);
                    const komponenJam = getJakartaDateComponents(new Date(waktuAlarmMs));
                    return `${String(komponenJam.hour).padStart(2, '0')}:${String(komponenJam.minute).padStart(2, '0')} WIB`;
                });

                const jamSekarang = new Date();
                const komponenSekarang = getJakartaDateComponents(jamSekarang);
                const teksSekarang = `${String(komponenSekarang.hour).padStart(2, '0')}:${String(komponenSekarang.minute).padStart(2, '0')} WIB`;

                let recoveryText = `⚠️ *[BACKEND RECOVERY NOTICE]*\n` +
                                   `mau ngingetin bray, sorry seharusnya gue ngingetin lo jam ${jamMissedArr.join(', dan ')}, karena server di belakang gue sempet mati jadi gue baru hidup lagi dan malah baru ngingetin lo di jam ${teksSekarang}.\n\n` +
                                   `• *agenda*: ${reminder.judul}`;

                missedMilestonesThisRun.forEach(m => {
                    const key = milestoneKey(m);
                    if (!reminder.firedMilestones.includes(key)) reminder.firedMilestones.push(key);
                    if (!reminder.missedMilestones.includes(key)) reminder.missedMilestones.push(key);
                });
                changed = true;

                const targetJids = (reminder.targets || ['group']).map(t => {
                    if (t === 'group') return targetGrupJid;
                    if (t === 'personal') return config.ownerJid;
                    return t;
                }).filter(Boolean);

                const targetTextMap = {};
                targetJids.forEach(jid => { targetTextMap[jid] = recoveryText; });

                await deliverToJids(sock, reminder, targetTextMap);

                if ((reminder.scope === 'group' || reminder.scope === 'tertarget') && reminder.withTracking !== false) {
                    const milestoneTerakhir = missedMilestonesThisRun[missedMilestonesThisRun.length - 1];
                    await handleGroupTeamDistribution(sock, reminder, milestoneTerakhir, config);
                }

                if (missedMilestonesThisRun.some(m => m.isAuto) && (reminder.scope === 'group' || reminder.scope === 'tertarget') && reminder.withReport !== false) {
                    setTimeout(async () => {
                        const freshConfig = loadConfig();
                        const freshReminder = freshConfig.reminders.find(r => r.id === reminder.id) || reminder;
                        await generateAndSendTeamReport(sock, freshReminder, freshConfig);
                    }, 5 * 60 * 1000);
                }
            }

            for (const milestone of normalMilestonesThisRun) {
                const key = milestoneKey(milestone);

                if ((reminder.scope === 'group' || reminder.scope === 'tertarget') && reminder.withTracking !== false) {
                    await handleGroupTeamDistribution(sock, reminder, milestone, config);
                }
                
                if (milestone.isAuto && (reminder.scope === 'group' || reminder.scope === 'tertarget') && reminder.withReport !== false) {
                    setTimeout(async () => {
                        const freshConfig = loadConfig();
                        const freshReminder = freshConfig.reminders.find(r => r.id === reminder.id) || reminder;
                        await generateAndSendTeamReport(sock, freshReminder, freshConfig);
                    }, 5 * 60 * 1000);
                }
                
                const targetJids = (reminder.targets || ['group']).map(t => {
                    if (t === 'group') return targetGrupJid;
                    if (t === 'personal') return config.ownerJid;
                    return t;
                }).filter(Boolean);

                const targetTextMap = {};
                const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto, targetVibes: reminder.targetVibes, groupJidTarget: targetGrupJid };
                const messageTemplate = milestone.isAuto ? reminder.nowMessage : reminder.message;
                const manualFallback = milestone.isAuto ? reminder.nowManualFallback : reminder.manualFallback;

                for (const jid of targetJids) {
                    const preGen = reminder.pendingAITexts[key]?.textsByJid?.[jid];
                    targetTextMap[jid] = preGen || (await resolveTemplateForJid(messageTemplate, manualFallback, jid, context, reminder.formal)).text;
                }

                await deliverToJids(sock, reminder, targetTextMap);
                reminder.firedMilestones.push(key);
                changed = true;
            }

            if (reminder.firedMilestones.length >= reminder.milestones.length) {
                idsToRemove.push(reminder.id);
            }
        }

        if (idsToRemove.length > 0) {
            for (const id of idsToRemove) {
                config.reminders.splice(config.reminders.findIndex(r => r.id === id), 1);
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
        
        // EKSEKUSI PEMICU POLA CRON BERKALA KULIAH LU YAN
        const task = cron.schedule(reminder.cronPattern, () => {
            setTimeout(async () => {
                const freshConfig = loadConfig();
                
                // JALUR SPEKTAKULER: AKTIFKAN INTEROGASI ABSEN TIM JIKA SCOPE KELOMPOK AKTIF BRAY
                if ((reminder.scope === 'group' || reminder.scope === 'tertarget') && reminder.withTracking !== false) {
                    const mockMilestoneNow = { label: 'waktu utama', isAuto: true, totalMinutes: 0 };
                    await handleGroupTeamDistribution(sock, reminder, mockMilestoneNow, freshConfig);
                    
                    if (reminder.withReport !== false) {
                        setTimeout(async () => {
                            const reportConfig = loadConfig();
                            const currentFreshReminder = reportConfig.reminders.find(r => r.id === reminder.id) || reminder;
                            await generateAndSendTeamReport(sock, currentFreshReminder, reportConfig);
                        }, 5 * 60 * 1000); // Kirim rangkuman absen ke grup 5 menit pasca-kuliah mulai bray
                    }
                }

                // KIRIM NOTIFIKASI PENGINGAT UTAMA SEPERTI BIASA
                const targetJids = (reminder.targets || ['group']).map(t => {
                    if (t === 'group') return freshConfig.groupJid;
                    if (t === 'personal') return freshConfig.ownerJid;
                    return t;
                }).filter(Boolean);

                const targetTextMap = {};
                for (const jid of targetJids) {
                    const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto, targetVibes: reminder.targetVibes };
                    targetTextMap[jid] = (await resolveTemplateForJid(reminder.message, reminder.manualFallback, jid, context, reminder.formal)).text;
                }
                await deliverToJids(sock, reminder, targetTextMap);
                
            }, Math.random() * (reminder.jitterSeconds ?? 15) * 1000);
        }, { timezone: 'Asia/Jakarta' });
        scheduledTasks.push(task);
    });

    // Ubah detakan kaku 1 menit cron menjadi sirkuit interval peka 10 detik sekali bray bray
    const deadlineTimer = setInterval(() => checkDeadlines(sock), 10 * 1000);
    scheduledTasks.push({ stop: () => clearInterval(deadlineTimer) });

    // ====================================================================
    // KATUP AUTO-DELETE: PEMBERSIH UTAMAA FILE MEDIA TG SETELAH 1 HARI YAN
    // ====================================================================
    scheduledTasks.push(cron.schedule('0 * * * *', () => {
        const targetDir = path.join(__dirname, '..', 'home-reminder'); 
        const directory = fs.existsSync(targetDir) ? targetDir : __dirname;
        
        fs.readdir(directory, (err, files) => {
            if (err) return;
            const now = Date.now();
            const oneDayInMs = 24 * 60 * 60 * 1000; 
            
            files.forEach(file => {
                if (file.startsWith('tgmedia_')) {
                    const filePath = path.join(directory, file);
                    fs.stat(filePath, (err, stats) => {
                        if (err) return;
                        if (now - stats.mtimeMs > oneDayInMs) {
                            fs.unlink(filePath, (err) => {
                                if (!err) console.log(`[auto-delete] berhasil hapus file media kedalwarsa: ${file}`);
                            });
                        }
                    });
                }
            });
        });
    }, { timezone: 'Asia/Jakarta' }));
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

        const kpsn = getJakartaDateComponents(new Date());
        const konteksWaktuMurni = `${kpsn.year}-${kpsn.month.padStart(2, '0')}-${kpsn.day.padStart(2, '0')} Jam ${kpsn.hour.padStart(2, '0')}:${kpsn.minute.padStart(2, '0')} WIB`;
        const intent = await parseIntentFromText(captionText, konteksWaktuMurni);
        const targetTime = intent.waktu || "07:00";

        config.reminders.push({
            id: data.type === 'recurring' ? `rec_${Date.now().toString().slice(-4)}` : `ai_${Date.now().toString().slice(-4)}`,
            type: data.type || 'deadline', 
            scope: finalScope,
            targetTimestamp: data.type === 'recurring' ? null : targetTimestamp,
            tanggal: data.tanggal || null,                                // SINKRONISASI DATA TANGGAL ABSOLUT
            dailyReminderStartDate: data.dailyReminderStartDate || null,  // SINKRONISASI BATAS AWAL HARIAN
            dailyReminderTime: data.dailyReminderTime || null,           
            withDailyReminder: data.withDailyReminder || false,
            targetVibes: data.targetVibes || null,                        // KUNCI AMAN DATA EMOSI KUSTOM DI DATABASE
            cronPattern: data.cronPattern || null,
            judul: data.judul || 'agenda kasual',
            message: data.pesanDurasi || `waktunya {judul} bentar lagi nih!`,
            manualFallback: data.judul || 'agenda kasual',
            nowMessage: data.pesanNow || `sekarang waktunya ${data.judul || 'agenda kasual'} coy!`,
            nowManualFallback: data.judul || 'agenda kasual',
            milestones: data.type === 'recurring' ? null : finalMilestones,
            customMilestones: data.customMilestones || null,
            firedMilestones: [],
            pendingAITexts: {},
            targets: finalScope === 'group' ? ['group'] : targetJidsFinal, 
            mediaPath: null,
            mediaType: null,
            teamTracking: {},
            creator: data.creator || 'dyan',       
            creatorJid: data.creatorJid || '',
            withTracking: data.withTracking !== false,
            withReport: data.withReport !== false
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
            // Rekam nomor HP asli bot
            botJidNumber = sock.user.id.split(':')[0].split('@')[0];
            // Rekam nomor LID akun bot (Jika ada)
            botLidNumber = sock.user.lid ? sock.user.lid.split(':')[0].split('@')[0] : null;
            
            setupSchedules(sock);
            await initTelegramScraper(sock);
            await checkDeadlines(sock); // SUNTIKAN INSTAN BIAR AGENDA KADALUARSA LANGSUNG NYAPU PAS BOOTING BRAY
            rl.close();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return; 
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // TAMENG LAPIS 1: SAKLAR ID PESAN SAMA (FAST-TRACK)
        const idPesanUnik = msg.key.id;
        if (targetPesanTerproses.has(idPesanUnik)) {
            console.log(`[pengaman] pesan id ${idPesanUnik} duplikat, abaikan bray.`);
            return;
        }

        if (msg.message.ephemeralMessage) { msg.message = msg.message.ephemeralMessage.message; }
        if (msg.message.viewOnceMessage) { msg.message = msg.message.viewOnceMessage.message; }
        if (msg.message.viewOnceMessageV2) { msg.message = msg.message.viewOnceMessageV2.message; }
        if (!msg.message) return;

        const fromJid = msg.remoteJid || msg.key.remoteJid;
        const isGroup = fromJid.endsWith('@g.us');
        const senderJid = isGroup ? (msg.key.participant || fromJid) : fromJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';
        
        // TAMENG LAPIS 2: KUNCI ISI TEKS + JEDA WAKTU (Pencegah duplikat beda ID akibat retry jaringan)
        const kunciKontenUnik = `${senderJid}_${text.trim().toLowerCase()}`;
        const waktuSekarang = Date.now();
        
        if (memoriKontenTerproses.has(kunciKontenUnik)) {
            const waktuLama = memoriKontenTerproses.get(kunciKontenUnik);
            if (waktuSekarang - waktuLama < 5000) { // Toleransi kunci kembar gaib 5 detik yan bray
                console.log(`[pengaman hibrida] teks "${text}" diabaikan karena terindikasi retransmisi jaringan bray.`);
                return;
            }
        }

        // JIKA LULOS KEDUA SECURITY, KUNCI PERMANEN DI MEMORI RAM YAN
        targetPesanTerproses.add(idPesanUnik);
        memoriKontenTerproses.set(kunciKontenUnik, waktuSekarang);

        // Katup pembersih sampah RAM Termux biar ga bengkak
        if (targetPesanTerproses.size > 200) {
            const kunciPertama = targetPesanTerproses.values().next().value;
            targetPesanTerproses.delete(kunciPertama);
        }
        if (memoriKontenTerproses.size > 100) {
            const kunciPertamaMap = memoriKontenTerproses.keys().next().value;
            memoriKontenTerproses.delete(kunciPertamaMap);
        }

        console.log(`📡 [radar terverifikasi] id: ${idPesanUnik} | teks: ${text}`);

        const lowText = text.trim().toLowerCase();
        const cmd = text.startsWith('/') ? lowText.split(' ')[0] : '';
        
        let config = loadConfig();
        
        // ====================================================================
        // MONITOR DEBUGGING TERMUX LIVE MULTI-GROUP
        // ====================================================================
        if (!config.activatedGroups) config.activatedGroups = [];
        const isBotActiveInGroup = config.activatedGroups.includes(fromJid);
        
        if (isGroup) {
            console.log(`🔍 [DEBUG LIVE MULTI-GROUP]`);
            console.log(`   • ID Kamar Grup Target : ${fromJid}`);
            console.log(`   • Nomor JID Pengirim   : ${senderJid}`);
            console.log(`   • Status Otak Bot      : ${isBotActiveInGroup ? 'CEPAT/AKTIF' : 'BEKU/NONAKTIF'}`);
            console.log(`   • Isi Teks Mentah      : "${text}"`);
            console.log(`   • Deteksi Perintah Baku: "${cmd}"`);
        }

        // ====================================================================
        // SIRKUIT PEMBEKUAN OTAK BOT OTOMATIS (VERSI PEKA SENSOR TAG GRUP & LID)
        // ====================================================================
        const apakahMintaAktif = lowText.includes('/botaktif');
        const automakerMintaPasif = lowText.includes('/botpasif');
        
        // TAMENG HIBRIDA: Cek kesamaan string kaku, nomor murni, atau ID LID unik milik lu yan bray
        const apakahOwnerYgNgetIK = fromJid === config.ownerJid || 
                                    senderJid === config.ownerJid || 
                                    senderJid.includes('169810692436109') ||
                                    (config.ownerJid && senderJid.split('@')[0] === config.ownerJid.split('@')[0]);

        if (isGroup && !isBotActiveInGroup) {
            if (apakahMintaAktif && apakahOwnerYgNgetIK) {
                config.activatedGroups.push(fromJid);
                saveConfig(config);
                await sock.sendMessage(fromJid, { text: '🔊 *[sirkuit otak diaktifkan]*\nhalo bray! bot resmi mencair dan stand by mengawal sirkel kamar grup ini sekarang!' }, { quoted: msg });
                return;
            }
            
            const apakahBotDimentionLokal = text && (lowText.includes('bot') || (botJidNumber && lowText.includes(botJidNumber)) || msg.mentionedJid?.includes(botJidNumber));
            if (apakahBotDimentionLokal) {
                console.log(`⚠️ [PEMBERITAHUAN] Pesan dari grup ini diabaikan peladen karena statusnya masih beku bray.`);
            }
            return; 
        }

        if (isGroup && automakerMintaPasif && apakahOwnerYgNgetIK) {
            config.activatedGroups = config.activatedGroups.filter(g => g !== fromJid);
            saveConfig(config);
            await sock.sendMessage(fromJid, { text: '🔕 *[sirkuit otak dibekukan]*\nbot resmi masuk mode tidur senyap bray. panggil owner buat ketik /botaktif lagi kalo mau nyalain.' }, { quoted: msg });
            return;
        }

        // Perbaiki variabel penyaring laporan agar sinkron ke bawah yan
        const isListLaporan = cmd === '/listlaporan' || ['list laporan', 'lihat laporan', 'tampilin laporan'].some(w => lowText === w);
        const isDetailLaporan = cmd.startsWith('/detaillaporan ') || lowText.startsWith('detail laporan ') || lowText.startsWith('buka laporan ');
        const isHapusLaporan = cmd.startsWith('/hapuslaporan ') || lowText.startsWith('hapus laporan ') || lowText.startsWith('delete laporan ');

        const currentNick = getNick(senderJid, msg.pushName, config, 'stable');
        let isBotMentioned = text && (text.includes(botJidNumber) || lowText.includes('bot') || msg.mentionedJid?.includes(botJidNumber));

        // =================================================================
        // MESIN PENGENDUS HIBRIDA GRUP (LOGGING DATABASE & REKAM RAM PASIF)
        // =================================================================
        if (isGroup) {
            // A. Catat pasif ke RAM jangka pendek buat kebutuhan live opini bray
            if (!groupChatMemory[fromJid]) groupChatMemory[fromJid] = [];
            groupChatMemory[fromJid].push({ sender: currentNick, text: text });
            if (groupChatMemory[fromJid].length > 60) groupChatMemory[fromJid].shift();

            // B. Tulis pasif ke database json file terpisah buat kebutuhan sejarah rangkuman
            writeGroupLog(fromJid, currentNick, text);
            
            // JALUR PENGGERAK KATA KUNCI RANGKUMAN MANUAL (HANYA RESPOND JIKA ADA KEYWORD RANGKUM)
            if (isBotMentioned && (lowText.includes('rangkum') || lowText.includes('summary') || lowText.includes('ringkas'))) {
                let requestedBubbles = 100;
                const bubbleMatch = text.match(/(\d+)\s*(bubble|pesan|chat)/i);
                if (bubbleMatch) {
                    requestedBubbles = parseInt(bubbleMatch[1], 10);
                    if (requestedBubbles > 300) requestedBubbles = 300;
                }
                
                const rawLogs = readGroupLogs(fromJid, requestedBubbles);
                
                if (rawLogs.length < 5) {
                    await sock.sendMessage(fromJid, { text: 'belum ada obrolan yang kerekam di database bray, coba ngobrol dulu' }, { quoted: msg });
                    return;
                }
                
                const transkripObrolan = rawLogs.map(c => `[${c.sender}]: ${c.text}`).join('\n');
                
                const analisisGrupPrompt = `Lu adalah anggota kelompok kuliah yang cerdas, solutif, dan menyimak dinamika obrolan grup dari pojokan. Rangkum obrolan berikut bray.
                
                Transkrip obrolan (${rawLogs.length} chat terakhir urut kronologis dari past ke now):
                ${transkripObrolan}
                
                Instruksi berpikir wajib:
                1. Buat rangkuman alur kejadian penting atau silang pendapat dalam bentuk daftar list menggunakan simbol pointer strip (-). Jangan dirunut dalam satu kalimat atau paragraf panjang panjang bray.
                2. Gunakan gaya bahasa semi tidak baku khas ketikan anak tongkrongan asli (contoh wajib: gunakan kata "bilang kalo" jangan "memberi tahu", gunakan "ga setuju karna" jangan "tidak setuju", gunakan kata "nyari", "ntar malem", "bray", "wkwk").
                3. Aturan penulisan wajib: gunakan huruf kecil semua (lowercase) untuk seluruh teks keluarannya tanpa kecuali bray.
                4. Hilangkan identitas lu sebagai robot atau AI. Jawab langsung dengan daftar pointer teks kasual tersebut tanpa kalimat basa-basi pembuka atau penutup kaku bray.`;
                
                const { generateAIText } = require('./geminiClient');
                const aiGroupRes = await generateAIText(analisisGrupPrompt, {}, '', 'sorry bray otak gue lagi agak nge-lag, coba jelasin intinya aja', false);
                
                await sock.sendMessage(fromJid, { text: aiGroupRes.text.trim() }, { quoted: msg });
                return;
            }
        }
        // =================================================================
        // SELESAI PENEMPELAN, SEKARANG LOGIKANYA AMAN DAN SINKRON BRAY
        // =================================================================

        // ====================================================================
        // SENSOR PENAPIS AMAN ARSIP LAPORAN BERBASIS KAMAR SEKAT GRUP YAN
        // ====================================================================
        if (fromJid === config.ownerJid || isGroup || config.accountMapping[senderJid]) {
            if (isListLaporan) {
                let arrRep = config.reports || [];
                
                if (isGroup) {
                    arrRep = arrRep.filter(r => r.groupJidTarget === fromJid);
                } else if (fromJid !== config.ownerJid) {
                    arrRep = arrRep.filter(r => {
                        const freshRem = config.reminders.find(rem => rem.id === r.agendaId);
                        return freshRem && freshRem.teamTracking && freshRem.teamTracking[senderJid];
                    });
                }

                if (arrRep.length === 0) {
                    await sock.sendMessage(fromJid, { text: 'arsip laporan kelompok masih kosong bersih bray.' }, { quoted: msg });
                    return;
                }
                let listTeks = `📂 *[ARSIP LAPORAN KELOMPOK]*\n\n`;
                arrRep.forEach((r, i) => {
                    listTeks += `${i + 1}. *[${r.judul}]*\n• id arsip: ${r.id}\n• tanggal: ${r.tanggal}\n-------------------------\n`;
                });
                listTeks += `\n_ketik *detail laporan [id]* atau */detaillaporan [id]* buat bongkar isi detail laporannya bray._`;
                await sock.sendMessage(fromJid, { text: listTeks }, { quoted: msg });
                return;
            }

            if (isDetailLaporan) {
                const targetId = text.replace(/\/detaillaporan|detail laporan|buka laporan/gi, '').trim().toLowerCase();
                const foundRep = (config.reports || []).find(r => r.id === targetId);
                
                if (!foundRep) {
                    await sock.sendMessage(fromJid, { text: `id arsip ${targetId} ga ketemu bray, coba cek daftarnya lagi.` }, { quoted: msg });
                    return;
                }
                
                if (!isGroup && fromJid !== config.ownerJid) {
                    const freshRem = config.reminders.find(rem => rem.id === foundRep.agendaId);
                    if (!freshRem || !freshRem.teamTracking || !freshRem.teamTracking[senderJid]) {
                        await sock.sendMessage(fromJid, { text: 'hak akses dikunci bray, lo ga terdaftar di tim kelompok agenda ini.' }, { quoted: msg });
                        return;
                    }
                }
                
                let detailTeks = `📑 *[DETAIL ARSIP LAPORAN]*\n• id: ${foundRep.id}\n• tanggal: ${foundRep.tanggal}\n\n${foundRep.teks}`;
                await sock.sendMessage(fromJid, { text: detailTeks }, { quoted: msg });
                return;
            }

            if (isHapusLaporan) {
                if (fromJid !== config.ownerJid && senderJid !== config.ownerJid) {
                    await sock.sendMessage(fromJid, { text: 'hanya owner sirkel kuliah yang berhak menghapus berkas arsip laporan bray!' }, { quoted: msg });
                    return;
                }
                const targetId = text.replace(/\/hapuslaporan|hapus laporan|delete laporan/gi, '').trim().toLowerCase();
                const repIdx = (config.reports || []).findIndex(r => r.id === targetId);
                
                if (repIdx === -1) {
                    await sock.sendMessage(fromJid, { text: `gagal hapus bray, id arsip ${targetId} emang ga ada di database.` }, { quoted: msg });
                    return;
                }
                
                config.reports.splice(repIdx, 1);
                saveConfig(config);
                await sock.sendMessage(fromJid, { text: `beres yan, arsip laporan dengan id ${targetId} udah gue apus permanen.` }, { quoted: msg });
                return;
            }
        }

        const samples = config.styleProfiles?.[senderJid]?.samples || [];
        // const currentNick = getNick(senderJid, msg.pushName, config, 'stable');
        const botNameClean = (sock.user.name || 'dyan 2').toLowerCase();

        // if (isGroup && text) {
        //     logGroupMessage(senderName, text);
        // }   

        // if (text) {
        //     pushToMemory(fromJid, currentNick, text);
        // }

        // 1. GERBANG MANUAL UTAMA (SLASH INTERCEPTOR)
        if (text.startsWith('/')) {
            const checkCmd = text.trim().toLowerCase().split(/\s+/)[0];
            const isLocalDrafCmd = userStates[fromJid]?.mode === 'confirm_schedule' && ['/judul', '/waktu', '/jam', '/alarm', '/pengingat'].includes(checkCmd);

            if (!isLocalDrafCmd) {
                resetState(fromJid);
                const cmd = text.trim().toLowerCase();
                if (cmd === '/help') {
                    resetState(fromJid);
                    const menuHelp = `🛠 *PANDUAN LENGKAP PENGGUNAAN ASISTEN REMINDER BOT*\n` +
                        `--------------------------------------------------------\n\n` +
                        `Sistem ini dirancang buat jagain agenda personal sekaligus mantau keaktifan anggota kelompok kuliah secara otomatis bray. Berikut adalah daftar perintah yang bisa lu gunain:\n\n` +
                        `📌 *1. PENGELOLAAN AGENDA RUTIN BERULANG*\n` +
                        `Perintah ini digunain buat bikin alarm pengingat yang bakal bunyi terus secara konsisten mengikuti pola waktu tertentu bray.\n` +
                        `• *Cara Kasual*: Bicara santai lewat chat, misal: "bot buatin jadwal rutin jam 07:00 buat kuliah elka"\n` +
                        `• *Cara Kaku*: \`/tambah [menit] [jam] [tanggal] [bulan] [hari] | [pesan pengingat]\`\n` +
                        `• *Contoh*: \`/tambah 0 7 * * * | bangun bray kuliah elka malem\`\n\n` +
                        `📌 *2. PENGELOLAAN TENGGAT WAKTU TUGAS KULIAH*\n` +
                        `Perintah ini dipake buat bikin target satu kali eksekusi tugas kelompok yang butuh hitung mundur dinamis bray.\n` +
                        `• *Cara Kasual*: Bicara santai lewat chat, misal: "bot tolong ingetin ada tugas pengkondisian sinyal besok jam 10:00"\n` +
                        `• *Cara Kaku*: \`/tambahdeadline [tanggal-bulan-tahun jam:menit] | [judul tugas] | [tangga alarm]\`\n` +
                        `• *Contoh*: \`/tambahdeadline 08-07-2026 13:00 | kuis power electronics | 1hari,2jam,15menit\`\n\n` +
                        `📌 *3. INTEGRASI PENGERUKAN INFORMASI TELEGRAM*\n` +
                        `Lu bisa ngintip informasi pengumuman penting dari Telegram dan meneruskannya langsung ke grup WhatsApp sirkel lu bray.\n` +
                        `• */tglist [nama_grup]* : Mengintip 10 daftar isi percakapan terakhir di grup Telegram sasaran bray.\n` +
                        `• */tgforward [nama_grup] [nomor_id_pesan]* : Meneruskan secara resmi pesan pilihan dari Telegram ke grup WhatsApp dalam resolusi tinggi asli tanpa kompresi burik bray.\n\n` +
                        `📌 *4. MANAJEMEN ARSIP LAPORAN KELOMPOK*\n` +
                        `• */listlaporan* : Menampilkan semua daftar arsip laporan kelompok bray.\n` +
                        `• */detaillaporan [id_arsip]* : Membongkar isi teks laporan keaktifan secara utuh bray.\n` +
                        `• */hapuslaporan [id_arsip]* : Menghapus berkas arsip lama bray.\n\n` +
                        `📌 *5. MODIFIKASI PARAMETER PAS PROSES KONFIRMASI DRAF*\n` +
                        `Pas draf pratinjau muncul di chat, lu bisa ketik kalimat santai berikut buat ngubah settingan parameter agenda sebelum disimpan bray:\n` +
                        `• *ganti judul jadi...* : Mengubah nama aktivitas agenda bray.\n` +
                        `• *ganti waktu jadi...* : Mengubah jam target operasi bray.\n` +
                        `• *matikan pelacakan* : Mengubah agenda jadi ramah tanpa perlu neror chat pribadi bray.\n` +
                        `• *matikan laporan* : Mengunci bot agar tidak mengirim draf laporan keaktifan ke grup bray.\n\n` +
                        `📌 *6. PENGENALAN IDENTITAS & KAMUS NOMOR KELOMPOK*\n` +
                        `Biar bot pinter manggil nama asli anak-anak kelompok pas nerbitin laporan atau interogasi chat pribadi, daftarin nama panggilan lu pake cara ini bray:\n` +
                        `• *Cara Kasual Mandiri*: Ketik di chat: "panggil gue [nama_panggilan_lu]"\n` +
                        `• *Cara Kaku Mandiri*: Ketik perintah: \`/panggilgue [nama_panggilan_lu]\`\n` +
                        `• *Cara Kasual Owner*: Khusus dyan buat daftarin nomor temen sepihak: "daftarin [nomor_hp] sebagai [nama_panggilan]"\n` +
                        `• *Cara Kaku Owner*: Khusus dyan mendaftarkan nomor lewat command: \`/daftarin [nomor_hp] [nama_panggilan]\``;

                    await sock.sendMessage(fromJid, { text: menuHelp }, { quoted: msg });
                    return;
                }
            }
            if (cmd === '/listdetail') {
                await handleListDetail(sock, fromJid);
                return;
            }
            if (cmd.startsWith('/rangkuman')) {
                const bubbleCount = parseInt(cmd.replace('/rangkuman', '').trim(), 10) || 200;
                const logs = readGroupLogs(fromJid, bubbleCount); // Menggunakan database hibrida terpisah bray
                if (logs.length === 0) {
                    await sock.sendMessage(fromJid, { text: 'belum ada obrolan yang kerekam di database bray' });
                } else {
                    await sock.sendMessage(fromJid, { text: 'bentar gue rangkumin dulu ya' });
                    const transkripObrolan = logs.map(c => `[${c.sender}]: ${c.text}`).join('\n');
                    const summary = await summarizeChatLog(transkripObrolan);
                    await sock.sendMessage(fromJid, { text: summary });
                }
                return;
            }
            
            // ====================================================================
            // PERINTAH UTAMA: INTIP 10 LIST CHAT TERAKHIR DI TELEGRAM BRAY
            // ====================================================================
            if (cmd.startsWith('/tglist')) {
                const groupName = text.slice(7).trim();
                if (!groupName) {
                    await sock.sendMessage(fromJid, { text: 'format salah bray, contoh: */tglist nama_grup_lu*' }, { quoted: msg });
                    return;
                }
                
                await sock.sendMessage(fromJid, { text: `bentar ya, gue intip dulu riwayat chat terakhir di grup telegram *${groupName}*...` }, { quoted: msg });
                
                try {
                    const { getRecentMessages } = require('./telegramScraper');
                    const result = await getRecentMessages(groupName, 10);
                    
                    // SUNTIKKAN JEDA SIMULASI NGETIK DI SINI BRAY BIAR GA BERUNTUN
                    await sock.sendPresenceUpdate('composing', fromJid);
                    await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500));
                    
                    let outText = `📋 *[intip chat telegram]*\nsumber: *${result.title}*\n\n`;
                    result.list.reverse().forEach(m => {
                        const snippet = m.text.length > 70 ? m.text.slice(0, 70) + '...' : m.text;
                        outText += `🆔 *id: ${m.id}*\n💬 ${snippet}\n-------------------------\n`;
                    });
                    outText += `\n_ketik */tgforward ${groupName} [id_pesan]* buat nerusin pesan pilihan lu resmi ke grup wa bray._`;
                    
                    await sock.sendMessage(fromJid, { text: outText }, { quoted: msg });
                } catch (err) {
                    await sock.sendMessage(fromJid, { text: `gagal ngintip telegram bray: ${err.message}` }, { quoted: msg });
                }
                return;
            }

            // ====================================================================
            // PERINTAH UTAMA: FORWARD PESAN PILIHAN BERDASARKAN ID NYA YAN
            // ====================================================================
            // ====================================================================
            // PERINTAH UTAMA: FORWARD PESAN PILIHAN BERDASARKAN ID NYA YAN
            // ====================================================================
            if (cmd.startsWith('/tgforward')) {
                const args = text.slice(10).trim().split(/\s+/);
                if (args.length < 2) {
                    await sock.sendMessage(fromJid, { text: 'format salah bray, contoh: */tgforward nama_grup id_pesan*' }, { quoted: msg });
                    return;
                }
                
                const messageId = args[args.length - 1];
                const groupName = text.slice(10).replace(messageId, '').trim();
                
                if (isNaN(messageId)) {
                    await sock.sendMessage(fromJid, { text: 'id pesan harus pake angka bray kocak' }, { quoted: msg });
                    return;
                }

                await sock.sendMessage(fromJid, { text: `siap bray, lagi ngambil data pesan id *${messageId}* dari telegram...` }, { quoted: msg });

                try {
                    const { fetchSingleMessage } = require('./telegramScraper');
                    const targetMsg = await fetchSingleMessage(groupName, messageId);
                    
                    let whatsappPayload = `*[DITERUSKAN DARI TELEGRAM]*\n`;
                    whatsappPayload += `Sumber: ${targetMsg.chatTitle}\n`;
                    whatsappPayload += `Pengirim: ${targetMsg.senderName}\n\n`;
                    whatsappPayload += targetMsg.text || '_[kiriman media gambar/video]_';

                    // JEDA SIMULASI MANUSIA SEBELUM FORWARD RESMI TERBIT BRAY
                    await sock.sendPresenceUpdate('composing', config.groupJid);
                    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

                    if (targetMsg.mediaPath && fs.existsSync(targetMsg.mediaPath)) {
                        const mediaBuffer = fs.readFileSync(targetMsg.mediaPath);
                        if (targetMsg.mediaType === 'image') {
                            await sock.sendMessage(fromJid, { image: mediaBuffer, caption: whatsappPayload });
                        } else if (targetMsg.mediaType === 'video') {
                            await sock.sendMessage(fromJid, { video: mediaBuffer, caption: whatsappPayload });
                        }
                        await sock.sendMessage(fromJid, { text: `beres bray, pesan media HD id ${messageId} sukses diteruskan ke kamar ini!` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(fromJid, { text: whatsappPayload });
                        await sock.sendMessage(fromJid, { text: `beres bray, pesan teks id ${messageId} sukses diteruskan ke kamar ini!` }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(fromJid, { text: `gagal nerusin pesan bray: ${err.message}` }, { quoted: msg });
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

        // 3. JALUR PELACAKAN AKTIVITAS TIM KELOMPOK (INTEROGASI AI DINAMIS HYBRID)
        if (!isGroup) {
            // Cari apakah ada agenda aktif yang sedang melacak nomor ini dan belum selesai konfirmasi
            let activeReminder = config.reminders.find(r => r.teamTracking && r.teamTracking[fromJid] && !['Hadir', 'Absen'].includes(r.teamTracking[fromJid].status));
            
            if (activeReminder) {
                let track = activeReminder.teamTracking[fromJid];
                track.interrogationStage = (track.interrogationStage || 0) + 1;

                // Rekayasa instruksi perintah agar Gemini bertindak sebagai pengabsen pintar kelompok kuliah
                const systemPrompt = `Lu adalah asisten pengabsen kelompok kuliah yang tegas tapi santai. Seseorang bernama ${currentNick} memberikan jawaban ini untuk konfirmasi kehadiran agenda "${activeReminder.judul}": "${text}".
                Riwayat obrolan sebelumnya dengan orang ini: ${JSON.stringify(chatMemory[fromJid] || [])}.
                Tahap interogasi saat ini: ke-${track.interrogationStage} (Maksimal 2 kali tanya).

                Aturan klasifikasi dan tindakan wajib:
                1. Jika dia memastikan BISA atau HADIR: Set status menjadi "Hadir", reason menjadi "-", selesai menjadi true. Berikan kalimat penutup santai seperti "oke noted".
                2. Jika dia bilang "bisa tapi sakit": Tanyakan untuk memastikan kembali serius bisa atau tidak. Set status menjadi "Belum Respon", reason menjadi "sakit tapi diusahakan", selesai menjadi false.
                3. Jika dia tidak bisa karena "urusan keluarga" atau "urusan": Set status menjadi "Absen", reason menjadi "urusan keluarga" atau "urusan", selesai menjadi true. Langsung berikan kalimat penutup "oke noted" tanpa bertanya lagi.
                4. Jika dia tidak bisa karena "sakit": Tanyakan detail ringkas untuk memperjelas biar yang lain tahu contohnya "boleh tau ga lo sakit kenapa? biar yg laen pd tau gitu". Set status menjadi "Belum Respon", reason menjadi "sakit", selesai menjadi false. Jika ini sudah tahap ke-2, langsung kunci status menjadi "Absen" dan doakan lekas sembuh.
                5. Jika dia tidak bisa karena "rapat": Tanyakan rapat apa untuk memperjelas contohnya "rapat apa bray? rapat himpunan kah?". Set status menjadi "Belum Respon", reason menjadi "rapat", selesai menjadi false. Jika ini sudah tahap ke-2, langsung kunci status menjadi "Absen".
                6. Jika dia menjawab "gatau" atau ragu-ragu: Set status menjadi "Abu-Abu", reason menjadi "belum pasti", selesai menjadi true untuk sesi ini. Balas dengan kalimat penutup bahwa nanti akan diingatkan lagi di pengingat berikutnya.
                7. Jika dia sengaja mengalihkan pembicaraan atau iseng: Bersikap tegas, jangan alihkan pembicaraan, minta jawaban fokus pada kehadiran. Set status menjadi "Belum Respon", selesai menjadi false.
                8. Jika tahap interogasi sudah mencapai batas atau tahap ke-2 atau lebih dan dia tetap tidak jelas memberikan jawaban lanjutan, ambil kesimpulan akhir secara sepihak, set status menjadi "Hadir" atau "Absen", dan selesai menjadi true.

                Format output wajib berupa JSON mentah tanpa markdown, tanpa tulisan json, dan tanpa tanda backtick, ikuti struktur ini:
                {"status": "Hadir/Absen/Abu-Abu/Belum Respon", "reason": "intisari alasan pendek", "done": true, "reply": "teks balasan bot untuk chat pribadi"}
                Gunakan nama panggilan ${currentNick} dalam teks balasan lu.`;

                // Tembak instruksi terstruktur ke server AI
                const aiResponse = await resolveTemplateForJid(`AI:${systemPrompt}`, '', fromJid, {});
                
                try {
                    const cleanJsonStr = aiResponse.text.replace(/```json|```/gi, '').trim();
                    const aiResult = JSON.parse(cleanJsonStr);

                    // Update data tracking di database sesuai keputusan cerdas AI
                    track.status = aiResult.status;
                    if (aiResult.reason) track.reason = aiResult.reason;
                    track.message = text; 

                    saveConfig(config);

                    // Kirim respon balik interogasi ke chat pribadi target
                    pushToMemory(fromJid, 'bot', aiResult.reply);
                    await sock.sendMessage(fromJid, { text: aiResult.reply }, { quoted: msg });

                    // JALUR OTOMATIS: Kirim ringkasan satu baris ke grup jika statusnya resmi menjadi Absen
                    if (aiResult.status === 'Absen' && !track.notifiedInGroup) {
                        track.notifiedInGroup = true;
                        saveConfig(config);
                        
                        const ringkasanGrup = `*[laporan absen awal]*\n${currentNick} resmi izin ga bisa ikut agenda *[${activeReminder.judul}]* karena *${aiResult.reason || 'ada urusan'}*.`;
                        await sock.sendMessage(config.groupJid, { text: ringkasanGrup });
                    }

                    return;
                } catch (jsonErr) {
                    console.error('Gagal memproses keputusan JSON AI interogasi:', jsonErr.message);
                    const fallbackReply = "oke noted bray, data lu udah gue tampung dulu.";
                    await sock.sendMessage(fromJid, { text: fallbackReply }, { quoted: msg });
                    return;
                }
            }
        }

        // ====================================================================
        // KONDISI LOCK INTERAKTIF: PENANGKAP PILIHAN JADWAL KEDALWARSA BARU
        // ====================================================================
        if (userStates[fromJid] && userStates[fromJid].mode === 'past_time_check') {
            if (isGroup && !isBotMentioned) {
                // Biarkan lewat ke logger grup bawah bray
            } else {
                const state = userStates[fromJid];
                
                const promptRevisiWaktuLampau = `Kamu adalah mesin pembaca keputusan koreksi agenda kuliah kadaluwarsa.
Data draf saat ini: ${JSON.stringify(state.data)}
User membalas dengan ketikan bebas: "${text}"

Tugas kamu adalah menentukan niat perkataan user ke dalam salah satu keputusan JSON murni:
1. "besok": Jika user ingin menjadwalkan agenda ini untuk esok hari di jam yang sama (seperti: "besok aja", "ubah besok", "dirubah besok", "esok").
2. "hapus": Jika user ingin membatalkan draf karena salah ketik atau emang ga jadi (seperti: "hapus", "batal", "cancel", "gajadi").
3. "edit": Jika user ingin merevisi atau mengganti jamnya ke waktu baru hari ini yang belum lewat (seperti: "rubah jadi jam 23:59 hari ini", "ganti waktu dong jadi jam 23:10"). Ambil angka jam menit digitalnya dan taruh di properti "waktu_baru" format HH:MM.

Format keluaran WAJIB objek JSON mentah murni tanpa tanda backtick markdown, tanpa tulisan json, dan tanpa teks penjelas apa pun:
{
  "keputusan": "besok" | "hapus" | "edit",
  "waktu_baru": string atau null
}`;

                try {
                    const { generateAIText } = require('./geminiClient');
                    const aiRes = await generateAIText(promptRevisiWaktuLampau, {}, '', '{}', false);
                    
                    // MENGGUNAKAN TAMENG EKSTRAKSI AMAN BARU DI AREA PAST TIME CHECK
                    const ptResult = safeExtractAndParseJSON(aiRes.text);

                    if (ptResult.keputusan === 'besok') {
                        setState(fromJid, 'confirm_schedule', state.data);
                        await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                        return;
                    }
                    
                    if (ptResult.keputusan === 'hapus') {
                        resetState(fromJid);
                        await sock.sendMessage(fromJid, { text: `oke siap bray, draf agenda buat "${state.data.judul || 'agenda kasual'}" resmi gue apus dari memori ya wkwk` }, { quoted: msg });
                        return;
                    }
                    
                    if (ptResult.keputusan === 'edit' && ptResult.waktu_baru) {
                        state.data.waktu = ptResult.waktu_baru;
                        // Alirkan status draf langsung maju ke gerbang konfirmasi utama bray!
                        setState(fromJid, 'confirm_schedule', state.data);
                        await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                        return;
                    }

                    // Katup pengaman jika teks AI tidak stabil bray
                    await sock.sendMessage(fromJid, { text: `maksud lu gimana yan, mau diganti buat *besok*, diubah jamnya ke waktu baru hari ini, atau draf agendanya mau gue *hapus* aja nih?` }, { quoted: msg });

                } catch (err) {
                    console.error('gagal urai keputusan past_time_check:', err.message);
                    await sock.sendMessage(fromJid, { text: `maksud lu gimana yan, draf agenda "${state.data.judul}" mau diganti besok atau dihapus aja?` }, { quoted: msg });
                }
                return;
            }
        }

        // 4. KONDISI LOCK INTERAKTIF: REKAYASA REVISI TEMPLATE SEBELUM DISIMPAN PERMANEN
        if (userStates[fromJid] && userStates[fromJid].mode === 'confirm_schedule') {
            // JIKA DI GRUP DAN LU GA NGETAG BOT, BIARKAN CHAT LEWAT JANGAN DIINTERCEPT YAN!
            if (isGroup && !isBotMentioned) {
                // Biarkan lolos ke logger grup bawah
            } else {
                const state = userStates[fromJid];
                
                // ====================================================================
                // LAPIS 1: DETEKSI PERINTAH BAKU SLASH LOKAL (MUTLAK & INSTAN)
                // ====================================================================
                if (text.startsWith('/')) {
                    const args = text.slice(1).trim().split(/\s+/);
                    const subCmd = args[0].toLowerCase();
                    const restText = args.slice(1).join(' ').trim();

                    if (subCmd === 'judul') {
                        if (restText) state.data.judul = restText;
                        await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                        return;
                    }
                    if (subCmd === 'waktu' || subCmd === 'jam') {
                        const foundTime = restText.match(/\d{2}:\d{2}/)?.[0];
                        if (foundTime) state.data.waktu = foundTime;
                        await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                        return;
                    }
                    if (subCmd === 'alarm' || subCmd === 'pengingat') {
                        const matches = restText.match(/\d+/g);
                        if (matches) {
                            state.data.customMilestones = matches.map(Number).sort((a, b) => b - a);
                            state.data.intervalMinutes = null;
                        }
                        await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                        return;
                    }
                }

                // ====================================================================
                // LAPIS 2: JALUR CEPAT TOMBOL PENGUNCI JADWAL (MILIDETIK)
                // ====================================================================
                const hasEditKeywords = ['ganti', 'ubah', 'template', 'pesan', 'alarm', 'skema', 'durasi', 'eksekusi', 'jam', 'waktu', 'judul', 'samain', 'kaya', 'jadi', 'dibikin', 'interval', 'permenit', 'menit'].some(w => lowText.includes(w));
                const isYes = !hasEditKeywords && (/\b(yes|yess|yesss|betul|betuul|betull|betulll|iya|ya|yoi|fix|save|simpan|iye|iyee|sip|sipp|sippp|wokee|woke|yow|yowes|yoww|oke|okee|okeee|okay|okaay|okaaay|})\b/i.test(lowText) || lowText === 'y' || lowText === 'iya gitu');
                
                if (isYes) {
                    const data = state.data; 
                    let targetTimestamp = Date.now();
                    
                    // Rekonstruksi matematika konversi jam dinding digital Jakarta yan
                    if (data.waktu && data.waktu.includes(':')) {
                        const [hour, minute] = data.waktu.split(':').map(Number);
                        const now = new Date();
                        const tParts = getJakartaDateComponents(now);
                        
                        // JANGKAR BARU: Gunakan tanggal absolut dari data AI jika ada bray!
                        const targetTgl = data.tanggal || `${tParts.year}-${tParts.month.padStart(2, '0')}-${tParts.day.padStart(2, '0')}`;
                        let targetDate = new Date(`${targetTgl}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`);
                        
                        // Katup pengaman bawaan lama hanya bekerja jika user tidak menset tanggal kalender spesifik bray
                        if (!data.tanggal && targetDate.getTime() <= now.getTime()) {
                            targetDate.setDate(targetDate.getDate() + 1);
                        }
                        targetTimestamp = targetDate.getTime();
                    }

                    const intervalVal = data.intervalMinutes;
                    const finalMilestones = calculateMilestonesArray(data.waktu, data.startTime, intervalVal, data.customMilestones, data.tanggal, data.withDailyReminder);

                    let targetJidsFinal = [fromJid];
                    let finalScope = isGroup ? 'group' : 'personal';
                    
                    if (data.extractedTarget) {
                        const cleanTargetStr = data.extractedTarget.toLowerCase();
                        let mappedJids = [];
                        
                        if (cleanTargetStr === 'sender') {
                            mappedJids.push(senderJid);
                        } else {
                            Object.entries(config.accountMapping || {}).forEach(([jid, name]) => {
                                if (cleanTargetStr.includes(name.toLowerCase())) {
                                    mappedJids.push(jid);
                                }
                            });
                        }

                        if (mappedJids.length > 0) {
                            targetJidsFinal = mappedJids;
                            finalScope = mappedJids[0] === senderJid && mappedJids.length === 1 ? 'personal' : 'tertarget'; 
                        } else {
                            const foundContact = config.contacts?.find(c => c.name.toLowerCase() === data.extractedTarget.toLowerCase());
                            if (foundContact) {
                                targetJidsFinal = [foundContact.jid];
                                finalScope = 'personal';
                            }
                        }
                    }

                    config.reminders.push({
                        id: data.type === 'recurring' ? `rec_${Date.now().toString().slice(-4)}` : `ai_${Date.now().toString().slice(-4)}`,
                        type: data.type || 'deadline', // SEKARANG DINAMIS MENGIKUTI ZIP DATA AI BRAY
                        scope: finalScope,
                        targetTimestamp: data.type === 'recurring' ? null : targetTimestamp,
                        cronPattern: data.cronPattern || null, // KUNCI POLA CRON MINGGUAN KULIAH LU YAN
                        judul: data.judul || 'agenda kasual',
                        message: data.pesanDurasi || `waktunya {judul} bentar lagi nih!`,
                        manualFallback: data.judul || 'agenda kasual',
                        nowMessage: data.pesanNow || `sekarang waktunya ${data.judul || 'agenda kasual'} coy!`,
                        nowManualFallback: data.judul || 'agenda kasual',
                        milestones: data.type === 'recurring' ? null : finalMilestones,
                        customMilestones: data.customMilestones || null,
                        firedMilestones: [],
                        pendingAITexts: {},
                        targets: finalScope === 'group' ? ['group'] : targetJidsFinal, 
                        mediaPath: null,
                        mediaType: null,
                        teamTracking: {},
                        creator: data.creator || 'dyan',       
                        creatorJid: data.creatorJid || '',
                        withTracking: data.withTracking !== false,
                        withReport: data.withReport !== false
                    });

                    config.reports = config.reports || [];
                    saveConfig(config);
                    resetState(fromJid);
                    setupSchedules(sock);
                    
                    await sock.sendMessage(fromJid, { text: `jadwal udah gue simpen permanen ya ${currentNick}` });
                    return;
                }

                // ====================================================================
                // LAPIS 3: JALUR CERDAS INTERPRETASI KETIKAN KASUAL MANUSIA (AI BASIS SEMESTA)
                // ====================================================================
                const komponenSekarang = getJakartaDateComponents(new Date());
                const stringHariIni = `${komponenSekarang.year}-${komponenSekarang.month.padStart(2, '0')}-${komponenSekarang.day.padStart(2, '0')}`;
                const jamSekarangIni = `${komponenSekarang.hour.padStart(2, '0')}:${komponenSekarang.minute.padStart(2, '0')}`;

                const promptDinamisAI = `Kamu adalah mesin pembaca niat koreksi manifes agenda kuliah.
ACUAN TANGGAL HARI INI SECARA RIIL: ${stringHariIni} bray!
ACUAN JAM SEKARANG SECARA RIIL: ${jamSekarangIni} WIB bray! Gunakan acuan ini untuk menghitung secara akurat jika user menggunakan kata keterangan waktu relatif seperti "5 menit kedepan", "setengah jam lagi", "1 jam kemudian".
Data draf saat ini: ${JSON.stringify(state.data)}
User membalas dengan ketikan bebas: "${text}"

Tugas kamu adalah memetakan niat perkataan user dan mengembalikannya dalam bentuk JSON objek murni untuk menentukan tipe keputusan:
1. "batal": Jika user menggunakan kalimat pembatalan kasual/kaku.
2. "edit": Jika user ingin memperbaiki parameter draf (mengubah judul, jam, target, skema alarm kustom, template pesan durasi, maupun template pesan sekarang).

Aturan pengubahan parameter objek jika keputusan bernilai "edit":
- Jika user menyebutkan kata "hari ini" atau mengubah hari operasi ke hari ini, kamu WAJIB mengubah properti "tanggal" menjadi string "${stringHariIni}" secara akurat bray!
- Jika user mengubah waktu menggunakan pernyataan jam relatif (misal: "jamnya itu 5 menit kedepan", "setengah jam lagi", "10 menit dari sekarang"), hitung secara matematika dari acuan JAM SEKARANG (${jamSekarangIni}) lalu masukkan hasilnya dengan format HH:MM digital ke properti "waktu" bray!
- Jika user meminta alarm berbasis interval rutin atau permenit (misal: "skema alarm dibikin interval permenit", "interval 1 menit"), isi properti "intervalMinutes" dengan angka menit tersebut, dan set properti "customMilestones" menjadi null bray.
- Jika user meminta alarm di menit-menit tertentu, ambil seluruh angka menit tersebut, susun menjadi array angka terurut dari terbesar ke terkecil di properti "customMilestones", dan buat nilai "intervalMinutes" menjadi null.
- Jika user tidak mengubah atau tidak membahas skema alarm di chat barunya, JANGAN masukkan properti customMilestones dan intervalMinutes ke dalam objek parameter_berubah (biarkan kosong atau undefined) agar data lama tidak terhapus bray!
- Jika user meminta menyamakan template durasi dengan template eksekusi, salin isi string template eksekusi draf saat ini (yaitu teks mutlak: "${state.data.pesanNow || 'sekarang waktunya {judul} bray!'}") ke parameter "pesanDurasi".
- Jika user meminta menyamakan template eksekusi dengan template durasi, salin isi string template durasi draf saat ini (yaitu teks mutlak: "${state.data.pesanDurasi || 'waktunya {judul} bentar lagi nih!'}") ke parameter "pesanNow".
- Jika user mengubah judul, isi properti "judul" dengan nama agenda baru.
- Jika user mengubah jam/waktu menggunakan jam dinding kaku (misal: "ubah jadi jam 13:00"), isi properti "waktu" dengan format HH:MM digital tersebut bray.
- Jika user mengubah template pesan durasi, masukkan teks kalimat barunya ke properti "pesanDurasi".
- Jika user mengubah template pesan sekarang (H-0), masukkan teks kalimat barunya ke property "pesanNow".
- Jika user meminta target penerima diubah ke dirinya sendiri, isi properti "extractedTarget" dengan string murni "sender". 
- KHUSUS KOREKSI DATABASE KONTAK: Jika user memerintahkan pembaruan database nomor hp, tangkap data tersebut dan masukkan ke dalam properti objek "update_database_kontak" dengan sub-properti "nama" dan "nomor".
- Jika user meminta mengubah template durasi DAN eksekusi secara bersamaan dalam satu kalimat, kamu WAJIB mengisi KEDUA properti "pesanDurasi" dan "pesanNow" dengan nilai string teks yang sama tersebut bray!
- Jika user memasukkan kata "AI:" di dalam teks template barunya, isi teks "AI:" tersebut adalah string literal mutlak yang wajib lu pertahaman utuh di dalam properti pesanDurasi atau pesanNow, jangan pernah dipotong!
- Jika user meminta memindahkan, menukar, atau menggeser posisi marka, kamu WAJIB menyusun ulang seluruh string template tersebut dari awal dengan meletakkan kata "AI: " di posisi paling awal string bray!
- Jika user mengubah skema alarm menjadi interval rutin atau permenit, kamu WAJIB memaksa nilai properti "startTime" di objek draf ini menjadi null bray, agar hitungan matematika selisih jamnya tidak rusak kembali ke 0.
- Jika user mengubah pola pengulangan rutin, kamu WAJIB memperbarui properti "type" menjadi "recurring" dan buatkan susunan format linux cron 5 digit terbaru di properti "cronPattern" secara akurat bray!
- Jika user merevisi waktu alarm di hari terakhir menggunakan jam dinding kaku, kamu WAJIB menghitung selisih menit mundur dari jam alarm tersebut menuju jam target utama agenda saat ini, lalu masukkan hasilnya berupa array angka menit mundur ke dalam properti "customMilestones" bray!
- Jika user membahas atau merubah skema pengingat harian, set properti "withDailyReminder" menjadi true atau false secara akurat bray!
- Jika user mengubah tanggal awal harian atau jam harian, perbarui parameter "dailyReminderStartDate" dengan format YYYY-MM-DD dan "dailyReminderTime" dengan format HH:MM secara akurat bray!

Format keluaran WAJIB objek JSON mentah murni tanpa tanda backtick markdown, tanpa tulisan json, dan tanpa teks penjelas apa pun:
{
  "keputusan": "edit" | "batal" | "chat",
  "parameter_berubah": {
    "judul": string atau null,
    "waktu": string atau null,
    "tanggal": string atau null,
    "customMilestones": array atau null,
    "intervalMinutes": number or null,
    "pesanDurasi": string atau null,
    "pesanNow": string atau null,
    "withReport": boolean atau null,
    "withTracking": boolean atau null,
    "extractedTarget": string atau null
  },
  "update_database_kontak": {
    "nama": string or null,
    "nomor": string or null
  },
  "balasan_chatan": string atau null
}`;

                try {
                    const { generateAIText } = require('./geminiClient');
                    const aiRes = await generateAIText(promptDinamisAI, {}, '', '{}', false);
                    
                    // MENGGUNAKAN TAMENG EKSTRAKSI AMAN BARU AGAR TIDAK CRASH SAAT ADA TEKS PENGANTAR AI BRAY
                    const updateResult = safeExtractAndParseJSON(aiRes.text);

                    if (updateResult.keputusan === 'batal') {
                        resetState(fromJid);
                        const teksBatal = updateResult.balasan_chatan || `oke siap bray, draf agenda resmi gue apus dari memori ya wkwk`;
                        await sock.sendMessage(fromJid, { text: teksBatal.toLowerCase() }, { quoted: msg });
                        return;
                    }

                    if (updateResult.keputusan === 'edit') {
                        if (updateResult.update_database_kontak) {
                            const dbKontak = updateResult.update_database_kontak;
                            if (dbKontak.nama && dbKontak.nomor) {
                                const cleanNumOnly = dbKontak.nomor.replace(/[^0-9]/g, '');
                                const isSelfChanging = senderJid.startsWith(cleanNumOnly);
                                const isOwnerSirkel = fromJid === config.ownerJid || fromJid.includes('169810692436109');
                                
                                if (isOwnerSirkel || isSelfChanging) {
                                    const formattedJidTarget = `${cleanNumOnly}@s.whatsapp.net`;
                                    config.accountMapping[formattedJidTarget] = dbKontak.nama.toLowerCase();
                                    saveConfig(config);
                                    console.log(`[database] sukses update kontak: ${dbKontak.nama} -> ${cleanNumOnly}`);
                                } else {
                                    await sock.sendMessage(fromJid, { text: `gagal update nomor orang lain bray, hak akses database kontak dikunci khusus owner sirkel kuliah.` }, { quoted: msg });
                                }
                            }
                        }

                        const params = updateResult.parameter_berubah || {};
                        
                        if (params.customMilestones === null && params.intervalMinutes === null) {
                            delete params.customMilestones;
                            delete params.intervalMinutes;
                        }

                        // CLONE BACKUP MEMORI RAM SEBELUM DIMUTASI (Untuk Rollback jika meledak)
                        const backupJudul = state.data.judul;
                        const backupWaktu = state.data.waktu;
                        const backupTanggal = state.data.tanggal;
                        const backupCustomMilestones = state.data.customMilestones ? [...state.data.customMilestones] : null;
                        const backupIntervalMinutes = state.data.intervalMinutes;
                        const backupPesanDurasi = state.data.pesanDurasi;
                        const backupPesanNow = state.data.pesanNow;

                        Object.keys(params).forEach(key => {
                            if (params[key] !== undefined && params[key] !== null) {
                                state.data[key] = params[key];
                            } else if (params[key] === null && (key === 'intervalMinutes' || key === 'customMilestones')) {
                                state.data[key] = null; 
                            }
                        });

                        // ====================================================================
                        // SISTEM PEMBERSIH OTOMATIS: PENJAGA KONSISTENSI DATA PASCA-EDIT BRAY
                        // ====================================================================
                        // Saringan A: Jika tanggal diubah jadi hari ini, sapu bersih seluruh paket harian menuju hari H
                        if (state.data.tanggal === stringHariIni) {
                            state.data.withDailyReminder = false;
                            state.data.dailyReminderStartDate = null;
                            state.data.dailyReminderTime = null;
                        }

                        // Saringan B: Jika user minta interval per menit atau jam, bersihkan milestones kustom hari H
                        if (params.intervalMinutes && params.intervalMinutes > 0) {
                            state.data.customMilestones = null;
                        }

                        // Saringan C: Jika user secara eksplisit membersihkan draf harian via teks
                        if (params.customMilestones === null && !params.intervalMinutes) {
                            if (state.data.withDailyReminder && state.data.dailyReminderStartDate) {
                                const kataKunciHapus = ["rentang", "harian ga ada", "matikan harian", "permenit"];
                                if (kataKunciHapus.some(kata => text.toLowerCase().includes(kata))) {
                                    state.data.withDailyReminder = false;
                                    state.data.dailyReminderStartDate = null;
                                    state.data.dailyReminderTime = null;
                                }
                            }
                        }

                        // Saringan D: Cegah paradoks tanggal batas awal melompati tanggal target utama
                        if (state.data.dailyReminderStartDate && state.data.tanggal) {
                            if (new Date(state.data.dailyReminderStartDate) > new Date(state.data.tanggal)) {
                                state.data.dailyReminderStartDate = null;
                                state.data.withDailyReminder = false;
                            }
                        }

                        // BENTENG PENGAMAN ANTI-BYPASS: Uji kelayakan jumlah deret milestones baru bray
                        const intervalCheck = state.data.intervalMinutes; 
                        const testCalculated = calculateMilestonesArray(state.data.waktu, state.data.startTime, intervalCheck, state.data.customMilestones, state.data.tanggal, state.data.withDailyReminder, state.data.dailyReminderStartDate, state.data.dailyReminderTime);

                        if (testCalculated.length > 30) {
                            // ROLLBACK DATA RAM INSTAN KARENA JEBOL
                            state.data.judul = backupJudul;
                            state.data.waktu = backupWaktu;
                            state.data.tanggal = backupTanggal;
                            state.data.customMilestones = backupCustomMilestones;
                            state.data.intervalMinutes = backupIntervalMinutes;
                            state.data.pesanDurasi = backupPesanDurasi;
                            state.data.pesanNow = backupPesanNow;

                            await sock.sendMessage(fromJid, { text: `⚠️ *[BACKEND BLOCK NOTICE]*\nperubahan skema alarm otomatis gue tolak bray karena menghasilkan *${testCalculated.length} kali* pengingat beruntun. server bisa gempor wkwk. draf gue kembalikan ke posisi aman semula ya yan.` }, { quoted: msg });
                            return;
                        }
                        
                        const debugInfoData = {
                            inputText: text,
                            keputusan: updateResult.keputusan,
                            rawPayload: JSON.stringify(updateResult, null, 2)
                        };

                        await sendDetailedConfirmation(sock, fromJid, state.data, msg, debugInfoData);
                        return;
                    }

                    if (updateResult.keputusan === 'chat') {
                        const teksChat = updateResult.balasan_chatan || `mau lanjut chatan aja atau draf agenda "${state.data.judul}" nya mau disimpen nih bray?`;
                        await sock.sendMessage(fromJid, { text: teksChat.toLowerCase() }, { quoted: msg });
                        return;
                    }

                } catch (err) {
                    console.error('gagal parsing keputusan draf AI universal:', err.message);
                    await sock.sendMessage(fromJid, { text: `maksud lu gimana yan, draf agenda "${state.data.judul}" mau lu simpen (ketik iya), lu edit parameter, atau mau dibatalin nih?` }, { quoted: msg });
                }
            }
            return;
        }

        // 5. INTERLOCK PEMBATALAN OVER-LIMIT DEBAT INTERAKTIF MILESTONES
        if (userStates[fromJid] && userStates[fromJid].mode === 'interval_correction') {
            if (isGroup && !isBotMentioned) {
                // Biarkan lolos ke logger grup bawah bray
            } else {
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
                        const reply = await generateDynamicStateText(`masih kebanyakan bray ${testMilestones.length} kali gempor gue gila coba gedein lagi menit atau jamnya`, currentNick, samples, chatMemory[fromJid] || []);
                        pushToMemory(fromJid, 'bot', reply);
                        await sock.sendMessage(fromJid, { text: reply });
                    }
                } else if (['gajadi', 'batal', 'cancel'].some(w => lowText.includes(w))) {
                    resetState(fromJid);
                    const reply = await generateDynamicStateText('oke sip gue reset', currentNick, samples, chatMemory[fromJid] || []);
                    pushToMemory(fromJid, 'bot', reply);
                    await sock.sendMessage(fromJid, { text: reply });
                } else {
                    const reply = await generateDynamicStateText('coba benerin lagi maksud lu gimana mau diganti tiap berapa menit atau berapa jam', currentNick, samples, chatMemory[fromJid] || []);
                    pushToMemory(fromJid, 'bot', reply);
                    await sock.sendMessage(fromJid, { text: reply });
                }
                return;
            }
        }

        // 6. JALUR UMUM UTAMA DETEKSI RADAR NIAT (HASIL DEBUG VALID LID)
        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        
        isBotMentioned = isBotMentioned || mentionedJids.some(j => j.includes(botJidNumber) || (botLidNumber && j.includes(botLidNumber))) || 
                         lowText.includes('@bot') || 
                         (botJidNumber && lowText.includes(botJidNumber)) || 
                         (botLidNumber && lowText.includes(botLidNumber)) ||
                         (botNameClean && lowText.includes(botNameClean));

        if (!isGroup || isBotMentioned) {
            if (!isGroup && !isAuthorized(config, fromJid)) {
                await sock.sendMessage(fromJid, { text: 'akses terbatas daftar pake /daftar dulu cuy' });
                return;
            }

            // SIMULASI PERILAKU MANUSIA: Tandai pesan sudah dibaca dan beri jeda berpikir
            await sock.readMessages([msg.key]);
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
            
            // Nyalain status mengetik di wa sebelum AI mulai membalas
            await sock.sendPresenceUpdate('composing', fromJid);
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

            let processingText = text;
            if (isGroup) {
                processingText = text.replace(new RegExp(`@${botJidNumber}`, 'gi'), '')
                                     .replace(new RegExp(`@${botNameClean}`, 'gi'), '')
                                     .replace(/@bot/gi, '')
                                     .trim();
            }

            const kpsn = getJakartaDateComponents(new Date());
            const konteksWaktuMurni = `${kpsn.year}-${kpsn.month.padStart(2, '0')}-${kpsn.day.padStart(2, '0')} Jam ${kpsn.hour.padStart(2, '0')}:${kpsn.minute.padStart(2, '0')} WIB`;
            const intentData = await parseIntentFromText(processingText, konteksWaktuMurni);

            if (intentData.intent === 'create_schedule') {
                intentData.creator = currentNick;
                intentData.creatorJid = senderJid.split('@')[0];
                // PENGUNCI ELEKTRONIK JID ASAL GRUP KAMAR SECARA MANDIRI BRAY
                intentData.groupJidTarget = isGroup ? fromJid : null;

                // OTOMATISASI SAKLAR BERDASARKAN TARGET UTAMA YAN
                if (intentData.extractedTarget) {
                    intentData.withTracking = false;
                    intentData.withReport = false;
                } else {
                    intentData.withTracking = true;
                    intentData.withReport = true;
                }

                // GERBANG INTERAKTIF: CEK APAKAH WAKTU HARI INI SUDAH LEWAT YAN BRAY!
                if (intentData.waktu && intentData.waktu.includes(':')) {
                    const now = new Date();
                    const tParts = getJakartaDateComponents(now);
                    const [tHour, tMin] = intentData.waktu.split(':').map(Number);
                    const checkTodayTarget = new Date(`${tParts.year}-${tParts.month.padStart(2, '0')}-${tParts.day.padStart(2, '0')}T${String(tHour).padStart(2, '0')}:${String(tMin).padStart(2, '0')}:00+07:00`);
                    
                    if (checkTodayTarget.getTime() <= now.getTime()) {
                        // Kunci statusnya ke mode interogasi past_time_check bray
                        setState(fromJid, 'past_time_check', intentData);
                        
                        const pastTimePrompt = `Lu adalah asisten kelompok kuliah yang santai. Seseorang bernama ${currentNick} baru saja membuat draf agenda "${intentData.judul}" buat jam ${intentData.waktu}, tapi jam segitu buat hari ini udah lewat bray.
                        Tugas lu: Tanyakan dengan bahasa tongkrongan santai lu-gue, huruf kecil semua (lowercase), tanpa tanda kutip, tanpa markdown list kaku, intinya menyampaikan kalimat: "waktu agenda yg lo targetkan buat udah lewat, mau dirubah besok atau mau gue hapus karna lo salah ketik?". Jawab langsung kalimat chatnya aja tanpa penjelasan robot bray.`;
                        
                        const { generateAIText } = require('./geminiClient');
                        const aiRes = await generateAIText(pastTimePrompt, {}, '', 'waktu agenda yg lo targetkan buat udah lewat, mau dirubah besok atau mau gue hapus karna lo salah ketik?', false);
                        
                        await sock.sendMessage(fromJid, { text: aiRes.text.trim() }, { quoted: msg });
                        return;
                    }
                }

                const calculated = calculateMilestonesArray(intentData.waktu, intentData.startTime, intentData.intervalMinutes, intentData.customMilestones, intentData.tanggal, intentData.withDailyReminder, intentData.dailyReminderStartDate, intentData.dailyReminderTime);

                if (calculated.length > 30) {
                    setState(fromJid, 'interval_correction', { originalData: intentData, count: calculated.length });
                    const reply = await generateDynamicStateText(`ini yakin gue ngingetin ${calculated.length} kali gempor gue gila bray server bisa meledak coba benerin lagi maksud lu gimana mau diganti tiap berapa menit`, currentNick, samples, chatMemory[fromJid] || []);
                    pushToMemory(fromJid, 'bot', reply);
                    await sock.sendMessage(fromJid, { text: reply });
                    return;
                }

                setState(fromJid, 'confirm_schedule', intentData);
                await sendDetailedConfirmation(sock, fromJid, intentData, msg);
            
            } else if (intentData.intent === 'summarize') {
                const logs = readGroupLogs(fromJid, intentData.jumlahChat || 200); // Menggunakan database hibrida terpisah bray
                if (logs.length === 0) {
                    await sock.sendMessage(fromJid, { text: 'belum ada obrolan yang kerekam nih coy' });
                } else {
                    await sock.sendMessage(fromJid, { text: 'bentar gue rangkumin dulu ya' });
                    const transkripObrolan = logs.map(c => `[${c.sender}]: ${c.text}`).join('\n');
                    const summary = await summarizeChatLog(transkripObrolan);
                    await sock.sendMessage(fromJid, { text: summary });
                }
                
            } else if (intentData.intent === 'read_schedule_detail') {
                resetState(fromJid);
                await handleListDetail(sock, fromJid);

            } else if (intentData.intent === 'read_schedule') {
                resetState(fromJid);
                await handleCommand(sock, '/list', fromJid, () => setupSchedules(sock));
                
            } else {
                // SENSOR PENYUNTING NAMA PANGGILAN KASUAL OVERRIDE
                // ====================================================================
                // KONDISI PENGENALAN IDENTITAS MANDIRI (KASUAL & KAKU SLASH)
                // ====================================================================
                if (lowText.startsWith('panggil gue ') || lowText.startsWith('panggil gua ') || cmd === '/panggilgue') {
                    let namaBaru = '';
                    if (cmd === '/panggilgue') {
                        namaBaru = text.slice(11).trim();
                    } else {
                        namaBaru = text.replace(/panggil gue|panggil gua/gi, '').trim();
                    }
                    
                    if (namaBaru.length > 0) {
                        config.accountMapping[senderJid] = namaBaru;
                        saveConfig(config);
                        
                        const replyNama = await generateDynamicStateText(`siap sekarang nama lu udah gue ganti jadi ${namaBaru} yan`, currentNick, samples, chatMemory[fromJid] || []);
                        pushToMemory(fromJid, 'bot', replyNama);
                        await sock.sendMessage(fromJid, { text: replyNama }, { quoted: msg });
                        return;
                    }
                }

                // ====================================================================
                // KONDISI PENGENALAN SEPIHAK OLEH OWNER BERBASIS SUB-KAMAR BERSARANG YAN
                // ====================================================================
                if ((fromJid === config.ownerJid || senderJid === config.ownerJid) && (lowText.startsWith('daftarin ') || cmd === '/daftarin')) {
                    let nomorTarget = '';
                    let namaTarget = '';

                    if (cmd === '/daftarin') {
                        const args = text.slice(9).trim().split(/\s+/);
                        if (args.length >= 2) {
                            nomorTarget = args[0].trim().replace(/[^0-9]/g, '');
                            namaTarget = args.slice(1).join(' ').trim();
                        }
                    } else {
                        const cleanText = text.replace(/daftarin /gi, '').trim();
                        const parts = cleanText.split(/ sebagai /i);
                        if (parts.length === 2) {
                            nomorTarget = parts[0].trim().replace(/[^0-9]/g, '');
                            namaTarget = parts[1].trim();
                        }
                    }
                    
                    if (nomorTarget && namaTarget) {
                        if (!nomorTarget.endsWith('@s.whatsapp.net')) {
                            nomorTarget = `${nomorTarget}@s.whatsapp.net`;
                        }
                        
                        if (!config.groupMappings) config.groupMappings = {};
                        
                        if (isGroup) {
                            // Masukkan ke sub-kamar khusus grup aktif tempat lu ngetik bray!
                            if (!config.groupMappings[fromJid]) config.groupMappings[fromJid] = {};
                            config.groupMappings[fromJid][nomorTarget] = namaTarget;
                            saveConfig(config);
                            await sock.sendMessage(fromJid, { text: `beres yan, nomor ${nomorTarget.split('@')[0]} resmi dicatat khusus sebagai *${namaTarget}* di kamar grup ini!` }, { quoted: msg });
                        } else {
                            // Jalur cadangan global jika owner daftarin lewat room pribadi bray
                            config.accountMapping[nomorTarget] = namaTarget;
                            saveConfig(config);
                            await sock.sendMessage(fromJid, { text: `beres yan, nomor ${nomorTarget.split('@')[0]} resmi dicatat sebagai *${namaTarget}* di database global bray` }, { quoted: msg });
                        }
                        return;
                    }
                }

                if (['udahan', 'sip', 'oke dah', 'oke deh', 'makasih', 'thanks', 'yaudah', 'bray', 'oke', 'okee', 'okss', 'sipp', 'sippp'].some(w => lowText === w || lowText.includes(w))) {
                    if (userStates[fromJid] && userStates[fromJid].mode === 'chat') {
                        resetState(fromJid);
                        await sock.sendMessage(fromJid, { text: `oke siap obrolan gue tutup ya bray ${currentNick}` }, { quoted: msg });
                        return;
                    }
                }

                setState(fromJid, 'chat');
                
                let pesanBalasanFinal = '';
                
                if (isGroup) {
                    if (groupChatMemory[fromJid].length < 5) {
                        const restartPrompt = `Lu adalah asisten kelompok kuliah yang santai. Server lu baru aja restart sehingga memori obrolan lokal lu kosong bersih. Berikan respon maaf kasual dengan gaya lu-gue, santai, huruf kecil semua bray, menyampaikan kalimat "gue gatau bray servernya baru aja restart wkwk jadi ga nyimak percakapan lo pada sorry yaaa".`;
                        
                        const { generateAIText } = require('./geminiClient');
                        const aiRestartRes = await generateAIText(restartPrompt, {}, '', 'gue gatau bray servernya baru aja restart wkwk jadi ga nyimak percakapan lo pada sorry yaaa', false);
                        
                        await sock.sendMessage(fromJid, { text: aiRestartRes.text.trim() }, { quoted: msg });
                        return;
                    }

                    const transkripObrolan = groupChatMemory[fromJid].map(c => `[${c.sender}]: ${c.text}`).join('\n');
                    
                    const opiniPrompt = `Lu adalah anggota kelompok kuliah yang cerdas, solutif, dan menyimak dinamika obrolan grup dari pojokan room chat. Hari ini lu ditanya pendapat atau dimintai solusi oleh si ${currentNick} dengan pertanyaan: "${processingText}". Transkrip obrolan anak-anak sebelumnya: \n${transkripObrolan}`;
                    
                    const { generateAIText } = require('./geminiClient');
                    const aiOpiniRes = await generateAIText(opiniPrompt, {}, '', 'sori bray otak gue lagi agak nge-lag, coba jelasin intinya aja', false);
                    pesanBalasanFinal = aiOpiniRes.text;
                } else {
                    pesanBalasanFinal = await generateMimicReply(processingText, samples, chatMemory[fromJid] || [], currentNick);
                }

                pushToMemory(fromJid, 'bot', pesanBalasanFinal);
                await sock.sendMessage(fromJid, { text: pesanBalasanFinal }, { quoted: msg });
                
            }
        }
        
        if (text && (!isGroup || isBotMentioned)) {
            recordSample(isGroup ? (msg.key.participant || fromJid) : fromJid, text);
        }
    });

    // GERBANG PENGENDUS STATUS TANDA TERIMA PESAN (ANTI CENTANG SATU)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            const msgId = update.key.id;
            const status = update.update.status;
            
            // Angka 3 artinya pesan sukses tersampaikan ke hp target alias centang dua bray
            if (status === 3 || status === 4) {
                let config = loadConfig();
                let changed = false;
                
                config.reminders.forEach(r => {
                    if (r.teamTracking) {
                        Object.keys(r.teamTracking).forEach(jid => {
                            if (r.teamTracking[jid].lastMsgId === msgId) {
                                r.teamTracking[jid].isDelivered = true;
                                changed = true;
                            }
                        });
                    }
                });
                
                if (changed) saveConfig(config);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();