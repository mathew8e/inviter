/**
 * dashboard.js — Read-only status web interface.
 *
 * Shows: rate-limit budget/cooldown, whether a run is currently active
 * (lock file), post discovery/processing status, recent invite history,
 * and recent warnings/errors pulled from the newest logs/*.log file.
 *
 * Deliberately no write actions (no "trigger a run" button, no config
 * editing) — this only reads the same JSON/log files the automation
 * already writes, so it adds negligible memory overhead and can safely
 * run alongside the automation on constrained hardware.
 *
 * Uses only Node's built-in http module — no new dependencies.
 *
 * Usage: node src/dashboard.js [--port 8787]
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const scraper = require("./scraper");
const storage = require("./storage");
const rateLimiter = require("./rate-limiter");

const PORT = parseInt(
    process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ||
        process.env.DASHBOARD_PORT ||
        "8787",
    10,
);

// ──────────────────────────────────────────────
// Data gathering
// ──────────────────────────────────────────────

function isRunActive() {
    return fs.existsSync(config.lockFilePath);
}

function getLiveLogLines(maxLines = 150) {
    const liveLogPath = path.join(config.logsDir, "latest.log");
    if (!fs.existsSync(liveLogPath)) return [];
    const content = fs.readFileSync(liveLogPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-maxLines);
}

function getRecentLogLines(maxLines = 80) {
    if (!fs.existsSync(config.logsDir)) return [];
    const files = fs
        .readdirSync(config.logsDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ f, mtime: fs.statSync(path.join(config.logsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return [];

    const latest = path.join(config.logsDir, files[0].f);
    const content = fs.readFileSync(latest, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-maxLines).reverse();
}

function getWarningsAndErrors(lines) {
    return lines.filter((l) => /\bwarn:|\berror:/i.test(l));
}

/**
 * The date range the program actually scans on each run: from
 * config.discoverSinceDate through today.
 */
function getDiscoveryRange() {
    const to = new Date();
    const fmt = (d) => d.toISOString().slice(0, 10);
    return { from: config.discoverSinceDate, to: fmt(to) };
}

function gatherData() {
    const postList = scraper.loadPostList();
    const allPosts = postList.posts || [];
    const history = storage.getHistory();
    const rateState = rateLimiter.getState();
    const recentLogLines = getRecentLogLines(200);
    const warningsAndErrors = getWarningsAndErrors(recentLogLines).slice(0, 40);

    // Stories are ephemeral reposts of an existing post with no working
    // reactions dialog — the underlying content is already shown as its
    // own "post" entry, so Stories are excluded from the list entirely
    // rather than cluttering it with duplicate/non-actionable rows.
    const posts = allPosts.filter((p) => p.contentType !== "story");

    // Group invite-history entries by post URL so each post shows ONE row
    // with every run against it nested inside, instead of two separate,
    // hard-to-cross-reference tables (posts.json snapshot vs invitations.json
    // log).
    const historyByUrl = new Map();
    for (const h of history) {
        if (!historyByUrl.has(h.postUrl)) historyByUrl.set(h.postUrl, []);
        historyByUrl.get(h.postUrl).push(h);
    }

    const postRows = posts.map((p) => {
        const runs = (historyByUrl.get(p.url) || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
        // Total comes from posts.json's own invitedCount, NOT summed from the
        // history log — markPostStatus() runs unconditionally after every
        // processed post, but storage.saveHistory() was missing entirely
        // from resweep_done_posts.js for its first full pass (confirmed live
        // 2026-07-22: real invites were sent and correctly counted here, but
        // never logged to history), so summing the log alone undercounts.
        const totalInvited = p.invitedCount || 0;
        return { ...p, runs, totalInvited };
    });
    // Sorting/pagination now happens at render time based on the requested
    // column, so leave this in a stable default order (most recently
    // touched first) here.
    postRows.sort((a, b) => (b.processedAt || 0) - (a.processedAt || 0));

    const postsByStatus = { pending: 0, done: 0, error: 0 };
    for (const p of posts) {
        postsByStatus[p.status] = (postsByStatus[p.status] || 0) + 1;
    }
    const storyCount = allPosts.filter((p) => p.contentType === "story").length;

    // Summed from posts.json's per-post invitedCount, not the history log —
    // markPostStatus() runs unconditionally after every processed post, but
    // storage.saveHistory() was missing entirely from resweep_done_posts.js
    // for its first full pass (confirmed live 2026-07-22: 869 real invites
    // were sent and correctly counted here, but never logged to history),
    // so summing history alone silently undercounts.
    const totalInvitedAllTime = allPosts.reduce((sum, p) => sum + (p.invitedCount || 0), 0);

    // A plain-language "what happened recently" feed, newest first — this is
    // what a non-technical reader (the page owner) actually wants to see,
    // as opposed to the raw log lines underneath. Built from the same
    // history log the post table's expandable rows use.
    const dateByUrl = new Map(posts.map((p) => [p.url, p.date]));
    const recentActivity = history
        .slice()
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 15)
        .map((h) => ({
            ts: h.ts,
            postDate: dateByUrl.get(h.postUrl) || null,
            invitedCount: h.invitedCount || 0,
            stoppedReason: h.stoppedReason,
        }));

    // Rough throughput estimate from the last hour of activity, used to give
    // a plain-language ETA for the remaining backlog instead of just a bare
    // pending count with no sense of "how long will this actually take".
    const oneHourAgo = Date.now() - 3600000;
    const postsLastHour = history.filter((h) => (h.ts || 0) >= oneHourAgo).length;

    return {
        runActive: isRunActive(),
        rateState,
        postsByStatus,
        storyCount,
        totalPosts: posts.length,
        postRows,
        totalInvitedAllTime,
        recentActivity,
        postsLastHour,
        warningsAndErrors,
        scrapedAt: postList.scrapedAt,
        generatedAt: Date.now(),
        discoveryRange: getDiscoveryRange(),
    };
}

// Minutes until the next cron tick — the schedule runs every even hour.
function minutesUntilNextRun() {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(Math.ceil((now.getHours() + (now.getMinutes() > 0 || now.getSeconds() > 0 ? 1 : 0)) / 2) * 2);
    if (next <= now) next.setHours(next.getHours() + 2);
    return Math.max(0, Math.round((next - now) / 60000));
}

/** Small subset of gatherData() used for the live-polled header/cards — kept
 * cheap (no post-list scan) since this is fetched every 15s. */
function gatherStatus() {
    const rateState = rateLimiter.getState();
    const postList = scraper.loadPostList();
    const posts = (postList.posts || []).filter((p) => p.contentType !== "story");
    const postsByStatus = { pending: 0, done: 0, error: 0 };
    for (const p of posts) postsByStatus[p.status] = (postsByStatus[p.status] || 0) + 1;
    // Summed from posts.json's per-post invitedCount — see gatherData()'s
    // comment for why the history log alone would undercount.
    const totalInvitedAllTime = posts.reduce((sum, p) => sum + (p.invitedCount || 0), 0);

    return {
        runActive: isRunActive(),
        rateState,
        postsByStatus,
        totalInvitedAllTime,
        generatedAt: Date.now(),
    };
}

// ──────────────────────────────────────────────
// Labels / formatting
// ──────────────────────────────────────────────

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("cs-CZ");
}

function timeAgo(ts) {
    if (!ts) return "—";
    const diffMin = Math.round((Date.now() - ts) / 60000);
    if (diffMin < 1) return "právě teď";
    if (diffMin < 60) return `před ${diffMin} min`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `před ${diffHr} h`;
    return `před ${Math.round(diffHr / 24)} dny`;
}

function fmtMinutes(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// Czech numeral agreement: 1 = singular, 2-4 = "few" plural, 5+ = "many" plural.
function personCount(n) {
    if (n === 1) return "1 nový člověk";
    if (n >= 2 && n <= 4) return `${n} noví lidé`;
    return `${n} nových lidí`;
}

function activityLine(entry) {
    if (entry.invitedCount > 0) return `nalezeno a pozváno ${personCount(entry.invitedCount)}`;
    if (entry.stoppedReason === "post_time_cap") return "čas vypršel — zbytek se dokončí příště";
    if (entry.stoppedReason === "dialog_not_opened" || entry.stoppedReason === "no_container_found") {
        return "nepodařilo se otevřít reakce na tomto příspěvku";
    }
    return "nikdo nový k pozvání (buď všichni už stránku sledují, nebo je hotovo)";
}

function fmtDate(isoDate) {
    if (!isoDate) return "—";
    return new Date(isoDate + "T00:00:00").toLocaleDateString("cs-CZ");
}

const STATUS_LABELS_CZ = { done: "hotovo", pending: "čeká", error: "chyba" };
const STATUS_CLASS = { done: "ok", pending: "warn", error: "danger" };

function statusBadge(status) {
    const cls = STATUS_CLASS[status] || "";
    const label = STATUS_LABELS_CZ[status] || status;
    return `<span class="badge badge-${cls}">${esc(label)}</span>`;
}

function contentTypeLabel(contentType) {
    return contentType === "story" ? "Story" : "Příspěvek";
}

// Raw internal reason codes (e.g. "loop_exit", "post_time_cap") translated
// into plain-language Czech — these were previously shown as-is, which the
// page owner flagged as unreadable jargon (2026-07-22).
const STOP_REASON_LABELS_CZ = {
    loop_exit: "Dokončeno — celý seznam reakcí projit",
    no_more_users: "Dokončeno — už žádní další uživatelé",
    post_time_cap: "Časový limit příspěvku — zbytek se dokončí příště",
    dialog_not_opened: "Nepodařilo se otevřít dialog reakcí",
    no_container_found: "Nenalezen posouvatelný seznam reakcí",
    no_budget: "Vyčerpán denní limit pozvánek",
    per_post_limit: "Dosažen limit pozvánek pro tento příspěvek",
    story_not_supported: "Story repost — nepodporováno (duplicitní obsah)",
    run_time_cap: "Časový limit celého běhu",
    rate_limited: "Facebook omezil rychlost — pauza",
    session_expired: "Vypršelo přihlášení",
    discovery_only_phase: "Pouze vyhledávání příspěvků (bez pozvánek)",
    error: "Chyba",
};

function stopReasonLabel(reason) {
    if (!reason) return "—";
    return STOP_REASON_LABELS_CZ[reason] || reason;
}

const RATE_MODE_LABELS_CZ = { paranoid: "opatrný", moderate: "střední", aggressive: "rychlý" };

function rateModeLabel(mode) {
    if (!mode) return "—";
    return RATE_MODE_LABELS_CZ[mode] || mode;
}

// ──────────────────────────────────────────────
// Sorting / pagination
// ──────────────────────────────────────────────

const PAGE_SIZE = 10;

const SORT_GETTERS = {
    date: (p) => p.date || "",
    type: (p) => contentTypeLabel(p.contentType),
    status: (p) => p.status || "",
    invited: (p) => p.totalInvited || 0,
    reactions: (p) => (p.reactionsCount == null ? -1 : p.reactionsCount),
    runs: (p) => p.runs.length || 0,
    processed: (p) => p.processedAt || 0,
};

function sortPostRows(rows, sortKey, dir) {
    const getter = SORT_GETTERS[sortKey] || SORT_GETTERS.processed;
    return rows.slice().sort((a, b) => {
        const av = getter(a);
        const bv = getter(b);
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
        return 0;
    });
}

function paginate(rows, page) {
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * PAGE_SIZE;
    return { pageRows: rows.slice(start, start + PAGE_SIZE), totalPages, safePage };
}

// ──────────────────────────────────────────────
// HTML rendering
// ──────────────────────────────────────────────

function renderPage(data, query = {}) {
    const budgetPct = Math.min(
        100,
        Math.round((data.rateState.invitesToday / (data.rateState.dailyLimit || 1)) * 100),
    );

    const sortKey = SORT_GETTERS[query.sort] ? query.sort : "processed";
    const sortDir = query.dir === "asc" ? "asc" : "desc";
    const requestedPage = parseInt(query.page, 10) || 1;
    const sortedRows = sortPostRows(data.postRows, sortKey, sortDir);
    const { pageRows, totalPages, safePage } = paginate(sortedRows, requestedPage);

    // Builds a link that preserves the other params and toggles direction
    // when clicking the column already being sorted by.
    const sortLink = (key, label) => {
        const nextDir = sortKey === key && sortDir === "asc" ? "desc" : "asc";
        const active = sortKey === key;
        const arrow = active ? (sortDir === "asc" ? "▲" : "▼") : "";
        return `<a class="sort-link${active ? " active" : ""}" href="?sort=${key}&dir=${nextDir}&page=1#posts">${esc(label)}<span class="sort-arrow">${arrow}</span></a>`;
    };
    const pageLink = (p) => `?sort=${sortKey}&dir=${sortDir}&page=${p}#posts`;

    // ── Plain-language status story: what's happening now / what's next ──
    // This is the section a non-technical reader actually wants — the raw
    // stats and log below exist mostly for debugging, not for answering
    // "is this working and when will it be done" (2026-07-22).
    const pendingCount = data.postsByStatus.pending || 0;
    const nextRunMin = minutesUntilNextRun();
    let nowSentence;
    if (data.runActive) {
        nowSentence = "Právě pracuje — prochází příspěvky a hledá lidi k pozvání.";
    } else if (pendingCount > 0) {
        nowSentence = `Momentálně neběží. Čeká ${pendingCount} nezpracovaných příspěvků — příští automatické spuštění za ${fmtMinutes(nextRunMin)}.`;
    } else {
        nowSentence = `Momentálně neběží — všechny příspěvky jsou zpracované. Příští kontrola nových příspěvků za ${fmtMinutes(nextRunMin)}.`;
    }

    let etaSentence = "";
    if (pendingCount > 0 && data.postsLastHour > 0) {
        const etaHours = pendingCount / data.postsLastHour;
        const etaText = etaHours < 1 ? fmtMinutes(Math.round(etaHours * 60)) : `${etaHours.toFixed(1)} h`;
        etaSentence = `Za poslední hodinu zpracováno ${data.postsLastHour} příspěvků. Při tomto tempu zbývajících ${pendingCount} bude hotovo přibližně za ${etaText}.`;
    } else if (pendingCount > 0) {
        etaSentence = `Zbývá ${pendingCount} příspěvků, zatím bez dostatečné aktivity pro odhad času.`;
    }

    return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inviter — Přehled</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231B2420'/%3E%3Ccircle cx='32' cy='32' r='14' fill='%230E6B5C'/%3E%3Ccircle cx='32' cy='32' r='6' fill='%23EEF1EC'/%3E%3C/svg%3E">
<style>
  :root {
    --ink: #1B2420;
    --paper: #EEF1EC;
    --panel: #FFFFFF;
    --line: #DBE1D8;
    --muted: #667069;
    --accent: #0E6B5C;
    --accent-soft: #E1F0EB;
    --warn: #A15A1A;
    --warn-soft: #FBEEDD;
    --danger: #A6342B;
    --danger-soft: #FBEAE8;
    --ok: #1E7A4C;
    --ok-soft: #E7F4EC;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--paper); color: var(--ink); margin: 0;
    -webkit-text-size-adjust: 100%;
  }
  a { color: var(--accent); text-decoration: none; }
  a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; color: var(--muted); font-weight: 600; }

  header.topbar {
    position: sticky; top: 0; z-index: 20;
    background: rgba(238,241,236,.94); backdrop-filter: blur(6px);
    border-bottom: 1px solid var(--line);
    padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  }
  .topbar h1 { font-size: 16px; font-weight: 700; letter-spacing: -.01em; margin: 0; }
  .status-live { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .pulse-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); position: relative; flex-shrink: 0; }
  .pulse-dot.active { background: var(--accent); }
  .pulse-dot.active::after {
    content: ""; position: absolute; inset: -6px; border-radius: 50%; border: 2px solid var(--accent); opacity: .6;
    animation: pulse-ring 1.8s ease-out infinite;
  }
  @keyframes pulse-ring { 0% { transform: scale(.5); opacity: .7; } 100% { transform: scale(2); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .pulse-dot.active::after { animation: none; } }

  main { max-width: 1000px; margin: 0 auto; padding: 16px; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 16px 0 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
  .card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .card .value { font-size: 22px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .bar-bg { background: var(--line); border-radius: 6px; height: 8px; margin-top: 8px; overflow: hidden; }
  .bar-fill { background: var(--accent); height: 100%; transition: width .4s ease; }

  section { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
  section h2 { font-size: 14px; margin: 0 0 4px; font-weight: 700; }
  .hint { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .empty { color: var(--muted); font-size: 13px; padding: 10px 0; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  .sort-link { color: var(--ink); display: inline-flex; align-items: center; gap: 4px; }
  .sort-link.active { color: var(--accent); }
  .sort-arrow { font-size: 9px; }

  .mono { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; }
  .badge { padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .badge-ok { background: var(--ok-soft); color: var(--ok); }
  .badge-warn { background: var(--warn-soft); color: var(--warn); }
  .badge-danger { background: var(--danger-soft); color: var(--danger); }

  .expand-btn { cursor: pointer; border: none; background: none; font-size: 13px; color: var(--muted); padding: 4px; line-height: 1; }
  .sub-table-wrap { overflow-x: auto; }
  .sub-table-wrap table { min-width: 480px; }

  .pager { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; font-size: 13px; color: var(--muted); flex-wrap: wrap; gap: 8px; }
  .pager a, .pager-disabled { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); font-weight: 600; min-height: 40px; display: inline-flex; align-items: center; }
  .pager a { color: var(--ink); }
  .pager a:hover { border-color: var(--accent); color: var(--accent); }
  .pager-disabled { color: #b9c0b6; }

  .cooldown { background: var(--warn-soft); color: var(--warn); padding: 10px 14px; border-radius: var(--radius); font-size: 13px; margin-bottom: 16px; border: 1px solid #ecd7b8; }

  .story { background: var(--accent-soft); border: 1px solid #c7e2d9; }
  .story h2 { font-size: 13px; color: var(--accent); }
  #story-now { font-size: 16px; font-weight: 600; line-height: 1.4; margin: 4px 0 0; }
  #story-eta { font-size: 13px; color: var(--muted); margin-top: 6px; }
  .activity-list { list-style: none; margin: 10px 0 0; padding: 0; }
  .activity-list li { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
  .activity-list li:first-child { border-top: none; }
  .activity-when { color: var(--muted); flex-shrink: 0; width: 76px; font-variant-numeric: tabular-nums; }
  .activity-what b { font-variant-numeric: tabular-nums; }

  .warn-line { color: var(--danger); font-family: ui-monospace, Consolas, monospace; font-size: 12px; margin: 2px 0; white-space: pre-wrap; word-break: break-all; }

  details.tech summary { cursor: pointer; font-size: 14px; font-weight: 700; list-style: none; display: flex; align-items: center; gap: 8px; }
  details.tech summary::-webkit-details-marker { display: none; }
  details.tech summary::before { content: "▸"; color: var(--muted); font-size: 12px; transition: transform .15s ease; }
  details.tech[open] summary::before { transform: rotate(90deg); }
  #live-log { background: #161B18; color: #D6DBD3; padding: 12px; border-radius: 8px; max-height: 360px; overflow-y: auto; font-size: 12px; line-height: 1.5; margin: 12px 0 0; white-space: pre-wrap; word-break: break-all; }

  #live-shot { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); display: none; }

  footer.sub { color: var(--muted); font-size: 12px; text-align: center; padding: 8px 16px 24px; }

  /* Posts table becomes stacked cards below ~700px so nothing needs
     horizontal scrolling on a phone. */
  @media (max-width: 700px) {
    main { padding: 12px; }
    table.posts thead { display: none; }
    table.posts, table.posts > tbody { display: block; width: 100%; }
    table.posts > tbody > tr.post-row {
      display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 2px 10px;
      border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
    }
    table.posts > tbody > tr.post-row td { border: none; padding: 3px 0; display: block; }
    table.posts td[data-label]::before { content: attr(data-label); color: var(--muted); font-size: 11px; display: block; }
    table.posts > tbody > tr.post-row td:nth-child(1) { grid-row: 1 / 5; grid-column: 1; }
    table.posts > tbody > tr.post-row td:nth-child(2) { grid-column: 2; }
    table.posts > tbody > tr.post-row td:nth-child(3) { grid-column: 3; text-align: right; }
    table.posts > tbody > tr.post-row td:nth-child(4) { grid-column: 2; }
    table.posts > tbody > tr.post-row td:nth-child(5) { grid-column: 3; text-align: right; }
    table.posts > tbody > tr.post-row td:nth-child(6) { grid-column: 2; }
    table.posts > tbody > tr.post-row td:nth-child(7) { grid-column: 3; text-align: right; }
    table.posts > tbody > tr.post-row td:nth-child(8) { grid-column: 2 / 4; margin-top: 4px; }
    table.posts > tbody > tr.detail-row td { display: block; }
  }
</style>
</head>
<body>
  <header class="topbar">
    <h1>Inviter — Přehled</h1>
    <div class="status-live">
      <span id="pulse-dot" class="pulse-dot${data.runActive ? " active" : ""}"></span>
      <span id="status-label">${data.runActive ? "Právě pracuje" : "Čeká na další spuštění"}</span>
    </div>
  </header>

  <main>
    <section class="story">
      <h2>Co se právě děje</h2>
      <p id="story-now">${esc(nowSentence)}</p>
      ${etaSentence ? `<p id="story-eta">${esc(etaSentence)}</p>` : ""}
    </section>

    ${data.recentActivity.length > 0 ? `
    <section>
      <h2>Co se stalo naposledy</h2>
      <div class="hint">Posledních ${data.recentActivity.length} kroků, nejnovější první.</div>
      <ul class="activity-list">
        ${data.recentActivity.map((a) => `
        <li>
          <span class="activity-when">${esc(timeAgo(a.ts))}</span>
          <span class="activity-what">Příspěvek z ${esc(fmtDate(a.postDate))} — ${esc(activityLine(a))}</span>
        </li>`).join("")}
      </ul>
    </section>` : ""}

    <div class="cards">
      <div class="card">
        <div class="label">Dnešní pozvánky</div>
        <div class="value"><span id="stat-budget">${data.rateState.invitesToday} / ${data.rateState.dailyLimit}</span></div>
        <div class="bar-bg"><div id="stat-budget-bar" class="bar-fill" style="width:${budgetPct}%"></div></div>
      </div>
      <div class="card">
        <div class="label">Čeká na zpracování</div>
        <div class="value"><span id="stat-pending">${data.postsByStatus.pending || 0}</span></div>
      </div>
      <div class="card">
        <div class="label">Hotovo</div>
        <div class="value"><span id="stat-done">${data.postsByStatus.done || 0}</span></div>
      </div>
      <div class="card">
        <div class="label">Pozváno celkem</div>
        <div class="value"><span id="stat-total-invited">${data.totalInvitedAllTime}</span></div>
      </div>
      <div class="card">
        <div class="label">Cílové období</div>
        <div class="value" style="font-size:15px;">${esc(fmtDate(data.discoveryRange.from))} – dnes</div>
      </div>
    </div>

    <div id="cooldown-slot">
      ${data.rateState.isCooldown ? `<div class="cooldown">⚠️ Ochranná pauza do ${esc(fmtTime(data.rateState.cooldownUntil))} — chyby po sobě: ${data.rateState.consecutiveErrors}</div>` : ""}
    </div>

    <section>
      <h2>Živý náhled</h2>
      <div class="hint" id="live-shot-status">Co teď nástroj vidí na obrazovce.</div>
      <img id="live-shot" alt="živý náhled prohlížeče" />
      <div id="live-shot-empty" class="empty">Momentálně žádný běh — náhled není k dispozici.</div>
    </section>

    <section id="posts">
      <h2>Příspěvky <span style="color:var(--muted);font-weight:400;">(${data.totalPosts})</span></h2>
      <div class="hint">Klikněte na název sloupce pro seřazení. Šipka ▸ zobrazí historii jednotlivých běhů u příspěvku. ${data.storyCount} Story repostů je skryto (nemají vlastní dialog reakcí, patří pod svůj původní příspěvek).</div>
      ${data.postRows.length === 0 ? '<div class="empty">Zatím nebyly nalezeny žádné příspěvky.</div>' : `
      <table class="posts">
        <thead>
        <tr>
          <th></th>
          <th>${sortLink("date", "Datum")}</th>
          <th>${sortLink("type", "Typ")}</th>
          <th>${sortLink("status", "Stav")}</th>
          <th>${sortLink("invited", "Pozváno")}</th>
          <th>${sortLink("reactions", "Reakce")}</th>
          <th>${sortLink("runs", "Běhy")}</th>
          <th>Odkaz</th>
        </tr>
        </thead>
        <tbody>
        ${pageRows.map((p, i) => `
        <tr class="post-row">
          <td>${p.runs.length > 0 ? `<button class="expand-btn" aria-expanded="false" onclick="toggleRun(this, ${i})" style="font-size:16px;">▸</button>` : ""}</td>
          <td data-label="Datum">${esc(p.date)}</td>
          <td data-label="Typ">${esc(contentTypeLabel(p.contentType))}</td>
          <td data-label="Stav">${statusBadge(p.status)}</td>
          <td data-label="Pozváno">${p.totalInvited}</td>
          <td data-label="Reakce">${p.reactionsCount == null ? "—" : p.reactionsCount}</td>
          <td data-label="Běhy">${p.runs.length}</td>
          <td data-label="Odkaz">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Zobrazit na Facebooku ↗</a>` : "—"}</td>
        </tr>
        <tr class="detail-row" id="detail-${i}" style="display:none;">
          <td colspan="8">
            ${p.runs.length === 0 ? '<span class="empty">Pro tento příspěvek zatím nejsou zaznamenány žádné běhy.</span>' : `
            <div class="sub-table-wrap">
            <table>
              <tr><th>Kdy</th><th>Pozváno</th><th>Rychlost</th><th>Zkušební (bez odeslání)</th><th>Výsledek</th></tr>
              ${p.runs.map((r) => `
              <tr>
                <td>${esc(fmtTime(r.ts))}</td>
                <td>${r.invitedCount || 0}</td>
                <td>${esc(rateModeLabel(r.rateMode))}</td>
                <td>${r.dryRun ? "ano" : "ne"}</td>
                <td>${esc(stopReasonLabel(r.stoppedReason))}</td>
              </tr>`).join("")}
            </table>
            </div>`}
          </td>
        </tr>`).join("")}
        </tbody>
      </table>
      <div class="pager">
        <span>Stránka ${safePage} z ${totalPages} · ${sortedRows.length} příspěvků</span>
        <span style="display:flex;gap:8px;">
          ${safePage > 1 ? `<a href="${pageLink(safePage - 1)}">‹ Předchozí</a>` : '<span class="pager-disabled">‹ Předchozí</span>'}
          ${safePage < totalPages ? `<a href="${pageLink(safePage + 1)}">Další ›</a>` : '<span class="pager-disabled">Další ›</span>'}
        </span>
      </div>`}
    </section>

    ${data.warningsAndErrors.length > 0 ? `
    <section>
      <h2>Nedávná varování a chyby</h2>
      ${data.warningsAndErrors.map((l) => `<div class="warn-line">${esc(l)}</div>`).join("")}
    </section>` : ""}

    <details class="tech">
      <summary>Technický log <span class="eyebrow">pro vývojáře</span></summary>
      <div class="hint" id="live-status" style="margin-top:8px;">Syrový výstup nástroje — užitečné jen při ladění problémů.</div>
      <pre id="live-log">(čekání na data logu…)</pre>
    </details>

    <footer class="sub">Pouze pro čtení · stav se automaticky aktualizuje, stránka se sama nepřekresluje · vygenerováno ${esc(fmtTime(data.generatedAt))}</footer>
  </main>

  <script>
    function toggleRun(btn, i) {
      const row = document.getElementById("detail-" + i);
      const open = row.style.display !== "none";
      row.style.display = open ? "none" : "";
      btn.style.transform = open ? "" : "rotate(90deg)";
      btn.setAttribute("aria-expanded", String(!open));
    }

    // Live status/cards: polled in place every 15s. Replaces the old
    // whole-page auto-refresh (was every 20s), which reloaded the entire
    // page — including your scroll position and table page — even if
    // nothing had changed. Only these small, genuinely-live numbers update
    // now; the posts table stays put until you navigate it yourself.
    async function pollStatus() {
      try {
        const res = await fetch("/api/status");
        const s = await res.json();
        const dot = document.getElementById("pulse-dot");
        dot.className = "pulse-dot" + (s.runActive ? " active" : "");
        document.getElementById("status-label").textContent = s.runActive ? "Právě pracuje" : "Čeká na další spuštění";
        document.getElementById("stat-budget").textContent = s.rateState.invitesToday + " / " + s.rateState.dailyLimit;
        const pct = Math.min(100, Math.round((s.rateState.invitesToday / (s.rateState.dailyLimit || 1)) * 100));
        document.getElementById("stat-budget-bar").style.width = pct + "%";
        document.getElementById("stat-pending").textContent = s.postsByStatus.pending || 0;
        document.getElementById("stat-done").textContent = s.postsByStatus.done || 0;
        document.getElementById("stat-total-invited").textContent = s.totalInvitedAllTime;
      } catch (err) { /* keep last known values on a failed poll */ }
    }
    pollStatus();
    setInterval(pollStatus, 15000);

    // Polls the live log every 3s without reloading the page.
    const logEl = document.getElementById("live-log");
    const statusEl = document.getElementById("live-status");
    async function pollLog() {
      try {
        const res = await fetch("/api/logs");
        const data = await res.json();
        const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
        logEl.textContent = data.lines.length ? data.lines.join("\\n") : "(zatím žádný výstup)";
        if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
        statusEl.textContent = "aktualizováno " + new Date().toLocaleTimeString("cs-CZ");
      } catch (err) {
        statusEl.textContent = "načtení logu selhalo";
      }
    }
    pollLog();
    setInterval(pollLog, 3000);

    // Polls the live screenshot every 2s. Uses a throwaway Image() to
    // pre-load before swapping the visible <img> src, so the panel never
    // flashes a broken-image icon between frames.
    const shotImg = document.getElementById("live-shot");
    const shotEmpty = document.getElementById("live-shot-empty");
    const shotStatus = document.getElementById("live-shot-status");
    function pollShot() {
      const test = new Image();
      test.onload = () => {
        shotImg.src = test.src;
        shotImg.style.display = "block";
        shotEmpty.style.display = "none";
        shotStatus.textContent = "aktualizováno " + new Date().toLocaleTimeString("cs-CZ");
      };
      test.onerror = () => {
        shotImg.style.display = "none";
        shotEmpty.style.display = "";
        shotStatus.textContent = "Co teď nástroj vidí na obrazovce.";
      };
      test.src = "/live-screenshot.jpg?t=" + Date.now();
    }
    pollShot();
    setInterval(pollShot, 2000);
  </script>
</body>
</html>`;
}

// ──────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────

const server = http.createServer((req, res) => {
    if (req.url === "/api/logs") {
        try {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ lines: getLiveLogLines() }));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    if (req.url === "/api/status") {
        try {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(gatherStatus()));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    if (req.url.startsWith("/live-screenshot.jpg")) {
        if (!fs.existsSync(config.liveScreenshotPath)) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        fs.createReadStream(config.liveScreenshotPath).pipe(res);
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "/index.html") {
        res.writeHead(404);
        res.end("Not found");
        return;
    }
    try {
        const data = gatherData();
        const query = Object.fromEntries(parsedUrl.searchParams);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderPage(data, query));
    } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Dashboard error: " + err.message);
    }
});

server.listen(PORT, () => {
    console.log(`Inviter dashboard running at http://localhost:${PORT} (read-only)`);
});

module.exports = { gatherData, gatherStatus, renderPage };
