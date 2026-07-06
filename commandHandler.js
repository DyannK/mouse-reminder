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
            return 'PERSONAL';
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

    if (!isGroup && !isAuthorized(config, fromJid) && command !== '/daftar') {
        await sock.sendMessage(fromJid, { text: 'Akses terbatas. Silakan hubungi owner.' });
        return;
    }

    if (command === '/list') {
        await handleListCommand(sock, fromJid, config);
    } else if (command === '/help') {
        const bantuan = `*Panduan Perintah Manual Bot:*\n\n` +
                        `• \`/list\` - Melihat seluruh daftar agenda aktif.\n` +
                        `• \`/tambah <id> <jam> | <pesan>\` - Menambah agenda berkala harian.\n` +
                        `• \`/hapus <id>\` - Menghapus agenda dari memori.\n\n` +
                        `*Fitur Kasual:*\n` +
                        `Kamu bisa langsung mengetik pesan biasa tanpa garis miring untuk membuat jadwal otomatis secara praktis lewat bantuan kecerdasan buatan.`;
        await sock.sendMessage(fromJid, { text: bantuan });
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