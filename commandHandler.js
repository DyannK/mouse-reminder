const { loadConfig, saveConfig } = require('./configManager');
const { parseWaktuKeCron, formatCronKeTeks } = require('./timeParser');
const { parseTargetDateTime, parseMilestones } = require('./deadlineParser');

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
    if (!trimmed) return { error: 'pesan gak boleh kosong.' };

    if (trimmed.toUpperCase().startsWith('AI:')) {
        const afterPrefix = trimmed.substring(3).trim();
        const parts = afterPrefix.split('|').map(s => s.trim());
        if (parts.length < 2 || !parts[0] || !parts[1]) {
            return { error: 'kalau pakai mesin dinamis wajib sertakan tema dan teks cadangan manual.\nformat: AI: <tema> | <teks cadangan>' };
        }
        return { message: `AI:${parts[0]}`, manualFallback: parts[1] };
    }
    return { message: trimmed, manualFallback: null };
}

async function handleListCommand(sock, fromJid, config) {
    const isGroup = fromJid.endsWith('@g.us');
    let visibleReminders = config.reminders || [];

    if (isGroup) {
        visibleReminders = visibleReminders.filter(r => r.scope === 'group');
    } else {
        if (fromJid !== config.ownerJid) {
            visibleReminders = visibleReminders.filter(r => r.scope === 'group' || (r.targets && r.targets.includes(fromJid)));
        }
    }

    if (visibleReminders.length === 0) {
        await sock.sendMessage(fromJid, { text: 'belum ada jadwal atau agenda yang tercatat saat ini.' });
        return;
    }

    let msg = 'nih coy jadwalnya:\n\n';
    visibleReminders.forEach(r => {
        let waktuStr = '';
        if (r.type === 'deadline') {
            const tanggalTarget = new Date(r.targetTimestamp);
            waktuStr = `${String(tanggalTarget.getDate()).padStart(2, '0')}-${String(tanggalTarget.getMonth() + 1).padStart(2, '0')}-${tanggalTarget.getFullYear()} | jam ${String(tanggalTarget.getHours()).padStart(2, '0')}:${String(tanggalTarget.getMinutes()).padStart(2, '0')} WIB`;
        } else {
            waktuStr = formatCronKeTeks(r.cronPattern);
        }

        const targetNames = (r.targets || []).map(t => {
            if (t === 'group') return 'GROUP';
            const contact = config.contacts.find(c => c.name.toLowerCase() === t.toLowerCase());
            return contact ? `PERSONAL (${contact.name})` : 'PERSONAL';
        }).join(', ');

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

    if (!isGroup && command === '/daftar') {
        const inputPassword = parts[1];
        if (!inputPassword) {
            await sock.sendMessage(fromJid, { text: 'format: /daftar <password>' });
            return;
        }
        if (inputPassword === config.password) {
            if (!config.authorizedUsers.includes(fromJid) && fromJid !== config.ownerJid) {
                config.authorizedUsers.push(fromJid);
                saveConfig(config);
            }
            await sock.sendMessage(fromJid, { text: 'berhasil terdaftar. silakan gunakan perintah yang tersedia.' });
        } else {
            await sock.sendMessage(fromJid, { text: 'password salah.' });
        }
        return;
    }

    if (!isGroup && !isAuthorized(config, fromJid)) {
        await sock.sendMessage(fromJid, { text: 'akses terbatas. silakan daftar dulu.' });
        return;
    }

    if (command === '/help') {
        const menuBantuan = `*Daftar Perintah Manual:*\n\n` +
                            `• /list - lihat jadwal aktif\n` +
                            `• /tambah <id> <jam> <hari> | <pesan> | <target> - nambah pengingat rutin\n` +
                            `• /tambahdeadline <id> | <tanggal> | <judul> | <milestones> | <target> - nambah batas waktu\n` +
                            `• /editpesan <id> <pesan baru> - ubah teks pengingat\n` +
                            `• /editpesannow <id> <pesan baru> - ubah teks pas hari H\n` +
                            `• /hapus <id> - hapus jadwal\n\n` +
                            `*Fitur Otomatis:*\n` +
                            `chat biasa atau tag gue di grup buat bikin jadwal otomatis.`;
        await sock.sendMessage(fromJid, { text: menuBantuan });
    } else if (command === '/list') {
        await handleListCommand(sock, fromJid, config);
    } else if (command === '/tambah') {
        const rest = text.substring('/tambah'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        if (segments.length < 2) {
            await sock.sendMessage(fromJid, { text: 'format salah. contoh: /tambah mabar 20:00 | ayo login | group' });
            return;
        }
        const [idAndJam, pesanPart, targetPart] = segments;
        const idJamParts = idAndJam.split(' ');
        const id = idJamParts[0];
        const jamText = idJamParts.slice(1).join(' ');

        if (config.reminders.find(r => r.id === id)) {
            await sock.sendMessage(fromJid, { text: `id ${id} udah dipake.` });
            return;
        }

        const result = parseWaktuKeCron(jamText);
        if (result.error) {
            await sock.sendMessage(fromJid, { text: result.error });
            return;
        }

        const targets = targetPart ? targetPart.split(',').map(s => s.trim()) : ['group'];
        config.reminders.push({
            id, judul: id, type: 'recurring', scope: isGroup ? 'group' : 'personal',
            cronPattern: result.cronPattern, message: pesanPart, manualFallback: null,
            jitterSeconds: 15, targets, mediaPath: null, mediaType: null, teamTracking: {}
        });
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `agenda ${id} berhasil ditambah.` });

    } else if (command === '/tambahdeadline') {
        const rest = text.substring('/tambahdeadline'.length).trim();
        const segments = rest.split('|').map(s => s.trim());
        if (segments.length < 4) {
            await sock.sendMessage(fromJid, { text: 'format salah. contoh: /tambahdeadline tugas | 05-07-2026 18:00 | nugas | 1hari,2jam | group' });
            return;
        }
        const [id, tanggalStr, judul, milestoneStr, targetPart] = segments;

        if (config.reminders.find(r => r.id === id)) {
            await sock.sendMessage(fromJid, { text: `id ${id} udah dipake.` });
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
            id, type: 'deadline', scope: isGroup ? 'group' : 'personal', targetTimestamp: targetResult.timestamp,
            judul, message: `⏰ {sisa} menuju {judul}!`, manualFallback: null, nowMessage: `🔔 waktunya {judul}!`,
            nowManualFallback: null, milestones: milestoneResult.milestones, firedMilestones: [], pendingAITexts: {},
            targets, mediaPath: null, mediaType: null, teamTracking: {}
        });
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `deadline ${id} berhasil dibikin.` });

    } else if (command === '/editpesan' || command === '/editpesannow') {
        const id = parts[1];
        if (!id) {
            await sock.sendMessage(fromJid, { text: 'id nya mana cuy.' });
            return;
        }
        const rawPesan = text.substring((command + ' ' + id).length).trim();
        const reminder = config.reminders.find(r => r.id === id);
        if (!reminder) {
            await sock.sendMessage(fromJid, { text: `agenda ${id} gak ketemu.` });
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
                await sock.sendMessage(fromJid, { text: '/editpesannow cuma buat tipe deadline.' });
                return;
            }
            reminder.nowMessage = result.message;
            reminder.nowManualFallback = result.manualFallback;
        }
        saveConfig(config);
        await sock.sendMessage(fromJid, { text: `pesan agenda ${id} udah diupdate.` });

    } else if (command === '/hapus') {
        const id = parts[1];
        if (!id) {
            await sock.sendMessage(fromJid, { text: 'kasih id yang mau dihapus.' });
            return;
        }
        const index = config.reminders.findIndex(r => r.id === id);
        if (index === -1) {
            await sock.sendMessage(fromJid, { text: `agenda ${id} gak ketemu.` });
            return;
        }
        config.reminders.splice(index, 1);
        saveConfig(config);
        rebuildSchedules();
        await sock.sendMessage(fromJid, { text: `agenda ${id} berhasil dihapus.` });
    } else {
        await sock.sendMessage(fromJid, { text: `perintah ${command} gak ada. ketik /help buat liat daftar.` });
    }
}

module.exports = { handleCommand, resolveTargetsToJids, isAuthorized, handleListCommand };