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

async function extractVisiblePosts(page, alreadySeen, pageSlug) {
    // Pass timeRegex string for Strategy 1, and alreadySeen for dedup
    return page.evaluate(
        (timeTextRegexStr, seenUrls, pageSlugArg) => {
            const found = [];
            const seenSet = new Set(seenUrls);
            const candidates = new Map(); // cleanUrl -> linkEl
            const timeRegex = new RegExp(timeTextRegexStr);
            const slugLower = (pageSlugArg || "").toLowerCase();

            // Helper: resolve and clean a URL
            function resolveUrl(href) {
                if (!href) return null;
                if (!href.includes("facebook.com") && !href.startsWith("/")) return null;
                let full = href.startsWith("/") ? "https://www.facebook.com" + href : href;
                let clean = full.split("?")[0];
                clean = clean.replace(/\/+$/, "");
                return clean;
            }

            // Helper: does this /posts/ or /videos/ URL belong to the target page?
            // Facebook feeds can embed shared/quoted posts from OTHER authors
            // (e.g. the page shared someone else's post) — those have the
            // OTHER author's username in the path and must be excluded, or
            // we'd end up inviting people on a stranger's post.
            function belongsToTargetPage(clean) {
                if (!slugLower) return true; // no slug to check against — allow
                const match = clean.match(/^https:\/\/www\.facebook\.com\/([^/]+)\//i);
                if (!match) return true; // can't determine author — allow (e.g. reels have no slug)
                return match[1].toLowerCase() === slugLower;
            }

            // Helper: check if URL looks like a real post (not nav/dashboard)
            function isPostUrl(clean) {
                // Reel with numeric ID — no author slug in the URL itself
                if (/\/reel\/\d+/.test(clean)) return true;
                // Standard post — must be authored by the target page
                if ((clean.includes("/posts/pfbid") || clean.includes("/posts/")) && belongsToTargetPage(clean)) return true;
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
                // Exclude shared/quoted posts authored by someone other than the target page
                if ((clean.includes("/posts/") || clean.includes("/videos/")) && !belongsToTargetPage(clean)) continue;
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
        pageSlug,
    );
}

// ──────────────────────────────────────────────
// scrollToBottom — scroll to absolute bottom, detect if more content loaded
// ──────────────────────────────────────────────

/**
 * Scrolls the Content Library table by dispatching real mouse-wheel events.
 *
 * Confirmed live (2026-07-04): document.body.scrollHeight (and every other
 * element's scrollHeight) stays essentially flat no matter how much content
 * loads — this table is NOT a CSS overflow:scroll container at all. Setting
 * .scrollTop on any element (including the largest-scrollHeight candidate)
 * has zero effect. It's one of Facebook's Comet virtualized lists that
 * listens for wheel events directly and fetches more rows via its own
 * internal offset — confirmed by dispatching page.mouse.wheel() at the
 * table and watching the row count grow (took ~11 ticks / ~5.5s before the
 * first batch of new rows appeared).
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if new rows loaded
 */
async function scrollContentLibraryTable(page) {
    const countRows = () => page.evaluate(() =>
        document.querySelectorAll('a[href*="content_id"], a[href*="/insights/"]').length,
    );

    const before = await countRows();
    await page.mouse.move(640, 500);

    const MAX_TICKS = 30; // ~15s worst case — matches the reactions-dialog patience budget
    for (let i = 0; i < MAX_TICKS; i++) {
        await page.mouse.wheel({ deltaY: 1500 });
        await new Promise((r) => setTimeout(r, 500));
        if ((await countRows()) > before) return true;
    }
    return false;
}

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

    // Derive the page's own username/slug (e.g. "DanielKusPlzen" from
    // "https://www.facebook.com/DanielKusPlzen") so post extraction can
    // reject posts embedded/shared from OTHER authors' profiles.
    const slugMatch = pageUrl.match(/facebook\.com\/([^/?]+)/i);
    const pageSlug = slugMatch ? slugMatch[1] : null;
    logger.info(`Target page slug: ${pageSlug || "(none — no author filtering)"}`);

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
        const found = await extractVisiblePosts(page, alreadySeen, pageSlug);

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
// discoverPostsFromContentLibrary — PRIMARY discovery method
// ──────────────────────────────────────────────

const CONTENT_LIBRARY_URL =
    "https://www.facebook.com/professional_dashboard/content/content_library/" +
    "?filter=PUBLISHED&post_type=ALL_CONTENT&sort_by=DATE";

/**
 * Selects a custom date range in the Content Library's date-range picker,
 * spanning from `yearsBack` years ago to today.
 *
 * The date_range URL parameter alone does NOT work — confirmed live
 * (2026-07-04) that navigating directly to a URL with
 * date_range=CUSTOM&start_date=...&end_date=... silently keeps showing
 * only the default "Last 28 days" data; the underlying query only
 * updates after a genuine click on "Apply" inside the picker. There is
 * also no "ALL_TIME"/"LIFETIME" preset — only Today/7/14/28/60/90 days
 * and "This year", so anything older than the current year requires
 * driving the actual calendar UI.
 *
 * Mechanics (reverse-engineered live): the calendar shows one visible
 * month at a time. The left/right chevron arrows each step exactly one
 * month. Clicking a day sets the START of the range (highlighted blue);
 * clicking a second day (after navigating forward again) sets the END
 * and enables the "Apply" button. Confirmed: 36 clicks on the left arrow
 * from the current month reliably lands exactly 3 years back.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} yearsBack — how many years of history to include
 * @returns {Promise<boolean>} true if the range was set and applied
 */
async function setContentLibraryDateRange(page, yearsBack = 3) {
    logger.info(`Setting Content Library date range to last ${yearsBack} years...`);

    // Open the date-range picker (button shows text like "Last 28 days: ...")
    const opened = await page.evaluate(() => {
        for (const el of document.querySelectorAll('[role="button"]')) {
            const t = (el.textContent || "").trim();
            if (/^Last \d+ days:/.test(t) || /^This year:/.test(t) || /^Custom:/.test(t)) {
                const r = el.getBoundingClientRect();
                el.scrollIntoView({ block: "center" });
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
        }
        return null;
    });
    if (!opened) {
        logger.warn("Could not find the date-range picker button — leaving default range in place.");
        return false;
    }
    await page.mouse.click(opened.x, opened.y);
    await new Promise((r) => setTimeout(r, 1500));

    // Coordinates of the calendar's prev/next month chevrons, relative to
    // the picker popup that opens just below/right of the button. These
    // were confirmed against a 1280x900 viewport — if the layout shifts,
    // this will need re-verification (see PLAN.md testing notes).
    const PREV_MONTH_XY = [1004, 355];
    const NEXT_MONTH_XY = [1240, 355];

    const clickDayInVisibleMonth = async (dayNumber) => {
        const rect = await page.evaluate((day) => {
            for (const el of document.querySelectorAll("*")) {
                if ((el.textContent || "").trim() === String(day) && el.children.length === 0) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.width < 60) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                }
            }
            return null;
        }, dayNumber);
        if (!rect) return false;
        await page.mouse.click(rect.x, rect.y);
        await new Promise((r) => setTimeout(r, 800));
        return true;
    };

    const today = new Date();

    // Navigate back yearsBack*12 months, click day 1 as the range start.
    for (let i = 0; i < yearsBack * 12; i++) {
        await page.mouse.click(...PREV_MONTH_XY);
        await new Promise((r) => setTimeout(r, 150));
    }
    const startClicked = await clickDayInVisibleMonth(1);
    if (!startClicked) {
        logger.warn("Could not click a start day in the calendar — leaving default range in place.");
        return false;
    }

    // Navigate forward the same distance plus however many months are
    // needed to reach the CURRENT month, then click today's day-of-month.
    for (let i = 0; i < yearsBack * 12 + today.getMonth() + 1; i++) {
        await page.mouse.click(...NEXT_MONTH_XY);
        await new Promise((r) => setTimeout(r, 150));
    }
    const endClicked = await clickDayInVisibleMonth(today.getDate());
    if (!endClicked) {
        logger.warn("Could not click today's day in the calendar to complete the range.");
        return false;
    }

    // Click Apply
    const applyRect = await page.evaluate(() => {
        for (const el of document.querySelectorAll('[role="button"], button')) {
            if ((el.textContent || "").trim() === "Apply") {
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
        }
        return null;
    });
    if (!applyRect) {
        logger.warn("Apply button not found — date range may not have been applied.");
        return false;
    }
    await page.mouse.click(applyRect.x, applyRect.y);
    await new Promise((r) => setTimeout(r, 3000));

    const finalLabel = await page.evaluate(() => {
        for (const el of document.querySelectorAll('[role="button"]')) {
            const t = (el.textContent || "").trim();
            if (/^Custom:/.test(t)) return t;
        }
        return null;
    });
    logger.info(`Date range applied: ${finalLabel || "(label not confirmed, but Apply was clicked)"}`);
    return true;
}

/**
 * Parses a Content Library date string into YYYY-MM-DD.
 * Formats seen: "Today at 5:22 PM", "Yesterday at 7:14 PM", "Jun 30 at 7:14 PM".
 */
function parseContentLibraryDate(text) {
    if (!text) return "unknown";
    const now = new Date();

    if (/^today/i.test(text)) {
        return now.toISOString().slice(0, 10);
    }
    if (/^yesterday/i.test(text)) {
        return new Date(now.getTime() - 86400 * 1000).toISOString().slice(0, 10);
    }
    // "Jun 30 at 7:14 PM" — no year given, assume current year (or previous
    // year if that would put it in the future, e.g. testing in January).
    const match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2})/);
    if (match) {
        const guess = new Date(`${match[1]} ${match[2]}, ${now.getFullYear()}`);
        if (!isNaN(guess.getTime())) {
            if (guess.getTime() > now.getTime() + 86400 * 1000) {
                guess.setFullYear(guess.getFullYear() - 1);
            }
            return guess.toISOString().slice(0, 10);
        }
    }
    return "unknown";
}

/**
 * Extracts every content row currently rendered in the Content Library
 * table. Each row has an <a href="/content/insights/?content_id=...">
 * link — we use that as both the unique ID and the direct navigation
 * target (skips loading the post/reel/video itself entirely).
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array<{contentId, insightsUrl, dateText, isVideoStory, caption}>>}
 */
async function extractContentLibraryRows(page) {
    return page.evaluate(() => {
        const rows = [];
        const seen = new Set();
        const links = document.querySelectorAll('a[href*="/content/insights/"]');

        for (const link of links) {
            const href = link.getAttribute("href") || "";
            const idMatch = href.match(/content_id=([^&]+)/);
            if (!idMatch) continue;
            const contentId = decodeURIComponent(idMatch[1]);
            if (seen.has(contentId)) continue;
            seen.add(contentId);

            // Walk up to the row/gridcell container to read its full text
            // (caption, "Published • <date>", and "Video story" marker).
            const row =
                link.closest('[role="row"], [role="gridcell"]') ||
                link.closest("tr") ||
                link.parentElement;
            const rowText = row ? row.textContent || "" : "";

            const dateMatch = rowText.match(
                /(Today|Yesterday|[A-Za-z]{3,9}\s+\d{1,2})\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)?/i,
            );

            rows.push({
                contentId,
                insightsUrl:
                    "https://www.facebook.com/content/insights/?content_id=" +
                    encodeURIComponent(contentId) +
                    "&entry_point=ProdashCometContentLibraryTable",
                dateText: dateMatch ? dateMatch[0] : "",
                // Both "Video story" and "Photo story" are ephemeral Story
                // reposts of an existing post (confirmed live 2026-07-03 for
                // video; same UI pattern applies to photo stories) — neither
                // has a working reactions dialog, and the underlying content
                // is already discovered separately as its own "post" entry.
                isVideoStory: /(video|photo) story/i.test(rowText),
                caption: rowText.slice(0, 150),
            });
        }
        return rows;
    });
}

/**
 * Discovers posts via the Professional Dashboard's Content Library instead
 * of scraping the public page feed. Advantages over feed scraping:
 *   - Never loads video/reel players — just a metrics table. Much less
 *     bandwidth and rendering work, especially on constrained hardware.
 *   - Gives a direct /content/insights/?content_id=... link per post,
 *     which embeds the post with a working reactions toolbar (regular
 *     posts) — no need to guess "Posts tab" selectors or deal with
 *     shared/quoted posts contaminating results (content_id always
 *     belongs to the page's own content).
 *   - Cleanly identifies reels ("Video story" rows) up front, so they
 *     can be skipped without ever attempting to open a reactions dialog
 *     that we know Facebook doesn't expose for them via this UI.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} dateFrom — ISO date or "all"
 * @param {string} dateTo — ISO date or "all"
 * @param {number} maxPosts
 * @param {number} [yearsBack=3] — how far back the Content Library's own
 *        date-range filter should reach. Anything older is out of scope
 *        entirely per project policy — see PLAN.md §7.
 * @param {number} [maxDiscoveryTimeMs=600000] — wall-clock cap on how long
 *        this scan can run. Each cron run has to re-scroll past every
 *        already-seen row before reaching new ones at the frontier, so as
 *        the 3-year backlog is worked through this naturally gets slower —
 *        this cap guarantees a single cron invocation can't run unboundedly
 *        long. Whatever's found so far is returned; the rest is picked up
 *        by tomorrow's run (same multi-day catch-up as the invite phase).
 * @returns {Promise<Post[]>}
 */
async function discoverPostsFromContentLibrary(page, dateFrom, dateTo, maxPosts, yearsBack = 3, maxDiscoveryTimeMs = 600000) {
    const existing = loadPostList();
    const alreadySeen = new Set(existing.posts.map((p) => p.url).filter(Boolean));

    logger.info(
        `Discovering posts from Content Library (max ${maxPosts}, dateFrom ${dateFrom}, yearsBack ${yearsBack})`,
    );

    await page.goto(CONTENT_LIBRARY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 5000));

    const rangeSet = await setContentLibraryDateRange(page, yearsBack);
    if (!rangeSet) {
        logger.warn(
            "Could not set the Content Library date range via the picker UI — " +
            "falling back to whatever the default (Last 28 days) range shows.",
        );
    }

    const posts = [];
    let stallStreak = 0;
    let totalScrolls = 0;
    const discoveryStart = Date.now();
    // scrollContentLibraryTable() already retries internally for ~15s before
    // reporting no-growth, so a small outer streak is plenty of extra margin
    // (5 consecutive full stalls = ~75s of confirmed no growth = genuinely done).
    const MAX_STALL_STREAK = 5;

    while (posts.length < maxPosts && stallStreak < MAX_STALL_STREAK) {
        if (Date.now() - discoveryStart > maxDiscoveryTimeMs) {
            logger.warn(
                `Discovery time cap (${maxDiscoveryTimeMs}ms) reached with ${posts.length} new posts found — ` +
                "stopping here; the rest will be picked up by a future run.",
            );
            break;
        }
        totalScrolls++;
        if (totalScrolls % 10 === 0) {
            // A run scrolling deep into 3 years of history can go quiet for
            // a while between new-post discoveries (most rows in a given
            // batch are already-seen) — a periodic heartbeat makes it clear
            // the run is still actively working, not stuck.
            logger.info(`... still scrolling (scroll #${totalScrolls}, ${posts.length} new posts found so far)`);
        }
        const rows = await extractContentLibraryRows(page);

        for (const row of rows) {
            if (alreadySeen.has(row.insightsUrl)) continue;
            alreadySeen.add(row.insightsUrl);

            const post = {
                url: row.insightsUrl,
                id: row.contentId,
                timestamp: null,
                date: parseContentLibraryDate(row.dateText),
                status: "pending",
                invitedCount: 0,
                processedAt: null,
                error: null,
                // Content Library labels these "Video story"/"Photo story" —
                // confirmed live (2026-07-02/03) these are ephemeral Story
                // reposts of an existing post, not standalone Reels, and
                // never expose a working reactions dialog. The underlying
                // post is already discovered separately as its own "post"
                // entry, so nothing is lost by treating these as duplicates.
                contentType: row.isVideoStory ? "story" : "post",
            };

            posts.push(post);
            logger.info(
                `Post #${posts.length}: ${post.date} [${post.contentType}] — ${row.caption.slice(0, 60)}`,
            );
            if (posts.length >= maxPosts) break;
        }

        const grew = await scrollContentLibraryTable(page);
        stallStreak = grew ? 0 : stallStreak + 1;
    }

    logger.info(`Discovered ${posts.length} posts total from Content Library.`);

    const filtered = filterByDate(posts, dateFrom, dateTo);
    logger.info(`After date filtering (${dateFrom} to ${dateTo}): ${filtered.length} posts`);

    const merged = mergePostLists(existing.posts, filtered);
    const result = {
        scrapedAt: Date.now(),
        pageUrl: CONTENT_LIBRARY_URL,
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
    discoverPostsFromContentLibrary,
    setContentLibraryDateRange,
    extractContentLibraryRows,
    parseContentLibraryDate,
    loadPostList,
    savePostList,
    markPostStatus,
    switchToMostRecent,
    extractVisiblePosts,
    scrollToBottom,
    scrollContentLibraryTable,
    filterByDate,
    mergePostLists,
    extractDateString,
};
