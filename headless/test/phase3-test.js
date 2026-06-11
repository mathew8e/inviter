/**
 * Phase 2+3 integration test — Auth + Scraper against real Facebook.
 *
 * Usage:
 *   node test/phase3-test.js --page "https://www.facebook.com/YOUR_PAGE"
 *
 * What it does:
 *   1. Launches Chrome with your saved profile
 *   2. Verifies Facebook login is still valid
 *   3. Scrapes the page feed for posts
 *   4. Saves results to data/posts.json
 *   5. Prints a summary
 *
 * THIS IS READ-ONLY. No buttons are clicked, no invites are sent.
 * It only reads the page feed and extracts post URLs + dates.
 */

const puppeteer = require("puppeteer");
const fs = require("fs");

const config = require("../src/config");
const logger = require("../src/logger");
const session = require("../src/session");
const auth = require("../src/auth");
const scraper = require("../src/scraper");

// ── Parse CLI ──
const args = process.argv.slice(2);
let pageUrl = config.fbPageUrl || "";
let maxPosts = config.maxPostsPerRun;
let dateFrom = config.dateFrom;
let headless = config.headless;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--page" && args[i + 1]) {
        pageUrl = args[i + 1];
        i++;
    } else if (args[i] === "--max" && args[i + 1]) {
        maxPosts = parseInt(args[i + 1], 10);
        i++;
    } else if (args[i] === "--date-from" && args[i + 1]) {
        dateFrom = args[i + 1];
        i++;
    } else if (args[i] === "--visible") {
        headless = false;
    }
}

// ── Validate ──
if (!pageUrl) {
    console.error("ERROR: No page URL provided.");
    console.error("  Set FB_PAGE_URL in .env OR pass --page \"https://...\"");
    console.error("");
    console.error("Usage:");
    console.error("  node test/phase3-test.js --page \"https://www.facebook.com/YOUR_PAGE\"");
    console.error("  node test/phase3-test.js --page \"https://...\" --date-from 2026-01-01 --max 20");
    console.error("  node test/phase3-test.js --page \"https://...\" --visible  (show browser)");
    process.exit(1);
}

// ── Main ──
async function main() {
    logger.info("=".repeat(60));
    logger.info("PHASE 2+3 TEST — Auth + Post Discovery");
    logger.info(`Page:      ${pageUrl}`);
    logger.info(`Max posts: ${maxPosts}`);
    logger.info(`Date from: ${dateFrom}`);
    logger.info(`Headless:  ${headless}`);
    logger.info(`Profile:   ${config.profileDir}`);
    logger.info("=".repeat(60));

    // ── Launch browser ──
    const launchOptions = session.getLaunchOptions(config.profileDir, headless);
    logger.info("Launching browser...");
    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    try {
        // ── Phase 2: Auth ──
        logger.info("");
        logger.info("── Phase 2: Auth ──");

        auth.setupNavigationWatcher(page);

        const loggedIn = await auth.ensureLoggedIn(page);
        if (!loggedIn) {
            logger.error("Not logged in. Session may have expired.");
            return;
        }

        const pageOk = await auth.navigateToPage(page, pageUrl);
        if (!pageOk) {
            logger.error("Page did not load correctly. Check FB_PAGE_URL.");
            return;
        }

        // ── Phase 3: Scrape ──
        logger.info("");
        logger.info("── Phase 3: Post Discovery ──");

        const posts = await scraper.discoverPosts(
            page,
            pageUrl,
            dateFrom,
            config.dateTo,
            maxPosts,
        );

        // ── Summary ──
        logger.info("");
        logger.info("=".repeat(60));
        logger.info(`RESULTS: ${posts.length} posts discovered`);
        logger.info("=".repeat(60));

        if (posts.length === 0) {
            console.log("");
            console.log("No posts found. Possible reasons:");
            console.log("  1. The page URL is wrong or inaccessible");
            console.log("  2. The session has expired (try --wait-for-login again)");
            console.log("  3. Facebook changed its DOM structure");
            console.log("  4. The page has no posts visible in the feed");
            console.log("");
            console.log("Check data/posts.json — if empty, try with --visible to debug.");
        } else {
            console.log("");
            console.log("Posts saved to data/posts.json");
            console.log("");
            console.log("Sample posts:");
            for (const post of posts.slice(0, 10)) {
                console.log(`  ${post.date}  ${post.url}`);
            }
            if (posts.length > 10) {
                console.log(`  ... and ${posts.length - 10} more`);
            }
        }

        console.log("");
        console.log("── NEXT STEPS ──");
        console.log("  1. Inspect data/posts.json — check if URLs and dates look correct");
        console.log("  2. If most dates are 'unknown', the timestamp extraction needs fixing");
        console.log("  3. If no posts found, run with --visible to see what happens");
        console.log("  4. Once posts look good, proceed to Phase 4 (mock HTML)");

    } catch (err) {
        if (err instanceof auth.SessionExpiredError) {
            logger.error("SESSION EXPIRED: " + err.message);
            console.log("");
            console.log("── FIX ──");
            console.log("  On a machine WITH a display:");
            console.log("    node src/index.js --wait-for-login --profile-dir ./profile");
            console.log("  Then copy ./profile/ back to this machine.");
        } else {
            logger.error("Test failed: " + err.message);
            console.error(err);
        }
    } finally {
        logger.info("Closing browser...");
        await browser.close();
        logger.info("Done.");
    }
}

main();
