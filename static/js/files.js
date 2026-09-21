/* Files — a Drive-style manager over the case tree.
 *
 * Loaded after main.js, which supplies $, el, escapeHtml, smartTruncate,
 * openConfirm, openRenamePrompt, convertAllSelectsToLLD, _csrfToken and
 * CASEORG_IS_ADMIN.  Every <select> here goes through the app's own
 * Long-List Dropdown so the controls match the rest of Case Organizer.
 */
(function () {
  const body = document.getElementById('files-body');
  if (!body) return;

  const STANDARD_SUBDIRS = (window.CaseOrg && window.CaseOrg.standardSubdirs) || [];
  const PREFS = 'caseOrg.files.prefs';
  const STARS = 'caseOrg.files.starred';

  const state = {
    path: '', depth: 0, canDelete: false,
    dirs: [], files: [], crumbs: [],
    selected: new Set(), lastIndex: -1,
    view: 'list',
    // Multi-key sort: [{key, asc}, …]. Shift-clicking a header appends a key
    // instead of replacing, so "type then date" is expressible.
    sort: [{ key: 'name', asc: true }],
    filter: '', chipType: '', chipModified: '',
    starred: new Set(), noThumb: new Set(), infoOpen: false,
  };

  try {
    const s = JSON.parse(localStorage.getItem(PREFS) || '{}');
    if (s.view) state.view = s.view;
    if (Array.isArray(s.sort) && s.sort.length) state.sort = s.sort;
    if (typeof s.infoOpen === 'boolean') state.infoOpen = s.infoOpen;
    state.starred = new Set(JSON.parse(localStorage.getItem(STARS) || '[]'));
  } catch (e) { /* defaults */ }

  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(
        { view: state.view, sort: state.sort, infoOpen: state.infoOpen }));
      localStorage.setItem(STARS, JSON.stringify([...state.starred]));
    } catch (e) { /* private mode */ }
  };

  // ---- formatting --------------------------------------------------------
  function humanSize(n) {
    if (n === null || n === undefined) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
  function humanDate(epoch) {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    const today = new Date();
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString(undefined, sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const extOf = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');

  function kindOf(entry) {
    if (entry.kind === 'dir') return 'folder';
    const e = extOf(entry.name);
    if (e === 'pdf') return 'pdf';
    if (['png', 'jpg', 'jpeg'].includes(e)) return 'image';
    if (['docx', 'doc', 'txt', 'md', 'json'].includes(e)) return 'docx';
    return 'other';
  }

  function iconFor(entry) {
    if (entry.kind === 'dir') return { cls: 'fa-solid fa-folder', tint: 'folder' };
    const e = extOf(entry.name);
    if (e === 'pdf') return { cls: 'fa-solid fa-file-pdf', tint: 'pdf' };
    if (['png', 'jpg', 'jpeg'].includes(e)) return { cls: 'fa-solid fa-file-image', tint: 'img' };
    if (['docx', 'doc'].includes(e)) return { cls: 'fa-solid fa-file-word', tint: 'doc' };
    if (['txt', 'md'].includes(e)) return { cls: 'fa-solid fa-file-lines', tint: 'doc' };
    if (e === 'json') return { cls: 'fa-solid fa-file-code', tint: 'doc' };
    if (['zip', 'rar', '7z'].includes(e)) return { cls: 'fa-solid fa-file-zipper', tint: 'zip' };
    return { cls: 'fa-solid fa-file', tint: 'other' };
  }

  // ---- data --------------------------------------------------------------
  let reqSeq = 0;

  async function load(path, { push = true } = {}) {
    const seq = ++reqSeq;
    // The listing is NOT torn down while loading: replacing it with a stub
    // collapses the container and the page visibly snaps, worst of all on an
    // empty folder where nothing comes back to restore the height.
    document.getElementById('files-table').classList.add('is-loading');
    let data;
    try {
      const r = await fetch(`/api/files/list?path=${encodeURIComponent(path || '')}`);
      data = await r.json();
    } catch (err) {
      if (seq === reqSeq) showMessage('Could not reach the server.');
      return;
    }
    if (seq !== reqSeq) return;              // a newer navigation won
    document.getElementById('files-table').classList.remove('is-loading');
    if (!data.ok) { showMessage(data.msg || 'Could not open that folder.'); return; }

    Object.assign(state, {
      path: data.path, depth: data.depth, canDelete: data.can_delete,
      dirs: data.dirs, files: data.files, crumbs: data.crumbs,
    });
    state.selected.clear();
    state.lastIndex = -1;

    // pushState, not replaceState: browsing has to create history entries or
    // the browser/mouse Back button leaves the page instead of going up.
    const url = `/files${state.path ? `?path=${encodeURIComponent(state.path)}` : ''}`;
    if (push && location.pathname + location.search !== url) {
      history.pushState({ path: state.path }, '', url);
    }
    render();
  }

  function showMessage(msg) {
    document.getElementById('files-table').classList.remove('is-loading');
    body.innerHTML = `<div class="files-empty"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><p>${escapeHtml(msg)}</p></div>`;
  }

  // ---- sorting / filtering ----------------------------------------------
  function visibleEntries() {
    const needle = state.filter.trim().toLowerCase();
    const cutoff = state.chipModified
      ? Date.now() / 1000 - Number(state.chipModified) * 86400 : null;

    const keep = (e) => {
      if (needle && !e.name.toLowerCase().includes(needle)) return false;
      if (state.chipType && kindOf(e) !== state.chipType) return false;
      if (cutoff && (e.mtime || 0) < cutoff) return false;
      return true;
    };

    const val = (e, key) => {
      if (key === 'size') return e.kind === 'dir' ? -1 : (e.size || 0);
      if (key === 'modified') return e.mtime || 0;
      if (key === 'type') return kindOf(e);
      if (key === 'owner') return 'me';
      return e.name.toLowerCase();
    };
    const cmp = (a, b) => {
      for (const { key, asc } of state.sort) {
        const va = val(a, key), vb = val(b, key);
        let v = typeof va === 'string'
          ? va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
          : va - vb;
        if (v !== 0) return asc ? v : -v;
      }
      return 0;
    };
    // Folders lead, as in Drive.
    return [...state.dirs.filter(keep).sort(cmp), ...state.files.filter(keep).sort(cmp)];
  }

  // ---- selection ---------------------------------------------------------
  function updateSelBar() {
    const bar = document.getElementById('files-selbar');
    const n = state.selected.size;
    bar.hidden = n === 0;
    document.getElementById('files-selcount').textContent =
      `${n} selected`;
    document.getElementById('files-sel-delete').hidden = !state.canDelete;
    body.querySelectorAll('[data-rel]').forEach((row) => {
      const on = state.selected.has(row.dataset.rel);
      row.classList.toggle('selected', on);
      const cb = row.querySelector('.files-check');
      if (cb) cb.checked = on;
    });
    const all = document.getElementById('files-check-all');
    const total = visibleEntries().length;
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
    if (state.infoOpen) renderInfo();
  }

  function toggleSelect(rel, index, ev) {
    const entries = visibleEntries();
    if (ev && ev.shiftKey && state.lastIndex >= 0) {
      const [a, b] = [state.lastIndex, index].sort((x, y) => x - y);
      for (let i = a; i <= b; i += 1) state.selected.add(entries[i].rel);
    } else if (state.selected.has(rel)) {
      state.selected.delete(rel);
    } else {
      state.selected.add(rel);
    }
    state.lastIndex = index;
    updateSelBar();
  }

  const selectedEntries = () =>
    [...state.dirs, ...state.files].filter((e) => state.selected.has(e.rel));

  // ---- actions -----------------------------------------------------------
  async function doRename(entry) {
    const isCase = state.depth === 2 && entry.kind === 'dir';
    if (isCase && !CASEORG_IS_ADMIN) {
      alert('Renaming a case folder is an administrator action.');
      return;
    }
    const next = await openRenamePrompt(entry.name, isCase ? 'Rename Case' : 'Rename');
    if (!next || next === entry.name) return;
    const url = isCase ? '/api/rename-case' : '/api/rename-item';
    const payload = isCase
      ? { year: state.crumbs[0].name, month: state.crumbs[1].name, case: entry.name, new_name: next }
      : { rel: entry.rel, new_name: next };
    const data = await postJSON(url, payload);
    if (data.ok) load(state.path, { push: false });
    else alert(data.msg || 'Rename failed.');
  }

  function doReplace(entry) {
    const input = document.getElementById('files-replace-input');
    input.value = '';
    input.accept = `.${extOf(entry.name)}`;
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const ok = await openConfirm(
        `Replace “${entry.name}” with “${f.name}”? The current version is overwritten and cannot be recovered.`,
        'Replace File');
      if (!ok) return;
      const fd = new FormData();
      fd.append('rel', entry.rel); fd.append('file', f);
      const r = await fetch('/api/files/replace',
        { method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd });
      const data = await r.json();
      if (data.ok) load(state.path, { push: false });
      else alert(data.msg || 'Replace failed.');
    };
    input.click();
  }

  async function doDelete(entries) {
    if (!entries.length) return;
    const what = entries.length === 1 ? `“${entries[0].name}”` : `${entries.length} items`;
    if (!await openConfirm(`Delete ${what}? This cannot be undone.`, 'Confirm Delete')) return;
    for (const entry of entries) {
      const data = await postJSON('/api/delete-item', { rel: entry.rel, scope: 'cases' });
      if (!data.ok) { alert(`${entry.name}: ${data.msg || 'delete failed'}`); break; }
    }
    load(state.path, { push: false });
  }

  async function doMove(rels, dest) {
    const data = await postJSON('/api/files/move', { src: rels, dest });
    if (!data.ok && data.msg) alert(data.msg);
    else if (data.conflicts && data.conflicts.length) {
      alert(`Already in that folder: ${data.conflicts.join(', ')}`);
    }
    load(state.path, { push: false });
  }

  async function postJSON(url, payload) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
      body: JSON.stringify(payload),
    });
    return r.json();
  }

  function toggleStar(rel) {
    if (state.starred.has(rel)) state.starred.delete(rel); else state.starred.add(rel);
    savePrefs(); render();
  }

  // ---- row menu ----------------------------------------------------------
  function buildMenu(entry) {
    const menu = el('div', 'case-action-menu');
    const add = (icon, label, fn, danger) => {
      const b = el('button', danger ? 'danger' : '');
      b.type = 'button';
      b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}`;
      b.addEventListener('click', async () => { menu.classList.remove('open'); await fn(); });
      menu.appendChild(b);
    };
    if (entry.kind === 'dir') {
      add('fa-folder-open', 'Open', () => load(entry.rel));
      add('fa-download', 'Download as ZIP', () => {
        window.location.href = `/api/files/zip?path=${encodeURIComponent(entry.rel)}`;
      });
    } else {
      add('fa-download', 'Download', () => {
        window.location.href = `/static-serve?path=${encodeURIComponent(entry.abs)}&download=1`;
      });
      if (extOf(entry.name) === 'pdf') {
        add('fa-file-pdf', 'Open in PDF tools', () => { window.location.href = '/bento'; });
      }
    }
    add(state.starred.has(entry.rel) ? 'fa-star' : 'fa-star',
        state.starred.has(entry.rel) ? 'Remove star' : 'Add star', () => toggleStar(entry.rel));
    add('fa-pen', 'Rename', () => doRename(entry));
    add('fa-folder-open', 'Move to…', async () => {
      const dest = await openRenamePrompt(state.path, 'Move to folder');
      if (dest) await doMove([entry.rel], dest);
    });
    if (entry.kind === 'file' && entry.viewable) add('fa-arrows-rotate', 'Replace…', () => doReplace(entry));
    add('fa-circle-info', 'Details', () => {
      state.selected.clear(); state.selected.add(entry.rel);
      state.infoOpen = true; savePrefs(); render();
    });
    if (state.canDelete) add('fa-trash', 'Delete', () => doDelete([entry]), true);
    document.body.appendChild(menu);
    return menu;
  }

  // ---- rendering ---------------------------------------------------------
  function rowFor(entry, index) {
    const isDir = entry.kind === 'dir';
    const icon = iconFor(entry);
    const row = el('div', `files-row${isDir ? ' is-dir' : ''}`);
    row.dataset.rel = entry.rel;
    row.dataset.kind = entry.kind;
    row.draggable = true;
    row.tabIndex = 0;

    const check = el('span', 'files-col-check');
    check.innerHTML = `<input type="checkbox" class="files-check" aria-label="Select ${escapeHtml(entry.name)}" />`;

    const name = el('div', 'files-col-name');
    const star = state.starred.has(entry.rel)
      ? '<i class="fa-solid fa-star files-star on" aria-hidden="true"></i>' : '';
    if (state.view === 'grid') {
      const previewable = !isDir && ['pdf', 'png', 'jpg', 'jpeg'].includes(extOf(entry.name))
        && !state.noThumb.has(entry.rel);
      name.innerHTML =
        `<div class="files-thumb${previewable ? '' : ' no-preview'}"><i class="${icon.cls} tint-${icon.tint}" aria-hidden="true"></i></div>` +
        `<div class="files-tile-name"><i class="${icon.cls} tint-${icon.tint}" aria-hidden="true"></i>` +
        `<span>${escapeHtml(smartTruncate(entry.name, 42))}</span>${star}</div>`;
    } else {
      name.innerHTML =
        `<i class="${icon.cls} tint-${icon.tint}" aria-hidden="true"></i>` +
        `<span class="files-name-text">${escapeHtml(entry.name)}</span>${star}`;
    }

    const owner = el('span', 'files-col-owner');
    owner.textContent = 'me';
    const mod = el('span', 'files-col-mod');
    mod.textContent = humanDate(entry.mtime);
    const size = el('span', 'files-col-size');
    size.textContent = isDir ? '—' : humanSize(entry.size);

    // The menu button is FIRST in .files-col-actions: main.js's long-press
    // handler takes the first matching button in document order.
    const actions = el('div', 'files-col-actions');
    const menuBtn = el('button', 'files-iconbtn case-menu-btn');
    menuBtn.type = 'button';
    menuBtn.title = 'More actions';
    menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i><span class="sr-only">More actions</span>';
    actions.appendChild(menuBtn);

    row.append(check, name, owner, mod, size, actions);

    const menu = buildMenu(entry);
    const openMenu = (x, y, origin) => {
      document.querySelectorAll('.case-action-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
      const pad = 8;
      menu.style.transformOrigin = origin;
      menu.style.top = Math.max(pad, Math.min(y, innerHeight - menu.offsetHeight - pad)) + 'px';
      menu.style.left = Math.max(pad, Math.min(x, innerWidth - menu.offsetWidth - pad)) + 'px';
      menu.classList.add('open');
    };
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      openMenu(r.right - menu.offsetWidth, r.bottom + 6, 'top right');
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      openMenu(e.clientX, e.clientY + 4, 'top left');
    });

    check.querySelector('.files-check').addEventListener('click', (e) => {
      e.stopPropagation(); toggleSelect(entry.rel, index, e);
    });
    row.addEventListener('click', (e) => {
      if (e.target.closest('.files-col-actions, .files-check')) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) { toggleSelect(entry.rel, index, e); return; }
      state.selected.clear(); state.selected.add(entry.rel); state.lastIndex = index;
      updateSelBar();
    });
    row.addEventListener('dblclick', () => { if (isDir) load(entry.rel); });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isDir) load(entry.rel);
    });

    row.addEventListener('dragstart', (e) => {
      const rels = state.selected.has(entry.rel) ? [...state.selected] : [entry.rel];
      e.dataTransfer.setData('application/x-caseorg-files', JSON.stringify(rels));
      e.dataTransfer.effectAllowed = 'move';
    });
    if (isDir) {
      row.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('Files') ||
            e.dataTransfer.types.includes('application/x-caseorg-files')) {
          e.preventDefault(); row.classList.add('dragover');
        }
      });
      row.addEventListener('dragleave', () => row.classList.remove('dragover'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation(); row.classList.remove('dragover');
        const moved = e.dataTransfer.getData('application/x-caseorg-files');
        if (moved) { await doMove(JSON.parse(moved), entry.rel); return; }
        if (e.dataTransfer.files.length) await uploadInto(entry.rel, [...e.dataTransfer.files]);
      });
    }
    return row;
  }

  function render() {
    renderCrumbs();
    renderSideYears();
    renderHeaders();

    const table = document.getElementById('files-table');
    table.classList.toggle('view-grid', state.view === 'grid');
    table.classList.toggle('view-list', state.view !== 'grid');
    document.getElementById('files-view-list').classList.toggle('active', state.view !== 'grid');
    document.getElementById('files-view-grid').classList.toggle('active', state.view === 'grid');

    const entries = visibleEntries();
    body.innerHTML = '';
    if (!entries.length) {
      const filtered = state.filter || state.chipType || state.chipModified;
      body.innerHTML =
        '<div class="files-empty">' +
        `<i class="fa-regular ${filtered ? 'fa-face-frown' : 'fa-folder-open'}" aria-hidden="true"></i>` +
        `<p>${filtered ? 'No items match those filters.' : 'This folder is empty.'}</p>` +
        (filtered ? '' : '<p class="files-empty-sub">Drop files here, or use New to add a folder.</p>') +
        '</div>';
    } else {
      const frag = document.createDocumentFragment();
      entries.forEach((e, i) => frag.appendChild(rowFor(e, i)));
      body.appendChild(frag);
    }

    document.getElementById('files-chips-clear').hidden =
      !(state.filter || state.chipType || state.chipModified);

    const canWrite = state.depth >= 3;
    document.getElementById('files-new').classList.toggle('is-limited', !canWrite);
    document.getElementById('files-fab').hidden = !canWrite;

    const bytes = state.files.reduce((n, f) => n + (f.size || 0), 0);
    const fill = document.getElementById('files-storage-fill');
    fill.style.width = Math.min(100, (bytes / (1024 * 1024 * 50)) * 100) + '%';
    document.getElementById('files-storage-text').textContent =
      `${state.dirs.length} folder${state.dirs.length === 1 ? '' : 's'}, ` +
      `${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${humanSize(bytes)}`;

    document.getElementById('files-info').hidden = !state.infoOpen;
    updateSelBar();
    if (state.view === 'grid') lazyThumbs();
  }

  function renderHeaders() {
    document.querySelectorAll('.files-th').forEach((th) => {
      const key = th.dataset.sort;
      const idx = state.sort.findIndex((s) => s.key === key);
      th.classList.toggle('sorted', idx >= 0);
      const i = th.querySelector('i');
      if (!i) return;
      i.className = idx >= 0 && !state.sort[idx].asc
        ? 'fa-solid fa-arrow-down' : 'fa-solid fa-arrow-up';
      i.style.opacity = idx >= 0 ? '1' : '0';
      // Rank badge when more than one key is active.
      th.dataset.rank = state.sort.length > 1 && idx >= 0 ? String(idx + 1) : '';
    });
  }

  function renderCrumbs() {
    const host = document.getElementById('files-crumbs');
    host.innerHTML = '';
    const mk = (label, rel, last) => {
      const b = el('button', `files-crumb${last ? ' current' : ''}`);
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => load(rel));
      b.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-caseorg-files')) {
          e.preventDefault(); b.classList.add('dragover');
        }
      });
      b.addEventListener('dragleave', () => b.classList.remove('dragover'));
      b.addEventListener('drop', async (e) => {
        e.preventDefault(); b.classList.remove('dragover');
        const moved = e.dataTransfer.getData('application/x-caseorg-files');
        if (moved && rel) await doMove(JSON.parse(moved), rel);
      });
      return b;
    };
    host.appendChild(mk('All cases', '', state.crumbs.length === 0));
    state.crumbs.forEach((c, i) => {
      const sep = el('i', 'fa-solid fa-chevron-right files-crumb-sep');
      sep.setAttribute('aria-hidden', 'true');
      host.appendChild(sep);
      host.appendChild(mk(c.name, c.rel, i === state.crumbs.length - 1));
    });
  }

  function renderSideYears() {
    const host = document.getElementById('files-years');
    if (host.dataset.filled === '1' && !state.crumbs.length) return;
    fetch('/api/files/list').then(r => r.json()).then((d) => {
      if (!d.ok) return;
      host.innerHTML = '';
      d.dirs.forEach((y) => {
        const b = el('button', 'files-navitem sub');
        b.type = 'button';
        b.innerHTML = `<i class="fa-regular fa-calendar" aria-hidden="true"></i><span>${escapeHtml(y.name)}</span>`;
        b.classList.toggle('active', state.crumbs[0] && state.crumbs[0].name === y.name);
        b.addEventListener('click', () => load(y.rel));
        host.appendChild(b);
      });
      host.dataset.filled = '1';
    }).catch(() => {});
  }

  function renderInfo() {
    const host = document.getElementById('files-info-body');
    const picked = selectedEntries();
    if (!picked.length) {
      host.innerHTML = '<p class="files-info-hint">Select a file or folder to see its details.</p>';
      document.getElementById('files-info-title').textContent = 'Details';
      return;
    }
    if (picked.length > 1) {
      const bytes = picked.reduce((n, e) => n + (e.size || 0), 0);
      document.getElementById('files-info-title').textContent = `${picked.length} items`;
      host.innerHTML = `<dl><dt>Items</dt><dd>${picked.length}</dd>` +
                       `<dt>Total size</dt><dd>${humanSize(bytes)}</dd></dl>`;
      return;
    }
    const e = picked[0];
    document.getElementById('files-info-title').textContent = e.name;
    const icon = iconFor(e);
    host.innerHTML =
      `<div class="files-info-icon"><i class="${icon.cls} tint-${icon.tint}" aria-hidden="true"></i></div>` +
      '<dl>' +
      `<dt>Type</dt><dd>${e.kind === 'dir' ? 'Folder' : (extOf(e.name).toUpperCase() || 'File')}</dd>` +
      `<dt>Size</dt><dd>${e.kind === 'dir' ? '—' : humanSize(e.size)}</dd>` +
      `<dt>Modified</dt><dd>${humanDate(e.mtime)}</dd>` +
      `<dt>Owner</dt><dd>me</dd>` +
      `<dt>Location</dt><dd>${escapeHtml(state.path || 'All cases')}</dd>` +
      '</dl>';
  }

  // ---- thumbnails --------------------------------------------------------
  function lazyThumbs() {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const node = e.target;
        io.unobserve(node);
        const rel = node.closest('[data-rel]')?.dataset.rel;
        if (!rel) return;
        const img = new Image();
        img.alt = '';
        // Listener before src: a cached image fires load immediately.
        img.addEventListener('load', () => { node.innerHTML = ''; node.appendChild(img); });
        img.addEventListener('error', () => {
          state.noThumb.add(rel); node.classList.add('no-preview');
        });
        img.src = `/api/files/thumb?rel=${encodeURIComponent(rel)}`;
      });
    }, { rootMargin: '250px' });
    body.querySelectorAll('.files-thumb:not(.no-preview)').forEach(n => io.observe(n));
  }

  // ---- uploads -----------------------------------------------------------
  async function uploadInto(rel, files) {
    if (!files.length) return;
    const keep = await openConfirm(
      `Upload ${files.length} file(s) using the server's naming convention ` +
      `(“name - Case Name.pdf”)?\n\nChoose No to keep each file's own name.`,
      'Upload Files');
    const fd = new FormData();
    fd.append('rel', rel);
    fd.append('naming', keep ? 'standard' : 'original');
    files.forEach(f => fd.append('file', f));
    try {
      const r = await fetch('/api/files/upload',
        { method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd });
      const data = await r.json();
      if (!data.ok) alert(data.msg || 'Upload failed.');
      else if (data.skipped && data.skipped.length) {
        alert(`Uploaded ${data.saved.length}. Skipped (unsupported type): ${data.skipped.join(', ')}`);
      }
    } catch (err) {
      alert(`Upload failed: ${err}`);
    } finally {
      load(state.path, { push: false });
    }
  }

  // ---- New menu ----------------------------------------------------------
  const newBtn = document.getElementById('files-new');
  const newMenu = el('div', 'case-action-menu');
  (function buildNewMenu() {
    const add = (icon, label, fn) => {
      const b = el('button', '');
      b.type = 'button';
      b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}`;
      b.addEventListener('click', async () => { newMenu.classList.remove('open'); await fn(); });
      newMenu.appendChild(b);
    };
    add('fa-folder-plus', 'New folder', async () => {
      if (state.depth < 3) { alert('Open a case folder first.'); return; }
      const name = await openRenamePrompt(STANDARD_SUBDIRS[0] || '', 'New Folder');
      if (!name) return;
      if (!STANDARD_SUBDIRS.includes(name)) {
        alert(`Choose one of the standard sub-folders:\n\n${STANDARD_SUBDIRS.join('\n')}`);
        return;
      }
      const data = await postJSON('/api/files/new-folder', { rel: state.path, name });
      if (data.ok) load(state.path, { push: false });
      else alert(data.msg || 'Could not create that folder.');
    });
    add('fa-file-arrow-up', 'File upload', () => {
      if (state.depth < 3) { alert('Open a case folder first.'); return; }
      document.getElementById('files-input').click();
    });
    document.body.appendChild(newMenu);
  })();
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.case-action-menu.open').forEach(m => { if (m !== newMenu) m.classList.remove('open'); });
    const r = newBtn.getBoundingClientRect();
    newMenu.style.transformOrigin = 'top left';
    newMenu.style.top = (r.bottom + 6) + 'px';
    newMenu.style.left = r.left + 'px';
    const open = newMenu.classList.toggle('open');
    newBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // ---- toolbar wiring ----------------------------------------------------
  document.getElementById('files-view-list').addEventListener('click', () => {
    state.view = 'list'; savePrefs(); render();
  });
  document.getElementById('files-view-grid').addEventListener('click', () => {
    state.view = 'grid'; savePrefs(); render();
  });
  document.getElementById('files-info-toggle').addEventListener('click', () => {
    state.infoOpen = !state.infoOpen; savePrefs(); render();
  });
  document.getElementById('files-info-close').addEventListener('click', () => {
    state.infoOpen = false; savePrefs(); render();
  });

  document.querySelectorAll('.files-th').forEach((th) => {
    th.addEventListener('click', (e) => {
      const key = th.dataset.sort;
      const idx = state.sort.findIndex(s => s.key === key);
      if (e.shiftKey) {
        // Shift appends a secondary key rather than replacing.
        if (idx >= 0) state.sort[idx].asc = !state.sort[idx].asc;
        else state.sort.push({ key, asc: true });
      } else if (idx === 0 && state.sort.length === 1) {
        state.sort = [{ key, asc: !state.sort[0].asc }];
      } else {
        state.sort = [{ key, asc: true }];
      }
      savePrefs(); render();
    });
  });

  const filterBox = document.getElementById('files-filter');
  filterBox.addEventListener('input', () => { state.filter = filterBox.value; render(); });

  const chipType = document.getElementById('files-chip-type');
  const chipMod = document.getElementById('files-chip-modified');
  const chipSort = document.getElementById('files-chip-sort');
  chipSort.value = state.sort[0].key;
  chipType.addEventListener('change', () => { state.chipType = chipType.value; render(); });
  chipMod.addEventListener('change', () => { state.chipModified = chipMod.value; render(); });
  chipSort.addEventListener('change', () => {
    state.sort = [{ key: chipSort.value, asc: true }]; savePrefs(); render();
  });
  document.getElementById('files-chips-clear').addEventListener('click', () => {
    state.filter = ''; state.chipType = ''; state.chipModified = '';
    // The LLD overrides the select's .value setter, so assigning here already
    // resyncs its trigger text — no extra nudge needed.
    filterBox.value = ''; chipType.value = ''; chipMod.value = '';
    render();
  });

  // Every <select> goes through the app's own dropdown, exactly as Manage
  // Case, Create Case and the calendar modals do.
  if (typeof convertAllSelectsToLLD === 'function') {
    convertAllSelectsToLLD(document.getElementById('files-chips'));
  }

  document.getElementById('files-check-all').addEventListener('change', (e) => {
    state.selected.clear();
    if (e.target.checked) visibleEntries().forEach(x => state.selected.add(x.rel));
    updateSelBar();
  });

  document.querySelectorAll('.files-navitem[data-nav]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.files-navitem[data-nav]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      if (b.dataset.nav === 'all') load('');
      else if (b.dataset.nav === 'starred') {
        state.filter = ''; filterBox.value = '';
        alert('Starred items are marked with a star in the list. Star anything from its row menu.');
      } else {
        state.sort = [{ key: 'modified', asc: false }]; savePrefs(); render();
      }
    });
  });

  // ---- bulk actions ------------------------------------------------------
  document.getElementById('files-sel-clear').addEventListener('click', () => {
    state.selected.clear(); updateSelBar();
  });
  document.getElementById('files-sel-download').addEventListener('click', () => {
    const q = [...state.selected].map(r => `rel=${encodeURIComponent(r)}`).join('&');
    if (q) window.location.href = `/api/files/zip?${q}`;
  });
  document.getElementById('files-sel-delete').addEventListener('click', () => doDelete(selectedEntries()));
  document.getElementById('files-sel-move').addEventListener('click', async () => {
    const dest = await openRenamePrompt(state.path, 'Move to folder');
    if (dest) await doMove([...state.selected], dest);
  });

  // ---- page-level drag and drop -----------------------------------------
  const veil = document.getElementById('files-dropveil');
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth += 1;
    if (state.depth >= 3) veil.hidden = false;
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) veil.hidden = true;
  });
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); dragDepth = 0; veil.hidden = true;
    if (state.depth < 3) return;
    if (e.dataTransfer.files.length) await uploadInto(state.path, [...e.dataTransfer.files]);
  });

  const fileInput = document.getElementById('files-input');
  fileInput.addEventListener('change', async () => {
    const chosen = [...fileInput.files];
    fileInput.value = '';
    await uploadInto(state.path, chosen);
  });
  document.getElementById('files-fab').addEventListener('click', () => {
    if (state.depth >= 3) fileInput.click();
  });

  // ---- keyboard ----------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'Escape') { state.selected.clear(); updateSelBar(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault(); visibleEntries().forEach(x => state.selected.add(x.rel)); updateSelBar();
    }
    if (e.key === 'Delete' && state.canDelete && state.selected.size) doDelete(selectedEntries());
    if (e.key === 'F2' && state.selected.size === 1) doRename(selectedEntries()[0]);
    if (e.key === 'Backspace') {
      e.preventDefault();
      history.back();
    }
  });

  window.addEventListener('popstate', () => {
    load(new URLSearchParams(location.search).get('path') || '', { push: false });
  });

  load(new URLSearchParams(location.search).get('path') || '', { push: false });
})();
