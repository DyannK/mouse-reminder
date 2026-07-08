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
    // ATURAN SAKLEK UNTUK TETAP MEMPERTAHANKAN KAPITALISASI FIFO/LIFO BRAY!
    return 'gaya bahasa wajib menggunakan huruf kecil semua (lowercase) untuk seluruh kalimat dan kata panggilan, KECUALI untuk singkatan teknis, istilah/definisi khusus yang jarang disebutkan, atau produk unpopular yang aslinya memang berupa kapital penuh (contoh: FIFO, LIFO). jangan gunakan huruf kapital untuk nama orang atau di awal kalimat biasa bray. mengalir sangat santai natural seperti wa anak tongkrongan sehari-hari. dilarang keras menyisipkan tanda koma tepat sebelum panggilan nama (contoh salah: "apa, yan?", "halo, med". contoh benar: "apa yan", "halo med"). buang total atau kurangi penggunaan tanda baca berlebih atau lebay seperti !?, double tanda tanya, atau koma beruntun.';
}

async function generateAIText(tema, context = {}, styleInstruction = null, manualFallback = null, formal = false) {
    const fallbackText = manualFallback || `📌 ${tema}`;
    if (formal) return { text: fallbackText, usedFallback: true };
    
    let prompt = `tulis 1 kalimat pengingat pendek bertema: ${tema}.`;
    if (context.isNow) prompt += ` sekarang adalah waktu eksekusi acaranya.`;
    else if (context.sisa) prompt += ` sisa waktu: ${context.sisa}.`;
    if (context.judul) prompt += ` judul agenda: ${context.judul}.`;
    
    const result = await callAIWithHybridRotation(prompt, false, buildGayaInstruction());
    // HAPUS .toLowerCase() BIAR ISTILAH KHUSUS KELUARAN GEMINI TETAP TERJAGA KAPITALNYA BRAY
    if (result.text) return { text: result.text, usedFallback: false };
    
    return { text: fallbackText.toLowerCase(), usedFallback: true };
}

async function generateTagReply(triggerText, styleInstruction = null) {
    let prompt = `lu adalah teman yang asik di grup whatsapp. seseorang memanggil lu dengan pesan: ${triggerText}. balas pendek maksimal 2 kalimat, santai, nyambung, dan gunakan gaya chat tongkrongan.`;
    if (styleInstruction) prompt += ` ${styleInstruction}`;

    const result = await callAIWithHybridRotation(prompt, false, buildGayaInstruction());
    // HAPUS .toLowerCase() BIAR FORMAT SINKRON KE BAWAH YAN
    return result.text ? result.text : 'oi ada apa yan';
}

// SEKARANG FUNGSI MIMIC UDAH MAU MENERIMA OPERAN PARAMETER CURRENTNICK BRAY!
async function generateMimicReply(triggerText, recentSamples, conversationHistory = [], currentNick = 'coy') {
    const system = `lu adalah bot reminder jadwal sekaligus temen nongkrong digital di wa yang dikembangkan atau dibuat oleh dyan khusus buat jagain agenda personal dan kelompok mereka.
aturan mutlak:
1. jika user bertanya soal identitas (seperti: siapa lu, lu apa, siapa yang bikin lu, dll), jawab kasual kalau lu itu bot pengingat jadwal buatan dyan yang stand by jadi asisten digital mereka.
2. pakai gaya bahasa indonesia semi-betawi kasual banget, pakai gue/lo atau gua/lo. wajib huruf kecil semua (lowercase) untuk seluruh kalimat, KECUALI untuk singkatan teknis, istilah khusus, atau produk unpopular yang aslinya memang berupa kapital penuh (contoh: FIFO, LIFO). jangan gunakan huruf kapital untuk nama orang atau di awal kalimat biasa bray.
3. dilarang keras menyelipkan tanda koma tepat sebelum panggilan nama (contoh: "kenape yan?" bukan "ada apa, yan?"). kurangi total tanda baca lebay atau tidak penting seperti !?, double tanda tanya, atau rentetan koma.
4. perhatikan emosi pengguna dan tiru karakteristik ketikannya dari profil ini: ${recentSamples.join(' | ')}
5. lu wajib membaca runtunan riwayat percakapan sebelumnya agar jawaban lu mengakar, nyambung, dan memahami konteks pembicaraan dari bubble ke bubble sebelumnya secara akurat.
6. sapa atau panggil user menggunakan nama panggilannya: "${currentNick}" secara natural di dalam obrolan obrolan pribadi lu bray, jangan keseringan pake kata panggil default kasual jikalau nama panggilannya sudah terdeteksi jelas.`;
    
    let prompt = `Riwayat percakapan terakhir lu dan user:\n${conversationHistory.join('\n')}\n\nUser baru saja mengetik pesan: "${triggerText}"\nBalas dengan mengalir dan mengakar sesuai konteks riwayat di atas:`;
    
    const result = await callAIWithHybridRotation(prompt, false, system);
    // HAPUS .toLowerCase() DISINI AGAR ATURAN PENGECUALIAN HURUF KAPITAL LU WORK 100% DI CHAT PRIBADI YAN!
    return result.text ? result.text : 'waduh otak gue ngeblank bentar bray';
}

async function parseIntentFromText(triggerText) {
    const lowText = triggerText.toLowerCase();

    const readKeywords = ['lihat', 'liat', 'cek', 'tampilkan', 'tampilin', 'list', 'info', 'ada apa aja', 'gimana aja'];
    const scheduleKeywords = ['jadwal', 'agenda', 'deadline', 'ingetan', 'listnya', 'list'];
    
    const hasReadKw = readKeywords.some(kw => lowText.includes(kw));
    const hasSchedKw = scheduleKeywords.some(kw => lowText.includes(kw));

    if ((hasReadKw && hasSchedKw) || lowText.includes('liat jadwal') || lowText.includes('gimana aja listnya') || lowText.includes('liat list')) {
        if (lowText.includes('detail')) {
            return { intent: 'read_schedule_detail', judul: null, waktu: null, jumlahChat: 200 };
        }
        return { intent: 'read_schedule', judul: null, waktu: null, jumlahChat: 200 };
    }

    let system = `lu adalah mesin pembaca niat khusus bahasa indonesia. analisa kalimat dan kembalikan JSON murni.
pilihan intent:
1. "create_schedule": jika pengguna ingin membuat jadwal atau reminder atau deadline DAN menyebutkan jam serta judul aktivitas.
2. "chat": jika hanya mengobrol biasa atau menyapa.

aturan ekstraksi parameter untuk "create_schedule":
- jika user memasukkan teks yang mengandung awalan "AI:", itu adalah bagian dari string template pesan biasa, jangan pernah dihapus atau dipotong kata "AI:" tersebut dari hasil ekstraksi string!
- jika user menyebutkan rentetan menit pengingat spesifik (misal: "pengingat di 30 menit, 20 menit, 10 menit..."), ambil seluruh angka menit tersebut, susun menjadi array/larik angka terurut dari terbesar ke terkecil di properti "customMilestones", dan buat nilai "intervalMinutes" menjadi null.
- jika tidak ada rentetan menit spesifik melainkan kata perulangan rutin (misal: "tiap menit", "per-5 menit"), isi properti "intervalMinutes" dengan angka menit tersebut dan buat "customMilestones" menjadi null.
- jika user menyebutkan kata pembatalan laporan (misal: "tanpa laporan", "matikan laporan", "laporan off"), set properti "withReport" menjadi false. jika tidak disebutkan, secara default beri nilai true.
- jika user merujuk ke diri sendiri atau penegasan personal (misal: "buat gue pribadi", "buat saya", "buat gua aja", "pribadi aja"), kamu WAJIB mengisi properti "extractedTarget" dengan string murni "sender". jangan diisi dengan nama kata ganti tersebut.
- jika merujuk ke nama kontak atau nama orang lain (misal: "buat dyan", "buat fizar"), baru isi properti "extractedTarget" dengan nama orang tersebut.
- jika user menyebutkan template pesan pengingat mundur/durasi, masukkan ke parameter pesanDurasi.
- jika user menyebutkan template pengingat pas waktu target eksekusi (H-0), masukkan ke parameter pesanNow.

format output json murni:
{
  "intent": "create_schedule" | "chat",
  "judul": "string atau null",
  "waktu": "string format HH:MM atau null",
  "intervalMinutes": number atau null,
  "customMilestones": array angka atau null,
  "withReport": boolean,
  "startTime": "string format HH:MM atau null",
  "pesanDurasi": "string atau null",
  "pesanNow": "string atau null",
  "extractedTarget": "string atau null"
}`;

    const createKeywords = ['bikin', 'buat', 'ingetin', 'set', 'tambah', 'remind', 'buatkan', 'buatin', 'creating'];
    const hasCreateKw = createKeywords.some(kw => lowText.includes(kw));

    if (hasCreateKw || lowText.includes(':')) {
        system += `\n\nPERINGATAN UTAMA: Teks pengguna ini mengandung kata kunci pembuatan atau format waktu jam digital. Kamu harus memprioritaskan klasifikasi ke arah "create_schedule" jika ada nama aktivitas dan waktu eksekusi yang bisa diisolasi.`;
    }
    
    const result = await callAIWithHybridRotation(triggerText, true, system);
    if (!result.text) return { intent: 'chat' };
    
    try {
        const cleanJsonStr = result.text.replace(/```json|```/gi, '').trim();
        console.log('📋 [DEBUG INTENT AI OUT]:', cleanJsonStr);
        return JSON.parse(cleanJsonStr);
    } catch (err) {
        console.error('gagal urai json intent:', err.message);
        return { intent: 'chat' };
    }
}


async function generateDynamicStateText(fallbackText, currentNick, samples, history = []) {
    const system = `lu adalah asisten personal kasual di wa buatan dyan. tugas lu adalah mengubah pesan status operasional sistem menjadi untaian kalimat obrolan wa yang super natural.
    aturan mutlak:
    1. wajib huruf kecil semua tanpa terkecuali termasuk nama panggilan (yan, med, zar, yog, nad).
    2. jangan selipkan koma sebelum nama panggilan (contoh: "beres yan" bukan "beres, yan"). kurangi tanda baca berlebih (!?, koma lebay).
    3. esensi operasional status harus tetap tersampaikan utuh dan jelas dari kalimat: "${fallbackText}".
    4. sapa user menggunakan potongan nama panggilannya: "${currentNick}".
    5. tiru karakteristik ketikan kasual user dari sampel berikut: ${samples.join(' | ')}`;
    
    let prompt = `Riwayat chat terakhir:\n${history.join('\n')}\n\nUbah status sistem berikut menjadi kalimat chat tongkrongan yang mengalir: "${fallbackText}"`;
    const result = await callAIWithHybridRotation(prompt, false, system);
    return result.text ? result.text.toLowerCase() : fallbackText.toLowerCase();
}

async function summarizeChatLog(transkripObrolan) {
    const system = 'lu adalah perangkum tongkrongan. baca log chat berikut dan rangkum poin pentingnya menggunakan poin-poin. bahasanya tetap santai dan asik, pakai kata gue/lu.';
    const prompt = `rangkumin obrolan ini:\n${transkripObrolan}`;
    
    const result = await callAIWithHybridRotation(prompt, false, system);
    return result.text || 'lagi ga bisa ngerangkum nih kepanjangan kayaknya';
}

module.exports = { generateAIText, generateTagReply, parseIntentFromText, generateMimicReply, generateDynamicStateText, summarizeChatLog };