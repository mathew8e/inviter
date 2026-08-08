// Fast, READ-ONLY audit: sweeps every "done" post, counting how many
// people still show an Invite/Pozvat button — WITHOUT clicking any of
// them — and records the post's total reaction count alongside it. Never
// sends a real invite; purely a diagnostic/reporting pass, meant to run
// locally against the current "done" backlog and answer "how many
// uninvited people does the live system actually think are still there,
// right now, across everything."
//
// Writes reactionsCount / lastAuditUninvitedCount / lastAuditAt onto each
// checked post in posts.json (does NOT touch status/invitedCount — this
// is a read-only audit, not a resweep).
//
// Usage:
//   node audit_all_posts.js              (all "done" posts, oldest first)
//   node audit_all_posts.js --limit 20   (only the first 20)
// This never clicks Invite, so baseDelayMs/randomExtraMs (real-click
// pacing) don't functionally matter here the way they do for resweep —
// but during the post-block recovery period (see config.js's cautious
// mode comment) there's no reason for this to be the one thing still
// running at the old aggressive pace either, so it matches.
process.env.RATE_MODE = "cautious";

const puppeteer = require("puppeteer");
const session = require("./src/session");
const auth = require("./src/auth");
const scraper = require("./src/scraper");
const reactions = require("./src/reactions");
const rateLimiter = require("./src/rate-limiter");
const config = require("./src/config");
const logger = require("./src/logger");
const { gotoAndSettle, blockUnnecessaryResources } = require("./src/inviter");

function parseLimit() {
    const idx = process.argv.indexOf("--limit");
    if (idx === -1) return Infinity;
    const n = parseInt(process.argv[idx + 1], 10);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
}

(async () => {
    await scraper.loadPostList(); // sanity-check posts.json is readable before opening a browser
    rateLimiter.acquireLock();
    let lockHeld = true;
    const releaseLock = () => { if (lockHeld) { rateLimiter.releaseLock(); lockHeld = false; } };
    process.once("SIGINT", () => { releaseLock(); process.exit(0); });
    process.once("SIGTERM", () => { releaseLock(); process.exit(0); });

    const limit = parseLimit();
    const allPosts = scraper.loadPostList().posts;
    const targets = allPosts
        .filter((p) => p.status === "done" && p.contentType !== "story")
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
        .slice(0, limit);

    logger.info(`Audit: ${targets.length} done posts to check (read-only, no clicks).`);

    let browser;
    try {
        const opts = session.getLaunchOptions("./profile", process.env.HEADLESS === "false" ? false : "new");
        browser = await puppeteer.launch(opts);
        const page = await browser.newPage();
        await page.setUserAgent(config.userAgent);
        await page.setViewport({ width: 1280, height: 900 });
        await blockUnnecessaryResources(page);
        await auth.ensureLoggedIn(page);
        auth.setupNavigationWatcher(page);

        let totalUninvited = 0;
        let postsWithGaps = 0;
        const flagged = [];

        for (let i = 0; i < targets.length; i++) {
            const post = targets[i];
            try {
                await gotoAndSettle(page, post.url);
                const reactionsCount = await reactions.extractReactionsCount(page);

                const opened = await reactions.openReactionsDialog(page);
                if (!opened) {
                    logger.warn(`${i + 1}/${targets.length}: dialog did not open — skipping.`);
                    continue;
                }
                const container = await reactions.findScrollableContainer(page);
                if (!container) {
                    logger.warn(`${i + 1}/${targets.length}: no scrollable container — skipping.`);
                    await reactions.closeReactionsDialog(page);
                    continue;
                }

                const result = await reactions.countUninvitedReactors(page, reactions.INVITE_SELECTORS);
                await reactions.closeReactionsDialog(page);

                const fresh = scraper.loadPostList();
                const freshPost = fresh.posts.find((p) => p.url === post.url);
                if (freshPost) {
                    freshPost.reactionsCount = reactionsCount;
                    freshPost.lastAuditUninvitedCount = result.uninvitedCount;
                    freshPost.lastAuditAt = Date.now();
                    scraper.savePostList(fresh);
                }

                logger.info(
                    `${i + 1}/${targets.length}: reactions=${reactionsCount ?? "?"} ` +
                    `seen=${result.totalReactorsSeen} uninvited=${result.uninvitedCount} ` +
                    `(${post.date}, ${post.url.slice(0, 70)})`,
                );

                if (result.uninvitedCount > 0) {
                    totalUninvited += result.uninvitedCount;
                    postsWithGaps++;
                    flagged.push({ url: post.url, date: post.date, uninvited: result.uninvitedCount });
                }
            } catch (err) {
                logger.error(`${i + 1}/${targets.length}: error — ${err.message}`);
            }
        }

        logger.info(`\n=== AUDIT COMPLETE ===`);
        logger.info(`Posts checked: ${targets.length}`);
        logger.info(`Posts with uninvited people found: ${postsWithGaps}`);
        logger.info(`Total uninvited people found across all checked posts: ${totalUninvited}`);
        if (flagged.length > 0) {
            logger.info(`Flagged posts:`);
            for (const f of flagged) logger.info(`  ${f.uninvited} uninvited — ${f.date} — ${f.url}`);
        }
    } finally {
        if (browser) await browser.close();
        releaseLock();
    }
})();
