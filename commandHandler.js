const { loadConfig, saveConfig } = require('./configManager');
const { parseWaktuKeCron, formatCronKeTeks } = require('./timeParser');
const { parseTargetDateTime, parseMilestones, milestoneKey } = require('./deadlineParser');

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

const HELP_TEXT = `🤖 *Halo! Ini bot reminder kamu.*

Cara pakai paling dasar, 3 langkah:
1️⃣ Simpan kontak dulu (kalau mau reminder ke personal chat) — share kontak WA ke chat ini
2️⃣ Buat reminder pakai /tambah
3️⃣ Cek /list buat lihat reminder yang aktif

📖 *Ketik ini untuk penjelasan lebih detail per topik:*
/help jadwal → cara nulis format jam & hari
/help kontak → cara simpan kontak personal
/help reminder → semua command atur reminder

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

*Ubah reminder yang sudah ada (berlaku utk kedua tipe kecuali disebutkan):*
/setjam <id> <jadwal baru> → khusus reminder berulang
/setdeadline <id> | <DD-MM-YYYY HH:MM> | <milestone> → khusus deadline (milestone opsional, kalau kosong pakai yang lama)
/setpesan <id> <pesan baru> → berlaku utk kedua tipe, boleh pakai {sisa} dan {judul}
/setjitter <id> <detik> → khusus reminder berulang, default 15 detik

*Pesan otomatis pakai AI (gratis, teks beda-beda tiap kirim):*
/setpesan <id> AI: <tema singkat>
Contoh: /setpesan tugas_kalkulus AI: ingetin tugas kalkulus II tentang integral, gaya santai

*Lihat & hapus (berlaku utk kedua tipe):*
/list → lihat semua reminder aktif
/hapus <id> → hapus satu reminder`;

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
        // format: /tambah <id> <jadwal> | <pesan> | <target1,target2>
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
            jitterSeconds: 15,
            targets
        });
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `✅ Reminder "${id}" ditambahkan.\nJadwal: ${result.cronPattern}\nTarget: ${targets.join(', ')}` });

    } else if (command === '/tambahdeadline') {
        // format: /tambahdeadline <id> | <DD-MM-YYYY HH:MM> | <judul> | <milestone> | <target>
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
            milestones: milestoneResult.milestones,
            firedMilestones: [],
            targets
        });
        saveConfig(config);
        rebuildSchedules();

        const daftarMilestone = milestoneResult.milestones.map(m => m.label).join(', ');
        await sock.sendMessage(fromJid, {
            text: `✅ Deadline reminder "${id}" dibuat.\nTarget: ${tanggalStr}\nJudul: ${judul}\nAkan diingetin: ${daftarMilestone}\n\nMau custom pesannya? Pakai /setpesan ${id} <teks>, boleh pakai {sisa} dan {judul}.\nMau AI yang generate teks otomatis? Pakai /setpesan ${id} AI: <tema singkat>`
        });

    } else if (command === '/setdeadline') {
        // format: /setdeadline <id> | <DD-MM-YYYY HH:MM> | <milestone>
        const rest = text.substring('/setdeadline'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        const idPart = segments[0]?.split(' ')[0];

        const reminder = config.reminders.find(r => r.id === idPart);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${idPart}" gak ditemukan.` });
            return;
        }
        if (reminder.type !== 'deadline') {
            await sock.sendMessage(fromJid, { text: `❌ "${idPart}" bukan deadline reminder. Pakai /setjam kalau itu reminder berulang.` });
            return;
        }
        if (segments.length < 2) {
            await sock.sendMessage(fromJid, {
                text: '❌ Format: /setdeadline <id> | <DD-MM-YYYY HH:MM> | <milestone>\nContoh: /setdeadline meeting | 06-07-2026 19:00 | 1hari,2jam'
            });
            return;
        }

        const tanggalStr = segments[1];
        const milestoneStr = segments[2]; // opsional, kalau gak diisi milestone lama tetap dipakai

        const targetResult = parseTargetDateTime(tanggalStr);
        if (targetResult.error) {
            await sock.sendMessage(fromJid, { text: `❌ ${targetResult.error}` });
            return;
        }

        reminder.targetTimestamp = targetResult.timestamp;

        if (milestoneStr) {
            const milestoneResult = parseMilestones(milestoneStr);
            if (milestoneResult.error) {
                await sock.sendMessage(fromJid, { text: `❌ ${milestoneResult.error}` });
                return;
            }
            reminder.milestones = milestoneResult.milestones;
        }

        // reset supaya semua milestone bisa terkirim ulang sesuai jadwal baru
        reminder.firedMilestones = [];

        saveConfig(config);
        rebuildSchedules();

        const daftarMilestone = reminder.milestones.map(m => m.label).join(', ');
        await sock.sendMessage(fromJid, { text: `✅ Deadline "${idPart}" diupdate.\nTarget baru: ${tanggalStr}\nMilestone: ${daftarMilestone}` });

    } else if (command === '/setjam') {
        const id = parts[1];
        const jamText = parts.slice(2).join(' ');
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        if (reminder.type === 'deadline') {
            await sock.sendMessage(fromJid, { text: `❌ "${id}" itu deadline reminder, jadwalnya gak bisa diubah lewat /setjam. Hapus dulu (/hapus ${id}) lalu /tambahdeadline lagi.` });
            return;
        }
        const result = parseWaktuKeCron(jamText);
        if (result.error) {
            await sock.sendMessage(fromJid, { text: `❌ ${result.error}` });
            return;
        }
        reminder.cronPattern = result.cronPattern;
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `✅ Jadwal "${id}" jadi: ${result.cronPattern}` });

    } else if (command === '/setpesan') {
        const id = parts[1];
        const newMessage = parts.slice(2).join(' ');
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        if (!newMessage) {
            await sock.sendMessage(fromJid, { text: '❌ Pesan gak boleh kosong.' });
            return;
        }
        reminder.message = newMessage;
        saveConfig(config);
        await sock.sendMessage(fromJid, { text: `✅ Pesan "${id}" diubah.` });

    } else if (command === '/setjitter') {
        // format: /setjitter <id> <detik>
        const id = parts[1];
        const detikStr = parts[2];
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `❌ Reminder "${id}" gak ditemukan.` });
            return;
        }
        const detik = parseInt(detikStr, 10);
        if (isNaN(detik) || detik < 0) {
            await sock.sendMessage(fromJid, { text: '❌ Format: /setjitter <id> <detik>, contoh: /setjitter olahraga 10' });
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