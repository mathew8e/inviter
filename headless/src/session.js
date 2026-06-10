const fs = require("fs");
const path = require("path");

function findCachedLinuxChrome() {
    const home = process.env.HOME;
    if (!home) return undefined;

    const chromeRoot = path.join(home, ".cache", "puppeteer", "chrome");
    if (!fs.existsSync(chromeRoot)) return undefined;

    const candidates = fs
        .readdirSync(chromeRoot, { withFileTypes: true })
        .filter(
            (entry) => entry.isDirectory() && entry.name.startsWith("linux-"),
        )
        .map((entry) =>
            path.join(chromeRoot, entry.name, "chrome-linux64", "chrome"),
        )
        .filter((candidatePath) => fs.existsSync(candidatePath));

    return candidates.sort().at(-1);
}

function getLaunchOptions(profileDir, headless) {
    const opts = {
        headless: headless !== undefined ? headless : true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu",
            "--no-first-run",
            "--disable-background-networking",
            "--disable-default-apps",
            "--disable-sync",
            "--disable-device-discovery-notifications",
            "--disable-blink-features=AutomationControlled",
            "--force-color-profile=srgb",
            "--disable-extensions",
            "--disable-default-apps",
            "--mute-audio",
            "--metrics-recording-only",
            "--disable-client-side-phishing-detection",
            "--enable-features=NetworkService,NetworkServiceInProcess",
            "--disable-features=InterestFeedContentSuggestions",
        ],
        protocolTimeout: Number.parseInt(
            process.env.PUPPETEER_PROTOCOL_TIMEOUT || "300000",
            10,
        ),
    };

    if (profileDir) opts.userDataDir = profileDir;

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        return opts;
    }

    const linuxChrome = findCachedLinuxChrome();
    if (linuxChrome) opts.executablePath = linuxChrome;

    return opts;
}

module.exports = { getLaunchOptions };
