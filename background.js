let isRunning = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "START") isRunning = true;
    if (request.type === "STOP") isRunning = false;
    if (request.type === "GET_STATE") sendResponse({ isRunning });
});
