// Quick spot-audit tool: checks ONE post — a random already-"done" one by
// default, or a specific URL/content_id passed as an argument — for real
// un-invited reactors, using the exact same accurate scan as every other
// path (no shortcuts on correctness), just at the fastest safe pace
// (aggressive rate mode). Built for manually sanity-checking the page
// owner's suspicion that "done" posts still have missed invites, without
// having to hunt through the dashboard for a candidate or wait for a full
// resweep pass to reach it.
//
// Usage:
//   node spot_check.js                    (random "done" post)
//   node spot_check.js <post_url_or_id>   (that specific post)
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
const { gotoAndSettle, blockUnnecessaryResources } = require("./src/inviter");

function pickTarget() {
    const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
    const allPosts = scraper.loadPostList().posts;

    if (arg) {
        const post = allPosts.find((p) => p.url === arg || p.id === arg || p.url.includes(arg));
        if (!post) {
            console.error(`No post found matching "${arg}".`);
            process.exit(1);
        }
        return post;
    }

    const candidates = allPosts.filter((p) => p.status === "done" && p.contentType !== "story");
    if (candidates.length === 0) {
        console.error("No \"done\" posts to spot-check.");
        process.exit(1);
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
}

(async () => {
    await storage.init();
    rateLimiter.acquireLock();
    let lockHeld = true;
    const releaseLock = () => { if (lockHeld) { rateLimiter.releaseLock(); lockHeld = false; } };
    process.once("SIGINT", () => { releaseLock(); process.exit(0); });
    process.once("SIGTERM", () => { releaseLock(); process.exit(0); });

    const target = pickTarget();
    console.log(`\nSpot-checking: ${target.url}`);
    console.log(`(date=${target.date}, status=${target.status}, previously invitedCount=${target.invitedCount || 0})\n`);

    const visible = process.argv.includes("--visible");
    let browser;
    try {
        const opts = session.getLaunchOptions("./profile", visible ? false : "new");
        browser = await puppeteer.launch(opts);
        const page = await browser.newPage();
        await page.setUserAgent(config.userAgent);
        await page.setViewport({ width: 1280, height: 900 });
        await blockUnnecessaryResources(page);
        await auth.ensureLoggedIn(page);
        auth.setupNavigationWatcher(page);

        await gotoAndSettle(page, target.url);
        await rateLimiter.detectRateLimit(page);

        const budget = rateLimiter.canInviteToday();
        const maxInvites = Math.min(config.perPostMax, budget.remaining);
        const result = await reactions.processPost(page, target.url, false, reactions.INVITE_SELECTORS, maxInvites);

        if (result.invited > 0) {
            rateLimiter.recordInvite(result.invited);
        }
        await storage.saveHistory(target.url, result.invited, {
            stoppedReason: result.reason,
            rateMode: "aggressive",
            dryRun: false,
            spotCheck: true,
        });

        const incomplete = [
            "post_time_cap", "per_post_limit", "error_mid_scan",
            "dialog_not_opened", "no_container_found", "no_budget",
        ].includes(result.reason);
        scraper.markPostStatus(target.url, {
            status: incomplete ? "pending" : "done",
            invitedCount: result.invited,
            error: null,
            hitPostTimeCap: result.reason === "post_time_cap",
        });

        console.log("\n=== SPOT-CHECK RESULT ===");
        console.log(`Post: ${target.url}`);
        console.log(`Newly found un-invited reactors: ${result.invited}`);
        console.log(`Stop reason: ${result.reason}`);
        console.log(
            result.invited > 0
                ? "-> Found real missed invites — this post was NOT actually fully covered."
                : "-> Nothing new found this pass.",
        );
    } catch (err) {
        console.error(`Spot-check failed: ${err.message}`);
    } finally {
        if (browser) await browser.close();
        releaseLock();
    }
})();
