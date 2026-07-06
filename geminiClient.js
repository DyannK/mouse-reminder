const { loadConfig } = require('./configManager');

/**
 * Generate teks reminder pakai Gemini API berdasarkan tema yang user tulis.
 * context bisa berisi info tambahan seperti sisa waktu / judul (buat deadline reminder).
 * styleInstruction (opsional) dipakai buat niru gaya ketikan orang tertentu.
 *
 * Return { text, usedFallback }. usedFallback = true artinya AI gagal generate
 * dan yang dipakai adalah teks fallback (manual kalau ada, atau default).
 * Fungsi ini JANGAN PERNAH throw — reminder harus tetap terkirim walau AI gagal.
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

async function generateAIText(tema, context = {}, styleInstruction = null, manualFallback = null) {
    const config = loadConfig();
    const apiKey = config.geminiApiKey;
    const fallbackText = manualFallback || `📌 ${tema}`;

    if (!apiKey || apiKey.includes('ISI_')) {
        return { text: `⚠️ [AI belum dikonfigurasi] ${tema}`, usedFallback: true };
    }

    let prompt = `Tulis 1 kalimat pengingat singkat dalam Bahasa Indonesia dengan tema: "${tema}".`;
    if (context.sisa) prompt += ` Info waktu: ${context.sisa}.`;
    if (context.judul) prompt += ` Judul acara/tugas: "${context.judul}".`;
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

module.exports = { generateAIText };