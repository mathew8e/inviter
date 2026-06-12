/**
 * Phase 4 test — reactions.js (mock HTML + optional live test)
 *
 * Two modes:
 *   1. Unit tests (default): Launches a minimal Puppeteer page, injects mock HTML,
 *      and tests element selection, dedup logic, and scroll behavior.
 *      NO real Facebook involved.
 *
 *   2. Live test:      node test/phase4-test.js --live --url "https://..."
 *      Opens a real Facebook post's reactions dialog in dry-run mode.
 *      No buttons are actually clicked. Verifies the dialog opens correctly.
 */

const puppeteer = require("puppeteer");
const config = require("../src/config");
const logger = require("../src/logger");
const session = require("../src/session");
const reactions = require("../src/reactions");

// ── Parse CLI ──
const args = process.argv.slice(2);
let mode = "unit";
let liveUrl = "";
let headless = true;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live") {
        mode = "live";
    } else if (args[i] === "--url" && args[i + 1]) {
        liveUrl = args[i + 1];
        i++;
    } else if (args[i] === "--visible") {
        headless = false;
    }
}

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

// Helper: set up a fresh mock page and wait for DOM stability
async function resetMockPage(page, html) {
    await page.setContent(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><title>Phase 4 Mock</title></head>
        <body>${html}</body>
        </html>
    `);
    // Wait for DOM to fully settle
    await new Promise((r) => setTimeout(r, 800));
}

// ──────────────────────────────────────────────
// UNIT TESTS
// ──────────────────────────────────────────────

async function runUnitTests() {
    console.log("=".repeat(60));
    console.log("PHASE 4 — UNIT TESTS (mock HTML)");
    console.log("=".repeat(60));
    console.log("");

    const launchOptions = session.getLaunchOptions(config.profileDir, headless);
    launchOptions.headless = headless ? "new" : false;

    console.log("Launching browser for unit tests...");
    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    try {
        // ────────────────────────────────────
        // GROUP 1: Selector Matching
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 1: Selector Matching ──\n");

        await resetMockPage(page, reactions.getMockReactionsDialogHtml());

        await test("INVITE_SELECTORS find all 5 Pozvat/Invite buttons (not Following)", async () => {
            const selStr = reactions.INVITE_SELECTORS.join(", ");
            const count = await page.evaluate((s) => {
                return document.querySelectorAll(s).length;
            }, selStr);
            assert(count === 5, `Expected 5 invite buttons, found ${count}`);
        });

        await test("TEST_SELECTORS match Follow/Sledovat buttons", async () => {
            await resetMockPage(page, `
                <div role="dialog">
                    <div aria-label="Sledovat" role="button">Sledovat</div>
                    <button aria-label="Follow">Follow</button>
                    <button aria-label="Sledovat">Sledovat</button>
                    <div aria-label="Following" role="button">Following</div>
                </div>
            `);
            const selStr = reactions.TEST_SELECTORS.join(", ");
            const count = await page.evaluate((s) => document.querySelectorAll(s).length, selStr);
            assert(count === 3, `Expected 3 Follow buttons, found ${count}`);
        });

        // ────────────────────────────────────
        // GROUP 2: Scrollable Container
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 2: Scrollable Container Detection ──\n");

        await resetMockPage(page, reactions.getMockReactionsDialogHtml());

        await test("findScrollableContainer detects overflow-y: scroll", async () => {
            const container = await reactions.findScrollableContainer(page);
            assert(container !== null, "Should find a scrollable container");
            assert(container.inviteCount >= 3, `Expected >=3 invite buttons, got ${container.inviteCount}`);
        });

        await test("scrollable container contains invite buttons in DOM", async () => {
            const selStr = reactions.INVITE_SELECTORS.join(", ");
            const hasButtons = await page.evaluate((s) => {
                const dialog = document.querySelector('[role="dialog"]');
                if (!dialog) return false;
                const buttons = dialog.querySelectorAll(s);
                return buttons.length > 0;
            }, selStr);
            assert(hasButtons, "Dialog should contain invite buttons");
        });

        // ────────────────────────────────────
        // GROUP 3: data-invited Dedup
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 3: data-invited Dedup ──\n");

        await resetMockPage(page, reactions.getMockReactionsDialogHtml());

        await test("buttons can be marked with data-invited='true'", async () => {
            const selStr = reactions.INVITE_SELECTORS.join(", ");
            const marked = await page.evaluate((s) => {
                const buttons = document.querySelectorAll(s);
                let count = 0;
                for (const btn of buttons) {
                    if (count < 3) {
                        btn.setAttribute("data-invited", "true");
                        count++;
                    }
                }
                return count;
            }, selStr);
            assert(marked === 3, `Expected 3 marked, got ${marked}`);
        });

        await test("marked buttons are excluded from uninvited count", async () => {
            const selStr = reactions.INVITE_SELECTORS.join(", ");
            const counts = await page.evaluate((s) => {
                const all = document.querySelectorAll(s);
                let total = 0, uninvited = 0;
                for (const el of all) {
                    total++;
                    if (el.getAttribute("data-invited") !== "true") uninvited++;
                }
                return { total, uninvited };
            }, selStr);
            assert(counts.total === 5, `Expected 5 total, got ${counts.total}`);
            assert(counts.uninvited === 2, `Expected 2 uninvited, got ${counts.uninvited}`);
        });

        // ────────────────────────────────────
        // GROUP 4: Dry Run
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 4: Dry Run (no clicks) ──\n");

        await resetMockPage(page, reactions.getMockReactionsDialogHtml());

        await test("dryRun does NOT persist data-invited markers", async () => {
            const container = await reactions.findScrollableContainer(page);
            assert(container !== null, "Need container for dryRun test");

            let result;
            try {
                result = await reactions.scrollAndInvite(
                    page, container, 3, 100,
                    true, // dryRun
                    reactions.INVITE_SELECTORS,
                );
            } catch (err) {
                throw new Error(`scrollAndInvite threw: ${err.message}`);
            }

            assert(result.invited > 0, `Expected some invites counted, got ${result.invited}`);

            // Verify no data-invited markers were actually persisted
            const selStr = reactions.INVITE_SELECTORS.join(", ");
            const markedCount = await page.evaluate((s) => {
                const all = document.querySelectorAll(s);
                let marked = 0;
                for (const el of all) {
                    if (el.getAttribute("data-invited") === "true") marked++;
                }
                return marked;
            }, selStr);
            assert(markedCount === 0, `Expected 0 marked in dryRun, got ${markedCount}`);
        });

        // ────────────────────────────────────
        // GROUP 5: Real Run (non-dryRun marks buttons)
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 5: Real run marks buttons ──\n");

        await resetMockPage(page, reactions.getMockReactionsDialogHtml());

        await test("non-dryRun DOES mark buttons with data-invited", async () => {
            const container = await reactions.findScrollableContainer(page);
            assert(container !== null, "Need container for real-run test");

            let result;
            try {
                result = await reactions.scrollAndInvite(
                    page, container, 3, 100,
                    false, // NOT dryRun
                    reactions.INVITE_SELECTORS,
                );
            } catch (err) {
                throw new Error(`scrollAndInvite threw: ${err.message}`);
            }

            assert(result.invited >= 3, `Expected >=3 invited, got ${result.invited}`);

            // Verify buttons were marked
            const selStr = reactions.INVITE_SELECTORS.join(", ");
            const markedCount = await page.evaluate((s) => {
                const all = document.querySelectorAll(s);
                let marked = 0;
                for (const el of all) {
                    if (el.getAttribute("data-invited") === "true") marked++;
                }
                return marked;
            }, selStr);
            assert(markedCount >= 3, `Expected >=3 marked, got ${markedCount}`);
        });

        // ────────────────────────────────────
        // GROUP 6: maxInvites Limit
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 6: maxInvites limit ──\n");

        await resetMockPage(page, reactions.getMockReactionsDialogHtml());

        await test("scrollAndInvite respects maxInvites=2 limit", async () => {
            const container = await reactions.findScrollableContainer(page);
            assert(container !== null, "Need container");

            const result = await reactions.scrollAndInvite(
                page, container, 2, 100, false,
                reactions.INVITE_SELECTORS,
            );

            assert(result.invited <= 2, `Expected <=2, got ${result.invited}`);
            assert(result.reason === "per_post_limit",
                `Expected per_post_limit, got ${result.reason}`);
        });

        // ────────────────────────────────────
        // GROUP 7: Large Dialog Termination
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 7: Large dialog scroll termination ──\n");

        await resetMockPage(page, reactions.getLargeMockDialogHtml());

        await test("scroll terminates on large dialog after processing all buttons", async () => {
            const container = await reactions.findScrollableContainer(page);
            assert(container !== null, "Need container for large dialog");

            const result = await reactions.scrollAndInvite(
                page, container,
                100, // high limit so termination, not limit, is tested
                50,  // fast delay for test speed
                false,
                reactions.INVITE_SELECTORS,
            );

            assert(result.invited > 0, "Should have invited at least some users");
            assert(result.invited <= 30, `Should not exceed 30 users, got ${result.invited}`);
            console.log(`  INFO: Terminated with reason="${result.reason}" after ${result.invited} invites`);
        });

        // ────────────────────────────────────
        // GROUP 8: Following button exclusion
        // ────────────────────────────────────
        console.log("\n── TEST GROUP 8: Following button excluded ──\n");

        await resetMockPage(page, reactions.getMockReactionsDialogHtml());

        await test("Following (already-following) button does NOT match INVITE_SELECTORS", async () => {
            const selStr = reactions.INVITE_SELECTORS.join(", ");
            const followingMatched = await page.evaluate((s) => {
                const all = document.querySelectorAll(s);
                for (const el of all) {
                    const label = (el.getAttribute("aria-label") || "");
                    if (label === "Following") return true;
                }
                return false;
            }, selStr);
            assert(!followingMatched, "Following button should NOT match INVITE_SELECTORS");
        });

        console.log("");

    } finally {
        await browser.close();
    }
}

// ──────────────────────────────────────────────
// LIVE TEST (real Facebook — dry run only)
// ──────────────────────────────────────────────

async function runLiveTest() {
    if (!liveUrl) {
        console.error("ERROR: --live requires --url \"https://www.facebook.com/...\"");
        console.error("  node test/phase4-test.js --live --url \"https://...\"");
        console.error("  node test/phase4-test.js --live --url \"https://...\" --visible");
        process.exit(1);
    }

    console.log("=".repeat(60));
    console.log("PHASE 4 — LIVE TEST (dry run on real Facebook post)");
    console.log("=".repeat(60));
    console.log(`Post URL:  ${liveUrl}`);
    console.log(`Headless:  ${headless}`);
    console.log(`Profile:   ${config.profileDir}`);
    console.log("");
    console.log("WARNING: DRY RUN only — no buttons will be clicked.");
    console.log("=".repeat(60));
    console.log("");

    const launchOptions = session.getLaunchOptions(config.profileDir, headless);
    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    try {
        logger.info(`Navigating to post: ${liveUrl}`);
        await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 4000));

        const currentUrl = page.url();
        logger.info(`Current URL: ${currentUrl}`);

        if (currentUrl.includes("/login/") || currentUrl.includes("login.php")) {
            console.log("ERROR: Redirected to login. Session may have expired.");
            return;
        }

        console.log("\n── Step 1: Opening reactions dialog ──");
        const opened = await reactions.openReactionsDialog(page);
        console.log(opened ? "  PASS: Dialog opened" : "  FAIL: Could not open dialog");

        if (!opened) {
            console.log("Possible causes: wrong URL, no reactions, session expired, FB DOM changed");
            return;
        }

        console.log("\n── Step 2: Finding scrollable container ──");
        const container = await reactions.findScrollableContainer(page);
        if (container) {
            console.log(`  PASS: <${container.tag}> h=${container.clientHeight}px invites=${container.inviteCount}`);
        } else {
            console.log("  FAIL: No container found");
            return;
        }

        console.log("\n── Step 3: Scanning for buttons (dry run) ──");
        const selStr = reactions.INVITE_SELECTORS.join(", ");
        const scanResult = await page.evaluate((s) => {
            const all = document.querySelectorAll(s);
            const visible = [];
            for (const el of all) {
                if (el.offsetParent !== null) {
                    visible.push({
                        label: (el.getAttribute("aria-label") || "").trim(),
                        tag: el.tagName.toLowerCase(),
                    });
                }
            }
            return { total: all.length, visibleCount: visible.length, sample: visible.slice(0, 5) };
        }, selStr);

        console.log(`  Total invite-like: ${scanResult.total}`);
        console.log(`  Visible: ${scanResult.visibleCount}`);
        for (const btn of scanResult.sample) {
            console.log(`    <${btn.tag}> "${btn.label}"`);
        }

        console.log("\n── Step 4: Dry-run scroll (1 iteration) ──");
        if (container) {
            const dryResult = await reactions.scrollAndInvite(
                page, container, 5, 100, true, reactions.INVITE_SELECTORS,
            );
            console.log(`  Would invite: ${dryResult.invited}, reason: ${dryResult.reason}`);
        }

        console.log("\n── Step 5: Closing dialog ──");
        await reactions.closeReactionsDialog(page);

        console.log("\nLIVE TEST COMPLETE. Next: Phase 5 (integration).");

    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    } finally {
        await browser.close();
    }
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
    if (mode === "live") {
        await runLiveTest();
    } else {
        await runUnitTests();
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
