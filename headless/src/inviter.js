const puppeteer = require("puppeteer");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const logger = require("./logger");
const storage = require("./storage");
const session = require("./session");
const fs = require("fs");
const path = require("path");

const DEFAULT_SELECTORS = [
    'div[aria-label="Follow"][role="button"]',
    'div[aria-label="Sledovat"][role="button"]',
    'div[aria-label="Pozvat"][role="button"]',
    'div[aria-label="Add friend"][role="button"]',
    'button[aria-label="Follow"]',
    'button[aria-label="Sledovat"]',
    'button[aria-label="Pozvat"]',
    'button[aria-label="Add friend"]',
    'a[role="button"][aria-label*="Follow"]',
    'a[role="button"][aria-label*="Sledovat"]',
    'a[role="button"][aria-label*="Add friend"]',
];

function formatLaunchOptions(launchOptions) {
    const summary = { ...launchOptions };
    if (summary.executablePath) {
        summary.executablePath = summary.executablePath;
    }
    if (summary.args) {
        summary.args = [...summary.args];
    }
    return summary;
}

async function runWithBrowser({
    url,
    max = 1000,
    delay = 1000,
    profileDir,
    headless = true,
    waitForLogin = false,
    countFollow = false,
    inviteFollow = false,
}) {
    const launchOptions = session.getLaunchOptions(profileDir, headless);
    logger.info(
        `Launching browser with options: ${JSON.stringify(formatLaunchOptions(launchOptions))}`,
    );
    const browser = await puppeteer.launch(launchOptions);
    let count = 0;
    try {
        const page = await browser.newPage();
        logger.info(
            `Opened new page in browser version: ${await browser.version()}`,
        );
        await page.setUserAgent(
            process.env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64)",
        );
        logger.info(`Navigating to ${url}`);
        const response = await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 60000,
        });
        logger.info(
            `Navigation finished: status=${response ? response.status() : "n/a"}, finalUrl=${page.url()}`,
        );

        const title = await page.title().catch(() => "n/a");
        logger.info(`Page title: ${title}`);

        if (waitForLogin) {
            logger.info(
                "Browser is open for manual login. Press Enter here after you finish logging in.",
            );
            const rl = readline.createInterface({
                input: stdin,
                output: stdout,
            });
            await rl.question("");
            rl.close();
            logger.info(
                "Login pause finished. Exiting without running automation.",
            );
            return 0;
        }

        // Give page some time to render dynamic content
        await page.waitForTimeout(2000);

        if (countFollow || inviteFollow) {
            logger.info(
                inviteFollow
                    ? "Running invite-follow mode: will click reactions opener and click Follow / Add friend buttons."
                    : "Running count-follow mode: will click reactions opener and count Follow buttons.",
            );

            // Try clicking the 'All reactions' opener or toolbar that reveals people who reacted
            const openerClicked = await page.evaluate(() => {
                function tryClick(el) {
                    try {
                        el.scrollIntoView({
                            block: "center",
                            inline: "center",
                        });
                        el.click();
                        return true;
                    } catch (e) {
                        return false;
                    }
                }

                // 1) Prefer exact 'All reactions' opener (role=button with that visible text)
                try {
                    const roleButtons = Array.from(
                        document.querySelectorAll('[role="button"]'),
                    );
                    const exactAll = roleButtons.find((b) => {
                        const txt = (b.innerText || "")
                            .replace(/\s+/g, " ")
                            .trim();
                        return (
                            /^all reactions[:\s]?/i.test(txt) ||
                            /\ball reactions\b/i.test(txt)
                        );
                    });
                    if (exactAll && tryClick(exactAll)) return true;
                } catch (e) {
                    // ignore
                }

                // 2) Prefer toolbar element with aria-label 'See who reacted' (handle localisation)
                const toolbar = document.querySelector(
                    '[role="toolbar"][aria-label]',
                );
                if (
                    toolbar &&
                    /see who reacted|see who reacted to this|who reacted|reakce|reagoval|podívejte se|people|lidé/i.test(
                        toolbar.getAttribute("aria-label") || "",
                    )
                ) {
                    const btn =
                        toolbar.closest('[role="button"]') ||
                        toolbar.parentElement?.querySelector(
                            '[role="button"]',
                        ) ||
                        toolbar.querySelector('[role="button"]') ||
                        toolbar;
                    if (btn && tryClick(btn)) return true;
                }

                // 2) Find any visible element with text 'All reactions' or localized variants
                const candidates = Array.from(
                    document.querySelectorAll('[role="button"], div, span'),
                );
                for (const c of candidates) {
                    const txt = (c.innerText || "").replace(/\s+/g, " ").trim();
                    if (
                        /all reactions/i.test(txt) ||
                        /see who reacted/i.test(txt) ||
                        /reakce/i.test(txt) ||
                        /podívejte se/i.test(txt) ||
                        /zareagoval/i.test(txt) ||
                        /\bpeople\b/i.test(txt) ||
                        /\blidé\b/i.test(txt)
                    ) {
                        if (tryClick(c)) return true;
                        const btn = c.closest('[role="button"]');
                        if (btn && tryClick(btn)) return true;
                    }
                }

                // 3) Try any element that has numeric count + the phrase 'others' nearby
                for (const c of candidates) {
                    const txt = (c.innerText || "").replace(/\s+/g, " ").trim();
                    if (
                        /\d+ others|\d+ people|others/i.test(txt) &&
                        txt.length < 200
                    ) {
                        const btn = c.closest('[role="button"]') || c;
                        if (btn && tryClick(btn)) return true;
                    }
                }

                return false;
            });

            logger.info(`Reactions opener clicked: ${openerClicked}`);

            if (!openerClicked) {
                try {
                    // Dump page HTML for debugging
                    const html = await page.content();
                    const dumpDir = path.join(process.cwd(), "data");
                    if (!fs.existsSync(dumpDir))
                        fs.mkdirSync(dumpDir, { recursive: true });
                    const dumpPath = path.join(
                        dumpDir,
                        `page-debug-${Date.now()}.html`,
                    );
                    fs.writeFileSync(dumpPath, html, "utf8");
                    logger.info(`Wrote page HTML to ${dumpPath}`);

                    // Try to locate the opener element by visible text and return its outerHTML and an XPath
                    const openerInfo = await page.evaluate(() => {
                        function getXPathForElement(el) {
                            if (!el) return null;
                            if (el.id) return `//*[@id="${el.id}"]`;
                            const parts = [];
                            while (el && el.nodeType === 1) {
                                let nb = 0;
                                let sib = el.previousSibling;
                                while (sib) {
                                    if (
                                        sib.nodeType === 1 &&
                                        sib.nodeName === el.nodeName
                                    )
                                        nb++;
                                    sib = sib.previousSibling;
                                }
                                parts.unshift(
                                    el.nodeName.toLowerCase() +
                                        "[" +
                                        (nb + 1) +
                                        "]",
                                );
                                el = el.parentNode;
                            }
                            return "/" + parts.join("/");
                        }

                        const candidates = Array.from(
                            document.querySelectorAll(
                                '[role="button"], div, span',
                            ),
                        );
                        for (const c of candidates) {
                            const txt = (c.innerText || "")
                                .replace(/\s+/g, " ")
                                .trim();
                            if (
                                /all reactions/i.test(txt) ||
                                /see who reacted/i.test(txt) ||
                                /others$/i.test(txt)
                            ) {
                                return {
                                    outerHTML: c.outerHTML,
                                    xpath: getXPathForElement(c),
                                };
                            }
                        }
                        return null;
                    });

                    if (openerInfo) {
                        logger.info(
                            `Found opener candidate via text. xpath=${openerInfo.xpath}`,
                        );
                        // log a trimmed outerHTML sample
                        const sample = (openerInfo.outerHTML || "").slice(
                            0,
                            2000,
                        );
                        logger.info(`Opener outerHTML sample: ${sample}`);

                        // Try to click by XPath
                        if (openerInfo.xpath) {
                            const handles = await page.$x(openerInfo.xpath);
                            if (handles && handles.length > 0) {
                                try {
                                    await handles[0].evaluate((el) =>
                                        el.scrollIntoView({
                                            block: "center",
                                            inline: "center",
                                        }),
                                    );
                                    await handles[0].click();
                                    logger.info(
                                        "Clicked opener via XPath retry",
                                    );
                                    // allow rendering
                                    await page.waitForTimeout(800);
                                } catch (e) {
                                    logger.info(
                                        "XPath click attempt failed: " +
                                            (e && e.message),
                                    );
                                }
                            } else {
                                logger.info(
                                    "No element handle found for computed XPath",
                                );
                            }
                        }
                    } else {
                        logger.info(
                            "No opener candidate found by text heuristics",
                        );

                        // Dump candidate buttons for debugging: text, aria, classes, outerHTML
                        try {
                            const candidates = await page.evaluate(() => {
                                const nodes = Array.from(
                                    document.querySelectorAll(
                                        '[role="button"], button, a',
                                    ),
                                );
                                return nodes.slice(0, 400).map((n) => {
                                    const txt = (n.innerText || "")
                                        .replace(/\s+/g, " ")
                                        .trim();
                                    return {
                                        text: txt.slice(0, 400),
                                        aria:
                                            (n.getAttribute &&
                                                n.getAttribute("aria-label")) ||
                                            "",
                                        role:
                                            (n.getAttribute &&
                                                n.getAttribute("role")) ||
                                            "",
                                        classes: (n.className || "")
                                            .toString()
                                            .slice(0, 300),
                                        outerHTML: (n.outerHTML || "").slice(
                                            0,
                                            2000,
                                        ),
                                    };
                                });
                            });
                            const candPath = path.join(
                                process.cwd(),
                                "data",
                                `button-candidates-${Date.now()}.json`,
                            );
                            fs.writeFileSync(
                                candPath,
                                JSON.stringify(candidates, null, 2),
                                "utf8",
                            );
                            logger.info(
                                `Wrote ${candidates.length} button candidates to ${candPath}`,
                            );
                        } catch (e) {
                            logger.error(
                                "Failed to dump button candidates: " +
                                    (e && e.message),
                            );
                        }
                    }
                } catch (e) {
                    logger.error(
                        "Error during debug dump/opener probe: " +
                            (e && e.message),
                    );
                }
            }

            // Wait for the overlay/dialog to appear; attempt a few heuristics
            try {
                await page.waitForTimeout(1200);
                // wait for possible dialog or list to render
                await Promise.race([
                    page
                        .waitForSelector('[role="dialog"]', { timeout: 3000 })
                        .catch(() => {}),
                    page
                        .waitForSelector('[role="list"]', { timeout: 3000 })
                        .catch(() => {}),
                ]);
            } catch (e) {
                // ignore
            }

            // attempt to scroll the dialog or page to load more people
            await page.evaluate(async () => {
                // find a scrollable container within any dialog
                function findScrollable() {
                    const followSelectors = [
                        'button[aria-label="Follow"]',
                        'button[aria-label="Sledovat"]',
                        'div[role="button"][aria-label*="Follow"]',
                        'div[role="button"][aria-label*="Sledovat"]',
                        '[role="button"][aria-label*="Follow"]',
                        '[role="button"][aria-label*="Sledovat"]',
                        '[aria-label="Follow"]',
                        '[aria-label="Sledovat"]',
                    ];

                    const dialogs = Array.from(
                        document.querySelectorAll('[role="dialog"]'),
                    );

                    // Helper: count follow-like descendants
                    function countFollows(el) {
                        try {
                            let count = 0;
                            for (const sel of followSelectors) {
                                count += (el.querySelectorAll(sel) || [])
                                    .length;
                            }
                            return count;
                        } catch (e) {
                            return 0;
                        }
                    }

                    // Prefer a descendant inside the dialog that actually contains Follow buttons
                    for (const d of dialogs) {
                        // look for elements that explicitly contain follow buttons
                        const candidates = Array.from(
                            d.querySelectorAll("*") || [],
                        );
                        let best = null;
                        let bestCount = 0;
                        for (const c of candidates) {
                            const cnt = countFollows(c);
                            if (cnt > 0) {
                                // prefer elements that are scrollable or have overflow
                                const style = window.getComputedStyle(c) || {};
                                const overflowY = (
                                    style.overflowY || ""
                                ).toLowerCase();
                                const scrollable =
                                    overflowY === "auto" ||
                                    overflowY === "scroll" ||
                                    c.scrollHeight > c.clientHeight;
                                if (scrollable) return c;
                                if (cnt > bestCount) {
                                    best = c;
                                    bestCount = cnt;
                                }
                            }
                        }

                        // If we found a non-scrollable container with many follow buttons, pick that
                        if (best) return best;

                        // fallback: if dialog itself is scrollable, use it
                        if (d.scrollHeight > d.clientHeight) return d;
                    }

                    // fallback: look for any large container on the page
                    const pageCandidates = Array.from(
                        document.querySelectorAll("div"),
                    );
                    for (const c of pageCandidates) {
                        const style = window.getComputedStyle(c) || {};
                        const overflowY = (style.overflowY || "").toLowerCase();
                        if (
                            (overflowY === "auto" || overflowY === "scroll") &&
                            c.clientHeight > 100
                        )
                            return c;
                        if (
                            c.scrollHeight > c.clientHeight &&
                            c.clientHeight > 200
                        )
                            return c;
                    }

                    return (
                        document.scrollingElement ||
                        document.documentElement ||
                        document.body
                    );
                }

                const container = findScrollable();
                const total = Math.max(container.scrollHeight || 1000, 1000);
                const step = Math.floor(total / 6) || 400;
                for (let i = 0; i < 10; i++) {
                    try {
                        container.scrollBy({ top: step, behavior: "smooth" });
                    } catch (e) {
                        try {
                            container.scrollTop = container.scrollTop + step;
                        } catch (e) {}
                    }
                    await new Promise((r) => setTimeout(r, 450));
                }
            });

            if (inviteFollow && !countFollow) {
                const inviteResult = await page.evaluate(
                    async ({ maxInvites, delayMs, noNewButtonsLimit }) => {
                        const targetLabels = [
                            "sledovat",
                            "follow",
                            "pozvat",
                            "invite",
                            "add friend",
                            "přidat přítele",
                            "přidat do přátel",
                        ];

                        const selectors = [
                            "button[aria-label]",
                            'div[role="button"][aria-label]',
                            '[role="button"][aria-label]',
                            "[aria-label]",
                            "button",
                            'div[role="button"]',
                            'a[role="button"]',
                        ];

                        function sleep(ms) {
                            return new Promise((resolve) =>
                                setTimeout(resolve, ms),
                            );
                        }

                        function isVisible(el) {
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            if (
                                style &&
                                (style.visibility === "hidden" ||
                                    style.display === "none")
                            ) {
                                return false;
                            }
                            const rect = el.getBoundingClientRect();
                            return rect.width > 2 && rect.height > 2;
                        }

                        function normalize(value) {
                            return (value || "")
                                .replace(/\s+/g, " ")
                                .trim()
                                .toLowerCase();
                        }

                        function matchesTarget(el) {
                            const aria = normalize(
                                el.getAttribute("aria-label"),
                            );
                            const txt = normalize(
                                el.innerText || el.textContent || "",
                            );
                            return targetLabels.some(
                                (label) =>
                                    aria === label ||
                                    txt === label ||
                                    aria.includes(label) ||
                                    txt.includes(label),
                            );
                        }

                        function findName(node) {
                            try {
                                let current = node;
                                while (current) {
                                    const anchor =
                                        current.querySelector &&
                                        current.querySelector("a");
                                    if (anchor) {
                                        const text = normalize(
                                            anchor.innerText ||
                                                anchor.textContent ||
                                                "",
                                        );
                                        if (
                                            text &&
                                            text.length > 1 &&
                                            text.length < 120
                                        ) {
                                            return text;
                                        }
                                        const aria =
                                            anchor.getAttribute &&
                                            anchor.getAttribute("aria-label");
                                        if (aria) {
                                            const match = aria.match(
                                                /Profile picture of\s+(.+)/i,
                                            );
                                            if (match && match[1]) {
                                                return match[1].trim();
                                            }
                                        }
                                    }
                                    current = current.parentElement;
                                }
                            } catch (e) {}
                            return "";
                        }

                        function findScrollable() {
                            const dialogs = Array.from(
                                document.querySelectorAll('[role="dialog"]'),
                            );

                            for (const dialog of dialogs) {
                                const candidates = Array.from(
                                    dialog.querySelectorAll("*"),
                                );
                                let best = null;
                                let bestCount = 0;

                                for (const candidate of candidates) {
                                    if (!isVisible(candidate)) continue;
                                    let count = 0;
                                    for (const selector of selectors) {
                                        count +=
                                            candidate.querySelectorAll(
                                                selector,
                                            ).length;
                                    }
                                    if (count > 0) {
                                        const style =
                                            window.getComputedStyle(
                                                candidate,
                                            ) || {};
                                        const overflowY = (
                                            style.overflowY || ""
                                        ).toLowerCase();
                                        const scrollable =
                                            overflowY === "auto" ||
                                            overflowY === "scroll" ||
                                            candidate.scrollHeight >
                                                candidate.clientHeight;
                                        if (scrollable) {
                                            return candidate;
                                        }
                                        if (count > bestCount) {
                                            best = candidate;
                                            bestCount = count;
                                        }
                                    }
                                }

                                if (best) return best;
                                if (dialog.scrollHeight > dialog.clientHeight) {
                                    return dialog;
                                }
                            }

                            return (
                                document.scrollingElement ||
                                document.documentElement ||
                                document.body
                            );
                        }

                        const scrollable = findScrollable();
                        const clicked = [];
                        const seenNodes = new WeakSet();
                        let consecutiveNoNewButtons = 0;
                        let lastScrollHeight = -1;

                        while (
                            clicked.length < maxInvites &&
                            consecutiveNoNewButtons <= noNewButtonsLimit
                        ) {
                            const found = [];
                            for (const selector of selectors) {
                                const nodes = Array.from(
                                    document.querySelectorAll(selector),
                                );
                                for (const node of nodes) {
                                    try {
                                        if (
                                            !isVisible(node) ||
                                            !matchesTarget(node)
                                        ) {
                                            continue;
                                        }
                                        if (seenNodes.has(node)) continue;
                                        seenNodes.add(node);
                                        found.push(node);
                                    } catch (e) {}
                                }
                            }

                            if (found.length === 0) {
                                consecutiveNoNewButtons += 1;
                            } else {
                                consecutiveNoNewButtons = 0;
                            }

                            for (const node of found) {
                                if (clicked.length >= maxInvites) break;
                                try {
                                    if (
                                        node.getAttribute("data-invited") ===
                                        "true"
                                    ) {
                                        continue;
                                    }

                                    node.scrollIntoView({
                                        block: "center",
                                        inline: "center",
                                    });
                                    await sleep(250);

                                    if (!document.body.contains(node)) {
                                        continue;
                                    }

                                    node.click();
                                    node.setAttribute("data-invited", "true");
                                    clicked.push({
                                        name: findName(node),
                                        label: normalize(
                                            node.getAttribute("aria-label") ||
                                                node.innerText ||
                                                node.textContent ||
                                                "",
                                        ),
                                        tag: node.tagName,
                                    });

                                    await sleep(delayMs + 500);
                                } catch (e) {}
                            }

                            if (scrollable) {
                                const currentScrollHeight =
                                    scrollable.scrollHeight || 0;
                                if (currentScrollHeight === lastScrollHeight) {
                                    consecutiveNoNewButtons += 1;
                                } else {
                                    consecutiveNoNewButtons = 0;
                                    lastScrollHeight = currentScrollHeight;
                                }

                                try {
                                    scrollable.scrollTop =
                                        scrollable.scrollHeight;
                                } catch (e) {}
                                await sleep(1200);
                            } else {
                                await sleep(1200);
                            }
                        }

                        return { count: clicked.length, accounts: clicked };
                    },
                    {
                        maxInvites: Math.max(1, parseInt(max, 10) || 1000),
                        delayMs: Math.max(0, parseInt(delay, 10) || 0),
                        noNewButtonsLimit: 5,
                    },
                );

                count =
                    inviteResult && typeof inviteResult === "object"
                        ? inviteResult.count || 0
                        : 0;

                try {
                    const accounts =
                        (inviteResult && inviteResult.accounts) || [];
                    const outPath = path.join(
                        process.cwd(),
                        "data",
                        `followed-accounts-${Date.now()}.json`,
                    );
                    fs.writeFileSync(
                        outPath,
                        JSON.stringify(accounts, null, 2),
                        "utf8",
                    );
                    logger.info(
                        `Wrote ${accounts.length} followed accounts to ${outPath}`,
                    );
                } catch (e) {
                    logger.error(
                        "Failed to write followed accounts file: " +
                            (e && e.message),
                    );
                }

                logger.info(`invite-follow result: ${count}`);
                await storage.saveHistory(url, count);
                await browser.close();
                return count;
            }

            // After scrolling, collect Follow buttons using several heuristics
            const followCount = await page.evaluate(() => {
                const selectors = [
                    'button[aria-label="Follow"]',
                    'div[role="button"][aria-label*="Follow"]',
                    'a[role="button"][aria-label*="Follow"]',
                    "button",
                    'div[role="button"]',
                    'a[role="button"]',
                ];
                const els = new Set();
                function isVisible(el) {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (
                        style &&
                        (style.visibility === "hidden" ||
                            style.display === "none")
                    )
                        return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 2 && rect.height > 2;
                }

                // 1) direct aria-label or exact text match
                document.querySelectorAll("*").forEach((n) => {
                    try {
                        const aria =
                            (n.getAttribute && n.getAttribute("aria-label")) ||
                            "";
                        const txt = (n.innerText || "")
                            .replace(/\s+/g, " ")
                            .trim();
                        if (
                            /(?:\bFollow\b|\bsledovat\b)/i.test(aria) ||
                            /^(?:Follow|Sledovat)$/i.test(txt) ||
                            /(?:\bFollow\b|\bsledovat\b)/i.test(txt)
                        ) {
                            if (isVisible(n)) els.add(n);
                        }
                    } catch (e) {}
                });

                // 2) fallback: use candidate selectors and filter by small text 'Follow'
                selectors.forEach((sel) => {
                    document.querySelectorAll(sel).forEach((n) => {
                        try {
                            const txt = (n.innerText || "")
                                .replace(/\s+/g, " ")
                                .trim();
                            const aria =
                                (n.getAttribute &&
                                    n.getAttribute("aria-label")) ||
                                "";
                            if (
                                /(?:\bFollow\b|\bsledovat\b)/i.test(aria) ||
                                /^(?:Follow|Sledovat)$/i.test(txt) ||
                                /(?:\bFollow\b|\bsledovat\b)/i.test(txt)
                            ) {
                                if (isVisible(n)) els.add(n);
                            }
                        } catch (e) {}
                    });
                });

                return Array.from(els).length;
            });
            // If we got zero, dump detailed candidate info for post-scroll debugging
            if (!followCount) {
                try {
                    const candidates = await page.evaluate(() => {
                        const sels = [
                            "button[aria-label]",
                            'div[role="button"][aria-label]',
                            '[role="button"][aria-label]',
                            "[aria-label]",
                        ];
                        const nodes = [];
                        const all = Array.from(document.querySelectorAll("*"));
                        for (const n of all) {
                            try {
                                const aria =
                                    n.getAttribute &&
                                    n.getAttribute("aria-label");
                                const txt = (n.innerText || "")
                                    .replace(/\s+/g, " ")
                                    .trim();
                                if (
                                    aria ||
                                    /(?:follow|sledovat)/i.test(txt) ||
                                    (aria && /(?:follow|sledovat)/i.test(aria))
                                ) {
                                    const r = n.getBoundingClientRect
                                        ? n.getBoundingClientRect()
                                        : {
                                              width: 0,
                                              height: 0,
                                              top: 0,
                                              left: 0,
                                          };
                                    const style = window.getComputedStyle
                                        ? window.getComputedStyle(n)
                                        : {};
                                    nodes.push({
                                        aria: aria || "",
                                        text: txt.slice(0, 400),
                                        tag: n.tagName,
                                        roles:
                                            (n.getAttribute &&
                                                n.getAttribute("role")) ||
                                            "",
                                        rect: {
                                            w: r.width,
                                            h: r.height,
                                            top: r.top,
                                            left: r.left,
                                        },
                                        visibleStyle: {
                                            display: style.display || "",
                                            visibility: style.visibility || "",
                                            opacity: style.opacity || "",
                                            overflowY: style.overflowY || "",
                                        },
                                        outerHTML: (n.outerHTML || "").slice(
                                            0,
                                            2000,
                                        ),
                                        inDialog:
                                            !!n.closest &&
                                            !!n.closest('[role="dialog"]'),
                                    });
                                }
                            } catch (e) {}
                        }
                        return nodes;
                    });
                    const candPath = path.join(
                        process.cwd(),
                        "data",
                        `post-scroll-button-candidates-${Date.now()}.json`,
                    );
                    fs.writeFileSync(
                        candPath,
                        JSON.stringify(candidates, null, 2),
                        "utf8",
                    );
                    logger.info(
                        `Wrote ${candidates.length} post-scroll candidates to ${candPath}`,
                    );
                } catch (e) {
                    logger.error(
                        "Failed to dump post-scroll candidates: " +
                            (e && e.message),
                    );
                }
            }

            logger.info(`count-follow result: ${followCount}`);
            await storage.saveHistory(url, followCount);
            await browser.close();
            return followCount;
        }

        const selectorStats = await page.evaluate((selectors) => {
            return selectors.map((selector) => {
                const matches = Array.from(document.querySelectorAll(selector));
                return {
                    selector,
                    count: matches.length,
                    samples: matches.slice(0, 3).map((element) => {
                        const ariaLabel = element.getAttribute("aria-label");
                        const text = (element.textContent || "")
                            .replace(/\s+/g, " ")
                            .trim();
                        return {
                            ariaLabel,
                            text,
                            tagName: element.tagName,
                        };
                    }),
                };
            });
        }, DEFAULT_SELECTORS);

        logger.info(`Selector scan: ${JSON.stringify(selectorStats)}`);

        // Try to collect candidate buttons on the page
        const clicked = await page.evaluate(
            async (selectors, max, delay) => {
                function sleep(ms) {
                    return new Promise((r) => setTimeout(r, ms));
                }
                const els = [];
                selectors.forEach((sel) => {
                    document.querySelectorAll(sel).forEach((e) => els.push(e));
                });
                // Deduplicate
                const uniq = Array.from(new Set(els));
                let clickedCount = 0;
                for (let el of uniq) {
                    try {
                        if (el.getAttribute("data-invited") === "true")
                            continue;
                        // Scroll into view and click
                        el.scrollIntoView({
                            block: "center",
                            inline: "center",
                        });
                        el.click();
                        el.setAttribute("data-invited", "true");
                        clickedCount++;
                        await sleep(delay + Math.floor(Math.random() * 500));
                        if (clickedCount >= max) break;
                    } catch (e) {
                        // ignore single failures
                    }
                }
                return {
                    clickedCount,
                    matchedCount: uniq.length,
                };
            },
            DEFAULT_SELECTORS,
            max,
            delay,
        );

        count =
            clicked && typeof clicked === "object"
                ? clicked.clickedCount || 0
                : clicked || 0;
        const matchedCount =
            clicked && typeof clicked === "object"
                ? clicked.matchedCount || 0
                : 0;
        logger.info(
            `Matched ${matchedCount} candidate elements and clicked ${count} buttons`,
        );
        await storage.saveHistory(url, count);
    } catch (err) {
        logger.error("Error in inviter run: " + err.message);
        throw err;
    } finally {
        await browser.close();
    }
    return count;
}

module.exports = { runWithBrowser };
