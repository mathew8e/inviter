#!/usr/bin/env node

// ──────────────────────────────────────────────
// Pre-parse --rate-mode BEFORE requiring config.js
// ──────────────────────────────────────────────
// config.js reads process.env.RATE_MODE once, at require-time, and freezes
// the result. To let `--rate-mode` override RATE_MODE from .env, we need to
// set the env var before anything requires config (directly or indirectly).
(function applyRateModeOverride() {
    const args = process.argv.slice(2);
    const idx = args.indexOf("--rate-mode");
    if (idx !== -1 && args[idx + 1]) {
        process.env.RATE_MODE = args[idx + 1];
    }
})();

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const inviter = require("./inviter");
const storage = require("./storage");
const reactions = require("./reactions");
const config = require("./config");
const logger = require("./logger");

async function main() {
    const argv = yargs(hideBin(process.argv))
        .option("page", {
            type: "string",
            describe: "Facebook Page URL to scan (full workflow: discover posts -> invite reactors)",
        })
        .option("url", {
            type: "string",
            describe: "Single post URL to process (legacy/testing mode, ignored if --page is set)",
        })
        .option("test-selectors", {
            type: "boolean",
            default: false,
            describe:
                'Use TEST_SELECTORS ("Sledovat"/"Follow") instead of INVITE_SELECTORS ("Pozvat"/"Invite"). ' +
                "For safely testing the scroll/invite loop on your own profile posts.",
        })
        .option("dry-run", {
            type: "boolean",
            default: true,
            describe:
                "Scan and log only, never click (SAFE DEFAULT). Pass --no-dry-run to actually send invites.",
        })
        .option("date-from", {
            type: "string",
            default: config.dateFrom,
            describe: 'Process posts from this date (YYYY-MM-DD) or "all"',
        })
        .option("date-to", {
            type: "string",
            default: config.dateTo,
            describe: 'Process posts until this date (YYYY-MM-DD) or "all"',
        })
        .option("max-posts", {
            type: "number",
            default: config.maxPostsPerRun,
            describe: "Maximum number of posts to process this run",
        })
        .option("discover-since", {
            type: "string",
            default: config.discoverSinceDate,
            describe: "Absolute ISO date (YYYY-MM-DD) the Content Library scan reaches back to (older posts are out of scope)",
        })
        .option("rate-mode", {
            type: "string",
            choices: ["paranoid", "moderate", "aggressive"],
            default: config.rateModeName,
            describe: "Rate limit preset (overrides RATE_MODE in .env)",
        })
        .option("profile-dir", {
            type: "string",
            default: config.profileDir,
            describe: "Path to Chrome user profile (userDataDir) to reuse login",
        })
        .option("headless", {
            type: "boolean",
            default: config.headless,
            describe: "Run browser in headless mode",
        })
        .option("wait-for-login", {
            type: "boolean",
            default: false,
            describe:
                "Open the browser VISIBLY so you can log in manually, then press Enter to save the session",
        })
        .check((a) => {
            if (!a["wait-for-login"] && !a.page && !a.url) {
                throw new Error("Must specify --page (full workflow), --url (single post), or --wait-for-login");
            }
            return true;
        })
        .help().argv;

    await storage.init();

    const selectors = argv["test-selectors"] ? reactions.TEST_SELECTORS : reactions.INVITE_SELECTORS;

    try {
        const summary = await inviter.runWithBrowser({
            pageUrl: argv.page,
            url: argv.url,
            profileDir: argv["profile-dir"],
            headless: argv.headless,
            waitForLogin: argv["wait-for-login"],
            dryRun: argv["dry-run"],
            dateFrom: argv["date-from"],
            dateTo: argv["date-to"],
            maxPosts: argv["max-posts"],
            sinceDate: argv["discover-since"],
            selectors,
        });

        if (!argv["wait-for-login"]) {
            logger.info(`Run finished: ${JSON.stringify(summary)}`);
        }
        process.exit(0);
    } catch (err) {
        logger.error("Run failed: " + err.message);
        process.exit(2);
    }
}

main();
