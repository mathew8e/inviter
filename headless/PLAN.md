# PLAN.md — Inviter Headless

> **Last updated:** 2026-07-04 (Cron scheduling live on the Pi — project complete, in maintenance mode)
> **Target environment:** Raspberry Pi (Debian 12 "bookworm", ARM), reachable at `192.168.1.32`
> **Purpose:** Automatically invite everyone who reacts to a politician's Facebook posts to follow the page
> **Auth method:** Facebook Business Suite (delegated page access), via a saved Chrome profile

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Infrastructure](#2-infrastructure)
3. [Authentication & Delegated Page Access](#3-authentication--delegated-page-access)
4. [Core Workflow](#4-core-workflow)
5. [Module-by-Module Plan](#5-module-by-module-plan)
6. [Rate Limiting — Three Modes](#6-rate-limiting--three-modes)
7. [Post Date Range Strategy — Content Library & `yearsBack`](#7-post-date-range-strategy--content-library--yearsback)
8. [Scheduled Execution (Cron) — LIVE](#8-scheduled-execution-cron--live)
9. [Data Persistence](#9-data-persistence)
10. [Error Handling](#10-error-handling)
11. [Testing Strategy](#11-testing-strategy)
12. [Deployment Steps](#12-deployment-steps)
13. [Future Ideas](#13-future-ideas)

---

## 1. Project Overview

### 1.1 What This Tool Does

A Puppeteer-based Node.js script that:

1. **Logs into** the developer's personal Facebook account (via a saved Chrome session/profile)
2. **Discovers posts** via the Facebook **Professional Dashboard's Content Library** (not the public
   page feed — see §7), going back up to `yearsBack` (default 3) years
3. **For each post**, opens the reactions popup → scrolls through everyone who reacted → clicks
   "Invite" (`Pozvat`) on each person who is **not yet following** the page
4. **Runs daily via cron** on a Raspberry Pi, obeying strict rate limits to avoid account suspension
5. Exposes a **read-only web dashboard** (`src/dashboard.js`) showing per-post status, invite history,
   and a live log tail — no "run now" button by design (see §5.9)

### 1.2 What "Invite" Means

Inside the reactions popup on a **Page post**, every person who reacted (Like, Love, Care, HaHa, Wow,
Sad, Angry) and **is not yet following** the page has an **"Invite" button** next to their name.
Clicking it sends them an invitation to **follow the page**. This is how the politician grows their
audience organically — people who already react are warm leads.

### 1.3 Current State of the Code

| File | Status |
|------|--------|
| `src/index.js` | CLI: `--page`, `--url`, `--rate-mode`, `--date-from/to`, `--max-posts`, `--years-back`, `--test-selectors`, `--dry-run` (default true) |
| `src/inviter.js` | Orchestrator — `runWithBrowser` → `runPageWorkflow` (discover via Content Library, then invite loop) or single-URL mode; graceful SIGINT/SIGTERM shutdown; 1280×900 viewport |
| `src/session.js` | Chrome launch config — `headless: "new"`, `defaultViewport: 1280×900` |
| `src/storage.js` | `saveHistory(postUrl, count, meta)` + `getHistory()` — per-run invite history |
| `src/logger.js` | Winston — Console **and** File transport (`logs/latest.log`, 5MB cap) so the dashboard always has something to tail |
| `src/config.js` | Central config, rate-mode table, `yearsBack`, `discoveryTimeCapMs` — **note: `.env` is NOT auto-loaded** (no `dotenv` in this codebase); every env var that matters must be set inline on the command/cron line (see §8.2) |
| `src/rate-limiter.js` | Daily budget, cooldowns, lock file (prevents concurrent runs) |
| `src/auth.js` | Login verify, page nav, session-expiry watcher |
| `src/scraper.js` | Post discovery — **primary path is `discoverPostsFromContentLibrary()`** (see §7); legacy feed-based `discoverPosts()` kept but unused by the live workflow |
| `src/reactions.js` | Reactions dialog: open, scroll-and-invite loop, stable person-ID dedup, reel/story handling |
| `src/validate-invites.js` | Standalone fast **read-only** scanner (`node src/validate-invites.js <url>`) — scrolls a reactions dialog quickly with minimal delay to sanity-check that production invited (or would invite) everyone eligible, without ever clicking anything |
| `src/dashboard.js` | Read-only HTTP dashboard (`node src/dashboard.js`, default port 8787) — merged posts + invite-history table, budget/status cards, live log panel polling `/api/logs` |
| `PLAN.md` | This file |

**What's done:** Everything. Discovery via Content Library (with real 3-year date range + working
scroll), the full invite pipeline, rate limiting, the dashboard, the validation script, and daily cron
on the Pi. The project is now in **maintenance mode** — see §13 for optional future work.

---

## 2. Infrastructure

| Property | Value |
|----------|-------|
| **Physical machine** | Raspberry Pi |
| **OS** | Debian GNU/Linux 12 (bookworm), ARM |
| **Network** | Home network, static-ish LAN IP `192.168.1.32` (has been seen at `.48` too — dual WiFi/Ethernet; if unreachable, check both) |
| **Access** | SSH (`mathew@192.168.1.32`) |
| **Display** | None — fully headless. Login setup is done on a machine WITH a display, then `./profile/` copied to the Pi |
| **Runtime** | Node.js, at `/usr/bin/node` |
| **Browser** | System `chromium` package (`/usr/bin/chromium`) — **not** Puppeteer's bundled Chromium (ARM incompatible) |
| **Scheduling** | System cron (`crontab`) — see §8 |
| **Local dev/test rig** | WSL Ubuntu at `~/inviter-test` (uses `chromium-browser` snap + WSLg for a visible browser window) — used for fast iteration before deploying to the Pi |

### 2.1 Directory Structure

```
headless/
├── data/                     # Runtime data (gitignored)
│   ├── posts.json            # Every discovered post + its status/invitedCount
│   ├── invitations.json      # Per-run invite history
│   └── rate-limit-state.json # Daily budget / cooldown state
├── profile/                  # Chrome session (copy from local machine)
├── src/
│   ├── index.js
│   ├── inviter.js
│   ├── session.js
│   ├── logger.js
│   ├── storage.js
│   ├── config.js
│   ├── auth.js
│   ├── scraper.js
│   ├── reactions.js
│   ├── rate-limiter.js
│   ├── validate-invites.js
│   └── dashboard.js
├── logs/
│   └── latest.log            # Rolling file log (Winston File transport)
├── PLAN.md                   # This file
└── README.md
```

---

## 3. Authentication & Delegated Page Access

Unchanged from earlier phases:

1. On a machine with a display: `node src/index.js --wait-for-login --profile-dir ./profile`, log in,
   navigate to the page, press Enter — session is saved to `./profile/`.
2. `scp -r ./profile/ mathew@192.168.1.32:~/inviter/headless/profile/`
3. On the Pi, Puppeteer launches Chromium with `--user-data-dir=./profile` and reuses the session.

`src/auth.js` checks for logged-in indicators on every run and **never** attempts to re-login
programmatically — it logs a clear error and exits if the session has expired (Facebook sessions last
roughly 2–4 weeks).

---

## 4. Core Workflow

### 4.1 Algorithm (current)

```
1. Launch browser with saved profile (headless on the Pi)
2. Verify login
3. Navigate directly to the Professional Dashboard's Content Library
4. Set the date-range picker to "last <yearsBack> years" via calendar automation (§7.2)
5. Scroll the Content Library table (via real mouse-wheel events, NOT scrollTop — see §7.3)
   collecting rows until `maxPosts` NEW (never-seen) rows are found, a stall is confirmed, or the
   discovery time cap is hit
6. Filter out posts already marked "done" in posts.json
7. FOR EACH pending post (respecting the run-time cap and daily invite budget):
   a. Skip outright if it's a "story" (video/photo story repost — see §7.4)
   b. Otherwise navigate to its direct /content/insights/?content_id=... URL
   c. Open the reactions dialog, scroll-and-invite (patience-based end-of-list detection,
      stable-person-ID dedup — see §5.4)
   d. Record history, mark the post "done" in posts.json
   e. Cooldown before the next post
8. Save state, close browser
```

### 4.2 Why Content Library Instead of the Public Feed

The original plan (§5.3 in earlier drafts) scraped the page's public feed. This was replaced because
the Content Library:

- Gives a **direct per-post URL** (`/content/insights/?content_id=...&entry_point=ProdashCometContentLibraryTable`)
  that embeds the post with a working reactions toolbar, without ever loading a video/reel player
- Cleanly labels **"Video story" / "Photo story"** rows up front, so they can be skipped instead of
  attempting a reactions-dialog open that's known not to work for them (§7.4)
- Never mixes in shared/quoted posts from other authors — every row is the page's own content
- Has its own **date-range picker**, letting the tool constrain "how far back is even worth checking"
  independently of how many posts get processed in one run

### 4.3 Invite Button Behavior / Language

Unchanged: `"Pozvat"` (Czech, primary) / `"Invite"` (English, fallback). See `INVITE_SELECTORS` /
`TEST_SELECTORS` in `src/reactions.js`.

---

## 5. Module-by-Module Plan

### 5.1 `src/config.js`

Central config + 3 rate-limit modes (§6). Key fields beyond the original plan:

```javascript
yearsBack: parseInt(process.env.YEARS_BACK || "3", 10),
discoveryTimeCapMs: parseInt(process.env.DISCOVERY_TIME_CAP_MS || "600000", 10),
```

**Important:** this file reads straight from `process.env` — there is **no `dotenv.config()` call
anywhere in the codebase**. A `.env` file sitting in `headless/` is not read automatically. Every
variable that matters (`PUPPETEER_EXECUTABLE_PATH` especially) must be set inline on whatever command
line launches the process — see §8.2.

### 5.2 `src/auth.js`

Unchanged — `ensureLoggedIn()`, `navigateToPage()`, session-expiry detection.

### 5.3 `src/scraper.js` — Post Discovery

The module now exports two discovery paths:

- **`discoverPostsFromContentLibrary(page, dateFrom, dateTo, maxPosts, yearsBack, maxDiscoveryTimeMs)`**
  — **the one actually used** by `runPageWorkflow`. See §7 for the full mechanics (calendar
  automation, wheel-based scrolling, patience/stall detection, time cap).
- `discoverPosts(page, pageUrl, dateFrom, dateTo, maxPosts)` — the original feed-scraping
  implementation. Left in place (and still exported/tested) but not called by the live workflow.

Also in this file: `markPostStatus()` (updates a single post's bookkeeping in `posts.json`),
`mergePostLists()`, `filterByDate()`, `parseContentLibraryDate()`, `extractContentLibraryRows()`.

### 5.4 `src/reactions.js` — Reactions Dialog

The most heavily hardened module. Key mechanics, all confirmed live against real reaction lists of
hundreds of people:

- **`openReactionsDialog(page)`** — tries several strategies to find and click the reactions count,
  including an unlabelled "All reactions" button that's a *sibling* of the reaction-type toolbar
  (not a descendant — this specific DOM shape caused an early bug).
- **`getPersonId(el)`** — derives a stable identity for each reactor from their profile link, walking
  up to 8 parent levels to find an `a[href]`. Special-cases `profile.php?id=NNNN` URLs (identity is
  in the query string, not the path — two different people can otherwise collapse to the same key).
- **Dedup is done in JS via a `Set` of person IDs**, not a DOM `data-invited` attribute — Facebook
  recycles DOM nodes in long scrollable lists (virtualization), so attribute-based dedup silently
  missed people once the list got long enough to recycle nodes.
- **Patience-based end-of-list detection**: rather than concluding "done" after one no-growth scroll
  check, retries with growing delays (`[1000, 2000, 3000, 4000, 5000]` ms, up to 15s total) — a
  reactions list can genuinely pause mid-load for many seconds without being finished.
- `MAX_SCROLLS_WITHOUT_NEW = 300` (a safety net only; the patience retries are the real signal).
- `scrollAndInvite()` scrolls the dialog's own container by half a viewport height per step
  (`clientHeight * 0.5`) to avoid skipping past people.

### 5.5 `src/rate-limiter.js`

Unchanged from earlier phases — `canInviteToday()`, `recordInvite()`, `detectRateLimit()`,
`enterCooldown()`, lock file at `data/inviter.lock`.

### 5.6 `src/storage.js`

`saveHistory(postUrl, count, meta)` / `getHistory()` — per-run invite events, consumed by the
dashboard to compute totals (it sums history entries rather than trusting a single snapshot field, so
a post invited across multiple runs shows its true cumulative total).

### 5.7 `src/index.js`

CLI flags (see also §6, §7):

| Flag | Type | Default | Description |
|------|------|---------|--------------|
| `--page` | string | — | Full workflow: discover via Content Library → invite |
| `--url` | string | — | Single post URL (testing/manual mode) |
| `--dry-run` / `--no-dry-run` | boolean | `true` | Scan + log only vs. actually click |
| `--date-from` / `--date-to` | string | `all` | Filter discovered posts by date |
| `--max-posts` | number | `config.maxPostsPerRun` | Cap on **newly discovered** posts per run (not invites — see §7.5 on sizing this for cron) |
| `--years-back` | number | `config.yearsBack` (3) | How far back the Content Library date picker reaches |
| `--rate-mode` | string | `paranoid` | `paranoid` \| `moderate` \| `aggressive` |
| `--test-selectors` | boolean | `false` | Use "Sledovat"/"Follow" instead of "Pozvat"/"Invite" — safe testing on your own posts |
| `--profile-dir` | string | `config.profileDir` | Chrome profile path |
| `--headless` | boolean | `true` | Run invisibly |
| `--wait-for-login` | boolean | `false` | Open visibly for manual login |

### 5.8 `src/inviter.js`

`runWithBrowser({...})` → `runPageWorkflow(page, opts)`:

- Discovers via `scraper.discoverPostsFromContentLibrary(page, dateFrom, dateTo, maxPosts, yearsBack, config.discoveryTimeCapMs)`
- Filters to posts not already `"done"`
- Loops with a **run-time cap** (`config.runTimeCapMs`, independent of the discovery time cap) and the
  daily rate-limiter budget
- Skips `contentType === "story"` posts outright, marking them `"done"` immediately (§7.4)
- For real posts: navigates, opens reactions, invites, records history, marks `"done"`
- `--url` single-post mode also calls `scraper.markPostStatus()` now, so `posts.json` stays accurate
  even outside the full page workflow

### 5.9 `src/dashboard.js` — Read-Only Web Dashboard

Deliberately **read-only** — no "trigger a run" button. This was an explicit design decision: a
trigger button adds concurrency risk (what happens if someone clicks it while cron is already running
— the lock file would reject it, but it's an unnecessary failure mode to design in) and a bigger
memory/process footprint than is worth it on constrained hardware. The dashboard's only job is to
answer "what has the program done."

- `gatherData()` merges `posts.json` + `invitations.json`, excludes stories from the main table,
  computes `totalInvited` by summing history (not trusting a snapshot field)
- One table, one row per post, with expandable nested run-history rows — replaced an earlier, more
  confusing "recent posts" + "recent invite history" two-table layout
- A **"Sledované období"** (scanning period) card shows the actual date range being scanned — computed
  live from `config.yearsBack` (today back N years), the same way `setContentLibraryDateRange()`
  derives it, so it's never stale even though it isn't stored anywhere
- Live log panel polls `GET /api/logs` (reads `logs/latest.log`) every 3s
- **UI is in Czech** — this is what the page's actual stakeholders (the politician's team) read; labels,
  statuses, table headers, and the live-log panel text are all translated (`lang="cs"`)
- `node src/dashboard.js` (port 8787 by default, `DASHBOARD_PORT` env var to override)
- **Must be launched with `nohup ... & disown`** (or an equivalent detaching mechanism) when started
  over SSH — a plain foreground command dies the moment the SSH session ends
- **Remote access without port forwarding:** exposed publicly via **Tailscale Funnel** at
  `https://inviter-pi.tail000e48.ts.net` — a stable HTTPS URL that doesn't change across restarts/reboots
  (unlike `ngrok`/`localtunnel`, whose free-tier URLs are random and ephemeral, and whose tunnels were
  seen to silently drop and need manual restarting). Set up via `sudo tailscale up` (one-time device
  auth) then `sudo tailscale funnel --bg 8787` (persists in `tailscaled`'s own config — no foreground
  process to keep alive, survives reboots since `tailscaled` is a systemd service). The dashboard has no
  login, so this URL is effectively public to anyone who has it — acceptable for sharing with the
  client, but worth remembering if that changes.

### 5.10 `src/validate-invites.js` — Fast Read-Only Validator

`node src/validate-invites.js "<post-or-insights-url>"` — scrolls a single post's reactions dialog as
fast as possible (minimal delays) purely to confirm that everyone eligible for an invite either has
been invited or would be. Built to independently verify production `reactions.js` after the user
manually found discrepancies by scrolling Facebook themselves — this script went through the same
dedup/patience/`profile.php` bug-fix cycle as production code and directly validated three real bugs
before they were fixed (see git history for full detail). `HEADLESS=false` and `PROFILE_DIR` env vars
supported for local visual debugging.

---

## 6. Rate Limiting — Three Modes

| Setting | 🔒 Paranoid | ⚖️ Moderate (default, in use) | ⚡ Aggressive |
|---------|----------------------|-------------|---------------|
| **Daily max** | 100 | 250 | 500 |
| **Per post max** | 30 | 75 | 150 |
| **Base delay** | 5,000 ms | 3,000 ms | 1,500 ms |
| **Random extra** | 0–5,000 ms | 0–3,000 ms | 0–1,500 ms |
| **Scroll delay** | 1,500 ms | 1,000 ms | 500 ms |
| **Post cooldown** | 30 s | 15 s | 5 s |
| **Cooldown on error** | 48 h | 24 h | 12 h |
| **Max posts/run (config default)** | 5 | 10 | 20 |
| **Run time cap** | 20 min | 30 min | 45 min |

**Scroll delay halved (2026-07-05):** the user asked whether the run could be sped up "without getting
flagged." `scrollDelayMs` is the wait after every scroll before re-scanning for invite buttons — the
dominant per-iteration cost on a post with a huge reactor list (a single post can loop through this
thousands of times), but it's pure page-reading, not an invite-click action. Unlike `baseDelayMs`/
`randomExtraMs` (which pace the actual "Invite" clicks Facebook's abuse detection would plausibly
watch), scroll timing is indistinguishable from normal browsing — no account-risk tradeoff in speeding
it up, only a correctness one (not giving Facebook's lazy-loader enough time to render new rows), which
is why it was halved rather than cut more aggressively. Click pacing and the end-of-list patience
retries (§11.3 — calibrated for accuracy, not speed) are both left untouched.

`--max-posts` on the actual cron line overrides the config default (see §7.5) — this is safe because
`runTimeCapMs` and the daily budget independently bound how much real inviting happens per run,
regardless of how many posts discovery turns up.

**In production:** started in `paranoid` mode; confirmed hitting its 30-invite-per-post cap correctly
on a post with 37 eligible reactors (30 invited, 8 correctly left pending for the next run) — expected,
correct behavior, not a bug.

**Switched to `moderate` on 2026-07-04** (same day cron was first installed) — the user found the daily
runs too slow (one large post's reaction list ate the entire 20-minute paranoid run-time cap) and
explicitly chose to trade some of the "run paranoid for 1–2 weeks first" caution for speed. Moderate is
still a deliberately conservative preset (not `aggressive`), roughly doubling throughput: 3s vs 5s base
click delay, 15s vs 30s between posts, 30 vs 20 minute run cap, 250 vs 100 daily invites. If Facebook's
rate-limit detection ever fires (`enterCooldown`, logged prominently, run exits), drop back to
`paranoid` by editing the crontab line (`crontab -e`) — no code change needed, `--rate-mode` is a CLI flag.

### 6.1 Daily/Per-Post Volume Overrides — `DAILY_MAX_OVERRIDE` / `PER_POST_MAX_OVERRIDE`

Also added 2026-07-04, same day, after the page owner (Daniel Kůs) reviewed the first live run and gave
direct feedback via chat: *"limit 100 je moc nizky... bezne posilam 500 a mam vyzkouseno ze nevadi ani
tech 1400"* (100/day is too low; he routinely sends 500/day manually and has tested 1,400/day without
issue on this exact account). That's real, account-specific tolerance data — strictly better than the
generic paranoid/moderate/aggressive presets, which were conservative guesses made with zero account
history to go on.

Rather than jump to `aggressive` mode (which would also speed up click/scroll *pacing* — timing that's
been carefully tuned for accuracy against Facebook's DOM update speed, and isn't what was actually being
complained about), `config.js` now supports overriding just the volume caps on top of whichever mode is
selected:

```javascript
if (process.env.DAILY_MAX_OVERRIDE) rateMode.dailyMax = parseInt(process.env.DAILY_MAX_OVERRIDE, 10);
if (process.env.PER_POST_MAX_OVERRIDE) rateMode.perPostMax = parseInt(process.env.PER_POST_MAX_OVERRIDE, 10);
```

**Currently deployed:** `moderate` mode's pacing (3s click delay, 15s post cooldown, 30 min run cap)
with `DAILY_MAX_OVERRIDE=800` and `PER_POST_MAX_OVERRIDE=240` (same 10:3 ratio as the built-in presets),
set inline on the crontab line — comfortably under the owner's tested 1,400/day ceiling, above his
routine 500/day, with margin held back deliberately rather than run right at the tested limit.

---

## 7. Post Date Range Strategy — Content Library & `yearsBack`

### 7.1 Why Not Just "All Time"

The Content Library UI has no "all time" option that actually works — `ALL_TIME` / `LIFETIME` / `ALL`
/ `MAX` query params, and directly setting `start_date`/`end_date` via URL, were all tested live and
either silently fall back to the default ("Last 28 days") or show a misleading label without changing
the underlying query. **Only a genuine calendar interaction ending in a real click on the Apply
button** updates the real state.

### 7.2 `setContentLibraryDateRange(page, yearsBack)`

Drives the calendar UI with real pixel-coordinate clicks (empirically determined, somewhat fragile if
Facebook changes the layout):

1. Opens the date-range picker
2. Clicks "previous month" `yearsBack * 12` times, then clicks day `1`
3. Clicks "next month" forward to the current month, then clicks today's day number
4. Clicks **Apply**
5. Confirms via the resulting `"Custom: ..."` label text

Confirmed live producing `date_range=CUSTOM&start_date=<3-years-ago>&end_date=<today>` and a genuine
`"Custom: Jun 1 - Jul 4"`-style label.

### 7.3 Scrolling the Table — Real Mouse-Wheel Events

**This was the hardest bug of the whole project.** The Content Library table is **not** a CSS
`overflow: scroll`/`auto` container — every candidate element's `scrollHeight` stayed essentially flat
(within ~100px of `clientHeight`) no matter how much content had loaded, and setting `.scrollTop` on
any element (including the one with the largest `scrollHeight`) had zero effect. This is one of
Facebook's Comet virtualized lists that listens for genuine wheel events and fetches more rows via its
own internal offset/pagination — confirmed by dispatching `page.mouse.wheel({ deltaY: 1500 })`
repeatedly at the table and watching the row count grow (it took ~11 ticks / ~5.5s before the first
new batch of rows appeared in one live test).

`scrollContentLibraryTable(page)` now:
1. Counts current rows (`a[href*="content_id"], a[href*="/insights/"]`)
2. Moves the mouse over the table and dispatches up to 30 wheel ticks (500ms apart, ~15s worst case)
3. Returns `true` as soon as the row count grows, `false` if it never does

Before this fix, discovery silently stalled at **exactly 10 posts** every single run — the outer loop
would burn through hundreds of scroll iterations with zero progress, because scrolling had no real
effect on the table at all. This is fixed as of commit `a61197b`.

### 7.4 Story vs. Reel

Content Library labels some rows **"Video story"** / **"Photo story"**. These are confirmed (by the
user manually cross-checking Facebook) to be **ephemeral Story reposts of an already-discovered post**,
not standalone Reels — the underlying post shows up separately as its own `"post"`-type row, so
nothing is lost by skipping stories outright. They also never expose a working reactions dialog via
this UI. `contentType: "story"` posts are marked `"done"` immediately in `runPageWorkflow`, no
reactions dialog is ever attempted.

Genuine standalone Reels (not seen as a distinct Content Library category in practice, but handled
defensively) go through `openReactionsDialogForReel` in `reactions.js` if ever encountered.

### 7.5 Sizing `--max-posts` and `--years-back` for Cron

`--max-posts` caps **newly discovered** rows per run, roughly half of which are story-duplicates that
cost nothing (no invite budget, no reactions dialog). Since each cron run has to re-scroll past every
already-seen row before reaching new ones at the frontier, and the actual invite-sending is
independently bounded by `runTimeCapMs` + the daily budget, it's safe (and necessary, to make
meaningful progress through 3 years of backlog) to set `--max-posts` well above the rate-mode's config
default. **Currently deployed: `--max-posts 60 --years-back 3`** (see §8.1).

The `discoveryTimeCapMs` (default 10 minutes, `config.js`) bounds the discovery/scroll phase
independently of `runTimeCapMs`, so a single cron invocation can never run away even as the "already
seen" backlog grows over the multi-day catch-up period. Whatever's found by the time either cap hits
is processed; the rest is picked up by a future run — this is expected and fine, not an error.

---

## 8. Scheduled Execution (Cron) — LIVE

### 8.1 The Actual Crontab Entry (installed 2026-07-04, updated same day — see §6/§6.1)

```
0 9 * * * cd /home/mathew/inviter/headless && PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium DAILY_MAX_OVERRIDE=800 PER_POST_MAX_OVERRIDE=240 /usr/bin/node src/index.js --page "https://www.facebook.com/DanielKusPlzen" --profile-dir ./profile --no-dry-run --max-posts 60 --years-back 3 --rate-mode moderate >> logs/run-$(date +\%Y-\%m-\%d).log 2>&1
```

Runs daily at 09:00 on the Pi. Verified `cron` service is `active` via `systemctl is-active cron`.
See §6 for why `--rate-mode` was bumped from `paranoid` to `moderate`, and §6.1 for why
`DAILY_MAX_OVERRIDE`/`PER_POST_MAX_OVERRIDE` were added on top of it the same day.

### 8.2 Why `PUPPETEER_EXECUTABLE_PATH` Is Set Inline

There is **no `dotenv` loading anywhere in this codebase** — a `.env` file with
`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` sitting in `headless/` does **nothing** on its own. Every
prior successful run (manual or automated) worked only because that variable was exported inline on
the command that launched Node. The cron line above sets it explicitly for the same reason. If this
tool is ever ported to a machine where this variable needs to change, **edit the crontab line
directly** — don't assume `.env` will pick it up.

`--page` is likewise always passed explicitly on the command line — `config.fbPageUrl` (read from
`FB_PAGE_URL`) exists but is **not** wired up as a default for the `--page` CLI flag.

`--rate-mode moderate` is passed explicitly too; `index.js` sets `process.env.RATE_MODE` from this
flag *before* `config.js` is required, so it works regardless of what (if anything) is in `.env`.

### 8.3 Lock File

`data/inviter.lock`, managed by `rate-limiter.js` — prevents overlapping runs if one invocation is
still going (discovery phase + invite phase can together take up to ~40 min in the worst case:
`discoveryTimeCapMs` 10 min + `runTimeCapMs` 30 min for moderate mode) when the next scheduled run
would otherwise fire.

### 8.4 Logs

Daily cron output goes to `logs/run-YYYY-MM-DD.log` (via the crontab line's own redirection).
Separately, `src/logger.js`'s Winston File transport always writes to `logs/latest.log` (5MB cap, 1
file) regardless of how the process was launched — this is what `src/dashboard.js`'s live log panel
tails.

---

## 9. Data Persistence

| File | What it stores |
|------|---------------|
| `data/posts.json` | Every discovered post: `{ url, id, date, status, invitedCount, processedAt, error, contentType }` — `contentType` is `"post"` or `"story"` |
| `data/invitations.json` | Per-run invite history, consumed by `storage.getHistory()` |
| `data/rate-limit-state.json` | `{ date, invitesToday, dailyLimit, lastInviteTimestamp, isCooldown, cooldownUntil, consecutiveErrors }` |
| `data/inviter.lock` | Concurrent-run guard |
| `logs/latest.log` | Rolling live log (Winston File transport) |
| `logs/run-YYYY-MM-DD.log` | Daily cron stdout/stderr capture |
| `profile/` | Chrome's full session data (cookies, localStorage) |

### 9.1 Deduplication

- **Within a reactions dialog scroll**: a JS-side `Set` of stable person IDs (from `getPersonId()`),
  not a DOM attribute — see §5.4 for why.
- **Across runs, per post**: `posts.json`'s `status: "done"` prevents re-processing an entire post.
- **Across posts**: the same person can be (and sometimes is) invited from more than one post they
  reacted to — acceptable, low-probability, and Facebook tolerates occasional re-invites.

---

## 10. Error Handling

Unchanged from earlier phases — session expiry logs and exits (no auto-relogin), Facebook UI changes
get a screenshot + log + exit, network timeouts retry 3x with backoff then skip the post, rate-limit
detection enters a cooldown and exits, missing elements get a screenshot + skip to next post, browser
crashes are not auto-restarted mid-run (picked up fresh by the next cron invocation).

Screenshots on error/failed-click are saved to `data/screenshots/` for post-mortem debugging.

---

## 11. Testing Strategy

### 11.1 Test Modes

| Mode | Command | What it tests |
|------|---------|----------------|
| Dry run | `--dry-run` | Scans + logs, never clicks |
| Follow test | `--test-selectors` | Reactions popup + scroll loop on your own profile posts, safely |
| Single post | `--url <url>` | One specific post |
| Page mode | `--page <url>` | Full Content Library discovery → invite workflow |
| Fast validation | `node src/validate-invites.js <url>` | Independent, fast, read-only cross-check of a single post's invite completeness |
| Deep discovery check | any `--page` run with a high `--max-posts` and `--dry-run` | Confirms discovery reaches back through real history without re-stalling |

### 11.2 Test Checklist

- [x] `--wait-for-login` saves a working session
- [x] Session works when loaded headlessly
- [x] `--dry-run` logs buttons found without clicking
- [x] Reactions popup opens (sibling "All reactions" button strategy)
- [x] Scroll loop finds users and terminates (patience-based end-of-list, not a short fixed streak)
- [x] Stable person-ID dedup survives DOM node recycling in long lists
- [x] `profile.php?id=` URLs don't collide with each other
- [x] Daily limit stops the run; per-post cap (30 in paranoid) confirmed hit correctly on a 37-reactor post
- [x] Lock file prevents concurrent runs
- [x] Ctrl+C / SIGTERM releases lock cleanly
- [x] Story vs. Reel: "Video story"/"Photo story" rows correctly skipped as duplicates, not processed as reels
- [x] Content Library date-range picker reliably set to a real 3-year custom range (calendar automation)
- [x] Content Library table scrolls via real mouse-wheel events — confirmed discovery goes well past
      the old 10-post stall and progresses steadily backward through real history
- [x] `posts.json` `invitedCount` stays accurate for `--url` single-post mode too
- [x] Dashboard: single merged posts table with expandable run-history, live log panel, read-only (no trigger button)
- [x] Cron installed and verified active on the Pi (§8.1)

### 11.3 Bug Log (Full History)

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Buttons not found/clicked | `offsetParent === null` on all elements in `position: fixed` FB dialog | Removed `offsetParent` checks; use `getComputedStyle` |
| Wrong dialog found | Two `[role="dialog"]` in DOM; `querySelector` returns the first (comment box) | `querySelectorAll` filtered by computed visibility |
| Strategy 1 clicked wrong button | Unlabelled "All reactions" button is a *sibling* of the toolbar, not a descendant | Search sibling container, not just descendants |
| DOM-attribute dedup missed people | Facebook recycles DOM nodes in long virtualized lists | JS-side `Set` of stable person IDs (`getPersonId()`) instead of `data-invited` |
| Premature "end of list" | One quick no-growth check wasn't enough — lists pause mid-load for many seconds | Patience retries: `[1000,2000,3000,4000,5000]`ms before concluding done |
| `profile.php?id=` collisions | Identity was read from URL path, but for this URL shape it's in the query string | Special-cased in `getPersonId()` (3 call sites — a quote-style mismatch caused one to be missed by `replace_all` initially) |
| Blocking images broke scroll detection | Request interception blocked `image` resourceType, which broke scroll-height growth signals | Only block `media` type, not `image` |
| Stale code deployed to Pi despite "up to date" `git pull` | A local fix (`MAX_SCROLLS_WITHOUT_NEW`) was never `git add`ed before pushing | Always `git status`/`git diff` before assuming a fix is live |
| Reel/Story misclassification (2 reversals) | Initially assumed all "video story" rows were unsupported Reels; then tried enabling them since real Reels DO work; then user manually confirmed these specific rows are ephemeral Story-reposts of an existing post | Permanently skip `contentType: "story"`, added "Photo story" to detection regex |
| Direct URL date-range params ignored | `ALL_TIME`/custom `start_date`/`end_date` via direct navigation are silently ignored or cosmetic-only | Only a genuine calendar-driven Apply click works — see §7.1 |
| **Content Library discovery stuck at exactly 10 posts** | The table is not a CSS overflow-scroll container at all — every element's `scrollHeight` stays flat; `.scrollTop` assignment has zero effect (Comet virtualized list, wheel-event-driven) | Dispatch real `page.mouse.wheel()` events; use row-count growth as the signal instead of `scrollHeight` |
| Discovery phase had no time bound | Only the invite-processing phase (`runTimeCapMs`) was time-capped; a slow/stuck discovery scroll could in principle run forever | Added `config.discoveryTimeCapMs` (default 10 min), enforced inside `discoverPostsFromContentLibrary`'s loop |
| `.env` silently ignored | No `dotenv.config()` call anywhere in the codebase | Every variable that matters is set inline on the launching command/cron line instead (§8.2) |
| Run appeared "frozen" for 15 min (not an actual bug) | A post with thousands of reactors, mostly already following, produces long genuine stretches of zero new invites — the dashboard's invited-count only moves on an actual invite, so it looked stuck even though the scroll loop was actively working | Added a periodic heartbeat log (every 20 iterations) in `scrollAndInvite()` reporting invited-so-far and scans-since-last-invite, so long quiet stretches are visibly reported as progress |
| `DAILY_MAX_OVERRIDE` silently ignored on same-day reruns | `rate-limit-state.json`'s `dailyLimit` was only re-synced from `config.dailyMax` on an actual calendar-date change (`resetDailyIfNeeded`) — a run launched with the new override later the same day as an earlier run kept the stale `dailyLimit=100` baked into that day's state file. Confirmed live: a run configured for 800/day reported "budget remaining: 53" (100−47), not 753 | `dailyLimit` re-synced from `config.dailyMax` on every `resetDailyIfNeeded()` call regardless of date — it's a config value, not day-scoped state; only `invitesToday` should reset on a real day change |
| **Pending posts silently orphaned forever** (serious) | `discoverPostsFromContentLibrary()` only returns rows newly found in that specific call (rows already in `posts.json` are skipped there to avoid re-scraping) — `runPageWorkflow` derived its `pending` list solely from that return value. A post discovered in an earlier run but never processed (still "pending" after hitting the daily budget or run-time cap) would never appear in `discovered` again, since its URL was already in the "already seen" set — it silently dropped out of every future run's pending list forever, breaking the entire "cron eventually catches up on the backlog" premise. Confirmed live (2026-07-04): a run that discovered 60 posts and processed only 1 did NOT retry the other 59 on the next run — it found a fresh batch further back instead | `runPageWorkflow` now loads the FULL accumulated `posts.json` list (`scraper.loadPostList()`) and derives `pending` from everything not yet `"done"`, instead of relying only on the newly-discovered batch |

---

## 12. Deployment Steps

### 12.1 On a Machine With a Display (first-time login / session renewal)

```bash
git clone https://github.com/mathew8e/inviter.git
cd inviter/headless
npm ci
node src/index.js --wait-for-login --profile-dir ./profile
# Log into Facebook, navigate to the politician's page, press Enter
scp -r ./profile/ mathew@192.168.1.32:/home/mathew/inviter/headless/profile/
```

### 12.2 On the Pi

```bash
ssh mathew@192.168.1.32
cd ~/inviter && git pull
cd headless && npm ci   # if dependencies changed

# Sanity check (safe, no clicks):
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node src/index.js \
  --page "https://www.facebook.com/DanielKusPlzen" --profile-dir ./profile \
  --dry-run --max-posts 15 --years-back 3

# Crontab is already installed (§8.1) — to view/edit:
crontab -l
crontab -e
```

### 12.3 Session Renewal (Every ~2–4 Weeks)

Repeat §12.1's `--wait-for-login` step on a display machine, then `scp` the refreshed `./profile/`
over to the Pi again.

### 12.4 Dashboard

```bash
ssh mathew@192.168.1.32
cd ~/inviter/headless
nohup node src/dashboard.js > /tmp/dashboard.log 2>&1 < /dev/null &
disown
# Visit http://192.168.1.32:8787
```

---

## 13. Future Ideas

| Feature | Notes |
|---------|-------|
| **Email/push notification** on errors or session expiry | Would remove the need to manually check the dashboard/logs |
| **Auto-detect Pi IP** | Has been seen at both `.32` and `.48` (dual WiFi/Ethernet) — a small discovery script would save time if it moves again |
| **Multiple page support** | If more politicians/pages are ever added |
| **Session-expiry pre-check before cron fires** | Currently only discovered when a scheduled run fails — could ping login state and alert sooner |
