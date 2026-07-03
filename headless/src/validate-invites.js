/**
 * validate-invites.js — Quick read-only validation script.
 *
 * Scrolls through a post's reactions list as fast as reasonably possible
 * WITHOUT clicking anything, counting distinct people who still show an
 * Invite/Pozvat button. Uses the same stable profile-link identifier as
 * the main scrollAndInvite loop (see reactions.js) so Facebook's
 * virtualized list recycling can't cause double-counting.
 *
 * Usage: node src/validate-invites.js "<post-or-insights-url>"
 */

const puppeteer = require("puppeteer");
const session = require("./session");
const reactions = require("./reactions");

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

    const remaining = new Set();
    const allPeopleSeen = new Set(); // every distinct reactor, invite-eligible or not — for sanity-checking against the reaction count shown on the post
    const selectorStr = reactions.INVITE_SELECTORS.join(", ");
    let scrollsWithoutNew = 0;
    let totalScrolls = 0;
    const MAX_SCROLLS_WITHOUT_NEW = 500; // safety net only, not the primary exit signal
    const FAST_SCROLL_DELAY = 600; // shorter than production, but long enough for FB's lazy loader to inject the next batch

    const getScrollHeight = () => page.evaluate(() => {
        const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
            const s = window.getComputedStyle(d);
            return s.display !== "none" && s.visibility !== "hidden";
        });
        for (const dialog of open) {
            const scrollables = Array.from(dialog.querySelectorAll("*"))
                .filter(el => {
                    const s = window.getComputedStyle(el);
                    return s.overflowY === "scroll" || s.overflowY === "auto" || el.scrollHeight > el.clientHeight + 10;
                })
                .sort((a, b) => b.scrollHeight - a.scrollHeight);
            if (scrollables.length > 0) return scrollables[0].scrollHeight;
        }
        return 0;
    });

    while (scrollsWithoutNew < MAX_SCROLLS_WITHOUT_NEW) {
        totalScrolls++;
        const found = await page.evaluate((selStr) => {
            function getPersonId(el) {
                let node = el.parentElement;
                for (let i = 0; i < 8 && node; i++) {
                    const a = node.querySelector("a[href]");
                    if (a) {
                        const href = a.getAttribute("href") || "";
                        if (href) return href.split("?")[0].split("#")[0];
                    }
                    node = node.parentElement;
                }
                return (node || el).textContent.trim().slice(0, 80);
            }
            const roots = (function() {
                const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
                    const s = window.getComputedStyle(d);
                    return s.display !== "none" && s.visibility !== "hidden";
                });
                return open.length > 0 ? open : [document.body];
            })();
            const ids = [];
            for (const root of roots) {
                for (const el of root.querySelectorAll(selStr)) {
                    if (el.getAttribute("aria-disabled") === "true") continue;
                    ids.push(getPersonId(el));
                }
            }

            // Also collect every distinct profile link visible right now,
            // invite-eligible or not — lets us sanity-check total reactor
            // coverage against the reaction count shown on the post itself.
            const allSeen = [];
            for (const root of roots) {
                const scrollables = Array.from(root.querySelectorAll("*")).filter(el => {
                    const s = window.getComputedStyle(el);
                    return s.overflowY === "scroll" || s.overflowY === "auto" || el.scrollHeight > el.clientHeight + 10;
                }).sort((a, b) => b.scrollHeight - a.scrollHeight);
                const container = scrollables[0] || root;
                for (const a of container.querySelectorAll("a[href]")) {
                    const href = a.getAttribute("href") || "";
                    if (href && href !== "#" && !href.startsWith("javascript:")) {
                        allSeen.push(href.split("?")[0].split("#")[0]);
                    }
                }
            }

            return { ids, allSeen };
        }, selectorStr);

        const before = remaining.size;
        for (const id of found.ids) remaining.add(id);
        for (const id of found.allSeen) allPeopleSeen.add(id);
        scrollsWithoutNew = remaining.size === before ? scrollsWithoutNew + 1 : 0;

        if (totalScrolls % 10 === 0) {
            console.log(`... scroll #${totalScrolls}, ${remaining.size} invite-eligible / ${allPeopleSeen.size} total distinct reactors seen so far`);
        }

        const heightBefore = await getScrollHeight();
        const scrollResult = await page.evaluate(() => {
            const open = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
                const s = window.getComputedStyle(d);
                return s.display !== "none" && s.visibility !== "hidden";
            });
            for (const dialog of open) {
                const scrollables = Array.from(dialog.querySelectorAll("*")).filter(el => {
                    const s = window.getComputedStyle(el);
                    return s.overflowY === "scroll" || s.overflowY === "auto" || el.scrollHeight > el.clientHeight + 10;
                });
                if (scrollables.length === 0) continue;
                scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
                const c = scrollables[0];
                c.scrollBy(0, c.clientHeight * 0.5);
                const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 20;
                return { atBottom };
            }
            return { atBottom: true };
        });

        // Wait for Facebook's lazy loader, THEN check whether scrollHeight
        // actually grew. A single no-growth check isn't reliable — the
        // user observed the list can pause/lag for several seconds before
        // continuing to load more (confirmed live: an earlier run declared
        // "end of list" at only 73 of ~891 real reactors). Be patient:
        // retry several times with growing waits before concluding we've
        // truly reached the end.
        await new Promise((r) => setTimeout(r, FAST_SCROLL_DELAY));

        if (scrollResult.atBottom) {
            let stillStalled = true;
            const retryDelaysMs = [1000, 2000, 3000, 4000, 5000];
            for (const delay of retryDelaysMs) {
                const heightAfter = await getScrollHeight();
                if (heightAfter > heightBefore) {
                    stillStalled = false;
                    break;
                }
                await new Promise((r) => setTimeout(r, delay));
            }
            if (stillStalled) {
                const finalHeight = await getScrollHeight();
                if (finalHeight <= heightBefore) {
                    console.log(`Confirmed end of list at scroll #${totalScrolls} (height stayed at ${finalHeight}px through ${retryDelaysMs.length} patience retries).`);
                    break;
                }
            }
        }
    }

    if (scrollsWithoutNew >= MAX_SCROLLS_WITHOUT_NEW) {
        console.log(`WARNING: hit the ${MAX_SCROLLS_WITHOUT_NEW}-scroll safety cap without confirming end of list — results below may be incomplete.`);
    }

    console.log(`Total scrolls performed: ${totalScrolls}`);
    console.log(`Total distinct reactors seen (any type, invited or not): ${allPeopleSeen.size}`);
    console.log(`RESULT: ${remaining.size} distinct people still show an Invite/Pozvat button.`);
    if (remaining.size > 0) {
        console.log("Sample identifiers:", Array.from(remaining).slice(0, 15));
    }

    await browser.close();
}

main().catch((err) => {
    console.error("Validation script error:", err);
    process.exit(1);
});
