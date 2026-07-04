/**
 * config.js — Single source of truth for ALL configuration.
 *
 * Precedence (once CLI is implemented in Phase 7):
 *   CLI flags > .env > hardcoded defaults
 *
 * For now (Phase 0): .env > hardcoded defaults
 */

const path = require("path");

// ──────────────────────────────────────────────
// RATE MODE TABLE — single source of truth
// ──────────────────────────────────────────────

const RATE_MODES = {
    paranoid: {
        dailyMax: 100,
        perPostMax: 30,
        baseDelayMs: 5000,
        randomExtraMs: 5000,
        scrollDelayMs: 3000,
        postCooldownMs: 30000,
        errorCooldownHours: 48,
        maxPostsPerRun: 5,
        runTimeCapMs: 20 * 60 * 1000,
    },
    moderate: {
        dailyMax: 250,
        perPostMax: 75,
        baseDelayMs: 3000,
        randomExtraMs: 3000,
        scrollDelayMs: 2000,
        postCooldownMs: 15000,
        errorCooldownHours: 24,
        maxPostsPerRun: 10,
        runTimeCapMs: 30 * 60 * 1000,
    },
    aggressive: {
        dailyMax: 500,
        perPostMax: 150,
        baseDelayMs: 1500,
        randomExtraMs: 1500,
        scrollDelayMs: 1000,
        postCooldownMs: 5000,
        errorCooldownHours: 12,
        maxPostsPerRun: 20,
        runTimeCapMs: 45 * 60 * 1000,
    },
};

// ──────────────────────────────────────────────
// Resolve rate mode
// ──────────────────────────────────────────────

const rateModeName = process.env.RATE_MODE || "paranoid";
if (!RATE_MODES[rateModeName]) {
    const valid = Object.keys(RATE_MODES).join(", ");
    throw new Error(
        `Invalid RATE_MODE "${rateModeName}". Must be one of: ${valid}`,
    );
}
const rateMode = RATE_MODES[rateModeName];

// ──────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, "data");
const LOGS_DIR = process.env.LOGS_DIR || path.join(PROJECT_ROOT, "logs");

// ──────────────────────────────────────────────
// Export frozen config
// ──────────────────────────────────────────────

const config = Object.freeze({
    // ── Facebook ──
    fbPageUrl: process.env.FB_PAGE_URL || "",
    fbPageId: process.env.FB_PAGE_ID || "",

    // ── Rate limit mode name + all resolved values ──
    rateModeName,
    ...rateMode,

    // ── Date range (YYYY-MM-DD or "all") ──
    dateFrom: process.env.DATE_FROM || "all",
    dateTo: process.env.DATE_TO || "all",

    // How far back the Content Library's own date-range picker should be
    // set (years). Posts older than this are out of scope entirely —
    // project policy, not just a discovery filter (see PLAN.md §7).
    yearsBack: parseInt(process.env.YEARS_BACK || "3", 10),

    // ── Paths ──
    projectRoot: PROJECT_ROOT,
    dataDir: DATA_DIR,
    logsDir: LOGS_DIR,
    profileDir:
        process.env.PROFILE_DIR || path.join(PROJECT_ROOT, "profile"),
    dbPath:
        process.env.DB_PATH ||
        path.join(DATA_DIR, "invitations.json"),
    postsPath:
        process.env.POSTS_PATH ||
        path.join(DATA_DIR, "posts.json"),
    rateLimitStatePath:
        process.env.RATE_LIMIT_PATH ||
        path.join(DATA_DIR, "rate-limit-state.json"),
    lockFilePath: path.join(DATA_DIR, "inviter.lock"),
    screenshotsDir:
        process.env.SCREENSHOTS_DIR || path.join(DATA_DIR, "screenshots"),

    // ── Browser ──
    headless: process.env.HEADLESS !== "false",
    userAgent:
        process.env.USER_AGENT ||
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    puppeteerExecutablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    puppeteerProtocolTimeout: parseInt(
        process.env.PUPPETEER_PROTOCOL_TIMEOUT || "300000",
        10,
    ),
});

module.exports = config;
