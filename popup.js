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

    let scrollableElement = null;
    if (!isMobile) {
        // Try to find a dialog and then a scrollable element within it
        const dialog = document.querySelector('div[role="dialog"]');
        if (dialog) {
            // Look for a scrollable descendant
            const potentialScrollables = dialog.querySelectorAll('div, ul, ol');
            for (const el of potentialScrollables) {
                // Check if the element is actually scrollable
                const computedStyle = getComputedStyle(el);
                if (
                    el.scrollHeight > el.clientHeight &&
                    (computedStyle.overflowY === 'auto' || computedStyle.overflowY === 'scroll')
                ) {
                    scrollableElement = el;
                    break;
                }
            }
            // If no specific scrollable element found, try the dialog itself if it's scrollable
            if (!scrollableElement) {
                const computedStyle = getComputedStyle(dialog);
                if (
                    dialog.scrollHeight > dialog.clientHeight &&
                    (computedStyle.overflowY === 'auto' || computedStyle.overflowY === 'scroll')
                ) {
                    scrollableElement = dialog;
                }
            }
        }
    }
    // Fallback to body only if no specific scrollable element found in desktop mode or if in mobile mode
    if (!scrollableElement) {
        scrollableElement = document.body;
    }


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

    // --- NEW PRE-SCROLLING LOGIC ---
    chrome.runtime.sendMessage({
        type: "LOG",
        message: "Pre-scrolling to load all users..."
    });
    let lastScrollHeight = -1;
    let currentScrollHeight = scrollableElement.scrollHeight;
    let scrollAttempts = 0;
    const MAX_SCROLL_ATTEMPTS = 20; // Prevent infinite loops, increased from 10

    while (
        lastScrollHeight !== currentScrollHeight &&
        scrollAttempts < MAX_SCROLL_ATTEMPTS &&
        !window.__inviter_stop
    ) {
        lastScrollHeight = currentScrollHeight;
        scrollableElement.scrollTop = scrollableElement.scrollHeight;
        await new Promise((res) => setTimeout(res, 1500)); // Wait for content to load
        currentScrollHeight = scrollableElement.scrollHeight;
        scrollAttempts++;
        chrome.runtime.sendMessage({
             type: "LOG",
             message: `Scrolled. Current height: ${currentScrollHeight}. Attempt: ${scrollAttempts}`
        });
    }
    chrome.runtime.sendMessage({
        type: "LOG",
        message: "Pre-scrolling complete. Starting invitation process."
    });
    // --- END NEW PRE-SCROLLING LOGIC ---


    let lastButtonCount = -1; // This variable will now track total unique buttons found
    let allButtonsFound = new Set(); // Use a Set to store unique buttons

    while (!window.__inviter_stop && count < maxInvites) {
        let currentVisibleButtons = [];
        for (const selector of selectors) {
            const foundButtons = Array.from(
                document.querySelectorAll(
                    `${selector}:not([data-invited="true"])`
                )
            );
            if (foundButtons.length > 0) {
                const searchText = inputString.trim().toLowerCase();
                if (searchText) {
                    currentVisibleButtons = foundButtons.filter(
                        (btn) =>
                            btn.textContent.trim().toLowerCase() === searchText
                    );
                } else {
                    currentVisibleButtons = foundButtons;
                }

                if (currentVisibleButtons.length > 0) {
                    // Filter out buttons already in our Set of all found buttons
                    const newButtons = currentVisibleButtons.filter(btn => !allButtonsFound.has(btn));
                    newButtons.forEach(btn => allButtonsFound.add(btn));

                    chrome.runtime.sendMessage({
                        type: "LOG",
                        message: `Found ${currentVisibleButtons.length} new buttons with selector: ${selector}. Total unique found: ${allButtonsFound.size}`,
                    });
                    break;
                }
            }
        }

        // If no new buttons were found in this pass, and we've already scrolled to the bottom
        // (implied by the pre-scrolling), then we can assume we're done.
        // The check buttons.length === 0 is now effectively replaced by the pre-scrolling
        // and the fact that allButtonsFound will eventually stabilize.
        if (currentVisibleButtons.length === 0 && allButtonsFound.size === (lastButtonCount === -1 ? 0 : lastButtonCount)) {
            chrome.runtime.sendMessage({
                type: "LOG",
                message: "No new buttons to process after pre-scrolling. Finishing.",
            });
            break;
        }

        lastButtonCount = allButtonsFound.size; // Update total count for next iteration check

        for (const btn of currentVisibleButtons) { // Iterate over currently visible (and uninvited) buttons
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
        // Removed the in-loop scrolling as pre-scrolling should handle initial load
        // and we only process visible buttons after that.
    }

    window.__inviter_running = false;

    chrome.runtime.sendMessage({
        type: "FINISHED",
        count: count,
        stopped: window.__inviter_stop,
    });
}
