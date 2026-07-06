const { loadConfig } = require('./configManager');

/**
 * Generate teks reminder pakai Gemini API.
 * context: { sisa, judul, isNow } - isNow=true artinya ini pesan yang dikirim TEPAT PAS
 *          waktunya (bukan pengingat sebelumnya), pengaruh ke framing kalimat.
 * styleInstruction: hasil dari styleProfiler.buildStyleInstruction (boleh null).
 * formal: true/false - kalau true pakai kapitalisasi & bahasa baku, kalau false santai/lowercase.
 * manualFallback: teks fallback wajib kalau tema di-generate lewat AI, dipakai kalau gagal.
 *
 * Return { text, usedFallback }. Fungsi ini JANGAN PERNAH throw.
 */
async function callGemini(prompt, apiKey) {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
    );
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return { text, raw: data, status: res.status };
}

function buildGayaInstruction(formal) {
    return formal
        ? 'Gaya bahasa formal/baku: pakai kapitalisasi standar di awal kalimat, tata bahasa yang benar, sopan.'
        : 'Gaya bahasa santai kayak chat sehari-hari: awal kalimat BOLEH huruf kecil (jangan maksa kapital kayak surat resmi), boleh singkatan wajar.';
}

async function generateAIText(tema, context = {}, styleInstruction = null, manualFallback = null, formal = false) {
    const config = loadConfig();
    const apiKey = config.geminiApiKey;
    const fallbackText = manualFallback || `📌 ${tema}`;

    if (!apiKey || apiKey.includes('ISI_')) {
        return { text: `⚠️ [AI belum dikonfigurasi] ${tema}`, usedFallback: true };
    }

    let prompt = `Tulis 1 kalimat pengingat singkat dalam Bahasa Indonesia dengan tema: "${tema}".`;
    if (context.isNow) {
        prompt += ` PENTING: ini dikirim TEPAT PAS waktunya sekarang (eksekusi), BUKAN pengingat menjelang — jadi framing-nya "sekarang saatnya", bukan "akan datang" atau "menuju".`;
    } else if (context.sisa) {
        prompt += ` Info waktu: ${context.sisa}.`;
    }
    if (context.judul) prompt += ` Judul acara/tugas: "${context.judul}".`;
    prompt += ` ${buildGayaInstruction(formal)}`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;
    prompt += ` Maksimal 2 kalimat, boleh pakai emoji secukupnya. Jangan pakai tanda kutip di jawaban.`;

    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const { text, raw, status } = await callGemini(prompt, apiKey);
            if (text) return { text: text.trim(), usedFallback: false };

            console.error(`Gemini gagal (percobaan ${attempt}/${MAX_ATTEMPTS}), status ${status}:`, JSON.stringify(raw));
            if (status === 503 && attempt < MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            return { text: fallbackText, usedFallback: true };
        } catch (err) {
            console.error(`Gagal generate teks AI (percobaan ${attempt}/${MAX_ATTEMPTS}):`, err);
            if (attempt < MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            return { text: fallbackText, usedFallback: true };
        }
    }
}

/** Generate balasan kontekstual singkat waktu bot di-tag di grup (fitur "chat mode"). */
async function generateTagReply(triggerText, styleInstruction = null) {
    const config = loadConfig();
    const apiKey = config.geminiApiKey;
    if (!apiKey || apiKey.includes('ISI_')) return null; // diam aja kalau AI belum dikonfigurasi

    let prompt = `Kamu adalah asisten reminder di grup WhatsApp. Ada yang nge-tag/mention kamu dengan pesan: "${triggerText}". Balas singkat (maks 2 kalimat), santai, dan nyambung sama konteks pesannya. Boleh emoji secukupnya. Jangan pakai tanda kutip di jawaban.`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;

    try {
        const { text } = await callGemini(prompt, apiKey);
        return text ? text.trim() : null;
    } catch (err) {
        console.error('Gagal generate balasan tag:', err);
        return null;
    }
}

module.exports = { generateAIText, generateTagReply };