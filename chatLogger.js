const fs = require('fs');
const path = require('./group_log.json');

const MAX_LOGS = 500;

function logGroupMessage(senderName, text) {
    let logs = [];
    if (fs.existsSync('./group_log.json')) {
        try {
            logs = JSON.parse(fs.readFileSync('./group_log.json', 'utf-8'));
        } catch (e) {
            logs = [];
        }
    }

    logs.push({ senderName, text, timestamp: Date.now() });

    if (logs.length > MAX_LOGS) {
        logs.shift(); // Hapus yang paling lama (FIFO)
    }

    fs.writeFileSync('./group_log.json', JSON.stringify(logs, null, 2));
}

function getGroupLogs(count = 200) {
    if (!fs.existsSync('./group_log.json')) return [];
    try {
        const logs = JSON.parse(fs.readFileSync('./group_log.json', 'utf-8'));
        return logs.slice(-count);
    } catch (e) {
        return [];
    }
}

module.exports = { logGroupMessage, getGroupLogs };