/**
 * inviter.js — The brains of the operation (Phase 5).
 *
 * This file orchestrates the full headless workflow:
 *   1. Launch a hidden Chrome browser (with the saved login profile)
 *   2. Verify the Facebook session is still valid (auth.js)
 *   3. Navigate to the politician's Page (auth.js)
 *   4. Discover posts in the configured date range (scraper.js)
 *   5. For each pending post (newest first):
 *        - Open the reactions popup, scroll, click Invite/Pozvat (reactions.js)
 *        - Record what happened (storage.js, rate-limiter.js)
 *        - Respect daily/per-post limits and cooldowns (rate-limiter.js)
 *   6. Save state and close the browser
 *
 * It also supports two "legacy"/testing modes:
 *   - `waitForLogin: true`  -> open a visible browser so the user can log in
 *     manually; the saved profile dir then has a working session.
 *   - `url: "<single post>"` (without `pageUrl`) -> process exactly one post.
 *     Useful for testing against your own profile with TEST_SELECTORS
 *     ("Sledovat"/"Follow" instead of "Pozvat"/"Invite").
 */

const puppeteer = require("puppeteer");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");

const logger = require("./logger");
const storage = require("./storage");
const session = require("./session");
const config = require("./config");
const auth = require("./auth");
const scraper = require("./scraper");
const reactions = require("./reactions");
const rateLimiter = require("./rate-limiter");
const { takeScreenshot } = require("./screenshot");

// ──────────────────────────────────────────────
// Browser / page helpers
// ──────────────────────────────────────────────

/**
 * Opens a (possibly hidden) Chrome browser using the saved profile.
 *
 * @param {object} options
 * @param {string} [options.profileDir] - Path to a Chrome profile folder (so we stay logged in)
 * @param {boolean} [options.headless=true] - True = invisible browser, False = you can see it
 * @returns {Promise<object>} browser
 */
async function launchBrowser({ profileDir, headless }) {
    const launchOptions = session.getLaunchOptions(profileDir, headless);
    logger.info(`Launching browser (headless=${launchOptions.headless}, profileDir=${profileDir || "none"})`);
    return await puppeteer.launch(launchOptions);
}

/**
 * Blocks image and media (video/audio) network requests. This automation
 * never needs to actually see images or play video/reel content — it only
 * reads DOM structure, aria-labels, and computed styles. Skipping these
 * downloads meaningfully cuts bandwidth and page-load time, especially on
 * constrained hardware (e.g. a Raspberry Pi) or slower connections.
 *
 * Deliberately NOT blocking stylesheets or fonts: the codebase relies on
 * getComputedStyle() (visibility/overflow checks) and getBoundingClientRect()
 * (click coordinates) throughout — missing CSS or font-fallback metrics
 * could shift layout enough to click the wrong element.
 *
 * @param {object} page
 */
async function blockUnnecessaryResources(page) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
        const type = req.resourceType();
        if (type === "image" || type === "media") {
            req.abort().catch(() => {});
        } else {
            req.continue().catch(() => {});
        }
    });
}

/**
 * Facebook sometimes shows a black background in headless mode, which makes
 * text unreadable in screenshots/debug dumps. This forces a light theme.
 *
 * @param {object} page
 */
async function forceLightColorScheme(page) {
    await page
        .evaluate(() => {
            const style = document.createElement("style");
            style.textContent = `
                * { color-scheme: light !important; }
                html, body { background-color: #ffffff !important; color: #000000 !important; }
                :root { color-scheme: light !important; }
            `;
            document.head.appendChild(style);
        })
        .catch(() => {}); // Not critical - ignore failures
}

/**
 * Navigates to a URL, fixes dark mode, and gives the page a moment to settle.
 *
 * @param {object} page
 * @param {string} url
 * @param {object} [navOptions] - extra options merged into page.goto()
 */
async function gotoAndSettle(page, url, navOptions = {}) {
    logger.info(`Navigating to: ${url}`);
    const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
        ...navOptions,
    });
    logger.info(`Navigation finished: status=${response ? response.status() : "n/a"}, finalUrl=${page.url()}`);

    await forceLightColorScheme(page);
    await new Promise((r) => setTimeout(r, 2000));
    await auth.dismissCookieBanner(page);
}

// ──────────────────────────────────────────────
// LOGIN MODE: Let the user log in manually
// ──────────────────────────────────────────────

/**
 * Opens the browser visibly on facebook.com and waits for the user to log
 * in (and switch to the Page's context, if needed). Once logged in, the
 * user presses Enter in the terminal and the session is saved to profileDir.
 *
 * @param {object} page - The browser page (already on facebook.com)
 */
async function waitForManualLogin(page) {
    logger.info("=".repeat(60));
    logger.info("FACEBOOK LOGIN - Browser is now open on your screen.");
    logger.info("1. Log in to Facebook in that browser window.");
    logger.info("2. Navigate to the politician's Page and switch to its context.");
    logger.info("3. Come back to this terminal.");
    logger.info("4. Press ENTER to save the session and close the browser.");
    logger.info("=".repeat(60));

    const rl = readline.createInterface({ input: stdin, output: stdout });
    await rl.question("");
    rl.close();

    logger.info("Login session saved. You can now run the tool without --wait-for-login.");
}

// ──────────────────────────────────────────────
// Single-post mode (legacy / testing)
// ──────────────────────────────────────────────

/**
 * Processes exactly one post URL. Used for:
 *   - Quick manual testing of a single post
 *   - Testing the scroll/invite loop against your OWN profile post using
 *     TEST_SELECTORS (Follow/Sledovat instead of Invite/Pozvat)
 *
 * @param {object} page
 * @param {string} url
 * @param {boolean} dryRun
 * @param {Array<string>} selectors
 * @returns {Promise<{invited: number, reason: string}>}
 */
async function runSinglePost(page, url, dryRun, selectors) {
    await gotoAndSettle(page, url);
    await rateLimiter.detectRateLimit(page);

    const budget = rateLimiter.canInviteToday();
    const maxInvites = dryRun ? config.perPostMax : Math.min(config.perPostMax, budget.remaining);

    const result = await reactions.processPost(page, url, dryRun, selectors, maxInvites);

    if (!dryRun && result.invited > 0) {
        rateLimiter.recordInvite(result.invited);
    }

    await storage.saveHistory(url, result.invited, {
        stoppedReason: result.reason,
        rateMode: config.rateModeName,
        dryRun,
    });

    return result;
}

// ──────────────────────────────────────────────
// Page mode (the real workflow)
// ──────────────────────────────────────────────

/**
 * The full pipeline: discover posts on the Page, then loop through the
 * pending ones, opening each post's reactions dialog and inviting people,
 * all while respecting rate limits.
 *
 * @param {object} page
 * @param {object} opts
 * @returns {Promise<object>} summary
 */
async function runPageWorkflow(page, opts) {
    const { pageUrl, dryRun, dateFrom, dateTo, maxPosts, selectors } = opts;

    const summary = {
        postsDiscovered: 0,
        postsProcessed: 0,
        totalInvited: 0,
        stoppedReason: null,
        results: [],
    };

    // ── Phase 1: Discover posts via the Professional Dashboard's Content
    // Library (primary method — never loads video/reel players, gives a
    // direct per-post Insights link, and reels are cleanly identifiable
    // up front so we can skip them instead of attempting a doomed
    // reactions-dialog open). Navigates there directly; no need to visit
    // the public page URL first.
    const discovered = await scraper.discoverPostsFromContentLibrary(page, dateFrom, dateTo, maxPosts);
    summary.postsDiscovered = discovered.length;

    // Skip posts already marked "done" in a previous run
    const pending = discovered.filter((p) => p.status !== "done");
    logger.info(`${pending.length}/${discovered.length} discovered posts are pending (not yet done).`);

    if (pending.length === 0) {
        summary.stoppedReason = "no_pending_posts";
        return summary;
    }

    // ── Phase 2: Process posts ──
    const runStart = Date.now();

    for (const post of pending) {
        // ── Run-time cap (don't run forever - pick up the rest tomorrow) ──
        if (Date.now() - runStart > config.runTimeCapMs) {
            summary.stoppedReason = "run_time_cap";
            logger.warn(`Run time cap (${config.runTimeCapMs}ms) reached. Stopping for this run.`);
            break;
        }

        // ── Rate-limit / daily budget check ──
        const budget = rateLimiter.canInviteToday();
        if (!budget.allowed) {
            summary.stoppedReason = budget.reason;
            logger.warn(`Rate limiter says STOP (${budget.reason}). Ending run.`);
            break;
        }

        logger.info("");
        logger.info(
            `=== Post ${summary.postsProcessed + 1}/${pending.length} ` +
            `(budget remaining: ${budget.remaining}) - ${post.url} ===`,
        );

        // Reels: Facebook's Content Library Insights page shows only a
        // static "N Reactions" counter for reels/video stories, with no
        // functional "see who reacted" trigger — confirmed on multiple
        // reels regardless of engagement level or network connection.
        // Skip immediately instead of wasting a page load + timeout on a
        // dialog we already know won't open.
        if (post.contentType === "reel") {
            logger.info("Skipping reel — Insights doesn't expose reactions for reels.");
            summary.results.push({ url: post.url, invited: 0, reason: "reel_not_supported" });
            scraper.markPostStatus(post.url, { status: "done", invitedCount: 0, error: null });
            continue;
        }

        try {
            await gotoAndSettle(page, post.url);
            await rateLimiter.detectRateLimit(page);

            // Never let a single post blow the whole daily budget
            const maxInvites = dryRun
                ? config.perPostMax
                : Math.min(config.perPostMax, budget.remaining);

            const result = await reactions.processPost(page, post.url, dryRun, selectors, maxInvites);

            summary.postsProcessed++;
            summary.totalInvited += result.invited;
            summary.results.push({ url: post.url, ...result });

            if (!dryRun && result.invited > 0) {
                rateLimiter.recordInvite(result.invited);
            }

            if (!dryRun) {
                await storage.saveHistory(post.url, result.invited, {
                    stoppedReason: result.reason,
                    rateMode: config.rateModeName,
                    dryRun,
                });
            }

            // Mark this post as done (dry runs are still marked done so we
            // don't re-scan them every day; delete posts.json to rescan).
            scraper.markPostStatus(post.url, {
                status: "done",
                invitedCount: dryRun ? 0 : result.invited,
                error: null,
            });

            rateLimiter.resetErrorCounter();
        } catch (err) {
            logger.error(`Error processing post ${post.url}: ${err.message}`);
            await takeScreenshot(page, "post-processing-error");
            summary.results.push({ url: post.url, invited: 0, reason: "error", error: err.message });

            scraper.markPostStatus(post.url, {
                status: "error",
                invitedCount: 0,
                error: err.message,
            });

            // detectRateLimit() throws a recognizable message when it enters cooldown
            if (err.message.includes("RATE LIMIT DETECTED") || err instanceof auth.SessionExpiredError) {
                summary.stoppedReason = err instanceof auth.SessionExpiredError ? "session_expired" : "rate_limited";
                break;
            }
            // Otherwise: log it, move on to the next post
        }

        // ── Cooldown between posts ──
        const cooldown = config.postCooldownMs + Math.floor(Math.random() * 1000);
        logger.info(`Post cooldown: waiting ${cooldown}ms before the next post...`);
        await new Promise((r) => setTimeout(r, cooldown));
    }

    if (!summary.stoppedReason) {
        summary.stoppedReason =
            summary.postsProcessed >= pending.length ? "completed_all_posts" : "loop_exit";
    }

    return summary;
}

// ──────────────────────────────────────────────
// THE MAIN ENTRY POINT - Ties everything together
// ──────────────────────────────────────────────

/**
 * @param {object} options
 * @param {string} [options.pageUrl] - Facebook Page URL (full workflow mode)
 * @param {string} [options.url] - Single post URL (legacy/testing mode, used if pageUrl is not set)
 * @param {string} [options.profileDir] - Chrome profile folder (defaults to config.profileDir)
 * @param {boolean} [options.headless=true] - Run invisible
 * @param {boolean} [options.waitForLogin=false] - Just log in, don't run automation
 * @param {boolean} [options.dryRun=true] - Scan + log only, never click (SAFE DEFAULT)
 * @param {string} [options.dateFrom] - ISO date or "all" (defaults to config.dateFrom)
 * @param {string} [options.dateTo] - ISO date or "all" (defaults to config.dateTo)
 * @param {number} [options.maxPosts] - Max posts to process this run (defaults to config.maxPostsPerRun)
 * @param {Array<string>} [options.selectors] - Override invite selectors (e.g. reactions.TEST_SELECTORS)
 * @returns {Promise<object>} summary - { postsDiscovered, postsProcessed, totalInvited, stoppedReason, results }
 */
async function runWithBrowser({
    pageUrl,
    url,
    profileDir = config.profileDir,
    headless = config.headless,
    waitForLogin = false,
    dryRun = true,
    dateFrom = config.dateFrom,
    dateTo = config.dateTo,
    maxPosts = config.maxPostsPerRun,
    selectors = reactions.INVITE_SELECTORS,
} = {}) {
    const isLoginMode = waitForLogin === true;
    const effectiveHeadless = isLoginMode ? false : headless;

    const browser = await launchBrowser({ profileDir, headless: effectiveHeadless });

    let lockHeld = false;
    let cleanupDone = false;
    let summary = {
        postsDiscovered: 0,
        postsProcessed: 0,
        totalInvited: 0,
        stoppedReason: null,
        results: [],
    };

    // Idempotent cleanup — safe to call from both signal handlers and finally.
    async function cleanup(reason) {
        if (cleanupDone) return;
        cleanupDone = true;
        logger.info(`Cleaning up (reason: ${reason})...`);
        if (lockHeld) {
            rateLimiter.releaseLock();
            lockHeld = false;
        }
        try {
            await browser.close();
        } catch (_) {}
        logger.info("Shutdown complete.");
    }

    // Register signal handlers so Ctrl+C / SIGTERM release the lock cleanly.
    const onSignal = async (sig) => {
        logger.info(`\nReceived ${sig} — shutting down gracefully...`);
        await cleanup(sig);
        process.exit(0);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent(config.userAgent);
        await page.setViewport({ width: 1280, height: 900 });
        await blockUnnecessaryResources(page);

        // ── Login mode: open facebook.com, wait for the user, then exit ──
        if (isLoginMode) {
            await gotoAndSettle(page, "https://www.facebook.com/");
            await waitForManualLogin(page);
            summary.stoppedReason = "login_mode";
            return summary;
        }

        if (!dryRun) {
            logger.warn(
                "DRY RUN IS OFF - this run WILL click Invite/Pozvat buttons and send real invites.",
            );
        } else {
            logger.info("DRY RUN - scanning and logging only, no buttons will be clicked.");
        }

        // ── Lock: prevent concurrent runs from stepping on each other ──
        rateLimiter.acquireLock();
        lockHeld = true;

        // ── Auth: verify session, watch for mid-run expiry ──
        await auth.ensureLoggedIn(page);
        auth.setupNavigationWatcher(page);

        if (pageUrl) {
            // ── Full page workflow ──
            summary = await runPageWorkflow(page, { pageUrl, dryRun, dateFrom, dateTo, maxPosts, selectors });
        } else if (url) {
            // ── Single-post legacy/testing mode ──
            const result = await runSinglePost(page, url, dryRun, selectors);
            summary.postsDiscovered = 1;
            summary.postsProcessed = 1;
            summary.totalInvited = result.invited;
            summary.stoppedReason = result.reason;
            summary.results.push({ url, ...result });
        } else {
            throw new Error(
                "runWithBrowser requires 'pageUrl' (full workflow), 'url' (single post), or 'waitForLogin: true'.",
            );
        }

        logger.info("");
        logger.info(
            `RUN SUMMARY: discovered=${summary.postsDiscovered}, processed=${summary.postsProcessed}, ` +
            `invited=${summary.totalInvited}, stoppedReason=${summary.stoppedReason}, dryRun=${dryRun}`,
        );
    } catch (err) {
        logger.error("Error in inviter run: " + err.message);
        if (page) await takeScreenshot(page, "run-error");
        throw err;
    } finally {
        // Remove signal listeners first so cleanup() isn't called twice.
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        await cleanup("normal exit");
    }

    return summary;
}

// ──────────────────────────────────────────────
// EXPORT
// ──────────────────────────────────────────────
module.exports = {
    runWithBrowser,
    // Exposed for testing / reuse
    launchBrowser,
    gotoAndSettle,
    forceLightColorScheme,
    blockUnnecessaryResources,
};
