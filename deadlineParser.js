/**
 * Parse format "DD-MM-YYYY HH:MM" jadi timestamp (ms, UTC-based)
 * yang merepresentasikan waktu tersebut di zona WIB (UTC+7).
 */
function parseTargetDateTime(input) {
    const trimmed = (input || '').trim();
    const match = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!match) {
        return { error: `Format tanggal salah. Harus "DD-MM-YYYY HH:MM", contoh: "05-07-2026 18:00". Kamu ketik: "${trimmed}"` };
    }
    const [, dd, mm, yyyy, hh, min] = match.map(Number);
    // Date.UTC dengan jam dikurangi 7, supaya hasilnya representasi UTC yang benar dari waktu WIB.
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
 * Parse satu token milestone, misal:
 *   "3hari"        -> kalender, H-3, jam default 08:00 WIB
 *   "3hari@07:00"  -> kalender, H-3, jam 07:00 WIB
 *   "2jam"         -> durasi, 2 jam sebelum waktu target persis
 *   "30menit"      -> durasi, 30 menit sebelum waktu target persis
 *   "2jam30menit"  -> durasi, 2.5 jam sebelum waktu target persis (kombinasi unit)
 */
function parseMilestoneToken(token) {
    const trimmed = token.trim();

    // --- Kasus kalender: cuma "Nhari" atau "Nhari@HH:MM" ---
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

    // --- Kasus durasi: kombinasi hari/jam/menit, dijumlah jadi total menit ---
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
        return { error: `Milestone "${trimmed}" gak dikenali. Contoh valid: 3hari, 3hari@07:00, 2jam, 30menit, 2jam30menit` };
    }

    return {
        type: 'durasi',
        totalMinutes,
        label: `${labelParts.join(' ')} lagi`
    };
}

/**
 * Parse semua milestone (dipisah koma) jadi array, plus tambah 1 milestone otomatis
 * "tepat di waktu target" yang gak perlu ditulis manual.
 */
function parseMilestones(input) {
    const tokens = input.split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
        return { error: 'Minimal harus ada 1 milestone, contoh: 1hari,2jam' };
    }
    const milestones = [];
    for (const token of tokens) {
        const result = parseMilestoneToken(token);
        if (result.error) return { error: result.error };
        milestones.push(result);
    }
    // tambahkan otomatis: reminder tepat di waktu target
    milestones.push({ type: 'durasi', totalMinutes: 0, label: 'Sekarang' });
    return { milestones };
}

/**
 * Hitung timestamp (ms) kapan sebuah milestone harus terpicu, relatif ke targetTimestamp.
 */
function computeTriggerTimestamp(milestone, targetTimestamp) {
    if (milestone.type === 'durasi') {
        return targetTimestamp - milestone.totalMinutes * 60 * 1000;
    }
    // type 'kalender': cari tanggal (di WIB) milestone.daysBefore hari sebelum tanggal target,
    // pada jam yang ditentukan.
    const targetLocal = new Date(targetTimestamp + 7 * 3600 * 1000); // geser ke "waktu WIB" sbg UTC semu
    const Y = targetLocal.getUTCFullYear();
    const M = targetLocal.getUTCMonth();
    const D = targetLocal.getUTCDate();
    // jam WIB -> UTC dengan kurangi 7
    return Date.UTC(Y, M, D - milestone.daysBefore, milestone.jam - 7, milestone.menit, 0);
}

/** Key unik untuk 1 milestone, dipakai buat cek apakah sudah pernah dikirim. */
function milestoneKey(milestone) {
    return milestone.type === 'kalender'
        ? `kal-${milestone.daysBefore}-${milestone.jam}-${milestone.menit}`
        : `dur-${milestone.totalMinutes}`;
}

module.exports = { parseTargetDateTime, parseMilestones, computeTriggerTimestamp, milestoneKey };