const puppeteer = require("puppeteer");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const logger = require("./logger");
const storage = require("./storage");
const session = require("./session");

const DEFAULT_SELECTORS = [
    'div[aria-label="Follow"][role="button"]',
    'div[aria-label="Pozvat"][role="button"]',
    'button[aria-label="Follow"]',
    'button[aria-label="Pozvat"]',
    'a[role="button"][aria-label*="Follow"]',
];

function formatLaunchOptions(launchOptions) {
    const summary = { ...launchOptions };
    if (summary.executablePath) {
        summary.executablePath = summary.executablePath;
    }
    if (summary.args) {
        summary.args = [...summary.args];
    }
    return summary;
}

async function runWithBrowser({
    url,
    max = 10,
    delay = 1000,
    profileDir,
    headless = true,
    waitForLogin = false,
    countFollow = false,
}) {
    const launchOptions = session.getLaunchOptions(profileDir, headless);
    logger.info(
        `Launching browser with options: ${JSON.stringify(formatLaunchOptions(launchOptions))}`,
    );
    const browser = await puppeteer.launch(launchOptions);
    let count = 0;
    try {
        const page = await browser.newPage();
        logger.info(
            `Opened new page in browser version: ${await browser.version()}`,
        );
        await page.setUserAgent(
            process.env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64)",
        );
        logger.info(`Navigating to ${url}`);
        const response = await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 60000,
        });
        logger.info(
            `Navigation finished: status=${response ? response.status() : "n/a"}, finalUrl=${page.url()}`,
        );

        const title = await page.title().catch(() => "n/a");
        logger.info(`Page title: ${title}`);

        if (waitForLogin) {
            logger.info(
                "Browser is open for manual login. Press Enter here after you finish logging in.",
            );
            const rl = readline.createInterface({
                input: stdin,
                output: stdout,
            });
            await rl.question("");
            rl.close();
            logger.info(
                "Login pause finished. Exiting without running automation.",
            );
            return 0;
        }

        // Give page some time to render dynamic content
        await page.waitForTimeout(2000);

        if (countFollow) {
            logger.info(
                "Running count-follow mode: will click reactions opener and count Follow buttons.",
            );

            // Try clicking the 'All reactions' opener or toolbar that reveals people who reacted
            const openerClicked = await page.evaluate(() => {
                function tryClick(el) {
                    try {
                        el.scrollIntoView({
                            block: "center",
                            inline: "center",
                        });
                        el.click();
                        return true;
                    } catch (e) {
                        return false;
                    }
                }

                // 1) Prefer aria-label toolbar
                const toolbar = document.querySelector(
                    '[aria-label="See who reacted to this"]',
                );
                if (toolbar) {
                    // find closest role=button descendant
                    const btn =
                        toolbar.closest('[role="button"]') ||
                        toolbar.querySelector('[role="button"]');
                    if (btn && tryClick(btn)) return true;
                }

                // 2) Find any visible element with text 'All reactions'
                const candidates = Array.from(
                    document.querySelectorAll('[role="button"], div, span'),
                );
                for (const c of candidates) {
                    const txt = (c.innerText || "").replace(/\s+/g, " ").trim();
                    if (/all reactions/i.test(txt)) {
                        if (tryClick(c)) return true;
                        const btn = c.closest('[role="button"]');
                        if (btn && tryClick(btn)) return true;
                    }
                }

                // 3) Try any element that has numeric count + the phrase 'others' nearby
                for (const c of candidates) {
                    const txt = (c.innerText || "").replace(/\s+/g, " ").trim();
                    if (
                        /\d+ others|\d+ people|others/i.test(txt) &&
                        txt.length < 200
                    ) {
                        const btn = c.closest('[role="button"]') || c;
                        if (btn && tryClick(btn)) return true;
                    }
                }

                return false;
            });

            logger.info(`Reactions opener clicked: ${openerClicked}`);

            // Wait for the overlay/dialog to appear; attempt a few heuristics
            try {
                await page.waitForTimeout(1200);
                // wait for possible dialog or list to render
                await Promise.race([
                    page
                        .waitForSelector('[role="dialog"]', { timeout: 3000 })
                        .catch(() => {}),
                    page
                        .waitForSelector('[role="list"]', { timeout: 3000 })
                        .catch(() => {}),
                ]);
            } catch (e) {
                // ignore
            }

            // attempt to scroll the dialog or page to load more people
            await page.evaluate(async () => {
                // find a scrollable container within any dialog
                function findScrollable() {
                    const dialogs = Array.from(
                        document.querySelectorAll('[role="dialog"]'),
                    );
                    for (const d of dialogs) {
                        if (d.scrollHeight > d.clientHeight) return d;
                    }
                    // fallback: look for large containers
                    const candidates = Array.from(
                        document.querySelectorAll("div"),
                    );
                    for (const c of candidates) {
                        if (
                            c.scrollHeight > c.clientHeight &&
                            c.clientHeight > 100
                        )
                            return c;
                    }
                    return (
                        document.scrollingElement ||
                        document.documentElement ||
                        document.body
                    );
                }

                const container = findScrollable();
                const step =
                    Math.floor((container.scrollHeight || 1000) / 6) || 400;
                for (let i = 0; i < 8; i++) {
                    container.scrollBy({ top: step, behavior: "smooth" });
                    await new Promise((r) => setTimeout(r, 600));
                }
            });

            // After scrolling, collect Follow buttons using several heuristics
            const followCount = await page.evaluate(() => {
                const selectors = [
                    'button[aria-label="Follow"]',
                    'div[role="button"][aria-label*="Follow"]',
                    'a[role="button"][aria-label*="Follow"]',
                    "button",
                    'div[role="button"]',
                    'a[role="button"]',
                ];
                const els = new Set();
                function isVisible(el) {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (
                        style &&
                        (style.visibility === "hidden" ||
                            style.display === "none")
                    )
                        return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 2 && rect.height > 2;
                }

                // 1) direct aria-label or exact text match
                document.querySelectorAll("*").forEach((n) => {
                    try {
                        const aria =
                            (n.getAttribute && n.getAttribute("aria-label")) ||
                            "";
                        const txt = (n.innerText || "")
                            .replace(/\s+/g, " ")
                            .trim();
                        if (
                            /\bFollow\b/i.test(aria) ||
                            /^Follow$/i.test(txt) ||
                            /\bFollow\b/i.test(txt)
                        ) {
                            if (isVisible(n)) els.add(n);
                        }
                    } catch (e) {}
                });

                // 2) fallback: use candidate selectors and filter by small text 'Follow'
                selectors.forEach((sel) => {
                    document.querySelectorAll(sel).forEach((n) => {
                        try {
                            const txt = (n.innerText || "")
                                .replace(/\s+/g, " ")
                                .trim();
                            const aria =
                                (n.getAttribute &&
                                    n.getAttribute("aria-label")) ||
                                "";
                            if (
                                /\bFollow\b/i.test(aria) ||
                                /^Follow$/i.test(txt) ||
                                /\bFollow\b/i.test(txt)
                            ) {
                                if (isVisible(n)) els.add(n);
                            }
                        } catch (e) {}
                    });
                });

                return Array.from(els).length;
            });

            logger.info(`count-follow result: ${followCount}`);
            await storage.saveHistory(url, followCount);
            await browser.close();
            return followCount;
        }

        const selectorStats = await page.evaluate((selectors) => {
            return selectors.map((selector) => {
                const matches = Array.from(document.querySelectorAll(selector));
                return {
                    selector,
                    count: matches.length,
                    samples: matches.slice(0, 3).map((element) => {
                        const ariaLabel = element.getAttribute("aria-label");
                        const text = (element.textContent || "")
                            .replace(/\s+/g, " ")
                            .trim();
                        return {
                            ariaLabel,
                            text,
                            tagName: element.tagName,
                        };
                    }),
                };
            });
        }, DEFAULT_SELECTORS);

        logger.info(`Selector scan: ${JSON.stringify(selectorStats)}`);

        // Try to collect candidate buttons on the page
        const clicked = await page.evaluate(
            async (selectors, max, delay) => {
                function sleep(ms) {
                    return new Promise((r) => setTimeout(r, ms));
                }
                const els = [];
                selectors.forEach((sel) => {
                    document.querySelectorAll(sel).forEach((e) => els.push(e));
                });
                // Deduplicate
                const uniq = Array.from(new Set(els));
                let clickedCount = 0;
                for (let el of uniq) {
                    try {
                        if (el.getAttribute("data-invited") === "true")
                            continue;
                        // Scroll into view and click
                        el.scrollIntoView({
                            block: "center",
                            inline: "center",
                        });
                        el.click();
                        el.setAttribute("data-invited", "true");
                        clickedCount++;
                        await sleep(delay + Math.floor(Math.random() * 500));
                        if (clickedCount >= max) break;
                    } catch (e) {
                        // ignore single failures
                    }
                }
                return {
                    clickedCount,
                    matchedCount: uniq.length,
                };
            },
            DEFAULT_SELECTORS,
            max,
            delay,
        );

        count =
            clicked && typeof clicked === "object"
                ? clicked.clickedCount || 0
                : clicked || 0;
        const matchedCount =
            clicked && typeof clicked === "object"
                ? clicked.matchedCount || 0
                : 0;
        logger.info(
            `Matched ${matchedCount} candidate elements and clicked ${count} buttons`,
        );
        await storage.saveHistory(url, count);
    } catch (err) {
        logger.error("Error in inviter run: " + err.message);
        throw err;
    } finally {
        await browser.close();
    }
    return count;
}

module.exports = { runWithBrowser };
