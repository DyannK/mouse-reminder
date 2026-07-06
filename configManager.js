const fs = require('fs');
const CONFIG_PATH = './config.json';

function loadConfig() {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // safety default, biar gak crash kalau field belum ada di file lama
    if (!raw.authorizedUsers) raw.authorizedUsers = [];
    if (!raw.contacts) raw.contacts = [];
    if (!raw.reminders) raw.reminders = [];
    if (!raw.geminiApiKey) raw.geminiApiKey = '';
    if (!raw.styleProfiles) raw.styleProfiles = {};
    return raw;
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { loadConfig, saveConfig };