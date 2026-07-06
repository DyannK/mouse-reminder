const MAX_INTERVAL_EXPANSION = 100; // batas jumlah reminder hasil expand "tiap X" biar gak kebablasan

/**
 * Parse format "DD-MM-YYYY HH:MM" jadi timestamp (ms, UTC-based) yang merepresentasikan
 * waktu tersebut di zona WIB (UTC+7).
 */
function parseTargetDateTime(input) {
    const trimmed = (input || '').trim();
    const match = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!match) {
        return { error: `Format tanggal salah. Harus "DD-MM-YYYY HH:MM", contoh: "05-07-2026 18:00". Kamu ketik: "${trimmed}"` };
    }
    const [, dd, mm, yyyy, hh, min] = match.map(Number);
    const timestamp = Date.UTC(yyyy, mm - 1, dd, hh - 7, min, 0);
    if (isNaN(timestamp)) {
        return { error: `Tanggal/jam gak valid: "${trimmed}"` };
    }
    if (timestamp < Date.now()) {
        return { error: `Tanggal target sudah lewat. Pastikan tanggal/jam-nya di masa depan.` };
    }
    return { timestamp };
}

/**
 * Parse satu token milestone non-interval, misal:
 *   "3hari"        -> kalender, H-3, jam default 08:00 WIB
 *   "3hari@07:00"  -> kalender, H-3, jam 07:00 WIB
 *   "2jam"         -> durasi, 2 jam sebelum waktu target persis
 *   "2jam30menit"  -> durasi, kombinasi unit
 */
function parseSingleMilestoneToken(token) {
    const trimmed = token.trim();

    const kalenderMatch = trimmed.match(/^(\d+)hari(?:@(\d{1,2}):(\d{2}))?$/i);
    if (kalenderMatch) {
        const days = parseInt(kalenderMatch[1], 10);
        const jamStr = kalenderMatch[2] || '08';
        const menitStr = kalenderMatch[3] || '00';
        return {
            type: 'kalender',
            daysBefore: days,
            jam: parseInt(jamStr, 10),
            menit: parseInt(menitStr, 10),
            label: days === 0 ? 'Hari ini' : `H-${days}`
        };
    }

    const durasiRegex = /(\d+)\s*(hari|jam|menit)/gi;
    let totalMinutes = 0;
    let found = false;
    let m;
    const labelParts = [];
    while ((m = durasiRegex.exec(trimmed)) !== null) {
        found = true;
        const value = parseInt(m[1], 10);
        const unit = m[2].toLowerCase();
        if (unit === 'hari') totalMinutes += value * 1440;
        else if (unit === 'jam') totalMinutes += value * 60;
        else if (unit === 'menit') totalMinutes += value;
        labelParts.push(`${value} ${unit}`);
    }

    if (!found) {
        return { error: `Milestone "${trimmed}" gak dikenali. Contoh valid: 3hari, 3hari@07:00, 2jam, 30menit, 2jam30menit, tiap30menit@3jam` };
    }

    return { type: 'durasi', totalMinutes, label: `${labelParts.join(' ')} lagi` };
}

/** Parse durasi tunggal semacam "3jam" atau "30menit" jadi total menit. Dipakai buat parsing token "tiap...@...". */
function parseDurasiKeMenit(str) {
    const m = str.match(/^(\d+)(menit|jam)$/i);
    if (!m) return null;
    const value = parseInt(m[1], 10);
    return m[2].toLowerCase() === 'jam' ? value * 60 : value;
}

/**
 * Parse token interval "tiap<interval>@<mulai>", contoh "tiap30menit@3jam"
 * -> expand jadi beberapa milestone durasi individual: 180,150,120,90,60,30 menit sebelum target.
 * (titik "0"/pas waktu target udah otomatis di-cover milestone "Sekarang" yang selalu ditambahkan.)
 */
function parseIntervalToken(token) {
    const match = token.trim().match(/^tiap(\d+(?:menit|jam))@(\d+(?:menit|jam))$/i);
    if (!match) return null;

    const intervalMinutes = parseDurasiKeMenit(match[1]);
    const startMinutes = parseDurasiKeMenit(match[2]);

    if (!intervalMinutes || intervalMinutes <= 0) {
        return { error: `Interval "${match[1]}" gak valid.` };
    }
    if (!startMinutes || startMinutes <= 0) {
        return { error: `Titik mulai "${match[2]}" gak valid.` };
    }

    const jumlah = Math.floor(startMinutes / intervalMinutes);
    if (jumlah > MAX_INTERVAL_EXPANSION) {
        return { error: `"${token}" bakal jadi ${jumlah} reminder, kebanyakan (maks ${MAX_INTERVAL_EXPANSION}). Perbesar interval atau perkecil titik mulai.` };
    }
    if (jumlah === 0) {
        return { error: `"${token}" gak menghasilkan reminder apapun — titik mulai harus lebih besar dari interval.` };
    }

    const milestones = [];
    for (let t = startMinutes; t >= intervalMinutes; t -= intervalMinutes) {
        const jam = Math.floor(t / 60);
        const menit = t % 60;
        const labelWaktu = jam > 0 ? `${jam} jam${menit > 0 ? ' ' + menit + ' menit' : ''}` : `${menit} menit`;
        milestones.push({ type: 'durasi', totalMinutes: t, label: `${labelWaktu} lagi` });
    }
    return { milestones };
}

/**
 * Parse semua milestone (dipisah koma) jadi array, plus tambah 1 milestone otomatis
 * "tepat di waktu target" (ditandai isAuto: true) yang gak perlu ditulis manual.
 */
function parseMilestones(input) {
    const tokens = input.split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
        return { error: 'Minimal harus ada 1 milestone, contoh: 1hari,2jam' };
    }

    const milestones = [];
    for (const token of tokens) {
        if (/^tiap/i.test(token)) {
            const intervalResult = parseIntervalToken(token);
            if (!intervalResult) {
                return { error: `Format interval "${token}" salah. Contoh: tiap30menit@3jam` };
            }
            if (intervalResult.error) return { error: intervalResult.error };
            milestones.push(...intervalResult.milestones);
        } else {
            const result = parseSingleMilestoneToken(token);
            if (result.error) return { error: result.error };
            milestones.push(result);
        }
    }

    milestones.push({ type: 'durasi', totalMinutes: 0, label: 'Sekarang', isAuto: true });
    return { milestones };
}

/** Hitung timestamp (ms) kapan sebuah milestone harus terpicu, relatif ke targetTimestamp. */
function computeTriggerTimestamp(milestone, targetTimestamp) {
    if (milestone.type === 'durasi') {
        return targetTimestamp - milestone.totalMinutes * 60 * 1000;
    }
    const targetLocal = new Date(targetTimestamp + 7 * 3600 * 1000);
    const Y = targetLocal.getUTCFullYear();
    const M = targetLocal.getUTCMonth();
    const D = targetLocal.getUTCDate();
    return Date.UTC(Y, M, D - milestone.daysBefore, milestone.jam - 7, milestone.menit, 0);
}

/** Key unik untuk 1 milestone, dipakai buat cek apakah sudah pernah dikirim. */
function milestoneKey(milestone) {
    return milestone.type === 'kalender'
        ? `kal-${milestone.daysBefore}-${milestone.jam}-${milestone.menit}`
        : `dur-${milestone.totalMinutes}`;
}

/**
 * Cek milestone mana yang trigger-nya udah lewat waktu sekarang (gak masuk akal dipasang).
 * Milestone isAuto (yang "Sekarang") selalu dianggap valid, gak pernah di-skip.
 * Return { validMilestones, skipped: [label,...] }
 */
function validateMilestonesAgainstTarget(milestones, targetTimestamp) {
    const validMilestones = [];
    const skipped = [];
    const now = Date.now();

    for (const m of milestones) {
        if (m.isAuto) { validMilestones.push(m); continue; }
        const triggerTs = computeTriggerTimestamp(m, targetTimestamp);
        if (triggerTs <= now) {
            skipped.push(m.label);
        } else {
            validMilestones.push(m);
        }
    }
    return { validMilestones, skipped };
}

module.exports = { parseTargetDateTime, parseMilestones, computeTriggerTimestamp, milestoneKey, validateMilestonesAgainstTarget };