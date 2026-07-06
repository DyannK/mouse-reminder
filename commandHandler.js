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

function parsePesanInput(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { error: 'Pesan gak boleh kosong.' };

    if (trimmed.toUpperCase().startsWith('AI:')) {
        const afterPrefix = trimmed.substring(3).trim();
        const parts = afterPrefix.split('|').map(s => s.trim());
        if (parts.length < 2 || !parts[0] || !parts[1]) {
            return { error: 'Pakai AI wajib sertakan tema DAN teks fallback manual.\nFormat: AI: <tema> | <teks fallback>\nContoh: AI: ingetin tugas | Woy tugas!' };
        }
        return { message: `AI:${parts[0]}`, manualFallback: parts[1] };
    }
    return { message: trimmed, manualFallback: null };
}

async function handleListCommand(sock, fromJid, config) {
    const isGroup = fromJid.endsWith('@g.us');
    let visibleReminders = config.reminders || [];

    if (isGroup) {
        // Di grup hanya menampilkan agenda yang memiliki cakupan kelompok
        visibleReminders = visibleReminders.filter(r => r.scope === 'group');
    } else {
        // Di chat pribadi: owner bisa melihat semuanya, user biasa hanya melihat agenda kelompok
        if (fromJid !== config.ownerJid) {
            visibleReminders = visibleReminders.filter(r => r.scope === 'group');
        }
    }

    if (visibleReminders.length === 0) {
        await sock.sendMessage(fromJid, { text: 'Belum ada jadwal atau agenda yang tercatat saat ini.' });
        return;
    }

    let msg = 'nih coy jadwalnya:\n\n';
    visibleReminders.forEach(r => {
        let waktuStr = '';
        if (r.type === 'deadline') {
            const tanggalTarget = new Date(r.targetTimestamp + 7 * 3600 * 1000);
            waktuStr = `${String(tanggalTarget.getUTCDate()).padStart(2, '0')}-${String(tanggalTarget.getUTCMonth() + 1).padStart(2, '0')}-${tanggalTarget.getUTCFullYear()} | jam ${String(tanggalTarget.getUTCHours()).padStart(2, '0')}:${String(tanggalTarget.getUTCMinutes()).padStart(2, '0')} WIB`;
        } else {
            waktuStr = formatCronKeTeks(r.cronPattern);
        }

        const targetNames = (r.targets || []).map(t => {
            if (t === 'group') return 'GROUP';
            const contact = config.contacts.find(c => c.name.toLowerCase() === t.toLowerCase());
            return contact ? `PERSONAL (${contact.name})` : 'PERSONAL';
        }).join(', ');

        // Format tampilan menggunakan kurung siku tebal dan spasi lapang ramah layar HP
        msg += `*[${r.judul || r.id}]*\n`;
        msg += `Waktu: ${waktuStr}\n`;
        msg += `Target: ${targetNames}\n\n`;
    });

    await sock.sendMessage(fromJid, { text: msg.trim() });
}

async function handleCommand(sock, text, fromJid, rebuildSchedules) {
    let config = loadConfig();
    const parts = text.trim().split(' ');
    const command = parts[0].toLowerCase();
    const isGroup = fromJid.endsWith('@g.us');

    // Wajib verifikasi password jika user biasa mencoba berinteraksi lewat chat pribadi
    if (!isGroup && command === '/daftar') {
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
            await sock.sendMessage(fromJid, { text: 'Berhasil terdaftar. Silakan gunakan perintah yang tersedia.' });
        } else {
            await sock.sendMessage(fromJid, { text: 'Password salah.' });
        }
        return;
    }

    if (!isGroup && !isAuthorized(config, fromJid)) {
        await sock.sendMessage(fromJid, { text: 'Akses terbatas. Silakan daftar terlebih dahulu menggunakan password melalui /daftar <password>.' });
        return;
    }

    const isOwner = fromJid === config.ownerJid;

    if (command === '/list') {
        await handleListCommand(sock, fromJid, config);
    } else if (command === '/tambah') {
        const rest = text.substring('/tambah'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        if (segments.length < 2) {
            await sock.sendMessage(fromJid, { text: 'Format salah. Contoh: /tambah olahraga 06:00 weekday | Yuk olahraga! | group' });
            return;
        }
        const [idAndJam, pesanPart, targetPart] = segments;
        const idJamParts = idAndJam.split(' ');
        const id = idJamParts[0];
        const jamText = idJamParts.slice(1).join(' ');

        if (config.reminders.find(r => r.id === id)) {
            await sock.sendMessage(fromJid, { text: `ID "${id}" sudah digunakan.` });
            return;
        }

        const result = parseWaktuKeCron(jamText);
        if (result.error) {
            await sock.sendMessage(fromJid, { text: result.error });
            return;
        }

        const targets = targetPart ? targetPart.split(',').map(s => s.trim()) : ['group'];
        config.reminders.push({
            id,
            judul: id,
            type: 'recurring',
            scope: isGroup ? 'group' : 'personal',
            cronPattern: result.cronPattern,
            message: pesanPart,
            manualFallback: null,
            jitterSeconds: 15,
            targets,
            mediaPath: null,
            mediaType: null,
            teamTracking: {}
        });
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `Agenda rutin "${id}" berhasil ditambahkan.` });

    } else if (command === '/tambahdeadline') {
        const rest = text.substring('/tambahdeadline'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        if (segments.length < 4) {
            await sock.sendMessage(fromJid, { text: 'Format salah. Contoh: /tambahdeadline meeting | 05-07-2026 18:00 | Meeting | 1hari,2jam | group' });
            return;
        }
        const [id, tanggalStr, judul, milestoneStr, targetPart] = segments;

        if (config.reminders.find(r => r.id === id)) {
            await sock.sendMessage(fromJid, { text: `ID "${id}" sudah digunakan.` });
            return;
        }

        const targetResult = parseTargetDateTime(tanggalStr);
        if (targetResult.error) {
            await sock.sendMessage(fromJid, { text: targetResult.error });
            return;
        }

        const milestoneResult = parseMilestones(milestoneStr);
        if (milestoneResult.error) {
            await sock.sendMessage(fromJid, { text: milestoneResult.error });
            return;
        }

        const targets = targetPart ? targetPart.split(',').map(s => s.trim()) : ['group'];
        config.reminders.push({
            id,
            type: 'deadline',
            scope: isGroup ? 'group' : 'personal',
            targetTimestamp: targetResult.timestamp,
            judul,
            message: `⏰ {sisa} menuju \"{judul}\"!`,
            manualFallback: null,
            nowMessage: `🔔 Sekarang waktunya \"{judul}\"!`,
            nowManualFallback: null,
            milestones: milestoneResult.milestones,
            firedMilestones: [],
            pendingAITexts: {},
            targets,
            mediaPath: null,
            mediaType: null,
            teamTracking: {}
        });
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `Deadline "${id}" berhasil dibuat.` });

    } else if (command === '/editpesan' || command === '/editpesannow') {
        const id = parts[1];
        const rawPesan = text.substring((command + ' ' + id).length).trim();
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `Reminder "${id}" tidak ditemukan.` });
            return;
        }
        const result = parsePesanInput(rawPesan);
        if (result.error) {
            await sock.sendMessage(fromJid, { text: result.error });
            return;
        }
        if (command === '/editpesan') {
            reminder.message = result.message;
            reminder.manualFallback = result.manualFallback;
        } else {
            if (reminder.type !== 'deadline') {
                await sock.sendMessage(fromJid, { text: 'Perintah /editpesannow hanya berlaku untuk tipe deadline.' });
                return;
            }
            reminder.nowMessage = result.message;
            reminder.nowManualFallback = result.manualFallback;
        }
        saveConfig(config);
        await sock.sendMessage(fromJid, { text: `Pesan agenda "${id}" berhasil diperbarui.` });

    } else if (command === '/hapus') {
        const id = parts[1];
        const index = config.reminders.findIndex(r => r.id === id);
        if (index === -1) {
            await sock.sendMessage(fromJid, { text: `Reminder "${id}" tidak ditemukan.` });
            return;
        }
        config.reminders.splice(index, 1);
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `Agenda "${id}" berhasil dihapus.` });
    }
}

module.exports = { handleCommand, resolveTargetsToJids, isAuthorized, handleListCommand };