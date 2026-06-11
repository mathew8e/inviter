# Project Context: Inviter Headless

> Generated: 2026-06-11
> Updated: 2026-06-11 (after Phase 0–3, scraper working against real page)

---

## Overview

**Inviter Headless** is a Puppeteer-based Node.js automation tool that scans Facebook Page posts and automatically invites people who reacted (but don't yet follow) to follow the Page. It runs on a headless Ubuntu server via cron, respects strict rate limits, and operates in two phases: (1) scrape post list from page feed, (2) open reactions popup on each post and click Invite (`Pozvat`) buttons.

**Milestone A reached (Phase 3 complete):** The scraper authenticates, discovers posts from the real politician's page (`PiratDanielKus`), extracts URLs and dates, and saves to `data/posts.json`. Tested working in both visible and headless modes.

**Planning documents:** `PLAN.md` (architecture & design), `RULES.md` (conventions, phased breakdown, testing strategy, two-phase execution model). Milestone links: see Section 4 (Core Workflow) and Section 5 (Module-by-Module) in PLAN.md.

---

## Implementation Progress

| Phase | Module | Status | Date | Notes |
|-------|--------|--------|------|-------|
| 0 | `src/config.js` | ✅ Done | 2026-06-11 | Rate mode table, env vars, single source of truth |
| 1 | `src/rate-limiter.js` + `test/phase1-test.js` | ✅ Done | 2026-06-11 | Daily budget, cooldowns, atomic lock file, 24 tests |
| 2 | `src/auth.js` | ✅ Done | 2026-06-11 | Login verify, page nav, mid-run session watcher |
| 3 | `src/scraper.js` + `test/phase3-test.js` | ✅ Done | 2026-06-11 | Post discovery, date parsing, headless-ready |
| 4 | `test/mock-reactions-dialog.html` | ⬜ **NEXT** | — | Mock Facebook reactions popup for safe testing |
| 5 | `src/reactions.js` | ⬜ Pending | — | Popup open, scroll loop, invite clicking |
| 6 | `src/inviter.js` (refactor) | ⬜ Pending | — | Orchestrator wiring all modules together |
| 7 | `src/index.js` (CLI update) | ⬜ Pending | — | New flags: --page, --dry-run, --date-from, --rate-mode |
| 8 | `src/storage.js` (enhance) | ⬜ Pending | — | Post list persistence, no peopleNames |
| 9 | `src/logger.js` (file transport) | ⬜ Pending | — | File transport + 30-day log rotation |
| 10 | Cron & deployment finalization | ⬜ Pending | — | Lock file, crontab, session renewal |

---

## Project Structure

```
D:\MASTER_FOLDER\PROJECTS\DIGITAL\CODE_PERSONAL\inviter\headless\
├── .dockerignore          # Excludes node_modules, profile, data from Docker build
├── .env.example           # Env vars: FB_PAGE_URL, RATE_MODE, HEADLESS, paths
├── Dockerfile             # node:20-bullseye-slim with Chromium deps
├── docker-compose.yml     # Docker Compose service definition
├── package.json           # npm package (name: inviter-headless, v0.1.0)
├── package-lock.json
├── nodeinstal.bash        # Script to install Node dependencies
├── README.md              # Usage instructions
├── PLAN.md                # Architecture & design document
├── RULES.md               # Conventions, phased breakdown, testing strategy
├── CONTEXT.md             # This file — project context for LLM
├── data/                  # Runtime data directory (gitignored)
│   ├── invitations.json   # Invite history database (JSON array)
│   ├── rate-limit-state.json  # NEW (Phase 1) — daily budget, cooldown state
│   ├── posts.json         # NEW (Phase 3) — post list from Phase 1 scraping
│   └── inviter.lock       # NEW (Phase 1) — atomic lock file
├── profile/               # Chrome browser profile for session reuse
│   └── Default/           # Full Chrome user data directory
├── test/                  # NEW — test files
│   └── phase1-test.js     # Phase 1 unit tests (24 tests, no Puppeteer)
└── src/
    ├── index.js           # CLI entry point (yargs-based, to be updated Phase 7)
    ├── inviter.js         # Core automation logic (to be refactored, Phase 6)
    ├── logger.js          # Winston logger (console transport, Phase 9)
    ├── session.js         # Chrome launch options & profile discovery
    ├── storage.js         # JSON-based invite history persistence (Phase 8)
    ├── config.js          # NEW (Phase 0) — central config + rate mode table
    └── rate-limiter.js    # NEW (Phase 1) — daily budget, cooldowns, lock file
```

---

## Key Files & Their Roles

### 1. `src/config.js` — Central Configuration (NEW, Phase 0)

- **Single source of truth** for all configuration.
- Contains the **rate mode table** (`paranoid`, `moderate`, `aggressive`) — all values (`maxPostsPerRun`, `dailyMax`, `perPostMax`, delays, cooldowns) come from here. No duplication.
- Exports a **frozen config object** derived from `.env` with hardcoded defaults.
- Precedence (once Phase 7 CLI is done): CLI flags > `.env` > defaults.
- Detects invalid `RATE_MODE` values and throws a clear error.

**Rate mode table:**

| Setting | paranoid | moderate | aggressive |
|---------|----------|----------|------------|
| dailyMax | 100 | 250 | 500 |
| perPostMax | 30 | 75 | 150 |
| baseDelayMs | 5000 | 3000 | 1500 |
| randomExtraMs | 5000 | 3000 | 1500 |
| scrollDelayMs | 3000 | 2000 | 1000 |
| postCooldownMs | 30000 | 15000 | 5000 |
| errorCooldownHours | 48 | 24 | 12 |
| maxPostsPerRun | 5 | 10 | 20 |
| runTimeCapMs | 20 min | 30 min | 45 min |

**Environment variables read:**

| Variable | Default | Description |
|----------|---------|-------------|
| `FB_PAGE_URL` | `""` | Target Facebook Page URL |
| `FB_PAGE_ID` | `""` | Page numeric ID or username |
| `RATE_MODE` | `paranoid` | `paranoid` / `moderate` / `aggressive` |
| `DATE_FROM` | `all` | Start date for post scraping (`YYYY-MM-DD`) |
| `DATE_TO` | `all` | End date for post scraping (`YYYY-MM-DD`) |
| `PROFILE_DIR` | `./profile` | Chrome user data directory |
| `DATA_DIR` | `./data` | Runtime data directory |
| `LOGS_DIR` | `./logs` | Log output directory |
| `DB_PATH` | `./data/invitations.json` | Invite history path |
| `POSTS_PATH` | `./data/posts.json` | Post list path (Phase 3) |
| `RATE_LIMIT_PATH` | `./data/rate-limit-state.json` | Rate limit state path |
| `HEADLESS` | `true` | Headless mode toggle |
| `USER_AGENT` | Chrome 120 Linux | Custom user agent |
| `PUPPETEER_EXECUTABLE_PATH` | auto-detected | Chromium binary path |
| `PUPPETEER_PROTOCOL_TIMEOUT` | `300000` | Protocol timeout in ms |

### 2. `src/rate-limiter.js` — Rate Limiting (NEW, Phase 1)

- **Lock file** management: atomic `fs.writeFileSync(path, pid, { flag: 'wx' })` — no race condition.
- **Daily budget**: `canInviteToday()` checks today's count vs `config.dailyMax`, `getRemainingBudget()` returns remaining invites.
- **Cooldowns**: `enterCooldown(hours)` sets cooldown, `isInCooldown()` checks current status, auto-expires when time passes.
- **Rate limit detection**: `scanTextForRateLimit(text)` is a pure function testing 12 patterns (English + Czech). `detectRateLimit(page)` scans a Puppeteer page's full text and triggers cooldown if any pattern matches.
- **Recording**: `recordInvite(count)` increments daily counter after successful clicks. `resetErrorCounter()` clears error streak on clean runs.
- **Daily reset**: `resetDailyIfNeeded()` automatically detects date changes and resets counters. Does NOT clear cooldowns (time-based).
- **State file**: `data/rate-limit-state.json` — `{ date, invitesToday, dailyLimit, lastInviteTimestamp, isCooldown, cooldownUntil, consecutiveErrors }`.
- **Config passthrough**: `getLimitPerPost()`, `getRunTimeCap()`, `getPostCooldown()` for convenience.
- **24 unit tests** in `test/phase1-test.js` cover all functions without needing Puppeteer.

### 3. `src/auth.js` — Authentication (NEW, Phase 2)

- **`ensureLoggedIn(page)`**: Navigates to facebook.com, checks URL for `/login/` redirects, checks page title ("Log in to Facebook"), scans DOM for logged-in indicators. Throws `SessionExpiredError` if session is invalid.
- **`navigateToPage(page, pageUrl)`**: Navigates to Page URL, verifies it loaded (no "page not found" text).
- **`setupNavigationWatcher(page)`**: Listens for `framenavigated` events. If URL redirects to `/login/` mid-run, closes the page causing a clean error.
- **Tested**: Against real `PiratDanielKus` page with valid Business Suite session.

### 4. `src/scraper.js` — Post Discovery (NEW, Phase 3 — MILESTONE A)

- **`discoverPosts(page, pageUrl, dateFrom, dateTo, maxPosts)`**: Main entry point. Clicks tab (Posts/All/Příspěvky), scrolls to load posts, extracts URLs + dates, saves to `data/posts.json`.
- **Tab detection**: Tries "Posts", "Příspěvky", "All". Managed pages (Business Suite) use "All".
- **Scrolling**: `scrollToBottom()` — scrolls to `document.body.scrollHeight`, detects growth. Stops after 4 consecutive scrolls with no new content.
- **Post URL discovery**: (1) Time-text links — `<a>` with text like "5d", "1w", "Yesterday at 2:22 AM" (these ARE post timestamps). (2) URL patterns — `/reel/NUMBER`, `/posts/pfbid...`, `/photo/?fbid=NUMBER`.
- **Date parsing**: Handles relative ("5d", "1w"), absolute words ("Yesterday", "Today"), absolute dates ("May 23 at 7:36 PM"), `data-utime`. Outputs `YYYY-MM-DD`.
- **Deduplication**: URLs cleaned (params stripped), checked against `alreadySeen` across scrolls, merged with existing `posts.json`.
- **Filtering**: Excludes dashboard, groups, inbox, settings, photo albums, page URL itself.
- **Test results**: 20 posts from `PiratDanielKus` in headless. All URLs clean (`/reel/` or `/posts/pfbid`). 19/20 dates correct. Zero false positives.
- **Test script**: `test/phase3-test.js`. Usage: `node test/phase3-test.js --page URL --max N [--visible] [--date-from YYYY-MM-DD]`.

### 5. `src/index.js` — CLI Entry Point (to be updated Phase 7)
  | Flag | Type | Default | Description |
  |---|---|---|---|
  | `--url` | string | **(required)** | Facebook post URL to scan |
  | `--max` | number | 1000 | Max invites before stopping |
  | `--delay` | number | 1000 | Base delay between clicks (ms) |
  | `--profile-dir` | string | — | Chrome user data dir for login reuse |
  | `--headless` | boolean | true | Run browser in headless mode |
- Flow: initializes storage → calls `inviter.runWithBrowser()` → logs result → exits.
- **To be updated in Phase 7** with new flags: `--page`, `--dry-run`, `--date-from`, `--date-to`, `--rate-mode`.

### 4. `src/inviter.js` — Core Automation Logic (to be refactored Phase 6)

- Launches Puppeteer with config from `session.js`.
- Navigates to the target Facebook post URL.
- **Injects CSS** to force light color scheme (fixes black-background/unreadable-text issues).
- **Scans for invite buttons** using 6 CSS selectors:
    ```js
    'div[aria-label="Pozvat"][role="button"]',
    'button[aria-label="Pozvat"]',
    'a[role="button"][aria-label*="Pozvat"]',
    'div[aria-label="Invite"][role="button"]',
    'button[aria-label="Invite"]',
    'a[role="button"][aria-label*="Invite"]',
    ```
- **Clicks invite buttons** inside the page context (`page.evaluate`):
    - De-duplicates elements via `Set`.
    - Skips already-invited elements (`data-invited` attribute).
    - Scrolls each element into view before clicking.
    - Adds randomized delay: `delay + random(0–500)ms`.
    - Stops when `max` is reached.
- Saves invite history to storage.
- Supports both `Pozvat` (Czech/Slovak) and `Invite` (English) button labels.
- **Current limitation**: No popup/dialog logic. Only works if invite buttons are already in the DOM. Phase 6 will refactor `inviter.js` into an orchestrator that wires together `auth.js`, `scraper.js`, `reactions.js`, and `rate-limiter.js`.

### 5. `src/session.js` — Browser Launch Configuration

- **`findCachedLinuxChrome()`**: Searches `~/.cache/puppeteer/chrome/linux-*` for a cached Chromium executable.
- **`getLaunchOptions(profileDir, headless)`**: Returns Puppeteer launch options:
    - `headless`: Configurable (default `true`).
    - `args`: 18 Chrome flags including `--no-sandbox`, `--disable-gpu`, `--disable-blink-features=AutomationControlled`, etc.
    - `protocolTimeout`: From env `PUPPETEER_PROTOCOL_TIMEOUT` or 300s default.
    - `userDataDir`: Set if `profileDir` is provided.
    - `executablePath`: From env `PUPPETEER_EXECUTABLE_PATH`, or falls back to cached Linux Chrome.

### 6. `src/storage.js` — Persistence Layer (to be enhanced Phase 8)

- Stores invite history in `data/invitations.json` (or custom path via `DB_PATH` env var).
- Structure: JSON array of `{ id, ts (Date.now()), url, count }`.
- Two functions:
    - `init()`: Creates data directory and initializes empty JSON array file.
    - `saveHistory(url, count)`: Appends a new entry and writes back.
- **Phase 8 will add**: `loadPostList()`, `savePostList()`, `markPostProcessed()`, `isPostProcessed()` for the two-phase post list system. Will remove `peopleNames` from schema (privacy).

### 7. `src/logger.js` — Logging (to be enhanced Phase 9)

- Uses **winston** with a single `Console` transport at `info` level.
- Format: simple (`winston.format.simple()`).
- **Phase 9 will add**: file transport to `logs/run-YYYY-MM-DD.log` + 30-day log rotation.

---

## Data Flow (Current)

```
CLI (index.js)
  │
  ├── storage.init()        → creates data/ dir & invitations.json
  │
  └── inviter.runWithBrowser({
        url, max, delay, profileDir, headless
      })
        │
        ├── session.getLaunchOptions()  → Puppeteer launch config
        │
        ├── puppeteer.launch(options)
        │     └── browser.newPage()
        │
        ├── page.goto(url)
        │     ├── Inject CSS (light color scheme)
        │     └── Wait 2s for dynamic render
        │
        ├── Scan DEFAULT_SELECTORS → log stats
        │
        ├── Click invite buttons (inside page context)
        │     ├── Deduplicate via Set
        │     ├── Scroll into view + click
        │     ├── Mark as data-invited="true"
        │     └── Randomized delay between clicks
        │
        └── storage.saveHistory(url, count)
              └── Append to data/invitations.json
```

## Data Flow (Target — after Phase 6)

```
CLI (index.js)
  │
  ├── config (rate mode, paths, date range)
  │
  ├── rateLimiter.acquireLock()
  │
  └── inviter.runWithBrowser(...)
        │
        ├── auth.ensureLoggedIn(page)
        ├── auth.navigateToPage(page)
        │
        ├── [Phase 1] scraper.discoverPosts(page, dateFrom, dateTo)
        │     └── Save to data/posts.json
        │
        ├── FOR EACH pending post:
        │     ├── rateLimiter.canInviteToday()
        │     ├── page.goto(post.url)
        │     ├── rateLimiter.detectRateLimit(page)
        │     ├── reactions.openReactionsDialog(page)
        │     ├── reactions.findScrollableContainer(page)
        │     ├── reactions.scrollAndInvite(container, limits, delay)
        │     ├── storage.markPostProcessed(post.url, count)
        │     └── rateLimiter.recordInvite(count)
        │
        └── rateLimiter.releaseLock()
```

---

## Environment Variables (Updated after Phase 0)

| Variable | Default | Description |
|----------|---------|-------------|
| `FB_PAGE_URL` | `""` | Target Facebook Page URL |
| `FB_PAGE_ID` | `""` | Page numeric ID or username |
| `RATE_MODE` | `paranoid` | `paranoid` / `moderate` / `aggressive` |
| `DATE_FROM` | `all` | Start date for post scraping (`YYYY-MM-DD`) |
| `DATE_TO` | `all` | End date for post scraping |
| `PROFILE_DIR` | `./profile` | Chrome user data directory |
| `DATA_DIR` | `./data` | Runtime data directory |
| `LOGS_DIR` | `./logs` | Log output directory |
| `DB_PATH` | `./data/invitations.json` | Invite history path |
| `POSTS_PATH` | `./data/posts.json` | Post list path |
| `RATE_LIMIT_PATH` | `./data/rate-limit-state.json` | Rate limit state path |
| `HEADLESS` | `true` | Headless mode toggle |
| `USER_AGENT` | Chrome 120 Linux | Custom user agent |
| `PUPPETEER_EXECUTABLE_PATH` | auto-detected | Chromium binary path |
| `PUPPETEER_PROTOCOL_TIMEOUT` | `300000` | Protocol timeout in ms |

---

## Dependencies

| Package     | Version               | Purpose              |
| ----------- | --------------------- | -------------------- |
| `puppeteer` | ^21.0.0               | Browser automation   |
| `yargs`     | (bundled via require) | CLI argument parsing |
| `winston`   | (bundled via require) | Logging              |

---

## Docker Support

- **Dockerfile**: Based on `node:20-bullseye-slim` with ~30 Chromium system dependencies installed.
- **docker-compose.yml**: Mounts `./data` and `./profile` directories as volumes.
- **Usage**:
    ```bash
    docker build -t inviter-headless .
    docker run --rm -v $(pwd)/data:/usr/src/app/data \
      -v $(pwd)/profile:/usr/src/app/profile \
      inviter-headless node src/index.js \
      --url "<post-url>" --max 5 --profile-dir /usr/src/app/profile
    ```

---

## Git History Highlights (most recent first)

| Commit    | Message                                                          |
| --------- | ---------------------------------------------------------------- |
| `c54f7d0` | Update README and package.json; refactor index.js and inviter.js |
| `f421dbf` | Fixed black background and unreadable text (CSS injection)       |
| `dd10003` | Scroll handling + adjustable rounds for dry run                  |
| `39dce7f` | Simplify invite logic, improve node selection                    |
| `3f8839e` | Add dry-run option                                               |
| `689bf34` | Increase max follows/invites limit, enhance selectors            |
| `1ce8061` | Add invite-follow option (Follow buttons)                        |
| `e9769fb` | Headless Puppeteer scaffold, CLI, storage, Dockerfile            |

---

## Scroll & Popup/Dialog Selection — Detailed Analysis

### Current Version (commit `c54f7d0`, HEAD)

The current `inviter.js` has **no popup/dialog selection logic** and **no scrolling loop**. It simply:

1. Navigates to the post URL.
2. Injects CSS for light color scheme.
3. Waits 2 seconds for dynamic rendering.
4. Scans the **entire page** for buttons matching `DEFAULT_SELECTORS` (6 CSS selectors targeting `Pozvat`/`Invite` `aria-label`).
5. Clicks each found button with `el.scrollIntoView()` + `el.click()` + randomized delay.

**Limitation**: This only works if the invite buttons are already rendered in the DOM at page load. It does **not** open the reactions popup, scroll within a dialog, or handle the Facebook reactions overlay.

---

### Original Popup/Dialog Selection Logic (Removed in `c54f7d0`)

Earlier versions (up to commit `f421dbf`) had a comprehensive multi-step popup-opening and dialog-scrolling flow. Here's how it worked:

#### Step 1: Open the Reactions Popup ("All reactions" opener)

```js
// Try clicking the 'All reactions' opener or toolbar that reveals people who reacted
const openerClicked = await page.evaluate(() => {
    // Strategy 1: Exact 'All reactions' button with role=button
    const roleButtons = Array.from(document.querySelectorAll('[role="button"]'));
    const exactAll = roleButtons.find(b => /^all reactions[:\s]?/i.test(b.innerText));

    // Strategy 2: Toolbar with aria-label matching localized variants
    const toolbar = document.querySelector('[role="toolbar"][aria-label]');
    // Checks for: "see who reacted", "reakce" (Czech), "reagoval", "people", "lidé"

    // Strategy 3: Any visible element with text "All reactions" or localized variants
    const candidates = Array.from(document.querySelectorAll('[role="button"], div, span'));
    // Checks for: /all reactions/i, /see who reacted/i, /reakce/i, /people/i, /lidé/i

    // Strategy 4: Elements with numeric count + "others" nearby
    // Matches patterns like "50 others", "30 people"
});
```

The opener detection used **4 fallback strategies**, from most specific (exact `role="button"` with text "All reactions") to most heuristic (any element with numbers + "others").

#### Step 2: Debug Dump (if opener not found)

If no opener was found, the tool would:
- Dump the full page HTML to `data/page-debug-{timestamp}.html`
- Search for text matches and compute an XPath for the candidate opener element
- Attempt to click via `page.$x()` (XPath-based Puppeteer click)
- Dump all button candidates (text, aria-label, role, classes, outerHTML) to `data/button-candidates-{timestamp}.json`

#### Step 3: Wait for the Dialog to Appear

```js
await page.waitForTimeout(1200);
await Promise.race([
    page.waitForSelector('[role="dialog"]', { timeout: 3000 }).catch(() => {}),
    page.waitForSelector('[role="list"]', { timeout: 3000 }).catch(() => {}),
]);
```

This waited for a Facebook dialog (`[role="dialog"]`) or list (`[role="list"]`) to render after clicking the reactions opener.

#### Step 4: Find the Scrollable Container Inside the Dialog

The `findScrollable()` function (commit `689bf34` / `dd10003`) searched for the correct scrollable container inside the popup:

```js
function findScrollable() {
    // 1. Find all dialogs: document.querySelectorAll('[role="dialog"]')
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));

    for (const dialog of dialogs) {
        // 2. Look for descendants containing Follow/Invite buttons
        const candidates = Array.from(dialog.querySelectorAll('*'));
        let best = null, bestCount = 0;

        for (const candidate of candidates) {
            // Count how many follow/invite buttons are inside this candidate
            let count = 0;
            for (const selector of selectors) {
                count += candidate.querySelectorAll(selector).length;
            }

            if (count > 0) {
                const overflowY = window.getComputedStyle(candidate).overflowY;
                const scrollable = overflowY === 'auto' || overflowY === 'scroll'
                    || candidate.scrollHeight > candidate.clientHeight;

                // Prefer scrollable containers
                if (scrollable) return candidate;
                if (count > bestCount) { best = candidate; bestCount = count; }
            }
        }

        // 3. Fallback to the dialog itself if scrollable
        if (dialog.scrollHeight > dialog.clientHeight) return dialog;
    }

    // 4. Fallback: any large scrollable div on the page
    // 5. Last resort: document.scrollingElement || document.body
}
```

This algorithm:
1. Found all `[role="dialog"]` elements (Facebook's popup overlay).
2. Within each dialog, searched descendant elements for those containing follow/invite buttons.
3. Among button-containing elements, **preferred scrollable ones** (`overflow: auto/scroll` or `scrollHeight > clientHeight`).
4. Fell back to the dialog itself if scrollable.
5. Fell back to any large page div with overflow.
6. Last resort: the document's scrolling element or body.

#### Step 5: Pre-scroll the Dialog to Load More Users

Before scanning for buttons, the tool pre-scrolled the container to trigger Facebook's lazy-loading:

```js
// Commit dd10003 version
const container = findScrollable();
const total = Math.max(container.scrollHeight || 1000, 1000);
const step = Math.floor(total / 6) || 400;
for (let i = 0; i < 10; i++) {
    container.scrollBy({ top: step, behavior: "smooth" });
    await new Promise(r => setTimeout(r, 450));
}
```

This performed 10 scroll steps with 450ms delays between them.

#### Step 6: Iterative Scroll-and-Invite Loop

Commit `39dce7f` (before simplification) had a full **while-loop** that scrolled, scanned, and invited iteratively:

```js
const scrollable = findScrollable();
let consecutiveNoNewButtons = 0;
let lastScrollHeight = -1;

while (clicked.length < maxInvites && consecutiveNoNewButtons <= noNewButtonsLimit) {
    // 1. Scan for new buttons in the current viewport
    const found = [];
    for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
            if (!isVisible(node) || !matchesTarget(node)) continue;
            if (seenNodes.has(node)) continue;
            seenNodes.add(node);
            found.push(node);
        }
    }

    // 2. Scroll to each found button and click
    for (const node of found) {
        node.scrollIntoView({ block: "center", inline: "center" });
        await sleep(250);
        if (simulateOnly) { /* record */ continue; }
        node.click();
        node.setAttribute("data-invited", "true");
        await sleep(delayMs + 500);
    }

    // 3. Scroll the container down to load more
    if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
    }
    await sleep(1200);
}
```

Key features of this loop:
- **`seenNodes` (WeakSet)**: Tracks already-processed nodes across scroll cycles.
- **`consecutiveNoNewButtons`**: Counter that breaks the loop after 5 consecutive scrolls with no new buttons found.
- **`lastScrollHeight`**: Detects when the container stops growing (no more content to load).
- **Scrolls to bottom** of the container to trigger Facebook's infinite scroll.

#### Step 7: Scrolling Within the Dialog (Commit `dd10003`)

Commit `dd10003` replaced the while-loop with a **for-loop with fixed scroll rounds**:

```js
const root = findScrollable();
let lastScrollTop = -1;

for (let round = 0; round < scrollRounds; round++) {
    // Scan for all buttons visible in current viewport
    const nodes = [];
    for (const selector of selectors) {
        const scope = root || document;
        const matches = Array.from(scope.querySelectorAll(selector));
        for (const node of matches) {
            if (!isVisible(node) || !matchesTarget(node)) continue;
            nodes.push(node);
        }
    }

    // Click all found buttons
    const uniqueNodes = Array.from(new Set(nodes));
    for (const node of uniqueNodes) { /* click logic */ }

    // Scroll incrementally within the popup
    if (root && root.scrollHeight > root.clientHeight) {
        const currentTop = root.scrollTop || 0;
        const nextTop = currentTop + Math.max(200, Math.floor(root.clientHeight * 0.8));
        root.scrollTop = nextTop;
        if (root.scrollTop === lastScrollTop) break; // Stop if scrolled to bottom
        lastScrollTop = root.scrollTop;
    } else {
        window.scrollBy(0, Math.max(200, window.innerHeight * 0.8));
    }
}
```

This version:
- Scrolled in increments of **80% of the container height** (or 200px minimum).
- Detected scroll end by comparing `scrollTop` before and after (if no change → reached bottom).
- Used `scrollRounds = 2` for dry-run, `5` for actual invites.

---

### Evolution Timeline (Scrolling & Popup)

| Commit | State | Key Changes |
|---|---|---|
| `81d6128` | **Initial** | Headless Puppeteer scaffold, basic navigation |
| `689bf34` | **Full implementation** | Reactions opener click → dialog detection → `findScrollable()` → iterative scroll-and-invite while-loop → `seenNodes` tracking → `consecutiveNoNewButtons` break condition |
| `3f8839e` | **Dry-run added** | `simulateOnly` flag to log matches without clicking |
| `39dce7f` | **Simplified** | **Removed** the entire scroll loop, `WeakSet`, `consecutiveNoNewButtons`, `findScrollable()`. Replaced with flat scan of all DOM nodes at once using `findScrollable()` scope. |
| `dd10003` | **Scroll rounds added** | Reintroduced scrolling as a **for-loop** (`scrollRounds`) with incremental scroll (80% height steps). Added scroll-end detection. |
| `f421dbf` | **CSS fix** | Added light color-scheme injection to fix black background. |
| `c54f7d0` | **Streamlined (CURRENT)** | **Removed ALL** popup/dialog logic, `findScrollable()`, opener detection, scroll loops. Only does flat button scan + click. No reactions popup handling. |

---

### Why the Popup/Scroll Logic Was Removed

The current streamlined version:
- Only works if **invite buttons are already visible on the page** (e.g., a group member list or event attendees page where buttons render natively).
- Does **not** open the reactions popup, so if the URL is a post, the tool will likely find **zero** buttons.
- Has no scrolling loop, so only buttons in the initial viewport are clicked.

If you need the full reactions-popup + scrolling functionality again, the code exists in commits `689bf34` through `f421dbf` and can be restored from git history.

---

## Key Observations

1. **Facebook selectors target `Pozvat` (Czech/Slovak) and `Invite` (English)** — the tool is designed for multilingual use.
2. **All interaction runs inside `page.evaluate()`** — clicks happen in the browser context, not via Puppeteer's `page.click()`. This means no navigation handling between clicks.
3. **No pagination/scroll loop in current version** — the current code only clicks buttons visible at page load. Earlier commits (up to `f421dbf`) had full scroll-and-invite loops within dialog popups that were removed.
4. **Storage uses JSON** (despite the name suggesting `invites.db` in `.env.example`).
5. **Profile directory** contains a real Chrome profile with cookies, localStorage, and session data — enabling login reuse without re-authentication.
6. **The `package.json` main field points to `src/login.js`** which doesn't exist — this is a legacy reference; actual entry point is `src/index.js`.
7. **New architecture uses two-phase execution** (Phase 1: scrape post list → Phase 2: invite from list) for crash-resilience and resumability.
8. **Rate mode is the single source of truth** for all timing/budget values — no duplication between config files.
