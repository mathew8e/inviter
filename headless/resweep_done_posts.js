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
const config = require("./src/config");
const logger = require("./src/logger");
const { gotoAndSettle, forceLightColorScheme, blockUnnecessaryResources } = require("./src/inviter");

(async () => {
    const opts = session.getLaunchOptions("./profile", "new");
    const browser = await puppeteer.launch(opts);
    const page = await browser.newPage();
    await page.setUserAgent(config.userAgent);
    await page.setViewport({ width: 1280, height: 900 });
    await blockUnnecessaryResources(page);

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

            scraper.markPostStatus(post.url, {
                status: result.reason === "post_time_cap" ? "pending" : "done",
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
})();
