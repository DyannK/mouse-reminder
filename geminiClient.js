const { loadConfig } = require('./configManager');

/**
 * Generate teks reminder pakai Gemini API berdasarkan tema yang user tulis.
 * context bisa berisi info tambahan seperti sisa waktu / judul (buat deadline reminder).
 * Kalau gagal (API error, quota habis, dll), return fallback text simpel — JANGAN pernah throw,
 * karena reminder harus tetap terkirim walau AI-nya gagal.
 */
async function generateAIText(tema, context = {}) {
    const config = loadConfig();
    const apiKey = config.geminiApiKey;

    if (!apiKey || apiKey.includes('ISI_')) {
        return `⚠️ [AI belum dikonfigurasi] ${tema}`;
    }

    let prompt = `Tulis 1 kalimat pengingat singkat dalam Bahasa Indonesia dengan tema: "${tema}".`;
    if (context.sisa) prompt += ` Info waktu: ${context.sisa}.`;
    if (context.judul) prompt += ` Judul acara/tugas: "${context.judul}".`;
    prompt += ` Gaya santai dan asik, maksimal 2 kalimat, boleh pakai emoji secukupnya. Jangan pakai tanda kutip di jawaban.`;

    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            }
        );
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            console.error('Gemini response gak ada teks:', JSON.stringify(data));
            return `📌 ${tema}`; // fallback aman
        }
        return text.trim();
    } catch (err) {
        console.error('Gagal generate teks AI:', err);
        return `📌 ${tema}`; // fallback aman, reminder tetap jalan walau AI gagal
    }
}

module.exports = { generateAIText };