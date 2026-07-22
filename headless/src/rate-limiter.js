/**
 * rate-limiter.js — Daily invite budget, cooldowns, lock file, rate-limit detection.
 *
 * Uses data/rate-limit-state.json to track:
 *   - Today's invite count
 *   - Cooldown status
 *   - Last invite timestamp
 *
 * Every function that modifies state persists to disk immediately.
 * The lock file prevents concurrent runs.
 */

const fs = require("fs");
const config = require("./config");
const logger = require("./logger");

const STATE_PATH = config.rateLimitStatePath;
const LOCK_PATH = config.lockFilePath;

// ──────────────────────────────────────────────
// Rate limit text patterns (English + Czech)
// ──────────────────────────────────────────────

const RATE_LIMIT_PATTERNS = [
    // English
    /you are doing that too much/i,
    /rate limit exceeded/i,
    /blocked temporarily/i,
    /this action is temporarily blocked/i,
    /please try again later/i,
    /you have been temporarily blocked/i,
    /slow down/i,
    /too many requests/i,
    // Czech
    /děláš to příliš často/i,
    /dočasně zablokováno/i,
    /tato akce je dočasně zablokována/i,
    /zkus to znovu později/i,
    /zpomal/i,
    /příliš mnoho požadavků/i,
];

// ──────────────────────────────────────────────
// State file helpers
// ──────────────────────────────────────────────

/**
 * Returns a fresh state object for a new day/run.
 */
function createFreshState() {
    return {
        date: todayString(),
        invitesToday: 0,
        dailyLimit: config.dailyMax,
        lastInviteTimestamp: null,
        isCooldown: false,
        cooldownUntil: null,
        consecutiveErrors: 0,
    };
}

/**
 * Returns today's date as YYYY-MM-DD string.
 */
function todayString() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Reads state from disk. Returns fresh state if file missing or corrupted.
 */
function loadState() {
    try {
        if (!fs.existsSync(STATE_PATH)) {
            const fresh = createFreshState();
            saveState(fresh);
            return fresh;
        }
        const raw = fs.readFileSync(STATE_PATH, "utf8");
        const state = JSON.parse(raw);
        // Validate required fields
        if (typeof state.date !== "string" || typeof state.invitesToday !== "number") {
            logger.warn("rate-limit-state.json corrupted, resetting");
            const fresh = createFreshState();
            saveState(fresh);
            return fresh;
        }
        return state;
    } catch (err) {
        logger.warn("Failed to load rate-limit state, resetting: " + err.message);
        const fresh = createFreshState();
        saveState(fresh);
        return fresh;
    }
}

/**
 * Writes state to disk atomically (write to temp, then rename).
 */
function saveState(state) {
    const dir = require("path").dirname(STATE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = STATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_PATH);
}

// ──────────────────────────────────────────────
// Lock file — atomic exclusive create
// ──────────────────────────────────────────────

let lockHeld = false;

/**
 * Acquires the run lock. Throws if another run is in progress.
 * Uses atomic 'wx' flag — if file exists, EEXIST is thrown.
 */
function acquireLock() {
    try {
        const dir = require("path").dirname(LOCK_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
        lockHeld = true;
        logger.info("Lock acquired (pid " + process.pid + ")");
    } catch (err) {
        if (err.code === "EEXIST") {
            throw new Error(
                "Lock file exists — another run appears to be in progress. " +
                "If you are sure no other run is active, delete: " + LOCK_PATH,
            );
        }
        throw err;
    }
}

/**
 * Releases the run lock. Safe to call multiple times.
 */
function releaseLock() {
    if (!lockHeld) return;
    try {
        if (fs.existsSync(LOCK_PATH)) {
            fs.unlinkSync(LOCK_PATH);
        }
        lockHeld = false;
        logger.info("Lock released");
    } catch (err) {
        logger.warn("Failed to release lock: " + err.message);
    }
}

// ──────────────────────────────────────────────
// Daily reset
// ──────────────────────────────────────────────

/**
 * If the state date isn't today, resets the daily counter.
 * Does NOT clear cooldowns — those are time-based.
 */
function resetDailyIfNeeded() {
    const state = loadState();
    const today = todayString();
    let changed = false;

    if (state.date !== today) {
        logger.info(
            `New day detected (state was ${state.date}, now ${today}). Resetting daily counter.`,
        );
        state.date = today;
        state.invitesToday = 0;
        state.lastInviteTimestamp = null;
        // Note: cooldown is NOT cleared — it's time-based, persists across days
        changed = true;
    }

    // dailyLimit is a CONFIG value, not day-scoped state — re-sync it on every
    // run regardless of whether it's a new day. Confirmed live (2026-07-04):
    // DAILY_MAX_OVERRIDE was set after a run earlier the same day had already
    // written dailyLimit=100 to disk; without this, that stale value would
    // have silently overridden the new config until the next calendar day.
    if (state.dailyLimit !== config.dailyMax) {
        logger.info(`Daily limit changed (was ${state.dailyLimit}, now ${config.dailyMax}). Updating.`);
        state.dailyLimit = config.dailyMax;
        changed = true;
    }

    if (changed) saveState(state);

    return state;
}

// ──────────────────────────────────────────────
// Cooldown
// ──────────────────────────────────────────────

/**
 * Checks if we are currently in a cooldown period.
 */
function isInCooldown() {
    const state = loadState();
    if (!state.isCooldown || !state.cooldownUntil) return false;

    const now = Date.now();
    if (now >= state.cooldownUntil) {
        // Cooldown expired
        state.isCooldown = false;
        state.cooldownUntil = null;
        saveState(state);
        logger.info("Cooldown period has ended.");
        return false;
    }

    const remaining = Math.ceil((state.cooldownUntil - now) / 1000 / 60);
    logger.warn(`In cooldown. ${remaining} minutes remaining.`);
    return true;
}

/**
 * Enters a cooldown period for the given number of hours.
 */
function enterCooldown(durationHours) {
    const state = loadState();
    const until = Date.now() + durationHours * 60 * 60 * 1000;
    const untilStr = new Date(until).toISOString();

    state.isCooldown = true;
    state.cooldownUntil = until;
    state.consecutiveErrors += 1;
    saveState(state);

    logger.warn(
        `COOLDOWN ACTIVATED — ${durationHours}h. Until: ${untilStr}. ` +
        `Consecutive errors: ${state.consecutiveErrors}. ` +
        `No invites will be sent until cooldown expires.`,
    );
}

// ──────────────────────────────────────────────
// Budget checks
// ──────────────────────────────────────────────

/**
 * Returns the number of invites remaining for today.
 */
function getRemainingBudget() {
    resetDailyIfNeeded();
    const state = loadState();
    return Math.max(0, state.dailyLimit - state.invitesToday);
}

/**
 * Checks if an invite can be made right now.
 * Returns { allowed: boolean, remaining: number, reason: string | null }
 */
function canInviteToday() {
    // 1. Check cooldown
    if (isInCooldown()) {
        return { allowed: false, remaining: 0, reason: "cooldown_active" };
    }

    // 2. Reset daily counter if needed
    resetDailyIfNeeded();

    // 3. Check daily budget
    const state = loadState();
    const remaining = Math.max(0, state.dailyLimit - state.invitesToday);

    if (remaining <= 0) {
        return {
            allowed: false,
            remaining: 0,
            reason: "daily_limit_reached",
        };
    }

    return { allowed: true, remaining, reason: null };
}

// ──────────────────────────────────────────────
// Recording
// ──────────────────────────────────────────────

/**
 * Records invites that were just sent. Call AFTER actual clicks succeed.
 * @param {number} count — how many invites were just sent
 */
function recordInvite(count) {
    const state = loadState();
    state.invitesToday += count;
    state.lastInviteTimestamp = Date.now();
    saveState(state);

    logger.info(
        `Recorded ${count} invite(s). Today: ${state.invitesToday}/${state.dailyLimit}. ` +
        `Remaining: ${Math.max(0, state.dailyLimit - state.invitesToday)}`,
    );
}

/**
 * Resets the consecutive error counter (call on successful runs).
 */
function resetErrorCounter() {
    const state = loadState();
    if (state.consecutiveErrors > 0) {
        state.consecutiveErrors = 0;
        saveState(state);
    }
}

// ──────────────────────────────────────────────
// Rate limit detection (page scanning)
// ──────────────────────────────────────────────

/**
 * Scans a plain text string for rate-limit keywords.
 * Returns the first matched pattern string, or null.
 * Pure function — no side effects. Useful for unit testing.
 */
function scanTextForRateLimit(text) {
    for (const pattern of RATE_LIMIT_PATTERNS) {
        if (pattern.test(text)) {
            return pattern.source;
        }
    }
    return null;
}

/**
 * Scans the current page for rate-limit warning messages.
 * If found, enters cooldown and throws.
 *
 * @param {import('puppeteer').Page} page — Puppeteer page object
 * @throws {Error} if rate limit is detected (after entering cooldown)
 */
async function detectRateLimit(page) {
    try {
        const bodyText = await page.evaluate(() => document.body.innerText || "");
        const match = scanTextForRateLimit(bodyText);

        if (match) {
            enterCooldown(config.errorCooldownHours);
            throw new Error(
                `RATE LIMIT DETECTED on page. Pattern: "${match}". ` +
                `Entered ${config.errorCooldownHours}h cooldown. Exiting run.`,
            );
        }
    } catch (err) {
        // Re-throw if it's our own rate-limit error (already handled)
        if (err.message.includes("RATE LIMIT DETECTED")) {
            throw err;
        }
        // If page.evaluate fails (page closed, etc.), that's not a rate-limit issue
        logger.warn("Could not scan page for rate limits: " + err.message);
    }
}

// ──────────────────────────────────────────────
// Current state reader (for logs/debug)
// ──────────────────────────────────────────────

/**
 * Returns a copy of the current state for logging/debugging.
 */
function getState() {
    const state = loadState();
    return { ...state };
}

// ──────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────

module.exports = {
    // Lock management
    acquireLock,
    releaseLock,

    // Daily management
    getRemainingBudget,
    canInviteToday,

    // Recording
    recordInvite,
    resetErrorCounter,

    // Cooldown
    isInCooldown,
    enterCooldown,

    // Rate limit detection
    scanTextForRateLimit,
    detectRateLimit,

    // Debug
    getState,
    todayString,

    // Config passthrough (for convenience)
    getLimitPerPost: () => config.perPostMax,
    getRunTimeCap: () => config.runTimeCapMs,
    getPostCooldown: () => config.postCooldownMs,
};
