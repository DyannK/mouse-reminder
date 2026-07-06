const { loadConfig, saveConfigDebounced } = require('./configManager');

const MAX_SAMPLES = 30;
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/** Simpan 1 sample pesan dari seseorang (dipanggil pasif tiap ada pesan teks biasa masuk). */
function recordSample(jid, text) {
    if (!text || text.trim().length < 3) return; // skip pesan kependekan, gak representatif
    const config = loadConfig();
    if (!config.styleProfiles) config.styleProfiles = {};
    if (!config.styleProfiles[jid]) config.styleProfiles[jid] = { samples: [], manualDescription: '' };

    config.styleProfiles[jid].samples.push(text);
    if (config.styleProfiles[jid].samples.length > MAX_SAMPLES) {
        config.styleProfiles[jid].samples.shift(); // buang yang paling lama, biar tetap "gaya terkini"
    }
    // Menggunakan penyimpanan berkala agar tidak membebani performa prosesor saat grup ramai
    saveConfigDebounced(config);
}

/** Set deskripsi gaya manual (seed awal), lewat command /gayaketik. */
function setManualStyle(jid, description) {
    const config = loadConfig();
    if (!config.styleProfiles) config.styleProfiles = {};
    if (!config.styleProfiles[jid]) config.styleProfiles[jid] = { samples: [], manualDescription: '' };
    config.styleProfiles[jid].manualDescription = description;
    saveConfig(config);
}

/** Ekstrak heuristik sederhana dari kumpulan sample: rasio CAPSLOCK, emoji favorit, panjang rata-rata. */
function extractHeuristics(samples) {
    if (samples.length === 0) return null;

    let totalLetters = 0, totalCaps = 0, totalWords = 0;
    const emojiCount = {};

    samples.forEach(s => {
        const letters = s.replace(/[^a-zA-Z]/g, '');
        totalLetters += letters.length;
        totalCaps += (letters.match(/[A-Z]/g) || []).length;
        totalWords += s.trim().split(/\s+/).length;

        const emojis = s.match(EMOJI_REGEX) || [];
        emojis.forEach(e => { emojiCount[e] = (emojiCount[e] || 0) + 1; });
    });

    const capsRatio = totalLetters > 0 ? totalCaps / totalLetters : 0;
    const avgWords = totalWords / samples.length;
    const topEmojis = Object.entries(emojiCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e]) => e);

    return { capsRatio, avgWords, topEmojis };
}

/**
 * Bangun instruksi gaya (dalam bentuk teks) buat disisipkan ke prompt Gemini.
 * Gabungan dari deskripsi manual (/gayaketik) + hasil pengamatan pasif dari histori chat.
 * Return null kalau belum ada data sama sekali.
 */
function buildStyleInstruction(jid) {
    const config = loadConfig();
    const profile = config.styleProfiles?.[jid];
    if (!profile) return null;

    const parts = [];
    if (profile.manualDescription) {
        parts.push(profile.manualDescription);
    }

    const heuristics = extractHeuristics(profile.samples || []);
    if (heuristics) {
        if (heuristics.capsRatio > 0.3) parts.push('sering pakai HURUF KAPITAL buat nekenin sesuatu');
        if (heuristics.avgWords < 6) parts.push('gaya ngetik pendek-pendek, gak bertele-tele');
        else if (heuristics.avgWords > 15) parts.push('gaya ngetik agak panjang dan detail');
        if (heuristics.topEmojis.length > 0) parts.push(`suka pakai emoji seperti ${heuristics.topEmojis.join(' ')}`);
    }

    if (parts.length === 0) return null;
    return `Tulis dengan gaya mirip orang ini: ${parts.join('; ')}.`;
}

/** Cari JID/key berdasarkan nama target ("aku"/"owner" = owner sendiri, "bot" = persona bot, atau nama kontak). */
function resolveJidForName(config, name) {
    const clean = name.trim().toLowerCase();
    if (clean === 'aku' || clean === 'saya' || clean === 'owner') return config.ownerJid;
    if (clean === 'bot') return '__bot__'; // bukan JID asli, cuma key internal buat persona bot
    const contact = config.contacts.find(c => c.name.toLowerCase() === clean);
    return contact ? contact.jid : null;
}

module.exports = { recordSample, setManualStyle, buildStyleInstruction, resolveJidForName };