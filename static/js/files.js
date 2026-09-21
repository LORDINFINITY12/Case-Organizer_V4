/* Files page — a Drive-like view over the case tree.
 *
 * Loaded after main.js, which supplies $, el, escapeHtml, smartTruncate,
 * openConfirm, openRenamePrompt, uploadWithProgress, makeProgressBar,
 * offloadLargeFiles, _csrfToken and CASEORG_IS_ADMIN.
 */
(function () {
  const body = document.getElementById('files-body');
  if (!body) return;   // not the Files page

  const STANDARD_SUBDIRS = (window.CaseOrg && window.CaseOrg.standardSubdirs) || [];
  const PREFS = 'caseOrg.files.prefs';

  const state = {
    path: '',
    depth: 0,
    canDelete: false,
    dirs: [],
    files: [],
    crumbs: [],
    selected: new Set(),
    lastIndex: -1,
    view: 'list',
    sort: 'name',
    asc: true,
    filter: '',
    expanded: new Set(),   // tree view
    // Rels whose thumbnail the server could not produce. Kept across
    // renders so a folder of unrenderable files is not re-requested
    // every time the view changes.
    noThumb: new Set(),
  };

  // ---- prefs -------------------------------------------------------------
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) || '{}');
    if (saved.view) state.view = saved.view;
    if (saved.sort) state.sort = saved.sort;
    if (typeof saved.asc === 'boolean') state.asc = saved.asc;
  } catch (e) { /* defaults are fine */ }

  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(
        { view: state.view, sort: state.sort, asc: state.asc }));
    } catch (e) { /* private mode */ }
  };

  // ---- formatting --------------------------------------------------------
  function humanSize(n) {
    if (!n && n !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function humanDate(epoch) {
    if (!epoch) return '';
    const d = new Date(epoch * 1000);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

  function iconFor(entry) {
    if (entry.kind === 'dir') return 'fa-folder';
    const e = extOf(entry.name);
    if (e === 'pdf') return 'fa-file-pdf';
    if (['png', 'jpg', 'jpeg'].includes(e)) return 'fa-file-image';
    if (e === 'docx') return 'fa-file-word';
    if (['txt', 'md', 'json'].includes(e)) return 'fa-file-lines';
    if (['zip', 'rar', '7z'].includes(e)) return 'fa-file-zipper';
    return 'fa-file';
  }

  // ---- data --------------------------------------------------------------
  async function load(path, { push = true } = {}) {
    body.innerHTML = '<div class="files-empty">Loading…</div>';
    let data;
    try {
      const r = await fetch(`/api/files/list?path=${encodeURIComponent(path || '')}`);
      data = await r.json();
    } catch (err) {
      body.innerHTML = `<div class="files-empty">Could not reach the server: ${escapeHtml(String(err))}</div>`;
      return;
    }
    if (!data.ok) {
      body.innerHTML = `<div class="files-empty">${escapeHtml(data.msg || 'Could not open that folder.')}</div>`;
      return;
    }
    Object.assign(state, {
      path: data.path, depth: data.depth, canDelete: data.can_delete,
      dirs: data.dirs, files: data.files, crumbs: data.crumbs,
    });
    state.selected.clear();
    state.lastIndex = -1;
    if (push) {
      const q = state.path ? `?path=${encodeURIComponent(state.path)}` : '';
      history.replaceState(null, '', `/files${q}`);
    }
    render();
  }

  // ---- sorting / filtering ----------------------------------------------
  function visibleEntries() {
    const needle = state.filter.trim().toLowerCase();
    const match = (e) => !needle || e.name.toLowerCase().includes(needle);
    const dirs = state.dirs.filter(match);
    const files = state.files.filter(match);

    const cmp = (a, b) => {
      let v = 0;
      if (state.sort === 'size') v = (a.size || 0) - (b.size || 0);
      else if (state.sort === 'modified') v = (a.mtime || 0) - (b.mtime || 0);
      else if (state.sort === 'type') v = extOf(a.name).localeCompare(extOf(b.name));
      if (v === 0) v = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return state.asc ? v : -v;
    };
    // Folders always lead, as in every file manager.
    return [...dirs.sort(cmp), ...files.sort(cmp)];
  }

  // ---- selection ---------------------------------------------------------
  function updateSelBar() {
    const bar = document.getElementById('files-selbar');
    const count = state.selected.size;
    bar.hidden = count === 0;
    document.getElementById('files-selcount').textContent =
      `${count} selected`;
    const del = document.getElementById('files-sel-delete');
    del.hidden = !state.canDelete;
    body.querySelectorAll('[data-rel]').forEach((row) => {
      row.classList.toggle('selected', state.selected.has(row.dataset.rel));
      const cb = row.querySelector('.files-check');
      if (cb) cb.checked = state.selected.has(row.dataset.rel);
    });
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

  // ---- row actions -------------------------------------------------------
  function buildMenu(entry) {
    const menu = el('div', 'case-action-menu');
    const add = (icon, label, fn, danger) => {
      const b = el('button', danger ? 'danger' : '');
      b.type = 'button';
      b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}`;
      b.addEventListener('click', async () => { menu.classList.remove('open'); await fn(); });
      menu.appendChild(b);
      return b;
    };

    if (entry.kind === 'dir') {
      add('fa-folder-open', 'Open', () => load(entry.rel));
    } else {
      const a = el('button', '');
      a.type = 'button';
      a.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i> Download';
      a.addEventListener('click', () => {
        menu.classList.remove('open');
        window.location.href =
          `/static-serve?path=${encodeURIComponent(entry.abs)}&download=1`;
      });
      menu.appendChild(a);
      if (extOf(entry.name) === 'pdf') {
        add('fa-file-pdf', 'Open in PDF tools', () => { window.location.href = '/bento'; });
      }
    }

    if (entry.kind === 'dir') {
      add('fa-file-zipper', 'Download as ZIP', () => {
        window.location.href = `/api/files/zip?path=${encodeURIComponent(entry.rel)}`;
      });
    }

    add('fa-pen', 'Rename', () => doRename(entry));

    if (entry.kind === 'file' && entry.viewable) {
      add('fa-arrows-rotate', 'Replace…', () => doReplace(entry));
    }

    if (state.canDelete) {
      add('fa-trash', 'Delete', () => doDelete([entry]), true);
    }
    document.body.appendChild(menu);
    return menu;
  }

  async function doRename(entry) {
    // Case folders cascade calendar events, so they go through the admin-only
    // case rename; everything deeper uses the generic one.
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
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
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
      fd.append('rel', entry.rel);
      fd.append('file', f);
      const r = await fetch('/api/files/replace', {
        method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd,
      });
      const data = await r.json();
      if (data.ok) load(state.path, { push: false });
      else alert(data.msg || 'Replace failed.');
    };
    input.click();
  }

  async function doDelete(entries) {
    const what = entries.length === 1
      ? `“${entries[0].name}”`
      : `${entries.length} items`;
    const ok = await openConfirm(
      `Delete ${what}? This cannot be undone.`, 'Confirm Delete');
    if (!ok) return;
    for (const entry of entries) {
      const r = await fetch('/api/delete-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
        body: JSON.stringify({ rel: entry.rel, scope: 'cases' }),
      });
      const data = await r.json();
      if (!data.ok) { alert(`${entry.name}: ${data.msg || 'delete failed'}`); break; }
    }
    load(state.path, { push: false });
  }

  async function doMove(rels, dest) {
    const r = await fetch('/api/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
      body: JSON.stringify({ src: rels, dest }),
    });
    const data = await r.json();
    if (!data.ok && data.msg) alert(data.msg);
    else if (data.conflicts && data.conflicts.length) {
      alert(`Already in that folder: ${data.conflicts.join(', ')}`);
    }
    load(state.path, { push: false });
  }

  // ---- rendering ---------------------------------------------------------
  function rowFor(entry, index) {
    const isDir = entry.kind === 'dir';
    const row = el('div', `result-item files-row${isDir ? ' folder' : ''}`);
    row.dataset.rel = entry.rel;
    row.dataset.kind = entry.kind;
    row.draggable = true;

    // Grid tiles get a thumbnail slot, filled lazily on scroll so that
    // rendering a PDF's first page never blocks the folder listing.
    if (state.view === 'grid') {
      const thumb = el('div', 'files-thumb');
      thumb.innerHTML = `<i class="fa-solid ${iconFor(entry)}" aria-hidden="true"></i>`;
      if (isDir || !['pdf', 'png', 'jpg', 'jpeg'].includes(extOf(entry.name))
          || state.noThumb.has(entry.rel)) {
        thumb.classList.add('no-preview');
      }
      row.appendChild(thumb);
    }

    const name = el('div', 'name');
    name.innerHTML =
      `<input type="checkbox" class="files-check" aria-label="Select ${escapeHtml(entry.name)}" />` +
      `<i class="fa-solid ${iconFor(entry)}" aria-hidden="true"></i>` +
      `<span class="files-name-text">${escapeHtml(smartTruncate(entry.name, 90))}</span>`;
    row.appendChild(name);

    const meta = el('span', 'files-meta');
    meta.textContent = isDir ? humanDate(entry.mtime)
      : `${humanSize(entry.size)} · ${humanDate(entry.mtime)}`;
    row.appendChild(meta);

    // The menu button must come FIRST in .icon-row: main.js's mobile
    // long-press handler picks the first match of
    // '.case-menu-btn, [data-case-menu], .icon-btn' in document order, so a
    // leading Download link would make long-press start a download instead.
    const icons = el('div', 'icon-row');
    const menuBtn = el('button', 'icon-btn case-menu-btn');
    menuBtn.type = 'button';
    menuBtn.title = 'Actions';
    menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i><span class="sr-only">Actions</span>';
    icons.appendChild(menuBtn);
    row.appendChild(icons);

    const menu = buildMenu(entry);
    const openMenu = (x, y, origin) => {
      document.querySelectorAll('.case-action-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
      const pad = 8;
      menu.style.transformOrigin = origin;
      menu.style.top = Math.max(pad, Math.min(y, window.innerHeight - menu.offsetHeight - pad)) + 'px';
      menu.style.left = Math.max(pad, Math.min(x, window.innerWidth - menu.offsetWidth - pad)) + 'px';
      menu.classList.add('open');
    };
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      openMenu(rect.right - menu.offsetWidth, rect.bottom + 6, 'top right');
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      openMenu(e.clientX, e.clientY + 4, 'top left');
    });

    const cb = name.querySelector('.files-check');
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(entry.rel, index, e); });

    row.addEventListener('click', (e) => {
      if (e.target.closest('.icon-row') || e.target.closest('.files-check')) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) { toggleSelect(entry.rel, index, e); return; }
      if (isDir) load(entry.rel);
    });

    // ---- drag to move ----
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
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('dragover');
        const moved = e.dataTransfer.getData('application/x-caseorg-files');
        if (moved) { await doMove(JSON.parse(moved), entry.rel); return; }
        if (e.dataTransfer.files.length) await uploadInto(entry.rel, [...e.dataTransfer.files]);
      });
    }
    return row;
  }

  function render() {
    renderCrumbs();
    body.className = `files-body results view-${state.view}`;
    body.innerHTML = '';

    const entries = visibleEntries();
    if (!entries.length) {
      body.innerHTML = `<div class="files-empty">${state.filter ? 'Nothing matches that filter.' : 'This folder is empty.'}</div>`;
    } else if (state.view === 'tree') {
      renderTree();
    } else {
      entries.forEach((entry, i) => body.appendChild(rowFor(entry, i)));
    }

    const bytes = state.files.reduce((n, f) => n + (f.size || 0), 0);
    document.getElementById('files-summary').textContent = entries.length
      ? `${state.dirs.length} folder(s), ${state.files.length} file(s) · ${humanSize(bytes)}`
      : '';

    const canWrite = state.depth >= 3;
    document.getElementById('files-upload-btn').disabled = !canWrite;
    document.getElementById('files-new-folder').disabled = !canWrite;
    const dz = document.getElementById('files-drop');
    dz.classList.toggle('is-disabled', !canWrite);
    dz.textContent = canWrite
      ? 'Drag & drop files here, or use Upload'
      : 'Open a case folder to upload.';
    document.getElementById('files-fab').hidden = !canWrite;
    updateSelBar();
    if (state.view === 'grid') lazyThumbs();
  }

  function renderCrumbs() {
    const host = document.getElementById('files-crumbs');
    host.innerHTML = '';
    const mk = (label, rel) => {
      const b = el('button', 'files-crumb');
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
    host.appendChild(mk('All cases', ''));
    state.crumbs.forEach((c) => {
      host.appendChild(el('span', 'files-crumb-sep')).textContent = '/';
      host.appendChild(mk(c.name, c.rel));
    });
  }

  // ---- tree view ---------------------------------------------------------
  async function renderTree() {
    const host = el('div', 'files-tree');
    body.appendChild(host);
    await treeLevel(host, state.path, 0);
  }

  async function treeLevel(host, path, depth) {
    let data;
    try {
      const r = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`);
      data = await r.json();
    } catch (e) { return; }
    if (!data.ok) return;

    [...data.dirs, ...data.files].forEach((entry) => {
      const node = el('div', 'files-tree-node');
      node.style.paddingLeft = `${depth * 18}px`;
      const isDir = entry.kind === 'dir';
      const open = state.expanded.has(entry.rel);
      node.innerHTML =
        `<i class="fa-solid ${isDir ? (open ? 'fa-chevron-down' : 'fa-chevron-right') : 'fa-minus'} files-tree-caret" aria-hidden="true"></i>` +
        `<i class="fa-solid ${iconFor(entry)}" aria-hidden="true"></i> ` +
        `<span>${escapeHtml(entry.name)}</span>`;
      node.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!isDir) { window.location.href = `/static-serve?path=${encodeURIComponent(entry.abs)}`; return; }
        if (state.expanded.has(entry.rel)) state.expanded.delete(entry.rel);
        else state.expanded.add(entry.rel);
        render();
      });
      host.appendChild(node);
      if (isDir && open) {
        const child = el('div', '');
        host.appendChild(child);
        treeLevel(child, entry.rel, depth + 1);
      }
    });
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
        // Attach the handler BEFORE setting src: a cached image fires load
        // immediately, and a listener added afterwards would never see it.
        img.addEventListener('load', () => { node.innerHTML = ''; node.appendChild(img); });
        img.addEventListener('error', () => {
          state.noThumb.add(rel);
          node.classList.add('no-preview');
        });
        img.src = `/api/files/thumb?rel=${encodeURIComponent(rel)}`;
      });
    }, { rootMargin: '200px' });
    body.querySelectorAll('.files-thumb:not(.no-preview)').forEach((n) => io.observe(n));
  }

  // ---- uploads -----------------------------------------------------------
  async function uploadInto(rel, files) {
    if (!files.length) return;
    let naming = 'standard';
    const keep = await openConfirm(
      `Upload ${files.length} file(s) using the server's naming convention ` +
      `(“name - Case Name.pdf”)?\n\nChoose No to keep each file's own name.`,
      'Upload Files');
    naming = keep ? 'standard' : 'original';

    const host = document.getElementById('files-summary');
    const bar = makeProgressBar ? makeProgressBar(host) : null;
    const fd = new FormData();
    fd.append('rel', rel);
    fd.append('naming', naming);
    files.forEach((f) => fd.append('file', f));
    try {
      const r = await fetch('/api/files/upload', {
        method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd,
      });
      const data = await r.json();
      if (!data.ok) alert(data.msg || 'Upload failed.');
      else if (data.skipped && data.skipped.length) {
        alert(`Uploaded ${data.saved.length}. Skipped (unsupported type): ${data.skipped.join(', ')}`);
      }
    } catch (err) {
      alert(`Upload failed: ${err}`);
    } finally {
      if (bar && bar.remove) bar.remove();
      load(state.path, { push: false });
    }
  }

  // ---- toolbar wiring ----------------------------------------------------
  document.querySelectorAll('.files-view-toggle [data-view]').forEach((b) => {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      savePrefs();
      document.querySelectorAll('.files-view-toggle [data-view]')
        .forEach(x => x.classList.toggle('active', x === b));
      render();
    });
    b.classList.toggle('active', b.dataset.view === state.view);
  });

  const sortSel = document.getElementById('files-sort');
  sortSel.value = state.sort;
  sortSel.addEventListener('change', () => { state.sort = sortSel.value; savePrefs(); render(); });
  document.getElementById('files-sort-dir').addEventListener('click', () => {
    state.asc = !state.asc; savePrefs(); render();
  });

  const filterBox = document.getElementById('files-filter');
  filterBox.addEventListener('input', () => { state.filter = filterBox.value; render(); });

  document.getElementById('files-new-folder').addEventListener('click', async () => {
    const name = await openRenamePrompt(STANDARD_SUBDIRS[0] || '', 'New Folder');
    if (!name) return;
    if (!STANDARD_SUBDIRS.includes(name)) {
      alert(`Choose one of the standard sub-folders:\n\n${STANDARD_SUBDIRS.join('\n')}`);
      return;
    }
    const r = await fetch('/api/files/new-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
      body: JSON.stringify({ rel: state.path, name }),
    });
    const data = await r.json();
    if (data.ok) load(state.path, { push: false });
    else alert(data.msg || 'Could not create that folder.');
  });

  const fileInput = document.getElementById('files-input');
  const pickFiles = () => { if (state.depth >= 3) fileInput.click(); };
  document.getElementById('files-upload-btn').addEventListener('click', pickFiles);
  document.getElementById('files-fab').addEventListener('click', pickFiles);
  fileInput.addEventListener('change', async () => {
    const chosen = [...fileInput.files];
    fileInput.value = '';
    await uploadInto(state.path, chosen);
  });

  const dz = document.getElementById('files-drop');
  dz.addEventListener('click', pickFiles);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (state.depth < 3) return;
    if (e.dataTransfer.files.length) await uploadInto(state.path, [...e.dataTransfer.files]);
  });

  // ---- bulk actions ------------------------------------------------------
  const selected = () => [...state.dirs, ...state.files].filter(e => state.selected.has(e.rel));
  document.getElementById('files-sel-clear').addEventListener('click', () => {
    state.selected.clear(); updateSelBar();
  });
  document.getElementById('files-sel-download').addEventListener('click', () => {
    const q = [...state.selected].map(r => `rel=${encodeURIComponent(r)}`).join('&');
    if (q) window.location.href = `/api/files/zip?${q}`;
  });
  document.getElementById('files-sel-delete').addEventListener('click', () => doDelete(selected()));
  document.getElementById('files-sel-move').addEventListener('click', async () => {
    const dest = await openRenamePrompt(state.path, 'Move to folder (path)');
    if (dest) await doMove([...state.selected], dest);
  });

  // ---- keyboard ----------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'Escape') { state.selected.clear(); updateSelBar(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      visibleEntries().forEach(x => state.selected.add(x.rel));
      updateSelBar();
    }
    if (e.key === 'Delete' && state.canDelete && state.selected.size) doDelete(selected());
    if (e.key === 'Backspace' && state.crumbs.length) {
      e.preventDefault();
      load(state.crumbs.length > 1 ? state.crumbs[state.crumbs.length - 2].rel : '');
    }
  });

  window.addEventListener('popstate', () => {
    load(new URLSearchParams(location.search).get('path') || '', { push: false });
  });

  load(new URLSearchParams(location.search).get('path') || '', { push: false });
})();
