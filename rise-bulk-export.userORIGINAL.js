// ==UserScript==
// @name         Rise 360 Bulk Export
// @namespace    rise-bulk-export
// @version      3.0
// @description  Bulk export Rise 360 courses as Web (HTML) and/or LMS (SCORM) zips from selected folders
// @match        https://rise.articulate.com/*
// @match        https://app.rise.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const DELAYS = {
    beforeMenuClick: 800,
    afterMenuClick: 600,
    afterPublishHover: 500,
    pollInterval: 1000,
    publishTimeout: 120000,
    afterBack: 3000,
    afterFolderClick: 2000,
    betweenCourses: 1500,
    betweenFolders: 2000,
    afterSettingChange: 300,   // ms after changing a dropdown/toggle
  };

  // LMS publish-page settings to enforce
  const LMS_SETTINGS = {
    lmsFormat: 'scorm12',              // SCORM 1.2
    reporting: 'completed-incomplete', // Complete/Incomplete
    toggles: {
      'enable-exit-course': false,           // Exit microlearning link → OFF
      'disable-course-cover-page': true,     // Hide cover page → ON
      // 'enable-telemetry-collection' — don't care
      'enable-reset-learner-data': false,    // Reset progress after updates → OFF
      'load-only-in-lms': true,              // Only load in LMS → ON
    },
  };

  /*
   * STATE MACHINE — persists across page navigations via GM_setValue.
   *
   * Phases:
   *   IDLE                → no export running
   *   IN_SUBFOLDER        → on a subfolder page, processing courses (SPA nav, no reload)
   *   ON_PUBLISH_PAGE     → page navigated to publish settings, need to click Download
   *   BACK_TO_FOLDER      → clicked Back from publish, returning to subfolder
   */
  const PHASE = {
    IDLE: 'IDLE',
    IN_SUBFOLDER: 'IN_SUBFOLDER',
    ON_PUBLISH_PAGE: 'ON_PUBLISH_PAGE',
    BACK_TO_FOLDER: 'BACK_TO_FOLDER',
  };

  // ── UTILITIES ───────────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findByExactText(selector, text, parent = document) {
    const els = parent.querySelectorAll(selector);
    for (const el of els) {
      if (el.textContent.trim() === text) return el;
    }
    return null;
  }

  function hoverElement(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const mOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    const pOpts = { ...mOpts, pointerId: 1, pointerType: 'mouse', width: 1, height: 1, isPrimary: true };

    el.dispatchEvent(new PointerEvent('pointerover', pOpts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...pOpts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointermove', pOpts));
    el.dispatchEvent(new MouseEvent('mouseover', mOpts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...mOpts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', mOpts));
  }

  // ── PERSISTENT STATE ────────────────────────────────────────────────────────

  function getState() {
    try {
      return JSON.parse(GM_getValue('rbe_state', 'null')) || { phase: PHASE.IDLE };
    } catch { return { phase: PHASE.IDLE }; }
  }

  function setState(obj) {
    const current = getState();
    const merged = { ...current, ...obj };
    GM_setValue('rbe_state', JSON.stringify(merged));
    return merged;
  }

  function clearState() {
    GM_setValue('rbe_state', JSON.stringify({ phase: PHASE.IDLE }));
  }

  // ── LOGGING ─────────────────────────────────────────────────────────────────

  /** Persistent log — survives page reloads */
  function getLogEntries() {
    try { return JSON.parse(GM_getValue('rbe_log', '[]')); } catch { return []; }
  }
  function saveLogEntry(msg, type) {
    const entries = getLogEntries();
    entries.push({ msg, type, time: new Date().toLocaleTimeString() });
    // Keep last 200 entries
    if (entries.length > 200) entries.splice(0, entries.length - 200);
    GM_setValue('rbe_log', JSON.stringify(entries));
  }
  function clearLog() {
    GM_setValue('rbe_log', '[]');
  }

  function log(msg, type = 'info') {
    saveLogEntry(msg, type);
    renderLog();
    console.log(`[Rise Bulk Export] ${msg}`);
  }

  function renderLog() {
    const logEl = document.getElementById('rbe-log');
    if (!logEl) return;
    const entries = getLogEntries();
    logEl.innerHTML = entries
      .map((e) => `<div class="rbe-log-${e.type}">[${e.time}] ${e.msg}</div>`)
      .join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── DOM HELPERS ─────────────────────────────────────────────────────────────

  function getMainContentArea() {
    return document.getElementById('current-content')
      || document.querySelector('[data-ba="dashboard_container"]')
      || document.querySelector('[role="region"][data-auto-scrollable="true"]')
      || document.body;
  }

  /** Poll for a condition, returning the result when truthy */
  async function pollFor(testFn, timeout = 15000, interval = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = testFn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  // ── FOLDER SCANNING ─────────────────────────────────────────────────────────

  function scanFolders() {
    const folders = [];
    const contentArea = getMainContentArea();

    // Step 1: Find the "Folders (N)" section and get all links within it
    const walker = document.createTreeWalker(contentArea, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => /^Folders\s*\(\d+\)$/.test(n.textContent.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const textNode = walker.nextNode();

    if (textNode) {
      // Walk up parent tree to find the container holding the folder cards
      let section = textNode.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!section || section === contentArea || section === document.body) break;

        // Collect all links in this section
        section.querySelectorAll('a').forEach((link) => {
          // Only exclude: sidebar, our panel, breadcrumbs (by data-ba), course cards
          if (link.closest('[data-ba="sidebar_container"]')) return;
          if (link.closest('#rbe-panel')) return;
          if (link.closest('[data-ba="breadcrumbs_container"], [aria-label="Breadcrumbs"]')) return;
          if (link.closest('[data-ba="create_courseCard"]')) return;

          const name = link.textContent.trim();
          if (!name || name === 'New Folder' || name.startsWith('+') || /^Folders\s*\(/.test(name)) return;

          if (!folders.some((f) => f.name === name)) {
            folders.push({ name, href: link.href || '', el: link });
          }
        });

        if (folders.length > 0) break;
        section = section.parentElement;
      }
    }

    // Step 2: If still nothing, broadest scan — all links in content area
    if (folders.length === 0) {
      contentArea.querySelectorAll('a').forEach((link) => {
        if (link.closest('[data-ba="sidebar_container"]')) return;
        if (link.closest('#rbe-panel')) return;
        if (link.closest('[data-ba="breadcrumbs_container"], [aria-label="Breadcrumbs"]')) return;
        if (link.closest('[data-ba="create_courseCard"]')) return;

        const name = link.textContent.trim();
        if (!name || name === 'New Folder' || name.startsWith('+') || /^Folders\s*\(/.test(name)) return;

        if (!folders.some((f) => f.name === name)) {
          folders.push({ name, href: link.href || '', el: link });
        }
      });
    }

    return folders;
  }

  function scanCourseCards() {
    const cards = [];
    const contentArea = getMainContentArea();

    // Primary: data-ba="create_courseCard" (confirmed from DOM)
    contentArea.querySelectorAll('[data-ba="create_courseCard"]').forEach((card, i) => {
      const title = card.getAttribute('data-ba-name') || `Course ${i + 1}`;
      const courseId = card.getAttribute('data-ba-course-id') || '';
      cards.push({ title, el: card, index: i, courseId });
    });

    if (cards.length > 0) return cards;

    // Fallback: listitem with course content
    contentArea.querySelectorAll('li[role="listitem"]').forEach((item, i) => {
      const titleEl = item.querySelector('[class*="title"], h3, h4, a[class*="heading"]');
      const hasBadge = item.textContent.includes('Microlearning') || item.textContent.includes('Course');
      if (titleEl && hasBadge) {
        cards.push({ title: titleEl.textContent.trim(), el: item, index: i });
      }
    });

    return cards;
  }

  // ── EXPORT: CARD MENU ───────────────────────────────────────────────────────

  async function openCardMenu(cardEl) {
    log(`    Looking for "..." on: "${cardEl.getAttribute('data-ba-name') || 'unknown'}"`, 'info');

    // Try finding the button (CSS override forces visibility)
    let menuBtn = cardEl.querySelector('button[data-ba="content.dropDownMenu.menuButton"]');

    if (!menuBtn) {
      hoverElement(cardEl);
      await sleep(DELAYS.beforeMenuClick);
      menuBtn = cardEl.querySelector('button[data-ba="content.dropDownMenu.menuButton"]');
    }

    if (!menuBtn) {
      menuBtn = cardEl.querySelector('button[aria-haspopup="true"]');
    }

    if (!menuBtn) {
      // Force-show all child divs
      cardEl.querySelectorAll('div').forEach((d) => { d.style.opacity = '1'; d.style.visibility = 'visible'; });
      await sleep(500);
      menuBtn = cardEl.querySelector('button[data-ba="content.dropDownMenu.menuButton"]')
        || cardEl.querySelector('button[aria-haspopup]');
    }

    if (!menuBtn) {
      const btns = cardEl.querySelectorAll('button');
      log(`    DEBUG: ${btns.length} buttons in card`, 'warn');
      btns.forEach((b, i) => log(`      [${i}] data-ba="${b.getAttribute('data-ba')}" text="${b.textContent.trim().slice(0, 30)}"`, 'warn'));
      throw new Error('Could not find "..." menu button');
    }

    // Safety: don't click breadcrumb buttons
    if (menuBtn.closest('[class*="breadcrumb"]') || menuBtn.closest('[data-ba="dropdownMenu_menuAnchor"]')) {
      throw new Error('Found breadcrumb menu button, not card menu. Aborting.');
    }

    log(`    Clicking "..."`, 'info');
    menuBtn.click();
    await sleep(DELAYS.afterMenuClick);
  }

  async function clickPublishFormat(format = 'web') {
    const menuLabel = format === 'lms' ? 'LMS' : 'Web';

    // Find Publish menu item
    const publishItem = await pollFor(() => {
      return document.querySelector('li[data-ba="content.dropDownMenu.publish"]')
        || findByExactText('[role="menuitem"]', 'Publish');
    }, 5000, 300);

    if (!publishItem) throw new Error('Could not find "Publish" menu item');

    log(`    Hovering "Publish"...`, 'info');
    hoverElement(publishItem);
    await sleep(DELAYS.afterPublishHover);

    // Find target format in submenu
    const targetItem = await pollFor(() => {
      const menus = document.querySelectorAll('ul[role="menu"]');
      for (const menu of menus) {
        for (const item of menu.querySelectorAll('[role="menuitem"]')) {
          if (item.textContent.trim() === menuLabel) return item;
        }
      }
      return null;
    }, 5000, 300);

    if (!targetItem) throw new Error(`Could not find "${menuLabel}" submenu item`);

    log(`    Clicking "${menuLabel}" (will navigate to publish page)...`, 'info');

    // *** SAVE STATE BEFORE NAVIGATION — the page will reload ***
    setState({ phase: PHASE.ON_PUBLISH_PAGE });

    targetItem.click();
    // Script will restart on the new page — execution stops here.
  }

  // ── FORMAT HELPERS ──────────────────────────────────────────────────────

  /** Determine which format we're currently exporting */
  function getCurrentFormat() {
    const state = getState();
    const formats = state.exportFormats || ['web'];
    const idx = state.currentFormatIndex || 0;
    return formats[idx] || 'web';
  }

  /** After a successful or failed export, decide whether to advance format or course */
  function advanceAfterExport(succeeded) {
    const state = getState();
    const formats = state.exportFormats || ['web'];
    const formatIdx = state.currentFormatIndex || 0;

    const updates = {
      phase: PHASE.BACK_TO_FOLDER,
    };

    if (succeeded) {
      updates.totalExported = (state.totalExported || 0) + 1;
    } else {
      updates.totalFailed = (state.totalFailed || 0) + 1;
    }

    // More formats left for this course?
    if (formatIdx + 1 < formats.length) {
      updates.currentFormatIndex = formatIdx + 1;
      // Don't increment courseIndex — same course, next format
    } else {
      updates.currentFormatIndex = 0;
      updates.currentCourseIndex = (state.currentCourseIndex || 0) + 1;
    }

    return updates;
  }

  // ── LMS SETTINGS CONFIGURATION ──────────────────────────────────────────

  /** Click "More settings" if visible, to reveal all toggles */
  async function expandMoreSettings() {
    // Look for any element whose visible text says "More settings"
    const candidates = document.querySelectorAll(
      '[class*="export-settings"] *, [class*="settings-label"] *'
    );
    let moreLink = null;
    for (const el of candidates) {
      if (/^more settings$/i.test(el.textContent.trim()) && el.children.length === 0) {
        moreLink = el;
        break;
      }
    }
    // Broader fallback — any clickable text
    if (!moreLink) {
      moreLink = findByExactText('div, span, a, button', 'More settings');
    }
    if (moreLink) {
      log(`    Expanding "More settings"...`, 'info');
      moreLink.click();
      await sleep(DELAYS.afterSettingChange);
    }
  }

  /** Set a <select> dropdown to a specific value, triggering React's change handler */
  function setSelectValue(selectEl, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    nativeSetter.call(selectEl, value);
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Set a checkbox toggle to a desired checked state */
  function setToggle(inputEl, desired) {
    if (inputEl.checked === desired) return;
    // Try clicking the label (Rise uses custom switch components)
    const label = inputEl.closest('label') || document.querySelector(`label[for="${inputEl.id}"]`);
    if (label) {
      label.click();
    } else {
      // Direct fallback
      inputEl.click();
    }
  }

  /** Configure all LMS publish settings before clicking Download */
  async function configureLmsSettings() {
    log(`  Waiting for LMS settings to load...`, 'info');

    // Poll for the LMS format dropdown — it's the most reliable signal the page is ready
    const lmsFormatSelect = await pollFor(() => {
      const selects = document.querySelectorAll('select[class*="dropdown"]');
      return selects.length >= 1 ? selects[0] : null;
    }, 30000, 1000);

    if (!lmsFormatSelect) {
      log(`  ⚠ LMS settings never loaded (no dropdown found after 30s)`, 'error');
      return;
    }

    log(`  Configuring LMS settings...`, 'info');

    // Expand "More settings" first so all toggles are visible
    await expandMoreSettings();
    await sleep(500);

    // 1. LMS Format dropdown
    if (lmsFormatSelect.value !== LMS_SETTINGS.lmsFormat) {
      log(`    Setting LMS format → SCORM 1.2`, 'info');
      setSelectValue(lmsFormatSelect, LMS_SETTINGS.lmsFormat);
      await sleep(DELAYS.afterSettingChange);
    } else {
      log(`    LMS format already SCORM 1.2 ✓`, 'info');
    }

    // 2. Reporting dropdown (re-query after expand in case DOM shifted)
    const selects = document.querySelectorAll('select[class*="dropdown"]');
    if (selects.length >= 2) {
      const reportingSelect = selects[1];
      if (reportingSelect.value !== LMS_SETTINGS.reporting) {
        log(`    Setting Reporting → Complete/Incomplete`, 'info');
        setSelectValue(reportingSelect, LMS_SETTINGS.reporting);
        await sleep(DELAYS.afterSettingChange);
      } else {
        log(`    Reporting already Complete/Incomplete ✓`, 'info');
      }
    } else {
      log(`    ⚠ Could not find Reporting dropdown`, 'warn');
    }

    // 3. Toggle switches (by input ID) — poll briefly for each
    for (const [inputId, desired] of Object.entries(LMS_SETTINGS.toggles)) {
      const input = await pollFor(() => document.getElementById(inputId), 5000, 500);
      if (input) {
        const label = inputId.replace(/-/g, ' ').replace(/^(enable|disable)\s/, '');
        if (input.checked !== desired) {
          log(`    Setting "${label}" → ${desired ? 'ON' : 'OFF'}`, 'info');
          setToggle(input, desired);
          await sleep(DELAYS.afterSettingChange);
        } else {
          log(`    "${label}" already ${desired ? 'ON' : 'OFF'} ✓`, 'info');
        }
      } else {
        log(`    ⚠ Could not find toggle #${inputId}`, 'warn');
      }
    }

    log(`  LMS settings configured`, 'success');
  }

  // ── EXPORT: PUBLISH PAGE (runs after page reload) ───────────────────────────

  async function handlePublishPage() {
    const currentFormat = getCurrentFormat();
    log(`  On publish page (${currentFormat.toUpperCase()}) — waiting for Download button...`, 'info');

    // If LMS, configure settings before clicking Download
    if (currentFormat === 'lms') {
      await configureLmsSettings();
    }

    // Poll for the Download button (page may still be loading)
    const downloadBtn = await pollFor(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Download') return btn;
      }
      return null;
    }, 30000, 1000);

    if (!downloadBtn) {
      log(`  ✗ Could not find Download button — aborting this course`, 'error');
      navigateBackToFolder();
      return;
    }

    await sleep(500);
    log(`  Clicking "Download"...`, 'info');
    downloadBtn.click();

    // Wait for "Publish Successful"
    log(`  Publishing... (waiting up to ${DELAYS.publishTimeout / 1000}s)`, 'info');
    const success = await pollFor(
      () => document.body.innerText.includes('Publish Successful') ? true : null,
      DELAYS.publishTimeout,
      2000
    );

    if (success) {
      log(`  ✓ Published (${currentFormat.toUpperCase()}) successfully — zip auto-downloaded`, 'success');
    } else {
      log(`  ✗ Publish timed out`, 'error');
    }

    setState(advanceAfterExport(!!success));

    // Click Back — this will navigate and restart the script
    log(`  Clicking "Back"...`, 'info');
    const backBtn = await pollFor(
      () => findByExactText('button, a, [role="button"]', 'Back'),
      10000, 500
    );
    if (backBtn) {
      backBtn.click();
    } else {
      log(`  ✗ Could not find Back button, using browser back`, 'warn');
      window.history.back();
    }
  }

  function navigateBackToFolder() {
    const state = getState();
    setState({ phase: PHASE.BACK_TO_FOLDER });
    if (state.currentFolderUrl) {
      window.location.href = state.currentFolderUrl;
    } else {
      window.history.back();
    }
  }

  // ── EXPORT: FOLDER PAGE (runs after page reload or SPA nav) ─────────────────

  async function handleBackToFolder() {
    const state = getState();

    // Wait for the page to settle
    await sleep(DELAYS.afterBack);

    // Check if we're on the right folder page
    log(`  Back on folder page. Course index: ${state.currentCourseIndex}`, 'info');

    // Update phase
    setState({ phase: PHASE.IN_SUBFOLDER });

    // Continue processing courses in this folder
    await processCourses();
  }

  async function processCourses() {
    const state = getState();
    const courseIndex = state.currentCourseIndex || 0;
    const currentFormat = getCurrentFormat();

    // Wait for content to load
    await sleep(2000);

    const cards = scanCourseCards();
    log(`  Found ${cards.length} course(s), continuing from index ${courseIndex}`, 'info');

    if (courseIndex >= cards.length) {
      // Done with this folder — move to next
      log(`  ✓ Folder complete`, 'success');
      await moveToNextFolder();
      return;
    }

    // Process the current course
    const card = cards[courseIndex];
    const formatLabel = currentFormat.toUpperCase();
    log(`  Exporting [${courseIndex + 1}/${cards.length}] (${formatLabel}): "${card.title}"`, 'info');

    try {
      await openCardMenu(card.el);
      await clickPublishFormat(currentFormat);
      // ^^^ This saves state and navigates — execution stops here
    } catch (err) {
      log(`  ✗ Error: ${err.message}`, 'error');
      // Skip this course (all remaining formats), move to next
      setState({
        currentCourseIndex: courseIndex + 1,
        currentFormatIndex: 0,
        totalFailed: (state.totalFailed || 0) + 1,
      });
      // Try next course after a pause
      await sleep(2000);
      await processCourses();
    }
  }

  async function moveToNextFolder() {
    const state = getState();
    const nextFolderIndex = (state.currentFolderIndex || 0) + 1;
    const selectedFolders = state.selectedFolders || [];

    if (nextFolderIndex >= selectedFolders.length) {
      // All done!
      log(`\n═══ DONE ═══`, 'info');
      log(`Exported: ${state.totalExported || 0} | Failed: ${state.totalFailed || 0}`, (state.totalFailed || 0) > 0 ? 'warn' : 'success');
      if (state.prefix) {
        log(`⚠ Remember to rename downloaded zips with prefix "${state.prefix}"`, 'warn');
      }
      clearState();
      document.body.classList.remove('rbe-export-active');
      updateButtons();
      return;
    }

    // Navigate to parent folder first, then click into next subfolder
    const nextFolder = selectedFolders[nextFolderIndex];
    log(`📂 Next folder: "${nextFolder.name}"`, 'info');

    setState({
      currentFolderIndex: nextFolderIndex,
      currentCourseIndex: 0,
      currentFormatIndex: 0,
      phase: PHASE.IN_SUBFOLDER,
    });

    // Navigate to parent and then into the folder
    if (state.parentFolderUrl) {
      window.location.href = state.parentFolderUrl;
      // Wait for parent page to load, then click folder
      // But this will restart the script... we need to handle this
      // Store that we need to enter a subfolder
      setState({ phase: PHASE.ENTERING_SUBFOLDER });
    }
  }

  async function handleEnteringSubfolder() {
    const state = getState();
    const selectedFolders = state.selectedFolders || [];
    const folderIndex = state.currentFolderIndex || 0;
    const targetFolder = selectedFolders[folderIndex];

    if (!targetFolder) {
      log('No more folders to process', 'warn');
      clearState();
      updateButtons();
      return;
    }

    await sleep(DELAYS.afterFolderClick);

    log(`📂 Entering folder: "${targetFolder.name}"`, 'info');

    // Find and click the folder
    const folders = scanFolders();
    const folder = folders.find((f) => f.name === targetFolder.name);

    if (folder) {
      setState({
        phase: PHASE.IN_SUBFOLDER,
        currentFolderUrl: folder.href,
      });
      folder.el.click();
      await sleep(DELAYS.afterFolderClick);
      await processCourses();
    } else {
      log(`  Could not find folder "${targetFolder.name}" — skipping`, 'error');
      setState({
        currentFolderIndex: folderIndex + 1,
        currentCourseIndex: 0,
        phase: PHASE.ENTERING_SUBFOLDER,
      });
      await handleEnteringSubfolder();
    }
  }

  // ── START EXPORT ────────────────────────────────────────────────────────────

  async function startExport() {
    const prefix = document.getElementById('rbe-prefix').value.trim();
    const checkboxes = document.querySelectorAll('.rbe-folder-cb:checked');
    const selectedNames = Array.from(checkboxes).map((cb) => cb.value);

    if (selectedNames.length === 0) {
      log('No folders selected!', 'error');
      return;
    }

    // Read export format selection
    const formatRadio = document.querySelector('input[name="rbe-format"]:checked');
    const formatChoice = formatRadio ? formatRadio.value : 'web';
    let exportFormats;
    if (formatChoice === 'both') {
      exportFormats = ['web', 'lms'];
    } else {
      exportFormats = [formatChoice];
    }

    // Build folder list with hrefs
    const allFolders = scanFolders();
    const selectedFolders = selectedNames.map((name) => {
      const f = allFolders.find((x) => x.name === name);
      return f ? { name: f.name, href: f.href } : null;
    }).filter(Boolean);

    if (selectedFolders.length === 0) {
      log('Could not find selected folders in DOM', 'error');
      return;
    }

    clearLog();
    const fmtLabel = exportFormats.map((f) => f.toUpperCase()).join(' + ');
    log(`Starting export of ${selectedFolders.length} folder(s) as ${fmtLabel} with prefix "${prefix}"`, 'info');

    // Save full state
    setState({
      phase: PHASE.ENTERING_SUBFOLDER,
      active: true,
      prefix,
      exportFormats,
      currentFormatIndex: 0,
      parentFolderUrl: window.location.href,
      selectedFolders,
      currentFolderIndex: 0,
      currentCourseIndex: 0,
      totalExported: 0,
      totalFailed: 0,
    });

    document.body.classList.add('rbe-export-active');
    updateButtons();

    // Start by entering the first subfolder
    await handleEnteringSubfolder();
  }

  function stopExport() {
    log('⏹ Export stopped by user', 'warn');
    clearState();
    document.body.classList.remove('rbe-export-active');
    updateButtons();
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  GM_addStyle(`
    /* Force card menu buttons visible during export */
    .rbe-export-active [data-ba="content.dropDownMenu.menuButton"],
    .rbe-export-active [class*="block-view-item-common_menu"],
    .rbe-export-active [class*="menu_item"] > button {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }

    #rbe-panel {
      position: fixed;
      top: 60px;
      right: 16px;
      width: 340px;
      max-height: calc(100vh - 80px);
      background: #fff;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      color: #333;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #rbe-panel.rbe-collapsed #rbe-body { display: none; }
    #rbe-panel.rbe-collapsed { width: auto; }

    #rbe-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #1a1a1a; color: #fff;
      cursor: move; user-select: none; flex-shrink: 0;
    }
    #rbe-header span { font-weight: 600; font-size: 13px; }
    #rbe-toggle-btn { background: none; border: none; color: #fff; cursor: pointer; font-size: 16px; padding: 0 4px; }

    #rbe-body { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
    .rbe-section { padding: 10px 14px; border-bottom: 1px solid #eee; }
    .rbe-section:last-child { border-bottom: none; }
    .rbe-label { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 6px; }

    #rbe-prefix { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; box-sizing: border-box; }
    #rbe-prefix:focus { outline: none; border-color: #4a9eff; }

    #rbe-folder-list { max-height: 200px; overflow-y: auto; margin-top: 4px; }
    .rbe-folder-item { display: flex; align-items: center; padding: 4px 0; gap: 8px; }
    .rbe-folder-item label { cursor: pointer; flex: 1; line-height: 1.3; }

    .rbe-btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .rbe-btn { padding: 6px 12px; border: none; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .rbe-btn:hover { opacity: 0.85; }
    .rbe-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .rbe-btn-primary { background: #1a1a1a; color: #fff; }
    .rbe-btn-danger  { background: #d9534f; color: #fff; }
    .rbe-btn-outline { background: #fff; color: #333; border: 1px solid #ccc; }

    #rbe-log {
      flex: 1; min-height: 120px; max-height: 250px; overflow-y: auto;
      padding: 8px 14px; font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 11px; line-height: 1.5; background: #fafafa;
    }
    .rbe-log-info    { color: #555; }
    .rbe-log-success { color: #2e7d32; }
    .rbe-log-warn    { color: #e65100; }
    .rbe-log-error   { color: #c62828; }

    .rbe-format-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .rbe-radio-label { display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
    .rbe-radio-label input[type="radio"] { margin: 0; cursor: pointer; }

    .rbe-select-links { font-size: 11px; margin-top: 4px; }
    .rbe-select-links a { color: #4a9eff; cursor: pointer; text-decoration: none; margin-right: 8px; }
    .rbe-select-links a:hover { text-decoration: underline; }
  `);

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'rbe-panel';
    panel.innerHTML = `
      <div id="rbe-header">
        <span>Rise Bulk Export</span>
        <button id="rbe-toggle-btn" title="Collapse">−</button>
      </div>
      <div id="rbe-body">
        <div class="rbe-section">
          <div class="rbe-label">Filename Prefix</div>
          <input id="rbe-prefix" type="text" placeholder="e.g. daa_" />
        </div>
        <div class="rbe-section">
          <div class="rbe-label">Folders</div>
          <div class="rbe-btn-row">
            <button class="rbe-btn rbe-btn-outline" id="rbe-scan-btn">Scan Folders</button>
          </div>
          <div id="rbe-folder-list"></div>
          <div class="rbe-select-links" id="rbe-select-links" style="display:none;">
            <a id="rbe-select-all">Select all</a>
            <a id="rbe-select-none">Select none</a>
          </div>
        </div>
        <div class="rbe-section">
          <div class="rbe-label">Export Format</div>
          <div class="rbe-format-row">
            <label class="rbe-radio-label"><input type="radio" name="rbe-format" value="web" checked /> Web (HTML)</label>
            <label class="rbe-radio-label"><input type="radio" name="rbe-format" value="lms" /> LMS (SCORM)</label>
            <label class="rbe-radio-label"><input type="radio" name="rbe-format" value="both" /> Both</label>
          </div>
        </div>
        <div class="rbe-section">
          <div class="rbe-btn-row">
            <button class="rbe-btn rbe-btn-primary" id="rbe-start-btn" disabled>Start Export</button>
            <button class="rbe-btn rbe-btn-danger" id="rbe-stop-btn">Stop</button>
          </div>
        </div>
        <div id="rbe-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Toggle
    document.getElementById('rbe-toggle-btn').addEventListener('click', () => {
      panel.classList.toggle('rbe-collapsed');
      document.getElementById('rbe-toggle-btn').textContent = panel.classList.contains('rbe-collapsed') ? '+' : '−';
    });

    // Scan
    document.getElementById('rbe-scan-btn').addEventListener('click', () => {
      log('Scanning...', 'info');
      const folders = scanFolders();
      const list = document.getElementById('rbe-folder-list');
      const links = document.getElementById('rbe-select-links');

      if (folders.length === 0) {
        // Debug info
        const ca = getMainContentArea();
        log(`DEBUG: content area = ${ca.id || ca.tagName}`, 'warn');
        const allLinks = ca.querySelectorAll('a');
        log(`DEBUG: ${allLinks.length} links in content area`, 'warn');
        // Check for Folders header
        const bodyText = ca.innerText || '';
        const folderMatch = bodyText.match(/Folders\s*\(\d+\)/);
        log(`DEBUG: Folders header found: ${folderMatch ? folderMatch[0] : 'NO'}`, 'warn');
        // Log first 10 non-sidebar links
        let count = 0;
        allLinks.forEach((a) => {
          if (count >= 15) return;
          if (a.closest('[data-ba="sidebar_container"], #rbe-panel')) return;
          const inBreadcrumb = !!a.closest('[data-ba="breadcrumbs_container"], [aria-label="Breadcrumbs"]');
          log(`  Link: "${a.textContent.trim().substring(0, 50)}" bc=${inBreadcrumb} href=${(a.href || '').substring(0, 70)}`, 'warn');
          count++;
        });

        list.innerHTML = '<div style="color:#999;padding:6px 0;">No folders found. Check log for debug info.</div>';
        links.style.display = 'none';
        document.getElementById('rbe-start-btn').disabled = true;
        return;
      }

      list.innerHTML = folders.map((f, i) => `
        <div class="rbe-folder-item">
          <input type="checkbox" class="rbe-folder-cb" id="rbe-f-${i}" value="${f.name.replace(/"/g, '&quot;')}" checked />
          <label for="rbe-f-${i}">${f.name}</label>
        </div>`).join('');

      links.style.display = 'block';
      document.getElementById('rbe-start-btn').disabled = false;
      log(`Scanned ${folders.length} folder(s)`, 'success');
    });

    // Select all/none
    document.getElementById('rbe-select-all')?.addEventListener('click', (e) => { e.preventDefault(); document.querySelectorAll('.rbe-folder-cb').forEach((c) => c.checked = true); });
    document.getElementById('rbe-select-none')?.addEventListener('click', (e) => { e.preventDefault(); document.querySelectorAll('.rbe-folder-cb').forEach((c) => c.checked = false); });

    // Start / Stop
    document.getElementById('rbe-start-btn').addEventListener('click', startExport);
    document.getElementById('rbe-stop-btn').addEventListener('click', stopExport);

    // Draggable
    makeDraggable(panel, document.getElementById('rbe-header'));
  }

  function updateButtons() {
    const state = getState();
    const active = state.phase !== PHASE.IDLE;
    const startBtn = document.getElementById('rbe-start-btn');
    const stopBtn = document.getElementById('rbe-stop-btn');
    const scanBtn = document.getElementById('rbe-scan-btn');
    if (startBtn) startBtn.disabled = active;
    // Stop is always enabled so user can reset stale state
    if (stopBtn) stopBtn.disabled = false;
    if (scanBtn) scanBtn.disabled = active;
  }

  function makeDraggable(panel, handle) {
    let ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => { dragging = true; ox = e.clientX - panel.getBoundingClientRect().left; oy = e.clientY - panel.getBoundingClientRect().top; panel.style.transition = 'none'; });
    document.addEventListener('mousemove', (e) => { if (!dragging) return; panel.style.left = (e.clientX - ox) + 'px'; panel.style.top = (e.clientY - oy) + 'px'; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ── INIT / RESUME ───────────────────────────────────────────────────────────

  async function init() {
    createPanel();
    renderLog(); // Restore log from previous page

    const state = getState();
    console.log('[Rise Bulk Export] Init state:', state);
    updateButtons();

    if (state.phase !== PHASE.IDLE) {
      log(`Resuming: phase=${state.phase}, folder=${state.currentFolderIndex}, course=${state.currentCourseIndex}`, 'info');
    }

    // Check if we need to resume an export after a page navigation
    switch (state.phase) {
      case PHASE.ON_PUBLISH_PAGE:
        log(`--- Page reloaded: resuming on publish page ---`, 'info');
        document.body.classList.add('rbe-export-active');
        await handlePublishPage();
        break;

      case PHASE.BACK_TO_FOLDER:
        log(`--- Page reloaded: back on folder page ---`, 'info');
        document.body.classList.add('rbe-export-active');
        await handleBackToFolder();
        break;

      case PHASE.ENTERING_SUBFOLDER:
        log(`--- Page reloaded: entering subfolder ---`, 'info');
        document.body.classList.add('rbe-export-active');
        await handleEnteringSubfolder();
        break;

      case PHASE.IN_SUBFOLDER:
        log(`--- Page reloaded: resuming in subfolder ---`, 'info');
        document.body.classList.add('rbe-export-active');
        await processCourses();
        break;

      default:
        log('Ready. Navigate to the parent folder, then click "Scan Folders".', 'info');
        break;
    }
  }

  init();
})();