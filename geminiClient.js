const { loadConfig } = require('./configManager');

let currentGeminiIndex = 0;
let currentGroqIndex = 0;

async function callGroq(prompt, config, systemInstruction) {
    const keys = config.groqApiKeys || [];
    const model = 'llama-3.3-70b-versatile';

    if (keys.length === 0) return { error: 'kunci groq kosong' };

    for (let attempt = 0; attempt < keys.length; attempt++) {
        const activeIndex = (currentGroqIndex + attempt) % keys.length;
        const apiKey = keys[activeIndex];

        if (!apiKey || apiKey.includes('ISI_')) continue;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        try {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemInstruction },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.8
                }),
                signal: controller.signal
            });

            const data = await res.json();
            if (!res.ok) continue;

            const text = data?.choices?.[0]?.message?.content;
            if (text) {
                currentGroqIndex = activeIndex;
                return { text: text.trim() };
            }
        } catch (err) {
            console.error(err.message);
        } finally {
            clearTimeout(timeoutId);
        }
    }
    return { text: null };
}

// MESIN EKSTRAKSI LOGIKA (Buta Emosi)
async function parseIntentFromText(triggerText) {
    const system = `analisis kalimat untuk klasifikasi intent. keluarkan format JSON mentah tanpa markdown.
intent bisa berupa: "create_schedule", "read_schedule", "summarize", "chat".
aturan:
1. jika jam/judul tidak ada, fallback ke intent "chat".
2. perintah hapus/edit tidak diizinkan di sini, jatuhkan ke "chat".

format json:
{
  "intent": string,
  "judul": string atau null,
  "waktu": string "HH:MM" atau null,
  "jumlahChat": number (jika intent summarize, tangkap angkanya, default 200)
}`;
    const result = await callGroq(triggerText, loadConfig(), system);
    try {
        return JSON.parse(result.text.replace(/```json|```/gi, '').trim());
    } catch {
        return { intent: 'chat' };
    }
}

// MESIN PENIRU EMOSI (Mimicking)
async function generateMimicReply(triggerText, recentSamples) {
    const system = `lu adalah temen nongkrong di WA.
aturan mutlak:
1. pakai gaya bahasa indonesia kasual banget, pakai gue/lu.
2. PERHATIKAN EMOSI PENGGUNA: kalau dia pakai huruf berulang ("guyyyss", "apaaaa"), huruf kapital untuk ngegas, atau singkatan alay, LU WAJIB NIRU vibe dan energinya persis kayak gitu.
3. pelajari gaya ketikannya dari histori ini: ${recentSamples.join(' | ')}
4. jangan pernah kayak robot, jawab sesingkat dan seasik mungkin.`;
    
    const result = await callGroq(triggerText, loadConfig(), system);
    return result.text || 'waduh, otak gue ngeblank bentar coy.';
}

// MESIN RANGKUMAN
async function summarizeChatLog(logs) {
    const chatText = logs.map(l => `${l.senderName}: ${l.text}`).join('\n');
    const system = `lu adalah perangkum tongkrongan. baca log chat berikut dan rangkum poin pentingnya pakai dots (bullet). bahasanya tetap santai dan asik, pakai kata gue/lu.`;
    const prompt = `rangkumin obrolan ini:\n${chatText}`;
    
    const result = await callGroq(prompt, loadConfig(), system);
    return result.text || 'lagi ga bisa ngerangkum nih, kepanjangan kayaknya.';
}

module.exports = { parseIntentFromText, generateMimicReply, summarizeChatLog };