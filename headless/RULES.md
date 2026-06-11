# RULES.md — Inviter Headless

> **Purpose:** Project rules, conventions, phased feature breakdown, and testing strategy.
> **Last updated:** 2026-06-11
> **Companion docs:** `PLAN.md` (architecture/design), `CONTEXT.md` (existing codebase analysis)

---

## 0. Core Principles

1. **One module, one concern.** Each `src/*.js` file does exactly one thing.
2. **Fail safe.** Never attempt programmatic re-login. Never retry on rate-limit errors. If something unexpected happens, stop and log clearly.
3. **Small chunks.** Each implementation step targets ONE module or ONE feature. No mega-PRs. The LLM gets one task at a time.
4. **Test with mocks.** No test page available → we build a local mock HTML page that mirrors Facebook's reactions dialog structure. All popup/scroll/invite logic is validated against the mock before touching real Facebook.
5. **Two-phase execution.** Scraping the post list and inviting from posts are separate phases. This means resumption is trivial — if a run crashes, it picks up from the list.

---

## 1. Conventions

### 1.1 Code Style

| Rule | Detail |
|------|--------|
| **Language** | JavaScript (Node.js 20), CommonJS (`require`/`module.exports`) for now — don't convert to ESM unless deliberately planned |
| **Async** | `async/await` everywhere. No `.then()` chains. |
| **Error handling** | Every async function either handles errors or propagates them. Use try/catch at module boundaries. |
| **Logging** | Use `src/logger.js` (Winston) — never `console.log` in production code |
| **Config** | Single source of truth: CLI flags override `.env`, which overrides `config.js` defaults |
| **File naming** | `kebab-case` for files, `camelCase` for functions, `UPPER_SNAKE` for constants |
| **Comments** | Czech comments allowed (team is Czech). English for public API / JSDoc on exported functions. |

### 1.2 DOM / Selector Rules

- **Always try both languages:** Czech (`Pozvat`) AND English (`Invite`). The order in the array doesn't matter — any match wins.
- **Never use fragile selectors** like `.x78zum5.x1q0g3np` (Facebook's hashed class names change constantly). Prefer `[aria-label]`, `[role]`, and text content matching.
- **When Facebook changes UI and selectors fail:** Take a screenshot, dump candidate elements to JSON, log the error, and STOP. Do NOT fall back to blind guessing.

### 1.3 Rate Limit Rules (ABSOLUTE)

- **ALWAYS start with `paranoid` mode.** No exceptions.
- **After 1-2 weeks of no errors:** User manually switches to `moderate` in `.env`.
- **`aggressive` mode:** Only use if the account owner explicitly accepts the risk of suspension. It is NOT the default for any automated flow.
- **If ANY rate-limit text is detected on a page:** Enter cooldown immediately and stop the entire run. Do NOT skip the post and continue.
- **Session cap:** 30 minutes per run, hard stop. Remaining posts are picked up the next day.

### 1.4 Data Persistence Rules

- All persistence files live in `data/`.
- `data/` is `.gitignore`'d.
- JSON files, not SQLite — no extra dependencies.
- Never store real people's names permanently (privacy). Record counts, timestamps, post URLs, and statuses only.
- The lock file uses atomic exclusive write: `fs.writeFileSync(path, pid, { flag: 'wx' })`.

---

## 2. Architecture: Two-Phase Execution

This is the key insight that simplifies everything:

```
┌──────────────────────────────┐
│  PHASE 1: POST DISCOVERY     │
│  (scraper.js)                │
│                              │
│  1. Go to page feed          │
│  2. Click "Most Recent" tab  │
│  3. Scroll & extract:        │
│     - Post URL               │
│     - Post timestamp         │
│     - Status (pending/done)  │
│  4. Save to data/posts.json  │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  PHASE 2: INVITE FROM LIST   │
│  (inviter.js + reactions.js) │
│                              │
│  For each pending post:      │
│  1. Navigate to post URL     │
│  2. Open reactions popup     │
│  3. Scroll + click Invite    │
│  4. Mark post as done        │
│  5. Cooldown between posts   │
└──────────────────────────────┘
```

**Benefits:**
- If Phase 2 crashes, Phase 1 results are safe — resume from the list.
- Phase 1 runs fast (no clicking, just scrolling + extracting).
- Phase 1 can be run separately to refresh the post list without inviting.
- The post list is inspectable/debuggable.

### 2.1 Post List Format (`data/posts.json`)

```json
{
  "scrapedAt": 1749638400000,
  "pageUrl": "https://www.facebook.com/politician",
  "posts": [
    {
      "url": "https://www.facebook.com/politician/posts/123456",
      "id": "123456",
      "timestamp": 1749600000000,
      "date": "2026-06-10",
      "status": "pending",
      "invitedCount": 0,
      "processedAt": null,
      "error": null
    }
  ]
}
```

---

## 3. Testing Strategy: Mock Site

### 3.1 The Problem

There is no test Facebook Page with real reactions. The "Follow" button does NOT appear in profile-post reactions popups — it only appears on profile headers. So we cannot test the reactions-dialog flow on a personal profile.

### 3.2 The Solution: Local Mock HTML

We build a static HTML file at `test/mock-reactions-dialog.html` that mimics Facebook's reactions popup structure as closely as possible:

- A `<div role="dialog">` containing a scrollable list
- Each row has a person's name, profile picture placeholder, and an Invite/Pozvat button
- Enough rows (50-100) to test scroll behavior and lazy loading simulation
- The page includes minimal JS to simulate Facebook behavior:
  - Clicking "Invite" changes the button text to "Invited" / "Pozváno" and disables it
  - Scrolling to the bottom appends more rows (simulating infinite scroll)
  - A page-level "Open Reactions" button that shows the mock dialog

### 3.3 How to Build the Mock

1. Open a real Facebook page post with many reactions in a browser
2. Open DevTools → Elements panel
3. Click the reactions count to open the real popup
4. Right-click the dialog element → Copy → Copy outerHTML
5. Save as reference: `test/fb-dialog-reference.html`
6. Hand-craft `test/mock-reactions-dialog.html` based on the real structure, but simplified — remove hashed class names, add our own IDs, and add buttons with predictable aria-labels

### 3.4 Mock Testing Workflow

```
1. Write reactions.js (popup open + scroll + invite)
2. Point it at file://test/mock-reactions-dialog.html
3. Test: popup opens, scrolling works, buttons clicked, dedup works
4. Test: daily limit stops execution
5. Test: dummy "rate limit" text triggers cooldown
6. ONLY AFTER ALL MOCK TESTS PASS → test on real Facebook
```

---

## 4. Phased Implementation Plan

Each phase is ONE task for the LLM. Do not combine phases.

### Phase 0 — Cleanup & Foundation

**Files:** `src/config.js` (NEW), `.env.example` (edit), `RULES.md` (this file)

- Create `src/config.js` with defaults derived ONLY from `RATE_MODE`
- Remove duplicate `maxPostsPerRun` — it must come from the rate mode table
- The full rate mode table (daily max, per-post max, delays, cooldowns) lives in `config.js`
- CLI flags (`--rate-mode`) and `.env` (`RATE_MODE`) override the default
- Add `FB_PAGE_URL` and `FB_PAGE_ID` to `.env.example`

**Success criteria:** `node -e "const c = require('./src/config'); console.log(c);"` prints a valid config object with all values resolved from the rate mode.

---

### Phase 1 — Rate Limiter Module

**Files:** `src/rate-limiter.js` (NEW), `data/rate-limit-state.json`

**What it does:**
- `canInviteToday()` — checks daily budget vs. today's count, checks cooldown status
- `recordInvite(count)` — increments counter, writes to disk
- `detectRateLimit(page)` — scans page text for rate-limit keywords, triggers cooldown
- `enterCooldown(durationHours)` — sets `cooldownUntil`, logs prominently
- `getRemainingBudget()` — returns `dailyLimit - invitesToday`
- `resetDailyIfNeeded()` — if `date` in state file isn't today, reset counter

**Lock file:** Use `fs.writeFileSync(LOCK_PATH, pid, { flag: 'wx' })` for atomic acquire. Wrap in try/catch — if it throws EEXIST, another run is in progress.

**Success criteria:** Unit-testable — no Puppeteer needed. Test with `detectRateLimit` by passing a mock page object that returns known text.

---

### Phase 2 — Auth Module

**Files:** `src/auth.js` (NEW)

**What it does:**
- `ensureLoggedIn(page)` — navigates to `facebook.com`, checks URL is NOT `/login/`, checks for nav-bar DOM elements, returns `true/false`
- `navigateToPage(page, fbPageUrl)` — navigates to page URL, verifies page loaded (no "page not found" text, no redirect to login)
- `setupNavigationWatcher(page)` — listens for `framenavigated` events. If URL contains `/login/` or `login.php` at any point during the run, throws a `SessionExpiredError` and halts execution immediately. This covers mid-run expiry.

**Login indicators to check:**
- URL does NOT contain `/login/`, `login.php`, `/checkpoint/`
- A nav bar element exists (e.g., `[role="navigation"]`, `[aria-label="Home"]`, or the Facebook top bar)
- Page title is NOT "Log in to Facebook" or similar

**Success criteria:** Works with a valid profile directory. Detects expired session by checking for login redirect.

---

### Phase 3 — Post Scraper (Phase 1 of Two-Phase)

**Files:** `src/scraper.js` (NEW), `data/posts.json`

**What it does:**
- Navigate to the page's "Posts" section if not already there
- **Click "Most Recent" / "Nejnovější" filter** — this is critical for chronological ordering
- Scroll the feed to load posts
- For each post visible in the DOM:
  - Extract the permalink URL (look for `<a>` elements with `href` containing `/posts/` or `/videos/` or `/photos/`)
  - Extract the timestamp (`<abbr>` element, `data-utime` attribute, or aria-label with relative date)
  - Convert timestamp to ISO-like date string (`YYYY-MM-DD`)
  - Filter by `dateFrom`/`dateTo` config
- Stop scrolling when:
  - Post date is older than `dateFrom` (posts are now chronologically ordered thanks to "Most Recent")
  - `maxPostsPerRun` limit reached
  - Scroll height stops growing (no more posts loading)
- Save results to `data/posts.json`, merging with existing entries (don't overwrite already-processed posts)

**Selector guidance:** Facebook post permalinks are typically `<a>` tags nested inside the post container. Look for:
- `a[href*="/posts/"]` — standard post links
- `a[href*="/videos/"]` — video posts
- `a[href*="/photos/"]` — photo posts
- Timestamps: `abbr[data-utime]`, `span[aria-label*="202"]` (contains year)
- Post containers: `div[role="article"]` or elements containing the above

**Fallback if "Most Recent" isn't available:** Log a warning, proceed with whatever ordering the feed gives. Date filtering still applies, but the "stop when older than dateFrom" optimization won't work — instead, process all visible posts up to maxPostsPerRun and rely on `processed-posts.json` dedup.

**Success criteria:** Run with `--dry-run`, produces a valid `data/posts.json` with correct URLs, dates, and statuses. No invitations sent.

---

### Phase 4 — Mock Site

**Files:** `test/mock-reactions-dialog.html` (NEW)

Build the HTML mock as described in Section 3. The mock must include:
- A button labeled "Open Reactions" that shows a `<div role="dialog">`
- Inside the dialog: a scrollable `<div>` (overflow-y: auto) with 50+ rows
- Each row has: avatar placeholder, person name, and an Invite/Pozvat button
- Clicking Invite changes the button to "Invited" / "Pozváno" and disables it
- Scrolling to 80% triggers appending 20 more rows (simulate infinite scroll)
- After 200 total rows, stop appending (simulate end of list)
- A "SIMULATE RATE LIMIT" button that inserts a rate-limit warning message on the page

**Success criteria:** Open in a browser, verify manually: dialog opens, scrolling works, invite buttons work, rate limit simulation works.

---

### Phase 5 — Reactions Module (Popup + Scroll + Invite)

**Files:** `src/reactions.js` (NEW)

**This is the hardest module.** Build it against `test/mock-reactions-dialog.html` first.

**Functions:**
- `openReactionsDialog(page)` — click reactions count, wait for `[role="dialog"]`
- `findScrollableContainer(page)` — find the scrollable element inside the dialog
- `scrollAndInvite(page, container, maxInvites, baseDelay)` — the main loop

**The main loop algorithm:**
```
seenNodes = new WeakSet()
scrollsWithNoNewButtons = 0

while (invitedThisPost < maxPerPost && scrollsWithNoNewButtons < 5):
  // 1. Scan for visible invite buttons within the dialog
  buttons = findInviteButtonsInDialog(dialog, INVITE_SELECTORS)
  newButtons = buttons.filter(b => !seenNodes.has(b) && b not disabled)

  // 2. Click each new button
  for each button in newButtons:
    button.scrollIntoView()
    randomDelay(baseDelay, jitter)
    button.click()
    seenNodes.add(button)
    invitedThisPost++
    if invitedThisPost >= maxPerPost: break

  // 3. Check daily limit
  if rateLimiter.getRemainingBudget() <= 0: throw DailyLimitReached

  // 4. Scroll to load more
  oldScrollHeight = container.scrollHeight
  container.scrollTop = container.scrollHeight
  await delay(scrollDelay)

  // 5. Detect if new content loaded
  if container.scrollHeight == oldScrollHeight && newButtons.length == 0:
    scrollsWithNoNewButtons++
  else:
    scrollsWithNoNewButtons = 0
```

**Why WeakSet + scrollHeight together:**
- `WeakSet` prevents re-clicking the same DOM node during scroll cycles (even if `data-invited` attribute is lost due to DOM replacement)
- `scrollHeight` comparison detects when Facebook stops loading more entries
- `scrollsWithNoNewButtons` counter is a safety net — if both checks fail, the loop still terminates after 5 empty scrolls

**Invite button detection in dialog:**
```javascript
const INVITE_SELECTORS = [
  'div[aria-label="Pozvat"][role="button"]',
  'button[aria-label="Pozvat"]',
  'a[role="button"][aria-label*="Pozvat"]',
  'div[aria-label="Invite"][role="button"]',
  'button[aria-label="Invite"]',
  'a[role="button"][aria-label*="Invite"]',
];
```

Also filter out buttons whose text/aria-label contains:
- `"Pozváno"` / `"Invited"` — already invited
- `"Odvolat"` / `"Cancel"` — cancel invitation (already sent)

**Success criteria:** Running against the mock site: dialog opens, all invite buttons are clicked, scrolling works, loop terminates correctly, rate limit detection from mock page works.

---

### Phase 6 — Inviter Orchestrator (Refactor)

**Files:** `src/inviter.js` (REFACTOR)

Rewrite `src/inviter.js` to orchestrate the new modules:

```
runWithBrowser({ pageUrl, profileDir, headless, waitForLogin, dateFrom, dateTo, dryRun, rateMode })
  → if waitForLogin: launch browser, wait for manual login, save session, return
  → browser = launch(profileDir, headless)
  → page = browser.newPage()
  → setupNavigationWatcher(page)          // mid-run session expiry detection
  → auth.ensureLoggedIn(page)
  → auth.navigateToPage(page, pageUrl)
  → posts = scraper.discoverPosts(page, pageUrl, dateFrom, dateTo)
  → for each post in posts (where status == "pending"):
      page.goto(post.url)
      rateLimiter.resetDailyIfNeeded()
      detectRateLimit(page)               // throws if rate-limited
      reactions.openReactionsDialog(page)
      container = reactions.findScrollableContainer(page)
      count = reactions.scrollAndInvite(page, container, rateMode.maxPerPost, rateMode.baseDelay)
      storage.markPostProcessed(post.url, count)
      rateLimiter.recordInvite(count)
      cooldown(rateMode.postCooldown)
      if rateLimiter.getRemainingBudget() <= 0: break
  → close browser
```

The refactored `inviter.js` should NOT contain DOM logic — that's all in `scraper.js`, `reactions.js`, and `auth.js`.

**Success criteria:** Dry-run produces a full log showing: posts discovered, dialogs detected, buttons found (not clicked in dry-run), rate limits respected.

---

### Phase 7 — CLI Update

**Files:** `src/index.js` (EDIT)

New/updated flags:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--page` | string | — | Page URL (replaces `--url` for page mode) |
| `--url` | string | — | Single post URL (direct mode, bypasses scraper) |
| `--dry-run` | boolean | false | Log only, no clicks |
| `--date-from` | string | `all` | `YYYY-MM-DD` |
| `--date-to` | string | `all` | `YYYY-MM-DD` |
| `--rate-mode` | string | `paranoid` | `paranoid` / `moderate` / `aggressive` |
| `--profile-dir` | string | `./profile` | Chrome profile path |
| `--headless` | boolean | true | Headless mode |
| `--wait-for-login` | boolean | false | Manual login mode |

**Conflict rule:** `--url` and `--page` are mutually exclusive. `--page` triggers the full two-phase workflow. `--url` goes directly to one post (bypass scraper) — useful for testing.

**Success criteria:** Each flag works individually. `--help` shows all options. Invalid combinations error out with a clear message.

---

### Phase 8 — Storage Enhancement

**Files:** `src/storage.js` (EDIT)

Add functions for the two-phase system:

| Function | Purpose |
|----------|---------|
| `loadPostList()` | Read `data/posts.json` |
| `savePostList(posts)` | Write `data/posts.json`, merge by URL |
| `markPostProcessed(postUrl, invitedCount)` | Update status to "done" |
| `isPostProcessed(postUrl)` | Check status === "done" |
| `saveInviteEvent(postUrl, count, stoppedReason)` | Append to `data/invitations.json` |
| `getInviteHistory()` | Read all invite events |

Remove the `peopleNames` field from the schema — store counts and timestamps only.

**Success criteria:** Load/save round-trips. Post dedup works. Existing `data/invitations.json` is backwards-compatible (just new fields are optional).

---

### Phase 9 — Logging & Log Rotation

**Files:** `src/logger.js` (EDIT)

Add file transport:
- Log to `logs/run-YYYY-MM-DD.log` AND console
- Log rotation: keep last 30 log files, delete older ones on startup (simple `fs.readdir` + filter by date in filename + `fs.unlink`)

**Log format:** Include timestamp, level, module name, and message.

**Success criteria:** Run produces a dated log file. Running 31 days in a row keeps only 30 files.

---

### Phase 10 — Cron & Deployment Finalization

**Files:** `crontab` reference in `PLAN.md`, `data/.gitignore` (ensure)

- Verify lock file prevents concurrent runs
- Verify session cap (30 min) works
- Write the exact crontab line
- Document session renewal process (every 2-4 weeks)
- Add `data/` to `.gitignore` if not already present
- Clean up old debug files from `data/`

**Success criteria:** Two concurrent cron runs — second one exits immediately with "Lock file exists."

---

## 5. Error Classification

| Error Type | Action |
|------------|--------|
| `SessionExpiredError` | Log, exit. User must run `--wait-for-login` on local machine. |
| `DailyLimitReached` | Log, save state, exit cleanly. Resume next day. |
| `RateLimitDetectedError` | Enter cooldown (duration from rate mode). Log prominently. Exit. |
| `DialogNotFoundError` | Screenshot, log HTML snippet, skip post, continue. |
| `ElementNotFoundError` | Screenshot, log, skip post, continue. |
| `NetworkError` | Retry 3x with exponential backoff (5s, 10s, 20s). Then skip post. |
| `BrowserCrashError` | Restart browser, resume from last unprocessed post in `posts.json`. |

---

## 6. Files Summary — Before & After

| File | Status | Purpose |
|------|--------|---------|
| `src/config.js` | **NEW** | Central config, rate mode table, env fallbacks |
| `src/rate-limiter.js` | **NEW** | Daily budget, cooldowns, lock file, rate-limit detection |
| `src/auth.js` | **NEW** | Login verification, page navigation, mid-run session watcher |
| `src/scraper.js` | **NEW** | Phase 1: post discovery from page feed → `data/posts.json` |
| `src/reactions.js` | **NEW** | Phase 2: reactions popup, scroll loop, invite clicking |
| `src/inviter.js` | **REFACTOR** | Orchestrator — wires all modules together |
| `src/index.js` | **EDIT** | CLI with new flags (`--page`, `--dry-run`, `--date-from`, `--rate-mode`) |
| `src/storage.js` | **EDIT** | Add post list persistence, remove `peopleNames` |
| `src/logger.js` | **EDIT** | Add file transport + 30-day log rotation |
| `src/session.js` | **NO CHANGE** | Already works fine |
| `test/mock-reactions-dialog.html` | **NEW** | Mock Facebook reactions popup for testing |
| `test/fb-dialog-reference.html` | **NEW** | Real Facebook dialog HTML for reference (saved manually) |
| `data/posts.json` | **NEW** | Post list from Phase 1 |
| `data/rate-limit-state.json` | **NEW** | Throttling state |
| `data/invitations.json` | **EXISTING** | Invite history (new fields added) |
| `data/processed-posts.json` | **DEPRECATED** | Replaced by `posts.json` status field. Keep for backwards compat. |

---

## 7. Quick-Start (After Implementation)

```bash
# Step 1: First-time login (local machine with display)
node src/index.js --wait-for-login --profile-dir ./profile

# Step 2: Copy profile to server
scp -r ./profile/ user@server:/home/user/inviter/headless/profile/

# Step 3: Phase 1 — discover posts (dry-run, no invites)
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile --dry-run --date-from 2023-01-01

# Step 4: Check the post list
cat data/posts.json | head -50

# Step 5: Phase 1+2 — full run
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile --date-from 2023-01-01 --rate-mode paranoid

# Step 6: Single post test (bypass scraper)
node src/index.js --url "https://www.facebook.com/politician/posts/123" \
  --profile-dir ./profile --dry-run

# Step 7: Mock test during development
node src/index.js --url "file://$(pwd)/test/mock-reactions-dialog.html" --dry-run
```
