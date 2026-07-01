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

module.exports = { takeScreenshot };
