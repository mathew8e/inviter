/**
 * Phase 5 test — inviter.js orchestration (unit tests + live dry-run)
 *
 * Two modes:
 *
 *   1. Unit tests (default): node test/phase5-test.js
 *      Uses a temp data directory — does NOT touch your real data/ folder,
 *      does NOT launch a browser, does NOT touch Facebook.
 *      Verifies: scraper.markPostStatus, rate-limiter round trip
 *      (budget/cooldown/lock), storage.saveHistory schema.
 *
 *   2. Live dry-run (real Facebook, but --dry-run is ALWAYS on here):
 *
 *        # Full page workflow — discovers posts, opens reactions dialogs,
 *        # scans for Invite/Pozvat buttons, but clicks NOTHING.
 *        node test/phase5-test.js --live --page "https://www.facebook.com/PAGE"
 *
 *        # Single post (e.g. your own profile post) — use TEST_SELECTORS
 *        # to scan for "Follow"/"Sledovat" instead of "Invite"/"Pozvat".
 *        node test/phase5-test.js --live --url "https://www.facebook.com/..." --test-selectors
 *
 *        # Show the browser window instead of running headless
 *        node test/phase5-test.js --live --page "..." --visible
 *
 *   This script NEVER sends real invites — it always forces dryRun: true.
 *   To do a real run, use src/index.js with --no-dry-run (see README/PLAN).
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

// ── Parse CLI (before requiring anything that reads env/config) ──
const args = process.argv.slice(2);
const mode = args.includes("--live") ? "live" : "unit";
const headless = !args.includes("--visible");
const useTestSelectors = args.includes("--test-selectors");

function argValue(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const livePageUrl = argValue("--page");
const liveUrl = argValue("--url");

// ── For unit mode, isolate all file I/O in a temp directory ──
let TMP_DIR;
if (mode === "unit") {
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "inviter-phase5-"));
    process.env.DATA_DIR = TMP_DIR;
    process.env.POSTS_PATH = path.join(TMP_DIR, "posts.json");
    process.env.RATE_LIMIT_PATH = path.join(TMP_DIR, "rate-limit-state.json");
    process.env.DB_PATH = path.join(TMP_DIR, "invitations.json");
    process.env.RATE_MODE = "paranoid";
}

const config = require("../src/config");
const logger = require("../src/logger");
const scraper = require("../src/scraper");
const rateLimiter = require("../src/rate-limiter");
const storage = require("../src/storage");
const reactions = require("../src/reactions");
const inviter = require("../src/inviter");

// ── Test harness ──
let failures = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL: ${name} — ${e.message}`);
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || "assertion failed");
}

// ──────────────────────────────────────────────
// UNIT TESTS
// ──────────────────────────────────────────────

async function runUnitTests() {
    console.log("=".repeat(60));
    console.log("PHASE 5 — UNIT TESTS (temp data dir, no browser, no Facebook)");
    console.log(`Temp dir: ${TMP_DIR}`);
    console.log("=".repeat(60));
    console.log("");

    // ────────────────────────────────────
    // GROUP 1: scraper.markPostStatus
    // ────────────────────────────────────
    console.log("\n── TEST GROUP 1: scraper.markPostStatus ──\n");

    const samplePost = {
        url: "https://www.facebook.com/testpage/posts/123",
        id: "123",
        timestamp: Date.now(),
        date: "2026-06-10",
        status: "pending",
        invitedCount: 0,
        processedAt: null,
        error: null,
    };

    scraper.savePostList({
        scrapedAt: Date.now(),
        pageUrl: "https://www.facebook.com/testpage",
        posts: [samplePost],
    });

    await test("markPostStatus updates status + invitedCount + processedAt", async () => {
        const ok = scraper.markPostStatus(samplePost.url, {
            status: "done",
            invitedCount: 7,
            error: null,
        });
        assert(ok === true, "markPostStatus should return true for existing post");

        const data = scraper.loadPostList();
        const post = data.posts.find((p) => p.url === samplePost.url);
        assert(post.status === "done", `Expected status "done", got "${post.status}"`);
        assert(post.invitedCount === 7, `Expected invitedCount 7, got ${post.invitedCount}`);
        assert(typeof post.processedAt === "number", "processedAt should be set");
        assert(post.error === null, `Expected error null, got ${post.error}`);
    });

    await test("markPostStatus accumulates invitedCount across calls", async () => {
        scraper.markPostStatus(samplePost.url, { invitedCount: 3 });
        const data = scraper.loadPostList();
        const post = data.posts.find((p) => p.url === samplePost.url);
        assert(post.invitedCount === 10, `Expected invitedCount 10 (7+3), got ${post.invitedCount}`);
    });

    await test("markPostStatus on unknown URL returns false", async () => {
        const ok = scraper.markPostStatus("https://www.facebook.com/does/not/exist", { status: "done" });
        assert(ok === false, "Expected false for unknown post URL");
    });

    // ────────────────────────────────────
    // GROUP 2: rate-limiter — budget + recording
    // ────────────────────────────────────
    console.log("\n── TEST GROUP 2: rate-limiter budget ──\n");

    await test("fresh state starts with full daily budget (paranoid = 100)", async () => {
        const budget = rateLimiter.canInviteToday();
        assert(budget.allowed === true, "Should be allowed with fresh state");
        assert(budget.remaining === 100, `Expected remaining=100, got ${budget.remaining}`);
    });

    await test("recordInvite decreases remaining budget", async () => {
        rateLimiter.recordInvite(30);
        const remaining = rateLimiter.getRemainingBudget();
        assert(remaining === 70, `Expected remaining=70 after recording 30, got ${remaining}`);
    });

    await test("canInviteToday reflects updated remaining budget", async () => {
        const budget = rateLimiter.canInviteToday();
        assert(budget.allowed === true, "Should still be allowed (70 remaining)");
        assert(budget.remaining === 70, `Expected remaining=70, got ${budget.remaining}`);
    });

    await test("daily limit reached blocks further invites", async () => {
        rateLimiter.recordInvite(70); // now at 100/100
        const budget = rateLimiter.canInviteToday();
        assert(budget.allowed === false, "Should NOT be allowed at 100/100");
        assert(budget.reason === "daily_limit_reached", `Expected daily_limit_reached, got ${budget.reason}`);
    });

    // ────────────────────────────────────
    // GROUP 3: rate-limiter — cooldown
    // ────────────────────────────────────
    console.log("\n── TEST GROUP 3: rate-limiter cooldown ──\n");

    await test("enterCooldown activates cooldown", async () => {
        rateLimiter.enterCooldown(48);
        assert(rateLimiter.isInCooldown() === true, "Should be in cooldown after enterCooldown(48)");
    });

    await test("canInviteToday blocked by cooldown", async () => {
        const budget = rateLimiter.canInviteToday();
        assert(budget.allowed === false, "Should NOT be allowed during cooldown");
        assert(budget.reason === "cooldown_active", `Expected cooldown_active, got ${budget.reason}`);
    });

    // ────────────────────────────────────
    // GROUP 4: rate-limiter — text scanning
    // ────────────────────────────────────
    console.log("\n── TEST GROUP 4: rate-limiter text scanning ──\n");

    await test("scanTextForRateLimit detects English rate-limit message", async () => {
        const match = rateLimiter.scanTextForRateLimit("You are doing that too much. Please try again later.");
        assert(match !== null, "Expected a pattern match");
    });

    await test("scanTextForRateLimit detects Czech rate-limit message", async () => {
        const match = rateLimiter.scanTextForRateLimit("Tato akce je dočasně zablokována.");
        assert(match !== null, "Expected a pattern match for Czech text");
    });

    await test("scanTextForRateLimit returns null for normal text", async () => {
        const match = rateLimiter.scanTextForRateLimit("Hello world, this is a normal Facebook post.");
        assert(match === null, `Expected null, got "${match}"`);
    });

    // ────────────────────────────────────
    // GROUP 5: rate-limiter — lock file
    // ────────────────────────────────────
    console.log("\n── TEST GROUP 5: lock file ──\n");

    await test("acquireLock succeeds when no lock exists", async () => {
        rateLimiter.acquireLock();
        assert(fs.existsSync(config.lockFilePath), "Lock file should exist after acquireLock");
    });

    await test("acquireLock throws when lock already held", async () => {
        let threw = false;
        try {
            rateLimiter.acquireLock();
        } catch (e) {
            threw = true;
            assert(/another run/i.test(e.message), `Unexpected error message: ${e.message}`);
        }
        assert(threw, "Second acquireLock() should throw");
    });

    await test("releaseLock removes the lock file", async () => {
        rateLimiter.releaseLock();
        assert(!fs.existsSync(config.lockFilePath), "Lock file should be gone after releaseLock");
    });

    await test("acquireLock works again after release", async () => {
        rateLimiter.acquireLock();
        assert(fs.existsSync(config.lockFilePath), "Lock file should exist again");
        rateLimiter.releaseLock();
    });

    // ────────────────────────────────────
    // GROUP 6: storage.saveHistory schema
    // ────────────────────────────────────
    console.log("\n── TEST GROUP 6: storage.saveHistory ──\n");

    await storage.init();

    await test("saveHistory writes a PLAN.md-shaped entry", async () => {
        const id = await storage.saveHistory("https://www.facebook.com/testpage/posts/123", 5, {
            stoppedReason: "completed_all_posts",
            rateMode: "paranoid",
            dryRun: false,
        });
        assert(typeof id === "number" && id > 0, `Expected positive id, got ${id}`);

        const history = storage.getHistory();
        const entry = history.find((e) => e.id === id);
        assert(entry !== undefined, "Entry should be findable by id");
        assert(entry.postUrl === "https://www.facebook.com/testpage/posts/123", "postUrl should match");
        assert(entry.invitedCount === 5, `Expected invitedCount=5, got ${entry.invitedCount}`);
        assert(entry.stoppedReason === "completed_all_posts", "stoppedReason should match");
        assert(entry.rateMode === "paranoid", "rateMode should match");
        assert(typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date), "date should be YYYY-MM-DD");
    });

    console.log("");
}

// ──────────────────────────────────────────────
// LIVE DRY-RUN TESTS (real Facebook, no clicks)
// ──────────────────────────────────────────────

async function runLiveTest() {
    console.log("=".repeat(60));
    console.log("PHASE 5 — LIVE DRY-RUN (real Facebook, dryRun forced ON)");
    console.log("=".repeat(60));
    console.log(`Headless: ${headless}`);
    console.log(`Profile:  ${config.profileDir}`);
    console.log("");

    if (livePageUrl) {
        console.log(`Mode: PAGE WORKFLOW`);
        console.log(`Page: ${livePageUrl}`);
        console.log("This will: verify login -> navigate to page -> discover posts ->");
        console.log("open reactions dialog on 1 post -> scan for Invite/Pozvat buttons (NO CLICKS).");
        console.log("");

        const summary = await inviter.runWithBrowser({
            pageUrl: livePageUrl,
            headless,
            dryRun: true, // forced — this test never clicks
            maxPosts: 1,
            selectors: useTestSelectors ? reactions.TEST_SELECTORS : reactions.INVITE_SELECTORS,
        });

        console.log("\n── Result ──");
        console.log(JSON.stringify(summary, null, 2));

        assert(typeof summary.postsDiscovered === "number", "summary.postsDiscovered should be a number");
        assert(summary.stoppedReason !== null, "summary.stoppedReason should be set");
        console.log("\n  PASS: page workflow ran end-to-end without throwing");
    } else if (liveUrl) {
        console.log(`Mode: SINGLE POST`);
        console.log(`URL:  ${liveUrl}`);
        console.log(`Selectors: ${useTestSelectors ? "TEST_SELECTORS (Follow/Sledovat)" : "INVITE_SELECTORS (Invite/Pozvat)"}`);
        console.log("This will: verify login -> open post -> open reactions dialog ->");
        console.log("scan for buttons (NO CLICKS).");
        console.log("");

        const summary = await inviter.runWithBrowser({
            url: liveUrl,
            headless,
            dryRun: true, // forced — this test never clicks
            selectors: useTestSelectors ? reactions.TEST_SELECTORS : reactions.INVITE_SELECTORS,
        });

        console.log("\n── Result ──");
        console.log(JSON.stringify(summary, null, 2));

        assert(summary.postsProcessed === 1, "Expected exactly 1 post processed");
        console.log("\n  PASS: single-post dry run completed without throwing");
    } else {
        console.error("ERROR: --live requires --page \"<facebook page url>\" or --url \"<facebook post url>\"");
        console.error("  node test/phase5-test.js --live --page \"https://www.facebook.com/PAGE\"");
        console.error("  node test/phase5-test.js --live --url \"https://www.facebook.com/...\" --test-selectors");
        process.exit(1);
    }
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
    if (mode === "live") {
        try {
            await runLiveTest();
        } catch (err) {
            failures++;
            console.log(`  FAIL: live test threw — ${err.message}`);
        }
    } else {
        await runUnitTests();
        // Clean up temp dir
        try {
            fs.rmSync(TMP_DIR, { recursive: true, force: true });
        } catch {}
    }

    console.log("=".repeat(60));
    if (failures === 0) {
        console.log("ALL TESTS PASSED ✓");
        process.exit(0);
    } else {
        console.log(`${failures} TEST(S) FAILED ✗`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
});
