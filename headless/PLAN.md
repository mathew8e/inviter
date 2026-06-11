# PLAN.md — Inviter Headless

> **Last updated:** 2026-06-11
> **Target environment:** HP Ubuntu Server (Ubuntu 20.x, 4–8 GB RAM, home network attic)
> **Purpose:** Automatically invite everyone who reacts to a politician's Facebook posts to follow the page
> **Auth method:** Facebook Business Suite (delegated page access)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Infrastructure](#2-infrastructure)
3. [Authentication & Delegated Page Access](#3-authentication--delegated-page-access)
4. [Core Workflow](#4-core-workflow)
5. [Module-by-Module Plan](#5-module-by-module-plan)
6. [Rate Limiting — Three Modes](#6-rate-limiting--three-modes)
7. [Post Date Range Strategy](#7-post-date-range-strategy)
8. [Scheduled Execution (Cron)](#8-scheduled-execution-cron)
9. [Data Persistence](#9-data-persistence)
10. [Error Handling](#10-error-handling)
11. [Testing Strategy](#11-testing-strategy)
12. [Deployment Steps](#12-deployment-steps)
13. [Future Ideas](#13-future-ideas)

---

## 1. Project Overview

### 1.1 What This Tool Does

A Puppeteer-based Node.js script that runs on a headless Ubuntu server and:

1. **Logs into** the developer's personal Facebook account (via saved Chrome session)
2. **Switches to** a politician's Facebook Page (delegated via Business Suite)
3. **Scrapes the page's posts** within a configured date range
4. **For each post**, opens the reactions popup → scrolls through all people who reacted → clicks "Invite" (`Pozvat`) on each person who is **not yet following** the page
5. **Runs daily via cron**, obeying strict rate limits to avoid account suspension

### 1.2 What "Invite" Means

Inside the reactions popup on a **Page post**, every person who reacted (Like, Love, Care, HaHa, Wow, Sad, Angry) and **is not yet following** the page has an **"Invite" button** next to their name. Clicking it sends them an invitation to **follow the page**.

This is how the politician grows their audience organically — people who already react are warm leads.

### 1.3 Current State of the Code

The `headless/` folder already has:

| File | Status |
|------|--------|
| `src/index.js` | CLI with `--url`, `--max`, `--delay`, `--profile-dir`, `--headless`, `--wait-for-login` |
| `src/inviter.js` | Basic Puppeteer automation: navigate → scan buttons → click |
| `src/session.js` | Chrome launch config, Linux Chrome discovery |
| `src/storage.js` | JSON persistence for invite history |
| `src/logger.js` | Winston console logger |
| `Dockerfile` | Node 20 + Chromium deps |
| `docker-compose.yml` | Volume mounts for data/profile |

**What's missing:** Reactions popup opening, dialog scroll loop, post discovery from page feed, delegated page navigation, rate limiting, cron scheduling, date range filtering, configurable rate limit modes.

---

## 2. Infrastructure

| Property | Value |
|----------|-------|
| **Physical machine** | Old HP server in the attic |
| **OS** | Ubuntu 20.x (older LTS) |
| **RAM** | 4–8 GB |
| **Network** | Home network (SSH from local network, no external encryption concerns) |
| **Access** | SSH + FTP |
| **Display** | **None** — fully headless. Login setup must be done on a machine WITH a display (local PC), then `./profile/` copied to server |
| **Runtime** | Node.js 20.x (may need to install from NodeSource on Ubuntu 20) |
| **Browser** | Chromium bundled via Puppeteer |
| **Scheduling** | System cron (`crontab`) |

### 2.1 Docker or Bare Metal?

**Recommendation:** Run bare metal (Node directly) for simplicity. The server has limited RAM (4–8 GB), and Docker adds overhead. Use the Dockerfile mainly as documentation for dependencies.

```bash
# Install Chromium deps directly on Ubuntu 20
sudo apt-get update
sudo apt-get install -y ca-certificates fonts-liberation libnss3 libnspr4 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2
```

### 2.2 Directory Structure

```
headless/
├── data/                     # Runtime data (gitignored)
│   ├── invitations.json      # Log of all invites sent
│   ├── processed-posts.json  # Track which posts are done
│   └── rate-limit-state.json # Throttling state
├── profile/                  # Chrome session (copy from local machine)
│   └── Default/
├── src/
│   ├── index.js              # CLI entry (needs --page, --dry-run, --date-from flags)
│   ├── inviter.js            # Core automation (needs major refactor)
│   ├── session.js            # Chrome launch config (exists, good)
│   ├── logger.js             # Logging (exists)
│   ├── storage.js            # JSON persistence (needs enhancement)
│   ├── config.js             # NEW — central config + 3 rate limit modes
│   ├── auth.js               # NEW — login verify + page navigation
│   ├── scraper.js            # NEW — discover posts from page feed
│   ├── reactions.js          # NEW — open popup, scroll loop, click invites
│   └── rate-limiter.js       # NEW — daily budget, cooldowns, error detection
├── logs/                     # Log output files
├── .env                      # Config variables
├── PLAN.md                   # This file
├── CONTEXT.md                # Existing git history docs
└── README.md                 # Usage instructions
```

---

## 3. Authentication & Delegated Page Access

### 3.1 How It Works

The developer has a **personal Facebook account** that has been granted page access to the politician's page via **Facebook Business Suite**. The exact role level (Admin/Editor/Moderator) isn't confirmed, but the account can:
- See all the politician's posts
- Click on reactions counts
- Click "Invite" (`Pozvat`) buttons

### 3.2 Login Flow

**Step 1 — Initial setup** (on a machine with a display, e.g., local PC):
```bash
node src/index.js --wait-for-login --profile-dir ./profile
```
- Browser opens visibly
- User logs into their personal Facebook account
- User navigates to the politician's page and switches to page context
- User presses Enter in terminal
- Session (cookies, auth tokens, page context) is saved to `./profile/`

**Step 2 — Copy to server:**
```bash
scp -r ./profile/ user@server:/home/user/inviter/headless/profile/
```

**Step 3 — Automation runs** (server, headless):
- Puppeteer launches Chrome with `--user-data-dir=./profile`
- Facebook sees the existing session and treats it as "already logged in"

### 3.3 What `src/auth.js` Does

- On every run: check if the session is still valid
- Navigate to `facebook.com` first to restore session from cookies
- Check for logged-in indicators (nav bar, no redirect to login page)
- Navigate to the politician's page URL
- Verify page context is active
- If session expired: log a clear error, exit. User must re-run `--wait-for-login`

### 3.4 Session Expiry

Facebook sessions last ~2–4 weeks. The script detects this by:
- URL redirect to `/login/` or `login.php`
- Missing logged-in DOM elements
- **Never attempts to re-login programmatically** — logs error and stops

---

## 4. Core Workflow

### 4.1 Algorithm

```
1. Launch browser with saved profile
2. Verify login & navigate to politician's page
3. Read config: date range, rate limit mode, max posts
4. Scrape page feed → list of post URLs within date range
5. Filter out already-processed posts
6. FOR EACH post (newest first):
   a. Navigate to post URL
   b. Click on reactions count to open popup
   c. Wait for [role="dialog"] to render
   d. Find the scrollable container inside dialog
   e. LOOP:
      i.   Find all visible "Invite"/"Pozvat" buttons
      ii.  Click each with randomized delay (3–5s)
      iii. Mark with data-invited="true"
      iv.  Track count for this post + this day
      v.   If daily limit reached → STOP RUN
      vi.  If post limit reached → move to next post
      vii. Scroll dialog to load more people
      viii.If no new people after X scrolls → exit loop
   f. Mark post as processed
   g. Cooldown 10-30s before next post
7. Save all state, close browser
```

### 4.2 Invite Button Behavior

- Found in reactions dialog next to each person who **isn't following** the page
- Label: `"Pozvat"` (Czech) or `"Invite"` (English)
- CSS selectors target: `div[aria-label="Pozvat"][role="button"]`, etc.
- All reaction types are treated equally (Like, Love, Care, HaHa, Wow, Sad, Angry)

### 4.3 Language Handling

Primary: **Czech** (`"Pozvat"`)
Fallback: **English** (`"Invite"`) — can be switched if Facebook UI language changes

Selectors array:
```javascript
const INVITE_SELECTORS = [
    // Czech (primary)
    'div[aria-label="Pozvat"][role="button"]',
    'button[aria-label="Pozvat"]',
    'a[role="button"][aria-label*="Pozvat"]',
    // English (fallback)
    'div[aria-label="Invite"][role="button"]',
    'button[aria-label="Invite"]',
    'a[role="button"][aria-label*="Invite"]',
];
```

---

## 5. Module-by-Module Plan

### 5.1 `src/config.js` (NEW) ✅ DONE

Central configuration with **3 rate limit modes** (see Section 6):

```javascript
module.exports = {
    // Facebook — set in .env
    fbPageUrl: process.env.FB_PAGE_URL,     // Full page URL
    fbPageId: process.env.FB_PAGE_ID,       // Numeric ID or username

    // Rate limit mode — 'paranoid' | 'moderate' | 'aggressive'
    rateMode: process.env.RATE_MODE || 'paranoid',

    // Date range for posts (ISO date strings or 'all')
    dateFrom: process.env.DATE_FROM || 'all',
    dateTo: process.env.DATE_TO || 'all',

    // Max posts to process per run
    maxPostsPerRun: parseInt(process.env.MAX_POSTS_PER_RUN || '10', 10),

    // Paths
    profileDir: process.env.PROFILE_DIR || './profile',
    dbPath: process.env.DB_PATH || './data/invitations.json',
    processedPostsPath: process.env.PROCESSED_POSTS_PATH || './data/processed-posts.json',
    rateLimitPath: process.env.RATE_LIMIT_PATH || './data/rate-limit-state.json',
};
```

### 5.2 `src/auth.js` (NEW) ✅ DONE

```
ensureLoggedIn(browser, profileDir)  → page
  - Launch browser with profile
  - Go to facebook.com
  - Check URL isn't /login/
  - Check DOM for nav bar (logged-in indicator)
  - If expired → log error, return null

navigateToPage(page, pageUrl)  → boolean
  - Go to page URL
  - Verify page loaded (not "page not found")
  - Return true/false
```

### 5.3 `src/scraper.js` (NEW) ✅ DONE

```
discoverPosts(page, pageUrl, dateFrom, dateTo, maxPosts)  → Post[]
  - Go to page feed
  - Try clicking "Posts" tab
  - Scroll to load posts
  - Extract post URLs + timestamps
  - Filter by date range
  - Limit to maxPosts
  - Return array of { url, id, timestamp }
```

Posts are discovered from the page timeline. Each post has a URL like `https://www.facebook.com/pageName/posts/123456`.

Date filtering: compare post timestamp against `dateFrom`/`dateTo`. If `dateFrom === 'all'`, process everything available (up to maxPosts). For the **first run**, the user would set `dateFrom` far back (e.g., 3 years). For periodic runs, `dateFrom` would be the last run date.

### 5.4 `src/reactions.js` (NEW)

**The most complex module.** Opens reactions popup and implements the scroll-and-invite loop.

```
openReactionsDialog(page)  → boolean
  - Find reactions count element (e.g., "47" with aria-label)
  - Click it
  - Wait for [role="dialog"] to appear (2-3s)
  - Return true if dialog opened

findScrollableContainer(page)  → ElementHandle | null
  - Inside dialog, find elements with overflow-y: scroll/auto
  - Prefer one that contains invite buttons
  - Return container or null

scrollAndInvite(page, container, maxInvites, baseDelay)  → number
  - LOOP:
    - Scan for invite buttons (INVITE_SELECTORS)
    - Filter by data-invited != "true"
    - If found: click each with randomized delay
    - Scroll container to bottom
    - If scroll height stopped growing + no new buttons → break
    - If maxInvites reached → break
  - Return count of invites sent
```

### 5.5 `src/rate-limiter.js` (NEW) ✅ DONE

```
canInviteToday()  → { allowed, remaining, reason }
  - Read rate-limit-state.json
  - Check if today's count < daily limit
  - Check if in cooldown
  - Return decision

recordInvite(count)  → void
  - Increment today's counter
  - Update lastInviteTimestamp
  - Persist to disk

detectRateLimit(page)  → boolean
  - Check page text for rate limit messages
  - If detected: trigger cooldown (24h)
  - Return true/false

enterCooldown(duration)  → void
  - Set cooldownUntil timestamp
  - Log prominently

getRemainingBudget()  → number
  - Return dailyLimit - invitesToday
```

### 5.6 `src/storage.js` (ENHANCE)

Add functions for post tracking:

```
markPostProcessed(postUrl, invitedCount)  → void
isPostProcessed(postUrl)  → boolean
getProcessedPosts()  → string[]
```

The invite history entry:
```json
{
    "id": 1,
    "ts": 1749638400000,
    "date": "2026-06-11",
    "postUrl": "...",
    "invitedCount": 47,
    "peopleNames": ["John Doe", "Jane Smith"],
    "stoppedReason": "daily_limit | post_limit | no_more_users | error",
    "rateMode": "paranoid"
}
```

The `peopleNames` array is optional — just for the user to see it's working. Not used for deduplication.

### 5.7 `src/index.js` (ENHANCE)

New CLI flags:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--page` | string | — | Page URL to scan (instead of `--url`) |
| `--dry-run` | boolean | false | Log only, no clicks |
| `--date-from` | string | `all` | Process posts from this date (ISO: `2023-01-01`) |
| `--date-to` | string | `all` | Process posts until this date |
| `--rate-mode` | string | `paranoid` | `paranoid` \| `moderate` \| `aggressive` |

Usage:
```bash
# First run: process 3 years of posts
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile --date-from 2023-01-01

# Periodic run: process last 30 days
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile --date-from 2026-05-11

# Dry run (safe check)
node src/index.js --page "..." --profile-dir ./profile --dry-run
```

### 5.8 `src/inviter.js` (REFACTOR)

Will be refactored to orchestrate the new modules instead of doing everything inline:

```
runWithBrowser({ page, profileDir, headless, waitForLogin, dateFrom, dateTo, dryRun, rateMode })
  → launch browser
  → if waitForLogin: run auth flow, return
  → auth.ensureLoggedIn()
  → auth.navigateToPage(pageUrl)
  → posts = scraper.discoverPosts(dateFrom, dateTo, maxPostsPerRun)
  → for each post:
      page.goto(post.url)
      reactions.openReactionsDialog()
      container = reactions.findScrollableContainer()
      count = reactions.scrollAndInvite(container, maxPerPost, delay)
      storage.markPostProcessed(post.url, count)
  → close browser
```

---

## 6. Rate Limiting — Three Modes

The user isn't sure what limit Facebook enforces, so the tool provides **three presets**. Start with `paranoid`, check logs for a week, then cautiously move up.

| Setting | 🔒 Paranoid (default) | ⚖️ Moderate | ⚡ Aggressive |
|---------|----------------------|-------------|---------------|
| **Daily max** | 100 | 250 | 500 |
| **Per post max** | 30 | 75 | 150 |
| **Base delay** | 5,000 ms | 3,000 ms | 1,500 ms |
| **Random extra** | 0–5,000 ms | 0–3,000 ms | 0–1,500 ms |
| **Scroll delay** | 3,000 ms | 2,000 ms | 1,000 ms |
| **Post cooldown** | 30 s | 15 s | 5 s |
| **Cooldown on error** | 48 h | 24 h | 12 h |
| **Max posts/run** | 5 | 10 | 20 |
| **Run time cap** | 20 min | 30 min | 45 min |

**Recommendation:** Use `paranoid` for at least 1–2 weeks. If no rate limit errors appear, switch to `moderate`. Never use `aggressive` unless you're willing to risk the account.

Set via:
```bash
# .env
RATE_MODE=paranoid

# or CLI
--rate-mode moderate
```

### 6.1 Rate Limit Detection

The script watches for Facebook's rate limit signals on every page load:
- "You are doing that too much. Please try again later."
- "Rate limit exceeded"
- "Blocked temporarily"
- "This action is temporarily blocked"

If detected: enter cooldown (duration depends on mode), log prominently, exit.

### 6.2 Anti-Detection

- `--disable-blink-features=AutomationControlled` (already set)
- Override `navigator.webdriver` to `false`
- Random jitter on ALL timings (not just click delay — scroll speed, dialog open wait, everything)
- No concurrent runs (lock file)
- Session age capped at 30 minutes — if more posts remain, they're picked up in the next day's run

---

## 7. Post Date Range Strategy

### 7.1 First Run (Initial Catch-Up)

The first run processes posts going back **further in time** — maybe up to 3–4 years depending on how long the page has been active.

Set via:
```bash
--date-from 2023-01-01
```

The script will:
- Scrape all posts from the page feed dating back to 2023-01-01
- Process them newest-first
- Stop when daily limit is reached
- Continue the next day from where it left off (using `processed-posts.json`)

Since the daily limit is small (100 in paranoid mode), the first run will take several days/weeks to catch up on 3+ years of posts. That's fine — it's intentional.

### 7.2 Periodic Runs (Maintenance Mode)

Once the backlog is cleared, runs process **only new posts** since the last run:

```bash
--date-from 2026-06-01   # Or whatever the last run date was
```

This can be automated in cron by passing the last run's date as `--date-from`.

### 7.3 Implementation

In `scraper.js`:
- Extract post timestamp from the DOM (Facebook often has `abbr` timestamps or `data-utime` attributes)
- Compare against `dateFrom` and `dateTo`
- If post is older than `dateFrom`, stop scraping (older posts won't appear further down — can rely on chronological ordering)
- Filter against `processed-posts.json` to skip already-done posts

---

## 8. Scheduled Execution (Cron)

### 8.1 Crontab Entry

```bash
# Edit with: crontab -e
# Run daily at 9:00 AM
0 9 * * * cd /home/user/inviter/headless && node src/index.js --page "https://www.facebook.com/politician" --profile-dir ./profile --date-from 2026-06-01 >> logs/run-$(date +\%Y-\%m-\%d).log 2>&1
```

### 8.2 Lock File

Prevent concurrent runs (in case one run takes longer than 24h):

```javascript
const LOCK_FILE = './data/inviter.lock';

function acquireLock() {
    if (fs.existsSync(LOCK_FILE)) throw new Error('Lock file exists — another run in progress');
    fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
}
```

### 8.3 Logs

Logs go to `logs/run-YYYY-MM-DD.log`. Each log entry includes:
- Date, time, rate mode
- Posts discovered + processed
- Invites sent per post
- Daily total
- Errors encountered
- Stopped reason

---

## 9. Data Persistence

| File | What it stores |
|------|---------------|
| `data/invitations.json` | Array of invite events: `[{ id, ts, date, postUrl, invitedCount, peopleNames[], stoppedReason, rateMode }]` |
| `data/processed-posts.json` | Object: `{ "postUrl": { processedAt, invitedCount, status } }` |
| `data/rate-limit-state.json` | `{ date, invitesToday, dailyLimit, lastInviteTimestamp, isCooldown, cooldownUntil, consecutiveErrors }` |
| `profile/Default/` | Chrome's full session data (cookies, localStorage, etc.) |

### 9.1 Deduplication

Within a single run: `data-invited="true"` attribute on the DOM element prevents re-clicking during scroll loops.

Across runs: `processed-posts.json` prevents re-processing an entire post. Individual user re-invites across different posts are acceptable (low probability, Facebook allows occasional re-invites).

---

## 10. Error Handling

| Scenario | Response |
|----------|---------|
| **Session expired** | Log error, exit. User re-runs `--wait-for-login` on local machine, copies profile to server. |
| **Facebook UI changed** | Log full debug + screenshot. Exit — needs code update. |
| **Network timeout** | Retry 3x with exponential backoff (5s, 10s, 20s). Then skip post. |
| **Rate limited** | Enter cooldown (duration depends on mode). Log prominently. Exit. |
| **Element not found** (no reactions, no dialog) | Screenshot, log, skip to next post. |
| **Browser crash** | Restart browser, resume from last processed post. |
| **Date range has no posts** | Log "No new posts found in range", exit cleanly. |

All errors are logged to file. For v1, the user checks logs manually via SSH.

---

## 11. Testing Strategy

### 11.1 No Test Page Available

There is no dedicated test page with enough invites to test with. **Alternative testing approach:**

Use the developer's **own Facebook profile** with a popular post that has many reactions. The reactions dialog works identically — the only difference is the button label changes from "Invite" (`Pozvat`) to "Follow" (`Sledovat`).

So during development, test with:
```javascript
const TEST_SELECTORS = [
    'div[aria-label="Sledovat"][role="button"]',  // Czech "Follow"
    'div[aria-label="Follow"][role="button"]',     // English "Follow"
    'button[aria-label="Sledovat"]',
    'button[aria-label="Follow"]',
];
```

This way the dev can safely test:
- Reactions popup opens correctly
- Scroll loop works and terminates
- DOM tracking (`data-invited`) prevents double-clicks
- Daily limits stop execution
- Error handling catches missing elements

Before running on the politician's page, just swap the selectors back to `"Pozvat"` / `"Invite"`.

### 11.2 Test Modes

| Mode | Command | What it tests |
|------|---------|---------------|
| Dry run | `--dry-run` | Scans + logs, never clicks. Safe on any page. |
| Follow test | (swap selectors) | Reactions popup + scroll loop on own profile |
| Single post | `--url` | One specific post |
| Page mode | `--page` | Full workflow from scraping to inviting |
| Low limit | `--rate-mode paranoid --date-from 2026-06-01` | Rate limiting with tiny budget |

### 11.3 Test Checklist

- [ ] `--wait-for-login` saves a working session
- [ ] Session works when loaded headlessly
- [ ] `--dry-run` logs buttons found without clicking
- [ ] Reactions popup opens on test post
- [ ] Scroll loop finds users and terminates (doesn't infinite scroll)
- [ ] Follow/Invite buttons are clickable
- [ ] `data-invited` prevents duplicate clicks
- [ ] Daily limit stops the run
- [ ] Rate limit error enters cooldown
- [ ] Lock file prevents concurrent runs
- [ ] Log contains useful info (counts, errors, timing)

---

## 12. Deployment Steps

### 12.1 On Local Machine (with display)

```bash
# 1. Clone repo, install deps
git clone https://github.com/mathew8e/inviter.git
cd inviter/headless
npm ci

# 2. First-time login
node src/index.js --wait-for-login --profile-dir ./profile

# 3. Log into Facebook manually in the browser
# 4. Navigate to politician's page, verify you can see posts
# 5. Press Enter in terminal
# 6. Result: ./profile/ has a saved Chrome session

# 7. Copy profile to server
scp -r ./profile/ user@server:/home/user/inviter/headless/profile/
```

### 12.2 On the Server (Ubuntu 20.x)

```bash
# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install Chromium deps
sudo apt-get update
sudo apt-get install -y ca-certificates fonts-liberation libnss3 libnspr4 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2

# 3. Get the code on the server
git clone https://github.com/mathew8e/inviter.git
cd inviter/headless
npm ci

# 4. Create data + logs dirs
mkdir -p data logs

# 5. Copy profile (from step 12.1)
# Profile should already be at ./profile/

# 6. Configure .env
cp .env.example .env
nano .env
# Set: FB_PAGE_URL=https://www.facebook.com/politician
# Set: RATE_MODE=paranoid

# 7. Test dry run
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile --dry-run \
  --date-from 2026-01-01

# 8. First real run (manual)
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile \
  --date-from 2023-01-01 \
  >> logs/first-run.log 2>&1

# 9. Set up daily cron
crontab -e
# Add line:
0 9 * * * cd /home/user/inviter/headless && node src/index.js --page "https://www.facebook.com/politician" --profile-dir ./profile --date-from 2026-06-01 >> logs/run-\$(date +\%Y-\%m-\%d).log 2>&1
```

### 12.3 Session Renewal (Every ~2-4 Weeks)

```bash
# On local machine:
node src/index.js --wait-for-login --profile-dir ./profile
# Log in again, press Enter

# Copy to server:
scp -r ./profile/ user@server:/home/user/inviter/headless/profile/
```

---

## 13. Future Ideas

| Feature | When |
|---------|------|
| **Email notification** on errors or session expiry | v2 (after basic flow works) |
| **Web dashboard** with stats and logs | v3 (if needed) |
| **"Follow" support** for other social features | Low priority |
| **Multiple page support** (more politicians) | If needed |
| **Auto-update date-from** to last run date | Before v2 (simple fix) |

---

## Appendix: Quick Reference

```bash
# ─── FIRST-TIME SETUP (local machine) ───────────────
node src/index.js --wait-for-login --profile-dir ./profile

# ─── TEST (swap selectors to "Sledovat"/"Follow") ───
node src/index.js --url "https://www.facebook.com/your-post" --profile-dir ./profile

# ─── FIRST RUN ON SERVER (deep catch-up) ────────────
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile \
  --date-from 2023-01-01 \
  --rate-mode paranoid

# ─── PERIODIC RUN (daily cron) ─────────────────────
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile \
  --date-from 2026-06-01

# ─── DRY RUN (safe, no clicks) ─────────────────────
node src/index.js --page "https://www.facebook.com/politician" \
  --profile-dir ./profile --dry-run

# ─── CHANGE RATE MODE ──────────────────────────────
node src/index.js --page "..." --profile-dir ./profile --rate-mode moderate
```