/**
 * inviter.js — The brains of the operation.
 *
 * This file is like a robot that:
 *   1. Opens a hidden web browser (Chrome)
 *   2. Goes to a Facebook post
 *   3. Looks for "Invite" or "Pozvat" buttons
 *   4. Clicks them one by one
 *   5. Writes down what it did
 *
 * It uses Puppeteer, which is a library that lets code control a browser.
 * Think of it like a puppeteer controlling a puppet, but the puppet is Chrome.
 */

const puppeteer = require("puppeteer");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const logger = require("./logger");
const storage = require("./storage");
const session = require("./session");

// ──────────────────────────────────────────────
// SETTINGS — The button types we're looking for
// ──────────────────────────────────────────────

/**
 * These are CSS selectors (like search patterns for HTML elements).
 * They look for buttons that say "Pozvat" (Czech for "Invite") or "Invite".
 *
 * Facebook uses aria-label to label buttons for screen readers.
 * We search by that label to find the right buttons to click.
 *
 * Each selector targets a different HTML tag that Facebook might use:
 *   - div[aria-label="Pozvat"][role="button"]  — a <div> acting as a button
 *   - button[aria-label="Pozvat"]               — a real <button> element
 *   - a[role="button"][aria-label*="Pozvat"]    — a <a> link acting as a button
 *
 * Same three patterns again but for English ("Invite").
 */
const DEFAULT_SELECTORS = [
    // Czech: "Pozvat" = "Invite"
    'div[aria-label="Pozvat"][role="button"]',
    'button[aria-label="Pozvat"]',
    'a[role="button"][aria-label*="Pozvat"]',

    // English: "Invite"
    'div[aria-label="Invite"][role="button"]',
    'button[aria-label="Invite"]',
    'a[role="button"][aria-label*="Invite"]',
];

// ──────────────────────────────────────────────
// STEP 1: Launch the browser
// ──────────────────────────────────────────────

/**
 * Opens a hidden Chrome browser.
 *
 * @param {object} options
 * @param {string} [options.profileDir] — Path to a Chrome profile folder (so we stay logged in)
 * @param {boolean} [options.headless=true] — True = invisible browser, False = you can see it
 * @returns {Promise<object>} browser — The browser object we can control
 */
async function launchBrowser({ profileDir, headless }) {
    const launchOptions = session.getLaunchOptions(profileDir, headless);
    logger.info(
        `Launching browser with options: ${JSON.stringify(launchOptions)}`,
    );
    return await puppeteer.launch(launchOptions);
}

// ──────────────────────────────────────────────
// STEP 2: Set up a page and go to the URL
// ──────────────────────────────────────────────

/**
 * Creates a new browser tab, sets up the user agent (so Facebook thinks
 * it's a real browser), and navigates to the post URL.
 *
 * @param {object} browser — The puppeteer browser
 * @param {string} url — The Facebook post URL to visit
 * @returns {Promise<object>} page — The page object (like a browser tab)
 */
async function createPageAndNavigate(browser, url) {
    const page = await browser.newPage();
    logger.info(
        `Opened new page in browser version: ${await browser.version()}`,
    );

    // Set a fake user-agent so Facebook doesn't know it's a robot
    await page.setUserAgent(
        process.env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64)",
    );

    logger.info(`Navigating to ${url}`);

    // Go to the URL and wait for everything to finish loading
    const response = await page.goto(url, {
        waitUntil: "networkidle2", // Wait until no network activity for 500ms
        timeout: 60000, // Give up after 60 seconds
    });

    logger.info(
        `Navigation finished: status=${response ? response.status() : "n/a"}, finalUrl=${page.url()}`,
    );

    return page;
}

// ──────────────────────────────────────────────
// STEP 3: Force a light background (fixes dark mode issues)
// ──────────────────────────────────────────────

/**
 * Facebook sometimes shows a black background in headless mode.
 * This makes text unreadable. So we inject CSS (style rules) that
 * forces everything to have a white background and dark text.
 *
 * It's like turning off "dark mode" even if Facebook thinks it's on.
 *
 * @param {object} page — The browser page
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
        .catch(() => {}); // If it fails, no big deal
}

// ──────────────────────────────────────────────
// STEP 4: Wait for the page to finish rendering
// ──────────────────────────────────────────────

/**
 * Facebook loads stuff slowly. This waits a bit so all the buttons
 * have time to appear on the page.
 *
 * @param {object} page — The browser page
 */
async function waitForPageToSettle(page) {
    // Log the page title so we know we're on the right page
    const title = await page.title().catch(() => "n/a");
    logger.info(`Page title: ${title}`);

    // Wait 2 seconds for dynamic content (stuff that loads after the page)
    await page.waitForTimeout(2000);
}

// ──────────────────────────────────────────────
// STEP 5: Scan the page — count and log all invite buttons
// ──────────────────────────────────────────────

/**
 * Looks through the page for all buttons matching our selectors.
 * Doesn't click anything — just counts them and logs some examples
 * so we can see what the robot found.
 *
 * @param {object} page — The browser page
 * @param {string[]} selectors — CSS selectors to search for
 * @returns {Promise<object[]>} stats — Info about each selector (count, samples)
 */
async function scanInviteButtons(page, selectors) {
    const stats = await page.evaluate((sels) => {
        return sels.map((selector) => {
            // Find all elements matching this selector
            const matches = Array.from(document.querySelectorAll(selector));

            return {
                selector,
                count: matches.length,
                // Show the first 3 matches so we can see what they look like
                samples: matches.slice(0, 3).map((element) => ({
                    ariaLabel: element.getAttribute("aria-label"),
                    text: (element.textContent || "")
                        .replace(/\s+/g, " ")
                        .trim(),
                    tagName: element.tagName,
                })),
            };
        });
    }, selectors);

    logger.info(`Selector scan: ${JSON.stringify(stats)}`);
    return stats;
}

// ──────────────────────────────────────────────
// STEP 6: Collect + deduplicate matching buttons
// ──────────────────────────────────────────────

/**
 * Runs INSIDE the browser page (via page.evaluate).
 * Finds all buttons matching our selectors, removes duplicates,
 * and returns them as a flat array.
 *
 * @param {string[]} selectors — CSS selectors to search for
 * @returns {HTMLElement[]} — Unique matching elements
 */
function findAllMatchingElements(selectors) {
    const els = [];
    selectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((e) => els.push(e));
    });
    // Remove duplicates (same element matched by different selectors)
    return Array.from(new Set(els));
}

// ──────────────────────────────────────────────
// STEP 7: Click all the buttons (inside the browser)
// ──────────────────────────────────────────────

/**
 * This runs INSIDE the browser tab (not in Node.js).
 * It's like sending a little robot into the page to do the clicking.
 *
 * For each button it finds:
 *   1. Scroll to it (so it's visible on screen)
 *   2. Click it
 *   3. Mark it as "done" (so we don't click it twice)
 *   4. Wait a bit (so Facebook doesn't think we're a spam bot)
 *
 * @param {string[]} selectors — CSS selectors to find buttons
 * @param {number} max — Stop after this many clicks
 * @param {number} delay — Wait this many ms between clicks (random extra 0-500ms added)
 * @returns {Promise<object>} result — { clickedCount, matchedCount }
 */
async function clickInviteButtonsInPage(selectors, max, delay) {
    // ── Helper: pause for a bit ──
    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // Find all unique buttons
    const uniq = findAllMatchingElements(selectors);
    let clickedCount = 0;

    for (const el of uniq) {
        try {
            // Skip buttons we've already clicked
            if (el.getAttribute("data-invited") === "true") continue;

            // Scroll the button into view
            el.scrollIntoView({
                block: "center",
                inline: "center",
            });

            // Click it
            el.click();

            // Mark it so we don't click it again
            el.setAttribute("data-invited", "true");
            clickedCount++;

            // Wait a random time (delay + up to 500ms extra)
            // This mimics human behavior — bots click at the exact same speed
            await sleep(delay + Math.floor(Math.random() * 500));

            // Stop if we've done enough
            if (clickedCount >= max) break;
        } catch (e) {
            // If one button fails (e.g. it disappeared), skip it and move on
        }
    }

    return { clickedCount, matchedCount: uniq.length };
}

// ──────────────────────────────────────────────
// LOGIN MODE: Let you log in manually
// ──────────────────────────────────────────────

/**
 * Opens the browser and lets you log in to Facebook manually.
 * The browser shows up on your screen (not hidden) so you can see it.
 * Once logged in, press Enter in the terminal. The session saves to the profile folder.
 *
 * @param {object} page — The browser page (already on Facebook)
 */
async function waitForManualLogin(page) {
    logger.info("=".repeat(60));
    logger.info("FACEBOOK LOGIN — Browser is now open on your screen.");
    logger.info("1. Log in to Facebook in that browser window.");
    logger.info("2. Come back to this terminal.");
    logger.info("3. Press ENTER to save the session and close the browser.");
    logger.info("=".repeat(60));

    const rl = readline.createInterface({
        input: stdin,
        output: stdout,
    });
    await rl.question("");
    rl.close();

    logger.info("Login session saved. You can now run the tool without --wait-for-login.");
}

// ──────────────────────────────────────────────
// THE MAIN FUNCTION — Ties everything together
// ──────────────────────────────────────────────

/**
 * This is the big boss function. It's what index.js calls.
 *
 * Think of it like a recipe:
 *   1. Heat up the oven     → launch the browser
 *   2. Put the pan in       → open a new tab
 *   3. Go to the right page → navigate to the Facebook post
 *   4. If login mode        → wait for you to press Enter, then exit
 *   5. Fix the lighting     → force light mode
 *   6. Let it preheat       → wait for stuff to load
 *   7. Count the cookies    → scan for buttons
 *   8. Eat the cookies      → click the buttons
 *   9. Write it down        → save what we did
 *  10. Clean up             → close the browser
 *
 * @param {object} options
 * @param {string} options.url — Facebook post URL
 * @param {number} [options.max=1000] — Max invites
 * @param {number} [options.delay=1000] — Delay between clicks (ms)
 * @param {string} [options.profileDir] — Chrome profile folder
 * @param {boolean} [options.headless=true] — Run invisible
 * @param {boolean} [options.waitForLogin=false] — Just log in, don't run automation
 * @returns {Promise<number>} count — How many buttons were clicked (0 if login mode)
 */
async function runWithBrowser({
    url,
    max = 1000,
    delay = 1000,
    profileDir,
    headless = true,
    waitForLogin = false,
}) {
    // ── Login mode: force the browser to show so you can see it ──
    const isLoginMode = waitForLogin === true;
    const effectiveHeadless = isLoginMode ? false : headless;

    // ── Step 1: Launch the browser ──
    const browser = await launchBrowser({ profileDir, headless: effectiveHeadless });

    let count = 0;

    try {
        // ── Step 2: Open a tab and go to the page ──
        const page = await createPageAndNavigate(browser, url);

        // ── Step 3: If login mode, pause and wait for you ──
        if (isLoginMode) {
            await waitForManualLogin(page);
            return 0; // Exit early — no automation, just saving session
        }

        // ── Step 4: Fix dark mode issues ──
        await forceLightColorScheme(page);

        // ── Step 5: Wait for everything to load ──
        await waitForPageToSettle(page);

        // ── Step 6: Look for invite buttons (just counting, not clicking) ──
        await scanInviteButtons(page, DEFAULT_SELECTORS);

        // ── Step 7: Actually click the buttons ──
        // This runs INSIDE the browser (like sending a little robot in)
        const result = await page.evaluate(
            clickInviteButtonsInPage,
            DEFAULT_SELECTORS,
            max,
            delay,
        );

        // ── Step 8: Read the result ──
        count =
            result && typeof result === "object"
                ? result.clickedCount || 0
                : result || 0;
        const matchedCount =
            result && typeof result === "object" ? result.matchedCount || 0 : 0;

        logger.info(
            `Matched ${matchedCount} candidate elements and clicked ${count} buttons`,
        );

        // ── Step 9: Save to history ──
        await storage.saveHistory(url, count);
    } catch (err) {
        logger.error("Error in inviter run: " + err.message);
        throw err;
    } finally {
        // ── Step 10: Close the browser (always runs, even if something broke) ──
        await browser.close();
    }

    return count;
}

// ──────────────────────────────────────────────
// EXPORT — Make the main function available to other files
// ──────────────────────────────────────────────
module.exports = { runWithBrowser };