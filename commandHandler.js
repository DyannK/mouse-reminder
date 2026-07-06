const { loadConfig, saveConfig } = require('./configManager');
const { parseWaktuKeCron, formatCronKeTeks } = require('./timeParser');
const { parseTargetDateTime, parseMilestones, milestoneKey } = require('./deadlineParser');
const { setManualStyle, resolveJidForName } = require('./styleProfiler');

function isAuthorized(config, jid) {
    return jid === config.ownerJid || config.authorizedUsers.includes(jid);
}

function resolveTargetsToJids(config, targetNames) {
    const jids = [];
    targetNames.forEach(name => {
        const clean = name.trim().toLowerCase();
        if (clean === 'group') {
            jids.push(config.groupJid);
        } else {
            const contact = config.contacts.find(c => c.name.toLowerCase() === clean);
            if (contact) jids.push(contact.jid);
        }
    });
    return jids;
}

/**
 * Parse input pesan buat /editpesan. Kalau diawali "AI:", wajib ada fallback manual
 * dipisah "|", karena AI bisa gagal (server overload dll) dan reminder tetap harus
 * punya teks yang jelas buat dikirim.
 * Format: "AI: <tema> | <fallback manual>"  ATAU  teks biasa (literal, gak perlu fallback).
 */
function parsePesanInput(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { error: 'Pesan gak boleh kosong.' };

    if (trimmed.toUpperCase().startsWith('AI:')) {
        const afterPrefix = trimmed.substring(3).trim();
        const parts = afterPrefix.split('|').map(s => s.trim());
        if (parts.length < 2 || !parts[0] || !parts[1]) {
            return { error: 'Pakai AI wajib sertakan tema DAN teks fallback manual.\nFormat: AI: <tema> | <teks fallback kalau AI gagal>\nContoh: AI: ingetin minum air, gaya asik | Woy jangan lupa minum air ya!' };
        }
        return { message: `AI:${parts[0]}`, manualFallback: parts[1] };
    }
    return { message: trimmed, manualFallback: null };
}

const HELP_TEXT = `🤖 *Halo! Ini bot reminder kamu.*

Cara pakai paling dasar, 3 langkah:
1️⃣ Simpan kontak dulu (kalau mau reminder ke personal chat) — share kontak WA ke chat ini
2️⃣ Buat reminder pakai /tambah
3️⃣ Cek /list buat lihat reminder yang aktif

📖 *Ketik ini untuk penjelasan lebih detail per topik:*
/help jadwal → cara nulis format jam & hari
/help kontak → cara simpan kontak personal
/help reminder → semua command atur reminder
/help ai → cara pakai teks auto-generate AI + niru gaya ketikan

Atau langsung liat contoh cepat:
/tambah olahraga 06:00 weekday | Yuk olahraga! | group

Ketik command apa saja, bot akan kasih tahu kalau formatnya salah.`;

const HELP_JADWAL = `📅 *Cara Nulis Jadwal*

Format: <HH:MM> [hari]

*Jam* — wajib, format 24 jam (bukan AM/PM)
✅ 07:00   ✅ 19:30   ❌ 7:00 pagi

*Hari* — opsional, kalau kosongin artinya tiap hari
• harian → tiap hari (sama kalau dikosongin)
• weekday → Senin sampai Jumat
• weekend → Sabtu & Minggu
• Atau pilih sendiri, pisah koma: sen,sel,rab,kam,jum,sab,min

*Contoh:*
07:00                → tiap hari jam 7 pagi
19:30 weekday        → Senin-Jumat jam 7:30 malam
06:00 sen,rab,jum     → Senin, Rabu, Jumat jam 6 pagi
20:00 weekend         → Sabtu-Minggu jam 8 malam`;

const HELP_KONTAK = `📇 *Cara Simpan Kontak Personal*

Kalau reminder-nya mau dikirim ke chat pribadi seseorang (bukan grup), simpan dulu kontaknya:

1. Buka contact info orang itu di WhatsApp
2. Share/Forward kontak itu ke chat ini (gak perlu ketik apapun, cukup share biasa)
3. Bot bakal tanya "mau disimpan nama apa?"
4. Balas aja namanya, misal: budi

Setelah tersimpan, nama itu bisa dipakai sebagai target reminder, contoh: /tambah ... | ... | budi

*Command terkait:*
/listkontak → lihat semua kontak tersimpan
/hapuskontak <nama> → hapus kontak, contoh: /hapuskontak budi`;

const HELP_REMINDER = `⏰ *Command Atur Reminder*

Ada 2 tipe reminder:

*1) Reminder berulang* (harian/mingguan)
/tambah <id> <jadwal> | <pesan> | <target>

Contoh:
/tambah olahraga 06:00 weekday | Yuk olahraga! | group

*2) Deadline/countdown reminder* (sekali tembak, hitung mundur)
/tambahdeadline <id> | <DD-MM-YYYY HH:MM> | <judul> | <milestone> | <target>

Milestone (pisah koma):
• 3hari → diingetin H-3 jam 08:00 pagi
• 3hari@07:00 → H-3 tapi jam custom
• 2jam, 30menit → sebelum waktu target persis
• 2jam30menit → boleh gabung unit

Bot otomatis nambahin 1 reminder pas persis waktu target, gak perlu ditulis manual.

Contoh:
/tambahdeadline meeting | 05-07-2026 18:00 | Meeting klien | 3hari,1hari,2jam,30menit | group

*Catatan:* pesan reminder pas dibuat (/tambah atau /tambahdeadline) selalu teks biasa dulu.
Kalau mau AI-generated, pakai /editpesan setelah reminder dibuat (lihat /help ai).

*Ubah reminder yang sudah ada:*
/editjadwal <id> <jadwal baru> → khusus reminder berulang
/editdeadline <id> | <tanggal> | <judul> | <milestone> | <target> → khusus deadline, isi "-" di bagian yang gak mau diubah
/editpesan <id> <pesan baru> → berlaku kedua tipe, boleh pakai {sisa} dan {judul}
/editjitter <id> <detik> → khusus reminder berulang, default 15 detik

*Lihat & hapus (berlaku utk kedua tipe):*
/list → lihat semua reminder aktif
/hapus <id> → hapus satu reminder

Contoh /editdeadline (cuma ganti judul & target, tanggal+milestone tetap):
/editdeadline meeting | - | Meeting klien (revisi) | - | group,budi`;

const HELP_AI = `🧠 *Teks Otomatis Pakai AI (Gratis)*

Ubah pesan reminder yang sudah ada jadi AI-generated:
/editpesan <id> AI: <tema singkat> | <teks fallback manual>

• tema = deskripsi singkat, boleh sertain gaya ("asik", "formal", dll)
• fallback = teks manual yang dipakai KALAU AI gagal generate (server sibuk dll) — wajib diisi

Contoh:
/editpesan tugas_kalkulus AI: ingetin tugas kalkulus II tentang integral, gaya santai | Jangan lupa tugas kalkulus II ya!

Bot bakal generate teks ini beberapa menit sebelum waktu kirim (biar ada waktu coba ulang kalau gagal), bukan mepet di detik terakhir. Kalau AI tetap gagal setelah dicoba beberapa kali, kamu (owner) bakal di-DM biar tau, dan reminder tetap terkirim pakai fallback manual kamu.

*Niru Gaya Ketikan Seseorang*
Bot bisa niru gaya ngetik orang tertentu waktu generate teks AI:
/gayaketik <nama|aku> <deskripsi gaya>

Contoh:
/gayaketik aku santai, suka pakai "wkwk" sama emoji 😂
/gayaketik budi banyak CAPSLOCK kalau lagi niatin sesuatu, suka emoji 🔥

Bot juga otomatis belajar dari histori chat orang itu (pola CAPSLOCK, emoji favorit, panjang pesan), digabung sama deskripsi manual di atas.

Reminder ke target "group" pakai gaya kamu (owner) secara default. Reminder ke kontak tertentu pakai gaya kontak itu (kalau ada datanya).`;

const OWNER_HELP_EXTRA = `

👑 *Khusus owner:*
/hapususer <nomor> → cabut akses seseorang, contoh: /hapususer 6281234567890
/listuser → lihat siapa saja yang punya akses`;

async function handleCommand(sock, text, fromJid, rebuildSchedules) {
    let config = loadConfig();
    const parts = text.trim().split(' ');
    const command = parts[0].toLowerCase();

    // --- /daftar tidak butuh authorization dulu ---
    if (command === '/daftar') {
        const inputPassword = parts[1];
        if (!inputPassword) {
            await sock.sendMessage(fromJid, { text: 'Format: /daftar <password>' });
            return;
        }
        if (inputPassword === config.password) {
            if (!config.authorizedUsers.includes(fromJid) && fromJid !== config.ownerJid) {
                config.authorizedUsers.push(fromJid);
                saveConfig(config);
            }
            await sock.sendMessage(fromJid, { text: '✅ Berhasil terdaftar. Ketik /help untuk lihat command.' });
        } else {
            await sock.sendMessage(fromJid, { text: '❌ Password salah.' });
        }
        return;
    }

    // --- Semua command di bawah wajib authorized ---
    if (!isAuthorized(config, fromJid)) {
        await sock.sendMessage(fromJid, { text: '🔒 Kamu belum terdaftar. Ketik /daftar <password>.' });
        return;
    }

    const isOwner = fromJid === config.ownerJid;

    if (command === '/help') {
        const topic = parts[1]?.toLowerCase();
        if (topic === 'jadwal') {
            await sock.sendMessage(fromJid, { text: HELP_JADWAL });
        } else if (topic === 'kontak') {
            await sock.sendMessage(fromJid, { text: HELP_KONTAK });
        } else if (topic === 'reminder') {
            await sock.sendMessage(fromJid, { text: HELP_REMINDER });
        } else if (topic === 'ai') {
            await sock.sendMessage(fromJid, { text: HELP_AI });
        } else {
            await sock.sendMessage(fromJid, { text: HELP_TEXT + (isOwner ? OWNER_HELP_EXTRA : '') });
        }

    } else if (command === '/list') {
        if (config.reminders.length === 0) {
            await sock.sendMessage(fromJid, { text: 'Belum ada reminder.' });
            return;
        }
        let msg = '📋 Daftar reminder:\n\n';
        config.reminders.forEach(r => {
            const isAI = (r.message || '').startsWith('AI:');
            const pesanInfo = isAI ? `AI-generated (tema: ${r.message.replace('AI:', '').trim()})` : `"${r.message}"`;

            if (r.type === 'deadline') {
                const tanggalTarget = new Date(r.targetTimestamp + 7 * 3600 * 1000);
                const tglStr = `${String(tanggalTarget.getUTCDate()).padStart(2, '0')}-${String(tanggalTarget.getUTCMonth() + 1).padStart(2, '0')}-${tanggalTarget.getUTCFullYear()} ${String(tanggalTarget.getUTCHours()).padStart(2, '0')}:${String(tanggalTarget.getUTCMinutes()).padStart(2, '0')}`;
                const sisaMilestone = r.milestones.filter(m => !r.firedMilestones.includes(milestoneKey(m))).length;
                msg += `• [${r.id}] ⏳ deadline: ${tglStr}\n  judul: ${r.judul}\n  pesan: ${pesanInfo}\n  target: ${(r.targets || ['group']).join(', ')}\n  sisa milestone: ${sisaMilestone}/${r.milestones.length}\n\n`;
            } else {
                msg += `• [${r.id}] 🔁 ${formatCronKeTeks(r.cronPattern)}\n  pesan: ${pesanInfo}\n  target: ${(r.targets || ['group']).join(', ')}\n\n`;
            }
        });
        await sock.sendMessage(fromJid, { text: msg });

    } else if (command === '/tambah') {
        const rest = text.substring('/tambah'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        if (segments.length < 2) {
            await sock.sendMessage(fromJid, { text: '❌ Format salah. Contoh:\n/tambah olahraga 06:00 weekday | Yuk olahraga! | group' });
            return;
        }
        const [idAndJam, pesanPart, targetPart] = segments;
        const idJamParts = idAndJam.split(' ');
        const id = idJamParts[0];
        const jamText = idJamParts.slice(1).join(' ');

        if (!id) {
            await sock.sendMessage(fromJid, { text: '❌ ID reminder gak boleh kosong.' });
            return;
        }
        if (config.reminders.find(r => r.id === id)) {
            await sock.sendMessage(fromJid, { text: `❌ ID "${id}" sudah dipakai. Pilih id lain atau /hapus dulu.` });
            return;
        }

        const result = parseWaktuKeCron(jamText);
        if (result.error) {
            await sock.sendMessage(fromJid, { text: `❌ ${result.error}` });
            return;
        }
        if (!pesanPart) {
            await sock.sendMessage(fromJid, { text: '❌ Pesan gak boleh kosong.' });
            return;
        }
        if (pesanPart.toUpperCase().startsWith('AI:')) {
            await sock.sendMessage(fromJid, { text: '❌ Reminder baru harus pakai pesan teks biasa dulu. Kalau mau AI-generated, buat dulu reminder-nya, baru pakai /editpesan (cek /help ai).' });
            return;
        }

        const targets = targetPart ? targetPart.split(',').map(s => s.trim()) : ['group'];
        const validTargetJids = resolveTargetsToJids(config, targets);
        if (validTargetJids.length === 0) {
            await sock.sendMessage(fromJid, { text: `❌ Target "${targets.join(', ')}" gak ada yang valid. Cek /listkontak dulu.` });
            return;
        }

        config.reminders.push({
            id,
            cronPattern: result.cronPattern,
            message: pesanPart,
            manualFallback: null,
            jitterSeconds: 15,
            targets
        });
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `✅ Reminder "${id}" ditambahkan.\nJadwal: ${result.cronPattern}\nTarget: ${targets.join(', ')}` });

    } else if (command === '/tambahdeadline') {
        const rest = text.substring('/tambahdeadline'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        if (segments.length < 4) {
            await sock.sendMessage(fromJid, {
                text: '❌ Format salah. Contoh:\n/tambahdeadline meeting | 05-07-2026 18:00 | Meeting klien | 1hari,2jam,30menit | group'
            });
            return;
        }
        const [id, tanggalStr, judul, milestoneStr, targetPart] = segments;

        if (!id) {
            await sock.sendMessage(fromJid, { text: '❌ ID gak boleh kosong.' });
            return;
        }
        if (config.reminders.find(r => r.id === id)) {
            await sock.sendMessage(fromJid, { text: `❌ ID "${id}" sudah dipakai. Pilih id lain atau /hapus dulu.` });
            return;
        }

        const targetResult = parseTargetDateTime(tanggalStr);
        if (targetResult.error) {
            await sock.sendMessage(fromJid, { text: `❌ ${targetResult.error}` });
            return;
        }

        const milestoneResult = parseMilestones(milestoneStr);
        if (milestoneResult.error) {
            await sock.sendMessage(fromJid, { text: `❌ ${milestoneResult.error}` });
            return;
        }

        const targets = targetPart ? targetPart.split(',').map(s => s.trim()) : ['group'];
        const validTargetJids = resolveTargetsToJids(config, targets);
        if (validTargetJids.length === 0) {
            await sock.sendMessage(fromJid, { text: `❌ Target "${targets.join(', ')}" gak ada yang valid. Cek /listkontak dulu.` });
            return;
        }

        config.reminders.push({
            id,
            type: 'deadline',
            targetTimestamp: targetResult.timestamp,
            judul,
            message: `⏰ {sisa} menuju "{judul}"!`,
            manualFallback: null,
            milestones: milestoneResult.milestones,
            firedMilestones: [],
            pendingAITexts: {},
            targets
        });
        saveConfig(config);
        rebuildSchedules();

        const daftarMilestone = milestoneResult.milestones.map(m => m.label).join(', ');
        await sock.sendMessage(fromJid, {
            text: `✅ Deadline reminder "${id}" dibuat.\nTarget: ${tanggalStr}\nJudul: ${judul}\nAkan diingetin: ${daftarMilestone}\n\nMau custom pesannya? /editpesan ${id} <teks>, boleh pakai {sisa} dan {judul}.\nMau AI-generated? Cek /help ai.`
        });

    } else if (command === '/editdeadline') {
        // format: /editdeadline <id> | <tanggal atau -> | <judul atau -> | <milestone atau -> | <target atau ->
        const rest = text.substring('/editdeadline'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        const id = segments[0];

        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        if (reminder.type !== 'deadline') {
            await sock.sendMessage(fromJid, { text: `❌ "${id}" bukan deadline reminder. Pakai /editjadwal kalau itu reminder berulang.` });
            return;
        }
        if (segments.length < 5) {
            await sock.sendMessage(fromJid, {
                text: '❌ Format: /editdeadline <id> | <tanggal atau -> | <judul atau -> | <milestone atau -> | <target atau ->\nIsi "-" di bagian yang gak mau diubah.\nContoh (cuma ganti judul): /editdeadline meeting | - | Meeting klien revisi | - | -'
            });
            return;
        }

        const [, tanggalStr, judulStr, milestoneStr, targetStr] = segments;
        let jadwalBerubah = false;

        if (tanggalStr && tanggalStr !== '-') {
            const targetResult = parseTargetDateTime(tanggalStr);
            if (targetResult.error) {
                await sock.sendMessage(fromJid, { text: `❌ ${targetResult.error}` });
                return;
            }
            reminder.targetTimestamp = targetResult.timestamp;
            jadwalBerubah = true;
        }

        if (judulStr && judulStr !== '-') {
            reminder.judul = judulStr;
        }

        if (milestoneStr && milestoneStr !== '-') {
            const milestoneResult = parseMilestones(milestoneStr);
            if (milestoneResult.error) {
                await sock.sendMessage(fromJid, { text: `❌ ${milestoneResult.error}` });
                return;
            }
            reminder.milestones = milestoneResult.milestones;
            jadwalBerubah = true;
        }

        if (targetStr && targetStr !== '-') {
            const newTargets = targetStr.split(',').map(s => s.trim());
            const validJids = resolveTargetsToJids(config, newTargets);
            if (validJids.length === 0) {
                await sock.sendMessage(fromJid, { text: `❌ Target "${newTargets.join(', ')}" gak ada yang valid. Cek /listkontak dulu.` });
                return;
            }
            reminder.targets = newTargets;
        }

        if (jadwalBerubah) {
            // jadwal/milestone berubah -> semua milestone dianggap "belum terkirim" lagi
            reminder.firedMilestones = [];
            reminder.pendingAITexts = {};
        }

        saveConfig(config);
        rebuildSchedules();

        const daftarMilestone = reminder.milestones.map(m => m.label).join(', ');
        await sock.sendMessage(fromJid, { text: `✅ Deadline "${id}" diupdate.\nJudul: ${reminder.judul}\nMilestone: ${daftarMilestone}\nTarget: ${(reminder.targets || ['group']).join(', ')}` });

    } else if (command === '/editjadwal') {
        const id = parts[1];
        const jamText = parts.slice(2).join(' ');
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        if (reminder.type === 'deadline') {
            await sock.sendMessage(fromJid, { text: `❌ "${id}" itu deadline reminder. Pakai /editdeadline.` });
            return;
        }
        const result = parseWaktuKeCron(jamText);
        if (result.error) {
            await sock.sendMessage(fromJid, { text: `❌ ${result.error}` });
            return;
        }
        reminder.cronPattern = result.cronPattern;
        reminder.pendingAIText = null; // jadwal berubah, teks pre-generate lama gak relevan lagi
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `✅ Jadwal "${id}" jadi: ${formatCronKeTeks(result.cronPattern)}` });

    } else if (command === '/editpesan') {
        const id = parts[1];
        const rawPesan = text.substring(('/editpesan ' + id).length).trim();
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        const result = parsePesanInput(rawPesan);
        if (result.error) {
            await sock.sendMessage(fromJid, { text: `❌ ${result.error}` });
            return;
        }
        reminder.message = result.message;
        reminder.manualFallback = result.manualFallback;
        reminder.pendingAIText = null;
        if (reminder.pendingAITexts) reminder.pendingAITexts = {};
        saveConfig(config);
        const isAI = result.message.startsWith('AI:');
        await sock.sendMessage(fromJid, { text: `✅ Pesan "${id}" diubah.${isAI ? '\nMode: AI-generated (fallback manual tersimpan kalau AI gagal).' : ''}` });

    } else if (command === '/editjitter') {
        const id = parts[1];
        const detikStr = parts[2];
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        const detik = parseInt(detikStr, 10);
        if (isNaN(detik) || detik < 0) {
            await sock.sendMessage(fromJid, { text: '❌ Format: /editjitter <id> <detik>, contoh: /editjitter olahraga 10' });
            return;
        }
        reminder.jitterSeconds = detik;
        saveConfig(config);
        await sock.sendMessage(fromJid, { text: `✅ Jitter "${id}" diubah jadi maksimal ${detik} detik.\n(0 = kirim persis di jadwal, tanpa delay random)` });

    } else if (command === '/hapus') {
        const id = parts[1];
        const index = config.reminders.findIndex(r => r.id === id);
        if (index === -1) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        config.reminders.splice(index, 1);
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `🗑️ Reminder "${id}" dihapus.` });

    } else if (command === '/gayaketik') {
        const nama = parts[1];
        const deskripsi = parts.slice(2).join(' ');
        if (!nama || !deskripsi) {
            await sock.sendMessage(fromJid, { text: 'Format: /gayaketik <nama|aku> <deskripsi>\nContoh: /gayaketik aku santai, suka "wkwk" dan emoji 😂' });
            return;
        }
        const targetJid = resolveJidForName(config, nama);
        if (!targetJid) {
            await sock.sendMessage(fromJid, { text: `❌ "${nama}" gak dikenali. Pakai "aku" buat gaya kamu sendiri, atau nama kontak yang sudah tersimpan (cek /listkontak).` });
            return;
        }
        setManualStyle(targetJid, deskripsi);
        await sock.sendMessage(fromJid, { text: `✅ Gaya ketik "${nama}" tersimpan. Bakal dipakai tiap generate teks AI yang ditujukan buat ${nama}.` });

    } else if (command === '/kontak') {
        await sock.sendMessage(fromJid, {
            text: '📇 Cara simpan kontak:\n1. Buka contact info orang yang mau disimpan\n2. Share/Forward kontak itu ke chat ini (gak perlu ketik apapun)\n3. Bot akan otomatis tanya nama, tinggal balas nama-nya'
        });

    } else if (command === '/hapuskontak') {
        const name = parts.slice(1).join(' ').trim();
        if (!name) {
            await sock.sendMessage(fromJid, { text: 'Format: /hapuskontak <nama>\nContoh: /hapuskontak budi\n\nCek /listkontak dulu kalau lupa nama persisnya.' });
            return;
        }
        const index = config.contacts.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
        if (index === -1) {
            await sock.sendMessage(fromJid, { text: `❌ Kontak "${name}" gak ditemukan. Cek /listkontak untuk lihat nama yang tersimpan.` });
            return;
        }
        const removedName = config.contacts[index].name;
        config.contacts.splice(index, 1);
        saveConfig(config);
        await sock.sendMessage(fromJid, { text: `🗑️ Kontak "${removedName}" dihapus.` });

    } else if (command === '/listkontak') {
        if (config.contacts.length === 0) {
            await sock.sendMessage(fromJid, { text: 'Belum ada kontak tersimpan.' });
            return;
        }
        let msg = '📇 Kontak tersimpan:\n\n';
        config.contacts.forEach(c => { msg += `• ${c.name}\n`; });
        await sock.sendMessage(fromJid, { text: msg });

    } else if (command === '/hapususer') {
        if (!isOwner) {
            await sock.sendMessage(fromJid, { text: '🔒 Command ini khusus owner.' });
            return;
        }
        const nomor = parts[1];
        if (!nomor) {
            await sock.sendMessage(fromJid, { text: 'Format: /hapususer <nomor>, contoh: /hapususer 6281234567890' });
            return;
        }
        const targetJid = `${nomor}@s.whatsapp.net`;
        const before = config.authorizedUsers.length;
        config.authorizedUsers = config.authorizedUsers.filter(j => j !== targetJid);
        saveConfig(config);
        const removed = before !== config.authorizedUsers.length;
        await sock.sendMessage(fromJid, { text: removed ? `✅ Akses ${nomor} dicabut.` : `⚠️ Nomor ${nomor} gak ada di daftar authorized user.` });

    } else if (command === '/listuser') {
        if (!isOwner) {
            await sock.sendMessage(fromJid, { text: '🔒 Command ini khusus owner.' });
            return;
        }
        let msg = '👥 User terdaftar:\n\n';
        if (config.authorizedUsers.length === 0) {
            msg += '(belum ada, cuma owner)';
        } else {
            config.authorizedUsers.forEach(j => { msg += `• ${j.replace('@s.whatsapp.net', '')}\n`; });
        }
        await sock.sendMessage(fromJid, { text: msg });

    } else {
        await sock.sendMessage(fromJid, { text: `❓ Command gak dikenali. Ketik /help untuk lihat daftar command.` });
    }
}

module.exports = { handleCommand, resolveTargetsToJids, isAuthorized };