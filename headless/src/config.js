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
        // scrollDelayMs cut to a third again (2026-07-11, user request: scrolling
        // felt too slow watching a windowed run) — this is just the wait after
        // each scroll before re-scanning the page — it's the dominant
        // per-iteration cost on a post with a huge reactor list (a single post
        // can loop thousands of times), but it's pure page-reading, not an
        // invite-click action. Unlike baseDelayMs/randomExtraMs (which pace
        // the actual "Invite" clicks Facebook's abuse detection would
        // plausibly watch), scroll timing is indistinguishable from normal
        // browsing, so there's no account-risk tradeoff in speeding it up —
        // only a correctness one (not giving Facebook's lazy-loader enough
        // time to render new rows). Trimmed again 2026-07-11 to 300ms — this
        // is close to the floor: it's a wait for FACEBOOK'S SERVER to push
        // the next batch of reactors, not for our own scroll animation (that
        // part is now a separate, purely cosmetic smooth-scroll — see
        // reactions.js scrollAndInvite Step 3). Going much lower risks
        // scanning before new rows exist yet, which silently skips
        // reactors in the virtualized list (root-caused and fixed once
        // already, 2026-07-03).
        scrollDelayMs: 300,
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
        scrollDelayMs: 200,
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
        scrollDelayMs: 120,
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
const rateMode = { ...RATE_MODES[rateModeName] };

// Daily/per-post volume caps are the one thing worth overriding independently
// of the rest of a rate mode's pacing (click delay, scroll delay, run-time
// cap) — those govern timing sensitive to Facebook's DOM update speed and
// have been carefully tuned for accuracy, whereas the volume caps are just
// "how much is this specific account's reputation known to tolerate."
// Confirmed with the page owner (2026-07-04): routinely sends 500/day
// manually, tested 1,400/day without issue — far above the generic
// paranoid/moderate/aggressive guesses, which were conservative estimates
// made with zero account history to go on.
if (process.env.DAILY_MAX_OVERRIDE) {
    rateMode.dailyMax = parseInt(process.env.DAILY_MAX_OVERRIDE, 10);
}
if (process.env.PER_POST_MAX_OVERRIDE) {
    rateMode.perPostMax = parseInt(process.env.PER_POST_MAX_OVERRIDE, 10);
}
// Lets a one-off run be pointed almost entirely at discovery (see
// DISCOVERY_TIME_CAP_MS) by forcing the invite-processing phase to exit
// on its first budget check instead of running for the mode's normal
// 20-45 minutes — used for dedicated backfill-cataloging runs that
// shouldn't spend any of their time opening reactions dialogs.
if (process.env.RUN_TIME_CAP_OVERRIDE) {
    rateMode.runTimeCapMs = parseInt(process.env.RUN_TIME_CAP_OVERRIDE, 10);
}

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

    // Absolute cutoff date the Content Library's own date-range picker
    // should reach back to. Posts older than this are out of scope
    // entirely — project policy, not just a discovery filter (see PLAN.md
    // §7). Originally a rolling "3 years back" window; narrowed to a fixed
    // 2025-10-01 backfill start (2026-07-05) per the page owner's direct
    // request — the account's actually-useful history doesn't go back
    // nearly that far, and the narrower fixed range finishes the backlog
    // far faster. Once the backlog is cleared, this is expected to switch
    // to a short rolling window (e.g. "5 days back") for ongoing
    // maintenance — see PLAN.md §7 for the full plan.
    discoverSinceDate: process.env.DISCOVER_SINCE_DATE || "2025-10-01",

    // Wall-clock cap (ms) on the Content Library discovery/scroll phase per
    // run — independent of runTimeCapMs, which only bounds the invite
    // phase. Keeps a single cron invocation bounded even as the "already
    // seen" backlog grows over the multi-day catch-up. Only used once
    // discovery has already reached discoverSinceDate (see
    // discoveryOnlyTimeCapMs for the phase before that).
    // Cut from 600000 (10min) to 120000 (2min) on 2026-07-11 now that the
    // deep backlog has been fully backfilled (see routineDiscoveryWindowDays
    // below) — routine discovery only scans the last couple of days now,
    // so it should never legitimately need anywhere near 10 minutes; this
    // is just a safety net against a genuinely stuck scroll.
    discoveryTimeCapMs: parseInt(process.env.DISCOVERY_TIME_CAP_MS || "120000", 10),

    // Once the deep backlog is fully catalogued, routine per-run discovery
    // (the small pass every normal cron run does before invite processing)
    // only needs to catch posts published since the last run — re-scanning
    // all the way back to discoverSinceDate every single run wastes the
    // whole discoveryTimeCapMs budget confirming "0 new" against already-
    // known history (confirmed live 2026-07-11, right after the Oct 2025
    // backfill completed). Narrows the routine scan to a recent window
    // instead; the full discoverSinceDate range is still used by the
    // opt-in --discovery-only-until-complete backfill mode.
    routineDiscoveryWindowDays: parseInt(process.env.ROUTINE_DISCOVERY_WINDOW_DAYS || "2", 10),

    // A post marked "done" was only fully clear of uninvited reactors AT
    // THE MOMENT it was checked — Facebook posts keep collecting new
    // reactions for days/weeks afterward, and nothing re-opens a "done"
    // post's reactions dialog to check for people who reacted since. This
    // was confirmed live (2026-07-22) by the page owner manually finding
    // dozens/hundreds of un-invited reactors on posts that were already
    // marked "done" — some as recent as ~24h old. recheckWindowDays/
    // recheckIntervalMs make "done" posts published within the window
    // periodically eligible for one more pass, so genuinely new reactions
    // keep getting caught instead of a post being treated as permanently
    // finished after its first clean scan.
    recheckWindowDays: parseInt(process.env.RECHECK_WINDOW_DAYS || "30", 10),
    recheckIntervalMs: parseInt(process.env.RECHECK_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10),

    // Wall-clock cap (ms) for a "discovery-only" run — used automatically
    // by runPageWorkflow while the oldest known post is still newer than
    // discoverSinceDate (i.e. the backlog hasn't been fully catalogued
    // yet). Deliberately close to the rate mode's full runTimeCapMs, since
    // these runs skip invite-processing entirely and can dedicate nearly
    // the whole window to discovery. Confirmed live (2026-07-10): with
    // discovery and invite-processing splitting a shared 30-minute budget,
    // 9 of 11 runs in a day found 0 new posts — the backlog wasn't
    // shrinking fast enough for discovery to ever catch up on its own.
    discoveryOnlyTimeCapMs: parseInt(process.env.DISCOVERY_ONLY_TIME_CAP_MS || "1500000", 10),

    // Wall-clock cap (ms) on a SINGLE post's scroll-and-invite loop.
    // runTimeCapMs (in inviter.js's post loop) is only checked BETWEEN
    // posts — a single post with a huge reactor list scattered with many
    // invite candidates can otherwise run far past the intended run cap.
    // Confirmed live (2026-07-04/05): one post ran for ~16 HOURS overnight
    // before an unrelated Puppeteer protocol timeout finally killed it.
    // Default (15 min) leaves room for more than one post within a
    // moderate-mode 30-minute run cap.
    postTimeCapMs: parseInt(process.env.POST_TIME_CAP_MS || "900000", 10),

    // How many times a post is allowed to hit postTimeCapMs before it's
    // given up on and marked "done" anyway. Confirmed live (2026-07-05
    // through 2026-07-10): a post whose full reactor list can't be
    // scrolled in one postTimeCapMs window makes ZERO net progress across
    // repeated attempts — every run reopens the reactions dialog fresh (no
    // way to resume a saved scroll position; Facebook's virtualized list
    // only loads more content by reaching its current, session-local
    // bottom, confirmed via a live scrollTop-jump test that the browser
    // clamps to already-rendered height rather than skipping ahead) and
    // hits the exact same ~49,000px depth ceiling every single day. Under
    // oldest-first processing (see PLAN.md §7.6) this permanently blocks
    // the front of the queue. Giving up after a few attempts trades
    // completeness on that one outlier post for actual backlog progress.
    maxPostTimeCapAttempts: parseInt(process.env.MAX_POST_TIME_CAP_ATTEMPTS || "3", 10),

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
    // Single file, overwritten every tick — a cheap near-live view of what
    // the browser is doing, shown on the dashboard (no video/ffmpeg needed).
    liveScreenshotPath:
        process.env.LIVE_SCREENSHOT_PATH || path.join(DATA_DIR, "live-screenshot.jpg"),
    liveScreenshotIntervalMs: parseInt(process.env.LIVE_SCREENSHOT_INTERVAL_MS || "2000", 10),

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
