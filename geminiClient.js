const { loadConfig } = require('./configManager');

let currentGeminiIndex = 0;
let currentGroqIndex = 0;

async function callGroqFallback(prompt, config) {
    const keys = config.groqApiKeys || [];
    const model = 'llama-3.3-70b-versatile';

    if (keys.length === 0) return { error: 'kunci akses groq kosong.' };

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
                            content: `lu adalah temen tongkrongan di grup whatsapp. 
aturan wajib mutlak:
1. gunakan bahasa indonesia kasual tongkrongan, pakai kata gue dan lu.
2. wajib gunakan huruf kecil di awal kalimat dan di mana pun, jangan pakai huruf kapital sama sekali biar keliatan kayak ngetik santai.
3. dilarang keras membalas seperti robot, asisten, atau admin olshop.
4. kalau nolak atau ga ngerti, jawab santai aja.

contoh balasan yang bener:
- oi coy, jadwal lu udah gue amanin nih.
- buset, jamnya ga jelas nih, perjelas lagi dong.
- siap, nanti gue ingetin.` 
                        },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.8
                }),
                signal: controller.signal
            });

            const data = await res.json();

            if (!res.ok) {
                console.error(`[log eror groq] indeks ${activeIndex} | status: ${res.status}`);
                continue;
            }

            const text = data?.choices?.[0]?.message?.content;
            if (text) {
                currentGroqIndex = activeIndex;
                return { text: text.trim().toLowerCase(), provider: 'groq' };
            }
        } catch (err) {
            console.error(`[kendala jaringan groq] indeks ${activeIndex}: ${err.message}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return { error: 'seluruh jalur groq gagal merespons.' };
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

                if (!res.ok) {
                    console.error(`[log eror gemini] indeks ${activeIndex} | status: ${res.status}`);
                    continue;
                }

                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                    currentGeminiIndex = activeIndex;
                    return { text: text.trim().toLowerCase(), provider: 'gemini' };
                }
            } catch (err) {
                console.error(`[kendala jaringan gemini] indeks ${activeIndex}: ${err.message}`);
            } finally {
                clearTimeout(timeoutId);
            }
        }
    }

    const groqResult = await callGroqFallback(prompt, config);
    if (groqResult.text) return { text: groqResult.text, provider: 'groq' };

    return { error: groqResult.error };
}

function buildGayaInstruction() {
    return 'gaya bahasa wajib sangat santai, natural, mengalir seperti chat sehari-hari. gunakan huruf kecil di awal kalimat agar terasa manusiawi, boleh pakai singkatan wajar, gunakan panggilan yang akrab, buang total struktur kaku.';
}

async function generateAIText(tema, context = {}, styleInstruction = null, manualFallback = null, formal = false) {
    const fallbackText = manualFallback || `📌 ${tema}`;
    if (formal) return { text: fallbackText, usedFallback: true };
    
    let prompt = `tulis 1 kalimat pengingat pendek bertema: ${tema}.`;
    if (context.isNow) prompt += ` sekarang adalah waktu eksekusi acaranya.`;
    else if (context.sisa) prompt += ` sisa waktu: ${context.sisa}.`;
    if (context.judul) prompt += ` judul agenda: ${context.judul}.`;
    prompt += ` ${buildGayaInstruction()}`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;
    prompt += ` maksimal 2 kalimat pendek.`;

    const result = await callAIWithHybridRotation(prompt);
    if (result.text) return { text: result.text, usedFallback: false };
    
    return { text: fallbackText, usedFallback: true };
}

async function generateTagReply(triggerText, styleInstruction = null) {
    let prompt = `lu adalah teman yang asik di grup whatsapp. seseorang memanggil lu dengan pesan: ${triggerText}. balas pendek maksimal 2 kalimat, santai, nyambung, dan gunakan gaya chat tongkrongan. ${buildGayaInstruction()}`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;

    const result = await callAIWithHybridRotation(prompt);
    return result.text || 'oi, ada apa coy?';
}

async function parseIntentFromText(triggerText) {
    const prompt = `analisis kalimat dari pengguna ini untuk mendeteksi pembuatan jadwal.
kalimat: ${triggerText}

kembalikan jawaban dalam bentuk json mentah.
aturan validasi:
1. jika jam tidak ada atau tidak jelas, isReminder wajib false.
2. jika judul acara tidak jelas, isReminder wajib false.

struktur json:
{
  "isReminder": boolean,
  "type": "deadline",
  "judul": string atau null,
  "waktu": string format "HH:MM" atau null,
  "milestones": "1hari,2jam",
  "isGroupTask": boolean,
  "replyPasif": string
}`;
    
    const result = await callAIWithHybridRotation(prompt);
    if (!result.text) return { isReminder: false, replyPasif: 'jalur ai lagi padat nih coy, coba bentar lagi ya.' };

    try {
        const cleanJson = result.text.replace(/```json|```/gi, '').trim();
        return JSON.parse(cleanJson);
    } catch (err) {
        console.error('gagal mengurai json intent:', result.text);
        return { isReminder: false, replyPasif: 'kalimat lu agak belibet nih, mending pake perintah manual aja coy.' };
    }
}

module.exports = { generateAIText, generateTagReply, parseIntentFromText };