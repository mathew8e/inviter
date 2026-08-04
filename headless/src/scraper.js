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
// scrollContentLibraryTable
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

    const MAX_TICKS = 30; // ~3s worst case — matches the reactions-dialog patience budget
    for (let i = 0; i < MAX_TICKS; i++) {
        await page.mouse.wheel({ deltaY: 1500 });
        await new Promise((r) => setTimeout(r, 100));
        if ((await countRows()) > before) return true;
    }
    return false;
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
// isEligibleForProcessing
// ──────────────────────────────────────────────

/**
 * True while a post is still within the "fast" recheck window
 * (config.recheckFastWindowDays of its publication date) — the period
 * where most new reactions actually land. Shared by isEligibleForProcessing
 * (which interval applies) and the queue sort in inviter.js (which posts
 * jump ahead of the backlog) so the two stay in sync.
 *
 * @param {object} post
 * @param {number} [now]
 * @returns {boolean}
 */
function isFreshPost(post, now = Date.now()) {
    if (post.date === "unknown") return false;
    const ageMs = now - new Date(post.date).getTime();
    return ageMs <= config.recheckFastWindowDays * 86400000;
}

/**
 * A post is eligible for a processing pass if it's still "pending"/"error",
 * OR if it's "done" and due another look — Facebook posts keep collecting
 * new reactions indefinitely after their first clean scan, so a "done"
 * post needs periodic re-checks forever, not a one-time pass or a pass
 * that stops after some fixed age. Confirmed live (2026-07-24): posts
 * published months ago, whose only check happened long after publication
 * (deep in the historical backlog), still had real un-invited reactors —
 * an earlier version of this function stopped rechecking anything more
 * than 30 days past its PUBLICATION date, which for a post whose first
 * check itself happened 78 days after publication meant zero rechecks,
 * ever. There is no reliable cutoff where a post can never get a new
 * reaction again, so there is no age-based exclusion here anymore — only
 * the interval below, which keeps the ongoing cost bounded.
 *
 * Two-tier schedule: near-every-cron-cycle while the post is still within
 * recheckFastWindowDays of publication (most new reactions land here),
 * tapering to once every recheckIntervalMs forever after that.
 *
 * @param {object} post
 * @param {number} [now]
 * @returns {boolean}
 */
function isEligibleForProcessing(post, now = Date.now()) {
    if (post.status !== "done") return true;
    // Stories never have a working reactions dialog (see contentType
    // comments elsewhere) — they're marked "done" immediately and would
    // otherwise become "eligible" for a pointless recheck every cycle.
    if (post.contentType === "story") return false;
    if (post.date === "unknown") return false;
    const interval = isFreshPost(post, now)
        ? config.recheckFastIntervalMs
        : config.recheckIntervalMs;
    return !post.processedAt || now - post.processedAt >= interval;
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
function markPostStatus(postUrl, { status, invitedCount, error, hitPostTimeCap } = {}) {
    const data = loadPostList();
    const post = data.posts.find((p) => p.url === postUrl);

    if (!post) {
        logger.warn(`markPostStatus: post not found in posts.json: ${postUrl}`);
        return false;
    }

    if (hitPostTimeCap) {
        post.postTimeCapAttempts = (post.postTimeCapAttempts || 0) + 1;
        if (post.postTimeCapAttempts >= config.maxPostTimeCapAttempts) {
            logger.warn(
                `${postUrl.slice(0, 60)}... hit its post-time-cap ${post.postTimeCapAttempts} times ` +
                "without finishing — giving up and marking done. Some of this post's reactors may " +
                "never have been checked.",
            );
            status = "done";
        }
    } else if (status === "done") {
        // Reset so a post that later gets manually reset to "pending" (e.g.
        // by deleting posts.json) doesn't inherit a stale attempt count.
        post.postTimeCapAttempts = 0;
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
// discoverPostsFromContentLibrary — PRIMARY discovery method
// ──────────────────────────────────────────────

const CONTENT_LIBRARY_URL =
    "https://www.facebook.com/professional_dashboard/content/content_library/" +
    "?filter=PUBLISHED&post_type=ALL_CONTENT&sort_by=DATE";

/**
 * Returns the whole-calendar-month gap between two dates (e.g. 2025-10-01 to
 * 2026-07-05 is 9 months) — used to convert an absolute cutoff date into the
 * number of "previous month" calendar clicks setContentLibraryDateRange()
 * needs, since the picker only understands relative month navigation, not
 * absolute dates.
 *
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {number}
 */
function monthsBetween(fromDate, toDate) {
    return (toDate.getFullYear() - fromDate.getFullYear()) * 12 + (toDate.getMonth() - fromDate.getMonth());
}

/**
 * Selects a custom date range in the Content Library's date-range picker,
 * spanning from `sinceDate` to today.
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
 * Takes an absolute cutoff date (not a relative "years back" count) — the
 * project's actual scope has changed over time (originally 3 years, then
 * narrowed to a specific 2025-10-01 backfill start per the page owner's
 * request — see PLAN.md §7), and an absolute date is also what's needed
 * for the planned post-backfill "last 5 days" maintenance window, so this
 * is the one representation that covers both.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} sinceDate — ISO date (YYYY-MM-DD) to use as the range start
 * @param {string|null} [untilDate] — ISO date (YYYY-MM-DD) to use as the range end
 *        (defaults to today). Lets discovery be confined to a narrow window
 *        instead of always spanning to today — see discoverPostsFromContentLibrary's
 *        chunked-window usage, added to work around a reproducible scroll
 *        ceiling on long continuous scrolls (see PLAN.md).
 * @returns {Promise<boolean>} true if the range was set and applied
 */
async function setContentLibraryDateRange(page, sinceDate, untilDate = null) {
    const today = new Date();
    const endDate = untilDate ? new Date(untilDate) : today;
    const startDate = new Date(sinceDate);

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

    // The calendar does NOT open showing the current actual month — it opens
    // showing whatever month the CURRENTLY SELECTED PRESET's start date falls
    // in (e.g. "Last 28 days" selected → opens on last month, not this one).
    // Confirmed live (2026-07-11) this caused a systematic off-by-one in the
    // number of prev/next clicks when the code assumed the calendar always
    // starts on "today"'s month. Read the ACTUAL displayed month/year from
    // the DOM instead of assuming it, and compute clicks relative to that.
    const MONTH_NAMES = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];
    const visibleMonthText = await page.evaluate((names) => {
        const re = new RegExp(`^(${names.join("|")}) \\d{4}$`);
        for (const el of document.querySelectorAll("*")) {
            const t = (el.textContent || "").trim();
            if (re.test(t) && el.children.length === 0) return t;
        }
        return null;
    }, MONTH_NAMES);
    if (!visibleMonthText) {
        logger.warn("Could not read the calendar's visible month — leaving default range in place.");
        return false;
    }
    const [monthName, yearStr] = visibleMonthText.split(" ");
    const calendarMonth = new Date(`${monthName} 1, ${yearStr}`);
    const startMonthsBack = Math.max(0, monthsBetween(startDate, calendarMonth));
    // Forward distance is computed directly between start and end (NOT via a
    // separate "endMonthsBack relative to calendarMonth" — that formula
    // silently clamped to 0 whenever endDate fell in a LATER month than the
    // calendar's opening month, e.g. untilDate=today when the calendar opens
    // on last month; confirmed live 2026-07-11 this produced a wrong applied
    // range, e.g. "Custom: Jun 11 - Jun 27" instead of "Jun 27 - Jul 11").
    // After navigating back startMonthsBack months we're on startDate's own
    // month by construction, so the remaining forward distance to endDate's
    // month is exactly monthsBetween(startDate, endDate).
    const forwardClicks = Math.max(0, monthsBetween(startDate, endDate));
    logger.info(
        `Setting Content Library date range to ${sinceDate} → ${untilDate || "today"} ` +
        `(calendar opened on ${visibleMonthText}; ${startMonthsBack} months back, ` +
        `${forwardClicks} months forward)...`,
    );

    // Coordinates of the calendar's prev/next month chevrons, relative to
    // the picker popup that opens just below/right of the button. Confirmed
    // against a 1280x900 viewport via elementFromPoint + cursor:pointer probing
    // (2026-07-11): the true clickable 16x16 icon sits at x=979/1215 (left
    // edge), so the CENTER is (987, 353) / (1223, 353) — the previous
    // (1004, 355) / (1240, 355) were 17px too far right and landed on a
    // large non-interactive parent container instead of the icon, silently
    // no-op'ing every prev/next click. This was the root cause of the
    // applied range always being wrong (e.g. "Custom: Jun 1 - Jun 11"
    // instead of the intended span) — if the layout shifts, this will need
    // re-verification (see PLAN.md testing notes).
    const PREV_MONTH_XY = [987, 353];
    const NEXT_MONTH_XY = [1223, 353];

    const readVisibleMonth = () => page.evaluate((names) => {
        const re = new RegExp(`^(${names.join("|")}) \\d{4}$`);
        for (const el of document.querySelectorAll("*")) {
            const t = (el.textContent || "").trim();
            if (re.test(t) && el.children.length === 0) return t;
        }
        return null;
    }, MONTH_NAMES);

    // Bounds of the calendar's day-grid, so a stray "1"/"15" elsewhere on the
    // page (badges, indices, etc.) can't be mistaken for a day cell — the
    // un-scoped whole-page search this replaced was a real source of
    // mis-clicks (confirmed live 2026-07-11: mis-clicks sometimes navigated
    // away from Content Library entirely).
    const CALENDAR_BOUNDS = { xMin: 960, xMax: 1260, yMin: 395, yMax: 560 };

    const clickDayInVisibleMonth = async (dayNumber) => {
        const rect = await page.evaluate((day, bounds) => {
            for (const el of document.querySelectorAll("*")) {
                if ((el.textContent || "").trim() === String(day) && el.children.length === 0) {
                    const r = el.getBoundingClientRect();
                    if (
                        r.width > 0 && r.width < 60 &&
                        r.x >= bounds.xMin && r.x <= bounds.xMax &&
                        r.y >= bounds.yMin && r.y <= bounds.yMax
                    ) {
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    }
                }
            }
            return null;
        }, dayNumber, CALENDAR_BOUNDS);
        if (!rect) return false;
        await page.mouse.click(rect.x, rect.y);
        await new Promise((r) => setTimeout(r, 800));
        return true;
    };

    // Click prev/next `count` times, verifying the displayed month actually
    // changed each time (retrying once if not) — a plain fire-and-forget
    // click loop silently no-op'd before (see PREV/NEXT_MONTH_XY note above),
    // and nothing downstream would have caught that.
    const navigateMonths = async (count, xy) => {
        for (let i = 0; i < count; i++) {
            const before = await readVisibleMonth();
            let after = before;
            for (let attempt = 0; attempt < 2 && after === before; attempt++) {
                await page.mouse.click(...xy);
                await new Promise((r) => setTimeout(r, 400));
                after = await readVisibleMonth();
            }
            if (after === before) {
                logger.warn(`Calendar month navigation did not change from "${before}" after retry.`);
            }
        }
    };

    // Navigate back startMonthsBack months, click the start day.
    await navigateMonths(startMonthsBack, PREV_MONTH_XY);
    const startClicked = await clickDayInVisibleMonth(startDate.getDate());
    if (!startClicked) {
        logger.warn("Could not click a start day in the calendar — leaving default range in place.");
        return false;
    }

    // Navigate forward exactly enough months to reach the END date's month,
    // then click the end day.
    await navigateMonths(forwardClicks, NEXT_MONTH_XY);
    const endClicked = await clickDayInVisibleMonth(endDate.getDate());
    if (!endClicked) {
        logger.warn("Could not click the end day in the calendar to complete the range.");
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
 * Selects the "This year: Jan 1 - <today>" preset — a single click, no
 * fragile calendar day-picking required. Only covers Jan 1 of the current
 * year onward, so it can't reach back into a prior year on its own.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if the preset was selected and applied
 */
async function selectThisYearPreset(page) {
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

    const presetRect = await page.evaluate(() => {
        for (const el of document.querySelectorAll("*")) {
            const t = (el.textContent || "").trim();
            if (/^This year:/.test(t) && el.children.length <= 2) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.width < 250) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
        }
        return null;
    });
    if (!presetRect) {
        logger.warn('Could not find the "This year" preset option — leaving default range in place.');
        return false;
    }
    await page.mouse.click(presetRect.x, presetRect.y);
    await new Promise((r) => setTimeout(r, 800));

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
        logger.warn("Apply button not found — This year preset may not have been applied.");
        return false;
    }
    await page.mouse.click(applyRect.x, applyRect.y);
    await new Promise((r) => setTimeout(r, 3000));

    logger.info('Date range applied: This year preset.');
    return true;
}

/**
 * Parses a Content Library date string into YYYY-MM-DD.
 * Formats seen: "Today at 5:22 PM", "Yesterday at 7:14 PM", "Jun 30 at 7:14 PM"
 * (posts under ~1 year old), and "Nov 2, 2025" (older posts — date only, no
 * time, but WITH an explicit year).
 */
/**
 * Formats a Date using its LOCAL calendar components (not toISOString(),
 * which is always UTC). Confirmed live (2026-08-04): the Pi runs in
 * Europe/Prague (UTC+1/+2) — `new Date("July 5, 2026")` parses as local
 * midnight, which is July 4, 22:00/23:00 UTC, so `.toISOString().slice(0,
 * 10)` silently reported every date exactly one day too early. Reading
 * the same Date back with the local getters instead of toISOString()
 * returns the calendar date that was actually intended.
 */
function formatLocalDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function parseContentLibraryDate(text) {
    if (!text) return "unknown";
    const now = new Date();

    if (/^today/i.test(text)) {
        return formatLocalDate(now);
    }
    if (/^yesterday/i.test(text)) {
        return formatLocalDate(new Date(now.getTime() - 86400 * 1000));
    }
    // "Nov 2, 2025" — explicit year given, use it directly rather than
    // guessing (more robust than the current-year heuristic below, and the
    // only path old-enough posts actually reach — confirmed live 2026-07-11
    // this format was silently falling through to "unknown" before the
    // explicit-year capture group was added to extractContentLibraryRows'
    // dateMatch regex).
    const withYear = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
    if (withYear) {
        const guess = new Date(`${withYear[1]} ${withYear[2]}, ${withYear[3]}`);
        if (!isNaN(guess.getTime())) return formatLocalDate(guess);
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
            return formatLocalDate(guess);
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

            // Facebook shows two different date formats depending on age:
            // recent posts show "Jun 30 at 7:14 PM" (with a time), but posts
            // older than roughly a year show just "Nov 2, 2025" (date only,
            // no time). Confirmed live 2026-07-11: the original regex only
            // matched the "at TIME" form, so every older post's dateText
            // came back empty and parseContentLibraryDate() silently
            // returned "unknown" for the entire Oct-Dec 2025 backlog — the
            // exact range this project's backfill needs to reach.
            const dateMatch = rowText.match(
                /(Today|Yesterday|[A-Za-z]{3,9}\s+\d{1,2})(,\s*\d{4})?(\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)?)?/i,
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
 * @param {string} [sinceDate] — absolute ISO date (YYYY-MM-DD) the Content
 *        Library's own date-range filter should reach back to. Anything
 *        older is out of scope entirely per project policy — see PLAN.md §7.
 *        Defaults to config.discoverSinceDate.
 * @param {number} [maxDiscoveryTimeMs=600000] — wall-clock cap on how long
 *        this scan can run. Each cron run has to re-scroll past every
 *        already-seen row before reaching new ones at the frontier, so as
 *        the backlog is worked through this naturally gets slower — this
 *        cap guarantees a single cron invocation can't run unboundedly
 *        long. Whatever's found so far is returned; the rest is picked up
 *        by a future run (same multi-day catch-up as the invite phase).
 * @returns {Promise<Post[]>}
 */
async function discoverPostsFromContentLibrary(
    page, dateFrom, dateTo, maxPosts, sinceDate = config.discoverSinceDate, maxDiscoveryTimeMs = 600000,
    untilDate = null, useThisYearPreset = false,
) {
    const existing = loadPostList();
    const alreadySeen = new Set(existing.posts.map((p) => p.url).filter(Boolean));

    logger.info(
        `Discovering posts from Content Library (max ${maxPosts}, dateFrom ${dateFrom}, ` +
        `sinceDate ${sinceDate}, untilDate ${untilDate || "today"}, ` +
        `useThisYearPreset ${useThisYearPreset})`,
    );

    await page.goto(CONTENT_LIBRARY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 5000));

    const rangeSet = useThisYearPreset
        ? await selectThisYearPreset(page)
        : await setContentLibraryDateRange(page, sinceDate, untilDate);
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
    // Confirmed live (2026-07-10): 5 was FAR too impatient — two consecutive
    // dedicated backfill runs both stalled at exactly this point (~30 total
    // scrolls) while still working through a large already-seen backlog
    // (164 known posts), reporting "0 posts discovered" despite far more
    // history genuinely remaining beyond it. The reactions-dialog scroll
    // loop (reactions.js) tolerates up to 300 consecutive non-growth
    // attempts for the exact same kind of Facebook-side pacing pause — this
    // was inconsistent with that lesson already learned once this session.
    // maxDiscoveryTimeMs (the wall-clock cap) is what actually bounds a
    // single run now; this streak is just a safety net against a truly
    // dead/broken scroll, so it can afford to be generous.
    const MAX_STALL_STREAK = 60;

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
    discoverPostsFromContentLibrary,
    setContentLibraryDateRange,
    selectThisYearPreset,
    extractContentLibraryRows,
    parseContentLibraryDate,
    loadPostList,
    savePostList,
    markPostStatus,
    scrollContentLibraryTable,
    filterByDate,
    mergePostLists,
    isEligibleForProcessing,
    isFreshPost,
};
