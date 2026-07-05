const DAY_CODE_MAP = { min: 0, sen: 1, sel: 2, rab: 3, kam: 4, jum: 5, sab: 6 };

/**
 * Parse format baku "<HH:MM> [hari]" jadi cron pattern.
 * Contoh input: "07:00", "19:30 weekday", "06:00 sen,rab,jum"
 * Return: { cronPattern } kalau sukses, { error } kalau gagal.
 */
function parseWaktuKeCron(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) {
        return { error: 'Jadwal kosong. Format: "HH:MM" atau "HH:MM <hari>", contoh: "07:00 weekday".' };
    }

    const parts = trimmed.split(/\s+/);
    const jamPart = parts[0];
    const hariPart = parts[1] || 'harian';

    const jamMatch = jamPart.match(/^(\d{1,2}):(\d{2})$/);
    if (!jamMatch) {
        return { error: `Format jam salah. Harus "HH:MM", contoh: "07:00" atau "19:30". Kamu ketik: "${jamPart}"` };
    }

    const hour = parseInt(jamMatch[1], 10);
    const minute = parseInt(jamMatch[2], 10);

    if (hour < 0 || hour > 23) {
        return { error: `Jam harus antara 00-23. Kamu ketik: "${hour}"` };
    }
    if (minute < 0 || minute > 59) {
        return { error: `Menit harus antara 00-59. Kamu ketik: "${minute}"` };
    }

    let dayPart;
    const hariLower = hariPart.toLowerCase();
    if (hariLower === 'harian') {
        dayPart = '*';
    } else if (hariLower === 'weekday') {
        dayPart = '1-5';
    } else if (hariLower === 'weekend') {
        dayPart = '6,0';
    } else {
        const kodeHari = hariLower.split(',').map(s => s.trim());
        const invalid = kodeHari.filter(k => !(k in DAY_CODE_MAP));
        if (invalid.length > 0) {
            return { error: `Kode hari gak dikenali: "${invalid.join(', ')}". Pakai: sen, sel, rab, kam, jum, sab, min, weekday, weekend, atau harian.` };
        }
        dayPart = kodeHari.map(k => DAY_CODE_MAP[k]).join(',');
    }

    const cronPattern = `${minute} ${hour} * * ${dayPart}`;
    return { cronPattern };
}

const REVERSE_DAY_MAP = { 0: 'Minggu', 1: 'Senin', 2: 'Selasa', 3: 'Rabu', 4: 'Kamis', 5: 'Jumat', 6: 'Sabtu' };

/**
 * Kebalikan dari parseWaktuKeCron: ubah cron pattern jadi teks yang mudah dibaca manusia.
 * Contoh: "1 0 * * 1" -> "00:01 (Senin)"
 *         "57 23 * * *" -> "23:57 (tiap hari)"
 */
function formatCronKeTeks(cronPattern) {
    const [minute, hour, , , dow] = cronPattern.split(' ');
    const jamStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

    let hariStr;
    if (dow === '*') {
        hariStr = 'tiap hari';
    } else if (dow === '1-5') {
        hariStr = 'Senin-Jumat';
    } else if (dow === '6,0' || dow === '0,6') {
        hariStr = 'Sabtu-Minggu';
    } else {
        hariStr = dow.split(',').map(d => REVERSE_DAY_MAP[parseInt(d, 10)] || d).join(', ');
    }

    return `${jamStr} (${hariStr})`;
}

module.exports = { parseWaktuKeCron, formatCronKeTeks };