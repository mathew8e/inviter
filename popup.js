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
        const estimatedTimeEl = document.getElementById("estimatedTime");
        const delay = parseFloat(
            document.getElementById("delay").value || "3.5"
        );

        if (invitedCountEl) {
            invitedCountEl.textContent = request.count;
        }
        if (estimatedTimeEl) {
            const remaining = request.total - request.count;
            const timeInSeconds = remaining * delay;
            const minutes = Math.floor(timeInSeconds / 60);
            const seconds = Math.floor(timeInSeconds % 60);
            estimatedTimeEl.textContent = `${minutes}m ${seconds}s`;
        }
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
        // Immediate visual feedback so clicks are noticeable without opening devtools
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

        // Read input values from the popup DOM
        const inputValue =
            (document.getElementById("string") &&
                document.getElementById("string").value) ||
            "";
        const delay =
            (document.getElementById("delay") &&
                document.getElementById("delay").value) ||
            "3.5";
        const limit =
            (document.getElementById("limit") &&
                document.getElementById("limit").value) ||
            "100";
        const pauseAfter =
            (document.getElementById("pauseAfter") &&
                document.getElementById("pauseAfter").value) ||
            "20";

        console.log("Start clicked, input:", {
            inputValue,
            delay,
            limit,
            pauseAfter,
        });

        try {
            // Clear stop flag and mark running on the page
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    window.__inviter_stop = false;
                    window.__inviter_running = true;
                },
            });

            if (statusEl) statusEl.textContent = "Spouštím pozvánky...";

            // Run the long-running function (will resolve when finished or stopped)
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: autoInviteAction,
                args: [inputValue, delay, limit, pauseAfter],
            });
            console.log("Content script finished");
            if (statusEl) statusEl.textContent = "Finished";
        } catch (err) {
            console.error("executeScript failed:", err);
            if (statusEl)
                statusEl.textContent = "Error: " + (err && err.message);
        } finally {
            // Ensure the state is updated even if the script fails
            chrome.runtime.sendMessage({ type: "STOP" });
        }
    });

    // Stop button
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
async function autoInviteAction(inputString, delay, limit, pauseAfter) {
    // How to find a good selector:
    // 1. Right-click the "Invite" button on Facebook and select "Inspect".
    // 2. Look for a unique and stable attribute on the button element or its parent.
    //    - Good: `aria-label`, `data-testid`
    //    - Okay: `class` (if it's not generated randomly)
    //    - Bad: `id` (often randomly generated)
    // 3. Create a CSS selector based on the attribute.
    //    - Example: `div[aria-label="Pozvat"]`
    // 4. Add the selector to the `selectors` array below, in order of preference.
    const selectors = [
        // PREFERRED: Find a selector that is specific and unlikely to change.
        'div[aria-label="Pozvat"][role="button"]',
        'div[aria-label^="Pozvat"][role="button"]',

        // FALLBACK: If the text changes, you might need to update this.
        `div[role="button"]`,
    ];

    let buttons = [];
    for (const selector of selectors) {
        try {
            const allButtons = Array.from(document.querySelectorAll(selector));
            if (allButtons.length > 0) {
                const searchText = inputString.trim().toLowerCase();
                buttons = allButtons.filter((btn) => {
                    const buttonText = btn.textContent.trim().toLowerCase();
                    return buttonText === searchText;
                });

                if (buttons.length > 0) {
                    console.log(
                        `Found ${buttons.length} buttons with selector: ${selector} and text: "${inputString}"`
                    );
                    break;
                }
            }
        } catch (error) {
            console.warn(`Selector "${selector}" failed:`, error);
        }
    }

    if (buttons.length === 0) {
        alert(
            `Nebyly nalezeny žádné tlačítka. Zkuste upravit selektory v souboru popup.js.`
        );
        return;
    }

    // Ensure the stop flag exists
    if (typeof window.__inviter_stop === "undefined")
        window.__inviter_stop = false;
    window.__inviter_running = true;

    let count = 0;
    const maxInvites = parseInt(limit, 10);
    const pauseAfterInvites = parseInt(pauseAfter, 10);
    const delaySeconds = parseFloat(delay);

    for (let index = 0; index < buttons.length; index++) {
        // Check stop flag before each iteration
        if (window.__inviter_stop) {
            console.log("Inviter stopped by user");
            break;
        }

        if (count >= maxInvites) {
            console.log("Invite limit reached");
            break;
        }

        const btn = buttons[index];

        // Random delay
        const randomDelay =
            Math.floor(Math.random() * (delaySeconds * 1000 - 2000 + 1)) + 2000;
        await new Promise((res) => setTimeout(res, randomDelay));

        // Check stop flag again after delay
        if (window.__inviter_stop) {
            console.log("Inviter stopped by user (post-delay)");
            break;
        }

        // Scroll the button into view
        try {
            btn.scrollIntoView({ behavior: "smooth", block: "center" });
            // Give browser time to finish scrolling
            await new Promise((res) => setTimeout(res, 500));
        } catch (e) {
            // ignore
        }

        // Click the button if still in DOM
        if (!document.contains(btn)) {
            console.warn(`Tlačítko č. ${index + 1} už není v DOM, přeskočeno.`);
            continue;
        }

        try {
            btn.click();
            btn.style.backgroundColor = "green";
            count++;
            chrome.runtime.sendMessage({
                type: "UPDATE_COUNT",
                count: count,
                total: buttons.length,
            });
            console.log(`Pozváno: osoba č. ${index + 1}`);
        } catch (e) {
            console.error(
                `Nepodařilo se kliknout na tlačítko č. ${index + 1}`,
                e
            );
        }

        if (count > 0 && count % pauseAfterInvites === 0) {
            console.log(`Pausing for a bit after ${count} invites...`);
            await new Promise((res) => setTimeout(res, 30000)); // 30-second pause
        }
    }

    window.__inviter_running = false;

    if (window.__inviter_stop) {
        console.log(`Zastaveno uživatelem. Pozváno ${count} osob.`);
    } else {
        alert(`Hotovo. Pozváno ${count} osob.`);
    }
}
