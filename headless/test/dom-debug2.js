/**
 * Debug: find actual post link structures on a Facebook page.
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
    await new Promise((r) => setTimeout(r, 5000));

    const result = await page.evaluate(() => {
        const findings = [];

        // Strategy 1: abbr[data-utime] — find parent links
        const abbrs = document.querySelectorAll("abbr[data-utime]");
        for (const abbr of abbrs) {
            const parent = abbr.closest("a");
            findings.push({
                type: "abbr-closest-a",
                href: parent
                    ? (parent.href || parent.getAttribute("href") || "")
                    : "no-link",
                text: abbr.textContent,
                utime: abbr.getAttribute("data-utime"),
            });
        }

        // Strategy 2: Links containing time-like text
        const timePatterns = [
            "min",
            "hr",
            "hour",
            "day",
            "sec",
            "h",
            "m",
            "s",
            "d",
        ];
        const links = document.querySelectorAll("a[href]");
        for (const link of links) {
            const text = (link.textContent || "").trim();
            const href = link.href || link.getAttribute("href");
            for (const p of timePatterns) {
                const regex = new RegExp("\\d+\\s*" + p, "i");
                if (regex.test(text) && href) {
                    findings.push({
                        type: "time-text-link",
                        href: href.slice(0, 200),
                        text: text.slice(0, 80),
                    });
                    break;
                }
            }
        }

        // Strategy 3: story_fbid / permalink / fbid= patterns
        const allAs = document.querySelectorAll("a[href]");
        const seen = new Set();
        for (const a of allAs) {
            const href = a.href || a.getAttribute("href") || "";
            const text = (a.textContent || "").trim().slice(0, 80);
            if (
                (href.includes("story_fbid") ||
                    href.includes("permalink") ||
                    href.includes("fbid=")) &&
                !seen.has(href)
            ) {
                seen.add(href);
                findings.push({
                    type: "story-link",
                    href: href.slice(0, 200),
                    text,
                });
            }
        }

        return findings;
    });

    console.log("Findings:", result.length);
    for (const f of result.slice(0, 30)) {
        console.log(`[${f.type}]`, JSON.stringify(f));
    }

    await browser.close();
})();
