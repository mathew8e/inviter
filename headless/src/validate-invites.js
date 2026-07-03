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
    const selectorStr = reactions.INVITE_SELECTORS.join(", ");
    let scrollsWithoutNew = 0;
    const MAX_SCROLLS_WITHOUT_NEW = 400;
    const FAST_SCROLL_DELAY = 350; // deliberately much shorter than production — this is validation-only, no clicks sent

    while (scrollsWithoutNew < MAX_SCROLLS_WITHOUT_NEW) {
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
            return ids;
        }, selectorStr);

        const before = remaining.size;
        for (const id of found) remaining.add(id);
        scrollsWithoutNew = remaining.size === before ? scrollsWithoutNew + 1 : 0;

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
                c.scrollBy(0, c.clientHeight * 0.6);
                const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 20;
                return { atBottom };
            }
            return { atBottom: true };
        });

        await new Promise((r) => setTimeout(r, FAST_SCROLL_DELAY));

        if (scrollResult.atBottom && scrollsWithoutNew > 8) break;
    }

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
