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
// dismissCookieBanner — EU consent banner blocks the whole page
// ──────────────────────────────────────────────

/**
 * Facebook shows an EU cookie consent banner that covers the entire page
 * until dismissed. If it isn't dismissed, nothing behind it renders/loads
 * (feed stays empty, reactions dialogs can't open, reels show a stripped
 * public overlay). Declining optional cookies is enough to unblock the
 * page — we don't need to accept tracking cookies.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if a banner was found and dismissed
 */
async function dismissCookieBanner(page) {
    try {
        const clicked = await page.evaluate(() => {
            const keywords = [
                "decline optional cookies",
                "allow all cookies",
                "odmítnout nepovinné soubory cookie",
                "povolit všechny soubory cookie",
                "only allow essential cookies",
            ];
            const candidates = document.querySelectorAll('[role="button"], button');
            for (const el of candidates) {
                const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
                if (keywords.some((k) => label === k || label.includes(k))) {
                    el.click();
                    return label.slice(0, 60);
                }
            }
            return null;
        });

        if (clicked) {
            logger.info(`Dismissed cookie consent banner: "${clicked}"`);
            await new Promise((r) => setTimeout(r, 1500));
            return true;
        }
        return false;
    } catch (err) {
        logger.warn("Error dismissing cookie banner: " + err.message);
        return false;
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

    await dismissCookieBanner(page);

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
    setupNavigationWatcher,
    dismissCookieBanner,
    SessionExpiredError,
};
