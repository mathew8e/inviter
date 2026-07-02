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

function gatherData() {
    const postList = scraper.loadPostList();
    const posts = postList.posts || [];
    const history = storage.getHistory();
    const rateState = rateLimiter.getState();
    const recentLogLines = getRecentLogLines(200);
    const warningsAndErrors = getWarningsAndErrors(recentLogLines).slice(0, 40);

    const postsByStatus = { pending: 0, done: 0, error: 0 };
    for (const p of posts) {
        postsByStatus[p.status] = (postsByStatus[p.status] || 0) + 1;
    }
    const reelCount = posts.filter((p) => p.contentType === "reel").length;
    const postCount = posts.filter((p) => p.contentType !== "reel").length;

    const totalInvitedAllTime = history.reduce((sum, h) => sum + (h.invitedCount || 0), 0);

    return {
        runActive: isRunActive(),
        rateState,
        postsByStatus,
        reelCount,
        postCount,
        totalPosts: posts.length,
        posts: posts.slice().sort((a, b) => (b.processedAt || 0) - (a.processedAt || 0)).slice(0, 30),
        recentHistory: history.slice(-15).reverse(),
        totalInvitedAllTime,
        warningsAndErrors,
        scrapedAt: postList.scrapedAt,
        generatedAt: Date.now(),
    };
}

// ──────────────────────────────────────────────
// HTML rendering
// ──────────────────────────────────────────────

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString();
}

function statusBadge(status) {
    const colors = { done: "#2e7d32", pending: "#e6a700", error: "#c62828" };
    const color = colors[status] || "#666";
    return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;">${esc(status)}</span>`;
}

function renderPage(data) {
    const budgetPct = Math.min(
        100,
        Math.round((data.rateState.invitesToday / (data.rateState.dailyLimit || 1)) * 100),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="20">
<title>Inviter Dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f5f7; color: #1c1c1c; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.1); min-width: 180px; }
  .card .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: .05em; }
  .card .value { font-size: 26px; font-weight: 600; margin-top: 4px; }
  .bar-bg { background: #e0e0e0; border-radius: 6px; height: 10px; margin-top: 8px; overflow: hidden; }
  .bar-fill { background: #1a73e8; height: 100%; }
  section { background: #fff; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  section h2 { font-size: 15px; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
  th { color: #666; font-weight: 500; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .warn-line { color: #c62828; font-family: ui-monospace, Consolas, monospace; font-size: 12px; margin: 2px 0; white-space: pre-wrap; word-break: break-all; }
  .badge-running { background:#1a73e8; color:#fff; padding:3px 10px; border-radius:10px; font-size:12px; }
  .badge-idle { background:#666; color:#fff; padding:3px 10px; border-radius:10px; font-size:12px; }
  .cooldown { background:#fff3cd; color:#856404; padding:8px 12px; border-radius:6px; font-size:13px; margin-bottom:12px; }
  .empty { color: #999; font-size: 13px; padding: 8px 0; }
  a { color: #1a73e8; text-decoration: none; }
</style>
</head>
<body>
  <h1>Inviter Dashboard</h1>
  <div class="sub">Read-only status view. Auto-refreshes every 20s. Generated ${esc(fmtTime(data.generatedAt))}</div>

  <div class="cards">
    <div class="card">
      <div class="label">Run status</div>
      <div class="value">${data.runActive ? '<span class="badge-running">RUNNING</span>' : '<span class="badge-idle">idle</span>'}</div>
    </div>
    <div class="card">
      <div class="label">Today's budget</div>
      <div class="value">${data.rateState.invitesToday} / ${data.rateState.dailyLimit}</div>
      <div class="bar-bg"><div class="bar-fill" style="width:${budgetPct}%"></div></div>
    </div>
    <div class="card">
      <div class="label">Posts pending</div>
      <div class="value">${data.postsByStatus.pending || 0}</div>
    </div>
    <div class="card">
      <div class="label">Posts done</div>
      <div class="value">${data.postsByStatus.done || 0}</div>
    </div>
    <div class="card">
      <div class="label">Total invited (all time)</div>
      <div class="value">${data.totalInvitedAllTime}</div>
    </div>
  </div>

  ${data.rateState.isCooldown ? `<div class="cooldown">⚠️ In cooldown until ${esc(fmtTime(data.rateState.cooldownUntil))} — consecutive errors: ${data.rateState.consecutiveErrors}</div>` : ""}

  <section>
    <h2>Recent posts (${data.totalPosts} total — ${data.postCount} posts, ${data.reelCount} reels)</h2>
    ${data.posts.length === 0 ? '<div class="empty">No posts discovered yet.</div>' : `
    <table>
      <tr><th>Date</th><th>Type</th><th>Status</th><th>Invited</th><th>Processed</th><th>Error</th><th>Link</th></tr>
      ${data.posts.map((p) => `
      <tr>
        <td>${esc(p.date)}</td>
        <td>${esc(p.contentType || "post")}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${p.invitedCount || 0}</td>
        <td>${esc(fmtTime(p.processedAt))}</td>
        <td class="mono">${p.error ? esc(p.error) : "—"}</td>
        <td>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">View</a>` : "—"}</td>
      </tr>`).join("")}
    </table>`}
  </section>

  <section>
    <h2>Recent invite history</h2>
    ${data.recentHistory.length === 0 ? '<div class="empty">No invites sent yet.</div>' : `
    <table>
      <tr><th>Date</th><th>Invited</th><th>Rate mode</th><th>Dry run</th><th>Stopped reason</th><th>Link</th></tr>
      ${data.recentHistory.map((h) => `
      <tr>
        <td>${esc(h.date)}</td>
        <td>${h.invitedCount || 0}</td>
        <td>${esc(h.rateMode || "—")}</td>
        <td>${h.dryRun ? "yes" : "no"}</td>
        <td>${esc(h.stoppedReason || "—")}</td>
        <td>${h.postUrl ? `<a href="${esc(h.postUrl)}" target="_blank" rel="noopener">View</a>` : "—"}</td>
      </tr>`).join("")}
    </table>`}
  </section>

  <section>
    <h2>Recent warnings / errors</h2>
    ${data.warningsAndErrors.length === 0 ? '<div class="empty">None in the most recent log file.</div>' :
      data.warningsAndErrors.map((l) => `<div class="warn-line">${esc(l)}</div>`).join("")}
  </section>

  <section>
    <h2>Live log <span id="live-status" style="font-weight:normal;color:#999;font-size:12px;"></span></h2>
    <pre id="live-log" style="background:#1c1c1c;color:#d4d4d4;padding:12px;border-radius:6px;max-height:400px;overflow-y:auto;font-size:12px;line-height:1.5;margin:0;white-space:pre-wrap;word-break:break-all;">(waiting for log data…)</pre>
  </section>

  <script>
    // Polls the live log every 3s without reloading the whole page, so the
    // log panel updates smoothly while a run is in progress. The rest of
    // the page still refreshes via the meta tag every 20s.
    const logEl = document.getElementById("live-log");
    const statusEl = document.getElementById("live-status");
    async function pollLog() {
      try {
        const res = await fetch("/api/logs");
        const data = await res.json();
        const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
        logEl.textContent = data.lines.length ? data.lines.join("\\n") : "(no log output yet)";
        if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
        statusEl.textContent = "updated " + new Date().toLocaleTimeString();
      } catch (err) {
        statusEl.textContent = "log fetch failed";
      }
    }
    pollLog();
    setInterval(pollLog, 3000);
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

    if (req.url !== "/" && req.url !== "/index.html") {
        res.writeHead(404);
        res.end("Not found");
        return;
    }
    try {
        const data = gatherData();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderPage(data));
    } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Dashboard error: " + err.message);
    }
});

server.listen(PORT, () => {
    console.log(`Inviter dashboard running at http://localhost:${PORT} (read-only)`);
});

module.exports = { gatherData, renderPage };
