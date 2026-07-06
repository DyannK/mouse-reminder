const { loadConfig } = require('./configManager');

let currentGeminiIndex = 0;
let currentGroqIndex = 0;

async function callAIWithHybridRotation(prompt, isJson = false, systemInstruction = null) {
    const config = loadConfig();
    const geminiKeys = config.geminiApiKeys || [];
    
    if (geminiKeys.length > 0) {
        for (let attempt = 0; attempt < geminiKeys.length; attempt++) {
            const activeIndex = (currentGeminiIndex + attempt) % geminiKeys.length;
            const apiKey = geminiKeys[activeIndex];
            if (!apiKey || apiKey.includes('ISI_')) continue;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            try {
                let fullPrompt = prompt;
                if (systemInstruction) {
                    fullPrompt = `${systemInstruction}\n\n${prompt}`;
                }
                if (isJson) {
                    fullPrompt += `\n\nReturn ONLY a valid JSON object. No markdown formatting, no code blocks, no prose.`;
                }

                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }] }),
                        signal: controller.signal
                    }
                );

                const data = await res.json();
                if (!res.ok) continue;

                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                    currentGeminiIndex = activeIndex;
                    return { text: text.trim() };
                }
            } catch (err) {
                console.error(`[gemini]`, err.message);
            } finally {
                clearTimeout(timeoutId);
            }
        }
    }

    const groqKeys = config.groqApiKeys || [];
    const model = 'llama-3.3-70b-versatile';
    if (groqKeys.length > 0) {
        for (let attempt = 0; attempt < groqKeys.length; attempt++) {
            const activeIndex = (currentGroqIndex + attempt) % groqKeys.length;
            const apiKey = groqKeys[activeIndex];
            if (!apiKey || apiKey.includes('ISI_')) continue;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            try {
                const body = {
                    model: model,
                    messages: [
                        { role: 'system', content: systemInstruction || 'lu adalah asisten chat santai.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: isJson ? 0.1 : 0.8
                };
                if (isJson) {
                    body.response_format = { type: 'json_object' };
                }

                const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
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
                console.error(`[groq]`, err.message);
            } finally {
                clearTimeout(timeoutId);
            }
        }
    }

    return { text: null };
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
    
    const result = await callAIWithHybridRotation(prompt, false, buildGayaInstruction());
    if (result.text) return { text: result.text, usedFallback: false };
    
    return { text: fallbackText, usedFallback: true };
}

async function generateTagReply(triggerText, styleInstruction = null) {
    let prompt = `lu adalah teman yang asik di grup whatsapp. seseorang memanggil lu dengan pesan: ${triggerText}. balas pendek maksimal 2 kalimat, santai, nyambung, dan gunakan gaya chat tongkrongan.`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;

    const result = await callAIWithHybridRotation(prompt, false, buildGayaInstruction());
    return result.text || 'oi, ada apa coy?';
}

async function parseIntentFromText(triggerText) {
    const lowText = triggerText.toLowerCase();

    // 1. PRAFILTER BACA JADWAL (100 Persen Akurat Tanpa AI)
    const readKeywords = ['lihat', 'liat', 'cek', 'tampilkan', 'tampilin', 'list', 'info', 'ada apa aja', 'gimana aja'];
    const scheduleKeywords = ['jadwal', 'agenda', 'deadline', 'ingetan', 'listnya'];
    
    const hasReadKw = readKeywords.some(kw => lowText.includes(kw));
    const hasSchedKw = scheduleKeywords.some(kw => lowText.includes(kw));

    if ((hasReadKw && hasSchedKw) || lowText === 'coba liat jadwal' || lowText.includes('gimana aja listnya')) {
        return { intent: 'read_schedule', judul: null, waktu: null, jumlahChat: 200 };
    }

    // 2. PRAFILTER RANGKUMAN (100 Persen Akurat Tanpa AI)
    if (lowText.includes('rangkum') || lowText.includes('rangkumin') || lowText.includes('summary')) {
        const match = lowText.match(/\d+/);
        const jumlahChat = match ? parseInt(match[0], 10) : 200;
        return { intent: 'summarize', judul: null, waktu: null, jumlahChat };
    }

    // 3. JALUR UTAMA PEMBACA NIAT BERSAMA PEMAKSAAN PROMPT
    let system = `lu adalah mesin pembaca niat khusus bahasa indonesia. analisa kalimat dan kembalikan JSON murni.
pilihan intent:
1. "create_schedule": jika pengguna ingin membuat jadwal/reminder/deadline DAN menyebutkan jam serta judul agenda secara eksplisit.
2. "chat": jika hanya mengobrol biasa atau menyapa.

aturan ketat: jika judul atau jam tidak ada atau kurang jelas, wajib gunakan intent "chat". format waktu wajib "HH:MM".

format output json murni:
{
  "intent": "create_schedule" | "chat",
  "judul": "string atau null",
  "waktu": "string format HH:MM atau null",
  "jumlahChat": 200
}`;

    const createKeywords = ['bikin', 'buat', 'ingetin', 'set', 'tambah', 'remind', 'buatkan', 'buatin', 'creating'];
    const hasCreateKw = createKeywords.some(kw => lowText.includes(kw));

    if (hasCreateKw || lowText.includes(':')) {
        system += `\n\nPERINGATAN UTAMA: Teks pengguna ini mengandung kata kunci pembuatan atau format waktu jam digital. Kamu harus memprioritaskan klasifikasi ke arah "create_schedule" jika ada nama aktivitas dan waktu eksekusi yang bisa diisolasi.`;
    }
    
    const result = await callAIWithHybridRotation(triggerText, true, system);
    if (!result.text) return { intent: 'chat' };
    
    try {
        return JSON.parse(result.text.replace(/```json|```/gi, '').trim());
    } catch (err) {
        console.error('gagal urai json intent:', err.message);
        console.error('teks mentah pemicu eror:', result.text);
        return { intent: 'chat' };
    }
}

async function generateMimicReply(triggerText, recentSamples) {
    const system = `lu adalah temen nongkrong di wa.
aturan mutlak:
1. pakai gaya bahasa indonesia kasual banget, pakai gue/lu.
2. perhatikan emosi pengguna: kalau dia pakai huruf berulang (guyyyss, apaaaa), huruf kapital untuk ngegas, atau singkatan alay, LU WAJIB NIRU vibe dan energinya persis kayak gitu.
3. pelajari gaya ketikannya dari histori ini: ${recentSamples.join(' | ')}
4. jangan pernah kayak robot, jawab sesingkat dan seasik mungkin.`;
    
    const result = await callAIWithHybridRotation(triggerText, false, system);
    return result.text || 'waduh, otak gue ngeblank bentar coy.';
}

async function summarizeChatLog(logs) {
    const chatText = logs.map(l => `${l.senderName}: ${l.text}`).join('\n');
    const system = `lu adalah perangkum tongkrongan. baca log chat berikut dan rangkum poin pentingnya menggunakan poin-poin. bahasanya tetap santai dan asik, pakai kata gue/lu.`;
    const prompt = `rangkumin obrolan ini:\n${chatText}`;
    
    const result = await callAIWithHybridRotation(prompt, false, system);
    return result.text || 'lagi ga bisa ngerangkum nih, kepanjangan kayaknya.';
}

module.exports = { generateAIText, generateTagReply, parseIntentFromText, generateMimicReply, summarizeChatLog };