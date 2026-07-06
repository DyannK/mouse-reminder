const { loadConfig } = require('./configManager');

let currentKeyIndex = 0;

/**
 * Eksekusi panggilan API Gemini dengan sistem proteksi waktu tunggu dan rotasi kunci otomatis.
 */
async function callGeminiWithRotation(prompt) {
    const config = loadConfig();
    const keys = config.geminiApiKeys || [];
    
    if (keys.length === 0) {
        return { error: 'Kunci API Gemini belum diisi di berkas konfigurasi.' };
    }

    const maxAttempts = keys.length;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const activeIndex = (currentKeyIndex + attempt) % keys.length;
        const apiKey = keys[activeIndex];

        if (!apiKey || apiKey.includes('ISI_')) continue;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
                    signal: controller.signal
                }
            );

            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
                currentKeyIndex = activeIndex; // Kunci sukses disimpan sebagai indeks utama
                return { text: text.trim(), status: res.status };
            }
            
            console.error(`Kunci indeks ${activeIndex} gagal memberikan teks respons. Mencoba kunci cadangan berikutnya...`);
        } catch (err) {
            console.error(`Kendala pada kunci indeks ${activeIndex} (${err.message}). Beralih ke kunci cadangan...`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return { error: 'Seluruh kunci akses cadangan Gemini gagal merespons atau kehabisan kuota harian.' };
}

function buildGayaInstruction(formal) {
    return formal
        ? 'Gaya bahasa formal/baku: pakai kapitalisasi standar di awal kalimat, tata bahasa yang benar, sopan.'
        : 'Gaya bahasa santai kayak chat sehari-hari: awal kalimat BOLEH huruf kecil (jangan maksa kapital kayak surat resmi), boleh singkatan wajar.';
}

async function generateAIText(tema, context = {}, styleInstruction = null, manualFallback = null, formal = false) {
    const fallbackText = manualFallback || `📌 ${tema}`;
    
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

    const result = await callGeminiWithRotation(prompt);
    if (result.text) return { text: result.text, usedFallback: false };
    
    return { text: fallbackText, usedFallback: true };
}

async function generateTagReply(triggerText, styleInstruction = null) {
    let prompt = `Kamu adalah asisten reminder di grup WhatsApp. Ada yang nge-tag/mention kamu dengan pesan: "${triggerText}". Balas singkat (maks 2 kalimat), santai, dan nyambung sama konteks pesannya. Boleh emoji secukupnya. Jangan pakai tanda kutip di jawaban.`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;

    const result = await callGeminiWithRotation(prompt);
    return result.text || null;
}

/**
 * Pembedah kalimat kasual untuk mendeteksi apakah pengguna ingin membuat jadwal produktif atau sekadar mengobrol.
 */
async function parseIntentFromText(triggerText) {
    const prompt = `Analisis kalimat dari pengguna berikut untuk menentukan apakah mereka berniat membuat pengingat/jadwal/tenggat waktu baru atau tidak.\n\nKalimat: "${triggerText}"\n\nKembalikan jawaban dalam bentuk JSON mentah utuh TANPA menggunakan format markdown block. Struktur JSON harus memiliki kolom: \n- isReminder (boolean)\n- type ("recurring" atau "deadline" atau null)\n- judul (string atau null)\n- waktu (string format DD-MM-YYYY HH:MM atau HH:MM saja atau null)\n- milestones (string atau null, misal "1hari,2jam")\n- isGroupTask (boolean, true jika ada kata "kita", "kelompok", "tim")\n- replyPasif (string, jika isReminder false, isi dengan kalimat balasan santai untuk menanggapi obrolan mereka).`;
    
    const result = await callGeminiWithRotation(prompt);
    if (!result.text) return { isReminder: false, replyPasif: 'Akses kecerdasan buatan sedang sibuk, coba lagi nanti ya.' };

    try {
        const cleanJson = result.text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (err) {
        console.error('Gagal membedah format JSON intent:', result.text);
        return { isReminder: false, replyPasif: 'Akses pemrosesan pesan mengalami kendala format.' };
    }
}

module.exports = { generateAIText, generateTagReply, parseIntentFromText };