const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3");

const DB_FILE =
    process.env.DB_PATH || path.resolve(__dirname, "..", "data", "invites.db");

let db;

function init() {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new sqlite3.Database(DB_FILE);
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS invitation_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, url TEXT, count INTEGER)`,
            (err) => (err ? reject(err) : resolve()),
        );
    });
}

function saveHistory(url, count) {
    const ts = new Date().toISOString();
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO invitation_history (ts, url, count) VALUES (?, ?, ?)`,
            [ts, url, count],
            function (err) {
                if (err) return reject(err);
                resolve(this.lastID);
            },
        );
    });
}

module.exports = { init, saveHistory };
