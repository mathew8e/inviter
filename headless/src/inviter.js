const puppeteer = require("puppeteer");
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

async function runWithBrowser({
    url,
    max = 10,
    delay = 1000,
    profileDir,
    headless = true,
}) {
    const launchOptions = session.getLaunchOptions(profileDir, headless);
    const browser = await puppeteer.launch(launchOptions);
    let count = 0;
    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            process.env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64)",
        );
        logger.info(`Navigating to ${url}`);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

        // Give page some time to render dynamic content
        await page.waitForTimeout(2000);

        // Try to collect candidate buttons on the page
        const clicked = await page.evaluate(
            async (selectors, max, delay) => {
                function sleep(ms) {
                    return new Promise((r) => setTimeout(r, ms));
                }
                const found = [];
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
                return clickedCount;
            },
            DEFAULT_SELECTORS,
            max,
            delay,
        );

        count = clicked || 0;
        logger.info(`Clicked ${count} buttons`);
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
