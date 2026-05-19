function getLaunchOptions(profileDir, headless) {
    const opts = {
        headless: headless !== undefined ? headless : true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };
    if (profileDir) opts.userDataDir = profileDir;
    return opts;
}

module.exports = { getLaunchOptions };
