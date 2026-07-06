const fs = require('fs');
const CONFIG_PATH = './config.json';

let configCache = null;
let debounceTimeout = null;

function loadConfig() {
    if (!configCache) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        // safety default, biar gak crash kalau field belum ada di file lama
        if (!raw.authorizedUsers) raw.authorizedUsers = [];
        if (!raw.contacts) raw.contacts = [];
        if (!raw.reminders) raw.reminders = [];
        if (!raw.geminiApiKey) raw.geminiApiKey = '';
        if (!raw.styleProfiles) raw.styleProfiles = {};
        configCache = raw;
    }
    return configCache;
}

function saveConfig(config) {
    configCache = config;
    // Jika ada antrean penulisan pasif yang tertunda, batalkan agar diganti dengan penulisan instan ini
    if (debounceTimeout) {
        clearTimeout(debounceTimeout);
        debounceTimeout = null;
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configCache, null, 2));
}

/**
 * Menyimpan konfigurasi secara berkala dengan jeda waktu tertentu.
 * Sangat berguna untuk operasi dengan lalu lintas tinggi seperti perekaman gaya ketik pasif.
 */
function saveConfigDebounced(config) {
    configCache = config;
    if (debounceTimeout) return; // Jika sudah ada antrean penulisan, biarkan berjalan

    debounceTimeout = setTimeout(() => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configCache, null, 2));
        debounceTimeout = null;
    }, 10000); // Menunda penulisan ke disk selama 10 detik demi kesehatan performa Termux
}

module.exports = { loadConfig, saveConfig, saveConfigDebounced };