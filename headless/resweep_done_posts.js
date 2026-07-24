// One-off sweep: re-scans every already-"done", non-story post at the
// fastest safe pacing (aggressive rate mode) with the newly-fixed
// double-confirmation end-of-list logic, to catch reactors that earlier
// (pre-fix) runs may have missed via a premature "end of list" false
// positive. Reuses the exact same building blocks as the normal cron flow
// (auth, gotoAndSettle, processPost, rate limiter) for one long-lived
// browser session across the whole backlog, instead of relaunching Chrome
// per post.
process.env.RATE_MODE = "aggressive";

const puppeteer = require("puppeteer");
const session = require("./src/session");
const auth = require("./src/auth");
const scraper = require("./src/scraper");
const reactions = require("./src/reactions");
const rateLimiter = require("./src/rate-limiter");
const storage = require("./src/storage");
const config = require("./src/config");
const logger = require("./src/logger");
const { gotoAndSettle, forceLightColorScheme, blockUnnecessaryResources } = require("./src/inviter");
const { startLiveScreenshotLoop } = require("./src/screenshot");

(async () => {
    await storage.init();

    // Acquire the same lock file the normal cron flow uses. Without this
    // (confirmed live 2026-07-22), the dashboard wrongly shows "idle" during
    // a resweep, and cron keeps trying to launch a second Chrome instance
    // every 2 hours — Chrome's own profile lock caught it every time (no
    // corruption happened), but it silently blocked all routine discovery
    // and invite processing for the run's entire duration.
    rateLimiter.acquireLock();
    let lockHeld = true;
    let stopLiveScreenshot = () => {};
    const releaseLock = () => {
        if (lockHeld) {
            stopLiveScreenshot();
            rateLimiter.releaseLock();
            lockHeld = false;
        }
    };
    process.once("SIGINT", () => { releaseLock(); process.exit(0); });
    process.once("SIGTERM", () => { releaseLock(); process.exit(0); });

    const opts = session.getLaunchOptions("./profile", "new");
    const browser = await puppeteer.launch(opts);
    const page = await browser.newPage();
    await page.setUserAgent(config.userAgent);
    await page.setViewport({ width: 1280, height: 900 });
    await blockUnnecessaryResources(page);
    stopLiveScreenshot = startLiveScreenshotLoop(page);

    await auth.ensureLoggedIn(page);
    auth.setupNavigationWatcher(page);

    const allPosts = scraper.loadPostList().posts;
    const targets = allPosts.filter((p) => p.status === "done" && p.contentType !== "story");
    logger.info(`Resweep: ${targets.length} done posts to re-check.`);

    let totalNewInvites = 0;
    let postsWithNewInvites = 0;

    for (let i = 0; i < targets.length; i++) {
        const post = targets[i];

        const budget = rateLimiter.canInviteToday();
        if (!budget.allowed) {
            logger.warn(`Rate limiter says STOP (${budget.reason}). Ending sweep early.`);
            break;
        }

        logger.info(`\n=== Resweep ${i + 1}/${targets.length} (budget remaining: ${budget.remaining}) - ${post.url} ===`);

        try {
            await gotoAndSettle(page, post.url);
            await rateLimiter.detectRateLimit(page);

            const maxInvites = Math.min(config.perPostMax, budget.remaining);
            const result = await reactions.processPost(page, post.url, false, reactions.INVITE_SELECTORS, maxInvites);

            if (result.invited > 0) {
                rateLimiter.recordInvite(result.invited);
                totalNewInvites += result.invited;
                postsWithNewInvites++;
                logger.info(`>>> Found ${result.invited} previously-missed reactor(s) on this post.`);
            }

            // Was missing entirely (confirmed live 2026-07-22) — without this,
            // the resweep's real invites were sent and correctly counted
            // toward the daily budget, but never showed up in the dashboard's
            // per-post history or activity feed, since both read from this
            // log rather than posts.json's running invitedCount.
            await storage.saveHistory(post.url, result.invited, {
                stoppedReason: result.reason,
                rateMode: "aggressive",
                dryRun: false,
                resweep: true,
            });

            // These reasons all mean the pass didn't reach the end of the
            // reactor list, or never started scanning it at all — see
            // inviter.js's matching comment for the full reasoning.
            const incomplete = [
                "post_time_cap", "per_post_limit", "error_mid_scan",
                "dialog_not_opened", "no_container_found", "no_budget",
            ].includes(result.reason);
            scraper.markPostStatus(post.url, {
                status: incomplete ? "pending" : "done",
                invitedCount: result.invited,
                error: null,
                hitPostTimeCap: result.reason === "post_time_cap",
            });

            rateLimiter.resetErrorCounter();
        } catch (err) {
            logger.error(`Error resweeping ${post.url}: ${err.message}`);
        }
    }

    logger.info(
        `\n=== RESWEEP COMPLETE === posts checked with new invites: ${postsWithNewInvites}, ` +
        `total newly-found invites: ${totalNewInvites}`,
    );

    await browser.close();
    releaseLock();
})();
