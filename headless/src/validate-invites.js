/**
 * validate-invites.js — Quick read-only validation script.
 *
 * Scrolls through a post's reactions list as fast as reasonably possible
 * WITHOUT clicking anything, counting distinct people who still show an
 * Invite/Pozvat button, plus the post's total reaction count. Reuses
 * reactions.js's countUninvitedReactors/extractReactionsCount (not its
 * own duplicated scan logic — an earlier version of this file predated
 * the double-confirmation end-of-list fix and had drifted out of sync).
 *
 * Usage: node src/validate-invites.js "<post-or-insights-url>"
 */

const puppeteer = require("puppeteer");
const session = require("./session");
const reactions = require("./reactions");
const scraper = require("./scraper");

async function main() {
    const postUrl = process.argv[2];
    if (!postUrl) {
        console.error('Usage: node src/validate-invites.js "<post-or-insights-url>"');
        process.exit(1);
    }

    const opts = session.getLaunchOptions(
        process.env.PROFILE_DIR || "./profile",
        process.env.HEADLESS === "false" ? false : "new",
    );
    const browser = await puppeteer.launch(opts);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    console.log(`Navigating to: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000));

    await page.evaluate(() => {
        const keywords = ["decline optional cookies", "allow all cookies"];
        for (const el of document.querySelectorAll('[role="button"], button')) {
            const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
            if (keywords.some((k) => label === k || label.includes(k))) { el.click(); return; }
        }
    });
    await new Promise((r) => setTimeout(r, 1000));

    const reactionsCount = await reactions.extractReactionsCount(page);
    console.log(`Reactions shown on post: ${reactionsCount === null ? "(not found)" : reactionsCount}`);

    const opened = await reactions.openReactionsDialog(page);
    if (!opened) {
        console.log("RESULT: could not open reactions dialog.");
        await browser.close();
        return;
    }

    const container = await reactions.findScrollableContainer(page);
    if (!container) {
        console.log("RESULT: no scrollable container found.");
        await browser.close();
        return;
    }

    const result = await reactions.countUninvitedReactors(page, reactions.INVITE_SELECTORS);

    console.log(`Total scrolls performed: ${result.scrolls}`);
    console.log(`Total distinct reactors seen (any type, invited or not): ${result.totalReactorsSeen}`);
    console.log(`RESULT: ${result.uninvitedCount} distinct people still show an Invite/Pozvat button.`);

    if (process.env.SAVE_TO_POSTS_JSON === "1") {
        const data = scraper.loadPostList();
        const post = data.posts.find((p) => p.url === postUrl);
        if (post) {
            post.reactionsCount = reactionsCount;
            post.lastAuditUninvitedCount = result.uninvitedCount;
            post.lastAuditAt = Date.now();
            scraper.savePostList(data);
            console.log("Saved reactionsCount / lastAuditUninvitedCount to posts.json.");
        } else {
            console.log("Post not found in posts.json — skipped saving audit fields.");
        }
    }

    await browser.close();
}

main().catch((err) => {
    console.error("Validation script error:", err);
    process.exit(1);
});
