const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

// Initialize button states
if (startBtn) startBtn.disabled = false;
if (stopBtn) stopBtn.disabled = true;

// Get running state from storage and update UI
chrome.storage.local.get("isRunning", (data) => {
    if (data.isRunning) {
        if (statusEl) statusEl.textContent = "Currently running...";
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
    } else {
        if (statusEl) statusEl.textContent = "Ready to start.";
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
    }
});
// Listen for changes in storage and update UI
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.isRunning) {
        const { newValue } = changes.isRunning;
        if (newValue) {
            if (statusEl) statusEl.textContent = "Currently running...";
            if (startBtn) startBtn.disabled = true;
            if (stopBtn) stopBtn.disabled = false;
        } else {
            if (statusEl) statusEl.textContent = "Finished";
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
        }
    }
});

// Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "UPDATE_COUNT") {
        const invitedCountEl = document.getElementById("invitedCount");
        if (invitedCountEl) {
            invitedCountEl.textContent = request.count;
        }
    } else if (request.type === "LOG") {
        if (statusEl) {
            statusEl.innerHTML = request.message;
        }
    } else if (request.type === "NO_BUTTONS_FOUND") {
        if (statusEl) {
            statusEl.innerHTML = `No buttons found. Please check the selectors in <code>popup.js</code>. <br>Mode: ${
                request.isMobile ? "Mobile" : "Desktop"
            }`;
        }
    } else if (request.type === "FINISHED") {
        if (statusEl) {
            const message = request.stopped
                ? `Stopped by user. Invited ${request.count} people.`
                : `Finished. Invited ${request.count} people.`;
            statusEl.textContent = message;
        }
        chrome.runtime.sendMessage({ type: "STOP" });
    }
});

// Update delay value display
const delaySlider = document.getElementById("delay");
const delayValueEl = document.getElementById("delayValue");
if (delaySlider && delayValueEl) {
    delaySlider.addEventListener("input", (e) => {
        delayValueEl.textContent = e.target.value;
    });
}

if (!startBtn) {
    console.error("startBtn element not found in popup");
} else {
    startBtn.addEventListener("click", async () => {
        console.log("Start button clicked");
        if (statusEl) statusEl.textContent = "Start clicked...";

        chrome.runtime.sendMessage({ type: "START" });

        let [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        if (!tab || !tab.id) {
            console.error("No active tab found to run the script");
            if (statusEl) statusEl.textContent = "No active tab to run on";
            return;
        }

        const inputValue =
            document.getElementById("string").value || "";
        const delay =
            document.getElementById("delay").value || "3.5";
        const limit =
            document.getElementById("limit").value || "100";
        const pauseAfter =
            document.getElementById("pauseAfter").value || "20";
        const isMobile =
            document.getElementById("mobileMode").checked;

        console.log("Start clicked, input:", {
            inputValue,
            delay,
            limit,
            pauseAfter,
            isMobile,
        });

        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    window.__inviter_stop = false;
                    window.__inviter_running = true;
                },
            });

            if (statusEl) statusEl.textContent = "Running invites...";

            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: autoInviteAction,
                args: [inputValue, delay, limit, pauseAfter, isMobile],
            });
        } catch (err) {
            console.error("executeScript failed:", err);
            if (statusEl)
                statusEl.textContent = "Error: " + (err && err.message);
            chrome.runtime.sendMessage({ type: "STOP" });
        }
    });

    if (stopBtn) {
        stopAction();
    }
}
function stopAction() {
    stopBtn.addEventListener("click", async () => {
        console.log("Stop button clicked");
        if (statusEl) statusEl.textContent = "Stop requested...";

        // Send STOP message to background script to update the running state
        chrome.runtime.sendMessage({ type: "STOP" });

        let [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        if (!tab || !tab.id) {
            console.error("No active tab found to set stop flag");
            if (statusEl) statusEl.textContent = "No active tab to stop on";
            return;
        }
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    window.__inviter_stop = true;
                },
            });
            console.log("Stop signal sent to page");
            if (statusEl) statusEl.textContent = "Stopping...";
        } catch (err) {
            console.error("Failed setting stop flag", err);
        }
    });
}

// This function runs INSIDE the Facebook page
async function autoInviteAction(
    inputString,
    delay,
    limit,
    pauseAfter,
    isMobile
) {
    chrome.runtime.sendMessage({ type: "LOG", message: "Script starting..." });

    const desktopSelectors = [
        'div[aria-label="Pozvat"][role="button"]',
        'div[aria-label^="Pozvat"][role="button"]',
        `div[role="button"]`, // Fallback
    ];

    const mobileSelectors = [
        'button[data-testid="user-list-invite-button"]',
        'div[aria-label="Pozvat"]',
        'div[aria-label="Invite"]',
        'button',
    ];

    const selectors = isMobile ? mobileSelectors : desktopSelectors;
    const scrollableElement = isMobile
        ? document.body
        : document.querySelector('div[role="dialog"] .scrollable-area') ||
          document.body;

    chrome.runtime.sendMessage({
        type: "LOG",
        message: `Using ${isMobile ? "mobile" : "desktop"} selectors.`,
    });

    if (typeof window.__inviter_stop === "undefined") {
        window.__inviter_stop = false;
    }
    window.__inviter_running = true;

    let count = 0;
    const maxInvites = parseInt(limit, 10);
    const pauseAfterInvites = parseInt(pauseAfter, 10);
    const delaySeconds = parseFloat(delay);

    let lastButtonCount = -1;
    let currentButtonCount = 0;

    while (!window.__inviter_stop && count < maxInvites) {
        let buttons = [];
        for (const selector of selectors) {
            const foundButtons = Array.from(
                document.querySelectorAll(
                    `${selector}:not([data-invited="true"])`
                )
            );
            if (foundButtons.length > 0) {
                const searchText = inputString.trim().toLowerCase();
                if (searchText) {
                    buttons = foundButtons.filter(
                        (btn) =>
                            btn.textContent.trim().toLowerCase() === searchText
                    );
                } else {
                    buttons = foundButtons;
                }

                if (buttons.length > 0) {
                    chrome.runtime.sendMessage({
                        type: "LOG",
                        message: `Found ${buttons.length} new buttons with selector: ${selector}`,
                    });
                    break;
                }
            }
        }

        currentButtonCount = buttons.length;

        if (buttons.length === 0 && lastButtonCount === 0) {
            chrome.runtime.sendMessage({
                type: "LOG",
                message: "No new people found, finishing.",
            });
            break;
        }
        lastButtonCount = currentButtonCount;

        for (const btn of buttons) {
            if (window.__inviter_stop || count >= maxInvites) {
                break;
            }

            btn.dataset.invited = "true";

            const randomDelay =
                Math.floor(Math.random() * (delaySeconds * 1000 - 1000 + 1)) +
                1000;
            await new Promise((res) => setTimeout(res, randomDelay));

            try {
                btn.scrollIntoView({ behavior: "smooth", block: "center" });
                await new Promise((res) => setTimeout(res, 300));
            } catch (e) {
                // Ignore if scrolling fails
            }

            if (!document.body.contains(btn)) {
                console.warn("Button is no longer in the DOM, skipping.");
                continue;
            }

            try {
                btn.click();
                btn.style.backgroundColor = "#5cb85c"; // Greenish color
                count++;
                chrome.runtime.sendMessage({
                    type: "UPDATE_COUNT",
                    count: count,
                });
                console.log(`Invited person #${count}`);
            } catch (e) {
                console.error("Failed to click button:", e);
                btn.style.backgroundColor = "#d9534f"; // Reddish color
            }

            if (count > 0 && count % pauseAfterInvites === 0) {
                chrome.runtime.sendMessage({
                    type: "LOG",
                    message: `Pausing for 30 seconds after ${count} invites...`,
                });
                await new Promise((res) => setTimeout(res, 30000));
            }
        }

        // Scroll to load more
        if (!window.__inviter_stop && count < maxInvites) {
            chrome.runtime.sendMessage({
                type: "LOG",
                message: "Scrolling to find more people...",
            });
            scrollableElement.scrollTop = scrollableElement.scrollHeight;
            await new Promise((res) => setTimeout(res, 2500)); // Wait for content to load
        }
    }

    window.__inviter_running = false;

    chrome.runtime.sendMessage({
        type: "FINISHED",
        count: count,
        stopped: window.__inviter_stop,
    });
}
