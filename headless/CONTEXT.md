# Project Context: Inviter Headless

> Generated: 2026-06-11
> Updated: 2026-06-16 (Phase 6 live testing — multiple bugs fixed, reel handling added)

---

## Overview

**Inviter Headless** is a Puppeteer-based Node.js automation tool that scans Facebook Page posts and automatically invites people who reacted (but don't yet follow) to follow the Page. It runs on a headless Ubuntu server via cron, respects strict rate limits, and operates in two phases: (1) scrape post list from page feed, (2) open reactions popup on each post and click Invite (`Pozvat`) buttons.

**Target page:** `PiratDanielKus` (Czech politician Daniel Kůs)
**Auth method:** Personal Facebook account with delegated Business Suite access to the page

---

## Implementation Progress

| Phase | Module | Status | Date | Notes |
|-------|--------|--------|------|-------|
| 0 | `src/config.js` | ✅ Done | 2026-06-11 | Rate mode table, env vars, frozen config |
| 1 | `src/rate-limiter.js` + `test/phase1-test.js` | ✅ Done | 2026-06-11 | Daily budget, cooldowns, atomic lock, 24 tests |
| 2 | `src/auth.js` | ✅ Done | 2026-06-11 | Login verify, page nav, mid-run session watcher |
| 3 | `src/scraper.js` + `test/phase3-test.js` | ✅ Done | 2026-06-11 | Post discovery, date parsing, headless-ready |
| 4 | `src/reactions.js` + `test/phase4-test.js` | ✅ Done | 2026-06-15 | Reactions dialog, scroll loop, invite click |
| 5 | `src/inviter.js` + `src/index.js` + `test/phase5-test.js` | ✅ Done | 2026-06-15 | Full orchestrator, CLI, 16 unit tests + live dry-run |
| 6 | Live dry-run validation + bug fixing | 🔄 In Progress | 2026-06-16 | Multiple bugs found and fixed, reel handling added |
| 7 | Cron & deployment | ⬜ Pending | — | Crontab, session renewal, server setup |

---

## Project Structure

```
D:\MASTER_FOLDER\PROJECTS\DIGITAL\CODE_PERSONAL\inviter\headless\
├── .env / .env.example        # FB_PAGE_URL, RATE_MODE, HEADLESS, paths
├── Dockerfile                 # node:20-bullseye-slim with Chromium deps
├── docker-compose.yml         # Volume mounts for data/profile
├── package.json               # name: inviter-headless, v0.1.0
├── PLAN.md                    # Architecture & phased implementation plan
├── RULES.md                   # Conventions, testing strategy
├── CONTEXT.md                 # This file
├── data/                      # Runtime data (gitignored)
│   ├── invitations.json       # Invite history database
│   ├── rate-limit-state.json  # Daily budget, cooldown state
│   ├── posts.json             # Post list from scraper
│   └── inviter.lock           # Atomic lock file (prevents concurrent runs)
├── profile/                   # Chrome browser profile (cookies, session)
│   └── Default/
├── test/
│   ├── phase1-test.js         # 24 unit tests (rate-limiter, no browser)
│   ├── phase3-test.js         # Integration test (auth + scraper, live)
│   ├── phase4-test.js         # 11 unit tests (reactions mock DOM)
│   └── phase5-test.js         # 16 unit tests + live dry-run (--live --page / --url)
└── src/
    ├── index.js               # CLI entry (yargs: --page, --url, --dry-run, etc.)
    ├── inviter.js             # Orchestrator: auth → scrape → loop posts → invite
    ├── reactions.js           # Reactions dialog: open, scroll, click Invite
    ├── scraper.js             # Post discovery from page feed
    ├── auth.js                # Login verify, page nav, session watcher
    ├── rate-limiter.js        # Daily budget, cooldowns, lock file
    ├── config.js              # Central config + rate mode table
    ├── storage.js             # JSON persistence (invitations.json)
    ├── session.js             # Chrome launch options, profile discovery
    └── logger.js              # Winston console logger
```

---

## Key Files & Their Roles

### `src/config.js` — Central Configuration

- **Single source of truth** for all configuration.
- Three **rate mode presets** (`paranoid`, `moderate`, `aggressive`) — all timing/budget values come from here.
- Exports a **frozen config object** from `.env` with hardcoded defaults.

**Rate mode table:**

| Setting | paranoid | moderate | aggressive |
|---------|----------|----------|------------|
| dailyMax | 100 | 250 | 500 |
| perPostMax | 30 | 75 | 150 |
| baseDelayMs | 5000 | 3000 | 1500 |
| scrollDelayMs | 3000 | 2000 | 1000 |
| postCooldownMs | 30000 | 15000 | 5000 |
| errorCooldownHours | 48 | 24 | 12 |
| maxPostsPerRun | 5 | 10 | 20 |
| runTimeCapMs | 20 min | 30 min | 45 min |

---

### `src/session.js` — Browser Launch Configuration

- **`getLaunchOptions(profileDir, headless)`**: Returns Puppeteer launch options.
- `headless: "new"` for headless, `false` for visible.
- **`defaultViewport: { width: 1280, height: 900 }`** — critical for headless mode; 800×600 default causes Facebook to render a mobile layout that hides management elements (Insights, reactions toolbar).
- 18 Chrome flags including `--disable-blink-features=AutomationControlled`.

---

### `src/auth.js` — Authentication

- **`ensureLoggedIn(page)`**: Navigates to `facebook.com`, checks URL for `/login/` redirect, checks page title, scans DOM for logged-in indicators. Throws `SessionExpiredError` if session invalid.
- **`navigateToPage(page, pageUrl)`**: Navigates to Page URL, verifies it loaded.
- **`setupNavigationWatcher(page)`**: `framenavigated` listener — if URL goes to `/login/` mid-run, closes page causing a clean error.

---

### `src/scraper.js` — Post Discovery

- **`discoverPostsFromContentLibrary(page, dateFrom, dateTo, maxPosts, sinceDate, maxDiscoveryTimeMs, untilDate, useThisYearPreset)`**: Primary (only) discovery method. Navigates to the Professional Dashboard's Content Library, sets the date range via `setContentLibraryDateRange`/`selectThisYearPreset`, scrolls the virtualized table (`scrollContentLibraryTable`) extracting rows (`extractContentLibraryRows`), saves to `data/posts.json`.
- **`markPostStatus(url, { status, invitedCount, error })`**: Updates a post entry in `posts.json` (used by orchestrator after each post).
- **`loadPostList()` / `savePostList()`**: JSON read/write helpers.
- The older feed-scraping approach (clicking the Posts/All tab and scrolling the public feed) has been removed — it was fully superseded by Content Library discovery and had no remaining callers.

---

### `src/reactions.js` — Reactions Dialog (most complex)

#### Selector constants

```js
const INVITE_SELECTORS = [
    'div[aria-label="Pozvat"][role="button"]',
    'button[aria-label="Pozvat"]',
    'a[role="button"][aria-label*="Pozvat"]',
    'div[aria-label="Invite"][role="button"]',
    'button[aria-label="Invite"]',
    'a[role="button"][aria-label*="Invite"]',
];
const TEST_SELECTORS = [
    'div[aria-label="Sledovat"][role="button"]',  // Czech "Follow"
    'div[aria-label="Follow"][role="button"]',
    'button[aria-label="Sledovat"]',
    'button[aria-label="Follow"]',
];
```

#### `openReactionsDialog(page)`

Three strategies, tried in order:

1. **Strategy 1 (primary):** Find `span[role="toolbar"]` → click `div[role="button"]` with **no `aria-label`** (= "All reactions" button). Individual reaction-type buttons (Like, Angry…) *do* have `aria-label="Like: 54K people"`. Fallback: any button inside the toolbar.
2. **Strategy 2:** Find `div[role="button"][aria-label]` matching `/:\s*[\d.,]+[KMB]?\s/i` (e.g., "Like: 54K people") — opens a filtered dialog, last resort.
3. **Strategy 3:** Text-content search for `"all reactions"` / `"všechny reakce"` / `"see who reacted"`.

After each click: waits 3s, checks if a visible `[role="dialog"]` appeared (using `getComputedStyle`, **not** `offsetParent`).

**Critical bug fixed:** `offsetParent === null` was used everywhere to check visibility. Facebook's modal dialogs use `position: fixed`, which makes `offsetParent === null` even for fully visible elements. All `offsetParent` checks have been replaced with `getComputedStyle` visibility checks.

#### `openReactionsDialogForReel(page)`

Fallback for reel URLs (`/reel/` or `/videos/`) where the standard reactions toolbar doesn't exist on the player page.

Flow:
1. Wait 3s + scroll 300px (management toolbar is lazy-loaded)
2. Try to find "Insights"/"Přehledy" button directly
3. If not found: click the **Menu (⋯)** button (`aria-label="Menu"`) and wait 2s
4. Search again for Insights inside the opened dropdown
5. In the Insights panel: find a reactions-related button and click it
6. Check if a visible `[role="dialog"]` appeared

Logs all button labels on failure for debugging.

#### `scrollAndInvite(page, containerInfo, maxInvites, baseDelayMs, dryRun, selectors)`

The main loop:

- **`MAX_SCROLLS_WITHOUT_NEW = 50`** (was 8 — increased because Facebook mixes already-invited users with uninvited ones)
- **Smart early exit:** if `atBottom && uninvitedCount === 0`, waits `SCROLL_DELAY`, checks if `scrollHeight` grew; if not → breaks immediately (confirmed end of list)
- **Scope:** searches only visible open `[role="dialog"]` elements (not whole document) — fixes the bug where `querySelector('[role="dialog"]')` returned the first (wrong) dialog when multiple are open simultaneously
- **Visibility check:** uses `aria-disabled === "true"` instead of `offsetParent === null`
- **Text keyword fallback:** if CSS selectors find nothing, searches `[role="button"]` elements by `textContent` matching `["Invite", "Pozvat", "Follow", "Sledovat"]`
- **Visual highlighting** (visible mode): orange/yellow outline for 1s before clicking, green after real click, blue after dry-run skip
- **`data-pending="true"`** attribute set during highlight phase; click phase queries `[data-pending="true"]`
- **`data-invited="true"`** set after click (prevents re-click across scroll iterations), set even in dry-run mode

#### `closeReactionsDialog(page)`

Tries `Escape` key first, then looks for `[aria-label="Close"/"Zavřít"]` button.

#### `processPost(page, postUrl, dryRun, selectors, maxInvites)`

Orchestrates: `openReactionsDialog` → if fails + reel URL → `openReactionsDialogForReel` → `findScrollableContainer` → `scrollAndInvite` → `closeReactionsDialog`.

---

### `src/inviter.js` — Orchestrator

**`runWithBrowser(options)`** — the main entry point:

- Launches browser, creates page, sets viewport 1280×900 and user agent
- **Graceful shutdown:** registers `SIGINT`/`SIGTERM` handlers (Ctrl+C) that call an idempotent `cleanup()` function → releases lock + closes browser before exit
- **`cleanup(reason)`** is idempotent (guarded by `cleanupDone` flag) — called from both signal handlers and the `finally` block, whichever runs first
- Acquires lock → verifies login → runs workflow → releases lock in `finally`

**`runPageWorkflow(page, opts)`** — full pipeline:
- Navigates to page → discovers posts → loops pending posts newest-first
- Per post: `gotoAndSettle` → rate-limit check → `reactions.processPost` → `markPostStatus`
- Respects run-time cap, daily budget, and post cooldown between posts

**`runSinglePost(page, url, dryRun, selectors)`** — single-post mode for testing

**`gotoAndSettle(page, url)`** — navigates, injects light color scheme CSS, waits 2s

---

### `src/rate-limiter.js` — Rate Limiting

- **Lock file:** atomic `fs.writeFileSync(path, pid, { flag: 'wx' })` — EEXIST → throws clear error
- **`acquireLock()` / `releaseLock()`** — `releaseLock()` is idempotent (checks `lockHeld` flag)
- **Daily budget:** `canInviteToday()`, `getRemainingBudget()`, `recordInvite(count)`
- **Cooldowns:** `enterCooldown(hours)`, `isInCooldown()`
- **Rate limit detection:** `scanTextForRateLimit(text)` tests 12 patterns (English + Czech). `detectRateLimit(page)` scans the page and enters cooldown if matched.

---

### `src/index.js` — CLI Entry Point

Full yargs CLI:

| Flag | Default | Description |
|------|---------|-------------|
| `--page` | — | Page URL (full workflow) |
| `--url` | — | Single post URL (testing) |
| `--dry-run` | `true` | Scan only, no clicks. Pass `--no-dry-run` to actually invite |
| `--test-selectors` | `false` | Use Follow/Sledovat selectors instead of Invite/Pozvat |
| `--date-from` | `all` | Process posts from this date (`YYYY-MM-DD`) |
| `--date-to` | `all` | Process posts until this date |
| `--max-posts` | `config.maxPostsPerRun` | Max posts this run |
| `--rate-mode` | `paranoid` | `paranoid` / `moderate` / `aggressive` |
| `--profile-dir` | `./profile` | Chrome user data directory |
| `--headless` | `true` | Headless mode |
| `--wait-for-login` | `false` | Open visible browser for manual login |

---

## Phase 6: Bugs Found and Fixed During Live Testing

| Bug | Symptom | Fix |
|-----|---------|-----|
| `offsetParent === null` rejects buttons in fixed-position overlay | Buttons found but not clicked; `openReactionsDialog` Strategy 1 skipped "All reactions" button | Removed all `offsetParent` checks; replaced with `getComputedStyle` visibility checks |
| Wrong dialog found | `querySelector('[role="dialog"]')` returns comment dialog, not reactions dialog (two dialogs in DOM simultaneously) | Changed to `querySelectorAll` filtered by computed visibility |
| No text-content fallback | `aria-label` not yet set by Facebook's JS at scan time | Added `textContent` keyword fallback for button scanning |
| Streak of 8 too low | Script terminates early on lists where Facebook mixes invited/uninvited users | Increased to 50 + smart end-of-list detection (atBottom + stable scrollHeight) |
| Strategy 1 clicked filtered "Like" dialog | `offsetParent !== null` rejected unlabelled "All reactions" button → fallback clicked "Like: 54K people" | Removed `offsetParent` check from Strategy 1 |
| `dry-run` didn't mark buttons as `data-invited` | Same buttons re-counted on each scroll iteration in dry-run | `data-invited="true"` now set regardless of `dryRun` flag |
| Headless mode: management toolbar missing | Default 800×600 viewport triggers Facebook's mobile layout | Set `defaultViewport: { width: 1280, height: 900 }` in `session.js` + `page.setViewport` in `inviter.js` |
| Reel pages: no reactions toolbar | Reel player URL has no `span[role="toolbar"]` | Added `openReactionsDialogForReel`: wait + scroll + click Menu → Insights → reactions |
| Ctrl+C leaves stale lock file | `SIGINT` kills process before `finally` block | Added `process.once("SIGINT"/"SIGTERM")` handlers calling idempotent `cleanup()` |
| `dialogVisible` check still using `offsetParent` | Reactions dialog not detected after click even when visible | Fixed to use `getComputedStyle` across all dialog checks |

---

## Known Open Issues

| Issue | Description | Status |
|-------|-------------|--------|
| **Page context (personal vs page manager)** | After login, Puppeteer is in personal account context — reactions dialog shows "Follow" buttons, not "Invite". Needs a "Switch to Page" step in the login/navigation flow. | Not yet implemented |
| **Reel: Insights in Menu dropdown** | Insights button is inside the ⋯ Menu — code now clicks Menu first, then looks for Insights. Not yet confirmed working end-to-end. | Code written, needs live test |

---

## Data Flow (Current — Phase 5+)

```
CLI (index.js) → inviter.runWithBrowser()
  │
  ├── launchBrowser() → browser.newPage()
  │     └── setViewport(1280×900) + setUserAgent()
  │
  ├── SIGINT/SIGTERM handlers registered (cleanup on Ctrl+C)
  │
  ├── rateLimiter.acquireLock()
  │
  ├── auth.ensureLoggedIn(page)      → verify session on facebook.com
  │
  ├── runPageWorkflow():
  │     ├── auth.navigateToPage(page, pageUrl)
  │     ├── scraper.discoverPostsFromContentLibrary(page, dateFrom, dateTo, maxPosts, …)
  │     │     └── saves to data/posts.json
  │     │
  │     └── FOR EACH pending post (newest first):
  │           ├── gotoAndSettle(page, post.url)
  │           ├── rateLimiter.detectRateLimit(page)
  │           ├── reactions.processPost(page, post.url, dryRun, selectors, maxInvites)
  │           │     ├── openReactionsDialog(page)           ← tries 3 strategies
  │           │     │     └── [reel fallback] openReactionsDialogForReel(page)
  │           │     ├── findScrollableContainer(page)
  │           │     ├── scrollAndInvite(page, container, …) ← main invite loop
  │           │     └── closeReactionsDialog(page)
  │           ├── rateLimiter.recordInvite(count)
  │           ├── storage.saveHistory(post.url, count, meta)
  │           └── scraper.markPostStatus(post.url, { status, invitedCount })
  │
  └── finally: cleanup() → releaseLock() + browser.close()
```

---

## Test Commands

```bash
# Unit tests (no browser)
node test/phase5-test.js

# Live dry-run — full page workflow (finds posts, opens reactions, scans — NO clicks)
node test/phase5-test.js --live --page "https://www.facebook.com/PiratDanielKus" --visible

# Live dry-run — single post, visible browser
node test/phase5-test.js --live --url "https://www.facebook.com/..." --visible

# Live dry-run — single reel, headless
node test/phase5-test.js --live --url "https://www.facebook.com/reel/1652230619401323"

# Real run (dry-run is default ON — pass --no-dry-run for actual invites)
node src/index.js --page "https://www.facebook.com/PiratDanielKus" \
  --profile-dir ./profile --rate-mode paranoid --max-posts 1
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `puppeteer` | Browser automation |
| `yargs` | CLI argument parsing |
| `winston` | Logging |
