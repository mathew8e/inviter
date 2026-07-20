/**
 * screenshot.js — Saves a PNG snapshot of the page whenever something
 * fails (dialog didn't open, click had no effect, unhandled error) so
 * issues can be diagnosed after the fact without re-running live.
 */

const fs = require("fs");
const path = require("path");
const config = require("./config");
const logger = require("./logger");

/**
 * Takes a screenshot and saves it to config.screenshotsDir.
 * Never throws — a failed screenshot should never crash the run.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} label — short reason, e.g. "dialog-not-opened", "click-error"
 * @returns {Promise<string|null>} the saved file path, or null on failure
 */
async function takeScreenshot(page, label) {
    try {
        if (!fs.existsSync(config.screenshotsDir)) {
            fs.mkdirSync(config.screenshotsDir, { recursive: true });
        }
        const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, "-").slice(0, 60);
        const filePath = path.join(config.screenshotsDir, `${Date.now()}-${safeLabel}.png`);
        await page.screenshot({ path: filePath, fullPage: false });
        logger.info(`Screenshot saved: ${filePath}`);
        return filePath;
    } catch (err) {
        logger.warn(`Failed to take screenshot ("${label}"): ${err.message}`);
        return null;
    }
}

/**
 * Starts a background loop that overwrites a single fixed JPEG file every
 * `config.liveScreenshotIntervalMs` — a cheap near-live view of what the
 * browser is doing, without the cost/complexity of a real video recording.
 * Writes to a temp path then renames into place (atomic on POSIX) so the
 * dashboard never serves a half-written frame.
 *
 * @param {import('puppeteer').Page} page
 * @returns {() => void} stop — call to end the loop (also clears the file)
 */
function startLiveScreenshotLoop(page) {
    const dir = path.dirname(config.liveScreenshotPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = config.liveScreenshotPath + ".tmp";

    let stopped = false;
    let inFlight = false;

    const tick = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
            if (!page.isClosed()) {
                await page.screenshot({ path: tmpPath, type: "jpeg", quality: 50 });
                fs.renameSync(tmpPath, config.liveScreenshotPath);
            }
        } catch (err) {
            // Page navigating/closing mid-shot is expected and frequent —
            // never let this loop crash the run.
        } finally {
            inFlight = false;
        }
    };

    const interval = setInterval(tick, config.liveScreenshotIntervalMs);
    tick();

    return () => {
        stopped = true;
        clearInterval(interval);
        try {
            fs.rmSync(config.liveScreenshotPath, { force: true });
            fs.rmSync(tmpPath, { force: true });
        } catch (err) {
            // Best-effort cleanup only.
        }
    };
}

module.exports = { takeScreenshot, startLiveScreenshotLoop };
