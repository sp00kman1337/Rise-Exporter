// ==UserScript==
// @name         Rise 360 Bulk Export
// @namespace    rise-bulk-export
// @version      3.4
// @description  Bulk export Rise 360 courses as Web (HTML) and/or LMS (SCORM) zips from selected folders
// @match        https://rise.articulate.com/*
// @match        https://app.rise.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @homepageURL  https://github.com/sp00kman1337/Rise-Exporter#readme
// @supportURL   https://github.com/sp00kman1337/Rise-Exporter#readme
// @updateURL    https://raw.githubusercontent.com/sp00kman1337/Rise-Exporter/main/rise-bulk-export.user.js
// @downloadURL  https://raw.githubusercontent.com/sp00kman1337/Rise-Exporter/main/rise-bulk-export.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── CONFIG ───────────────────────────────────────────────────────────────────
  const DELAYS = {
    beforeMenuClick: 800, afterMenuClick: 600, afterPublishHover: 500,
    publishTimeout: 120000, afterBack: 3000, afterFolderClick: 2000,
    afterSettingChange: 300, afterExpandSettings: 500, afterDownloadClick: 500,
    betweenCourses: 2000, betweenFolders: 2000,
  };

  // LMS publish-page settings to enforce
  const LMS_SETTINGS = {
    lmsFormat: 'scorm12',               // SCORM 1.2
    reporting: 'completed-incomplete',  // Complete/Incomplete
    toggles: {
      'enable-exit-course': false,       // Exit microlearning link → OFF
      'disable-course-cover-page': true, // Hide cover page → ON
      'enable-reset-learner-data': false,// Reset progress after updates → OFF
      'load-only-in-lms': true,          // Only load in LMS → ON
    },
  };

  const PHASE = {
    IDLE: 'IDLE', IN_SUBFOLDER: 'IN_SUBFOLDER', ON_PUBLISH_PAGE: 'ON_PUBLISH_PAGE',
    BACK_TO_FOLDER: 'BACK_TO_FOLDER', ENTERING_SUBFOLDER: 'ENTERING_SUBFOLDER',
  };

  // ── UTILITIES ────────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const findByExactText = (sel, text, root = document) => {
    for (const el of root.querySelectorAll(sel)) if (el.textContent.trim() === text) return el;
    return null;
  };

  function hoverElement(el) {
    const { left, top, width, height } = el.getBoundingClientRect();
    const cx = left + width / 2, cy = top + height / 2;
    const m = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    const p = { ...m, pointerId: 1, pointerType: 'mouse', width: 1, height: 1, isPrimary: true };
    ['pointerover', 'pointermove'].forEach(t => el.dispatchEvent(new PointerEvent(t, p)));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...p, bubbles: false }));
    ['mouseover', 'mousemove'].forEach(t => el.dispatchEvent(new MouseEvent(t, m)));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...m, bubbles: false }));
  }

  async function pollFor(fn, timeout = 15000, interval = 1000) {
    for (const end = Date.now() + timeout; Date.now() < end;) {
      const r = fn(); if (r) return r;
      await sleep(interval);
    }
    return null;
  }

  /** Escape HTML special chars to prevent XSS via innerHTML */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const ALLOWED_ORIGINS = ['https://rise.articulate.com', 'https://app.rise.com'];

  /** Navigate only to URLs on the Rise domain */
  function safeNavigate(url) {
    try {
      const { origin } = new URL(url);
      if (ALLOWED_ORIGINS.includes(origin)) { window.location.href = url; return true; }
    } catch {}
    console.warn('[Rise Bulk Export] Blocked navigation to untrusted URL:', url);
    return false;
  }

  // ── STATE ─────────────────────────────────────────────────────────────────────
  // st()        → read current state
  // st(patch)   → merge patch into state, return merged
  // st(null)    → reset to IDLE
  function st(patch) {
    const KEY = 'rbe_state';
    const INIT = { phase: PHASE.IDLE, totalExported: 0, totalFailed: 0 };
    if (patch === null) { GM_setValue(KEY, JSON.stringify(INIT)); return INIT; }
    let cur; try { cur = JSON.parse(GM_getValue(KEY, 'null')) || INIT; } catch { cur = INIT; }
    if (patch === undefined) return cur;
    const next = { ...cur, ...patch };
    GM_setValue(KEY, JSON.stringify(next));
    return next;
  }

  // ── LOG ───────────────────────────────────────────────────────────────────────
  function log(msg, type = 'info') {
    const KEY = 'rbe_log';
    let entries; try { entries = JSON.parse(GM_getValue(KEY, '[]')); } catch { entries = []; }
    entries.push({ msg, type, time: new Date().toLocaleTimeString() });
    if (entries.length > 200) entries.splice(0, entries.length - 200);
    GM_setValue(KEY, JSON.stringify(entries));
    _renderLog(entries);
    console.log(`[Rise Bulk Export] ${msg}`);
  }

  function _renderLog(entries) {
    const el = document.getElementById('rbe-log');
    if (!el) return;
    el.innerHTML = entries.map(e => `<div class="rbe-log-${esc(e.type)}">[${esc(e.time)}] ${esc(e.msg)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  const restoreLog = () => { try { _renderLog(JSON.parse(GM_getValue('rbe_log', '[]'))); } catch {} };
  const clearLog   = () => GM_setValue('rbe_log', '[]');

  // ── DOM ───────────────────────────────────────────────────────────────────────
  const contentArea = () =>
    document.getElementById('current-content')
    || document.querySelector('[data-ba="dashboard_container"]')
    || document.querySelector('[role="region"][data-auto-scrollable="true"]')
    || document.body;

  // ── SCANNING ──────────────────────────────────────────────────────────────────
  function scanFolders() {
    const folders = [], ca = contentArea();
    const SKIP = '[data-ba="sidebar_container"], #rbe-panel, [data-ba="breadcrumbs_container"], [aria-label="Breadcrumbs"], [data-ba="create_courseCard"]';
    const badName = n => !n || n === 'New Folder' || n.startsWith('+') || /^Folders\s*\(/.test(n);

    const collect = root => root.querySelectorAll('a').forEach(a => {
      const name = a.textContent.trim();
      if (a.closest(SKIP) || badName(name) || folders.some(f => f.name === name)) return;
      folders.push({ name, href: a.href || '', el: a });
    });

    const walker = document.createTreeWalker(ca, NodeFilter.SHOW_TEXT, {
      acceptNode: n => /^Folders\s*\(\d+\)$/.test(n.textContent.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const textNode = walker.nextNode();
    if (textNode) {
      for (let s = textNode.parentElement, i = 0; i < 12 && s && s !== ca && s !== document.body; i++, s = s.parentElement) {
        collect(s);
        if (folders.length) return folders;
      }
    }
    collect(ca);
    return folders;
  }

  function scanCourseCards() {
    const ca = contentArea();
    const primary = [...ca.querySelectorAll('[data-ba="create_courseCard"]')].map((card, i) => ({
      title: card.getAttribute('data-ba-name') || `Course ${i + 1}`,
      courseId: card.getAttribute('data-ba-course-id') || '',
      el: card, index: i,
    }));
    if (primary.length) return primary;

    return [...ca.querySelectorAll('li[role="listitem"]')].reduce((acc, item, i) => {
      const titleEl = item.querySelector('[class*="title"], h3, h4, a[class*="heading"]');
      if (titleEl && (item.textContent.includes('Microlearning') || item.textContent.includes('Course')))
        acc.push({ title: titleEl.textContent.trim(), el: item, index: i });
      return acc;
    }, []);
  }

  // ── FORMAT HELPERS ───────────────────────────────────────────────────────────
  const getCurrentFormat = () => {
    const s = st();
    return (s.exportFormats || ['web'])[s.currentFormatIndex || 0] || 'web';
  };

  /** After a publish attempt, advance format index or course index as appropriate */
  function advanceAfterExport(succeeded) {
    const s = st();
    const formats = s.exportFormats || ['web'];
    const fmtIdx = s.currentFormatIndex || 0;
    const updates = { phase: PHASE.BACK_TO_FOLDER };

    if (succeeded) updates.totalExported = s.totalExported + 1;
    else           updates.totalFailed   = s.totalFailed + 1;

    // More formats for this course?
    if (fmtIdx + 1 < formats.length) {
      updates.currentFormatIndex = fmtIdx + 1; // same course, next format
    } else {
      updates.currentFormatIndex = 0;
      updates.currentCourseIndex = s.currentCourseIndex + 1;
    }
    return updates;
  }

  // ── LMS SETTINGS ─────────────────────────────────────────────────────────────
  /** Click "More settings" if present, to reveal all toggles */
  async function expandMoreSettings() {
    let link = null;
    for (const el of document.querySelectorAll('[class*="export-settings"] *, [class*="settings-label"] *')) {
      if (/^more settings$/i.test(el.textContent.trim()) && !el.children.length) { link = el; break; }
    }
    if (!link) link = findByExactText('div, span, a, button', 'More settings');
    if (link) { log(`    Expanding "More settings"...`, 'info'); link.click(); await sleep(DELAYS.afterSettingChange); }
  }

  /** Set a React-controlled <select> to a value */
  function setSelectValue(selectEl, value) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(selectEl, value);
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Set a toggle/checkbox to a desired state, preferring label click for React switches */
  function setToggle(inputEl, desired) {
    if (inputEl.checked === desired) return;
    const label = inputEl.closest('label') || document.querySelector(`label[for="${inputEl.id}"]`);
    (label || inputEl).click();
  }

  /** Configure all LMS publish settings before clicking Download */
  async function configureLmsSettings() {
    log(`  Waiting for LMS settings to load...`, 'info');
    const lmsFormatSelect = await pollFor(() => {
      const s = document.querySelectorAll('select[class*="dropdown"]');
      return s.length >= 1 ? s[0] : null;
    }, 30000, 1000);

    if (!lmsFormatSelect) { log(`  ⚠ LMS settings never loaded`, 'error'); return; }
    log(`  Configuring LMS settings...`, 'info');

    await expandMoreSettings();
    await sleep(DELAYS.afterExpandSettings);

    // 1. LMS format dropdown
    if (lmsFormatSelect.value !== LMS_SETTINGS.lmsFormat) {
      log(`    Setting LMS format → SCORM 1.2`, 'info');
      setSelectValue(lmsFormatSelect, LMS_SETTINGS.lmsFormat);
      await sleep(DELAYS.afterSettingChange);
    } else { log(`    LMS format already SCORM 1.2 ✓`, 'info'); }

    // 2. Reporting dropdown (re-query after expand in case DOM shifted)
    const selects = document.querySelectorAll('select[class*="dropdown"]');
    if (selects.length >= 2) {
      const rep = selects[1];
      if (rep.value !== LMS_SETTINGS.reporting) {
        log(`    Setting Reporting → Complete/Incomplete`, 'info');
        setSelectValue(rep, LMS_SETTINGS.reporting);
        await sleep(DELAYS.afterSettingChange);
      } else { log(`    Reporting already Complete/Incomplete ✓`, 'info'); }
    } else { log(`    ⚠ Could not find Reporting dropdown`, 'warn'); }

    // 3. Toggle switches
    for (const [id, desired] of Object.entries(LMS_SETTINGS.toggles)) {
      const input = await pollFor(() => document.getElementById(id), 5000, 500);
      if (input) {
        const label = id.replace(/-/g, ' ').replace(/^(enable|disable)\s/, '');
        if (input.checked !== desired) {
          log(`    Setting "${label}" → ${desired ? 'ON' : 'OFF'}`, 'info');
          setToggle(input, desired);
          await sleep(DELAYS.afterSettingChange);
        } else { log(`    "${label}" already ${desired ? 'ON' : 'OFF'} ✓`, 'info'); }
      } else { log(`    ⚠ Could not find toggle #${id}`, 'warn'); }
    }
    log(`  LMS settings configured`, 'success');
  }

  // ── EXPORT: CARD MENU ────────────────────────────────────────────────────────
  async function openCardMenu(cardEl) {
    const name = cardEl.getAttribute('data-ba-name') || 'unknown';
    log(`    Looking for "..." on: "${name}"`, 'info');

    let btn = cardEl.querySelector('button[data-ba="content.dropDownMenu.menuButton"]');
    if (!btn) {
      hoverElement(cardEl);
      await sleep(DELAYS.beforeMenuClick);
      btn = cardEl.querySelector('button[data-ba="content.dropDownMenu.menuButton"]')
         || cardEl.querySelector('button[aria-haspopup="true"]');
    }
    if (!btn) {
      cardEl.querySelectorAll('div').forEach(d => { d.style.opacity = '1'; d.style.visibility = 'visible'; });
      await sleep(500);
      btn = cardEl.querySelector('button[data-ba="content.dropDownMenu.menuButton"]')
         || cardEl.querySelector('button[aria-haspopup]');
    }
    if (!btn) {
      [...cardEl.querySelectorAll('button')].forEach((b, i) =>
        log(`      [${i}] data-ba="${b.getAttribute('data-ba')}" text="${b.textContent.trim().slice(0, 30)}"`, 'warn'));
      throw new Error('Could not find "..." menu button');
    }
    if (btn.closest('[class*="breadcrumb"], [data-ba="dropdownMenu_menuAnchor"]'))
      throw new Error('Found breadcrumb menu button, not card menu. Aborting.');

    log(`    Clicking "..."`, 'info');
    btn.click();
    await sleep(DELAYS.afterMenuClick);
  }

  async function clickPublishFormat(format = 'web') {
    const menuLabel = format === 'lms' ? 'LMS' : 'Web';

    const publishItem = await pollFor(() =>
      document.querySelector('li[data-ba="content.dropDownMenu.publish"]')
      || findByExactText('[role="menuitem"]', 'Publish'), 5000, 300);
    if (!publishItem) throw new Error('Could not find "Publish" menu item');

    log(`    Hovering "Publish"...`, 'info');
    hoverElement(publishItem);
    await sleep(DELAYS.afterPublishHover);

    const targetItem = await pollFor(() => {
      for (const menu of document.querySelectorAll('ul[role="menu"]'))
        for (const item of menu.querySelectorAll('[role="menuitem"]'))
          if (item.textContent.trim() === menuLabel) return item;
      return null;
    }, 5000, 300);
    if (!targetItem) throw new Error(`Could not find "${menuLabel}" submenu item`);

    log(`    Clicking "${menuLabel}" (will navigate to publish page)...`, 'info');
    st({ phase: PHASE.ON_PUBLISH_PAGE }); // save before navigation — script restarts on new page
    targetItem.click();
  }

  // ── EXPORT: PUBLISH PAGE ─────────────────────────────────────────────────────
  async function handlePublishPage() {
    const fmt = getCurrentFormat();
    log(`  On publish page (${fmt.toUpperCase()}) — waiting for Download button...`, 'info');

    if (fmt === 'lms') await configureLmsSettings();

    const downloadBtn = await pollFor(() => findByExactText('button', 'Download'), 30000, 1000);
    if (!downloadBtn) { log(`  ✗ Could not find Download button`, 'error'); navigateBackToFolder(); return; }

    await sleep(DELAYS.afterDownloadClick);
    log(`  Clicking "Download"...`, 'info');
    downloadBtn.click();

    log(`  Publishing... (waiting up to ${DELAYS.publishTimeout / 1000}s)`, 'info');
    const success = await pollFor(() => {
      const t = document.body.innerText;
      return (
        t.includes('Publish Successful') ||       // Web export success
        t.includes('Published successfully') ||
        t.includes('Your course package is ready') // LMS export success
      ) || null;
    }, DELAYS.publishTimeout, 500);

    log(success ? `  ✓ Published (${fmt.toUpperCase()}) successfully — zip auto-downloaded` : `  ✗ Publish timed out`, success ? 'success' : 'error');
    st(advanceAfterExport(!!success));

    log(`  Clicking "Back"...`, 'info');
    const backBtn = await pollFor(() => findByExactText('button, a, [role="button"]', 'Back'), 10000, 500);
    backBtn ? backBtn.click() : (log(`  ✗ No Back button, using history.back()`, 'warn'), window.history.back());
  }

  function navigateBackToFolder() {
    const s = st({ phase: PHASE.BACK_TO_FOLDER });
    s.currentFolderUrl ? (safeNavigate(s.currentFolderUrl) || window.history.back()) : window.history.back();
  }

  // ── EXPORT: FOLDER PROCESSING ────────────────────────────────────────────────
  async function processCourses() {
    await sleep(DELAYS.betweenCourses);
    const cards = scanCourseCards();
    let idx = st().currentCourseIndex || 0;
    log(`  Found ${cards.length} course(s), continuing from index ${idx}`, 'info');

    while (idx < cards.length) {
      const fmt = getCurrentFormat();
      const card = cards[idx];
      log(`  Exporting [${idx + 1}/${cards.length}] (${fmt.toUpperCase()}): "${card.title}"`, 'info');
      try {
        await openCardMenu(card.el);
        await clickPublishFormat(fmt); // saves state + navigates — stops here
        return;
      } catch (err) {
        log(`  ✗ Error: ${err.message}`, 'error');
        // Skip all remaining formats for this course
        st({ currentCourseIndex: ++idx, currentFormatIndex: 0, totalFailed: st().totalFailed + 1 });
        await sleep(DELAYS.betweenFolders);
      }
    }

    log(`  ✓ Folder complete`, 'success');
    await moveToNextFolder();
  }

  async function handleEnteringSubfolder() {
    await sleep(DELAYS.afterFolderClick);
    const { selectedFolders = [], currentFolderIndex = 0 } = st();
    let idx = currentFolderIndex;

    while (idx < selectedFolders.length) {
      const target = selectedFolders[idx];
      log(`📂 Entering folder: "${target.name}"`, 'info');
      const folder = scanFolders().find(f => f.name === target.name);
      if (folder) {
        st({ phase: PHASE.IN_SUBFOLDER, currentFolderIndex: idx, currentFolderUrl: folder.href });
        folder.el.click();
        await sleep(DELAYS.afterFolderClick);
        await processCourses();
        return;
      }
      log(`  Could not find folder "${target.name}" — skipping`, 'error');
      st({ currentFolderIndex: ++idx, currentCourseIndex: 0, currentFormatIndex: 0 });
    }

    log('No more folders to process', 'warn');
    st(null);
    updateButtons();
  }

  async function moveToNextFolder() {
    const s = st();
    const nextIdx = (s.currentFolderIndex || 0) + 1;

    if (nextIdx >= (s.selectedFolders || []).length) {
      log(`\n═══ DONE ═══`, 'info');
      log(`Exported: ${s.totalExported} | Failed: ${s.totalFailed}`, s.totalFailed > 0 ? 'warn' : 'success');
      st(null);
      document.body.classList.remove('rbe-export-active');
      updateButtons();
      return;
    }

    log(`📂 Next folder: "${s.selectedFolders[nextIdx].name}"`, 'info');
    st({ currentFolderIndex: nextIdx, currentCourseIndex: 0, currentFormatIndex: 0, phase: PHASE.ENTERING_SUBFOLDER });
    if (s.parentFolderUrl) safeNavigate(s.parentFolderUrl);
  }

  // ── START / STOP ─────────────────────────────────────────────────────────────
  async function startExport() {
    const selectedNames = [...document.querySelectorAll('.rbe-folder-cb:checked')].map(cb => cb.value);
    if (!selectedNames.length) { log('No folders selected!', 'error'); return; }

    const formatChoice = document.querySelector('input[name="rbe-format"]:checked')?.value || 'web';
    const exportFormats = formatChoice === 'both' ? ['web', 'lms'] : [formatChoice];

    const selectedFolders = scanFolders()
      .filter(f => selectedNames.includes(f.name))
      .map(({ name, href }) => ({ name, href }));
    if (!selectedFolders.length) { log('Could not find selected folders in DOM', 'error'); return; }

    clearLog();
    log(`Starting export of ${selectedFolders.length} folder(s) as ${exportFormats.map(f => f.toUpperCase()).join(' + ')}`, 'info');
    st({
      phase: PHASE.ENTERING_SUBFOLDER, active: true, exportFormats,
      parentFolderUrl: window.location.href, selectedFolders,
      currentFolderIndex: 0, currentCourseIndex: 0, currentFormatIndex: 0,
      totalExported: 0, totalFailed: 0,
    });
    document.body.classList.add('rbe-export-active');
    updateButtons();
    await handleEnteringSubfolder();
  }

  function stopExport() {
    log('⏹ Export stopped by user', 'warn');
    st(null);
    document.body.classList.remove('rbe-export-active');
    updateButtons();
  }

  // ── UI ────────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    .rbe-export-active [data-ba="content.dropDownMenu.menuButton"],
    .rbe-export-active [class*="block-view-item-common_menu"],
    .rbe-export-active [class*="menu_item"] > button { opacity:1!important; visibility:visible!important; pointer-events:auto!important }
    #rbe-panel { position:fixed; top:60px; right:16px; width:320px; max-height:calc(100vh - 80px); z-index:99999; display:flex; flex-direction:column; overflow:hidden; background:#fff; border:1px solid #d0d0d0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:13px; color:#333 }
    #rbe-panel * { box-sizing:border-box }
    #rbe-panel.rbe-collapsed #rbe-body { display:none }
    #rbe-panel.rbe-collapsed { width:auto }
    #rbe-header { display:flex; align-items:center; justify-content:space-between; padding:9px 14px; background:#000; color:#fff; cursor:move; user-select:none; flex-shrink:0 }
    #rbe-header span { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px }
    #rbe-toggle-btn { background:none; border:none; color:#fff; cursor:pointer; font-size:16px; padding:0; line-height:1 }
    #rbe-body { display:flex; flex-direction:column; overflow-y:auto; flex:1 }
    #rbe-instructions { padding:10px 14px; border-bottom:1px solid #dee2e6; background:#f7f7f7; font-size:12px; color:#555; line-height:1.5 }
    #rbe-instructions strong { font-weight:600; color:#333 }
    .rbe-section { padding:10px 14px; border-bottom:1px solid #dee2e6 }
    .rbe-label { margin:0 0 8px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:#6c757d }
    .rbe-btn { display:inline-flex; align-items:center; justify-content:center; padding:6px 12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.3px; border:1px solid transparent; cursor:pointer; border-radius:0; white-space:nowrap }
    .rbe-btn:disabled { opacity:.4; cursor:not-allowed }
    .rbe-btn-primary { background:#5564ff; color:#fff; border-color:#5564ff }
    .rbe-btn-primary:hover:not(:disabled) { background:#3d4de0; border-color:#3d4de0 }
    .rbe-btn-danger { background:#cc3340; color:#fff; border-color:#cc3340 }
    .rbe-btn-danger:hover:not(:disabled) { background:#a82834; border-color:#a82834 }
    .rbe-btn-outline { background:#fff; color:#373737; border-color:#373737 }
    .rbe-btn-outline:hover:not(:disabled) { background:#373737; color:#fff }
    .rbe-btn-full { width:100% }
    .rbe-action-row { display:flex; gap:6px }
    .rbe-btn-grow { flex:1 }
    #rbe-folder-list { max-height:180px; overflow-y:auto; margin-top:6px }
    .rbe-check { display:flex; align-items:center; gap:6px; padding:3px 0; cursor:pointer; font-size:12px; margin:0 }
    .rbe-check input { width:14px; height:14px; margin:0; cursor:pointer; accent-color:#5564ff; flex-shrink:0 }
    .rbe-radio-group { display:flex; flex-wrap:wrap; gap:10px }
    #rbe-select-links { margin-top:6px; font-size:11px }
    #rbe-select-links a { color:#5564ff; cursor:pointer; text-decoration:none; margin-right:8px }
    #rbe-select-links a:hover { text-decoration:underline }
    #rbe-log { max-height:220px; overflow-y:auto; padding:8px 14px; font-family:'SF Mono',Menlo,Consolas,monospace; font-size:11px; line-height:1.5; background:#f7f7f7 }
    .rbe-log-info { color:#555 } .rbe-log-success { color:#00985b } .rbe-log-warn { color:#f67d02 } .rbe-log-error { color:#cc3340 }
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
        <div id="rbe-instructions">
          This exporter automatically exports Rise courses as HTML or SCORM. Navigate into a main folder, click <strong>Scan Folders</strong>, select which subfolders to export, then click <strong>Start Export</strong>. All files will be downloaded to your downloads folder.
        </div>
        <div class="rbe-section">
          <p class="rbe-label">Folders</p>
          <button class="rbe-btn rbe-btn-outline rbe-btn-full" id="rbe-scan-btn">Scan Folders</button>
          <div id="rbe-folder-list"></div>
          <div id="rbe-select-links" style="display:none">
            <a id="rbe-select-all">Select all</a><a id="rbe-select-none">Select none</a>
          </div>
        </div>
        <div class="rbe-section">
          <p class="rbe-label">Export Format</p>
          <div class="rbe-radio-group">
            <label class="rbe-check"><input type="radio" name="rbe-format" id="rbe-fmt-web" value="web" checked><span>Web (HTML)</span></label>
            <label class="rbe-check"><input type="radio" name="rbe-format" id="rbe-fmt-lms" value="lms"><span>LMS (SCORM)</span></label>
            <label class="rbe-check"><input type="radio" name="rbe-format" id="rbe-fmt-both" value="both"><span>Both</span></label>
          </div>
        </div>
        <div class="rbe-section rbe-action-row">
          <button class="rbe-btn rbe-btn-primary rbe-btn-grow" id="rbe-start-btn" disabled>Start Export</button>
          <button class="rbe-btn rbe-btn-danger" id="rbe-stop-btn">Stop</button>
        </div>
        <div id="rbe-log"></div>
      </div>`;
    document.body.appendChild(panel);

    const $ = id => document.getElementById(id);

    $('rbe-toggle-btn').addEventListener('click', () => {
      panel.classList.toggle('rbe-collapsed');
      $('rbe-toggle-btn').textContent = panel.classList.contains('rbe-collapsed') ? '+' : '−';
    });

    $('rbe-scan-btn').addEventListener('click', () => {
      log('Scanning...', 'info');
      const folders = scanFolders();
      const list = $('rbe-folder-list'), links = $('rbe-select-links');

      if (!folders.length) {
        const ca = contentArea();
        const allLinks = ca.querySelectorAll('a');
        log(`DEBUG: content area=${ca.id || ca.tagName}, ${allLinks.length} links`, 'warn');
        log(`DEBUG: Folders header=${((ca.innerText || '').match(/Folders\s*\(\d+\)/) || ['NO'])[0]}`, 'warn');
        let n = 0;
        allLinks.forEach(a => {
          if (n >= 15 || a.closest('[data-ba="sidebar_container"], #rbe-panel')) return;
          log(`  Link: "${a.textContent.trim().slice(0, 50)}" bc=${!!a.closest('[data-ba="breadcrumbs_container"],[aria-label="Breadcrumbs"]')} href=${(a.href || '').slice(0, 70)}`, 'warn');
          n++;
        });
        list.innerHTML = '<p style="color:#999;font-size:12px;margin:4px 0 0">No folders found. Check log.</p>';
        links.style.display = 'none';
        $('rbe-start-btn').disabled = true;
        return;
      }

      list.innerHTML = folders.map((f, i) => `
        <label class="rbe-check">
          <input type="checkbox" class="rbe-folder-cb" id="rbe-f-${i}" value="${esc(f.name)}" checked>
          <span>${esc(f.name)}</span>
        </label>`).join('');
      links.style.display = 'block';
      $('rbe-start-btn').disabled = false;
      log(`Scanned ${folders.length} folder(s)`, 'success');
    });

    $('rbe-select-all')?.addEventListener('click', e => { e.preventDefault(); document.querySelectorAll('.rbe-folder-cb').forEach(c => c.checked = true); });
    $('rbe-select-none')?.addEventListener('click', e => { e.preventDefault(); document.querySelectorAll('.rbe-folder-cb').forEach(c => c.checked = false); });
    $('rbe-start-btn').addEventListener('click', startExport);
    $('rbe-stop-btn').addEventListener('click', stopExport);

    // Draggable header
    let ox, oy, drag = false;
    $('rbe-header').addEventListener('mousedown', e => {
      drag = true;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      panel.style.transition = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.left = (e.clientX - ox) + 'px';
      panel.style.top  = (e.clientY - oy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => drag = false);
  }

  function updateButtons() {
    const active = st().phase !== PHASE.IDLE;
    ['rbe-start-btn', 'rbe-scan-btn'].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = active;
    });
    const stop = document.getElementById('rbe-stop-btn');
    if (stop) stop.disabled = false; // always enabled so user can reset stale state
  }

  // ── INIT / RESUME ─────────────────────────────────────────────────────────────
  async function init() {
    createPanel();
    restoreLog();
    const s = st();
    console.log('[Rise Bulk Export] Init:', s);
    updateButtons();
    if (s.phase !== PHASE.IDLE)
      log(`Resuming: phase=${s.phase}, folder=${s.currentFolderIndex}, course=${s.currentCourseIndex}, format=${s.currentFormatIndex}`, 'info');

    if (s.phase !== PHASE.IDLE) document.body.classList.add('rbe-export-active');

    switch (s.phase) {
      case PHASE.ON_PUBLISH_PAGE:
        log('--- resuming: publish page ---', 'info');
        await handlePublishPage();
        break;
      case PHASE.BACK_TO_FOLDER:
        log('--- resuming: back to folder ---', 'info');
        await sleep(DELAYS.afterBack);
        st({ phase: PHASE.IN_SUBFOLDER });
        await processCourses();
        break;
      case PHASE.ENTERING_SUBFOLDER:
        log('--- resuming: entering subfolder ---', 'info');
        await handleEnteringSubfolder();
        break;
      case PHASE.IN_SUBFOLDER:
        log('--- resuming: in subfolder ---', 'info');
        await processCourses();
        break;
      default:
        log('Ready. Navigate to the parent folder, then click "Scan Folders".', 'info');
    }
  }

  init();
})();
