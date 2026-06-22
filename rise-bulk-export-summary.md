# Rise 360 Bulk Export — Tampermonkey Script (v2)

## Purpose

Automates the export of Rise 360 courses as Web (HTML) zip files across multiple subfolders. The user navigates to a parent folder in Rise 360 (e.g., "2025 Updates"), selects which subfolders to process, and the script exports every course in each subfolder via the Publish > Web workflow.

## Target URLs

- `https://rise.articulate.com/*`
- `https://app.rise.com/*`

## Tampermonkey Grants

`GM_addStyle`, `GM_setValue`, `GM_getValue`, `GM_deleteValue`

---

## Architecture: Persistent State Machine

The core design challenge is that clicking **Publish > Web** and clicking **Back** both cause full page navigations, which restart the Tampermonkey script. The script uses `GM_setValue`/`GM_getValue` to persist its state across these reloads.

### Phases

| Phase | Description |
|---|---|
| `IDLE` | No export running |
| `ENTERING_SUBFOLDER` | Script navigated to the parent folder and needs to click into a subfolder |
| `IN_SUBFOLDER` | Inside a subfolder, processing course cards (SPA navigation, no reload) |
| `ON_PUBLISH_PAGE` | Full page navigation happened after clicking "Web"; script restarts and needs to click Download, wait for success, then click Back |
| `BACK_TO_FOLDER` | Full page navigation after clicking Back; script restarts and continues with the next course |

### Persisted State Object

Stored via `GM_setValue('rbe_state', ...)`:

```json
{
  "phase": "ON_PUBLISH_PAGE",
  "active": true,
  "prefix": "daa_",
  "parentFolderUrl": "https://rise.articulate.com/manage/folder/...",
  "selectedFolders": [
    { "name": "Lesson 01: Beginning Your OneStream Project", "href": "https://..." }
  ],
  "currentFolderIndex": 0,
  "currentCourseIndex": 0,
  "currentFolderUrl": "https://...",
  "totalExported": 3,
  "totalFailed": 0
}
```

Log entries are also persisted via `GM_setValue('rbe_log', ...)` so the progress log survives page reloads.

---

## Export Flow Per Course

1. **In subfolder view** (SPA, no reload): hover card → click `button[data-ba="content.dropDownMenu.menuButton"]` → hover `li[data-ba="content.dropDownMenu.publish"]` → click "Web" in submenu `ul[role="menu"]`
2. **Save state** as `ON_PUBLISH_PAGE` just before clicking "Web"
3. **Page navigates** to publish settings → script restarts → detects `ON_PUBLISH_PAGE`
4. **Poll for Download button** (up to 30s, checking every 1s for a `<button>` with text "Download")
5. **Click Download** → poll for "Publish Successful" text (up to 2 min)
6. **Save state** as `BACK_TO_FOLDER`, increment `currentCourseIndex`
7. **Click Back** button (or fall back to `history.back()`)
8. **Page navigates** to folder → script restarts → detects `BACK_TO_FOLDER` → continues next course

### Between Folders

When all courses in a subfolder are exported, the script navigates back to the parent folder URL, sets phase to `ENTERING_SUBFOLDER`, increments `currentFolderIndex`, and clicks into the next selected subfolder.

---

## DOM Selectors (confirmed from live DOM inspection)

| Element | Selector |
|---|---|
| Main content area | `#current-content` |
| Sidebar (excluded) | `[data-ba="sidebar_container"]` |
| Breadcrumbs (excluded) | `[data-ba="breadcrumbs_container"]`, `[aria-label="Breadcrumbs"]` |
| Course cards | `[data-ba="create_courseCard"]` with `data-ba-name` (title) and `data-ba-course-id` |
| Card "..." button | `button[data-ba="content.dropDownMenu.menuButton"]` (only visible on hover) |
| Publish menu item | `li[data-ba="content.dropDownMenu.publish"]` |
| Submenu (Web/PDF/LMS) | Nested `ul[role="menu"]`, items are `[role="menuitem"]` |
| Download button (publish page) | `<button>` containing text "Download", also has `data-hierarchy="primary"` |
| Back button (publish page) | Matched by exact text "Back" |

---

## Hover Visibility Workaround

The "..." menu button on course cards only appears on hover. Simulated hover events (MouseEvent + PointerEvent) don't reliably trigger React's state updates. The script works around this with a CSS override injected via `GM_addStyle`:

```css
.rbe-export-active [data-ba="content.dropDownMenu.menuButton"],
.rbe-export-active [class*="block-view-item-common_menu"],
.rbe-export-active [class*="menu_item"] > button {
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
}
```

The class `rbe-export-active` is toggled on `<body>` when the export is running.

### Hover Simulation

The script dispatches both PointerEvents (for React 17+) and MouseEvents:

```javascript
el.dispatchEvent(new PointerEvent('pointerover', opts));
el.dispatchEvent(new PointerEvent('pointerenter', opts));
el.dispatchEvent(new PointerEvent('pointermove', opts));
el.dispatchEvent(new MouseEvent('mouseover', opts));
el.dispatchEvent(new MouseEvent('mouseenter', opts));
el.dispatchEvent(new MouseEvent('mousemove', opts));
```

---

## Folder Scanning

Scans `<a>` tags inside `#current-content`, excluding sidebar, breadcrumbs, course cards, and the script's own panel.

### Strategy

1. Uses a `TreeWalker` to find the "Folders (N)" text node inside the content area
2. Walks up the parent tree (up to 12 levels) to find the container holding folder card links
3. At each level, queries all `<a>` tags and applies exclusion filters
4. Falls back to a broad scan of all links in the content area

### Exclusion Filters

- `[data-ba="sidebar_container"]` — left sidebar navigation tree
- `[data-ba="breadcrumbs_container"]` / `[aria-label="Breadcrumbs"]` — breadcrumb path links
- `[data-ba="create_courseCard"]` — course cards (not folders)
- `#rbe-panel` — the script's own UI panel
- Text filters: empty names, "New Folder", names starting with "+"

---

## Course Card Scanning

### Primary Strategy

```javascript
contentArea.querySelectorAll('[data-ba="create_courseCard"]')
```

Each card element has:
- `data-ba-name` — the course title
- `data-ba-course-id` — the Rise course ID

### Fallback

Scans `li[role="listitem"]` elements that contain a title element and a type badge ("Microlearning" or "Course").

---

## UI Panel

A floating, draggable panel (fixed position, top-right, z-index 99999) with:

- **Prefix input** — e.g., `daa_` (stored in state, logged as reminder)
- **Scan Folders button** — reads folder cards from the current page
- **Folder checkboxes** — select/deselect with "Select all" / "Select none" links
- **Start Export** / **Stop** buttons — Stop is always enabled so stale state can be cleared
- **Log panel** — scrollable monospace log with color-coded entries (info, success, warn, error)

The panel header is draggable. The panel can be collapsed/expanded via the "−" / "+" toggle button.

---

## Timing Configuration

All delays are configurable at the top of the script in the `DELAYS` object:

```javascript
const DELAYS = {
  beforeMenuClick: 800,      // ms after hovering before clicking "..."
  afterMenuClick: 600,       // ms after clicking "..." for menu to appear
  afterPublishHover: 500,    // ms after hovering "Publish" for submenu
  pollInterval: 1000,        // ms between poll checks
  publishTimeout: 120000,    // max ms to wait for publish (2 min)
  afterBack: 3000,           // ms after clicking "Back" for page to load
  afterFolderClick: 2000,    // ms after clicking a folder for content to load
  betweenCourses: 1500,      // ms pause between courses
  betweenFolders: 2000,      // ms pause between folders
};
```

---

## File Naming

The script does **not** rename downloaded files. Rise auto-downloads zips with its default naming convention. The prefix (e.g., `daa_`) is stored in state and logged as a reminder for the user to batch-rename afterward.

---

## Browser Configuration

Microsoft Edge blocks multiple automatic downloads by default. The user must whitelist the Rise domain:

1. Navigate to `edge://settings/content/automaticDownloads`
2. Add `https://rise.articulate.com` to the **Allow** list

---

## Known Limitations / Areas to Iterate

1. **File renaming** — downloads use Rise's default filenames; the prefix isn't applied automatically. Could potentially intercept via `GM_download` or a download observer.
2. **Edge download blocking** — requires manual whitelist (see above).
3. **Error recovery** — if a publish fails mid-way, the script increments the course index and moves on. Could be more graceful about retries.
4. **Folder card detection** — on some Rise views, folder cards might not be standard `<a>` tags. The scan has multiple fallback strategies but may need adjustment.
5. **Timing** — delays are hardcoded. Slow connections may need larger values in the `DELAYS` config.
6. **Hover simulation** — relies on CSS override to force-show the "..." button. If Rise changes its class names, the CSS selectors will need updating.
7. **Subfolder depth** — the script handles one level of nesting (parent folder → subfolder → courses). Deeper nesting would need additional logic.

---

## Usage

1. Install the script in Tampermonkey
2. Navigate to the **parent folder** in Rise 360 (the one that contains subfolders as cards)
3. Enter the filename prefix in the panel
4. Click **Scan Folders** — checkboxes appear for each subfolder
5. Deselect any folders to skip
6. Click **Start Export**
7. The script processes each folder and course automatically, logging progress
8. Click **Stop** at any time to abort and clear state
