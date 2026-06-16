/**
 * reactions.js — Reactions popup + scroll-and-invite loop.
 *
 * The core interactive module. Handles:
 *   1. Opening the reactions popup (click reactions count)
 *   2. Finding the scrollable container inside the dialog
 *   3. The scroll-and-invite loop: scan for buttons, click them,
 *      track with data-invited, scroll to load more, terminate
 *
 * Includes mock HTML for unit testing without a real Facebook page.
 * Supports dual selectors: INVITE_SELECTORS (page) and TEST_SELECTORS (personal profile).
 *
 * Depends on: config.js, logger.js
 */

const config = require("./config");
const logger = require("./logger");

// ──────────────────────────────────────────────
// Selectors
// ──────────────────────────────────────────────

const INVITE_SELECTORS = [
    // Czech (primary)
    'div[aria-label="Pozvat"][role="button"]',
    'button[aria-label="Pozvat"]',
    'a[role="button"][aria-label*="Pozvat"]',
    // English (fallback)
    'div[aria-label="Invite"][role="button"]',
    'button[aria-label="Invite"]',
    'a[role="button"][aria-label*="Invite"]',
];

const TEST_SELECTORS = [
    'div[aria-label="Sledovat"][role="button"]', // Czech "Follow"
    'div[aria-label="Follow"][role="button"]', // English "Follow"
    'button[aria-label="Sledovat"]',
    'button[aria-label="Follow"]',
];

// ──────────────────────────────────────────────
// Reactions count selectors — what to click to open the popup
// ──────────────────────────────────────────────

const REACTIONS_COUNT_SELECTORS = [
    // Facebook wraps the reactions summary in various containers
    '[aria-label*="reakc"][role="button"]',
    '[aria-label*="reaction"][role="button"]',
    'span[class*="reactions"][role="button"]',
    'div[role="button"] span[class*="reaction"]',
    // Generic fallback: any clickable element containing reactions count text
    '[role="button"] span:has-text("reakc")',
];

// ──────────────────────────────────────────────
// Mock HTML for unit testing
// ──────────────────────────────────────────────

/**
 * Returns a mock reactions dialog HTML string.
 * Simulates a realistic Facebook reactions popup with:
 *   - 5 visible invite buttons (Pozvat / Invite mixed)
 *   - 1 already-following user (no invite button)
 *   - Scroll container with overflow-y: scroll
 *   - Simulates lazy-loaded content on scroll
 *
 * Intended for headless unit tests — no browser required.
 */
function getMockReactionsDialogHtml() {
    return `
        <div role="dialog" aria-label="Reactions dialog" style="height: 400px; overflow: hidden;">
            <div class="reactions-list-container" style="height: 100%; overflow-y: scroll;">
                <div class="reaction-item" style="padding: 5px; border-bottom: 1px solid #eee;">
                    <span>John Doe</span>
                    <button aria-label="Pozvat" role="button" class="invite-button">Pozvat</button>
                </div>
                <div class="reaction-item" style="padding: 5px; border-bottom: 1px solid #eee;">
                    <span>Jane Smith</span>
                    <button aria-label="Invite" role="button" class="invite-button">Invite</button>
                </div>
                <div class="reaction-item" style="padding: 5px; border-bottom: 1px solid #eee;">
                    <span>Peter Pan</span>
                    <div aria-label="Pozvat" role="button" class="invite-button">Pozvat</div>
                </div>
                <div class="reaction-item" style="padding: 5px; border-bottom: 1px solid #eee;">
                    <span>Mary Jane</span>
                    <button aria-label="Following" role="button" class="following-button" disabled>Following</button>
                </div>
                <div class="reaction-item" style="padding: 5px; border-bottom: 1px solid #eee;">
                    <span>Bruce Wayne</span>
                    <button aria-label="Invite" role="button" class="invite-button">Invite</button>
                </div>
                <div class="reaction-item" style="padding: 5px; border-bottom: 1px solid #eee;">
                    <span>Clark Kent</span>
                    <button aria-label="Pozvat" role="button" class="invite-button">Pozvat</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Returns a larger mock dialog with 30 users for testing scroll + dedup behavior.
 */
function getLargeMockDialogHtml() {
    let html = `
        <div role="dialog" aria-label="Reactions dialog" style="height: 400px; overflow: hidden;">
            <div class="reactions-list-container" style="height: 100%; overflow-y: scroll;">
    `;
    for (let i = 1; i <= 30; i++) {
        const label = i % 3 === 0 ? "Invite" : "Pozvat";
        const tag = i % 2 === 0 ? "button" : "div";
        html += `
                <div class="reaction-item" style="padding: 5px; border-bottom: 1px solid #eee;">
                    <span>User ${i}</span>
                    <${tag} aria-label="${label}" role="button" class="invite-button">${label}</${tag}>
                </div>`;
    }
    html += `
            </div>
        </div>`;
    return html;
}

// ──────────────────────────────────────────────
// openReactionsDialog
// ──────────────────────────────────────────────

/**
 * Opens the reactions popup on a post page by clicking the reactions count.
 *
 * Strategy:
 *   1. Try aria-label containing "reakc" or "reaction" (Czech/English)
 *   2. Try any clickable element with text matching numeric reactions count
 *   3. Try clicking an element containing reaction emoji-like spans
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if dialog opened, false otherwise
 */
async function openReactionsDialog(page) {
    logger.info("Attempting to open reactions dialog...");

    // Wait a moment for the post page to fully render
    await new Promise((r) => setTimeout(r, 2000));

    // Try multiple strategies to find and click the reactions count
    const strategies = [
        // Strategy 1: aria-label with "reakc" or "reaction"
        async () => {
            const clicked = await page.evaluate(() => {
                const all = document.querySelectorAll('[aria-label*="reakc" i], [aria-label*="reaction" i]');
                for (const el of all) {
                    if (el.offsetParent !== null) {
                        el.click();
                        return el.getAttribute("aria-label");
                    }
                }
                return null;
            });
            return clicked;
        },

        // Strategy 2: Look for the reactions count bar (common FB pattern)
        async () => {
            const clicked = await page.evaluate(() => {
                // Facebook often has a container with reaction counts
                // Look for spans containing emoji-like characters and numbers
                const containers = document.querySelectorAll('[role="button"]');
                for (const el of containers) {
                    const text = el.textContent || "";
                    // Match patterns like "47", "1.2K", "You and 47 others"
                    if (/\d+/.test(text) && el.offsetParent !== null) {
                        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
                        if (aria.includes("reac") || aria.includes("like") || aria.includes("to se")) {
                            el.click();
                            return aria;
                        }
                    }
                }
                return null;
            });
            return clicked;
        },

        // Strategy 3: Click any visible element that looks like a reactions summary
        async () => {
            const clicked = await page.evaluate(() => {
                const spans = document.querySelectorAll('span[class*="reaction"], span[class*="like"]');
                for (const span of spans) {
                    let parent = span;
                    for (let i = 0; i < 5; i++) {
                        parent = parent.parentElement;
                        if (!parent) break;
                        const role = parent.getAttribute("role");
                        if (role === "button" && parent.offsetParent !== null) {
                            parent.click();
                            return "clicked via reactions span parent";
                        }
                    }
                }
                return null;
            });
            return clicked;
        },
    ];

    for (const strategy of strategies) {
        try {
            const result = await strategy();
            if (result) {
                logger.info(`Reactions count clicked: "${result}"`);

                // Wait for dialog to appear
                await new Promise((r) => setTimeout(r, 3000));

                // Verify dialog appeared
                const dialogVisible = await page.evaluate(() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    return dialog !== null && dialog.offsetParent !== null;
                });

                if (dialogVisible) {
                    logger.info("Reactions dialog opened successfully.");
                    return true;
                } else {
                    logger.info("Clicked reactions count but no [role='dialog'] appeared. Trying next strategy...");
                }
            }
        } catch (err) {
            logger.warn(`Strategy failed: ${err.message}`);
        }
    }

    logger.warn("Could not open reactions dialog with any strategy.");
    return false;
}

// ──────────────────────────────────────────────
// findScrollableContainer
// ──────────────────────────────────────────────

/**
 * Finds the scrollable container inside the reactions dialog.
 *
 * Checks for elements with overflow-y: scroll/auto or explicit scroll functionality.
 * Prefers containers that contain invite-like buttons.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string|null>} CSS selector path or null
 */
async function findScrollableContainer(page) {
    logger.info("Looking for scrollable container in reactions dialog...");

    const result = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return null;

        // Find all scrollable descendants
        const scrollables = [];
        const allElements = dialog.querySelectorAll("*");

        for (const el of allElements) {
            const style = window.getComputedStyle(el);
            const hasScroll =
                style.overflowY === "scroll" ||
                style.overflowY === "auto" ||
                (el.scrollHeight > el.clientHeight && el.clientHeight > 0);

            if (hasScroll) {
                // Count invite buttons inside this container
                const inviteCount = el.querySelectorAll(
                    '[aria-label="Pozvat"], [aria-label="Invite"], [aria-label="Sledovat"], [aria-label="Follow"]',
                ).length;

                scrollables.push({
                    tag: el.tagName.toLowerCase(),
                    className: el.className || "",
                    id: el.id || "",
                    clientHeight: el.clientHeight,
                    scrollHeight: el.scrollHeight,
                    inviteCount,
                });
            }
        }

        if (scrollables.length === 0) {
            // Fallback: use the dialog itself
            return {
                tag: dialog.tagName.toLowerCase(),
                className: dialog.className || "",
                id: dialog.id || "",
                clientHeight: dialog.clientHeight,
                scrollHeight: dialog.scrollHeight,
                inviteCount: dialog.querySelectorAll(
                    '[aria-label="Pozvat"], [aria-label="Invite"]',
                ).length,
                fallback: true,
            };
        }

        // Prefer container with most invite buttons
        scrollables.sort((a, b) => b.inviteCount - a.inviteCount || b.clientHeight - a.clientHeight);
        return scrollables[0];
    });

    if (result) {
        logger.info(
            `Scrollable container found: <${result.tag}> class="${result.className}" ` +
            `height=${result.clientHeight}px scroll=${result.scrollHeight}px ` +
            `invites=${result.inviteCount} ${result.fallback ? "(fallback to dialog)" : ""}`,
        );
        return result;
    }

    logger.warn("No scrollable container found in dialog.");
    return null;
}

// ──────────────────────────────────────────────
// scrollAndInvite — the main loop
// ──────────────────────────────────────────────

/**
 * The core scroll-and-invite loop inside the reactions dialog.
 *
 * Algorithm:
 *   1. Scan for all uninvited buttons (matching selectors, not data-invited)
 *   2. Click each with randomized delay
 *   3. Mark with data-invited="true" to prevent re-clicks
 *   4. Scroll container to load more users
 *   5. If no new buttons appear after N scrolls → exit
 *   6. If maxInvites reached → exit
 *
 * @param {import('puppeteer').Page} page
 * @param {object} containerInfo — result from findScrollableContainer()
 * @param {number} maxInvites — per-post invite limit
 * @param {number} baseDelayMs — base delay between clicks (ms)
 * @param {boolean} dryRun — if true, log buttons but don't click
 * @param {Array<string>} selectors — selectors to use (INVITE_SELECTORS or TEST_SELECTORS)
 * @returns {Promise<{invited: number, scanned: number, reason: string}>}
 */
async function scrollAndInvite(page, containerInfo, maxInvites, baseDelayMs, dryRun = false, selectors = INVITE_SELECTORS) {
    logger.info(
        `Starting scroll-and-invite loop (max ${maxInvites} invites, ` +
        `base delay ${baseDelayMs}ms, dryRun=${dryRun})`,
    );

    let invitesSent = 0;
    let scrollsWithoutNew = 0;
    const MAX_SCROLLS_WITHOUT_NEW = 8;
    const SCROLL_DELAY = config.scrollDelayMs || 3000;

    // Build a CSS selector string from the selectors array
    const selectorStr = selectors.join(", ");

    while (invitesSent < maxInvites && scrollsWithoutNew < MAX_SCROLLS_WITHOUT_NEW) {
        // ── Step 1: Scan for uninvited buttons ──
        const buttonsFound = await page.evaluate(
            (selStr, alreadyInvitedCount) => {
                const all = document.querySelectorAll(selStr);
                const uninvited = [];
                const newlyInvitedThisRound = [];

                for (const el of all) {
                    // Skip already-invited buttons
                    if (el.getAttribute("data-invited") === "true") continue;

                    // Skip elements that aren't visible
                    if (el.offsetParent === null) continue;

                    uninvited.push({
                        ariaLabel: (el.getAttribute("aria-label") || "").trim(),
                        tagName: el.tagName.toLowerCase(),
                    });
                }

                return {
                    uninvitedCount: uninvited.length,
                    totalVisible: all.length,
                    newlyInvitedThisRound: 0,
                };
            },
            selectorStr,
            invitesSent,
        );

        logger.info(
            `Scroll loop: ${buttonsFound.uninvitedCount} uninvited buttons visible ` +
            `(${buttonsFound.totalVisible} total invite-like elements)`,
        );

        // ── Step 2: Click each uninvited button ──
        if (buttonsFound.uninvitedCount > 0) {
            scrollsWithoutNew = 0;

            const clickedThisRound = await page.evaluate(
                (selStr, maxRemaining, shouldDryRun) => {
                    const all = document.querySelectorAll(selStr);
                    let clicked = 0;

                    for (const el of all) {
                        if (clicked >= maxRemaining) break;
                        if (el.getAttribute("data-invited") === "true") continue;
                        if (el.offsetParent === null) continue;

                        if (!shouldDryRun) {
                            el.click();
                            el.setAttribute("data-invited", "true");
                        }
                        clicked++;
                    }

                    return clicked;
                },
                selectorStr,
                maxInvites - invitesSent,
                dryRun,
            );

            invitesSent += clickedThisRound;
            logger.info(
                `${dryRun ? "[DRY RUN] Would click" : "Clicked"} ${clickedThisRound} button(s). ` +
                `Post total: ${invitesSent}/${maxInvites}`,
            );

            if (invitesSent >= maxInvites) {
                logger.info(`Per-post limit reached (${maxInvites}). Stopping.`);
                return { invited: invitesSent, scanned: buttonsFound.totalVisible, reason: "per_post_limit" };
            }
        } else {
            scrollsWithoutNew++;
            logger.info(`No new buttons found (streak ${scrollsWithoutNew}/${MAX_SCROLLS_WITHOUT_NEW})`);
        }

        // ── Step 3: Scroll to load more users ──
        const scrolled = await page.evaluate(() => {
            // Try to find the scrollable container
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return false;

            // Find the scrollable element
            const scrollables = Array.from(dialog.querySelectorAll("*")).filter((el) => {
                const style = window.getComputedStyle(el);
                return (
                    style.overflowY === "scroll" ||
                    style.overflowY === "auto" ||
                    el.scrollHeight > el.clientHeight
                );
            });

            if (scrollables.length === 0) return false;

            // Pick the largest scrollable
            scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
            const container = scrollables[0];

            const before = container.scrollTop;
            container.scrollBy(0, container.clientHeight * 0.8);
            return container.scrollTop > before;
        });

        if (!scrolled) {
            scrollsWithoutNew = MAX_SCROLLS_WITHOUT_NEW; // force exit
            logger.info("Could not scroll container. Exiting loop.");
        }

        // Wait for lazy-loaded content to render
        await new Promise((r) => setTimeout(r, SCROLL_DELAY));
    }

    const reason =
        scrollsWithoutNew >= MAX_SCROLLS_WITHOUT_NEW ? "no_more_users" : "loop_exit";

    logger.info(`Scroll loop finished. Invited: ${invitesSent}. Reason: ${reason}`);
    return { invited: invitesSent, scanned: -1, reason };
}

// ──────────────────────────────────────────────
// closeReactionsDialog
// ──────────────────────────────────────────────

/**
 * Closes the reactions dialog (Esc key or close button).
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
async function closeReactionsDialog(page) {
    logger.info("Closing reactions dialog...");
    try {
        // Try pressing Escape
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 1000));

        // Check if dialog is gone
        const stillOpen = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]');
            return dialog !== null && dialog.offsetParent !== null;
        });

        if (!stillOpen) {
            logger.info("Reactions dialog closed.");
            return true;
        }

        // Try clicking a close button
        const closed = await page.evaluate(() => {
            const closeButtons = document.querySelectorAll(
                '[aria-label="Close"], [aria-label="Zavřít"], [role="button"][aria-label="Zavřít"]',
            );
            for (const btn of closeButtons) {
                if (btn.offsetParent !== null) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (closed) {
            await new Promise((r) => setTimeout(r, 1000));
            logger.info("Reactions dialog closed via button.");
            return true;
        }

        logger.warn("Could not close dialog — may need manual intervention.");
        return false;
    } catch (err) {
        logger.warn("Error closing dialog: " + err.message);
        return false;
    }
}

// ──────────────────────────────────────────────
// processPost — convenience orchestrator
// ──────────────────────────────────────────────

/**
 * Full workflow for a single post: open dialog → find container → scroll & invite → close.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} postUrl
 * @param {boolean} dryRun
 * @param {Array<string>} selectors
 * @param {number} [maxInvites] — override the per-post limit (e.g. to respect
 *        the remaining daily budget). Defaults to config.perPostMax.
 * @returns {Promise<{invited: number, reason: string}>}
 */
async function processPost(page, postUrl, dryRun = false, selectors = INVITE_SELECTORS, maxInvites = config.perPostMax) {
    logger.info(`── Processing post: ${postUrl} ──`);

    const opened = await openReactionsDialog(page);
    if (!opened) {
        logger.warn("Could not open reactions dialog for this post. Skipping.");
        return { invited: 0, reason: "dialog_not_opened" };
    }

    const container = await findScrollableContainer(page);
    if (!container) {
        logger.warn("Could not find scrollable container. Closing dialog.");
        await closeReactionsDialog(page);
        return { invited: 0, reason: "no_container_found" };
    }

    const maxPerPost = Math.max(0, Math.min(config.perPostMax, maxInvites));
    const baseDelay = dryRun ? 0 : config.baseDelayMs;

    if (maxPerPost === 0) {
        logger.info("maxInvites is 0 (budget exhausted) — closing dialog without inviting.");
        await closeReactionsDialog(page);
        return { invited: 0, reason: "no_budget" };
    }

    const result = await scrollAndInvite(
        page,
        container,
        maxPerPost,
        baseDelay,
        dryRun,
        selectors,
    );

    await closeReactionsDialog(page);

    return result;
}

// ──────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────

module.exports = {
    // Selector lists
    INVITE_SELECTORS,
    TEST_SELECTORS,

    // Mock HTML factories
    getMockReactionsDialogHtml,
    getLargeMockDialogHtml,

    // Core functions
    openReactionsDialog,
    findScrollableContainer,
    scrollAndInvite,
    closeReactionsDialog,

    // Convenience
    processPost,
};
