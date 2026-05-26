#!/usr/bin/env node
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const inviter = require("./inviter");
const storage = require("./storage");
const logger = require("./logger");

async function main() {
    const argv = yargs(hideBin(process.argv))
        .option("url", {
            type: "string",
            demandOption: true,
            describe: "Post URL to scan",
        })
        .option("max", {
            type: "number",
            default: 10,
            describe: "Maximum number of follows/invites",
        })
        .option("delay", {
            type: "number",
            default: 1000,
            describe: "Base delay between actions (ms)",
        })
        .option("profile-dir", {
            type: "string",
            describe:
                "Path to Chrome user profile (userDataDir) to reuse login",
        })
        .option("headless", {
            type: "boolean",
            default: true,
            describe: "Run browser in headless mode",
        })
        .option("wait-for-login", {
            type: "boolean",
            default: false,
            describe:
                "Open the browser, pause for manual login, and exit when Enter is pressed",
        })
        .option("count-follow", {
            type: "boolean",
            default: false,
            describe:
                "Only count clickable 'Follow' buttons on the reactions list",
        })
        .option("invite-follow", {
            type: "boolean",
            default: false,
            describe:
                "Click clickable 'Follow' / 'Sledovat' buttons on the reactions list",
        })
        .help().argv;

    await storage.init();

    try {
        const count = await inviter.runWithBrowser({
            url: argv.url,
            max: argv.max,
            delay: argv.delay,
            profileDir: argv["profile-dir"],
            headless: argv.headless,
            waitForLogin: argv["wait-for-login"],
            countFollow: argv["count-follow"],
            inviteFollow: argv["invite-follow"],
        });
        logger.info(`Run finished. total actions: ${count}`);
        process.exit(0);
    } catch (err) {
        logger.error("Run failed: " + err.message);
        process.exit(2);
    }
}

main();
