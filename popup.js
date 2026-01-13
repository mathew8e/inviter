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
            "Nebyly nalezeny žádné tlačítka 'Pozvat'. Ujistěte se, že je seznam reakcí otevřený!"
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
            console.warn(`Tlačítko č. ${index + 1} už není v DOM, přeskočeno.`);
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

    alert(`Hotovo. Pozváno ${count} osob.`);
}
