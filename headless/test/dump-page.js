/**
 * Save page HTML snippet + all link patterns for analysis.
 * Run: node test/dump-page.js
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const config = require("../src/config");
const session = require("../src/session");

(async () => {
    const browser = await puppeteer.launch(
        session.getLaunchOptions(config.profileDir, false),
    );
    const page = await browser.newPage();

    await page.goto("https://www.facebook.com/PiratDanielKus", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 4000));

    // Click All tab
    await page.evaluate(() => {
        for (const el of document.querySelectorAll('[role="tab"], a')) {
            if ((el.textContent || "").trim() === "All" && el.offsetParent) {
                el.click();
                break;
            }
        }
    });
    await new Promise((r) => setTimeout(r, 3000));

    // Scroll to load posts
    for (let i = 0; i < 10; i++) {
        await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
        );
        await new Promise((r) => setTimeout(r, 1500));
    }

    // Save full HTML
    const html = await page.content();
    fs.writeFileSync("./data/page-snippet.html", html, "utf8");
    console.log("Saved HTML to data/page-snippet.html");

    // Extract ALL unique hrefs grouped by pattern
    const links = await page.evaluate(() => {
        const all = document.querySelectorAll("a[href]");
        const seen = new Set();
        const result = [];
        for (const a of all) {
            const href = (a.href || a.getAttribute("href") || "").replace(/\?.*$/, "").replace(/\/+$/, "");
            if (!href || seen.has(href)) continue;
            seen.add(href);
            result.push(href);
        }
        return result;
    });

    // Group by URL path pattern
    const groups = {};
    for (const href of links) {
        let key = "";
        if (href.includes("/posts/pfbid")) key = "/posts/pfbid";
        else if (href.includes("/reel/")) key = "/reel/NUMBER";
        else if (href.includes("/photo/") || href.includes("/photo?")) key = "/photo";
        else if (href.includes("/videos/")) key = "/videos";
        else if (href.includes("story_fbid")) key = "story_fbid";
        else if (href.includes("/groups/")) key = "/groups";
        else if (href.includes("/professional_dashboard")) key = "dashboard";
        else if (href.includes("/inbox")) key = "inbox";
        else if (href.includes("/settings")) key = "settings";
        else if (href.match(/facebook\.com\/\d+/)) key = "numeric-ID";
        else if (href.match(/facebook\.com\/[^\/]+\/?$/) && !href.includes(".")) key = "page-root";
        else key = "other";

        if (!groups[key]) groups[key] = [];
        if (groups[key].length < 5) groups[key].push(href);
    }

    console.log("\n=== URL PATTERNS ===");
    for (const [key, urls] of Object.entries(groups)) {
        console.log(`\n${key} (${urls.length > 4 ? "5+" : urls.length}):`);
        urls.slice(0, 5).forEach((u) => console.log(`  ${u.slice(0, 150)}`));
    }

    // Also find all time-text links
    const timeLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
            .filter((a) => {
                const t = (a.textContent || "").trim();
                return /^\d+\s*(min|hr|hour|day|sec|h|m|s|d|w)/i.test(t) ||
                    /yesterday|today|včera|dnes/i.test(t);
            })
            .map((a) => ({
                text: (a.textContent || "").trim(),
                href: (a.href || "").replace(/\?.*$/, "").replace(/\/+$/, "").slice(0, 200),
            }));
    });
    console.log(`\n=== TIME-TEXT LINKS (${timeLinks.length}) ===`);
    timeLinks.forEach((l) => console.log(`  "${l.text}" → ${l.href}`));

    await browser.close();
    console.log("\nDone. Check data/page-snippet.html for full HTML.");
})();
