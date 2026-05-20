const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "invitations.json");

function init() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([]));
    return Promise.resolve();
}

function saveHistory(url, count) {
    const entries = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const entry = { id: entries.length + 1, ts: Date.now(), url, count };
    entries.push(entry);
    fs.writeFileSync(DB_PATH, JSON.stringify(entries, null, 2));
    return Promise.resolve(entry.id);
}

module.exports = { init, saveHistory };
