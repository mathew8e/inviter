console.log("popup.js loaded");
const statusEl = document.getElementById("status");
let isRunning = false;
chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (statusEl) statusEl.textContent = response.isRunning;
    isRunning = response.isRunning;
});

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
if (stopBtn) stopBtn.disabled = true;

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

        // Read input value from the popup DOM and pass it into the page function
        const inputValue =
            (document.getElementById("string") &&
                document.getElementById("string").value) ||
            "";
        console.log("Start clicked, input:", inputValue);

        try {
            // Clear stop flag and mark running on the page
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    window.__inviter_stop = false;
                    window.__inviter_running = true;
                },
            });

            // Update UI state - DISABLE START BUTTON
            startBtn.disabled = true;
            if (stopBtn) stopBtn.disabled = false;
            if (statusEl) statusEl.textContent = "Inviting started...";

            // Run the long-running function (will resolve when finished or stopped)
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: autoInviteAction,
                args: [inputValue],
            });
            console.log("Content script finished");
            if (statusEl) statusEl.textContent = "Finished";
        } catch (err) {
            console.error("executeScript failed:", err);
            if (statusEl)
                statusEl.textContent = "Error: " + (err && err.message);
        } finally {
            // RE-ENABLE START BUTTON WHEN DONE
            startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
        }
    });

    // Stop button
    if (stopBtn) {
        stopBtn.addEventListener("click", async () => {
            console.log("Stop button clicked");
            if (statusEl) statusEl.textContent = "Stop requested...";
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
    async function autoInviteAction(inputString) {
        // inputString is passed from the popup (can't access popup DOM from the page)
        const string = (inputString || "") + "";
        console.log(`running with ${string}`);

        const searchText = string.trim().toLowerCase();
        if (!searchText) {
            alert("Prosím zadejte text, který chcete vyhledat.");
            return;
        }

        // Find buttons that contain at least one div whose text matches the search string (recursive by using querySelectorAll on divs)
        const buttons = Array.from(document.querySelectorAll("div")).filter(
            (btn) => {
                const divs = btn.querySelectorAll("div");
                for (const d of divs) {
                    if (
                        d.textContent &&
                        d.textContent.toLowerCase().includes(searchText)
                    )
                        return true;
                }
                return false;
            }
        );

        if (buttons.length === 0) {
            alert(
                `Nebyly nalezeny žádné tlačítka '${string}'. Ujistěte se, že je seznam reakcí otevřený!`
            );
            return;
        }

        // Ensure the stop flag exists
        if (typeof window.__inviter_stop === "undefined")
            window.__inviter_stop = false;
        window.__inviter_running = true;

        let count = 0;
        for (let index = 0; index < buttons.length; index++) {
            // Check stop flag before each iteration
            if (window.__inviter_stop) {
                console.log("Inviter stopped by user");
                break;
            }

            const btn = buttons[index];

            // Random delay 2-5s before action
            const delay = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
            await new Promise((res) => setTimeout(res, delay));

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
                console.warn(
                    `Tlačítko č. ${index + 1} už není v DOM, přeskočeno.`
                );
                continue;
            }

            try {
                btn.click();
                count++;
                console.log(`Pozváno: osoba č. ${index + 1}`);
            } catch (e) {
                console.error(
                    `Nepodařilo se kliknout na tlačítko č. ${index + 1}`,
                    e
                );
            }
        }

        window.__inviter_running = false;

        if (window.__inviter_stop) {
            alert(`Zastaveno uživatelem. Pozváno ${count} osob.`);
        } else {
            alert(`Hotovo. Pozváno ${count} osob.`);
        }
    }
}
