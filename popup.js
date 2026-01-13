document.getElementById("startBtn").addEventListener("click", async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: autoInviteAction,
    });
});

// This function runs INSIDE the Facebook page
async function autoInviteAction() {
    const buttons = Array.from(
        document.querySelectorAll('div[aria-label="Pozvat"]')
    );
    if (buttons.length === 0) {
        alert(
            "No 'pozvat' buttons found. Make sure the reaction list is open!"
        );
        return;
    }

    let count = 0;
    for (let index = 0; index < buttons.length; index++) {
        const btn = buttons[index];

        // Random delay 2-5s before action
        const delay = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
        await new Promise((res) => setTimeout(res, delay));

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
                `Button #${index + 1} is no longer in the DOM, skipping.`
            );
            continue;
        }

        try {
            btn.click();
            count++;
            console.log(`Invited person #${index + 1}`);
        } catch (e) {
            console.error(`Failed to click button #${index + 1}`, e);
        }
    }

    alert(`Finished. Invited ${count} people.`);
}
