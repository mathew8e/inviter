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
    // log). Also makes the invited-count bug (posts.json going stale after
    // a --url mode run) moot — the total here is summed directly from the
    // history log, which is always accurate.
    const historyByUrl = new Map();
    for (const h of history) {
        if (!historyByUrl.has(h.postUrl)) historyByUrl.set(h.postUrl, []);
        historyByUrl.get(h.postUrl).push(h);
    }

    const postRows = posts.map((p) => {
        const runs = (historyByUrl.get(p.url) || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const totalInvited = runs.reduce((sum, r) => sum + (r.invitedCount || 0), 0);
        return { ...p, runs, totalInvited };
    });
    postRows.sort((a, b) => (b.processedAt || 0) - (a.processedAt || 0));

    const postsByStatus = { pending: 0, done: 0, error: 0 };
    for (const p of posts) {
        postsByStatus[p.status] = (postsByStatus[p.status] || 0) + 1;
    }
    const storyCount = allPosts.filter((p) => p.contentType === "story").length;

    const totalInvitedAllTime = history.reduce((sum, h) => sum + (h.invitedCount || 0), 0);

    return {
        runActive: isRunActive(),
        rateState,
        postsByStatus,
        storyCount,
        totalPosts: posts.length,
        // Was capped at the 30 most-recently-processed posts — user wants
        // the full history visible, not just recent activity (2026-07-20).
        postRows,
        totalInvitedAllTime,
        warningsAndErrors,
        scrapedAt: postList.scrapedAt,
        generatedAt: Date.now(),
        discoveryRange: getDiscoveryRange(),
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
    return new Date(ts).toLocaleString("cs-CZ");
}

function fmtDate(isoDate) {
    if (!isoDate) return "—";
    return new Date(isoDate + "T00:00:00").toLocaleDateString("cs-CZ");
}

const STATUS_LABELS_CZ = { done: "hotovo", pending: "čeká", error: "chyba" };

function statusBadge(status) {
    const colors = { done: "#2e7d32", pending: "#e6a700", error: "#c62828" };
    const color = colors[status] || "#666";
    const label = STATUS_LABELS_CZ[status] || status;
    return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;">${esc(label)}</span>`;
}

function contentTypeLabel(contentType) {
    return contentType === "story" ? "Story" : "Příspěvek";
}

function renderPage(data) {
    const budgetPct = Math.min(
        100,
        Math.round((data.rateState.invitesToday / (data.rateState.dailyLimit || 1)) * 100),
    );

    return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="20">
<title>Inviter — Přehled</title>
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
  <h1>Inviter — Přehled</h1>
  <div class="sub">Pouze pro čtení. Automatická aktualizace každých 20 s. Vygenerováno ${esc(fmtTime(data.generatedAt))}</div>

  <div class="cards">
    <div class="card">
      <div class="label">Stav běhu</div>
      <div class="value">${data.runActive ? '<span class="badge-running">BĚŽÍ</span>' : '<span class="badge-idle">nečinný</span>'}</div>
    </div>
    <div class="card">
      <div class="label">Sledované období</div>
      <div class="value" style="font-size:16px;">${esc(fmtDate(data.discoveryRange.from))} – ${esc(fmtDate(data.discoveryRange.to))}</div>
    </div>
    <div class="card">
      <div class="label">Dnešní limit pozvánek</div>
      <div class="value">${data.rateState.invitesToday} / ${data.rateState.dailyLimit}</div>
      <div class="bar-bg"><div class="bar-fill" style="width:${budgetPct}%"></div></div>
    </div>
    <div class="card">
      <div class="label">Čekající příspěvky</div>
      <div class="value">${data.postsByStatus.pending || 0}</div>
    </div>
    <div class="card">
      <div class="label">Dokončené příspěvky</div>
      <div class="value">${data.postsByStatus.done || 0}</div>
    </div>
    <div class="card">
      <div class="label">Celkem pozváno (od začátku)</div>
      <div class="value">${data.totalInvitedAllTime}</div>
    </div>
  </div>

  ${data.rateState.isCooldown ? `<div class="cooldown">⚠️ Ochranná pauza do ${esc(fmtTime(data.rateState.cooldownUntil))} — chyby po sobě: ${data.rateState.consecutiveErrors}</div>` : ""}

  <section>
    <h2>Živý náhled <span id="live-shot-status" style="font-weight:normal;color:#999;font-size:12px;"></span></h2>
    <img id="live-shot" alt="live screenshot" style="max-width:100%;border-radius:6px;border:1px solid #eee;display:none;" />
    <div id="live-shot-empty" class="empty">Momentálně žádný běh — náhled není k dispozici.</div>
  </section>

  <section>
    <h2>Příspěvky (zobrazeno ${data.totalPosts} — ${data.storyCount} Story repostů skryto, nemají dialog reakcí)</h2>
    ${data.postRows.length === 0 ? '<div class="empty">Zatím nebyly nalezeny žádné příspěvky.</div>' : `
    <table>
      <tr><th></th><th>Datum</th><th>Typ</th><th>Stav</th><th>Pozváno celkem</th><th>Běhy</th><th>Odkaz</th></tr>
      ${data.postRows.map((p) => `
      <tr>
        <td>${p.runs.length > 0 ? `<button onclick="this.closest('tr').nextElementSibling.style.display = this.closest('tr').nextElementSibling.style.display === 'none' ? '' : 'none';" style="cursor:pointer;border:none;background:none;font-size:14px;">▸</button>` : ""}</td>
        <td>${esc(p.date)}</td>
        <td>${esc(contentTypeLabel(p.contentType))}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${p.totalInvited}</td>
        <td>${p.runs.length}</td>
        <td>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Zobrazit</a>` : "—"}</td>
      </tr>
      <tr style="display:none;">
        <td></td>
        <td colspan="6">
          ${p.runs.length === 0 ? '<span class="empty">Pro tento příspěvek zatím nejsou zaznamenány žádné běhy.</span>' : `
          <table>
            <tr><th>Kdy</th><th>Pozváno</th><th>Režim</th><th>Zkušební běh</th><th>Důvod ukončení</th></tr>
            ${p.runs.map((r) => `
            <tr>
              <td>${esc(fmtTime(r.ts))}</td>
              <td>${r.invitedCount || 0}</td>
              <td>${esc(r.rateMode || "—")}</td>
              <td>${r.dryRun ? "ano" : "ne"}</td>
              <td>${esc(r.stoppedReason || "—")}</td>
            </tr>`).join("")}
          </table>`}
        </td>
      </tr>`).join("")}
    </table>`}
  </section>

  <section>
    <h2>Nedávná varování / chyby</h2>
    ${data.warningsAndErrors.length === 0 ? '<div class="empty">V posledním logu žádné nejsou.</div>' :
      data.warningsAndErrors.map((l) => `<div class="warn-line">${esc(l)}</div>`).join("")}
  </section>

  <section>
    <h2>Živý log <span id="live-status" style="font-weight:normal;color:#999;font-size:12px;"></span></h2>
    <pre id="live-log" style="background:#1c1c1c;color:#d4d4d4;padding:12px;border-radius:6px;max-height:400px;overflow-y:auto;font-size:12px;line-height:1.5;margin:0;white-space:pre-wrap;word-break:break-all;">(čekání na data logu…)</pre>
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
        shotImg.style.display = "";
        shotEmpty.style.display = "none";
        shotStatus.textContent = "aktualizováno " + new Date().toLocaleTimeString("cs-CZ");
      };
      test.onerror = () => {
        shotImg.style.display = "none";
        shotEmpty.style.display = "";
        shotStatus.textContent = "";
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
