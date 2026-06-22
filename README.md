# Rise 360 Bulk Export

A Tampermonkey userscript that automates bulk-exporting Articulate Rise 360 courses
as Web (HTML) and/or LMS (SCORM) packages across multiple subfolders.

## Requirements

- [Tampermonkey](https://www.tampermonkey.net/) browser extension
- Access to [Articulate Rise 360](https://rise.articulate.com) or [app.rise.com](https://app.rise.com)
- Microsoft Edge or Chrome with automatic downloads enabled for the Rise domain

## Installation

### Option 1 — Install directly (recommended)

Click the link below while Tampermonkey is installed and it will prompt you to install
the script automatically:

[Install Rise 360 Bulk Export](https://raw.githubusercontent.com/sp00kman1337/Rise-Exporter/main/rise-bulk-export.user.js)

### Option 2 — Manual install with auto-update

If you already have a version of the script installed manually, add these two lines
to the Tampermonkey header to link it to this repository for automatic updates:

```js
// @updateURL    https://raw.githubusercontent.com/sp00kman1337/Rise-Exporter/main/rise-bulk-export.user.js
// @downloadURL  https://raw.githubusercontent.com/sp00kman1337/Rise-Exporter/main/rise-bulk-export.user.js
```

Tampermonkey will check for updates automatically and prompt you whenever a new
version is available.

## Browser Setup

Edge blocks multiple automatic downloads by default. Before running an export, whitelist
the Rise domain:

1. Navigate to `edge://settings/content/automaticDownloads`
2. Add `https://rise.articulate.com` to the **Allow** list

## Usage

1. Navigate to a **parent folder** in Rise 360 (the folder that contains subfolders as cards)
2. Click **Scan Folders** in the panel — checkboxes appear for each subfolder found
3. Deselect any folders you want to skip
4. Choose your export format: **Web (HTML)**, **LMS (SCORM)**, or **Both**
5. Click **Start Export**
6. The script processes each folder and course automatically, logging progress in the panel
7. Click **Stop** at any time to abort and clear state

Downloaded ZIP files will appear in your browser's default downloads folder using
Rise's default file naming.

## Export Formats

| Format | Description |
|---|---|
| Web (HTML) | Publishes each course as a standalone HTML zip |
| LMS (SCORM) | Publishes each course as a SCORM 1.2 package with preconfigured settings |
| Both | Runs both exports for every course in sequence |

### LMS Settings Applied Automatically

When exporting as LMS, the script configures the following settings on the publish page:

| Setting | Value |
|---|---|
| LMS Format | SCORM 1.2 |
| Reporting | Complete / Incomplete |
| Exit microlearning link | OFF |
| Hide cover page | ON |
| Reset progress after updates | OFF |
| Only load in LMS | ON |

## Configuration

Timing values can be adjusted at the top of the script in the `DELAYS` object if you
experience issues on slower connections:

```js
const DELAYS = {
  beforeMenuClick: 800,      // ms before clicking the "..." menu
  afterMenuClick: 600,       // ms after clicking "..." for menu to appear
  afterPublishHover: 500,    // ms after hovering Publish for submenu
  publishTimeout: 120000,    // max ms to wait for publish (2 min)
  afterBack: 3000,           // ms after clicking Back for page to load
  afterFolderClick: 2000,    // ms after clicking a folder for content to load
  betweenCourses: 2000,      // ms pause between courses
  betweenFolders: 2000,      // ms pause between folders
};
```

## Known Limitations

- Downloads use Rise's default file naming — files are not renamed automatically
- Only handles one level of folder nesting (parent → subfolder → courses)
- If a publish fails mid-export, the script skips that course and continues
- Requires the user to be inside a parent folder view before scanning

## Version History

| Version | Notes |
|---|---|
| 3.3 | OLIVE/BootStream UI styling, GitHub auto-update support |
| 3.2 | Security hardening, redundancy fixes |
| 3.1 | Removed prefix feature, added instructions panel |
| 3.0 | LMS/SCORM export support |
