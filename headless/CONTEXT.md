# Project Context: Inviter Headless

> Generated: 2026-06-11

---

## Overview

**Inviter Headless** is a Puppeteer-based Node.js automation tool that scans Facebook posts/profiles and automatically sends invite requests (`Pozvat`/`Invite` buttons) to users who reacted to a post. It runs as a CLI tool, optionally inside Docker, and persists invite history to a JSON file.

---

## Project Structure

```
D:\MASTER_FOLDER\PROJECTS\DIGITAL\CODE_PERSONAL\inviter\headless\
├── .dockerignore          # Excludes node_modules, profile, data from Docker build
├── .env.example           # Env vars: DB_PATH, USER_AGENT, HEADLESS
├── Dockerfile             # node:20-bullseye-slim with Chromium deps
├── docker-compose.yml     # Docker Compose service definition
├── package.json           # npm package (name: inviter-headless, v0.1.0)
├── package-lock.json
├── nodeinstal.bash        # Script to install Node dependencies
├── README.md              # Usage instructions
├── data/                  # Runtime data directory (gitignored)
│   └── invitations.json   # Invite history database (JSON array)
├── profile/               # Chrome browser profile for session reuse
│   └── Default/           # Full Chrome user data directory
│       ├── Cookies
│       ├── Login Data
│       ├── Preferences
│       ├── Local Storage/
│       └── ...browser cache/db files...
└── src/
    ├── index.js           # CLI entry point (yargs-based)
    ├── inviter.js         # Core invite automation logic (Puppeteer)
    ├── logger.js          # Winston logger (console transport)
    ├── session.js         # Chrome launch options & profile discovery
    └── storage.js         # JSON-based invite history persistence
```

---

## Key Files & Their Roles

### 1. `src/index.js` — CLI Entry Point

- Uses **yargs** for argument parsing.
- Options:
  | Flag | Type | Default | Description |
  |---|---|---|---|
  | `--url` | string | **(required)** | Facebook post URL to scan |
  | `--max` | number | 1000 | Max invites before stopping |
  | `--delay` | number | 1000 | Base delay between clicks (ms) |
  | `--profile-dir` | string | — | Chrome user data dir for login reuse |
  | `--headless` | boolean | true | Run browser in headless mode |
- Flow: initializes storage → calls `inviter.runWithBrowser()` → logs result → exits.

### 2. `src/inviter.js` — Core Automation Logic

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

### 3. `src/session.js` — Browser Launch Configuration

- **`findCachedLinuxChrome()`**: Searches `~/.cache/puppeteer/chrome/linux-*` for a cached Chromium executable.
- **`getLaunchOptions(profileDir, headless)`**: Returns Puppeteer launch options:
    - `headless`: Configurable (default `true`).
    - `args`: 18 Chrome flags including `--no-sandbox`, `--disable-gpu`, `--disable-blink-features=AutomationControlled`, etc.
    - `protocolTimeout`: From env `PUPPETEER_PROTOCOL_TIMEOUT` or 300s default.
    - `userDataDir`: Set if `profileDir` is provided.
    - `executablePath`: From env `PUPPETEER_EXECUTABLE_PATH`, or falls back to cached Linux Chrome.

### 4. `src/storage.js` — Persistence Layer

- Stores invite history in `data/invitations.json` (or custom path via `DB_PATH` env var).
- Structure: JSON array of `{ id, ts (Date.now()), url, count }`.
- Two functions:
    - `init()`: Creates data directory and initializes empty JSON array file.
    - `saveHistory(url, count)`: Appends a new entry and writes back.
- Note: Despite `.env.example` suggesting `invites.db`, the actual implementation uses `.json`.

### 5. `src/logger.js` — Logging

- Uses **winston** with a single `Console` transport at `info` level.
- Format: simple (`winston.format.simple()`).

---

## Data Flow

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

---

## Environment Variables

| Variable                     | Default                           | Description                           |
| ---------------------------- | --------------------------------- | ------------------------------------- |
| `DB_PATH`                    | `./data/invitations.json`         | Path to invite history JSON file      |
| `USER_AGENT`                 | `Mozilla/5.0 (X11; Linux x86_64)` | Custom user agent for the page        |
| `HEADLESS`                   | `true`                            | Headless mode toggle                  |
| `PUPPETEER_EXECUTABLE_PATH`  | auto-detected                     | Path to custom Chromium/Chrome binary |
| `PUPPETEER_PROTOCOL_TIMEOUT` | `300000`                          | Protocol timeout in ms                |

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

````js
// Try clicking the 'All reactions' opener or toolbar that reveals people who reacted
const openerClicked = await page.evaluate(() => {
    // Strategy 1: Exact 'All reactions' button with role=button
    const roleButtons = Array.from(document.querySelectorAll('[role="button"]'));
    const exactAll = roleButtons.find(b => /^alln    const exactAll = roleButtons.find(b => /^all reactions[:\s]?/i.test(b.innerText));\n\n    // Strategy 2: Toolbar with aria-label matching localized variants\n    const toolbar = document.querySelector('[role=\"toolbar\"][aria-label]');\n    // Checks for: \"see who reacted\", \"reakce\" (Czech), \"reagoval\", \"people\", \"lidé\"\n\n    // Strategy 3: Any visible element with text \"All reactions\" or localized variants\n    const candidates = Array.from(document.querySelectorAll('[role=\"button\"], div, span'));\n    // Checks for: /all reactions/i, /see who reacted/i, /reakce/i, /people/i, /lidé/i\n\n    // Strategy 4: Elements with numeric count + \"others\" nearby\n    // Matches patterns like \"50 others\", \"30 people\"\n});\n```\n\nThe opener detection used **4 fallback strategies**, from most specific (exact `role=\"button\"` with text \"All reactions\") to most heuristic (any element with numbers + \"others\").\n\n#### Step 2: Debug Dump (if opener not found)\n\nIf no opener was found, the tool would:\n- Dump the full page HTML to `data/page-debug-{timestamp}.html`\n- Search for text matches and compute an XPath for the candidate opener element\n- Attempt to click via `page.$x()` (XPath-based Puppeteer click)\n- Dump all button candidates (text, aria-label, role, classes, outerHTML) to `data/button-candidates-{timestamp}.json`\n\n#### Step 3: Wait for the Dialog to Appear\n\n```js\nawait page.waitForTimeout(1200);\nawait Promise.race([\n    page.waitForSelector('[role=\"dialog\"]', { timeout: 3000 }).catch(() => {}),\n    page.waitForSelector('[role=\"list\"]', { timeout: 3000 }).catch(() => {}),\n]);\n```\n\nThis waited for a Facebook dialog (`[role=\"dialog\"]`) or list (`[role=\"list\"]`) to render after clicking the reactions opener.\n\n#### Step 4: Find the Scrollable Container Inside the Dialog\n\nThe `findScrollable()` function (commit `689bf34` / `dd10003`) searched for the correct scrollable container inside the popup:\n\n```js\nfunction findScrollable() {\n    // 1. Find all dialogs: document.querySelectorAll('[role=\"dialog\"]')\n    const dialogs = Array.from(document.querySelectorAll('[role=\"dialog\"]'));\n\n    for (const dialog of dialogs) {\n        // 2. Look for descendants containing Follow/Invite buttons\n        const candidates = Array.from(dialog.querySelectorAll('*'));\n        let best = null, bestCount = 0;\n\n        for (const candidate of candidates) {\n            // Count how many follow/invite buttons are inside this candidate\n            let count = 0;\n            for (const selector of selectors) {\n                count += candidate.querySelectorAll(selector).length;\n            }\n\n            if (count > 0) {\n                const overflowY = window.getComputedStyle(candidate).overflowY;\n                const scrollable = overflowY === 'auto' || overflowY === 'scroll'\n                    || candidate.scrollHeight > candidate.clientHeight;\n\n                // Prefer scrollable containers\n                if (scrollable) return candidate;\n                if (count > bestCount) { best = candidate; bestCount = count; }\n            }\n        }\n\n        // 3. Fallback to the dialog itself if scrollable\n        if (dialog.scrollHeight > dialog.clientHeight) return dialog;\n    }\n\n    // 4. Fallback: any large scrollable div on the page\n    // 5. Last resort: document.scrollingElement || document.body\n}\n```\n\nThis algorithm:\n1. Found all `[role=\"dialog\"]` elements (Facebook's popup overlay).\n2. Within each dialog, searched descendant elements for those containing follow/invite buttons.\n3. Among button-containing elements, **preferred scrollable ones** (`overflow: auto/scroll` or `scrollHeight > clientHeight`).\n4. Fell back to the dialog itself if scrollable.\n5. Fell back to any large page div with overflow.\n6. Last resort: the document's scrolling element or body.\n\n#### Step 5: Pre-scroll the Dialog to Load More Users\n\nBefore scanning for buttons, the tool pre-scrolled the container to trigger Facebook's lazy-loading:\n\n```js\n// Commit dd10003 version\nconst container = findScrollable();\nconst total = Math.max(container.scrollHeight || 1000, 1000);\nconst step = Math.floor(total / 6) || 400;\nfor (let i = 0; i < 10; i++) {\n    container.scrollBy({ top: step, behavior: \"smooth\" });\n    await new Promise(r => setTimeout(r, 450));\n}\n```\n\nThis performed 10 scroll steps with 450ms delays between them.\n\n#### Step 6: Iterative Scroll-and-Invite Loop\n\nCommit `39dce7f` (before simplification) had a full **while-loop** that scrolled, scanned, and invited iteratively:\n\n```js\nconst scrollable = findScrollable();\nlet consecutiveNoNewButtons = 0;\nlet lastScrollHeight = -1;\n\nwhile (clicked.length < maxInvites && consecutiveNoNewButtons <= noNewButtonsLimit) {\n    // 1. Scan for new buttons in the current viewport\n    const found = [];\n    for (const selector of selectors) {\n        const nodes = Array.from(document.querySelectorAll(selector));\n        for (const node of nodes) {\n            if (!isVisible(node) || !matchesTarget(node)) continue;\n            if (seenNodes.has(node)) continue;\n            seenNodes.add(node);\n            found.push(node);\n        }\n    }\n\n    // 2. Scroll to each found button and click\n    for (const node of found) {\n        node.scrollIntoView({ block: \"center\", inline: \"center\" });\n        await sleep(250);\n        if (simulateOnly) { /* record */ continue; }\n        node.click();\n        node.setAttribute(\"data-invited\", \"true\");\n        await sleep(delayMs + 500);\n    }\n\n    // 3. Scroll the container down to load more\n    if (scrollable) {\n        scrollable.scrollTop = scrollable.scrollHeight;\n    }\n    await sleep(1200);\n}\n```\n\nKey features of this loop:\n- **`seenNodes` (WeakSet)**: Tracks already-processed nodes across scroll cycles.\n- **`consecutiveNoNewButtons`**: Counter that breaks the loop after 5 consecutive scrolls with no new buttons found.\n- **`lastScrollHeight`**: Detects when the container stops growing (no more content to load).\n- **Scrolls to bottom** of the container to trigger Facebook's infinite scroll.\n\n#### Step 7: Scrolling Within the Dialog (Commit `dd10003`)\n\nCommit `dd10003` replaced the while-loop with a **for-loop with fixed scroll rounds**:\n\n```js\nconst root = findScrollable();\nlet lastScrollTop = -1;\n\nfor (let round = 0; round < scrollRounds; round++) {\n    // Scan for all buttons visible in current viewport\n    const nodes = [];\n    for (const selector of selectors) {\n        const scope = root || document;\n        const matches = Array.from(scope.querySelectorAll(selector));\n        for (const node of matches) {\n            if (!isVisible(node) || !matchesTarget(node)) continue;\n            nodes.push(node);\n        }\n    }\n\n    // Click all found buttons\n    const uniqueNodes = Array.from(new Set(nodes));\n    for (const node of uniqueNodes) { /* click logic */ }\n\n    // Scroll incrementally within the popup\n    if (root && root.scrollHeight > root.clientHeight) {\n        const currentTop = root.scrollTop || 0;\n        const nextTop = currentTop + Math.max(200, Math.floor(root.clientHeight * 0.8));\n        root.scrollTop = nextTop;\n        if (root.scrollTop === lastScrollTop) break; // Stop if scrolled to bottom\n        lastScrollTop = root.scrollTop;\n    } else {\n        window.scrollBy(0, Math.max(200, window.innerHeight * 0.8));\n    }\n}\n```\n\nThis version:\n- Scrolled in increments of **80% of the container height** (or 200px minimum).\n- Detected scroll end by comparing `scrollTop` before and after (if no change → reached bottom).\n- Used `scrollRounds = 2` for dry-run, `5` for actual invites.\n\n---\n\n### Evolution Timeline (Scrolling & Popup)\n\n| Commit | State | Key Changes |\n|---|---|---|\n| `81d6128` | **Initial** | Headless Puppeteer scaffold, basic navigation |\n| `689bf34` | **Full implementation** | Reactions opener click → dialog detection → `findScrollable()` → iterative scroll-and-invite while-loop → `seenNodes` tracking → `consecutiveNoNewButtons` break condition |\n| `3f8839e` | **Dry-run added** | `simulateOnly` flag to log matches without clicking |\n| `39dce7f` | **Simplified** | **Removed** the entire scroll loop, `WeakSet`, `consecutiveNoNewButtons`, `findScrollable()`. Replaced with flat scan of all DOM nodes at once using `findScrollable()` scope. |\n| `dd10003` | **Scroll rounds added** | Reintroduced scrolling as a **for-loop** (`scrollRounds`) with incremental scroll (80% height steps). Added scroll-end detection. |\n| `f421dbf` | **CSS fix** | Added light color-scheme injection to fix black background. |\n| `c54f7d0` | **Streamlined (CURRENT)** | **Removed ALL** popup/dialog logic, `findScrollable()`, opener detection, scroll loops. Only does flat button scan + click. No reactions popup handling. |\n\n---\n\n### Why the Popup/Scroll Logic Was Removed\n\nThe current streamlined version:\n- Only works if **invite buttons are already visible on the page** (e.g., a group member list or event attendees page where buttons render natively).\n- Does **not** open the reactions popup, so if the URL is a post, the tool will likely find **zero** buttons.\n- Has no scrolling loop, so only buttons in the initial viewport are clicked.\n\nIf you need the full reactions-popup + scrolling functionality again, the code exists in commits `689bf34` through `f421dbf` and can be restored from git history.\n\n---\n\n## Key Observations\n\n1. **Facebook selectors target `Pozvat` (Czech/Slovak) and `Invite` (English)** — the tool is designed for multilingual use.\n2. **All interaction runs inside `page.evaluate()`** — clicks happen in the browser context, not via Puppeteer's `page.click()`. This means no navigation handling between clicks.\n3. **No pagination/scroll loop in current version** — the current code only clicks buttons visible at page load. Earlier commits (up to `f421dbf`) had full scroll-and-invite loops within dialog popups that were removed.\n4. **Storage uses JSON** (despite the name suggesting `invites.db` in `.env.example`).\n5. **Profile directory** contains a real Chrome profile with cookies, localStorage, and session data — enabling login reuse without re-authentication.\n6. **The `package.json` main field points to `src/login.js`** which doesn't exist — this is a legacy reference; actual entry point is `src/index.js`."}]
````
