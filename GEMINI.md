# Project Overview

This is a Chrome browser extension named "FB Auto Inviter". Its purpose is to automate the process of inviting people who have reacted to a Facebook post. It's designed to be used on the list of people who have reacted to a post.

## Main Technologies

*   **Frontend:** HTML, CSS, JavaScript
*   **Browser APIs:** Chrome Extension APIs (Manifest V3) including `chrome.scripting`, `chrome.storage`, and `chrome.runtime`.

## Architecture

The extension is composed of three main parts:

1.  **Popup (`popup.html`, `popup.js`):** Provides the user interface for starting and stopping the script, as well as configuring settings like delay and invitation limits. It's the main entry point for the user.
2.  **Content Script (`autoInviteAction` function in `popup.js`):** This function is dynamically injected into the active Facebook tab when the user clicks "Start". It contains the core logic for finding invite buttons, clicking them, and scrolling the page. It communicates status updates back to the popup.
3.  **Background Service Worker (`background.js`):** A simple script that manages the `isRunning` state of the extension in `chrome.storage.local`.

## Building and Running the Extension

This is a browser extension and does not have a formal build step. To run it:

1.  Open your Chrome-based browser and navigate to `chrome://extensions`.
2.  Enable the **"Developer mode"** toggle.
3.  Click on the **"Load unpacked"** button.
4.  Select the root directory of this project (`inviter`).

To use the extension:

1.  Navigate to a Facebook page where a list of people to invite is visible in a scrollable dialog.
2.  Click the extension's icon in the browser toolbar to open the popup.
3.  Adjust the settings (delay, limit, etc.) as needed.
4.  Click the **"Start"** button.

## Development Conventions

*   **Code Style:** The project uses plain JavaScript with no transpilers or bundlers.
*   **State Management:** The running state (`isRunning`) is managed via `chrome.storage.local` to persist across popup closures.
*   **Communication:** The popup, background script, and content script communicate using `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`.
*   **Core Logic:** The main automation logic is located in the `autoInviteAction` async function within `popup.js`.
*   **Scrolling Logic:** The script identifies a scrollable element (ideally a dialog box) and iteratively invites visible users, then scrolls down to load more. It stops when it reaches the end of the list, the invitation limit is met, or the user stops it.
*   **Debugging:** The content script includes `console.log` statements for debugging the scroll element detection and invitation process. It also visually highlights the detected scrollable element with a red border during its operation.
