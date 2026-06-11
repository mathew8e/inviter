/**
 * DOM debug — dump all links and post-like elements from a Facebook page.
 * Run this to see what the page actually contains so we can fix selectors.
 *
 * Usage:
 *   node test/dom-debug.js --page "https://www.facebook.com/YOUR_PAGE"
 */

const puppeteer = require("puppeteer");
const fs = require("fs");
const config = require("../src/config");
const session = require("../src/session");

async function main() {
    const args = process.argv.slice(2);
    let pageUrl = "";
    let headless = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--page" && args[i + 1]) { pageUrl = args[i + 1]; i++; }
        else if (args[i] === "--headless") { headless = true; }
    }

    if (!pageUrl) {
        console.error("Usage: node test/dom-debug.js --page \"https://www.facebook.com/PAGE\"");
        process.exit(1);
    }

    const browser = await puppeteer.launch(
        session.getLaunchOptions(config.profileDir, headless),
    );
    const page = await browser.newPage();

    try {
        console.log("Navigating to:", pageUrl);
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000)); // let feed load

        console.log("Page title:", await page.title());
        console.log("Page URL:", page.url());

        // Dump all links
        const links = await page.evaluate(() => {
            const result = [];
            const anchors = document.querySelectorAll("a[href]");
            for (const a of anchors) {
                const href = a.href || a.getAttribute("href");
                if (!href) continue;
                result.push({
                    href: href.slice(0, 200),
                    text: (a.textContent || "").trim().slice(0, 80),
                    aria: (a.getAttribute("aria-label") || "").slice(0, 80),
                    role: a.getAttribute("role") || "",
                });
            }
            return result;
        });

        // Filter to interesting links
        const interesting = links.filter(l =>
            l.href.includes("/posts/") ||
            l.href.includes("/videos/") ||
            l.href.includes("/photos/") ||
            l.href.includes("/permalink/") ||
            l.href.includes("pfbid") ||
            l.href.includes("/reel/") ||
            l.href.includes("story_fbid") ||
            l.href.includes("set=a.") ||
            l.role === "link" ||
            l.aria.length > 5
        );

        console.log(`\nTotal links: ${links.length}`);
        console.log(`Interesting links: ${interesting.length}`);
        console.log("\n── Interesting links ──");
        for (const l of interesting.slice(0, 30)) {
            console.log(`  href: ${l.href}`);
            console.log(`  text: ${l.text}`);
            console.log(`  role: ${l.role}  aria: ${l.aria}`);
            console.log("");
        }

        // Dump article elements
        const articles = await page.evaluate(() => {
            const result = [];
            const arts = document.querySelectorAll('[role="article"]');
            for (const a of arts) {
                const links = a.querySelectorAll("a[href]");
                const linkHrefs = Array.from(links).map(l => l.href || l.getAttribute("href")).filter(Boolean);
                result.push({
                    innerText: (a.textContent || "").trim().slice(0, 150),
                    links: linkHrefs.slice(0, 5).map(h => h.slice(0, 120)),
                });
            }
            return result;
        });

        console.log(`\n── Articles (${articles.length}) ──`);
        for (const a of articles.slice(0, 10)) {
            console.log(`  text: ${a.innerText}`);
            console.log(`  links: ${a.links.join(", ")}`);
            console.log("");
        }

        // Save full dump
        fs.writeFileSync(
            "./data/dom-debug.json",
            JSON.stringify({ links, articles }, null, 2),
            "utf8",
        );
        console.log("Full dump saved to data/dom-debug.json");

    } finally {
        await browser.close();
    }
}

main().catch(console.error);
