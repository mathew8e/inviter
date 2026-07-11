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
const { takeScreenshot } = require("./screenshot");

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
 * Opens the reactions popup on a post page by clicking the reactions bar.
 *
 * The reactions bar is a `span[role="toolbar"]` containing:
 *   - Individual reaction-type buttons: `div[role="button"][aria-label="Like: 3.2K people"]`
 *     (clicking one of these opens a FILTERED dialog for that reaction type only)
 *   - The "All reactions" button: `div[role="button"]` with NO aria-label, containing
 *     text like "All reactions:" and the total count — this opens the full unfiltered dialog.
 *
 * We always target the "All reactions" button so we see every person who reacted.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if dialog opened, false otherwise
 */
async function openReactionsDialog(page) {
    logger.info("Attempting to open reactions dialog...");

    // Wait for the post page to fully render
    await new Promise((r) => setTimeout(r, 2000));

    const strategies = [
        // Strategy 1 (primary): Find span[role="toolbar"] — the reactions bar
        // (individual reaction-type icons: Like, Haha, Angry… each WITH an
        // aria-label like "Like: 54K people"). The "All reactions: N" button
        // that opens the FULL unfiltered list is NOT inside the toolbar — it's
        // a SIBLING div next to it, inside the toolbar's parent container.
        // Confirmed via live DOM: <div><span role="toolbar">...icons...</span>
        // <div><div role="button">All reactions: N ...</div></div></div>
        // We must check the parent container first, or we end up clicking a
        // reaction-type icon and opening a FILTERED (e.g. Like-only) dialog.
        // offsetParent checks are intentionally omitted — Facebook's fixed-position
        // overlay makes offsetParent === null even for visible buttons.
        async () => {
            return await page.evaluate(() => {
                const toolbars = document.querySelectorAll('span[role="toolbar"]');
                for (const toolbar of toolbars) {
                    // Prefer an unlabelled div[role="button"] in the toolbar's
                    // parent container (sibling of the toolbar) — that's the
                    // real "All reactions" trigger.
                    const container = toolbar.parentElement;
                    if (container) {
                        const siblingButtons = container.querySelectorAll('div[role="button"]');
                        for (const btn of siblingButtons) {
                            if (toolbar.contains(btn)) continue; // skip reaction-type icons
                            if (!btn.getAttribute("aria-label")) {
                                btn.click();
                                return `container → "All reactions" (sibling of toolbar, no aria-label)`;
                            }
                        }
                    }

                    const buttons = toolbar.querySelectorAll('div[role="button"]');

                    // Fallback: an unlabelled button directly inside the toolbar
                    for (const btn of buttons) {
                        if (!btn.getAttribute("aria-label")) {
                            btn.click();
                            return `toolbar → "All reactions" (no aria-label)`;
                        }
                    }

                    // Last resort: any button inside the toolbar (opens a
                    // FILTERED single-reaction-type dialog, e.g. Like-only)
                    for (const btn of buttons) {
                        btn.click();
                        return `toolbar → ${btn.getAttribute("aria-label") || "unlabeled"} (FILTERED fallback)`;
                    }
                }
                return null;
            });
        },

        // Strategy 2: Individual reaction buttons have aria-label like "Like: 54K people".
        // Clicking one opens a FILTERED dialog (only that reaction type) — last resort.
        // offsetParent check removed for the same reason as Strategy 1.
        async () => {
            return await page.evaluate(() => {
                const buttons = document.querySelectorAll('div[role="button"][aria-label]');
                for (const btn of buttons) {
                    const label = btn.getAttribute("aria-label") || "";
                    // Match "Reaction type: NNN people/lidí/osob"
                    if (/:\s*[\d.,]+[KMB]?\s/i.test(label)) {
                        btn.click();
                        return label;
                    }
                }
                return null;
            });
        },

        // Strategy 3: Text-content fallback — find a visible div[role="button"] whose
        // inner text contains "all reactions", "všechny reakce", or similar phrases.
        async () => {
            return await page.evaluate(() => {
                const keywords = ["all reactions", "všechny reakce", "see who reacted", "zobrazit"];
                const buttons = document.querySelectorAll('div[role="button"]');
                for (const btn of buttons) {
                    const text = (btn.textContent || "").toLowerCase();
                    if (keywords.some((kw) => text.includes(kw)) && btn.offsetParent !== null) {
                        btn.click();
                        return btn.textContent.trim().slice(0, 60);
                    }
                }
                return null;
            });
        },
    ];

    for (let i = 0; i < strategies.length; i++) {
        try {
            const result = await strategies[i]();
            if (result) {
                logger.info(`Strategy ${i + 1} clicked: "${result}"`);

                // Wait for the dialog to render
                await new Promise((r) => setTimeout(r, 3000));

                const dialogVisible = await page.evaluate(() => {
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                    return dialogs.some((d) => {
                        const s = window.getComputedStyle(d);
                        return s.display !== "none" && s.visibility !== "hidden";
                    });
                });

                if (dialogVisible) {
                    logger.info("Reactions dialog opened successfully.");
                    return true;
                }
                logger.info(`Strategy ${i + 1}: clicked but no [role="dialog"] appeared. Trying next...`);
            }
        } catch (err) {
            logger.warn(`Strategy ${i + 1} failed: ${err.message}`);
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
 * @param {number} [maxTimeMs] — wall-clock cap for a SINGLE post. `runTimeCapMs`
 *        in inviter.js is only checked BETWEEN posts, never inside this loop —
 *        confirmed live (2026-07-04/05) that a single post with a huge reactor
 *        list scattered with hundreds of invite candidates ran for ~16 HOURS
 *        overnight before an unrelated Puppeteer protocol timeout finally
 *        killed it, completely bypassing the intended 30-minute run cap. This
 *        gives every post its own hard ceiling so one post can never consume
 *        the whole run (or more).
 * @returns {Promise<{invited: number, scanned: number, reason: string}>}
 */
async function scrollAndInvite(
    page, containerInfo, maxInvites, baseDelayMs, dryRun = false,
    selectors = INVITE_SELECTORS, maxTimeMs = config.postTimeCapMs,
) {
    logger.info(
        `Starting scroll-and-invite loop (max ${maxInvites} invites, ` +
        `base delay ${baseDelayMs}ms, dryRun=${dryRun}, post time cap ${maxTimeMs}ms)`,
    );

    let invitesSent = 0;
    let scrollsWithoutNew = 0;
    let totalIterations = 0;
    const postStart = Date.now();
    // Long runs of already-followed reactors (e.g. a politician who has
    // manually invited people for years) can produce hundreds of
    // consecutive scrolls with zero new invite buttons, long before the
    // real end of the list. The "atBottom + scrollHeight stable" check
    // below is the reliable end-of-list signal — this streak counter is
    // just a safety net against a stuck/broken scroll container, so it
    // needs to be generous rather than a realistic termination trigger.
    const MAX_SCROLLS_WITHOUT_NEW = 300;
    const SCROLL_DELAY = config.scrollDelayMs || 3000;

    // Facebook's reactions list is virtualized — as you scroll, DOM nodes
    // get RECYCLED and reused for different people (common in long React
    // lists). Marking a button element with data-invited="true" isn't
    // reliable dedup: if that exact node later gets reused for a
    // different person, we'd see the stale attribute and wrongly skip a
    // real candidate. Confirmed live (2026-07-03): a manual check found
    // ~9 people still showing "Pozvat" after a run claimed the list was
    // fully processed. Track invited people by a STABLE identifier (their
    // profile link, extracted from the row) in a Set that lives in
    // Node.js memory, not on the (possibly-recycled) DOM node itself.
    const invitedPersonIds = new Set();

    const selectorStr = selectors.join(", ");

    // Text keywords used as fallback when aria-label selectors find nothing.
    // Covers Czech and English for both page-invite and profile-follow scenarios.
    const TEXT_KEYWORDS = ["Invite", "Pozvat", "Follow", "Sledovat"];

    // Returns the visible open dialogs, falling back to [document] if none found.
    // Needed because Facebook can have multiple role="dialog" in the DOM at once
    // (e.g. a comment box dialog AND the reactions dialog) — querySelector returns
    // the first one, which may be the wrong one.
    const FIND_ROOTS = `
        (function() {
            const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
                const s = window.getComputedStyle(d);
                return s.display !== "none" && s.visibility !== "hidden";
            });
            return open.length > 0 ? open : [document.body];
        })()
    `;

    while (invitesSent < maxInvites && scrollsWithoutNew < MAX_SCROLLS_WITHOUT_NEW) {
        if (Date.now() - postStart > maxTimeMs) {
            logger.warn(
                `Post time cap (${maxTimeMs}ms) reached with ${invitesSent}/${maxInvites} invited — ` +
                "moving on to the next post. The rest of this post's reactors are picked up next run.",
            );
            return { invited: invitesSent, scanned: null, reason: "post_time_cap" };
        }
        totalIterations++;
        // A post with thousands of reactors, most already following the
        // page, can produce long genuine stretches of zero new invites —
        // confirmed live (2026-07-04) the page owner mistook this for a
        // frozen/stuck run after watching the invited-count sit still for
        // 15 minutes. Nothing was actually wrong: it was still scrolling
        // through already-followed people looking for the scattered
        // remaining candidates. A periodic heartbeat makes that visible.
        if (totalIterations % 20 === 0) {
            logger.info(
                `... still scanning this post (iteration #${totalIterations}, ` +
                `${invitesSent}/${maxInvites} invited so far, ${scrollsWithoutNew} scans since the last new invite)`,
            );
        }

        // ── Step 1: Scan for clickable invite buttons ──
        //
        // Three bugs were fixed vs the original scan:
        //   A) Searched whole document → now searches only open dialogs
        //   B) `offsetParent === null` filtered real buttons in FB's fixed-position
        //      dialog overlay → replaced with `aria-disabled` check
        //   C) No fallback when aria-label hasn't been set yet by FB's JS →
        //      now also matches by visible text content
        const buttonsFound = await page.evaluate((selStr, keywords, alreadyInvited) => {
            // Walk up from the button to find a nearby profile link — the
            // most stable identifier for a person, since it survives DOM
            // node recycling in Facebook's virtualized reactions list
            // (unlike a data-invited attribute stuck to a node that could
            // later be reused for someone else entirely).
            function getPersonId(el) {
                let node = el.parentElement;
                for (let i = 0; i < 8 && node; i++) {
                    const a = node.querySelector('a[href]');
                    if (a) {
                        const href = a.getAttribute("href") || "";
                        if (href) {
                            // Older-style profile links (profile.php?id=NNNN)
                            // carry the identifying part in the QUERY STRING —
                            // naively stripping "?..." collapses every such
                            // person into the same generic "profile.php"
                            // identifier, wrongly treating them as one person.
                            // Confirmed live (2026-07-03): this caused one real
                            // candidate to be silently skipped as "duplicate".
                            try {
                                const url = new URL(href, "https://www.facebook.com");
                                if (url.pathname === "/profile.php" && url.searchParams.has("id")) {
                                    return url.pathname + "?id=" + url.searchParams.get("id");
                                }
                                return url.origin + url.pathname;
                            } catch (e) {
                                return href.split("?")[0].split("#")[0];
                            }
                        }
                    }
                    node = node.parentElement;
                }
                return (node || el).textContent.trim().slice(0, 80);
            }

            const invitedSet = new Set(alreadyInvited);
            const roots = (function() {
                const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
                    const s = window.getComputedStyle(d);
                    return s.display !== "none" && s.visibility !== "hidden";
                });
                return open.length > 0 ? open : [document.body];
            })();

            let uninvitedCount = 0;
            let totalCount = 0;
            const debugInfo = [];

            for (const root of roots) {
                // Primary: aria-label CSS selectors
                for (const el of root.querySelectorAll(selStr)) {
                    totalCount++;
                    if (el.getAttribute("aria-disabled") === "true") continue;
                    if (invitedSet.has(getPersonId(el))) continue;
                    uninvitedCount++;
                    debugInfo.push(`aria:${el.getAttribute("aria-label")}`);
                }

                // Fallback: match by visible text content
                if (uninvitedCount === 0) {
                    for (const btn of root.querySelectorAll('[role="button"]')) {
                        const text = (btn.textContent || "").trim();
                        if (!keywords.includes(text)) continue;
                        if (btn.getAttribute("aria-disabled") === "true") continue;
                        if (invitedSet.has(getPersonId(btn))) continue;
                        totalCount++;
                        uninvitedCount++;
                        debugInfo.push(`text:${text}`);
                    }
                }
            }

            return { uninvitedCount, totalCount, debugInfo: debugInfo.slice(0, 5) };
        }, selectorStr, TEXT_KEYWORDS, Array.from(invitedPersonIds));

        logger.info(
            `Scan: ${buttonsFound.uninvitedCount} clickable / ${buttonsFound.totalCount} total` +
            (buttonsFound.debugInfo.length ? ` — ${buttonsFound.debugInfo.join(", ")}` : " — none found"),
        );

        // ── Step 2: Click each button one at a time with visual preview ──
        if (buttonsFound.uninvitedCount > 0) {
            scrollsWithoutNew = 0;
            let clickedThisRound = 0;
            const maxToClick = Math.min(buttonsFound.uninvitedCount, maxInvites - invitesSent);

            for (let i = 0; i < maxToClick; i++) {
                // Highlight the next clickable button with an orange outline.
                // Returns both a human-readable label AND the person's
                // stable identifier so we can record it in invitedPersonIds
                // (Node.js-side Set) after a successful click — NOT just a
                // DOM attribute, which can survive on a recycled node and
                // wrongly get attributed to a different person later.
                const found = await page.evaluate((selStr, keywords, alreadyInvited) => {
                    function getPersonId(el) {
                        let node = el.parentElement;
                        for (let i = 0; i < 8 && node; i++) {
                            const a = node.querySelector("a[href]");
                            if (a) {
                                const href = a.getAttribute("href") || "";
                                if (href) {
                                    try {
                                        const url = new URL(href, "https://www.facebook.com");
                                        if (url.pathname === "/profile.php" && url.searchParams.has("id")) {
                                            return url.pathname + "?id=" + url.searchParams.get("id");
                                        }
                                        return url.origin + url.pathname;
                                    } catch (e) {
                                        return href.split("?")[0].split("#")[0];
                                    }
                                }
                            }
                            node = node.parentElement;
                        }
                        return (node || el).textContent.trim().slice(0, 80);
                    }

                    const invitedSet = new Set(alreadyInvited);
                    const roots = (function() {
                        const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
                            const s = window.getComputedStyle(d);
                            return s.display !== "none" && s.visibility !== "hidden";
                        });
                        return open.length > 0 ? open : [document.body];
                    })();

                    for (const root of roots) {
                        // Try aria-label selectors first
                        for (const el of root.querySelectorAll(selStr)) {
                            if (el.getAttribute("data-pending") === "true") continue;
                            if (el.getAttribute("aria-disabled") === "true") continue;
                            const personId = getPersonId(el);
                            if (invitedSet.has(personId)) continue;

                            el.setAttribute("data-pending", "true");
                            el.style.outline = "4px solid orange";
                            el.style.backgroundColor = "#fff3cd";
                            el.scrollIntoView({ behavior: "smooth", block: "center" });
                            return { label: `aria:${el.getAttribute("aria-label")}`, personId };
                        }

                        // Fallback: text content
                        for (const btn of root.querySelectorAll('[role="button"]')) {
                            const text = (btn.textContent || "").trim();
                            if (!keywords.includes(text)) continue;
                            if (btn.getAttribute("data-pending") === "true") continue;
                            if (btn.getAttribute("aria-disabled") === "true") continue;
                            const personId = getPersonId(btn);
                            if (invitedSet.has(personId)) continue;

                            btn.setAttribute("data-pending", "true");
                            btn.style.outline = "4px solid orange";
                            btn.style.backgroundColor = "#fff3cd";
                            btn.scrollIntoView({ behavior: "smooth", block: "center" });
                            return { label: `text:${text}`, personId };
                        }
                    }
                    return null;
                }, selectorStr, TEXT_KEYWORDS, Array.from(invitedPersonIds));

                if (!found) break;
                logger.info(`Highlighted: ${found.label}`);

                // 1s preview so the button is visible before clicking
                await new Promise((r) => setTimeout(r, 1000));

                // Click (or dry-run skip) the highlighted button
                const clicked = await page.evaluate((shouldDryRun) => {
                    for (const el of document.querySelectorAll('[data-pending="true"]')) {
                        el.removeAttribute("data-pending");
                        el.style.outline = "";
                        if (!shouldDryRun) {
                            el.click();
                            el.style.backgroundColor = "#c3e6cb"; // green = clicked
                        } else {
                            el.style.backgroundColor = "#b8daff"; // blue = dry-run skipped
                        }
                        // Attribute is kept as a fast in-viewport hint only —
                        // invitedPersonIds (below) is the authoritative dedup.
                        el.setAttribute("data-invited", "true");
                        return true;
                    }
                    return false;
                }, dryRun);

                if (clicked) {
                    invitedPersonIds.add(found.personId);
                    clickedThisRound++;
                } else {
                    logger.warn("Highlighted button vanished before it could be clicked.");
                    await takeScreenshot(page, "click-missed");
                }

                // Per-invite spacing from rate config
                if (baseDelayMs > 0) {
                    const jitter = Math.random() * baseDelayMs;
                    await new Promise((r) => setTimeout(r, baseDelayMs + jitter));
                }
            }

            invitesSent += clickedThisRound;
            logger.info(
                `${dryRun ? "[DRY RUN] Would click" : "Clicked"} ${clickedThisRound} button(s). ` +
                `Post total: ${invitesSent}/${maxInvites}`,
            );

            if (invitesSent >= maxInvites) {
                logger.info(`Per-post limit reached (${maxInvites}). Stopping.`);
                return { invited: invitesSent, scanned: buttonsFound.totalCount, reason: "per_post_limit" };
            }
        } else {
            scrollsWithoutNew++;
            logger.info(`No new buttons found (streak ${scrollsWithoutNew}/${MAX_SCROLLS_WITHOUT_NEW})`);
        }

        // ── Step 3: Scroll the reactions list to load more users ──
        const scrollResult = await page.evaluate(async () => {
            const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
                const s = window.getComputedStyle(d);
                return s.display !== "none" && s.visibility !== "hidden";
            });

            for (const dialog of open) {
                const scrollables = Array.from(dialog.querySelectorAll("*")).filter(el => {
                    const s = window.getComputedStyle(el);
                    return s.overflowY === "scroll" || s.overflowY === "auto" ||
                           el.scrollHeight > el.clientHeight + 10;
                });
                if (scrollables.length === 0) continue;

                scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
                const container = scrollables[0];
                const heightBefore = container.scrollHeight;
                const before = container.scrollTop;
                // Total distance per iteration is still capped at 0.5x (was 0.8x —
                // a full-height jump risks skipping rows that finish rendering
                // between two scans on a fast-loading list). Spreading that same
                // distance over a handful of quick sub-steps instead of one jump
                // just makes the motion glide continuously, like a held
                // middle-click autoscroll, rather than visibly teleporting —
                // purely cosmetic, doesn't change the distance-per-scan safety
                // margin the 0.5x cap protects.
                const STEPS = 6;
                const stepSize = (container.clientHeight * 0.5) / STEPS;
                for (let i = 0; i < STEPS; i++) {
                    container.scrollBy(0, stepSize);
                    await new Promise((r) => setTimeout(r, 12));
                }

                // atBottom: we've reached the end of the scroll container
                const atBottom =
                    container.scrollTop + container.clientHeight >= container.scrollHeight - 20;

                return {
                    moved: container.scrollTop > before,
                    atBottom,
                    scrollHeight: heightBefore,
                };
            }
            return { moved: false, atBottom: true, scrollHeight: 0 };
        });

        if (!scrollResult.moved && !scrollResult.atBottom) {
            scrollsWithoutNew = MAX_SCROLLS_WITHOUT_NEW;
            logger.info("Could not scroll container. Exiting loop.");
        }

        // Wait for Facebook to lazy-load new rows
        await new Promise((r) => setTimeout(r, SCROLL_DELAY));

        const getScrollHeight = () => page.evaluate(() => {
            const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
                const s = window.getComputedStyle(d);
                return s.display !== "none" && s.visibility !== "hidden";
            });
            for (const dialog of open) {
                const scrollables = Array.from(dialog.querySelectorAll("*"))
                    .filter(el => {
                        const s = window.getComputedStyle(el);
                        return s.overflowY === "scroll" || s.overflowY === "auto" ||
                               el.scrollHeight > el.clientHeight + 10;
                    })
                    .sort((a, b) => b.scrollHeight - a.scrollHeight);
                if (scrollables.length > 0) return scrollables[0].scrollHeight;
            }
            return 0;
        });

        // Early exit: we are at the true bottom AND the scroll height didn't grow,
        // AND we found no buttons. A SINGLE no-growth check isn't reliable —
        // confirmed live (2026-07-03) that this list can pause for several
        // seconds mid-load before continuing, and a single quick recheck
        // wrongly declared "end of list" after seeing only ~8% of a post's
        // real reactors. Be patient: retry several times with growing waits
        // before concluding we've truly reached the end.
        if (scrollResult.atBottom && buttonsFound.uninvitedCount === 0) {
            let stillStalled = true;
            const retryDelaysMs = [1000, 2000, 3000, 4000, 5000];
            for (const delay of retryDelaysMs) {
                const heightAfter = await getScrollHeight();
                if (heightAfter > scrollResult.scrollHeight) {
                    logger.info(`New rows loaded after scroll (${scrollResult.scrollHeight} → ${heightAfter}px). Continuing.`);
                    stillStalled = false;
                    break;
                }
                await new Promise((r) => setTimeout(r, delay));
            }
            if (stillStalled) {
                const finalHeight = await getScrollHeight();
                if (finalHeight <= scrollResult.scrollHeight) {
                    logger.info(
                        `End of list confirmed: at scroll bottom, no new rows loaded through ${retryDelaysMs.length} patience retries, no pending buttons. Done.`,
                    );
                    break;
                }
                logger.info(`New rows loaded after scroll (${scrollResult.scrollHeight} → ${finalHeight}px). Continuing.`);
            }
        }
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
// openReactionsDialogForReel — reel-specific fallback
// ──────────────────────────────────────────────

/**
 * Fallback for reel posts where the standard reactions toolbar is absent.
 *
 * On a reel's player page (facebook.com/reel/VIDEO_ID), span[role="toolbar"] does not
 * exist. Page managers can access reactions via the Insights panel:
 *   1. Click the Insights button on the reel player page.
 *   2. Inside Insights, click the reactions count to open the invite dialog.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if a reactions dialog opened, false otherwise
 */
async function openReactionsDialogForReel(page) {
    logger.info("Reel post: trying Insights path to reach reactions...");

    // Give the reel management toolbar + sidebar (activity/insights panel)
    // extra time to render. On a WiFi-connected Pi this can be noticeably
    // slower than wired — the sidebar was observed still showing loading
    // skeletons at the 5s mark in a screenshot, so we wait longer here.
    await new Promise((r) => setTimeout(r, 6000));
    // Scroll slightly — some management elements are lazy-loaded on first scroll.
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise((r) => setTimeout(r, 4000));

    // Helper: scan all interactive elements for an Insights/Přehledy item and
    // click it with a real mouse click (see menuRect comment below for why).
    const tryClickInsights = async () => {
        const rect = await page.evaluate(() => {
            const keywords = ["insights", "přehledy", "přehled výkonu", "view insights"];
            const candidates = document.querySelectorAll('[role="button"], [role="menuitem"], a[role="link"], a');
            for (const el of candidates) {
                const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
                if (keywords.some((k) => label.includes(k))) {
                    el.scrollIntoView({ behavior: "instant", block: "center" });
                    const r = el.getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: label.slice(0, 60) };
                }
            }
            return null;
        });
        if (!rect) return null;
        await page.mouse.click(rect.x, rect.y);
        return rect.label;
    };

    // Helper: collect visible button labels (for diagnostics).
    const collectLabels = () => page.evaluate(() => {
        const seen = new Set();
        const out = [];
        for (const el of document.querySelectorAll('[role="button"], a[role="link"], a')) {
            const raw = (el.getAttribute("aria-label") || el.textContent || "").trim();
            const short = raw.slice(0, 50);
            if (short && !seen.has(short)) { seen.add(short); out.push(short); }
            if (out.length >= 35) break;
        }
        return out;
    });

    // Step 1a: Try to find Insights directly on the page.
    let insightsClicked = await tryClickInsights();

    if (!insightsClicked) {
        // Log what IS on the page so we know what we're working with.
        const labels = await collectLabels();
        logger.info(`Reel: buttons on page → ${labels.join(" | ") || "(none)"}`);

        // Step 1b: Insights lives inside the ⋯ Menu — click Menu first.
        // A synthetic el.click() often fails to trigger React's dropdown-open
        // handler for menu-type components, even though it "succeeds" from the
        // DOM's point of view (element is real, click event fires) — the
        // dropdown just never renders. A real mouse click via Puppeteer's
        // page.mouse.click() dispatches genuine pointer events that React's
        // event system reliably picks up.
        const menuRect = await page.evaluate(() => {
            const btn =
                document.querySelector('[aria-label="Menu"]') ||
                document.querySelector('[aria-label="More options"]') ||
                document.querySelector('[aria-label="Více možností"]') ||
                document.querySelector('[aria-label="Další možnosti"]');
            if (!btn) return null;
            btn.scrollIntoView({ behavior: "instant", block: "center" });
            const r = btn.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: btn.getAttribute("aria-label") };
        });

        if (!menuRect) {
            logger.warn("Reel: neither Insights nor a Menu button found on this page.");
            return false;
        }

        await page.mouse.click(menuRect.x, menuRect.y);
        const menuClicked = menuRect.label;

        logger.info(`Reel: opened Menu ("${menuClicked}"). Looking for Insights inside...`);
        await new Promise((r) => setTimeout(r, 3500));

        insightsClicked = await tryClickInsights();

        if (!insightsClicked) {
            const menuLabels = await collectLabels();
            logger.warn(
                `Reel: Insights not found in Menu dropdown. Menu contents → ${menuLabels.join(" | ") || "(none)"}`,
            );
            return false;
        }
    }

    logger.info(`Reel: clicked Insights ("${insightsClicked}"). Waiting for panel...`);
    await new Promise((r) => setTimeout(r, 6000));

    // Scroll down inside the Insights panel to reveal lazy-loaded items (reactions link is often below fold)
    await page.evaluate(() => {
        const panels = [
            ...document.querySelectorAll('[role="dialog"], [role="complementary"], [role="region"]'),
        ];
        for (const p of panels) {
            if (p.scrollHeight > p.clientHeight) {
                p.scrollBy(0, 400);
            }
        }
        window.scrollBy(0, 400);
    });
    await new Promise((r) => setTimeout(r, 2000));

    // Diagnostic: log what's in the panel
    const panelLabels = await page.evaluate(() => {
        const seen = new Set();
        const out = [];
        const roots = [
            ...document.querySelectorAll('[role="dialog"], [role="complementary"], [role="region"]'),
            document.body,
        ];
        for (const root of roots) {
            for (const el of root.querySelectorAll('[role="button"], a[href], a[role="link"]')) {
                const raw = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60);
                if (raw && !seen.has(raw)) { seen.add(raw); out.push(raw); }
                if (out.length >= 20) break;
            }
        }
        return out;
    });
    logger.info(`Reel: Insights panel elements → ${panelLabels.join(" | ") || "(none)"}`);

    // Step 2: Inside the insights panel, find and click the reactions count.
    // We target <a> links first (Facebook often wraps "see who reacted" in an anchor),
    // then fall back to [role="button"]. We also scrollIntoView before clicking.
    const reactionsClicked = await page.evaluate(() => {
        const keywords = ["reaction", "reakc", "likes and reactions", "see who reacted", "zobrazit kdo"];
        const roots = [
            ...document.querySelectorAll('[role="dialog"], [role="complementary"], [role="region"]'),
            document.body,
        ];
        // Prefer <a> links over buttons — the "see who reacted" item is often an anchor
        const queryOrder = ['a[href], a[role="link"]', '[role="button"]'];
        for (const root of roots) {
            for (const query of queryOrder) {
                for (const el of root.querySelectorAll(query)) {
                    if (el.dataset.pending || el.dataset.invited) continue;
                    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
                    if (keywords.some((k) => label.includes(k))) {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                        el.click();
                        return label.slice(0, 60);
                    }
                }
            }
        }
        return null;
    });

    if (!reactionsClicked) {
        logger.warn("Reel: no reactions button found inside Insights panel.");
        return false;
    }

    logger.info(`Reel: clicked reactions in Insights ("${reactionsClicked}"). Waiting for dialog...`);
    const urlBeforeReactions = page.url();
    await new Promise((r) => setTimeout(r, 5000));

    // Case A: a [role="dialog"] opened inline
    const dialogVisible = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        return dialogs.some((d) => {
            const s = window.getComputedStyle(d);
            return s.display !== "none" && s.visibility !== "hidden";
        });
    });

    if (dialogVisible) {
        logger.info("Reel: reactions dialog opened via Insights path.");
        return true;
    }

    // Case B: clicking "see who reacted" navigated to a dedicated reactions page
    const urlAfterReactions = page.url();
    if (urlAfterReactions !== urlBeforeReactions) {
        logger.info(`Reel: navigated to reactions page: ${urlAfterReactions}`);
        // Wait for the page to fully render
        await new Promise((r) => setTimeout(r, 3000));
        // Check again — some reaction pages render a dialog after load
        const dialogAfterNav = await page.evaluate(() => {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
            return dialogs.some((d) => {
                const s = window.getComputedStyle(d);
                return s.display !== "none" && s.visibility !== "hidden";
            });
        });
        if (dialogAfterNav) {
            logger.info("Reel: dialog found on navigated reactions page.");
            return true;
        }
        // The reactions page IS the list — treat the page body as the scroll root
        logger.info("Reel: reactions page loaded (no dialog needed — body is the list).");
        return true;
    }

    logger.warn("Reel: Insights path did not produce a visible reactions dialog.");
    return false;
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

    let opened = await openReactionsDialog(page);

    // Reels open a full-screen video player that has no reactions toolbar.
    // Try the Insights panel as a fallback.
    if (!opened && /\/(reel|videos)\//.test(postUrl)) {
        logger.info("Reel URL detected — falling back to Insights path.");
        opened = await openReactionsDialogForReel(page);
    }

    if (!opened) {
        logger.warn("Could not open reactions dialog for this post. Skipping.");
        await takeScreenshot(page, "dialog-not-opened");
        return { invited: 0, reason: "dialog_not_opened" };
    }

    const container = await findScrollableContainer(page);
    if (!container) {
        logger.warn("Could not find scrollable container. Closing dialog.");
        await takeScreenshot(page, "no-container-found");
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
    openReactionsDialogForReel,
    findScrollableContainer,
    scrollAndInvite,
    closeReactionsDialog,

    // Convenience
    processPost,
};
