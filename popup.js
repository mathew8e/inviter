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

        const inputValue = document.getElementById("string").value || "";
        const delay = document.getElementById("delay").value || "3.5";
        const limit = document.getElementById("limit").value || "100";
        const pauseAfter = document.getElementById("pauseAfter").value || "20";
        const isMobile = document.getElementById("mobileMode").checked;

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
    isMobile,
) {
    chrome.runtime.sendMessage({ type: "LOG", message: "Script starting..." });

    const desktopSelectors = [
        'div[aria-label="Pozvat"][role="button"]',
        'div[aria-label^="Pozvat"][role="button"]',
        'div[aria-label="Sledovat"][role="button"]',
        `div[role="button"]`, // Fallback
    ];

    const mobileSelectors = [
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

    const anchorButton = await new Promise(resolve => {
        const clickListener = (event) => {
            // We are looking for a button-like element that the user clicks.
            const targetElement = event.target.closest('div[role="button"], button');

            if (targetElement) {
                // To qualify as an anchor, it should look like an invite button.
                // We check its label or text content for keywords.
                const label = targetElement.getAttribute('aria-label') || targetElement.textContent || "";
                const keywords = ['invite', 'pozvat', 'sledovat']; // English, Czech. Add more if needed.
                
                if (keywords.some(k => label.toLowerCase().includes(k))) {
                    console.log('User clicked a potential invite button:', targetElement);
                    // Prevent the default click action and stop it from propagating.
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();

                    // Clean up the listener and resolve the promise.
                    document.removeEventListener('click', clickListener, true);
                    resolve(targetElement);
                } else {
                    console.log('Clicked element was not an invite button, ignoring:', targetElement);
                }
            }
        };

        // Listen for clicks on the entire document in the capture phase.
        document.addEventListener('click', clickListener, true);
    });

    chrome.runtime.sendMessage({
        type: "LOG",
        message: "Anchor button selected. Finding scrollable area...",
    });
    console.log("Selected anchor button:", anchorButton);
    
    let scrollableElement = null;
    let originalBorderStyle = "";

    if (!isMobile) {
        const dialog = anchorButton.closest('div[role="dialog"]');

        if (dialog) {
            console.log("Found dialog element via anchor:", dialog);
            
            let parent = anchorButton.parentElement;
            while (parent && parent !== dialog) {
                const style = window.getComputedStyle(parent);
                console.log(
                    `Checking parent: ${parent.tagName}.${parent.className}, overflowY: ${style.overflowY}`,
                );
                if (style.overflowY === 'scroll' || style.overflowY === 'auto') {
                    scrollableElement = parent;
                    console.log(
                        "Found potentially scrollable parent based on CSS overflow style:",
                        scrollableElement,
                    );
                    chrome.runtime.sendMessage({
                        type: "LOG",
                        message: "Scrollable area identified by CSS style.",
                    });
                    break; 
                }
                parent = parent.parentElement;
            }

            if (!scrollableElement) {
                console.log("Bottom-up search with user-selected button failed. Using dialog as fallback.");
                scrollableElement = dialog;
            }

        } else {
            console.log("No dialog found climbing up from anchor. Using document.body.");
            scrollableElement = document.body;
        }
    } else {
        scrollableElement = document.body;
    }
    // --- End of Scrollable Element Detection ---

    // --- Visual Debugging: Highlight the scrollable element ---
    if (scrollableElement) {
        originalBorderStyle = scrollableElement.style.border;
        scrollableElement.style.border = "3px solid red";
        scrollableElement.style.boxSizing = "border-box";
        console.log(
            "Highlighted the identified scrollable element:",
            scrollableElement,
        );
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
            let filteredButtons = foundButtons;
            if (searchText) {
                filteredButtons = foundButtons.filter(
                    (btn) =>
                        btn.textContent.trim().toLowerCase() === searchText,
                );
            }

            if (filteredButtons.length > 0) {
                currentVisibleButtons = filteredButtons;
                chrome.runtime.sendMessage({
                    type: "LOG",
                    message: `Found ${currentVisibleButtons.length} buttons to invite.`,
                });
                break;
            }
        }

        if (currentVisibleButtons.length === 0) {
            consecutiveNoNewButtons++;
            chrome.runtime.sendMessage({
                type: "LOG",
                message: "No new buttons found. Attempting to scroll...",
            });
        } else {
            consecutiveNoNewButtons = 0;
        }

        for (const btn of currentVisibleButtons) {
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
                // Ignore
            }

            if (!document.body.contains(btn)) {
                console.warn("Button is no longer in the DOM, skipping.");
                continue;
            }

            try {
                btn.click();
                btn.style.backgroundColor = "#5cb85c";
                count++;
                chrome.runtime.sendMessage({
                    type: "UPDATE_COUNT",
                    count: count,
                });
                console.log(`Invited person #${count}`);
            } catch (e) {
                console.error("Failed to click button:", e);
                btn.style.backgroundColor = "#d9534f";
            }

            if (count > 0 && count % pauseAfterInvites === 0) {
                chrome.runtime.sendMessage({
                    type: "LOG",
                    message: `Pausing for 30 seconds after ${count} invites...`,
                });
                await new Promise((res) => setTimeout(res, 30000));
            }
        }

        lastScrollHeight = scrollableElement.scrollHeight;
        const currentScrollTop = scrollableElement.scrollTop;
        scrollableElement.scrollTop = scrollableElement.scrollHeight;
        console.log(
            `Scrolling attempt: Before: ${currentScrollTop}, After: ${scrollableElement.scrollTop}, Height: ${scrollableElement.scrollHeight}`,
        );
        await new Promise((res) => setTimeout(res, 2000));

        if (
            scrollableElement.scrollHeight === lastScrollHeight &&
            consecutiveNoNewButtons > 2
        ) {
            chrome.runtime.sendMessage({
                type: "LOG",
                message: "End of list reached. Finishing.",
            });
            break;
        }
    }

    // --- Cleanup ---
    if (scrollableElement) {
        scrollableElement.style.border = originalBorderStyle; // Restore original border
    }
    window.__inviter_running = false;
    chrome.runtime.sendMessage({
        type: "FINISHED",
        count: count,
        stopped: window.__inviter_stop,
    });
}
