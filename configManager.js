const fs = require('fs');
const CONFIG_PATH = './config.json';

let configCache = null;
let debounceTimeout = null;

function loadConfig() {
    if (!configCache) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        
        if (!raw.authorizedUsers) raw.authorizedUsers = [];
        if (!raw.contacts) raw.contacts = [];
        if (!raw.reminders) raw.reminders = [];
        if (!raw.styleProfiles) raw.styleProfiles = {};
        if (!raw.accountMapping) raw.accountMapping = {};
        
        // Migrasi otomatis jika konfigurasi lama masih menggunakan kunci tunggal
        if (!raw.geminiApiKeys) {
            raw.geminiApiKeys = raw.geminiApiKey ? [raw.geminiApiKey] : [];
        }
        
        configCache = raw;
    }
    return configCache;
}

function saveConfig(config) {
    configCache = config;
    if (debounceTimeout) {
        clearTimeout(debounceTimeout);
        debounceTimeout = null;
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configCache, null, 2));
}

function saveConfigDebounced(config) {
    configCache = config;
    if (debounceTimeout) return;

    debounceTimeout = setTimeout(() => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configCache, null, 2));
        debounceTimeout = null;
    }, 10000);
}

module.exports = { loadConfig, saveConfig, saveConfigDebounced };