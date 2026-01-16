chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "START") {
        chrome.storage.local.set({ isRunning: true });
    }
    if (request.type === "STOP") {
        chrome.storage.local.set({ isRunning: false });
    }
    if (request.type === "GET_STATE") {
        chrome.storage.local.get("isRunning", (data) => {
            sendResponse({ isRunning: data.isRunning });
        });
        return true; // Indicates that the response is sent asynchronously
    }
});
