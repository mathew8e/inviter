/**
 * scraper.js — Phase 1 of the two-phase execution model.
 *
 * Discovers posts from a Facebook Page's feed and saves them to data/posts.json.
 * Each post gets: url, id, timestamp, date (YYYY-MM-DD), status (pending/done).
 *
 * Depends on: config.js, logger.js
 */

const fs = require("fs");
const path = require("path");
const config = require("./config");
const logger = require("./logger");

const POSTS_PATH = config.postsPath;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Converts a Facebook relative date string like "June 10 at 3:45 PM"
 * or a unix timestamp to a YYYY-MM-DD string.
 * Falls back to "unknown" if parsing fails.
 */
function extractDateString(timestampText, dataUtime) {
    if (dataUtime && !isNaN(dataUtime)) {
        const ms = parseInt(dataUtime, 10) * 1000;
        return new Date(ms).toISOString().slice(0, 10);
    }
    if (timestampText) {
        const cleaned = timestampText.replace(/at\s+/i, "").trim();
        const parsed = new Date(cleaned);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().slice(0, 10);
        }
    }
    return "unknown";
}

// ──────────────────────────────────────────────
// Post list persistence
// ──────────────────────────────────────────────

function loadPostList() {
    if (!fs.existsSync(POSTS_PATH)) {
        return { scrapedAt: null, pageUrl: "", posts: [] };
    }
    try {
        const raw = fs.readFileSync(POSTS_PATH, "utf8");
        const data = JSON.parse(raw);
        if (!Array.isArray(data.posts)) {
            logger.warn("posts.json corrupted, resetting");
            return { scrapedAt: null, pageUrl: "", posts: [] };
        }
        return data;
    } catch (err) {
        logger.warn("Failed to load posts.json: " + err.message);
        return { scrapedAt: null, pageUrl: "", posts: [] };
    }
}

function savePostList(data) {
    const dir = path.dirname(POSTS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(POSTS_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ──────────────────────────────────────────────
// Post extraction selectors
// ──────────────────────────────────────────────

// Post link selectors — must be specific enough to avoid nav elements
const POST_LINK_SELECTORS = [
    'a[href*="/posts/pfbid"]',
    'a[href*="/posts/"][href*="fbid"]',
    'a[href*="/reel/"][href*="fbid"]',  // catch reel?fbid=...
];

// Reel selectors: look for /reel/NUMBER pattern
const REEL_SELECTOR = 'a[href*="/reel/"]';

// Photo selectors: /photo/?fbid=NUMBER is a real post
const PHOTO_SELECTOR = 'a[href*="/photo/?"][href*="fbid="]';

const TIME_TEXT_REGEX = /^(\d+\s*(min|hr|hour|day|sec|h|m|s|d|w|week|month|year|rok|měsíc|den|hod|týden))\b|^(Yesterday|Today|Včera|Dnes)/i;

// ──────────────────────────────────────────────
// switchToMostRecent
// ──────────────────────────────────────────────

async function switchToMostRecent(page) {
    logger.info("Looking for post feed tab (trying Posts, All, Příspěvky)...");

    // Try multiple tabs — managed pages show posts under "All", regular pages under "Posts"
    const tabTexts = ["Posts", "Příspěvky", "All"];
    let feedLoaded = false;

    for (const tabText of tabTexts) {
        const clicked = await clickTabByText(page, [tabText]);
        if (clicked) {
            logger.info(`Clicked '${tabText}' tab.`);
            await new Promise((r) => setTimeout(r, 3000));
            // Scroll a bit to trigger lazy-loaded feed content
            await page.evaluate(() => window.scrollBy(0, 400));
            await new Promise((r) => setTimeout(r, 1500));

            // Quick check: any time-text links visible?
            const hasPosts = await page.evaluate(() => {
                const links = document.querySelectorAll("a[href]");
                for (const l of links) {
                    const t = (l.textContent || "").trim();
                    if (/^\d+\s*(min|hr|hour|day|sec|h|m|s|d|week|month|rok|měsíc|den|hod|týden)/i.test(t)) {
                        return true;
                    }
                }
                return false;
            });

            if (hasPosts) {
                logger.info(`Feed found under '${tabText}' tab.`);
                feedLoaded = true;
                break;
            } else {
                logger.info(`No posts visible under '${tabText}' tab, trying next...`);
            }
        }
    }

    if (!feedLoaded) {
        logger.info("No post feed tab found. Proceeding with current view.");
    }

    // Now try "Most Recent" filter if available
    const filterTexts = [
        "Most recent",
        "Nejnovější",
        "Nejnovejsi",
        "Recent",
        "Nedávné",
        "Nedavne",
    ];

    try {
        const clicked = await page.evaluate((texts) => {
            const allElements = Array.from(
                document.querySelectorAll(
                    '[role="button"], [role="tab"], [role="menuitem"], button, span, a',
                ),
            );
            for (const el of allElements) {
                const elText = (el.textContent || "").trim();
                const elLabel = (el.getAttribute("aria-label") || "").trim();
                for (const t of texts) {
                    if (
                        elText.toLowerCase().includes(t.toLowerCase()) ||
                        elLabel.toLowerCase().includes(t.toLowerCase())
                    ) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            el.click();
                            return "Clicked: " + elText.slice(0, 40);
                        }
                    }
                }
            }
            return null;
        }, filterTexts);

        if (clicked) {
            logger.info("Feed filter: " + clicked);
            await new Promise((r) => setTimeout(r, 2000));
        } else {
            logger.info("Most-recent filter not found. Proceeding with default feed order.");
        }
    } catch (err) {
        logger.warn("Error switching to most-recent: " + err.message);
    }
}

/**
 * Click a tab/button by its exact text content.
 */
async function clickTabByText(page, texts) {
    try {
        const result = await page.evaluate((targetTexts) => {
            const all = document.querySelectorAll(
                '[role="tab"], [role="button"], a, span, div',
            );
            for (const el of all) {
                const elText = (el.textContent || "").trim();
                for (const t of targetTexts) {
                    if (elText === t && el.offsetParent !== null) {
                        el.click();
                        return t;
                    }
                }
            }
            return null;
        }, texts);
        return result;
    } catch (err) {
        logger.warn("Could not click tab: " + err.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// extractVisiblePosts
// ──────────────────────────────────────────────

async function extractVisiblePosts(page, alreadySeen) {
    // Pass timeRegex string for Strategy 1, and alreadySeen for dedup
    return page.evaluate(
        (timeTextRegexStr, seenUrls) => {
            const found = [];
            const seenSet = new Set(seenUrls);
            const candidates = new Map(); // cleanUrl -> linkEl
            const timeRegex = new RegExp(timeTextRegexStr);

            // Helper: resolve and clean a URL
            function resolveUrl(href) {
                if (!href) return null;
                if (!href.includes("facebook.com") && !href.startsWith("/")) return null;
                let full = href.startsWith("/") ? "https://www.facebook.com" + href : href;
                let clean = full.split("?")[0];
                clean = clean.replace(/\/+$/, "");
                return clean;
            }

            // Helper: check if URL looks like a real post (not nav/dashboard)
            function isPostUrl(clean) {
                // Reel with numeric ID
                if (/\/reel\/\d+/.test(clean)) return true;
                // Standard post
                if (clean.includes("/posts/pfbid") || clean.includes("/posts/")) return true;
                // Photo with fbid (but not album sets)
                if (clean.includes("/photo/?") && clean.includes("fbid=") && !clean.includes("set=")) return true;
                return false;
            }

            // ── Strategy 1: Time-text links (most reliable) ──
            const allLinks = document.querySelectorAll("a[href]");
            for (const link of allLinks) {
                const text = (link.textContent || "").trim();
                // Time stamps are short: "5d", "1w", "Yesterday at 2:22 AM"
                if (text.length > 25) continue;
                if (!timeRegex.test(text)) continue;
                const clean = resolveUrl(link.href || link.getAttribute("href"));
                if (!clean) continue;
                if (!candidates.has(clean)) candidates.set(clean, link);
            }

            // ── Strategy 2: URL pattern matching for posts without time text ──
            for (const link of allLinks) {
                const clean = resolveUrl(link.href || link.getAttribute("href"));
                if (!clean) continue;
                if (candidates.has(clean)) continue; // already found
                if (isPostUrl(clean)) {
                    candidates.set(clean, link);
                }
            }

            // ── For each candidate, extract metadata ──
            for (const [url, linkEl] of candidates) {
                if (seenSet.has(url)) continue;

                const linkText = (linkEl.textContent || "").trim();

                // Try to locate the post container
                const postContainer =
                    linkEl.closest(
                        '[role="article"], div[data-ft], div[class*="feed"], div[class*="post"], div[class*="story"]',
                    ) || linkEl.closest("div");

                let timestampText = "";
                let dataUtime = null;

                if (postContainer) {
                    const abbr = postContainer.querySelector("abbr[data-utime]");
                    if (abbr) {
                        dataUtime = abbr.getAttribute("data-utime");
                        timestampText = abbr.textContent || abbr.getAttribute("aria-label") || "";
                    }
                    if (!dataUtime) {
                        const timeEl = postContainer.querySelector('time, span[aria-label*="202"]');
                        if (timeEl) {
                            timestampText = timeEl.textContent || timeEl.getAttribute("aria-label") || "";
                            dataUtime = timeEl.getAttribute("data-utime");
                        }
                    }
                // Broader fallback: scan post container's full text for date patterns
                    if (!timestampText && !dataUtime) {
                        const fullText = (postContainer.textContent || "");
                        // Match: "Yesterday at 2:22 AM", "5h", "3d", "2w", etc.
                        const dateMatch = fullText.match(/(Yesterday|Today|Včera|Dnes)(\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)?)?/i)
                            || fullText.match(/(\d+)\s*(min|hr|hour|day|sec|h|m|s|d|w|week|month|year|rok|měsíc|den|hod|týden)/i)
                            || fullText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)?)?/i);
                        if (dateMatch) timestampText = dateMatch[0];
                    }
                }

                // Fallback: use the link text itself if it matches a time pattern
                if (!timestampText && timeRegex.test(linkText)) {
                    timestampText = linkText;
                }

                // Also check aria-label of the link (Facebook puts full dates there)
                const linkAria = (linkEl.getAttribute("aria-label") || "");
                if (!timestampText && linkAria.length > 5 && /\d{4}|\d{1,2}[:\.]\d{2}/.test(linkAria)) {
                    timestampText = linkAria;
                }

                // Parse date
                let date = "unknown";
                if (dataUtime && !isNaN(dataUtime)) {
                    const ms = parseInt(dataUtime, 10) * 1000;
                    date = new Date(ms).toISOString().slice(0, 10);
                } else if (timestampText) {
                    // Try relative first
                    date = computeDateFromRelative(timestampText);
                    if (date === "unknown") {
                        // Try parsing as absolute date with JavaScript Date
                        const cleaned = timestampText.replace(/\s+at\s+/i, " ").replace(/(AM|PM)/i, " $1").trim();
                        const parsed = new Date(cleaned);
                        if (!isNaN(parsed.getTime())) {
                            date = parsed.toISOString().slice(0, 10);
                        }
                    }
                }

                found.push({
                    url,
                    id: url.split("/").pop() || url,
                    timestamp: dataUtime ? parseInt(dataUtime, 10) * 1000 : null,
                    date,
                    status: "pending",
                    invitedCount: 0,
                    processedAt: null,
                    error: null,
                });
            }

            return found;

            // Helper: convert relative time to date
            function computeDateFromRelative(text) {
                const now = Date.now();
                // Handle "Yesterday", "Today", "Včera", "Dnes"
                if (/yesterday|včera/i.test(text)) {
                    return new Date(now - 86400 * 1000).toISOString().slice(0, 10);
                }
                if (/today|dnes/i.test(text)) {
                    return new Date(now).toISOString().slice(0, 10);
                }
                // Handle "2w", "3 weeks", "5 týdny"
                const weekMatch = text.match(/(\d+)\s*(w|week|týden|týdny)/i);
                if (weekMatch) {
                    const days = parseInt(weekMatch[1], 10) * 7;
                    return new Date(now - days * 86400 * 1000).toISOString().slice(0, 10);
                }
                // Handle "1h", "5 min", "3d", etc.
                const match = text.match(/(\d+)\s*(min|hr|hour|day|sec|h|m|s|d|week|month|year|rok|měsíc|den|hod|týden)/i);
                if (!match) return "unknown";
                const num = parseInt(match[1], 10);
                const unit = match[2].toLowerCase();
                let ms = 0;
                if (unit.startsWith("min") || unit === "m") ms = num * 60 * 1000;
                else if (unit.startsWith("h") || unit.startsWith("hr") || unit.startsWith("hod")) ms = num * 3600 * 1000;
                else if (unit.startsWith("d") || unit.startsWith("den")) ms = num * 86400 * 1000;
                else if (unit.startsWith("s") || unit.startsWith("sec")) ms = num * 1000;
                else if (unit.startsWith("week") || unit.startsWith("týden")) ms = num * 604800 * 1000;
                else if (unit.startsWith("month") || unit.startsWith("měsíc")) ms = num * 2592000 * 1000;
                else if (unit.startsWith("year") || unit.startsWith("rok")) ms = num * 31536000 * 1000;
                else return "unknown";
                return new Date(now - ms).toISOString().slice(0, 10);
            }
        },
        TIME_TEXT_REGEX.source,
        Array.from(alreadySeen),
    );
}

// ──────────────────────────────────────────────
// scrollToBottom — scroll to absolute bottom, detect if more content loaded
// ──────────────────────────────────────────────

async function scrollToBottom(page) {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise((r) => setTimeout(r, 800));
    const after = await page.evaluate(() => document.body.scrollHeight);
    return after > before; // true if new content was loaded (scrollHeight grew)
}

// ──────────────────────────────────────────────
// filterByDate
// ──────────────────────────────────────────────

function filterByDate(posts, dateFrom, dateTo) {
    const from = dateFrom === "all" ? null : dateFrom;
    const to = dateTo === "all" ? null : dateTo;
    return posts.filter((post) => {
        if (post.date === "unknown") return true;
        if (from && post.date < from) return false;
        if (to && post.date > to) return false;
        return true;
    });
}

// ──────────────────────────────────────────────
// mergePostLists
// ──────────────────────────────────────────────

function mergePostLists(existingPosts, newPosts) {
    const map = new Map(existingPosts.map((p) => [p.url, p]));
    for (const post of newPosts) {
        const existing = map.get(post.url);
        if (existing) {
            post.status = existing.status;
            post.invitedCount = existing.invitedCount || 0;
            post.processedAt = existing.processedAt;
            post.error = existing.error;
            post.date = existing.date || post.date;
        }
        map.set(post.url, post);
    }
    return Array.from(map.values());
}

// ──────────────────────────────────────────────
// markPostStatus — update a single post's status in posts.json
// ──────────────────────────────────────────────

/**
 * Updates a single post's bookkeeping fields in posts.json after it has
 * been processed (or attempted). Safe to call repeatedly — looks the post
 * up by URL and merges the given fields.
 *
 * @param {string} postUrl
 * @param {object} updates
 * @param {string} [updates.status] — "pending" | "done" | "error"
 * @param {number} [updates.invitedCount] — additional invites to ADD to the running total
 * @param {string|null} [updates.error] — error message, or null to clear
 * @returns {boolean} true if the post was found and updated
 */
function markPostStatus(postUrl, { status, invitedCount, error } = {}) {
    const data = loadPostList();
    const post = data.posts.find((p) => p.url === postUrl);

    if (!post) {
        logger.warn(`markPostStatus: post not found in posts.json: ${postUrl}`);
        return false;
    }

    if (status !== undefined) post.status = status;
    if (invitedCount) post.invitedCount = (post.invitedCount || 0) + invitedCount;
    if (error !== undefined) post.error = error;
    post.processedAt = Date.now();

    savePostList(data);
    logger.info(
        `markPostStatus: ${postUrl.slice(0, 60)}... -> status=${post.status}, ` +
        `invitedCount=${post.invitedCount}, error=${post.error || "none"}`,
    );
    return true;
}

// ──────────────────────────────────────────────
// discoverPosts — MAIN
// ──────────────────────────────────────────────

async function discoverPosts(page, pageUrl, dateFrom, dateTo, maxPosts) {
    const existing = loadPostList();
    const alreadySeen = new Set(
        existing.posts.map((p) => p.url).filter(Boolean),
    );

    logger.info(
        `Discovering posts from ${pageUrl} (max ${maxPosts}, dateFrom ${dateFrom})`,
    );

    await switchToMostRecent(page);

    // ── Debug dump: what does the page actually look like right now? ──
    // Helps diagnose headless-only rendering differences (missing feed,
    // different layout, etc). Controlled by SCRAPER_DEBUG=1 env var.
    if (process.env.SCRAPER_DEBUG === "1") {
        try {
            const diag = await page.evaluate(() => ({
                readyState: document.readyState,
                bodyScrollHeight: document.body.scrollHeight,
                bodyInnerHTMLLength: document.body.innerHTML.length,
                linkCount: document.querySelectorAll("a[href]").length,
                title: document.title,
                url: location.href,
            }));
            logger.info(
                `SCRAPER_DEBUG: readyState=${diag.readyState} scrollHeight=${diag.bodyScrollHeight} ` +
                `htmlLen=${diag.bodyInnerHTMLLength} links=${diag.linkCount} title="${diag.title}" url=${diag.url}`,
            );
            const html = await page.content();
            const dumpPath = path.join(path.dirname(POSTS_PATH), `scraper-debug-${Date.now()}.html`);
            fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
            fs.writeFileSync(dumpPath, html, "utf8");
            logger.info(`SCRAPER_DEBUG: dumped page HTML to ${dumpPath}`);
        } catch (err) {
            logger.warn("SCRAPER_DEBUG dump failed: " + err.message);
        }
    }

    const posts = [];
    let noNewPostsStreak = 0;

    let scrollHeightUnchangedStreak = 0;

    while (posts.length < maxPosts && scrollHeightUnchangedStreak < 8) {
        const found = await extractVisiblePosts(page, alreadySeen);

        for (const post of found) {
            // Filter out the page URL itself (not a post)
            const pageUrlClean = pageUrl.toLowerCase().replace(/\/+$/, "");
            const postUrlClean = post.url.toLowerCase().replace(/\/+$/, "");
            if (postUrlClean === pageUrlClean) continue;

            alreadySeen.add(post.url);
            posts.push(post);
            logger.info(`Post #${posts.length}: ${post.date} — ${post.url.slice(0, 80)}`);
            if (posts.length >= maxPosts) break;
        }

        if (found.length === 0) {
            noNewPostsStreak++;
            logger.info(`No new posts this scroll (streak ${noNewPostsStreak})`);
        } else {
            noNewPostsStreak = 0;
        }

        // Scroll to absolute bottom to trigger Facebook's lazy loader
        const grew = await scrollToBottom(page);
        await new Promise((r) => setTimeout(r, 2500)); // Wait for new content to render

        if (!grew) {
            scrollHeightUnchangedStreak++;
            if (scrollHeightUnchangedStreak >= 4) {
                logger.info("scrollHeight unchanged 4 times — end of feed.");
                break;
            }
        } else {
            scrollHeightUnchangedStreak = 0;
        }

        // Safety: no posts + no height growth = truly done
        if (noNewPostsStreak >= 6 && scrollHeightUnchangedStreak >= 3) {
            logger.info("No posts + no scroll growth — end of feed.");
            break;
        }
    }

    logger.info(`Discovered ${posts.length} posts total.`);

    const filtered = filterByDate(posts, dateFrom, dateTo);
    logger.info(`After date filtering (${dateFrom} to ${dateTo}): ${filtered.length} posts`);

    const merged = mergePostLists(existing.posts, filtered);
    const result = {
        scrapedAt: Date.now(),
        pageUrl,
        posts: merged,
    };
    savePostList(result);

    return filtered;
}

// ──────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────

module.exports = {
    discoverPosts,
    loadPostList,
    savePostList,
    markPostStatus,
    switchToMostRecent,
    extractVisiblePosts,
    scrollToBottom,
    filterByDate,
    mergePostLists,
    extractDateString,
};
