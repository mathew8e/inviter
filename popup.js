const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const historyListEl = document.querySelector("#history ul");
function getConsecutiveNoNewButtonsMax() {
    const el = document.getElementById("noButton");
    const val = el ? parseInt(el.value, 10) : NaN;
    return Number.isFinite(val) ? val : 5; // default to 5 if not present or invalid
}

// --- History Functions ---
function loadHistory() {
    if (!historyListEl) return;
    historyListEl.innerHTML = ""; // Clear existing list
    chrome.storage.local.get("invitationHistory", (data) => {
        if (data.invitationHistory && data.invitationHistory.length > 0) {
            // Sort history from newest to oldest
            const sortedHistory = data.invitationHistory.sort(
                (a, b) => new Date(b.date) - new Date(a.date),
            );

            sortedHistory.forEach((item) => {
                const li = document.createElement("li");
                const date = new Date(item.date);
                // Format date to be more readable, e.g., "Feb 03 2026, 10:30"
                const formattedDate = `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
                li.textContent = `${formattedDate} - Invited ${item.count}`;
                historyListEl.appendChild(li);
            });
        } else {
            const li = document.createElement("li");
            li.textContent = "No history yet.";
            historyListEl.appendChild(li);
        }
    });
}

function saveHistory(count) {
    const newEntry = { date: new Date().toISOString(), count: count };
    chrome.storage.local.get("invitationHistory", (data) => {
        let history = data.invitationHistory || [];
        history.push(newEntry);
        // Keep only the last 10 entries
        if (history.length > 10) {
            history = history.slice(history.length - 10);
        }
        chrome.storage.local.set({ invitationHistory: history }, () => {
            loadHistory(); // Refresh the list after saving
        });
    });
}

// --- Initial UI Setup ---
function initializeUI() {
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;

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

    loadHistory();
}

// --- Event Listeners ---
// Listen for storage changes to update UI (e.g., when script finishes in background)
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.isRunning) {
        const { newValue } = changes.isRunning;
        if (newValue) {
            if (statusEl) statusEl.textContent = "Currently running...";
            if (startBtn) startBtn.disabled = true;
            if (stopBtn) stopBtn.disabled = false;
        } else {
            if (statusEl) statusEl.textContent = "Finished.";
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
        }
    }
});

// Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
        case "UPDATE_COUNT":
            const invitedCountEl = document.getElementById("invitedCount");
            if (invitedCountEl) invitedCountEl.textContent = request.count;
            break;
        case "LOG":
            if (statusEl) statusEl.innerHTML = request.message;
            break;
        case "NO_BUTTONS_FOUND":
            if (statusEl)
                statusEl.innerHTML = `No buttons found. Please check the button text.`;
            break;
        case "FINISHED":
            const message = request.stopped
                ? `Stopped by user. Invited ${request.count} people.`
                : `Finished. Invited ${request.count} people.`;
            if (statusEl) statusEl.textContent = message;
            saveHistory(request.count);
            chrome.runtime.sendMessage({ type: "STOP" }); // Tell background to set isRunning to false
            break;
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

const pcModeBtn = document.getElementById("pcModeBtn");
if (pcModeBtn) {
    pcModeBtn.addEventListener("click", () => {
        document.body.classList.add("pc-mode");
        pcModeBtn.style.display = "none";
    });
}

// --- Button Actions ---
if (startBtn) {
    startBtn.addEventListener("click", async () => {
        if (statusEl) statusEl.textContent = "Starting...";
        chrome.runtime.sendMessage({ type: "START" });

        let [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        if (!tab || !tab.id) {
            if (statusEl) statusEl.textContent = "No active tab to run on.";
            chrome.runtime.sendMessage({ type: "STOP" });
            return;
        }

        const inputValue = document.getElementById("string").value || "Pozvat";
        const delay = document.getElementById("delay").value || "0.5";
        const limit = document.getElementById("limit").value || "1000";
        const pauseAfter = document.getElementById("pauseAfter").value || "200";
        const consecutiveNoNewButtonsMax = getConsecutiveNoNewButtonsMax();

        // Helper to decide search string based on user input or common defaults
        let searchString = inputValue;
        // If the user hasn't changed the default Czech "Pozvat", we also check for "Follow" or "Invite"
        // But the script uses the exact inputString provided to the function. 
        // We'll pass the input as is, but the content script logic can be more flexible.

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
                args: [
                    inputValue,
                    delay,
                    limit,
                    pauseAfter,
                    consecutiveNoNewButtonsMax,
                ],
            });
        } catch (err) {
            console.error("executeScript failed:", err);
            if (statusEl)
                statusEl.textContent =
                    "Error: " + (err ? err.message : "Unknown error");
            chrome.runtime.sendMessage({ type: "STOP" });
        }
    });
}

if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
        if (statusEl) statusEl.textContent = "Stopping...";
        chrome.runtime.sendMessage({ type: "STOP" });

        let [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        if (!tab || !tab.id) {
            if (statusEl) statusEl.textContent = "No active tab to stop on.";
            return;
        }
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    window.__inviter_stop = true;
                },
            });
        } catch (err) {
            console.error("Failed to set stop flag:", err);
        }
    });
}

// --- Main execution ---
document.addEventListener("DOMContentLoaded", initializeUI);

// This function runs INSIDE the Facebook page
async function autoInviteAction(
    inputString,
    delay,
    limit,
    pauseAfter,
    consecutiveNoNewButtonsMax,
) {
    // This is now hardcoded to false as the UI element was removed.
    const isMobile = false;

    consecutiveNoNewButtonsMax = parseInt(consecutiveNoNewButtonsMax, 10);
    if (!Number.isFinite(consecutiveNoNewButtonsMax)) {
        consecutiveNoNewButtonsMax = 5;
    }

    chrome.runtime.sendMessage({ type: "LOG", message: "Script starting..." });

    const desktopSelectors = [
        'div[aria-label="Pozvat"][role="button"]',
        'div[aria-label^="Pozvat"][role="button"]',
        'div[aria-label="Sledovat"][role="button"]',
        'div[aria-label="Follow"][role="button"]',
        `div[role="button"]`, // Fallback
    ];

    const mobileSelectors = [
        // Kept for potential future use, but currently unused
        'button[data-testid="user-list-invite-button"]',
        'div[aria-label="Pozvat"]',
        'div[aria-label="Invite"]',
        "button",
    ];

    const selectors = isMobile ? mobileSelectors : desktopSelectors;

    // --- Scrollable Element Detection v4 (User-Initiated) ---
    chrome.runtime.sendMessage({
        type: "LOG",
        message: "Please click an 'Invite' button to begin.",
    });

    const anchorButton = await new Promise((resolve) => {
        const clickListener = (event) => {
            const targetElement = event.target.closest(
                'div[role="button"], button',
            );

            if (targetElement) {
                const label =
                    targetElement.getAttribute("aria-label") ||
                    targetElement.textContent ||
                    "";
                const keywords = ["invite", "pozvat", "sledovat", "follow"];

                if (keywords.some((k) => label.toLowerCase().includes(k))) {
                    console.log(
                        "User clicked a potential invite button:",
                        targetElement,
                    );
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    document.removeEventListener("click", clickListener, true);
                    resolve(targetElement);
                }
            }
        };
        document.addEventListener("click", clickListener, true);
    });

    chrome.runtime.sendMessage({
        type: "LOG",
        message: "Anchor button selected. Finding scrollable area...",
    });

    let scrollableElement = null;
    let originalBorderStyle = "";

    const dialog = anchorButton.closest('div[role="dialog"]');
    if (dialog) {
        let parent = anchorButton.parentElement;
        while (parent && parent !== dialog) {
            const style = window.getComputedStyle(parent);
            if (style.overflowY === "scroll" || style.overflowY === "auto") {
                scrollableElement = parent;
                chrome.runtime.sendMessage({
                    type: "LOG",
                    message: "Scrollable area found.",
                });
                break;
            }
            parent = parent.parentElement;
        }
        if (!scrollableElement) {
            scrollableElement = dialog;
        }
    } else {
        scrollableElement = document.body;
    }

    if (scrollableElement) {
        originalBorderStyle = scrollableElement.style.border;
        scrollableElement.style.border = "3px solid red";
    }

    if (typeof window.__inviter_stop === "undefined") {
        window.__inviter_stop = false;
    }
    window.__inviter_running = true;

    let count = 0;
    const maxInvites = parseInt(limit, 10);
    const pauseAfterInvites = parseInt(pauseAfter, 10);
    const delaySeconds = parseFloat(delay);
    let lastScrollHeight = -1;
    let consecutiveNoNewButtons = 0;

    while (!window.__inviter_stop && count < maxInvites) {
        let currentVisibleButtons = [];
        for (const selector of selectors) {
            const foundButtons = Array.from(
                document.querySelectorAll(
                    `${selector}:not([data-invited="true"])`,
                ),
            );

            const searchText = inputString.trim().toLowerCase();
            let filteredButtons = foundButtons.filter(
                (btn) =>
                    (btn.textContent || "").trim().toLowerCase() === searchText,
            );

            if (filteredButtons.length > 0) {
                currentVisibleButtons = filteredButtons;
                chrome.runtime.sendMessage({
                    type: "LOG",
                    message: `Found ${currentVisibleButtons.length} buttons.`,
                });
                break;
            }
        }

        if (currentVisibleButtons.length === 0) {
            consecutiveNoNewButtons++;
            chrome.runtime.sendMessage({
                type: "LOG",
                message: "No new buttons found. Scrolling...",
            });
        } else {
            consecutiveNoNewButtons = 0;
        }

        for (const btn of currentVisibleButtons) {
            if (window.__inviter_stop || count >= maxInvites) break;

            btn.dataset.invited = "true";

            const randomDelay = Math.random() * delaySeconds * 1000 + 500; // Add 0.5s base
            await new Promise((res) => setTimeout(res, randomDelay));

            btn.scrollIntoView({ behavior: "smooth", block: "center" });
            await new Promise((res) => setTimeout(res, 200));

            if (!document.body.contains(btn)) {
                console.warn("Button vanished, skipping.");
                continue;
            }

            try {
                btn.click();
                btn.style.backgroundColor = "#4CAF50"; // Green
                count++;
                chrome.runtime.sendMessage({
                    type: "UPDATE_COUNT",
                    count: count,
                });
            } catch (e) {
                btn.style.backgroundColor = "#F44336"; // Red
            }

            if (count > 0 && count % pauseAfterInvites === 0) {
                chrome.runtime.sendMessage({
                    type: "LOG",
                    message: `Paused for 30s after ${count} invites.`,
                });
                await new Promise((res) => setTimeout(res, 30000));
            }
        }

        lastScrollHeight = scrollableElement.scrollHeight;
        scrollableElement.scrollTop = scrollableElement.scrollHeight;
        await new Promise((res) => setTimeout(res, 2000));

        if (
            scrollableElement.scrollHeight === lastScrollHeight &&
            consecutiveNoNewButtons > consecutiveNoNewButtonsMax
        ) {
            chrome.runtime.sendMessage({
                type: "LOG",
                message: "End of list reached.",
            });
            break;
        }
    }

    if (scrollableElement) {
        scrollableElement.style.border = originalBorderStyle;
    }
    window.__inviter_running = false;
    chrome.runtime.sendMessage({
        type: "FINISHED",
        count: count,
        stopped: window.__inviter_stop,
    });
}
