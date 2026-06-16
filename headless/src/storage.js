const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "invitations.json");

function init() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([]));
    return Promise.resolve();
}

/**
 * Appends an entry to data/invitations.json.
 *
 * Shape (see PLAN.md section 9):
 *   { id, ts, date, postUrl, invitedCount, peopleNames[], stoppedReason, rateMode }
 *
 * @param {string} postUrl
 * @param {number} count - number of invites sent for this post
 * @param {object} [meta] - extra fields to merge in (stoppedReason, rateMode, peopleNames, dryRun, ...)
 * @returns {Promise<number>} the new entry's id
 */
function saveHistory(postUrl, count, meta = {}) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([]));

    const entries = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const entry = {
        id: entries.length + 1,
        ts: Date.now(),
        date: new Date().toISOString().slice(0, 10),
        postUrl,
        invitedCount: count,
        ...meta,
    };
    entries.push(entry);
    fs.writeFileSync(DB_PATH, JSON.stringify(entries, null, 2));
    return Promise.resolve(entry.id);
}

/**
 * Returns all invitation history entries.
 * @returns {Array<object>}
 */
function getHistory() {
    if (!fs.existsSync(DB_PATH)) return [];
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    } catch {
        return [];
    }
}

module.exports = { init, saveHistory, getHistory };
