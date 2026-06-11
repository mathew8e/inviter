/**
 * auth.js — Login verification, page navigation, mid-run session expiry detection.
 *
 * Phase 2 of the phased implementation plan.
 * Depends on: config.js, logger.js, session.js
 */

const logger = require("./logger");

// ──────────────────────────────────────────────
// Login indicators — what to look for on the page
// ──────────────────────────────────────────────

const LOGIN_REDIRECT_PATTERNS = [
    "/login/",
    "login.php",
    "/checkpoint/",
    "login_identifier",
];

const LOGGED_IN_INDICATORS = [
    '[role="navigation"]',
    '[aria-label="Home"]',
    '[aria-label="Domů"]',
    '[data-pagelet="page"]',
    'link[rel="canonical"][href*="facebook.com"]',
];

const LOGIN_PAGE_TITLES = [
    "Log in to Facebook",
    "Log into Facebook",
    "Facebook – log in or sign up",
    "Přihlásit se k Facebooku",
    "Facebook - přihlášení",
];

const PAGE_NOT_FOUND_INDICATORS = [
    "page not found",
    "stránka nebyla nalezena",
    "this page isn't available",
    "tato stránka není dostupná",
    "the link may be broken",
];

// ──────────────────────────────────────────────
// Session expired error class
// ──────────────────────────────────────────────

class SessionExpiredError extends Error {
    constructor(msg) {
        super(msg);
        this.name = "SessionExpiredError";
    }
}

// ──────────────────────────────────────────────
// ensureLoggedIn — verify session is valid
// ──────────────────────────────────────────────

/**
 * Navigates to facebook.com and checks if the user is still logged in.
 * Returns true if logged in, throws SessionExpiredError if not.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
async function ensureLoggedIn(page) {
    logger.info("Verifying Facebook login session...");

    // Go to facebook.com
    await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    const url = page.url();
    logger.info(`Current URL: ${url}`);

    // ── Check 1: URL redirect ──
    for (const pattern of LOGIN_REDIRECT_PATTERNS) {
        if (url.includes(pattern)) {
            throw new SessionExpiredError(
                `Session expired — URL redirected to login (matched "${pattern}"). ` +
                    "Re-run with --wait-for-login on a machine with a display.",
            );
        }
    }

    // ── Check 2: Page title ──
    try {
        const title = await page.title();
        logger.info(`Page title: ${title}`);
        for (const loginTitle of LOGIN_PAGE_TITLES) {
            if (title.toLowerCase().includes(loginTitle.toLowerCase())) {
                throw new SessionExpiredError(
                    `Session expired — page title is "${title}". ` +
                        "Re-run with --wait-for-login on a machine with a display.",
                );
            }
        }
    } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        logger.warn("Could not read page title: " + err.message);
    }

    // ── Check 3: Logged-in DOM indicators ──
    let foundIndicator = false;
    for (const selector of LOGGED_IN_INDICATORS) {
        try {
            const el = await page.$(selector);
            if (el) {
                foundIndicator = true;
                logger.info(`Login confirmed — found "${selector}" on page.`);
                break;
            }
        } catch (_) {
            // selector might fail, try next
        }
    }

    if (!foundIndicator) {
        throw new SessionExpiredError(
            "Session may be expired — no logged-in indicators found on facebook.com. " +
                "Re-run with --wait-for-login on a machine with a display.",
        );
    }

    logger.info("Session valid — user is logged in.");
    return true;
}

// ──────────────────────────────────────────────
// navigateToPage — switch to the target page
// ──────────────────────────────────────────────

/**
 * Navigates to the Facebook Page URL and verifies it loads correctly.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} pageUrl — Full URL to the Facebook Page
 * @returns {Promise<boolean>}
 */
async function navigateToPage(page, pageUrl) {
    logger.info(`Navigating to page: ${pageUrl}`);

    await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    // Let dynamic content settle
    await new Promise((r) => setTimeout(r, 3000));

    const url = page.url();
    logger.info(`Page URL after navigation: ${url}`);

    // ── Check for page-not-found ──
    try {
        const bodyText = await page.evaluate(() =>
            (document.body.innerText || "").toLowerCase(),
        );
        for (const indicator of PAGE_NOT_FOUND_INDICATORS) {
            if (bodyText.includes(indicator)) {
                logger.error(
                    `Page not found — body contains "${indicator}". ` +
                        `Check FB_PAGE_URL: ${pageUrl}`,
                );
                return false;
            }
        }
    } catch (err) {
        logger.warn("Could not check page body: " + err.message);
    }

    logger.info("Page loaded successfully.");
    return true;
}

// ──────────────────────────────────────────────
// setupNavigationWatcher — catch mid-run expiry
// ──────────────────────────────────────────────

/**
 * Sets up a listener on the page that watches for redirects to login pages.
 * If the user gets logged out mid-run, this catches it and throws.
 *
 * @param {import('puppeteer').Page} page
 */
function setupNavigationWatcher(page) {
    page.on("framenavigated", (frame) => {
        // Only care about the main frame
        if (frame !== page.mainFrame()) return;

        const url = frame.url();
        for (const pattern of LOGIN_REDIRECT_PATTERNS) {
            if (url.includes(pattern)) {
                logger.error(
                    `MID-RUN SESSION EXPIRY — redirected to "${pattern}". URL: ${url}`,
                );
                // We can't throw from an event listener directly,
                // but we can close the page which will cause the
                // main run to fail with a clear error.
                page
                    .close()
                    .catch(() => {});
                return;
            }
        }
    });

    logger.info("Navigation watcher active — monitoring for session expiry.");
}

// ──────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────

module.exports = {
    ensureLoggedIn,
    navigateToPage,
    setupNavigationWatcher,
    SessionExpiredError,
};
