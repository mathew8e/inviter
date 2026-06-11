/**
 * Deep DOM debug — dump ALL links with text after clicking Posts tab.
 */
const puppeteer = require("puppeteer");
const config = require("../src/config");
const session = require("../src/session");

(async () => {
    const browser = await puppeteer.launch(
        session.getLaunchOptions(config.profileDir, false),
    );
    const page = await browser.newPage();

    await page.goto("https://www.facebook.com/facebook", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 4000));

    // Click Posts tab
    await page.evaluate(() => {
        const all = document.querySelectorAll("span");
        for (const el of all) {
            if (el.textContent.trim() === "Posts" && el.offsetParent) {
                el.click();
                break;
            }
        }
    });
    await new Promise((r) => setTimeout(r, 4000));

    // Scroll a bit to load posts
    await page.evaluate(() => window.scrollBy(0, 600));
    await new Promise((r) => setTimeout(r, 2000));

    // Dump ALL links (href + text)
    const allLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]")).map((a) => ({
            href: (a.href || a.getAttribute("href") || "").slice(0, 200),
            text: (a.textContent || "").trim().slice(0, 100),
            tag: a.tagName,
        }));
    });

    console.log(`Total links: ${allLinks.length}`);

    // Show links that have any text content (not empty)
    const withText = allLinks.filter((l) => l.text.length > 0);
    console.log(`\nLinks WITH text (${withText.length}):`);
    for (const l of withText) {
        console.log(`  [${l.text.slice(0, 60)}] → ${l.href}`);
    }

    // Show links with no text but interesting hrefs
    const noText = allLinks.filter(
        (l) =>
            l.text.length === 0 &&
            (l.href.includes("/posts/") ||
                l.href.includes("/reel/") ||
                l.href.includes("/videos/") ||
                l.href.includes("/photo/") ||
                l.href.includes("story_fbid") ||
                l.href.includes("fbid=")),
    );
    console.log(`\nInteresting empty-text links (${noText.length}):`);
    for (const l of noText.slice(0, 20)) {
        console.log(`  ${l.href}`);
    }

    await browser.close();
})();
