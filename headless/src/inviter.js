const puppeteer = require("puppeteer");
const logger = require("./logger");
const storage = require("./storage");
const session = require("./session");

const DEFAULT_SELECTORS = [
    'div[aria-label="Pozvat"][role="button"]',
    'button[aria-label="Pozvat"]',
    'a[role="button"][aria-label*="Pozvat"]',
    'div[aria-label="Invite"][role="button"]',
    'button[aria-label="Invite"]',
    'a[role="button"][aria-label*="Invite"]',
];

async function runWithBrowser({
    url,
    max = 1000,
    delay = 1000,
    profileDir,
    headless = true,
}) {
    const launchOptions = session.getLaunchOptions(profileDir, headless);
    logger.info(
        `Launching browser with options: ${JSON.stringify(launchOptions)}`,
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

        // Inject CSS to fix rendering issues and ensure proper contrast
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
            .catch(() => {});

        const title = await page.title().catch(() => "n/a");
        logger.info(`Page title: ${title}`);

        // Give page some time to render dynamic content
        await page.waitForTimeout(2000);

        // Scan for invite buttons using DEFAULT_SELECTORS
        const selectorStats = await page.evaluate((selectors) => {
            return selectors.map((selector) => {
                const matches = Array.from(document.querySelectorAll(selector));
                return {
                    selector,
                    count: matches.length,
                    samples: matches.slice(0, 3).map((element) => ({
                        ariaLabel: element.getAttribute("aria-label"),
                        text: (element.textContent || "")
                            .replace(/\s+/g, " ")
                            .trim(),
                        tagName: element.tagName,
                    })),
                };
            });
        }, DEFAULT_SELECTORS);

        logger.info(`Selector scan: ${JSON.stringify(selectorStats)}`);

        // Click invite buttons
        const clicked = await page.evaluate(
            async (selectors, max, delay) => {
                function sleep(ms) {
                    return new Promise((r) => setTimeout(r, ms));
                }

                const els = [];
                selectors.forEach((sel) => {
                    document.querySelectorAll(sel).forEach((e) => els.push(e));
                });

                const uniq = Array.from(new Set(els));
                let clickedCount = 0;

                for (const el of uniq) {
                    try {
                        if (el.getAttribute("data-invited") === "true")
                            continue;

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

                return { clickedCount, matchedCount: uniq.length };
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
