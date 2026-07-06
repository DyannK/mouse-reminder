const { loadConfig } = require('./configManager');

let currentGeminiIndex = 0;
let currentGroqIndex = 0;

/**
 * Memanggil API Groq menggunakan fungsi fetch bawaan dengan standar OpenAI completions.
 */
async function callGroqFallback(prompt, config) {
    const keys = config.groqApiKeys || [];
    const model = config.groqModel || 'llama-3.3-70b-versatile';

    if (keys.length === 0) {
        return { error: 'Kunci akses Groq kosong.' };
    }

    const maxAttempts = keys.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const activeIndex = (currentGroqIndex + attempt) % keys.length;
        const apiKey = keys[activeIndex];

        if (!apiKey || apiKey.includes('ISI_')) continue;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        try {
            console.log(`[Hybrid System] Mengalihkan pencarian teks ke Groq (Indeks Kunci: ${activeIndex})...`);
            
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: prompt }]
                }),
                signal: controller.signal
            });

            const data = await res.json();
            const text = data?.choices?.[0]?.message?.content;

            if (text) {
                currentGroqIndex = activeIndex;
                return { text: text.trim(), provider: 'groq' };
            }
        } catch (err) {
            console.error(`[Groq Error] Kendala pada kunci Groq indeks ${activeIndex}: ${err.message}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return { error: 'Seluruh jalur penyelamat kecerdasan buatan gagal merespons.' };
}

/**
 * Fungsi utama dengan sistem rotasi kunci Gemini dan pengalihan otomatis ke Groq jika terjadi kendala.
 */
async function callAIWithHybridRotation(prompt) {
    const config = loadConfig();
    const geminiKeys = config.geminiApiKeys || [];
    
    // Tahap 1: Coba seluruh baris kunci akses Gemini terlebih dahulu
    if (geminiKeys.length > 0) {
        const maxGeminiAttempts = geminiKeys.length;

        for (let attempt = 0; attempt < maxGeminiAttempts; attempt++) {
            const activeIndex = (currentGeminiIndex + attempt) % geminiKeys.length;
            const apiKey = geminiKeys[activeIndex];

            if (!apiKey || apiKey.includes('ISI_')) continue;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000);

            try {
                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
                    currentGeminiIndex = activeIndex;
                    return { text: text.trim(), provider: 'gemini' };
                }
            } catch (err) {
                console.error(`[Gemini Error] Kendala pada kunci Gemini indeks ${activeIndex}: ${err.message}`);
            } finally {
                clearTimeout(timeoutId);
            }
        }
    }

    // Tahap 2: Jika Gemini habis atau bermasalah, langsung lempar ke Groq
    const groqResult = await callGroqFallback(prompt, config);
    if (groqResult.text) {
        return { text: groqResult.text, provider: 'groq' };
    }

    return { error: groqResult.error };
}

function buildGayaInstruction(formal) {
    return formal
        ? 'Gaya bahasa formal atau baku: pakai kapitalisasi standar di awal kalimat, tata bahasa yang benar, sopan.'
        : 'Gaya bahasa santai seperti obrolan chat sehari-hari: awal kalimat boleh menggunakan huruf kecil, boleh singkatan wajar, tapi hindari kesan kaku.';
}

async function generateAIText(tema, context = {}, styleInstruction = null, manualFallback = null, formal = false) {
    const fallbackText = manualFallback || `📌 ${tema}`;
    
    let prompt = `Tulis 1 kalimat pengingat singkat dalam Bahasa Indonesia dengan tema: "${tema}".`;
    if (context.isNow) {
        prompt += ` PENTING: ini dikirim tepat pada waktunya sekarang, bukan pengingat menjelang — jadi bingkai kalimatnya adalah "sekarang saatnya", bukan "akan datang" atau "menuju".`;
    } else if (context.sisa) {
        prompt += ` Info waktu: ${context.sisa}.`;
    }
    if (context.judul) prompt += ` Judul acara atau tugas: "${context.judul}".`;
    prompt += ` ${buildGayaInstruction(formal)}`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;
    prompt += ` Maksimal 2 kalimat, boleh pakai emoji secukupnya. Jangan sertakan tanda kutip atau backtick pada hasil jawaban jawaban.`;

    const result = await callAIWithHybridRotation(prompt);
    if (result.text) return { text: result.text, usedFallback: false };
    
    return { text: fallbackText, usedFallback: true };
}

async function generateTagReply(triggerText, styleInstruction = null) {
    let prompt = `Kamu adalah asisten pengingat di grup WhatsApp. Ada yang memanggil kamu melalui tag dengan pesan: "${triggerText}". Balas singkat maksimal 2 kalimat, santai, dan nyambung dengan konteks pembicaraannya. Boleh gunakan emoji yang umum. Jangan sertakan tanda kutip pada jawaban.`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;

    const result = await callAIWithHybridRotation(prompt);
    return result.text || null;
}

async function parseIntentFromText(triggerText) {
    const prompt = `Analisis kalimat pengguna berikut untuk mendeteksi apakah mereka bermaksud membuat pengingat atau jadwal baru.\n\nKalimat: "${triggerText}"\n\nKembalikan jawaban eksklusif berupa JSON mentah utuh tanpa menggunakan format markdown block. Struktur objek JSON wajib memiliki properti berikut:\n- isReminder (boolean)\n- type ("recurring" atau "deadline" atau null)\n- judul (string atau null)\n- waktu (string format HH:MM atau DD-MM-YYYY HH:MM atau null)\n- milestones (string atau null, contoh: "1hari,2jam")\n- isGroupTask (boolean, true jika ada kata kita atau kelompok atau tim)\n- replyPasif (string, jika isReminder false, isi dengan kalimat balasan santai dan adaptif untuk menanggapi obrolan mereka).`;
    
    const result = await callAIWithHybridRotation(prompt);
    if (!result.text) {
        return { isReminder: false, replyPasif: 'Jalur pemrosesan kecerdasan buatan sedang penuh, coba sesaat lagi ya.' };
    }

    try {
        const cleanJson = result.text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (err) {
        console.error('Gagal mengurai JSON intent:', result.text);
        return { isReminder: false, replyPasif: 'Gagal memproses format teks perintah.' };
    }
}

module.exports = { generateAIText, generateTagReply, parseIntentFromText };