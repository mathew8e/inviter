const winston = require("winston");
const path = require("path");
const fs = require("fs");

// Always write to logs/latest.log too, in addition to the console — this
// gives the dashboard a live log to tail regardless of whether the run was
// started manually or via cron (cron's own >> redirect writes a separate
// dated file for historical record-keeping; this one is just for "what is
// happening right now").
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const logger = winston.createLogger({
    level: "info",
    format: winston.format.simple(),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: path.join(LOGS_DIR, "latest.log"),
            maxsize: 5 * 1024 * 1024, // 5MB cap, avoid unbounded growth on constrained hardware
            maxFiles: 1,
        }),
    ],
});

module.exports = logger;
