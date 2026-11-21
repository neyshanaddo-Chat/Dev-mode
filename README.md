# Dev mode

Your dev mode tool from Ai-Tools, as its own app. Open **any website folder on your PC**, see it in a private preview, and change anything: click things on the page and edit them, or edit the code itself. Every change saves straight into the files in that folder. Nothing is uploaded or published.

## Open it

**https://neyshanaddo-chat.github.io/Dev-mode/** (on your laptop, in Microsoft Edge or Google Chrome)

1. Click **📂 Open a site folder** and pick a site's folder, e.g. `Documents\GitHub\Ai-Tools`. Press **Allow** / **Edit files** when the browser asks.
2. Next time, your sites are listed on the first screen. Click one to open it again.
3. **Install it as an app (once):** click the install button in the address bar (or `…` → **Apps → Install Dev mode**). It gets its own icon and opens in its own window.

The page comes from GitHub, but your site files never leave your PC: Dev mode reads and saves them in the folder you pick.

**Without the internet:** double-click **`Start Dev mode.cmd`** in this folder. It runs Dev mode at http://localhost:5178 on this PC only.

## Menu

Built on the website starter: ☰ menu with Home (the Dev mode tool) · Gallery · Our Values · Contact Us · Settings (Light / Dark) · About. 3 colours (background, text, accent), works offline, and updates itself when a new version is published.

## What you can do

| | |
|---|---|
| 🎯 **Inspect** (Ctrl + Shift + D) | Click anything on the page to select it. Esc stops. |
| **Selected** tab | Change its text, what's inside it (code), colours, text size, bold / italic, hide, line up, spacing, round corners, width, height, links / pictures (attributes). Duplicate or delete it. ↑ Parent selects the box around it. |
| **Edit on page** | Type straight onto the page. Enter saves, Esc cancels. |
| **&lt;/&gt; Code** | Jumps to the exact line of the selected item. Edit any file, Ctrl + S saves. Ctrl + F finds / replaces. |
| **Styles from CSS** | Click a rule to jump to it in the CSS. |
| **Files** | Every file in the site. ＋ new file, 🗑 delete, “Search inside all files” (Ctrl + Shift + F). |
| **↶ Undo** | Puts back the last save, one step at a time (also brings back deleted files). |
| 🖥 💻 📱 | See the page at computer, tablet or phone size. |
| 📝 **Requests** | Write changes you'd like Claude to make, then 📋 Copy all and paste into Claude. Each request includes the page, the item and its line in the code. |
| **Auto refresh** | When Claude (or anything else) changes a file, the preview updates by itself. |

## Good to know

- Your public website only changes when you **commit and push** with GitHub Desktop. Dev mode never publishes.
- The site's own service worker is switched off inside the preview, so you always see the files as they are now.
- Parts of a page made by a script (not written in the HTML) can be seen and inspected, but are changed in the code or with a 📝 request.
- The old `dev.js` in Ai-Tools still works the old way if you open `index.html` straight from the folder.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.css`, `app.js` | The app |
| `inspect.js` | Added to the preview only, so you can click and select things |
| `sw.js` | Serves the preview from your folder, and lets the app open offline |
| `version.json` | The version number; bump it together with `APP_VERSION` in index.html on every change |
| `Start Dev mode.cmd`, `devmode-server.ps1` | The launcher (runs the app at http://localhost:5178, only on this PC) |
