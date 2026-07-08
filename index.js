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

function getNick(jid, pushName, config, style = 'stable') {
    // Manifes lengkap variasi panggilan tongkrongan kelompok lu yan
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
    
    let mappedName = config.accountMapping?.[jid];
    if (!mappedName && jid === config.ownerJid) mappedName = 'dyan';
    if (!mappedName) mappedName = pushName || 'coy';
    
    let firstName = mappedName.trim().split(/\s+/)[0].toLowerCase();
    
    // Jika nama orangnya terdaftar di sirkel kelompok utama bray
    if (nameMap[firstName]) {
        const data = nameMap[firstName];
        if (style === 'short') return data.short;
        if (style === 'variant') {
            const arr = data.variants;
            return arr[Math.floor(Math.random() * arr.length)]; // Mengocok variasi acak
        }
        return data.stable;
    }
    
    // JALUR CADANGAN AUTOPOTONG: Untuk nomor asing di luar list utama lu bray
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

function calculateMilestonesArray(waktuTarget, waktuMulaiStr, intervalMin, customMilestones = null) {
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
    
    let milestones = [];

    // JALUR 1: KONDISI SEKALI TEMBAK (Jika dikirim array menit spesifik, misal [5, 1])
    if (customMilestones && Array.isArray(customMilestones)) {
        customMilestones.forEach(min => {
            if (min <= diffMin) {
                milestones.push({
                    type: 'durasi',
                    totalMinutes: min,
                    label: min === 0 ? 'sekarang' : `${min} menit lagi`,
                    isAuto: min === 0
                });
            }
        });
        // Pastikan alarm pas waktu eksekusi (0 menit) selalu ikut mengunci sebagai penutup
        if (!milestones.some(m => m.totalMinutes === 0)) {
            milestones.push({ type: 'durasi', totalMinutes: 0, label: 'sekarang', isAuto: true });
        }
    } else {
        // JALUR 2: KONDISI PERULANGAN BERUNTUN (Logika lama bawaan countdown)
        let step = (intervalMin && intervalMin > 0) ? intervalMin : 0;

        if (diffMin <= 0 || step === 0) {
            return [{ type: 'durasi', totalMinutes: 0, label: 'sekarang', isAuto: true }];
        }

        for (let minRemaining = 0; minRemaining <= diffMin; minRemaining += step) {
            milestones.push({
                type: 'durasi',
                totalMinutes: minRemaining,
                label: minRemaining === 0 ? 'sekarang' : `${minRemaining} menit lagi`,
                isAuto: minRemaining === 0
            });
        }
    }

    return milestones.sort((a, b) => b.totalMinutes - a.totalMinutes);
}

async function sendDetailedConfirmation(sock, jid, data, quotedMsg = null) {
    let targetText = data.extractedTarget ? `nomor pribadi ${data.extractedTarget}` : 'kelompok di grup ini';
    
    const intervalVal = data.intervalMinutes || 1;
    // Oper data customMilestones ke dalam mesin kalkulator bawaan berkas lo yan bray
    const milestones = calculateMilestonesArray(data.waktu, data.startTime, intervalVal, data.customMilestones);

    let skemaText = data.customMilestones 
        ? `kustom pada menit ke [${data.customMilestones.join(', ')}] terakhir sebelum mulai` 
        : `${milestones.length} kali pengingat beruntun (interval tiap ${intervalVal} menit dari waktu mulai)`;

    let confirmationText = `📋 *[konfirmasi agenda]*\n` +
        `• *judul aktivitas*: ${data.judul || 'agenda kasual'}\n` +
        `• *pembuat agenda*: ${data.creator || 'tidak dikenal'} (${data.creatorJid || 'tidak ada nomor'})\n` +
        `• *waktu sasaran*: jam ${data.waktu || 'belum diset'} wib\n` +
        `• *target penerima*: ${targetText}\n` + 
        `• *status pelacakan*: ${data.withTracking !== false ? 'aktif' : 'nonaktif atau silent'}\n` +
        `• *status laporan*: ${data.withReport !== false ? 'aktif' : 'nonaktif'}\n` +
        `• *skema alarm*: ${skemaText}\n` + 
        `• *template durasi*: "${data.pesanDurasi || `waktunya {judul} bentar lagi nih!`}"\n` +
        `• *template eksekusi*: "${data.pesanNow || `sekarang waktunya {judul} bray!`}"\n\n` +
        `📝 *sistem pengubah parameter diterima*:\n` +
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
    await sock.sendMessage(fromJid, { text: msg.trim() });
}

async function resolveTemplateForJid(messageTemplate, manualFallback, jid, context = {}, formal = false) {
    const { loadConfig } = require('./configManager');
    const config = loadConfig();
    
    let bodyText = messageTemplate || '';
    
    // 1. PROSES ISI UTAMA AGENDA (Biar tetep rapi mendukung kapital normal)
    if (context.sisa) bodyText = bodyText.replace(/{sisa}/g, context.sisa);
    if (context.judul) bodyText = bodyText.replace(/{judul}/g, context.judul);
    
    if ((messageTemplate || '').startsWith('AI:')) {
        const { generateAIText } = require('./geminiClient');
        const { buildStyleInstruction } = require('./styleProfiler');
        let tema = messageTemplate.replace('AI:', '').trim();
        
        // SUNTIKKAN ATURAN FORMAT KAPITALISASI KHUSUS SESUAI KEINGINAN LU YAN
        tema += `\n\nAturan format tulisan: wajib gunakan huruf kecil semua (lowercase) untuk seluruh kalimat dan kata panggilan, KECUALI untuk singkatan teknis, istilah/definisi khusus yang jarang disebutkan, atau produk unpopular yang aslinya memang berupa kapital penuh (contoh: FIFO, LIFO). Jangan gunakan huruf kapital untuk nama orang atau di awal kalimat biasa bray.`;
        
        const styleInstruction = buildStyleInstruction(jid);
        const aiRes = await generateAIText(tema, context, styleInstruction, manualFallback, formal);
        bodyText = aiRes.text;
    }

    // 2. RACIK KALIMAT PENGANTAR DINAMIS LEWAT GEMINI (Huruf kecil semua & koma ritmis)
    const targetNick = getNick(jid, '', config, 'stable');
    const agendaJudul = context.judul || 'agenda kelompok';
    
    const introPrompt = `Buat satu kalimat pendek kasual untuk mengantar pesan pengingat agenda "${agendaJudul}" buat si ${targetNick}. 
    Aturan wajib:
    1. Gunakan huruf kecil semua (lowercase).
    2. Masukkan nama panggilan ${targetNick} di dalam kalimatnya.
    3. Gunakan tanda baca koma hanya untuk jeda ritme bicara yang natural saat diucapkan (rhythmic parsing), jangan ditaruh kaku di ujung nama jika ritmenya tidak pas.
    4. Buat bervariasi dan dinamis (contoh: "ini jadwalnya ya ${targetNick}, coba dicek dulu" atau "nih ${targetNick}, jangan lupa sama agendanya").
    5. Hasil output hanya teks kalimat pengantarnya saja tanpa penjelas tambahan, tanpa tanda kutip.`;

    try {
        const { generateAIText } = require('./geminiClient');
        const aiIntro = await generateAIText(introPrompt, {}, '', 'ini pengingatnya bray', false);
        const cleanIntro = aiIntro.text.trim().toLowerCase();
        
        // Gabungkan pengantar kasual (huruf kecil) dan isi agenda (kapital rapi) bray
        const pesanFinal = `${cleanIntro}\n\n${bodyText}`;
        return { text: pesanFinal, usedFallback: false };
    } catch (err) {
        console.error('gagal ngeracik intro dinamis:', err.message);
        // Fallback aman jika server AI bermasalah
        return { text: `nih pengingatnya ya ${targetNick},\n\n${bodyText}`, usedFallback: true };
    }
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
        // Otomatis setup data tracking baru jika memori kelompok masih kosong bersih bray
        if (!reminder.teamTracking || Object.keys(reminder.teamTracking).length === 0) {
            reminder.teamTracking = await initializeTeamTracking(sock, config.groupJid, config);
            saveConfig(config);
        }

        // Ambil data metadata dari gembok cache lokal biar ga nembak API server terus
        if (!groupCache[config.groupJid]) {
            groupCache[config.groupJid] = await sock.groupMetadata(config.groupJid);
            setTimeout(() => { delete groupCache[config.groupJid]; }, 10 * 60 * 1000);
        }
        
        const groupMeta = groupCache[config.groupJid];
        const members = groupMeta.participants || [];
        
        for (const member of members) {
            const memberJid = member.id;
            if (memberJid.includes(botJidNumber) || memberJid === config.ownerJid) continue;

            // KATUP PENYARING JID KHUSUS SCOPE TERTARGET YAN BRAY!
            if (reminder.scope === 'tertarget' && !reminder.targets.includes(memberJid)) continue;

            const userTrack = reminder.teamTracking[memberJid] || { status: 'Belum Respon' };

            // STRATEGI 1: JIKA ANGGOTA SUDAH PASTI ABSEN (SELESAI INTEROGASI), LANGSUNG LEWATI
            if (userTrack.status === 'Absen') continue;

            const context = { sisa: milestone.label, judul: reminder.judul, isNow: !!milestone.isAuto };
            const messageTemplate = milestone.isAuto ? reminder.nowMessage : reminder.message;
            const manualFallback = milestone.isAuto ? reminder.nowManualFallback : reminder.manualFallback;

            let { text } = await resolveTemplateForJid(messageTemplate, manualFallback, memberJid, context, reminder.formal);
            
            // STRATEGI 2: PENYUSUNAN CATATAN KAKI DINAMIS BERDASARKAN STATUS
            let catatanKaki = '';
            if (userTrack.status === 'Belum Respon') {
                catatanKaki = `\n\n*catatan:* balas pesan pribadi ini buat ngasih konfirmasi keaktifan lu di grup ya bray.`;
            } else if (userTrack.status === 'Abu-Abu') {
                catatanKaki = `\n\n*catatan:* kemaren kan lu bilang gatau, gimana jadinya bray? sekarang udah bisa dipastikan belum? bales ya!`;
            } else if (userTrack.status === 'Hadir') {
                // Tetap diingatkan tapi tanpa todongan catatan kaku (diganti teks apresiasi standby)
                catatanKaki = `\n\n_lu kan udah konfirmasi hadir tadi, jadi tinggal stand by aja ya pas mulai, mantap bray!_`;
            }

            const pesanFinal = `${text}${catatanKaki}`;

            // STRATEGI 3: GELEMBUNG 1 - PANGGIL NAMA KASUAL (SIMULASI ALAMI)
            const namaPanggilan = getNick(memberJid, member.pushName || 'bray', config, 'variant');
            await sock.sendMessage(memberJid, { text: namaPanggilan.toLowerCase() });

            // Jeda tunggu rileks antar gelembung di dalam room chat yang sama
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));

            // STRATEGI 4: GELEMBUNG 2 - ISI TEMPLATE PENGINGAT UTAMA
            await sock.sendPresenceUpdate('composing', memberJid);
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
            
            // HAPUS .toLowerCase() DI SINI AGAR ISTILAH SEPERTI FIFO/LIFO TETAP AMAN KAPITAL BRAY!
            const sentMsg = await sock.sendMessage(memberJid, { text: pesanFinal });
            
            // Simpan id pesan terakhir ke database untuk pelacakan centang satu nanti
            if (reminder.teamTracking[memberJid]) {
                reminder.teamTracking[memberJid].lastMsgId = sentMsg.key.id;
            }

            // JEDA PENGAMAN ANTAR KEPALA NOMOR KELOMPOK (Dibuat lebih lama dan acak biar natural bray)
            await new Promise(r => setTimeout(r, 7000 + Math.random() * 5000));
        }
        
        saveConfig(config);
    } catch (err) {
        console.error('gagal distribusi ke tim:', err);
    }
}

async function generateAndSendTeamReport(sock, reminder, config) {
    let report = `*[laporan akhir keaktifan kelompok]*\nagenda: *[${reminder.judul}]*\n\n`;

    try {
        if (!groupCache[config.groupJid]) {
            groupCache[config.groupJid] = await sock.groupMetadata(config.groupJid);
            setTimeout(() => { delete groupCache[config.groupJid]; }, 10 * 60 * 1000);
        }

        const groupMeta = groupCache[config.groupJid];
        const members = groupMeta.participants || [];
        
        let listHadir = [];
        let listAbsen = [];
        let listNgilang = [];
        let listPasif = [];
        let listCentangSatu = [];

        for (const member of members) {
            const jid = member.id;
            if (jid.includes(botJidNumber)) continue;

            // FILTER BIAR ISI LAPORAN AKHIR OBJEKTIF CUMA NAMPILIN TARGET NYA AJA
            if (reminder.scope === 'tertarget' && !reminder.targets.includes(jid)) continue;

            const namaOrang = config.accountMapping?.[jid] || (jid === config.ownerJid ? 'pemilik' : jid.split('@')[0]);
            const track = reminder.teamTracking?.[jid] || { status: 'Belum Respon', reason: '', isDelivered: true };

            if (track.status === 'Hadir') {
                listHadir.push(`- ${namaOrang} (respon: ${track.message || 'bisa'})`);
            } else if (track.status === 'Absen') {
                listAbsen.push(`- ${namaOrang} (alasan: ${track.reason || 'ada urusan'})`);
            } else if (track.status === 'Abu-Abu') {
                listNgilang.push(`- ${namaOrang} (awal sempet bilang: ${track.reason || 'gatau'}, abis itu ngilang)`);
            } else {
                if (track.isDelivered === false) {
                    listCentangSatu.push(`- ${namaOrang} (nomor ga aktif / centang 1)`);
                } else {
                    listPasif.push(`- ${namaOrang} (silent reader / menyimak)`);
                }
            }
        }

        if (listHadir.length > 0) report += `*✅ anggota hadir/aktif:*\n${listHadir.join('\n')}\n\n`;
        if (listAbsen.length > 0) report += `*❌ anggota izin/absen:*\n${listAbsen.join('\n')}\n\n`;
        if (listNgilang.length > 0) report += `*⚠️ tidak konsisten (ngilang):*\n${listNgilang.join('\n')}\n\n`;
        if (listPasif.length > 0) report += `*💤 silent reader (pasif):*\n${listPasif.join('\n')}\n\n`;
        if (listCentangSatu.length > 0) report += `*🚫 nomor tidak aktif (centang 1):*\n${listCentangSatu.join('\n')}\n\n`;

        const teksFinalLaporan = report.trim();
        await sock.sendMessage(config.groupJid, { text: teksFinalLaporan });

        // ==========================================
        // MESIN OTOMATIS PENYIMPAN ARSIP LAPORAN
        // ==========================================
        if (!config.reports) config.reports = [];
        
        const existingRepIdx = config.reports.findIndex(r => r.agendaId === reminder.id);
        const reportData = {
            id: existingRepIdx !== -1 ? config.reports[existingRepIdx].id : `rep_${Date.now().toString().slice(-4)}`,
            agendaId: reminder.id,
            judul: reminder.judul,
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
    
    // KATUP PENGAMAN: Jangan eksekusi jadwal apa pun dalam 30 detik pertama pasca-login bray!
    if (Date.now() - botStartTime < 30 * 1000) {
        return;
    }

    isCheckingDeadlines = true;

    try {
        const config = loadConfig();
        let changed = false;
        const idsToRemove = [];

        for (const reminder of config.reminders) {
            if (reminder.type !== 'deadline') continue;
            if (!reminder.pendingAITexts) reminder.pendingAITexts = {};

            // ====================================================================
            // KATUP AUTO-CLEAN: JIKA TARGET UTAMA SUDAH LEWAT PAS BOT OFFLINE
            // ====================================================================
            if (Date.now() > reminder.targetTimestamp) {
                idsToRemove.push(reminder.id);
                changed = true;
                console.log(`[auto-clean] menghapus senyap agenda "${reminder.judul}" karena sudah kedalwarsa pas bot offline bray.`);
                continue; // Langsung lompat lewati pengiriman chat massal yan!
            }
            
            for (const milestone of reminder.milestones) {
                const key = milestoneKey(milestone);
                if (reminder.firedMilestones.includes(key)) continue;

                const triggerTs = computeTriggerTimestamp(milestone, reminder.targetTimestamp);

                if (Date.now() >= triggerTs) {
                    // SAKLAR PELACAKAN WAJIB AKTIF DAN SCOPE HARUS COCOK BRAY
                    if ((reminder.scope === 'group' || reminder.scope === 'tertarget') && reminder.withTracking !== false) {
                        await handleGroupTeamDistribution(sock, reminder, milestone, config);
                    }
                    
                    // SAKLAR LAPORAN SEKARANG IKUT MENJADI KATUP PENYARING UTAMA YAN
                    if (milestone.isAuto && (reminder.scope === 'group' || reminder.scope === 'tertarget') && reminder.withReport !== false) {
                        setTimeout(async () => {
                            const freshConfig = loadConfig();
                            const freshReminder = freshConfig.reminders.find(r => r.id === reminder.id) || reminder;
                            await generateAndSendTeamReport(sock, freshReminder, freshConfig);
                        }, 5 * 60 * 1000);
                    }
                    
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

    // ====================================================================
    // KATUP AUTO-DELETE: PEMBERSIH UTAMAA FILE MEDIA TG SETELAH 1 HARI YAN
    // ====================================================================
    scheduledTasks.push(cron.schedule('0 * * * *', () => {
        // Alamat folder scraper bray
        const targetDir = path.join(__dirname, '..', 'home-reminder'); 
        const directory = fs.existsSync(targetDir) ? targetDir : __dirname;
        
        fs.readdir(directory, (err, files) => {
            if (err) return;
            const now = Date.now();
            const oneDayInMs = 24 * 60 * 60 * 1000; // Filter ketat durasi 24 jam penuh yan bray
            
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
            // Rekam nomor HP asli bot
            botJidNumber = sock.user.id.split(':')[0].split('@')[0];
            // Rekam nomor LID akun bot (Jika ada)
            botLidNumber = sock.user.lid ? sock.user.lid.split(':')[0].split('@')[0] : null;
            
            setupSchedules(sock);
            await initTelegramScraper(sock);
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

        if (fromJid === config.ownerJid) {
            if (isListLaporan) {
                const arrRep = config.reports || [];
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
                
                let detailTeks = `📑 *[DETAIL ARSIP LAPORAN]*\n• id: ${foundRep.id}\n• tanggal: ${foundRep.tanggal}\n\n${foundRep.teks}`;
                await sock.sendMessage(fromJid, { text: detailTeks }, { quoted: msg });
                return;
            }

            if (isHapusLaporan) {
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
                            await sock.sendMessage(config.groupJid, { image: mediaBuffer, caption: whatsappPayload });
                        } else if (targetMsg.mediaType === 'video') {
                            await sock.sendMessage(config.groupJid, { video: mediaBuffer, caption: whatsappPayload });
                        }
                        await sock.sendMessage(fromJid, { text: `beres bray, pesan media HD id ${messageId} sukses diteruskan ke grup wa kuliah lu!` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(config.groupJid, { text: whatsappPayload });
                        await sock.sendMessage(fromJid, { text: `beres bray, pesan teks id ${messageId} sukses diteruskan ke grup wa kuliah lu!` }, { quoted: msg });
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
                
                // JIKA USER PILIH DIGANTI BESOK HARI YAN
                if (['besok', 'ubah besok', 'dirubah besok', 'lanjut', 'esok'].some(w => lowText.includes(w))) {
                    // Alirkan statusnya ke draf konfirmasi utama bray
                    setState(fromJid, 'confirm_schedule', state.data);
                    await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                    return;
                }
                
                // JIKA USER PILIH HAPUS ATAU SALAH KETIK
                if (['hapus', 'salah ketik', 'batal', 'cancel', 'gajadi', 'delete', 'salah'].some(w => lowText.includes(w))) {
                    resetState(fromJid);
                    await sock.sendMessage(fromJid, { text: `oke siap bray, draf agenda buat "${state.data.judul || 'agenda kasual'}" resmi gue apus dari memori ya wkwk` }, { quoted: msg });
                    return;
                }
                
                // Katup pengaman kalau ketikan anak-anak di grup gak jelas maksudnya bray
                await sock.sendMessage(fromJid, { text: `maksud lu gimana yan, mau diganti buat *besok* atau draf agendanya mau gue *hapus* aja nih?` }, { quoted: msg });
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
                    const isYes = /\b(iya|ya|yoi|oke|ok|y|buat|fix|gas|bisa|iye|iyee|yee)\b/i.test(lowText) || lowText.includes('iya') || lowText.includes('iye') || lowText.includes('buat agenda');
                    
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
                        const finalMilestones = calculateMilestonesArray(data.waktu, data.startTime, intervalVal, data.customMilestones);

                        let targetJidsFinal = [fromJid];
                        let finalScope = isGroup ? 'group' : 'personal';
                        
                        if (data.extractedTarget) {
                            const cleanTargetStr = data.extractedTarget.toLowerCase();
                            const mappedJids = [];
                            
                            Object.entries(config.accountMapping || {}).forEach(([jid, name]) => {
                                if (cleanTargetStr.includes(name.toLowerCase())) {
                                    mappedJids.push(jid);
                                }
                            });

                            if (mappedJids.length > 0) {
                                targetJidsFinal = mappedJids;
                                finalScope = 'tertarget'; 
                            } else {
                                const foundContact = config.contacts.find(c => c.name.toLowerCase() === data.extractedTarget.toLowerCase());
                                if (foundContact) {
                                    targetJidsFinal = [foundContact.jid];
                                    finalScope = 'personal';
                                }
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
                    // LAPIS 3: JALUR CERDAS INTERPRETASI KETIKAN KASUAL MANUSIA (AI BASIS)
                    // ====================================================================
                    const promptDinamisAI = `Kamu adalah mesin pembaca niat koreksi manifes agenda kuliah.
Data draf saat ini: ${JSON.stringify(state.data)}
User membalas dengan ketikan bebas: "${text}"

Tugas kamu adalah memetakan niat perkataan user dan mengembalikannya dalam bentuk JSON objek murni untuk menentukan tipe keputusan:
1. "batal": Jika user menggunakan kalimat pembatalan kasual/kaku (seperti: "ga jadi deh", "batalin aja", "gajadi", "cancel", "ntar aja dah pusing"). Kalimat balasan berupa penutupan lowercase ramah.
2. "edit": Jika user ingin memperbaiki parameter draf (mengubah judul, jam, target, atau memberikan skema alarm pengingat kustom baru).
3. "chat": Jika ketikan user di luar konteks pembatalan atau perbaikan draf (hanya basa-basi santai). Kalimat balasan berupa ketikan santai tongkrongan lowercase.

Aturan pengubahan parameter objek jika keputusan bernilai "edit":
- Jika user meminta alarm/pengingat di menit-menit tertentu (misal: di 30 menit, 20 menit, 10 menit, 5 menit, 3 menit, dan 1 menit terakhir), ambil seluruh angka menit tersebut, susun menjadi array angka terurut dari terbesar ke terkecil di properti "customMilestones", dan buat nilai "intervalMinutes" menjadi null.
- Jika user mengubah judul, isi properti "judul" dengan nama agenda baru yang bersih dari kata sampah pengetikan (seperti "ganti", "deh", "jadi", "judulnya").
- Jika user mengubah jam/waktu, isi properti "waktu" dengan format HH:MM digital.

Format keluaran WAJIB objek JSON mentah murni tanpa tanda backtick markdown, tanpa tulisan json, dan tanpa teks penjelas apa pun:
{
  "keputusan": "edit" | "batal" | "chat",
  "parameter_berubah": {
    "judul": string atau null,
    "waktu": string atau null,
    "customMilestones": array atau null,
    "intervalMinutes": number atau null
  },
  "balasan_chatan": string atau null
}`;

                    try {
                        const { generateAIText } = require('./geminiClient');
                        const aiRes = await generateAIText(promptDinamisAI, {}, '', '{}', false);
                        const cleanJsonStr = aiRes.text.replace(/```json|```/gi, '').trim();
                        const updateResult = JSON.parse(cleanJsonStr);

                        if (updateResult.keputusan === 'batal') {
                            resetState(fromJid);
                            const teksBatal = updateResult.balasan_chatan || `oke siap bray, draf agenda resmi gue apus dari memori ya wkwk`;
                            await sock.sendMessage(fromJid, { text: teksBatal.toLowerCase() }, { quoted: msg });
                            return;
                        }

                        if (updateResult.keputusan === 'edit') {
                            const params = updateResult.parameter_berubah || {};
                            Object.keys(params).forEach(key => {
                                if (params[key] !== undefined && params[key] !== null) {
                                    state.data[key] = params[key];
                                } else if (params[key] === null && (key === 'intervalMinutes' || key === 'customMilestones')) {
                                    state.data[key] = null; 
                                }
                            });
                            await sendDetailedConfirmation(sock, fromJid, state.data, msg);
                            return;
                        }

                        if (updateResult.keputusan === 'chat') {
                            const teksChat = updateResult.balasan_chatan || `mau lanjut chatan aja atau draf agenda "${state.data.judul}" nya mau disimpen nih bray?`;
                            await sock.sendMessage(fromJid, { text: teksChat.toLowerCase() }, { quoted: msg });
                            return;
                        }

                    } catch (err) {
                        console.error('gagal parsing keputusan draf AI:', err.message);
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

            const intentData = await parseIntentFromText(processingText);

            if (intentData.intent === 'create_schedule') {
                intentData.creator = currentNick;
                intentData.creatorJid = senderJid.split('@')[0];

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

                const calculated = calculateMilestonesArray(intentData.waktu, intentData.startTime, intentData.intervalMinutes || 1); //

                if (calculated.length > 30) {
                    setState(fromJid, 'interval_correction', { originalData: intentData, count: calculated.length });
                    const reply = await generateDynamicStateText(`ini yakin gue ngingetin ${calculated.length} kali gempor gue gila bray peladen bisa meledak coba benerin lagi maksud lu gimana mau diganti tiap berapa menit`, currentNick, samples, chatMemory[fromJid] || []);
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
                // KONDISI PENGENALAN SEPIHAK OLEH OWNER (KASUAL & KAKU SLASH)
                // ====================================================================
                if (fromJid === config.ownerJid && (lowText.startsWith('daftarin ') || cmd === '/daftarin')) {
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
                        config.accountMapping[nomorTarget] = namaTarget;
                        saveConfig(config);
                        
                        await sock.sendMessage(fromJid, { text: `beres yan, nomor ${nomorTarget.split('@')[0]} resmi gue catat sebagai *${namaTarget}* di database bray` }, { quoted: msg });
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