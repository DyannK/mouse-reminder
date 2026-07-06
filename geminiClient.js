const { loadConfig } = require('./configManager');

let currentGeminiIndex = 0;
let currentGroqIndex = 0;

async function callGroqFallback(prompt, config) {
    const keys = config.groqApiKeys || [];
    const model = config.groqModel || 'gemma2-9b-it';

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
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { 
                            role: 'system', 
                            content: 'Kamu adalah asisten chat yang sangat santai, friendly, dan asik. Gunakan gaya bahasa kasual seperti obrolan tongkrongan sehari-hari di WhatsApp. Gunakan kata gue dan lu secara natural.' 
                        },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.7
                }),
                signal: controller.signal
            });

            const data = await res.json();

            // Pelacak respons Groq jika status HTTP bukan 200 OK
            if (!res.ok) {
                console.error(`[Log Eror Groq] Indeks ${activeIndex} | Status: ${res.status} | Pesan:`, JSON.stringify(data));
                continue;
            }

            const text = data?.choices?.[0]?.message?.content;
            if (text) {
                currentGroqIndex = activeIndex;
                return { text: text.trim(), provider: 'groq' };
            }
        } catch (err) {
            console.error(`[Kendala Jaringan Groq] Indeks ${activeIndex}: ${err.message}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return { error: 'Seluruh jalur penyelamat Groq gagal merespons.' };
}

async function callAIWithHybridRotation(prompt) {
    const config = loadConfig();
    const geminiKeys = config.geminiApiKeys || [];
    
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

                // Pelacak respons Gemini jika status HTTP bukan 200 OK
                if (!res.ok) {
                    console.error(`[Log Eror Gemini] Indeks ${activeIndex} | Status: ${res.status} | Pesan:`, JSON.stringify(data));
                    continue;
                }

                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                    currentGeminiIndex = activeIndex;
                    return { text: text.trim(), provider: 'gemini' };
                }
            } catch (err) {
                console.error(`[Kendala Jaringan Gemini] Indeks ${activeIndex}: ${err.message}`);
            } finally {
                clearTimeout(timeoutId);
            }
        }
    }

    const groqResult = await callGroqFallback(prompt, config);
    if (groqResult.text) {
        return { text: groqResult.text, provider: 'groq' };
    }

    return { error: groqResult.error };
}

function buildGayaInstruction() {
    return 'Gaya bahasa WAJIB sangat santai, natural, mengalir seperti chat sehari-hari. Gunakan huruf kecil di awal kalimat agar terasa manusiawi, boleh pakai singkatan wajar, gunakan panggilan yang akrab, buang total struktur kaku.';
}

async function generateAIText(tema, context = {}, styleInstruction = null, manualFallback = null, formal = false) {
    const fallbackText = manualFallback || `📌 ${tema}`;
    if (formal) return { text: fallbackText, usedFallback: true };
    
    let prompt = `Tulis 1 kalimat pengingat pendek bertema: "${tema}".`;
    if (context.isNow) prompt += ` Sekarang adalah waktu eksekusi acaranya.`;
    else if (context.sisa) prompt += ` Sisa waktu: ${context.sisa}.`;
    if (context.judul) prompt += ` Judul agenda: "${context.judul}".`;
    prompt += ` ${buildGayaInstruction()}`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;
    prompt += ` Maksimal 2 kalimat pendek, jangan pakai tanda kutip atau format tebal di hasil jawaban.`;

    const result = await callAIWithHybridRotation(prompt);
    if (result.text) return { text: result.text, usedFallback: false };
    
    return { text: fallbackText, usedFallback: true };
}

async function generateTagReply(triggerText, styleInstruction = null) {
    let prompt = `Kamu adalah teman yang asik di grup WhatsApp. Seseorang memanggil lu dengan pesan: "${triggerText}". Balas pendek maksimal 2 kalimat, santai, nyambung, dan gunakan gaya chat tongkrongan. ${buildGayaInstruction()}`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;

    const result = await callAIWithHybridRotation(prompt);
    return result.text || 'oi, ada apa coy?';
}

async function parseIntentFromText(triggerText) {
    const prompt = `Analisis kalimat dari pengguna ini secara ketat untuk mendeteksi pembuatan jadwal.\n\nKalimat: "${triggerText}"\n\nKembalikan jawaban dalam bentuk JSON mentah tanpa format markdown block. Aturan validasi:\n1. Jika pengguna berniat membuat pengingat/jadwal/deadline tetapi tidak menyebutkan waktu secara spesifik atau jamnya tidak jelas, properti isReminder WAJIB diisi false.\n2. Jika judul tidak disebutkan atau tidak bisa ditebak dari konteks kalimat, properti isReminder WAJIB diisi false.\n\nStruktur JSON:\n{\n  "isReminder": boolean,\n  "type": "recurring" atau "deadline" atau null,\n  "judul": string atau null,\n  "waktu": string format "HH:MM" atau "DD-MM-YYYY HH:MM" atau null,\n  "milestones": string atau null,\n  "isGroupTask": boolean,\n  "replyPasif": string\n}`;
    
    const result = await callAIWithHybridRotation(prompt);
    if (!result.text) {
        return { isReminder: false, replyPasif: 'Jalur AI lagi padat nih, coba sebentar lagi ya.' };
    }

    try {
        const cleanJson = result.text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (err) {
        console.error('Gagal mengurai JSON intent:', result.text);
        return { isReminder: false, replyPasif: 'Format kalimat lu agak membingungkan nih, coba diperjelas lagi detailnya.' };
    }
}

module.exports = { generateAIText, generateTagReply, parseIntentFromText };