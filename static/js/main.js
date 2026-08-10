/* ============================================================================
   Case Organizer — main.js (full rewrite, v2)
   ============================================================================
   Covers:
   - Global helpers ($, el)
   - Taxonomies (SUBCATS, CASE_TYPES)
   - Search (basic + advanced) with single authoritative renderResults
   - Infinite year dropdown
   - Create Case form
   - Manage Case form (year/month/case, domain→subcategory, file upload)
   - Note.json button (either Add OR View/Edit) + modal wiring
   - Flash auto-dismiss
   - Theme toggle
   ============================================================================ */

// Small helpers
function $(sel){ return document.querySelector(sel); }
function el(tag, cls){ const e=document.createElement(tag); if(cls) e.className=cls; return e; }

/** Read the CSRF token from the page meta tag. */
function _csrfToken() {
  const m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.content : '';
}

/* ---------- Indian dd/mm/yyyy date fields ----------
   A native <input type="date"> renders in the browser's locale and cannot be
   forced to another order, so on a US-configured machine it shows mm/dd/yyyy.
   The visible control is a text field in Indian order; the element keeping the
   original id becomes a hidden input carrying the ISO value, so everything
   that already reads or writes that id keeps working unchanged.

   The markup is built here rather than in each form's template so the two
   forms cannot drift apart. */

function dateIsoToIn(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : '';
}

function dateInToIso(text) {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec((text || '').trim());
  if (!m) return '';
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  // Rejects 31/02 and friends, which Date would silently roll forward.
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}`;
}

/**
 * Turn <input type="date" id="X"> into a dd/mm/yyyy field.
 * The id moves to a hidden input holding the ISO value.
 * Returns { set(iso), get() } or null when the element is absent.
 */
function initIndianDateField(id, initialIso) {
  const original = document.getElementById(id);
  if (!original || original.type === 'hidden') return null;

  const wrap = document.createElement('span');
  wrap.className = 'date-in-wrap ' + (original.className || '');
  wrap.innerHTML =
    '<input type="text" class="date-in-text" inputmode="numeric" placeholder="dd/mm/yyyy"' +
    ' maxlength="10" autocomplete="off" aria-label="Date">' +
    '<button type="button" class="date-in-btn" aria-label="Open date picker">' +
    '<i class="fa-regular fa-calendar"></i></button>' +
    '<input type="date" class="date-in-native" tabindex="-1" aria-label="Choose date">';

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.id = id;
  wrap.appendChild(hidden);

  original.removeAttribute('id');
  original.replaceWith(wrap);

  const text = wrap.querySelector('.date-in-text');
  const native = wrap.querySelector('.date-in-native');
  const btn = wrap.querySelector('.date-in-btn');

  const commit = () => {
    const iso = dateInToIso(text.value);
    hidden.value = iso;
    // The picker is overlaid on the button and takes the tap itself, so it has
    // to track what is typed or it would open on today instead.
    if (iso) native.value = iso;
  };

  text.addEventListener('input', (e) => {
    if (!(e.inputType && e.inputType.startsWith('delete'))) {
      const digits = text.value.replace(/\D/g, '').slice(0, 8);
      text.value = digits.length > 4
        ? `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
        : digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    }
    commit();
  });

  native.addEventListener('change', () => {
    if (native.value) { text.value = dateIsoToIn(native.value); commit(); }
  });

  // Keyboard only; pointer events land on the overlaid input.
  btn.addEventListener('click', () => {
    try { native.showPicker(); } catch (_) { native.click(); }
  });

  const api = {
    get() { return hidden.value; },
    set(iso) { text.value = dateIsoToIn(iso || ''); commit(); },
  };
  if (initialIso) api.set(initialIso);
  return api;
}

/** Today as YYYY-MM-DD in local time (toISOString would shift across UTC). */
function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * POST a FormData with upload progress.  fetch() cannot report how much of the
 * body has gone out, so uploads go through XHR and drive a determinate bar.
 * Resolves (never rejects) with { ok, status, data, text }.
 */
function uploadWithProgress(url, formData, onProgress){
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-CSRF-Token', _csrfToken());
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && typeof onProgress === 'function') {
        onProgress(e.loaded / e.total);
      }
    });
    // A fast (or fully buffered) upload can finish without ever emitting an
    // intermediate progress event — LAN and loopback both do this.  Mark the
    // send complete so the bar moves on to "Processing…" instead of sitting at 0%.
    xhr.upload.addEventListener('load', () => {
      if (typeof onProgress === 'function') onProgress(1);
    });
    const finish = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_e) { data = null; }
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        data,
        text: xhr.responseText || '',
      });
    };
    xhr.addEventListener('load', finish);
    xhr.addEventListener('error', () => resolve({ ok: false, status: 0, data: null, text: '' }));
    xhr.addEventListener('abort', () => resolve({ ok: false, status: 0, data: null, text: '' }));
    xhr.send(formData);
  });
}

/**
 * Determinate progress bar appended to `host`.  Once the bytes are all sent the
 * server is still validating/writing, so the label switches to "Processing…"
 * rather than sitting at a misleading 100%.
 */
function makeProgressBar(host){
  if (!host) return { set(){}, done(){} };
  const wrap = el('div', 'upload-progress');
  wrap.innerHTML = '<div class="upload-progress-track"><div class="upload-progress-bar"></div></div>'
                 + '<span class="upload-progress-label">0%</span>';
  host.appendChild(wrap);
  const bar = wrap.querySelector('.upload-progress-bar');
  const label = wrap.querySelector('.upload-progress-label');
  return {
    set(frac){
      const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)));
      bar.style.width = pct + '%';
      label.textContent = pct >= 100 ? 'Processing…' : pct + '%';
    },
    done(){ wrap.remove(); },
  };
}

/* ==========================================================================
   Large uploads.

   Cloudflare refuses request bodies over 100 MB, so a big PDF cannot be posted
   in one piece through the tunnel. Anything at or above the threshold is sliced
   and sent to /api/upload/chunk, then referenced by id in the normal form post.
   The server reassembles it and runs it through the same validation as a direct
   upload, so behaviour is identical either way — only the transport differs.
   ========================================================================== */

const CHUNK_THRESHOLD_BYTES = 80 * 1024 * 1024;   // safely under Cloudflare's 100 MB
const CHUNK_SIZE_BYTES      = 16 * 1024 * 1024;

function _uploadId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/**
 * Send one oversized file in slices. Resolves with the id the form should
 * reference. `onProgress` receives 0..1 across the whole file.
 */
async function uploadInChunks(file, onProgress) {
  const id = _uploadId();
  const total = Math.ceil(file.size / CHUNK_SIZE_BYTES);
  for (let i = 0; i < total; i++) {
    const slice = file.slice(i * CHUNK_SIZE_BYTES, (i + 1) * CHUNK_SIZE_BYTES);
    const fd = new FormData();
    fd.set('upload_id', id);
    fd.set('index', String(i));
    fd.set('total', String(total));
    fd.append('chunk', slice, file.name);
    const r = await uploadWithProgress('/api/upload/chunk', fd, (frac) => {
      if (typeof onProgress === 'function') onProgress((i + (frac || 0)) / total);
    });
    if (!r.ok || !(r.data && r.data.ok)) {
      throw new Error((r.data && r.data.msg) || `Chunk ${i + 1}/${total} failed (HTTP ${r.status})`);
    }
  }
  if (typeof onProgress === 'function') onProgress(1);
  return { id, filename: file.name };
}

/**
 * Move every file at or over the threshold out of `fd` and into chunked
 * transfers, recording them in a `chunked` field. Small files are left in the
 * form untouched, so the common case is unchanged.
 */
async function offloadLargeFiles(fd, field, files, onProgress) {
  const big = files.filter((f) => f.size >= CHUNK_THRESHOLD_BYTES);
  if (!big.length) return fd;

  const small = files.filter((f) => f.size < CHUNK_THRESHOLD_BYTES);
  fd.delete(field);
  small.forEach((f) => fd.append(field, f));

  const bigBytes = big.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const refs = [];
  for (const f of big) {
    const ref = await uploadInChunks(f, (frac) => {
      if (typeof onProgress === 'function') onProgress((done + frac * f.size) / bigBytes);
    });
    done += f.size;
    refs.push(ref);
  }
  fd.set('chunked', JSON.stringify(refs));
  return fd;
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value){
  return String(value ?? '').replace(/[&<>\"']/g, ch => HTML_ESCAPE[ch] || ch);
}

function normalizeNewlines(value){
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*br\s*>/gi, '\n');
}

function isSafeMarkdownHref(rawHref){
  const href = String(rawHref || '').trim();
  if (!href) return false;
  try {
    const parsed = new URL(href, window.location.origin);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
  } catch (_err) {
    return false;
  }
}

function renderMarkdownInline(value){
  let html = escapeHtml(String(value ?? ''));
  const codeTokens = [];
  html = html.replace(/`([^`\n]+)`/g, (_m, codeText) => {
    const token = `@@CODE${codeTokens.length}@@`;
    codeTokens.push(`<code>${codeText}</code>`);
    return token;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const decodedHref = href.replace(/&amp;/g, '&');
    if (!isSafeMarkdownHref(decodedHref)) return label;
    return `<a href="${escapeHtml(decodedHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/@@CODE(\d+)@@/g, (_m, idx) => codeTokens[Number(idx)] || '');
  return html;
}

function isMarkdownBlockStart(line){
  const t = (line || '').trim();
  return /^#{1,6}\s+/.test(t)
    || /^>\s?/.test(t)
    || /^[-*+]\s+/.test(t)
    || /^\d+\.\s+/.test(t)
    || /^```/.test(t)
    || /^(-{3,}|\*{3,}|_{3,})$/.test(t);
}

function splitMarkdownTableRow(line){
  const raw = String(line ?? '').trim();
  if (!raw.includes('|')) return [];
  let row = raw;
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map(cell => cell.trim());
}

function isMarkdownTableSeparator(line){
  const cells = splitMarkdownTableRow(line);
  if (!cells.length) return false;
  return cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function isMarkdownTableStart(lines, index){
  if (!Array.isArray(lines) || index < 0 || index + 1 >= lines.length) return false;
  const header = splitMarkdownTableRow(lines[index]);
  const separator = splitMarkdownTableRow(lines[index + 1]);
  if (header.length < 2 || separator.length < 2) return false;
  if (!isMarkdownTableSeparator(lines[index + 1])) return false;
  return true;
}

function markdownTableAlign(cell){
  const token = String(cell || '').replace(/\s+/g, '');
  if (/^:-{3,}:$/.test(token)) return 'center';
  if (/^-{3,}:$/.test(token)) return 'right';
  if (/^:-{3,}$/.test(token)) return 'left';
  return '';
}

function renderMarkdownTable(lines, startIndex){
  const headerCellsRaw = splitMarkdownTableRow(lines[startIndex]);
  const separatorCellsRaw = splitMarkdownTableRow(lines[startIndex + 1]);
  const columnCount = Math.max(headerCellsRaw.length, separatorCellsRaw.length);
  const headerCells = headerCellsRaw.slice(0, columnCount);
  while (headerCells.length < columnCount) headerCells.push('');

  const aligns = separatorCellsRaw.slice(0, columnCount).map(markdownTableAlign);
  while (aligns.length < columnCount) aligns.push('');

  const bodyRows = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const raw = String(lines[index] || '');
    const trimmed = raw.trim();
    if (!trimmed) break;
    if (!trimmed.includes('|')) break;
    const cellsRaw = splitMarkdownTableRow(trimmed);
    if (!cellsRaw.length) break;
    const cells = cellsRaw.slice(0, columnCount);
    while (cells.length < columnCount) cells.push('');
    bodyRows.push(cells);
    index += 1;
  }

  const headerHtml = headerCells.map((cell, i) => {
    const align = aligns[i];
    const alignAttr = align ? ` style="text-align:${align}"` : '';
    return `<th${alignAttr}>${renderMarkdownInline(cell)}</th>`;
  }).join('');

  const bodyHtml = bodyRows.map((row) => {
    const tds = row.map((cell, i) => {
      const align = aligns[i];
      const alignAttr = align ? ` style="text-align:${align}"` : '';
      return `<td${alignAttr}>${renderMarkdownInline(cell)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  const html = `<div class="note-markdown-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
  return { html, nextIndex: index };
}

function renderMarkdown(value){
  const lines = normalizeNewlines(value).split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const current = lines[i];
    const trimmed = current.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const fence = trimmed.match(/^```([a-zA-Z0-9_-]+)?\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      i += 1;
      const block = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        block.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${langAttr}>${escapeHtml(block.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, i)) {
      const table = renderMarkdownTable(lines, i);
      out.push(table.html);
      i = table.nextIndex;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${quoteLines.map(renderMarkdownInline).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map(item => `<li>${renderMarkdownInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map(item => `<li>${renderMarkdownInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    const paragraph = [];
    while (i < lines.length) {
      const candidate = lines[i];
      if (!candidate.trim()) break;
      if (paragraph.length && (isMarkdownBlockStart(candidate) || isMarkdownTableStart(lines, i))) break;
      paragraph.push(candidate.trim());
      i += 1;
    }
    out.push(`<p>${paragraph.map(renderMarkdownInline).join('<br>')}</p>`);
  }

  return out.join('');
}

function renderMarkdownOrFallback(value, fallback = '—'){
  const raw = normalizeNewlines(value).trim();
  if (!raw) return `<p>${escapeHtml(fallback)}</p>`;
  return renderMarkdown(raw);
}

function renderMarkdownInlineOrFallback(value, fallback = '—'){
  const raw = normalizeNewlines(value).trim();
  if (!raw) return escapeHtml(fallback);
  return renderMarkdownInline(raw);
}

function bindUserMenus(){
  const menus = Array.from(document.querySelectorAll('[data-user-menu]'));
  if (!menus.length) return;
  if (document.documentElement.dataset.userMenusBound === '1') return;
  document.documentElement.dataset.userMenusBound = '1';

  let openMenu = null;

  const getParts = (menu) => {
    if (!menu) return { toggle: null, panel: null };
    return {
      toggle: menu.querySelector('[data-user-menu-toggle]'),
      panel: menu.querySelector('[data-user-menu-panel]'),
    };
  };

  const closeMenu = (menu) => {
    const { toggle, panel } = getParts(menu);
    if (!toggle || !panel) return;
    panel.hidden = true;
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.visibility = '';
    toggle.setAttribute('aria-expanded', 'false');
    if (openMenu === menu) openMenu = null;
  };

  const positionPanel = (toggle, panel) => {
    const rect = toggle.getBoundingClientRect();
    const padding = 16;
    const width = panel.getBoundingClientRect().width || 230;
    // Align the panel to the toggle's right edge (dropdown opens from the right)
    let left = rect.right - width;
    const maxLeft = window.innerWidth - width - padding;
    if (left > maxLeft) left = Math.max(padding, maxLeft);
    if (left < padding) left = padding;
    panel.style.position = 'fixed';
    panel.style.left = `${left}px`;
    panel.style.top = `${rect.bottom + 12}px`;
    panel.style.right = 'auto';
  };

  const openMenuFor = (menu) => {
    menus.forEach((m) => { if (m !== menu) closeMenu(m); });
    const { toggle, panel } = getParts(menu);
    if (!toggle || !panel) return;
    panel.hidden = false;
    panel.style.visibility = 'hidden';
    positionPanel(toggle, panel);
    panel.style.visibility = '';
    toggle.setAttribute('aria-expanded', 'true');
    openMenu = menu;
  };

  const toggleMenu = (menu) => {
    const { panel } = getParts(menu);
    if (!panel) return;
    if (panel.hidden) openMenuFor(menu);
    else closeMenu(menu);
  };

  menus.forEach((menu) => {
    const { toggle, panel } = getParts(menu);
    if (!toggle || !panel) return;

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      toggleMenu(menu);
    });

    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        openMenuFor(menu);
        const first = menu.querySelector('.user-menu-panel a, .user-menu-panel button, .user-menu-panel [tabindex]:not([tabindex="-1"])');
        first?.focus();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(menu);
      }
    });

    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(menu);
        toggle.focus();
      }
    });

    panel.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link) {
        closeMenu(menu);
      }
    });
  });

  document.addEventListener('click', (e) => {
    if (!openMenu) return;
    if (openMenu.contains(e.target)) return;
    closeMenu(openMenu);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!openMenu) return;
    const { toggle } = getParts(openMenu);
    closeMenu(openMenu);
    toggle?.focus();
  });

  const refreshOpenMenuPosition = () => {
    if (!openMenu) return;
    const { toggle, panel } = getParts(openMenu);
    if (!toggle || !panel || panel.hidden) return;
    panel.style.visibility = 'hidden';
    positionPanel(toggle, panel);
    panel.style.visibility = '';
  };

  window.addEventListener('resize', refreshOpenMenuPosition);
  window.addEventListener('scroll', refreshOpenMenuPosition, true);
}

const CASEORG_STATE = window.CaseOrg || {};
const CASEORG_IS_ADMIN = Boolean(CASEORG_STATE.isAdmin);

// --- Data: case types (case-law classification) ------------------------
// (The old flat case-creation SUBCATS list was retired in favour of the grouped
//  FILE_SUBCATS taxonomy used for filing; case classification now needs only a
//  Case Category.)
const CASE_TYPES = {
  Criminal: [
    "498A (Cruelty/Dowry)","Murder","Rape","Sexual Harassment","Hurt",
    "138 NI Act","Fraud","Human Trafficking","NDPS","PMLA","POCSO","Constitutional","Others"
  ],
  Civil: [
    "Property","Rent Control","Inheritance/Succession","Contract",
    "Marital Divorce","Marital Maintenance","Marital Guardianship","Constitutional","Others"
  ],
  Commercial: [
    "Trademark","Copyright","Patent","Banking","Constitutional","Others"
  ],
};

/* ── File Subcategory taxonomy (Manage Cases filing) ─────────────────────────
 * Structured divisions under Civil / Criminal / Commercial.  Each group becomes a
 * header in the searchable dropdown; each item becomes a filing subfolder name.
 * Source: firm's Law_Firm_Server_Taxonomy.md (researched additions included). */
const FILE_SUBCATS = {
  Civil: [
    { group: "Original Suits & Proceedings", items: ["Suit for Recovery of Money","Suit for Specific Performance","Suit for Declaration","Suit for Permanent Injunction","Suit for Mandatory Injunction","Suit for Possession","Partition Suit","Suit for Damages / Compensation","Suit for Cancellation of Instrument","Suit for Rescission of Contract","Suit for Rendition of Accounts","Dissolution of Partnership","Redemption of Mortgage","Foreclosure","Malicious Prosecution","Defamation Suit","Summary Suit (Order XXXVII CPC)","Suit under Section 92 CPC (Public Trust)","Original Suit","Other"] },
    { group: "Trial-Stage Filings", items: ["Plaint","Written Statement (Order VIII)","Set-off / Counter-Claim (Order VIII)","Replication / Rejoinder","Framing of Issues (Order XIV)","List of Witnesses (Order XVI)","Evidence Affidavit / Examination-in-Chief (Order XVIII Rule 4)","Cross-Examination","Re-Examination","Documentary Evidence / Exhibits (Order XIII)","Written Arguments / Submissions","Final Arguments","Judgment & Decree (Order XX)","Other"] },
    { group: "Interlocutory Applications (Independent — CPC)", items: ["Rejection of Plaint (Order VII Rule 11)","Return of Plaint (Order VII Rule 10)","Setting Aside Ex Parte Decree (Order IX Rule 13)","Restoration of Suit / Setting Aside Dismissal (Order IX Rule 9)","Setting Aside Ex Parte Order (Order IX Rule 7)","Judgment on Admissions (Order XII Rule 6)","Preliminary Issue (Order XIV Rule 2)","Substitution / Legal Representatives (Order XXII)","Setting Aside Abatement (Order XXII Rule 9)","Withdrawal of Suit (Order XXIII Rule 1)","Compromise / Settlement of Suit (Order XXIII Rule 3)","Review (Order XLVII / Section 114 CPC)","Restoration of Application / Appeal","Recall / Modification of Order","Transfer of Suit (Section 24 CPC)","Stay of Suit — Res Sub Judice (Section 10 CPC)","Consolidation of Suits","Reference (Order XLVI CPC)","Other"] },
    { group: "Contempt & Caveat", items: ["Civil Contempt","Caveat (Section 148A CPC)","Curative Petition","Other"] },
    { group: "CPC Reliefs - Declaratory Reliefs", items: ["Declaration","Cancellation of Instrument","Rectification of Instrument","Rescission of Contract","Other"] },
    { group: "CPC Reliefs - Injunctions", items: ["Temporary Injunction (Order XXXIX Rules 1-2 CPC)","Permanent Injunction","Mandatory Injunction","Ex Parte Injunction","Other"] },
    { group: "CPC Reliefs - Interim Reliefs", items: ["Appointment of Receiver (Order XL CPC)","Attachment Before Judgment (Order XXXVIII Rule 5 CPC)","Security for Costs (Order XXV CPC)","Arrest Before Judgment (Order XXXVIII CPC)","Commission (Order XXVI CPC)","Local Commissioner (Order XXVI CPC)","Other"] },
    { group: "CPC Reliefs - Execution", items: ["Execution Petition","Stay of Execution","Objection (Section 47 CPC)","Arrest in Execution","Attachment in Execution","Sale in Execution","Other"] },
    { group: "CPC Reliefs - Appeals & Revisions", items: ["First Appeal (Section 96 CPC)","Second Appeal (Section 100 CPC)","Appeal from Orders (Order XLIII CPC)","Civil Revision (Section 115 CPC)","Review (Order XLVII CPC)","Other"] },
    { group: "Property", items: ["Possession Suit","Partition Suit","Declaration of Title","Boundary Dispute","Easement Rights","Specific Performance","Mesne Profits","Encroachment","Cancellation of Sale Deed","Cancellation of Gift Deed","Rectification of Deed","Mutation Dispute","Property Injunction","Adverse Possession","Co-ownership Disputes","Other"] },
    { group: "Family", items: ["Divorce","Judicial Separation","Restitution of Conjugal Rights","Annulment","Maintenance","Permanent Alimony","Child Custody","Visitation Rights","Guardianship","Adoption","Domestic Violence Proceedings","Other"] },
    { group: "Guardianship", items: ["Appointment of Guardian","Removal of Guardian","Custody Modification","Minor Property Permission","Guardianship Certificate","Other"] },
    { group: "Succession & Probate", items: ["Probate","Letters of Administration","Succession Certificate","Will Dispute","Testamentary Petition","Intestate Succession","Other"] },
    { group: "Rent Control", items: ["Eviction","Recovery of Rent","Mesne Profits","Standard Rent","Tenant Injunction","Landlord Injunction","Other"] },
    { group: "Land Acquisition", items: ["Compensation","Enhanced Compensation","Reference","Rehabilitation","Other"] },
    { group: "Arbitration", items: ["Appointment of Arbitrator","Interim Measures","Challenge to Award","Enforcement of Award","Domestic Arbitration","International Commercial Arbitration","Other"] },
    { group: "Consumer", items: ["Consumer Complaint","Appeal","Revision","Execution","Other"] },
    { group: "Summary Proceedings", items: ["Summary Suit (Order XXXVII CPC)","Summary Judgment","Recovery Suit","Other"] },
    { group: "Company / NCLT (Civil)", items: ["Oppression & Mismanagement","Reduction of Share Capital","Amalgamation","Merger","Restoration","Other"] },
    { group: "Writ Jurisdiction", items: ["Writ Petition (Article 226)","Supervisory Petition (Article 227)","Habeas Corpus","Mandamus","Certiorari","Prohibition","Quo Warranto","Other"] },
    { group: "Supreme Court Constitutional", items: ["Writ Petition (Article 32)","Original Suit (Article 131)","Transfer Petition (Civil)","Special Leave Petition (Civil)","Review Petition","Curative Petition","Other"] },
    { group: "Motor Accident Claims (MACT)", items: ["Claim Petition","Compensation Enhancement Appeal","Insurance Recovery","Other"] },
    { group: "Service & Tribunals", items: ["Service Matter (CAT/SAT)","Departmental Appeal","RERA Complaint","Electricity Petition","Election Petition","Other"] },
  ],
  Criminal: [
    { group: "Investigation", items: ["FIR","Complaint Case","Protest Petition","Closure Report Objections","Charge Sheet","Supplementary Charge Sheet","Final Report","Other"] },
    { group: "Pre-Trial & Cognizance", items: ["Application u/s 156(3) CrPC (Direction to Register FIR)","Complaint u/s 200 CrPC","Cognizance / Summoning Order","Discharge (Section 227 / 239 / 245 CrPC)","Framing of Charge (Section 228 / 240 CrPC)","Committal (Section 209 CrPC)","Other"] },
    { group: "Trial Stages (CrPC / BNSS)", items: ["Prosecution Evidence (Section 242 / 254 CrPC)","Statement of Accused (Section 313 CrPC)","Defence Evidence (Section 233 / 243 CrPC)","Final Arguments","Written Arguments / Submissions","Judgment","Order on Sentence","Other"] },
    { group: "Interlocutory / Misc Applications (Criminal)", items: ["Exemption from Personal Appearance (Section 205 / 317 CrPC)","Recall / Re-summon Witness (Section 311 CrPC)","Further Investigation (Section 173(8) CrPC)","Summoning Additional Accused (Section 319 CrPC)","Production of Documents (Section 91 CrPC)","Section 65B Certificate","Interim Custody / Superdari of Property (Section 451 / 457 CrPC)","Return of Property","Compounding of Offence (Section 320 CrPC)","Withdrawal from Prosecution (Section 321 CrPC)","Condonation of Delay","Restoration / Recall of Order","Transfer of Case (Section 407 / 408 CrPC)","Other"] },
    { group: "Bail", items: ["Anticipatory Bail","Regular Bail","Interim Bail","Default Bail","Bail Cancellation","Suspension of Sentence","Other"] },
    { group: "Trial Proceedings", items: ["Sessions Trial","Warrant Trial","Summons Trial","Complaint Trial","Plea Bargaining","Discharge Application","Framing of Charge","Other"] },
    { group: "Appeals & Revisions", items: ["Criminal Appeal","Criminal Revision","Criminal Miscellaneous Petition","Transfer Petition (Criminal)","Review","Reference","Other"] },
    { group: "Constitutional & Extraordinary Remedies", items: ["Criminal Writ (Article 226)","Habeas Corpus","Quashing Petition","Petition under Section 482 CrPC / Section 528 BNSS","SLP (Criminal)","Review Petition","Curative Petition","Other"] },
    { group: "Economic Offences", items: ["PMLA","Benami","FEMA","GST Prosecution","Income Tax Prosecution","Customs","Prevention of Corruption Act","Other"] },
    { group: "Special Criminal Acts", items: ["Negotiable Instruments Act","NDPS Act","POCSO Act","UAPA","Arms Act","Explosives Act","SC/ST Act","Juvenile Justice Act","Motor Vehicles Act","Information Technology Act","Food Safety Act","Wildlife Protection Act","Environmental Protection Act","Forest Act","Copyright Act","Trade Marks Act","Companies Act (Criminal)","Domestic Violence Act (PWDVA)","Dowry Prohibition Act","Other"] },
    { group: "Prison & Sentence", items: ["Parole","Furlough","Remission","Premature Release","Sentence Modification","Other"] },
    { group: "Maintenance & Miscellaneous", items: ["Maintenance (Section 125 CrPC / Section 144 BNSS)","Criminal Contempt","Victim Compensation","Other"] },
  ],
  Commercial: [
    { group: "Commercial Suits", items: ["Commercial Suit","Commercial Appeal","Commercial Revision","Commercial Execution","Other"] },
    { group: "Commercial Courts Act — Stages & Applications", items: ["Pre-Institution Mediation (Section 12A)","Case Management Hearing (Order XV-A)","Summary Judgment (Order XIII-A)","Disclosure / Discovery / Inspection (Order XI, Commercial)","Statement of Truth","Written Statement (Order VIII, Commercial)","Replication","Admission & Denial of Documents","Written Arguments / Submissions","Judgment & Decree","Other"] },
    { group: "Banking & Finance", items: ["Loan Recovery","Mortgage","Guarantee","SARFAESI","DRT","DRAT","Cheque Recovery","Bank Fraud","Other"] },
    { group: "Insolvency", items: ["CIRP","Liquidation","Operational Creditor","Financial Creditor","Personal Insolvency","Other"] },
    { group: "Company Law", items: ["Shareholder Disputes","Oppression & Mismanagement","Merger","Demerger","Reduction of Capital","Winding Up","Director Disputes","Other"] },
    { group: "IP - Copyright", items: ["Infringement","Ownership","Licensing","Assignment","Other"] },
    { group: "IP - Trade Marks", items: ["Infringement","Passing Off","Rectification","Opposition","Other"] },
    { group: "IP - Patents", items: ["Infringement","Revocation","Compulsory Licence","Other"] },
    { group: "IP - Designs", items: ["Infringement","Cancellation","Other"] },
    { group: "IP - Geographical Indications", items: ["Registration","Infringement","Other"] },
    { group: "IP - Trade Secrets", items: ["Confidential Information","Breach of NDA","Other"] },
    { group: "Competition Law", items: ["Anti-competitive Agreements","Abuse of Dominance","Combination Approval","CCI Appeal","Other"] },
    { group: "Securities", items: ["SEBI Proceedings","Insider Trading","Takeover","Listing Compliance","Other"] },
    { group: "Direct Tax — ITAT", items: ["Income Tax Appeal (ITAT)","Appeal before CIT (Appeals)","Tax Reference / Appeal (High Court)","Stay / Rectification Application","Transfer Pricing","Other"] },
    { group: "Indirect Tax — CESTAT / GST", items: ["Customs / Excise / Service Tax Appeal (CESTAT)","GST Appeal (Appellate Authority / GSTAT)","Advance Ruling","VAT / Sales Tax Appeal","Other"] },
    { group: "Arbitration", items: ["Domestic Arbitration","International Commercial Arbitration","Section 9","Section 11","Section 34","Section 36","Enforcement of Foreign Award","Other"] },
    { group: "Technology & Digital Commerce", items: ["IT Act","Data Protection","Software Licensing","SaaS Agreements","E-Commerce","Cyber Contracts","Domain Name Disputes","Other"] },
    { group: "High Court (Commercial)", items: ["Writ Petition (Article 226)","Supervisory Petition (Article 227)","Other"] },
    { group: "Supreme Court (Commercial)", items: ["Writ Petition (Article 32)","Special Leave Petition","Review Petition","Curative Petition","Transfer Petition (Civil)","Other"] },
    { group: "Regulatory Tribunals", items: ["NCLAT Appeal","TDSAT (Telecom)","APTEL (Electricity)","MSME Facilitation","RERA (Commercial)","Other"] },
  ],
};

/* ── v4.8 taxonomy: role-aware primary + miscellaneous proceedings ───────────
 * FILE_SUBCATS above is the Petitioner/moving-party PRIMARY set.  Interim /
 * interlocutory / miscellaneous items are stripped from it (MISC_STRIP) and
 * offered instead in the Misc Proceedings tab (MISC_SUBCATS).  Representing the
 * Respondent swaps in the responsive pleadings (RESP_SUBCATS).  All lists are
 * starting points — edit freely.  The 9 standard sub-folders live in
 * STANDARD_SUBDIRS (kept in sync with app.py). */
const STANDARD_SUBDIRS = [
  "Primary Documents","Case Law","Research","Annexures","Drafts",
  "Notes","Court Copies","Pleadings","Judgments & Orders",
];

// Items removed from the Petitioner PRIMARY set (they move to Misc).
const MISC_STRIP = new Set([
  "Miscellaneous Civil Application","Civil Miscellaneous Petition","Interlocutory Application (IA)",
  "Restoration Application","Amendment Application","Recall Application",
  "Criminal Miscellaneous Petition","Interim Bail","Criminal Contempt",
  "Interim Relief","Interim Measures",
]);

// Whole Civil groups that are entirely interim/interlocutory reliefs → Misc.
const MISC_STRIP_GROUPS = new Set([
  "CPC Reliefs - Injunctions", "CPC Reliefs - Interim Reliefs",
]);

// Branch → GROUPED misc-application taxonomy (ancillary interim applications
// filed WITHIN a chosen subcategory). Grouped like FILE_SUBCATS so the Misc
// dropdown is searchable. Independent, suit-disposing applications (Order VII
// Rule 11, Order IX Rule 13, review, restoration, withdrawal …) are NOT here —
// they are first-class subcategories in FILE_SUBCATS. Written Submissions and
// Written Arguments are one item ("Written Submissions / Arguments").
const MISC_SUBCATS = {
  Civil: [
    { group: "Interim Reliefs (CPC)", items: ["Temporary Injunction (Order XXXIX Rules 1-2)","Ad-Interim / Ex-Parte Injunction","Mandatory Injunction","Stay Application","Appointment of Receiver (Order XL)","Attachment Before Judgment (Order XXXVIII Rule 5)","Arrest Before Judgment (Order XXXVIII Rule 1)","Security for Costs (Order XXV)","Interim Maintenance","Other"] },
    { group: "Applications in the Suit (CPC)", items: ["Amendment of Pleadings (Order VI Rule 17)","Striking Out Pleadings (Order VI Rule 16)","Impleadment / Addition of Parties (Order I Rule 10)","Deletion of Parties (Order I Rule 10)","Additional Documents (Order VII Rule 14 / Order VIII Rule 1A)","Discovery / Interrogatories (Order XI)","Inspection / Production of Documents (Order XI)","Admission & Denial of Documents (Order XII)","Commission / Local Commissioner (Order XXVI)","Recall of Witness (Order XVIII Rule 17)","Reopening of Evidence","Other"] },
    { group: "Procedural Applications", items: ["Condonation of Delay (Section 5, Limitation Act)","Extension of Time (Section 148 CPC)","Deficit Court Fee (Section 149 CPC)","Inherent Powers (Section 151 CPC)","Exemption from Personal Appearance","Early Hearing / Preponement","Short Date / Urgent Listing","Adjournment","Other"] },
    { group: "Common", items: ["Interlocutory Application (IA)","Written Submissions / Arguments","Miscellaneous Application","Other"] },
  ],
  Criminal: [
    { group: "Bail & Custody", items: ["Regular Bail","Anticipatory Bail","Interim Bail","Default / Statutory Bail (Section 167(2) CrPC)","Cancellation of Bail","Modification of Bail Conditions","Interim Custody / Superdari (Section 451 / 457 CrPC)","Other"] },
    { group: "Trial Applications", items: ["Discharge (Section 227 / 239 / 245 CrPC)","Exemption from Personal Appearance (Section 205 / 317 CrPC)","Recall / Re-summon Witness (Section 311 CrPC)","Further Investigation (Section 173(8) CrPC)","Summoning Additional Accused (Section 319 CrPC)","Production of Documents (Section 91 CrPC)","Section 65B Certificate","Defence Evidence (Section 243 CrPC)","Other"] },
    { group: "Post-Conviction / Sentence", items: ["Suspension of Sentence (Section 389 CrPC)","Probation (Section 360 CrPC)","Compounding of Offence (Section 320 CrPC)","Plea Bargaining (Chapter XXI-A)","Other"] },
    { group: "Procedural Applications", items: ["Condonation of Delay","Stay of Proceedings","Transfer of Case (Section 407 / 408 CrPC)","Restoration / Recall of Order","Exemption / Adjournment","Other"] },
    { group: "Common", items: ["Criminal Miscellaneous Application","Written Submissions / Arguments","Miscellaneous Application","Other"] },
  ],
  Commercial: [
    { group: "Interim Reliefs", items: ["Interim Injunction (Order XXXIX / Section 9 Arbitration)","Stay Application","Appointment of Receiver (Order XL)","Attachment Before Judgment (Order XXXVIII Rule 5)","Section 9 Interim Measures (Arbitration)","Section 17 Interim Measures (Arbitral Tribunal)","Other"] },
    { group: "Case Management (Commercial Courts Act)", items: ["Case Management Hearing (Order XV-A)","Summary Judgment (Order XIII-A)","Disclosure / Discovery (Order XI, Commercial)","Pre-Institution Mediation (Section 12A)","Other"] },
    { group: "Applications in the Suit", items: ["Amendment of Pleadings (Order VI Rule 17)","Impleadment (Order I Rule 10)","Condonation of Delay","Local Commissioner (Order XXVI)","Inspection / Production of Documents","Restoration / Recall","Other"] },
    { group: "Common", items: ["Commercial Miscellaneous Application","Written Submissions / Arguments","Miscellaneous Application","Other"] },
  ],
};

// Respondent-side PRIMARY (responsive pleadings), grouped like FILE_SUBCATS.
const RESP_SUBCATS = {
  Civil: [
    { group: "Responsive Pleadings", items: ["Written Statement","Additional Written Statement","Counter-Claim","Set-off","Counter Affidavit","Reply / Response","Reply to Application","Objections","Caveat","Cross-Objections (in Appeal)","Reply to Appeal","Reply to Writ / SLP","Other"] },
  ],
  Criminal: [
    { group: "Responsive Pleadings", items: ["Reply / Counter to Bail","Discharge Application","Reply to Quashing (Status Report / Counter)","Objections","Reply to Revision / Appeal","Reply to Petition u/s 482 CrPC / 528 BNSS","Reply to Application","Surety / Bond","Other"] },
  ],
  Commercial: [
    { group: "Responsive Pleadings", items: ["Written Statement","Statement of Defence (Arbitration)","Counter-Claim","Counter Affidavit","Reply to Section 9 / interim","Reply / Response","Objections","Cross-Objections","Other"] },
  ],
};

// Groups that are the moving party's own initiating pleadings — these are the
// only ones swapped out for the respondent (who files responsive pleadings
// instead). Everything else — interlocutory applications (incl. Order VII
// Rule 11, which the DEFENDANT files), trial stages, execution, appeals — is
// common to both sides.
const PETITIONER_ONLY_GROUPS = new Set([
  "Original Suits & Proceedings", "Commercial Suits",
]);

// Petitioner PRIMARY = FILE_SUBCATS minus the misc items/groups.
function primarySubcats(branch, role) {
  const groups = FILE_SUBCATS[branch] || [];
  const base = groups
    .filter((g) => !MISC_STRIP_GROUPS.has(g.group))
    .map((g) => ({ group: g.group, items: g.items.filter((it) => !MISC_STRIP.has(it)) }))
    .filter((g) => g.items.length);
  if (role !== 'Respondent') return base;
  // Respondent: responsive pleadings first, then every common group (drop only
  // the moving party's initiating-pleading groups).
  const resp = RESP_SUBCATS[branch] || [];
  const common = base.filter((g) => !PETITIONER_ONLY_GROUPS.has(g.group));
  return [...resp, ...common];
}

/* ── Court / Forum constants ──────────────────────────────────────────────── */
const COURT_TYPES = ["Supreme Court", "Federal Court", "Privy Council", "High Court"];

const TOP_COURTS = {
  "Supreme Court": { name: "Supreme Court of India", abbrev: "SC" },
  "Federal Court": { name: "Federal Court of India", abbrev: "FC" },
  "Privy Council": { name: "Judicial Committee of the Privy Council", abbrev: "PC" },
};

const HIGH_COURTS = [
  // Current
  { name: "Allahabad High Court", abbrev: "All", historical: false },
  { name: "Andhra Pradesh High Court", abbrev: "AP", historical: false },
  { name: "Bombay High Court", abbrev: "Bom", historical: false },
  { name: "Calcutta High Court", abbrev: "Cal", historical: false },
  { name: "Chhattisgarh High Court", abbrev: "CG", historical: false },
  { name: "Delhi High Court", abbrev: "Del", historical: false },
  { name: "Gauhati High Court", abbrev: "Gau", historical: false },
  { name: "Gujarat High Court", abbrev: "Guj", historical: false },
  { name: "Himachal Pradesh High Court", abbrev: "HP", historical: false },
  { name: "Jammu and Kashmir and Ladakh High Court", abbrev: "J&K", historical: false },
  { name: "Jharkhand High Court", abbrev: "Jhar", historical: false },
  { name: "Karnataka High Court", abbrev: "Kar", historical: false },
  { name: "Kerala High Court", abbrev: "Ker", historical: false },
  { name: "Madhya Pradesh High Court", abbrev: "MP", historical: false },
  { name: "Madras High Court", abbrev: "Mad", historical: false },
  { name: "Manipur High Court", abbrev: "Mani", historical: false },
  { name: "Meghalaya High Court", abbrev: "Meg", historical: false },
  { name: "Orissa High Court", abbrev: "Ori", historical: false },
  { name: "Patna High Court", abbrev: "Pat", historical: false },
  { name: "Punjab and Haryana High Court", abbrev: "P&H", historical: false },
  { name: "Rajasthan High Court", abbrev: "Raj", historical: false },
  { name: "Sikkim High Court", abbrev: "Sik", historical: false },
  { name: "Telangana High Court", abbrev: "Tel", historical: false },
  { name: "Tripura High Court", abbrev: "Tri", historical: false },
  { name: "Uttarakhand High Court", abbrev: "Utt", historical: false },
  // Historical / Defunct
  { name: "Hyderabad High Court", abbrev: "Hyd", historical: true },
  { name: "Mysore High Court", abbrev: "Mys", historical: true },
  { name: "Travancore-Cochin High Court", abbrev: "TC", historical: true },
  { name: "PEPSU High Court", abbrev: "PEPSU", historical: true },
  { name: "Nagpur High Court", abbrev: "Nag", historical: true },
];

// Supreme Court — shown at the very top of the unified court dropdown.
const SUPREME_COURT = { name: "Supreme Court of India", abbrev: "SC" };

// Lookup: court name → abbreviation
const _COURT_ABBREV_MAP = {};
for (const [key, val] of Object.entries(TOP_COURTS)) _COURT_ABBREV_MAP[val.name] = val.abbrev;
for (const hc of HIGH_COURTS) _COURT_ABBREV_MAP[hc.name] = hc.abbrev;

/* ── Citation / Journal constants ─────────────────────────────────────────── */
const CITATION_JOURNALS = ["INSC", "SCC", "SCC Online", "SCR", "AIR"];

const JOURNAL_CONFIG = {
  "INSC":       { hasVolume: false, hasCourtAbbrev: false, fmt: "({year}) INSC {page}" },
  "SCC":        { hasVolume: true,  hasCourtAbbrev: false, fmt: "({year}) {volume} SCC {page}" },
  "SCC Online": { hasVolume: false, hasCourtAbbrev: true,  fmt: "{year} SCC OnLine {court_abbrev} {page}" },
  "SCR":        { hasVolume: true,  hasCourtAbbrev: false, fmt: "({year}) {volume} SCR {page}" },
  "AIR":        { hasVolume: false, hasCourtAbbrev: true,  fmt: "AIR {year} {court_abbrev} {page}" },
};

/**
 * Get the court abbreviation currently selected on a form.
 * Looks for either #clu-court-name (upload) or #note-cl-court-name (edit).
 */
function _getCurrentCourtAbbrev() {
  for (const id of ['clu-court-name', 'note-cl-court-name']) {
    const el = document.getElementById(id);
    if (el && el.dataset.abbrev) return el.dataset.abbrev;
  }
  return '';
}

/**
 * Build a searchable dropdown for court selection.
 * opts.includeSupremeCourt → prepend a "Supreme Court" group above the High Courts.
 * opts.allowFreeText       → capture typed text (e.g. a trial/lower court) on blur
 *                            when no listed option was picked.
 * Returns { wrapper, input, hiddenInput, setVal(name) }
 */
function buildSearchableDropdown(inputId, hiddenId, placeholder, opts = {}) {
  const includeSC = !!opts.includeSupremeCourt;
  const allowFreeText = !!opts.allowFreeText;
  const wrapper = document.createElement('div');
  wrapper.className = 'search-dropdown';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'search-dropdown-input';
  inp.id = inputId;
  inp.placeholder = placeholder || 'Search…';
  inp.autocomplete = 'off';

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.id = hiddenId;

  const panel = document.createElement('div');
  panel.className = 'search-dropdown-panel';

  wrapper.appendChild(inp);
  wrapper.appendChild(hidden);
  wrapper.appendChild(panel);

  let activeIdx = -1;

  function render(filter) {
    panel.innerHTML = '';
    const q = (filter || '').toLowerCase();
    const current = HIGH_COURTS.filter(hc => !hc.historical);
    const historical = HIGH_COURTS.filter(hc => hc.historical);

    let allFiltered = [];
    let needDivider = false;

    const addOption = (name, abbrev, custom) => {
      const opt = document.createElement('div');
      opt.className = 'sd-option' + (custom ? ' sd-option-custom' : '');
      opt.textContent = name;
      opt.dataset.value = name;
      opt.dataset.abbrev = abbrev || '';
      opt.addEventListener('mousedown', (e) => { e.preventDefault(); selectOption(name, abbrev || ''); });
      panel.appendChild(opt);
      allFiltered.push(opt);
    };

    // Render a labelled group only when it has matches, with a divider *between*
    // non-empty sections — never a leading/trailing/empty divider.
    const addGroup = (label, items) => {
      const filtered = items.filter(hc => hc.name.toLowerCase().includes(q));
      if (!filtered.length) return;
      if (needDivider) {
        const div = document.createElement('div');
        div.className = 'sd-divider';
        panel.appendChild(div);
      }
      const lbl = document.createElement('div');
      lbl.className = 'sd-group-label';
      lbl.textContent = label;
      panel.appendChild(lbl);
      filtered.forEach(hc => addOption(hc.name, hc.abbrev, false));
      needDivider = true;
    };

    // Free-text: reflect exactly what the user typed as a pickable option whenever
    // it isn't already a listed court (combobox behaviour — captures lower/trial
    // courts that aren't catalogued).
    const typed = (filter || '').trim();
    const catalog = (includeSC ? [SUPREME_COURT] : []).concat(HIGH_COURTS);
    const exact = catalog.some(c => c.name.toLowerCase() === q);
    if (allowFreeText && typed && !exact) {
      addOption(typed, '', true);
      needDivider = true;
    }

    if (includeSC) addGroup('Supreme Court', [SUPREME_COURT]);
    addGroup(includeSC ? 'High Courts' : 'Current', current);
    addGroup('Historical', historical);

    activeIdx = -1;
    return allFiltered;
  }

  function selectOption(name, abbrev) {
    inp.value = name;
    hidden.value = name;
    hidden.dataset.abbrev = abbrev;
    inp.dataset.abbrev = abbrev;
    panel.classList.remove('open');
  }

  function setVal(name) {
    if (includeSC && name === SUPREME_COURT.name) { selectOption(SUPREME_COURT.name, SUPREME_COURT.abbrev); return; }
    const hc = HIGH_COURTS.find(h => h.name === name);
    if (hc) selectOption(hc.name, hc.abbrev);
    else { inp.value = name || ''; hidden.value = name || ''; inp.dataset.abbrev = ''; hidden.dataset.abbrev = ''; }
  }

  inp.addEventListener('focus', () => {
    render(inp.value);
    panel.classList.add('open');
  });

  inp.addEventListener('input', () => {
    render(inp.value);
    panel.classList.add('open');
  });

  inp.addEventListener('blur', () => {
    // Free-text fallback: keep whatever was typed (lower/trial courts not in the
    // list) so the value is captured even when no listed option was picked.
    if (allowFreeText && inp.value !== hidden.value) {
      hidden.value = inp.value;
      inp.dataset.abbrev = '';
      hidden.dataset.abbrev = '';
    }
    setTimeout(() => panel.classList.remove('open'), 150);
  });

  inp.addEventListener('keydown', (e) => {
    const opts = panel.querySelectorAll('.sd-option');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, opts.length - 1);
      opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
      if (opts[activeIdx]) opts[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
      if (opts[activeIdx]) opts[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && opts[activeIdx]) {
        const opt = opts[activeIdx];
        selectOption(opt.dataset.value, opt.dataset.abbrev);
      }
    } else if (e.key === 'Escape') {
      panel.classList.remove('open');
      inp.blur();
    }
  });

  return { wrapper, input: inp, hiddenInput: hidden, setVal };
}

/**
 * Grouped, searchable dropdown for the File Subcategory taxonomy.
 * `groups` = [{ group: "Header", items: ["A","B",...] }, ...]. Reuses the
 * .search-dropdown* CSS (group labels + dividers). Returns
 * { wrapper, getValue, setValue, reset }.
 */
function buildGroupedSearchableDropdown(container, hiddenId, placeholder, groups) {
  const wrapper = document.createElement('div');
  wrapper.className = 'search-dropdown';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'search-dropdown-input';
  inp.placeholder = placeholder || 'Search…';
  inp.autocomplete = 'off';

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.id = hiddenId;

  const panel = document.createElement('div');
  panel.className = 'search-dropdown-panel';

  wrapper.append(inp, hidden, panel);
  let activeIdx = -1;
  let _sdScrollClose = null;

  /**
   * Position the open panel the same way the Long-List Dropdown does: portalled
   * to <body> with fixed coords (so no ancestor's overflow or transform can clip
   * it), dropping DOWN when there is room and flipping UP when there is not,
   * with the height capped to the space actually available so a long grouped
   * list can never leak off-screen.
   */
  function positionPanel() {
    // Hosts get rebuilt when the category above them changes; never leave a
    // portalled panel floating in <body> after its input is gone.
    if (!inp.isConnected) { panel.remove(); return; }
    if (panel.parentNode !== document.body) document.body.appendChild(panel);
    const rect = inp.getBoundingClientRect();
    panel.classList.remove('flip-up');
    panel.style.position = 'fixed';
    panel.style.left = rect.left + 'px';
    panel.style.width = rect.width + 'px';
    panel.style.right = 'auto';
    panel.style.marginTop = '0';
    panel.style.zIndex = '100001';

    const GAP = 4;
    const EDGE = 8;                       // keep clear of the viewport edge
    const CAP = 240;                      // the panel's design max-height
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;

    // Decide on the height the panel actually WANTS to be — its content height
    // clamped to the design cap. Comparing the raw content height would flip a
    // long grouped list upwards even when the capped, scrollable panel fits
    // below perfectly well.
    panel.style.maxHeight = 'none';
    const desired = Math.min(panel.scrollHeight, CAP);

    const dropUp = desired > spaceBelow && (desired <= spaceAbove || spaceAbove > spaceBelow);
    if (dropUp) {
      panel.classList.add('flip-up');
      panel.style.top = 'auto';
      panel.style.bottom = (window.innerHeight - rect.top + GAP) + 'px';
      panel.style.maxHeight = Math.max(120, Math.min(desired, spaceAbove)) + 'px';
    } else {
      panel.style.top = (rect.bottom + GAP) + 'px';
      panel.style.bottom = 'auto';
      panel.style.maxHeight = Math.max(120, Math.min(desired, spaceBelow)) + 'px';
    }
  }

  function openPanel(filter) {
    render(filter);
    panel.classList.add('open');
    positionPanel();
    if (!_sdScrollClose) {
      // Close on scrolling the page behind the fixed panel, but not on
      // scrolling within the panel itself.
      _sdScrollClose = (evt) => {
        if (!inp.isConnected) { closePanel(); return; }
        if (evt.target === panel || panel.contains(evt.target)) return;
        closePanel();
      };
      window.addEventListener('scroll', _sdScrollClose, { capture: true, passive: true });
      window.addEventListener('resize', _sdScrollClose, { passive: true });
    }
  }

  function closePanel() {
    panel.classList.remove('open', 'flip-up');
    ['position', 'left', 'right', 'top', 'bottom', 'width', 'maxHeight', 'marginTop', 'zIndex']
      .forEach((prop) => { panel.style[prop] = ''; });
    if (panel.parentNode === document.body) wrapper.appendChild(panel);
    if (_sdScrollClose) {
      window.removeEventListener('scroll', _sdScrollClose, { capture: true });
      window.removeEventListener('resize', _sdScrollClose);
      _sdScrollClose = null;
    }
  }

  function pick(val) {
    inp.value = val;
    hidden.value = val;
    closePanel();
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function render(filter) {
    panel.innerHTML = '';
    const q = (filter || '').toLowerCase();
    let first = true;
    (groups || []).forEach(g => {
      const groupHit = g.group.toLowerCase().includes(q);
      const matches = (g.items || []).filter(it => groupHit || it.toLowerCase().includes(q));
      if (!matches.length) return;
      if (!first) { const d = document.createElement('div'); d.className = 'sd-divider'; panel.appendChild(d); }
      first = false;
      const lbl = document.createElement('div');
      lbl.className = 'sd-group-label';
      lbl.textContent = g.group;
      panel.appendChild(lbl);
      matches.forEach(it => {
        const opt = document.createElement('div');
        opt.className = 'sd-option';
        opt.textContent = it;
        opt.dataset.value = it;
        opt.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
        panel.appendChild(opt);
      });
    });
    activeIdx = -1;
  }

  inp.addEventListener('focus', () => openPanel(inp.value));
  // Re-position on every keystroke: filtering changes the list's height, which
  // changes whether it still fits below.
  inp.addEventListener('input', () => openPanel(inp.value));
  inp.addEventListener('blur', () => {
    // Revert any typed-but-unselected text — subcategory must be a listed value.
    setTimeout(() => { closePanel(); inp.value = hidden.value; }, 150);
  });
  inp.addEventListener('keydown', (e) => {
    const opts = panel.querySelectorAll('.sd-option');
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, opts.length - 1); opts.forEach((o,i)=>o.classList.toggle('active', i===activeIdx)); opts[activeIdx]?.scrollIntoView({block:'nearest'}); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); opts.forEach((o,i)=>o.classList.toggle('active', i===activeIdx)); opts[activeIdx]?.scrollIntoView({block:'nearest'}); }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0 && opts[activeIdx]) pick(opts[activeIdx].dataset.value); }
    else if (e.key === 'Escape') { closePanel(); inp.blur(); }
  });

  container.appendChild(wrapper);
  return {
    wrapper,
    getValue: () => hidden.value,
    setValue: (v) => pick(String(v || '')),
    reset: () => { inp.value = ''; hidden.value = ''; },
  };
}

/**
 * Long-list dropdown — native-select-like behaviour, limited to ~10 visible items.
 * Uses a <div> trigger so there is no text cursor.
 */
function buildLongListDropdown(container, hiddenId, placeholder, options) {
  const wrapper = document.createElement('div');
  wrapper.className = 'll-dropdown';

  const trigger = document.createElement('div');
  trigger.className = 'll-dropdown-trigger placeholder';
  trigger.setAttribute('tabindex', '0');
  trigger.textContent = placeholder;

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.id = hiddenId;

  const panel = document.createElement('div');
  panel.className = 'll-dropdown-panel';

  let selectedValue = '';
  let activeIdx = -1;
  const callbacks = [];

  function buildOptions() {
    panel.innerHTML = '';
    options.forEach((val) => {
      const opt = document.createElement('div');
      opt.className = 'll-option' + (String(val) === selectedValue ? ' selected' : '');
      opt.textContent = val;
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(String(val));
      });
      panel.appendChild(opt);
    });
    activeIdx = -1;
  }

  function open() {
    buildOptions();
    // Show panel first to measure actual height
    panel.classList.remove('flip-up');
    panel.classList.add('open');
    const rect = trigger.getBoundingClientRect();
    const panelH = panel.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < panelH && rect.top > spaceBelow) {
      panel.classList.add('flip-up');
    }
    const sel = panel.querySelector('.ll-option.selected');
    if (sel) sel.scrollIntoView({ block: 'center' });
  }

  function close() { panel.classList.remove('open', 'flip-up'); activeIdx = -1; }
  function isOpen() { return panel.classList.contains('open'); }

  function pick(val) {
    selectedValue = val;
    hidden.value = val;
    trigger.textContent = val || placeholder;
    trigger.classList.toggle('placeholder', !val);
    close();
    callbacks.forEach(cb => cb(val));
  }

  trigger.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (isOpen()) { close(); } else { open(); trigger.focus(); }
  });
  trigger.addEventListener('blur', close);
  trigger.addEventListener('keydown', (e) => {
    if (!isOpen() && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); open(); return;
    }
    const opts = panel.querySelectorAll('.ll-option');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, opts.length - 1);
      opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
      opts[activeIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
      opts[activeIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (activeIdx >= 0 && opts[activeIdx]) pick(opts[activeIdx].textContent);
    } else if (e.key === 'Escape') { close(); trigger.blur(); }
  });

  wrapper.append(trigger, hidden, panel);
  container.appendChild(wrapper);

  return {
    getValue() { return selectedValue; },
    setValue(val) { pick(String(val || '')); },
    onChange(cb) { callbacks.push(cb); },
    reset() { pick(''); },
  };
}

/**
 * Convert a native <select> into a Long-List Dropdown (visual wrapper).
 * The original <select> is hidden but remains the source of truth.
 * All existing JS code (.value, .selectedIndex, .disabled, populateOptions,
 * addEventListener('change')) keeps working unchanged.
 */
function convertSelectToLLD(sel) {
  if (!sel || sel._lldConverted) return;
  sel._lldConverted = true;

  // Wrap in .ll-dropdown
  const wrapper = document.createElement('div');
  wrapper.className = 'll-dropdown';
  sel.parentNode.insertBefore(wrapper, sel);
  wrapper.appendChild(sel);
  sel.style.display = 'none';

  // Trigger element (no text cursor — it's a div)
  const trigger = document.createElement('div');
  trigger.className = 'll-dropdown-trigger placeholder';
  trigger.setAttribute('tabindex', '0');
  wrapper.insertBefore(trigger, sel);

  // Panel
  const panel = document.createElement('div');
  panel.className = 'll-dropdown-panel';
  wrapper.appendChild(panel);

  let activeIdx = -1;
  let _scrollCloseFn = null;

  function syncTriggerText() {
    const opt = sel.options[sel.selectedIndex];
    const val = sel.value;
    const text = opt ? opt.textContent : '';
    trigger.textContent = val ? text : (sel.options[0]?.textContent || '');
    trigger.classList.toggle('placeholder', !val);
  }

  function syncDisabled() {
    const dis = sel.disabled;
    trigger.classList.toggle('disabled', dis);
    if (dis) { trigger.removeAttribute('tabindex'); close(); }
    else { trigger.setAttribute('tabindex', '0'); }
  }

  function buildOptions() {
    panel.innerHTML = '';
    Array.from(sel.options).forEach((opt, i) => {
      const div = document.createElement('div');
      div.className = 'll-option' + (i === sel.selectedIndex ? ' selected' : '');
      div.textContent = opt.textContent;
      div.dataset.index = i;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickIndex(i);
      });
      panel.appendChild(div);
    });
    activeIdx = -1;
  }

  function open() {
    if (sel.disabled) return;
    buildOptions();
    panel.classList.remove('flip-up');

    // Portal the panel to <body> before positioning. A modal ancestor with a
    // CSS transform becomes the containing block for position:fixed, which threw
    // the panel to the wrong place ("different universe"). As a direct child of
    // <body> the fixed coords are relative to the viewport, as intended.
    if (panel.parentNode !== document.body) document.body.appendChild(panel);

    // Use fixed positioning to escape all ancestor overflow clipping
    const rect = trigger.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.left = rect.left + 'px';
    panel.style.width = rect.width + 'px';
    panel.style.right = 'auto';
    panel.style.zIndex = '100001';   // above modals (z-index up to 10000)

    panel.classList.add('open');

    const panelH = panel.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - 2;

    if (spaceBelow < panelH && rect.top > spaceBelow) {
      panel.style.top = 'auto';
      panel.style.bottom = (window.innerHeight - rect.top + 2) + 'px';
      panel.classList.add('flip-up');
    } else {
      panel.style.top = (rect.bottom + 2) + 'px';
      panel.style.bottom = 'auto';
    }

    const cur = panel.querySelector('.ll-option.selected');
    if (cur) panel.scrollTop = cur.offsetTop - (panel.offsetHeight - cur.offsetHeight) / 2;

    // FIX (v4.2.1): Dropdown scroll — the previous handler closed the panel on
    // ANY scroll event, including scrolling *within* the dropdown panel itself.
    // Now we check whether the scroll originated inside the panel and only close
    // on external scrolls (e.g. the page body scrolling behind the fixed panel).
    _scrollCloseFn = (evt) => {
      if (evt.target === panel || panel.contains(evt.target)) return;
      close(); trigger.blur();
    };
    window.addEventListener('scroll', _scrollCloseFn, { capture: true, passive: true });
  }

  function close() {
    panel.classList.remove('open', 'flip-up');
    panel.style.position = '';
    panel.style.left = '';
    panel.style.width = '';
    panel.style.right = '';
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.zIndex = '';
    // Return the panel to its wrapper so its state stays with the control.
    if (panel.parentNode === document.body) wrapper.appendChild(panel);
    if (_scrollCloseFn) {
      window.removeEventListener('scroll', _scrollCloseFn, { capture: true });
      _scrollCloseFn = null;
    }
    activeIdx = -1;
  }
  function isOpen() { return panel.classList.contains('open'); }

  function pickIndex(i) {
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    syncTriggerText();
    close();
  }

  trigger.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (sel.disabled) return;
    if (isOpen()) { close(); } else { open(); trigger.focus(); }
  });

  trigger.addEventListener('blur', close);

  trigger.addEventListener('keydown', (e) => {
    if (sel.disabled) return;
    if (!isOpen() && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); open(); return;
    }
    const opts = panel.querySelectorAll('.ll-option');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, opts.length - 1);
      opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
      opts[activeIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
      opts[activeIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (activeIdx >= 0 && opts[activeIdx]) pickIndex(Number(opts[activeIdx].dataset.index));
    } else if (e.key === 'Escape') { close(); trigger.blur(); }
  });

  // Watch for programmatic changes to <select> (e.g. populateOptions, innerHTML, .value, .disabled)
  const observer = new MutationObserver(() => { syncTriggerText(); syncDisabled(); });
  observer.observe(sel, { childList: true, attributes: true, attributeFilter: ['disabled'] });

  // Override .value setter so programmatic sel.value = 'x' updates the trigger
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', {
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); syncTriggerText(); },
    configurable: true,
  });

  // Override .selectedIndex setter
  const siDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  Object.defineProperty(sel, 'selectedIndex', {
    get() { return siDesc.get.call(this); },
    set(v) { siDesc.set.call(this, v); syncTriggerText(); },
    configurable: true,
  });

  // Override .disabled setter
  const disDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'disabled');
  Object.defineProperty(sel, 'disabled', {
    get() { return disDesc.get.call(this); },
    set(v) { disDesc.set.call(this, v); syncDisabled(); },
    configurable: true,
  });

  // Override .innerHTML setter to re-sync after populateOptions rewrites options
  const ihDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(sel, 'innerHTML', {
    get() { return ihDesc.get.call(this); },
    set(v) { ihDesc.set.call(this, v); syncTriggerText(); syncDisabled(); },
    configurable: true,
  });

  // Initial sync
  syncTriggerText();
  syncDisabled();
}

/**
 * Convert all <select> elements within a container to Long-List Dropdowns.
 */
function convertAllSelectsToLLD(container) {
  if (!container) return;
  container.querySelectorAll('select').forEach(convertSelectToLLD);
}

/** Integer-only filter: block everything except digits and navigation keys */
function integerOnly(inp) {
  inp.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (['Backspace','Delete','Tab','ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    if (!/^\d$/.test(e.key)) e.preventDefault();
  });
  inp.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!/^\d+$/.test(text)) e.preventDefault();
  });
  inp.addEventListener('input', () => {
    inp.value = inp.value.replace(/\D/g, '');
  });
}

/**
 * Create a single citation row. `container` is the .citations-list element.
 * `courtAbbrevGetter` returns the auto-populated court abbreviation.
 */
function createCitationRow(container, data, courtAbbrevGetter) {
  const row = document.createElement('div');
  row.className = 'citation-row';

  // Journal
  const journalSel = document.createElement('select');
  journalSel.className = 'cite-journal';
  journalSel.innerHTML = '<option value="">Journal</option>' +
    CITATION_JOURNALS.map(j => `<option value="${j}">${j}</option>`).join('');

  // Year
  const yearInp = document.createElement('input');
  yearInp.type = 'text';
  yearInp.inputMode = 'numeric';
  yearInp.className = 'cite-year';
  yearInp.placeholder = 'Year';
  yearInp.maxLength = 4;
  integerOnly(yearInp);

  // Volume
  const volInp = document.createElement('input');
  volInp.type = 'text';
  volInp.inputMode = 'numeric';
  volInp.className = 'cite-volume';
  volInp.placeholder = 'Vol.';
  integerOnly(volInp);

  // Court abbreviation
  const courtInp = document.createElement('input');
  courtInp.type = 'text';
  courtInp.className = 'cite-court-abbrev';
  courtInp.placeholder = 'Court';

  // Page / entry
  const pageInp = document.createElement('input');
  pageInp.type = 'text';
  pageInp.inputMode = 'numeric';
  pageInp.className = 'cite-page';
  pageInp.placeholder = 'Page/Entry';
  integerOnly(pageInp);

  // Remove button
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'cite-remove';
  removeBtn.title = 'Remove citation';
  removeBtn.innerHTML = '&#x2715;';

  row.append(journalSel, yearInp, volInp, courtInp, pageInp, removeBtn);
  container.appendChild(row);

  function applyJournalConfig() {
    const j = journalSel.value;
    const cfg = JOURNAL_CONFIG[j] || {};
    if (cfg.hasVolume) {
      volInp.style.display = '';
      volInp.disabled = false;
      volInp.value = volInp.value === '.' ? '' : volInp.value;
    } else {
      volInp.value = '.';
      volInp.disabled = true;
      volInp.style.display = '';
    }
    if (cfg.hasCourtAbbrev) {
      courtInp.style.display = '';
      courtInp.disabled = false;
      if (!courtInp.value && courtAbbrevGetter) courtInp.value = courtAbbrevGetter();
    } else {
      courtInp.value = '';
      courtInp.disabled = true;
      courtInp.style.display = 'none';
    }
  }

  journalSel.addEventListener('change', applyJournalConfig);
  removeBtn.addEventListener('click', () => row.remove());

  // Convert journal select to Long-List Dropdown
  convertSelectToLLD(journalSel);

  // Populate if data provided
  if (data) {
    if (data.journal) { journalSel.value = data.journal; }
    if (data.year) yearInp.value = data.year;
    if (data.volume && data.volume !== '.') volInp.value = data.volume;
    if (data.court_abbrev) courtInp.value = data.court_abbrev;
    if (data.page) pageInp.value = data.page;
    applyJournalConfig();
  } else {
    applyJournalConfig();
  }

  return row;
}

/** Collect all citation data from rows inside a container element. */
function collectCitations(container) {
  const rows = container.querySelectorAll('.citation-row');
  const result = [];
  for (const row of rows) {
    const journal = row.querySelector('.cite-journal')?.value || '';
    const year = row.querySelector('.cite-year')?.value || '';
    const volume = row.querySelector('.cite-volume')?.value || '';
    const court_abbrev = row.querySelector('.cite-court-abbrev')?.value || '';
    const page = row.querySelector('.cite-page')?.value || '';
    if (journal) result.push({ journal, year, volume: volume === '.' ? '' : volume, court_abbrev, page });
  }
  return result;
}

/**
 * Wire a court type <select> to control a court name field.
 * `courtNameEl` is either a <select> or a searchable dropdown wrapper.
 * Returns { getCourtType(), getCourtName(), getCourtAbbrev(), setValues(type, name) }
 */
function wireCourtFields(courtTypeSel, courtNameContainer, searchDropdown) {
  function update() {
    const val = courtTypeSel.value;
    courtNameContainer.innerHTML = '';
    courtNameContainer._searchDropdown = null;
    if (TOP_COURTS[val]) {
      const info = TOP_COURTS[val];
      const fixed = document.createElement('input');
      fixed.type = 'text';
      fixed.value = info.name;
      fixed.disabled = true;
      fixed.style.cssText = 'width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--input-border,#e6e8ef);background:var(--input-bg,#fff);color:var(--text);font-size:14px;opacity:0.7;box-sizing:border-box;';
      fixed.dataset.abbrev = info.abbrev;
      fixed.id = courtNameContainer.dataset.inputId || '';
      courtNameContainer.appendChild(fixed);
      if (searchDropdown) { searchDropdown.input.value = ''; searchDropdown.hiddenInput.value = ''; }
    } else if (val === 'High Court') {
      const sd = buildSearchableDropdown(
        courtNameContainer.dataset.inputId || 'court-name-dd',
        (courtNameContainer.dataset.inputId || 'court-name-dd') + '-hidden',
        'Search High Court…'
      );
      courtNameContainer.appendChild(sd.wrapper);
      // Store reference for later
      courtNameContainer._searchDropdown = sd;
    } else {
      const placeholder = document.createElement('input');
      placeholder.type = 'text';
      placeholder.disabled = true;
      placeholder.placeholder = 'Select court type first';
      placeholder.style.cssText = 'width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--input-border,#e6e8ef);background:var(--input-bg,#fff);color:var(--text);font-size:14px;opacity:0.5;box-sizing:border-box;';
      courtNameContainer.appendChild(placeholder);
    }
  }

  courtTypeSel.addEventListener('change', update);
  update();

  return {
    getCourtType: () => courtTypeSel.value,
    getCourtName: () => {
      const sd = courtNameContainer._searchDropdown;
      if (sd) return sd.hiddenInput.value;
      const inp = courtNameContainer.querySelector('input');
      return inp ? inp.value : '';
    },
    getCourtAbbrev: () => {
      const sd = courtNameContainer._searchDropdown;
      if (sd) return sd.input.dataset.abbrev || '';
      const inp = courtNameContainer.querySelector('input');
      return inp ? (inp.dataset.abbrev || '') : '';
    },
    setValues: (type, name) => {
      courtTypeSel.value = type || '';
      update();
      if (type === 'High Court' && name) {
        const sd = courtNameContainer._searchDropdown;
        if (sd) sd.setVal(name);
      }
    },
  };
}

const NOTE_TEMPLATE_DEFAULT = `{
  "Petitioner Name": "",
  "Petitioner Address": "",
  "Petitioner Contact": "",

  "Respondent Name": "",
  "Respondent Address": "",
  "Respondent Contact": "",

  "Our Party": "",

  "Case Category": "",
  "Case Subcategory": "",
  "Case Type": "",

  "Court of Origin": {
    "State": "",
    "District": "",
    "Court/Forum": ""
  },

  "Current Court/Forum": {
    "State": "",
    "District": "",
    "Court/Forum": ""
  },

  "Additional Notes": ""
}`;

function defaultNoteTemplate(){
  return NOTE_TEMPLATE_DEFAULT;
}

// ------------------ Common UI utilities ------------------
function populateOptions(select, arr, placeholder="Select"){
  if (!select) return;
  select.innerHTML = "";
  const opt = el("option");
  opt.value = "";
  opt.textContent = placeholder;
  select.append(opt);
  arr.forEach(v => {
    const o = el("option");
    o.textContent = v;
    select.append(o);
  });
  select.disabled = false;
}

function openNotesModal(content, intent = 'update', context = null){
  if (typeof window._openNotesWith === 'function') {
    window._openNotesWith(content || '', intent || 'update', context || null);
    return;
  }
  const modal = document.getElementById('notesModal');
  const editor = document.getElementById('notesEditor');
  if (!modal || !editor) return;
  editor.value = content || '';
  editor.style.display = 'block';
  modal.removeAttribute('hidden');
  modal.setAttribute('aria-hidden','false');
}

// --- Search helpers -----------------------------------------------------
async function runBasicSearch(){
  const q = ($('#search-q')?.value || '').trim();
  const url = new URL('/search', location.origin);
  if (q) url.searchParams.set('q', q);
  const r = await fetch(url);
  const data = await r.json().catch(()=>({results:[]}));
  if (data.mode === 'cases') {
    renderCaseResults(data.results || [], q);
  } else {
    renderResults(data.results || []);
  }
  activateSearchResetMode('basic');
}

async function runAdvancedSearch(){
  const params = new URLSearchParams();
  const party = (document.getElementById('party')?.value || '').trim();
  const year  = (document.getElementById('year')?.value || '').trim();   // hidden #year (from year-dd)
  const month = document.getElementById('month')?.value || '';
  const domain = document.getElementById('adv-domain')?.value || '';
  const subcat = document.getElementById('adv-subcat')?.value || '';

  if (party) params.set('party', party);
  if (year)  params.set('year', year);
  if (month) params.set('month', month);
  if (domain) params.set('domain', domain);
  if (subcat) params.set('subcategory', subcat);

  // Only include 'type' if the element still exists (back-compat)
  const typeEl = document.getElementById('type');
  if (typeEl && typeEl.value) params.set('type', typeEl.value);

  const r = await fetch(`/search?${params.toString()}`);
  const data = await r.json().catch(()=>({results:[]}));
  if (data.mode === 'cases') {
    renderCaseResults(data.results || [], party || '');
  } else {
    renderResults(data.results || []);
  }
  activateSearchResetMode('advanced');
}

// ------------ Infinite, scrollable year dropdown (virtualized-ish) ------------
function initYearDropdown(wrapperId, hiddenInputId, startYear) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  const trigger = wrap.querySelector('.yd-trigger');
  const panel = wrap.querySelector('.yd-panel');
  const hidden = document.getElementById(hiddenInputId);
  if (!trigger || !panel || !hidden) return;

  let start = Number(startYear);
  if (!Number.isFinite(start)) {
    const dataStart = wrap.dataset.start ? Number(wrap.dataset.start) : NaN;
    start = Number.isFinite(dataStart) ? dataStart : new Date().getFullYear();
  }

  // Config
  const CHUNK = 80;          // how many years to render per side at once
  const THRESHOLD = 40;      // when to grow (px from top/bottom)
  const itemHeight = 32;     // keep in sync with CSS

  // State
  let anchor = start;    // visual center
  let from = anchor - CHUNK; // inclusive
  let to   = anchor + CHUNK; // inclusive
  let selected = start;

  // Ensure initial value
  hidden.value = String(selected);
  trigger.textContent = `Year: ${selected}`;

  // Utilities
  function render(initial = false) {
    const frag = document.createDocumentFragment();
    for (let y = from; y <= to; y++) {
      const opt = document.createElement('div');
      opt.className = 'yd-item';
      opt.setAttribute('role','option');
      opt.dataset.year = String(y);
      opt.textContent = String(y);
      if (y === selected) opt.classList.add('selected');
      frag.appendChild(opt);
    }
    if (initial) {
      panel.innerHTML = '';
    }
    panel.appendChild(frag);

    if (initial) {
      // scroll so that "anchor" sits roughly in the middle
      const midIndex = anchor - from;
      panel.scrollTop = Math.max(0, midIndex * itemHeight - panel.clientHeight/2 + itemHeight/2);
    }
  }

  function open() {
    if (!panel.hasAttribute('hidden')) return;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');

    // First open: initial render
    if (!panel.dataset.ready) {
      render(true);
      panel.dataset.ready = '1';
    }
    // focus panel for keyboard nav
    panel.focus({ preventScroll: true });
  }

  function close() {
    if (panel.hasAttribute('hidden')) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function setYear(y) {
    selected = y;
    hidden.value = String(y);
    trigger.textContent = `Year: ${y}`;
    // update selection highlight
    panel.querySelectorAll('.yd-item.selected').forEach(n => n.classList.remove('selected'));
    const elx = panel.querySelector(`.yd-item[data-year="${y}"]`);
    if (elx) elx.classList.add('selected');
  }

  // Expand list when scrolling near top/bottom
  panel.addEventListener('scroll', () => {
    const nearTop = panel.scrollTop <= THRESHOLD;
    const nearBottom = (panel.scrollHeight - panel.clientHeight - panel.scrollTop) <= THRESHOLD;

    if (nearTop) {
      // prepend older years
      const oldFrom = from;
      from = from - CHUNK;
      const frag = document.createDocumentFragment();
      for (let y = from; y < oldFrom; y++) {
        const opt = document.createElement('div');
        opt.className = 'yd-item';
        opt.setAttribute('role','option');
        opt.dataset.year = String(y);
        opt.textContent = String(y);
        if (y === selected) opt.classList.add('selected');
        frag.appendChild(opt);
      }
      panel.prepend(frag);
      // maintain visual position
      panel.scrollTop += CHUNK * itemHeight;
    }

    if (nearBottom) {
      const oldTo = to;
      to = to + CHUNK;
      const frag = document.createDocumentFragment();
      for (let y = oldTo + 1; y <= to; y++) {
        const opt = document.createElement('div');
        opt.className = 'yd-item';
        opt.setAttribute('role','option');
        opt.dataset.year = String(y);
        opt.textContent = String(y);
        if (y === selected) opt.classList.add('selected');
        frag.appendChild(opt);
      }
      panel.append(frag);
    }
  });

  // Click select
  panel.addEventListener('click', (e) => {
    const d = e.target.closest('.yd-item');
    if (!d) return;
    const y = parseInt(d.dataset.year, 10);
    if (!isNaN(y)) {
      setYear(y);
      close();
    }
  });

  // Keyboard on panel (Up/Down/Page/Home/End/Enter/Esc)
  panel.tabIndex = 0;
  panel.addEventListener('keydown', (e) => {
    const cur = parseInt(hidden.value || String(selected), 10);
    if (!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End','Enter','Escape'].includes(e.key)) return;
    e.preventDefault();
    let next = cur;
    if (e.key === 'ArrowUp') next = cur + 1;
    if (e.key === 'ArrowDown') next = cur - 1;
    if (e.key === 'PageUp') next = cur + 10;
    if (e.key === 'PageDown') next = cur - 10;
    if (e.key === 'Home') next = 9999;
    if (e.key === 'End') next = 1;
    if (e.key === 'Enter' || e.key === 'Escape') { close(); return; }

    setYear(next);

    // Ensure year element exists; extend if necessary
    if (next < from + 5) {
      const oldFrom = from;
      from = next - CHUNK;
      const frag = document.createDocumentFragment();
      for (let y = from; y < oldFrom; y++) {
        const opt = document.createElement('div');
        opt.className = 'yd-item';
        opt.setAttribute('role','option');
        opt.dataset.year = String(y);
        opt.textContent = String(y);
        if (y === selected) opt.classList.add('selected');
        frag.appendChild(opt);
      }
      panel.prepend(frag);
      panel.scrollTop += (oldFrom - from) * itemHeight;
    } else if (next > to - 5) {
      const oldTo = to;
      to = next + CHUNK;
      const frag = document.createDocumentFragment();
      for (let y = oldTo + 1; y <= to; y++) {
        const opt = document.createElement('div');
        opt.className = 'yd-item';
        opt.setAttribute('role','option');
        opt.dataset.year = String(y);
        opt.textContent = String(y);
        if (y === selected) opt.classList.add('selected');
        frag.appendChild(opt);
      }
      panel.append(frag);
    }

    // Scroll selected into view
    const elx = panel.querySelector(`.yd-item[data-year="${next}"]`);
    if (elx) {
      const r = elx.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      if (r.top < pr.top + 4) panel.scrollTop -= (pr.top + 4 - r.top);
      if (r.bottom > pr.bottom - 4) panel.scrollTop += (r.bottom - (pr.bottom - 4));
    }
  });

  // Open/close trigger + wheel fine-tune
  trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
  trigger.addEventListener('wheel', (e) => {
    if (!panel.hidden) return;
    if (!e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? +1 : -1;
      setYear(selected + delta);
    }
  }, { passive: false });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });

  // Initial text label already set
}

// ------------- Results renderer (authoritative) ----------------
function openConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const text  = document.getElementById('confirmText');
    const yes   = document.getElementById('confirmYes');
    const no    = document.getElementById('confirmNo');
    const x     = document.getElementById('confirmClose');

    if (!modal || !yes || !no || !x) {
      const ok = window.confirm(message || 'Do you want to delete this file?');
      resolve(ok);
      return;
    }

    if (text) text.textContent = message || 'Do you want to delete this file?';
    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');

    const cleanup = () => {
      modal.setAttribute('hidden', '');
      modal.setAttribute('aria-hidden', 'true');
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      x.removeEventListener('click', onNo);
    };
    const onYes = () => { cleanup(); resolve(true); };
    const onNo  = () => { cleanup(); resolve(false); };

    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    x.addEventListener('click', onNo);
  });
}

function openRenamePrompt(currentName) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'rename-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'rename-dialog';
    dialog.innerHTML = `
      <h3>Rename Case</h3>
      <input type="text" class="rename-input" spellcheck="false" />
      <div class="rename-actions">
        <button type="button" class="btn-ghost rename-cancel">Cancel</button>
        <button type="button" class="btn-primary rename-save">Rename</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const input = dialog.querySelector('.rename-input');
    input.value = currentName || '';
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      input.focus();
      input.select();
    });

    const close = (val) => {
      overlay.classList.remove('visible');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      resolve(val);
    };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    dialog.querySelector('.rename-cancel').addEventListener('click', () => close(null));
    dialog.querySelector('.rename-save').addEventListener('click', () => {
      const v = input.value.trim();
      close(v && v !== currentName ? v : null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); dialog.querySelector('.rename-save').click(); }
      if (e.key === 'Escape') close(null);
    });
  });
}

function smartTruncate(filename, maxLen = 100) {
  if (!filename || filename.length <= maxLen) return filename || '';
  const extIndex = filename.lastIndexOf('.');
  const ext = extIndex !== -1 ? filename.slice(extIndex) : '';
  const base = extIndex !== -1 ? filename.slice(0, extIndex) : filename;
  const keep = maxLen - ext.length - 3;
  const startLen = Math.ceil(keep / 2);
  const endLen = Math.floor(keep / 2);
  return base.slice(0, startLen) + '...' + base.slice(-endLen) + ext;
}

function buildResultItem(rec) {
  const row = document.createElement('div');
  row.className = 'result-item';
  row.dataset.path = rec.path;

  // filename (truncated for display only)
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = smartTruncate(rec.file, 100);

  // actions area
  const actions = document.createElement('div');
  actions.className = 'icon-row';

  // Download button
  const dl = document.createElement('a');
  dl.className = 'icon-btn';
  dl.href = `/static-serve?path=${encodeURIComponent(rec.path)}&download=1`;
  dl.setAttribute('title', 'Download');
  dl.innerHTML = `<i class="fa-solid fa-download" aria-hidden="true"></i><span class="sr-only">Download</span>`;
  actions.appendChild(dl);

  if (CASEORG_IS_ADMIN) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.setAttribute('title', 'Delete');
    del.innerHTML = `<i class="fa-solid fa-trash" aria-hidden="true"></i><span class="sr-only">Delete</span>`;
    del.addEventListener('click', async () => {
      const displayName = smartTruncate(rec.file, 100);
      const ok = await openConfirm(`Delete “${displayName}”?`);
      if (!ok) return;

      try {
        const resp = await fetch('/api/delete-item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
          body: JSON.stringify({ path: rec.path })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
          const msg = data && data.msg ? data.msg : `HTTP ${resp.status}`;
          alert(`Delete failed: ${msg}`);
          return;
        }
        row.remove();
      } catch (e) {
        alert(`Delete failed: ${e}`);
      }
    });
    actions.appendChild(del);
  }

  // double-click downloads
  row.addEventListener('dblclick', () => dl.click());

  // assemble row
  row.appendChild(name);
  row.appendChild(actions);
  return row;
}

function cloneResults(list) {
  if (!Array.isArray(list)) return null;
  return list.map(item => ({ ...item }));
}

let lastRenderedResults = null;
const SEARCH_DEFAULT_HINT = 'Use the search tools above to view results.';

const dirSearchState = {
  active: false,
  previousScroll: 0,
  currentPath: '',
  searchRootPath: '',
  savedCaseResults: null,
  savedQuery: ''
};

const searchUiState = {
  resetMode: false,
  activeMode: 'none',
};

function setSearchResetButton(enabled){
  const advBtn = document.getElementById('adv-search');
  if (!advBtn) return;
  advBtn.textContent = enabled ? 'Reset Search' : 'Advanced Search';
  advBtn.classList.toggle('btn-danger', enabled);
  advBtn.classList.toggle('btn-secondary', !enabled);
  advBtn.setAttribute('aria-label', enabled ? 'Reset Search' : 'Advanced Search');
  advBtn.dataset.mode = enabled ? 'reset' : 'search';
}

function activateSearchResetMode(mode = 'basic'){
  searchUiState.resetMode = true;
  searchUiState.activeMode = mode;
  setSearchResetButton(true);
}

// Mount the advanced-search File Subcategory control: a grouped searchable
// taxonomy dropdown for Civil/Criminal/Commercial, or a disabled placeholder.
// The dropdown's hidden input keeps id "adv-subcat", so existing reads work.
function mountAdvSubcat(dom){
  const host = document.getElementById('adv-subcat-host');
  if (!host) return;
  host.innerHTML = '';
  if (FILE_SUBCATS[dom]) {
    buildGroupedSearchableDropdown(host, 'adv-subcat', 'Search subcategory…', FILE_SUBCATS[dom]);
  } else {
    const ph = document.createElement('input');
    ph.type = 'text';
    ph.disabled = true;
    ph.className = 'mc-subcat-placeholder';
    ph.placeholder = 'Subcategory';
    host.appendChild(ph);
  }
}

function clearSearchInputs(){
  const q = document.getElementById('search-q');
  if (q) q.value = '';
  const party = document.getElementById('party');
  if (party) party.value = '';
  const year = document.getElementById('year');
  if (year) year.value = '';
  const month = document.getElementById('month');
  if (month) month.value = '';
  const domain = document.getElementById('adv-domain');
  if (domain) domain.value = '';
  mountAdvSubcat('');
  const typeEl = document.getElementById('type');
  if (typeEl) typeEl.value = '';
}

function resetSearchUi(){
  dirSearchState.active = false;
  dirSearchState.previousScroll = 0;
  dirSearchState.currentPath = '';
  dirSearchState.searchRootPath = '';
  dirSearchState.savedCaseResults = null;
  dirSearchState.savedQuery = '';

  const dirBtn = document.getElementById('dir-search');
  if (dirBtn) {
    dirBtn.classList.remove('active');
    dirBtn.textContent = 'Directory Search';
    dirBtn.setAttribute('aria-pressed', 'false');
  }

  const host = document.getElementById('results');
  if (host) {
    host.innerHTML = `<div class="result-item">${SEARCH_DEFAULT_HINT}</div>`;
    host.scrollTop = 0;
  }

  clearSearchInputs();
  lastRenderedResults = null;
  searchUiState.resetMode = false;
  searchUiState.activeMode = 'none';
  setSearchResetButton(false);
}

function renderResults(list) {
  const host = document.getElementById('results');
  if (!host) return;

  if (dirSearchState.active) {
    dirSearchState.active = false;
    dirSearchState.previousScroll = 0;
    dirSearchState.currentPath = '';
    dirSearchState.searchRootPath = '';
    dirSearchState.savedCaseResults = null;
    dirSearchState.savedQuery = '';
    const dirBtn = document.getElementById('dir-search');
    if (dirBtn) {
      dirBtn.classList.remove('active');
      dirBtn.textContent = 'Directory Search';
      dirBtn.setAttribute('aria-pressed', 'false');
    }
  }

  lastRenderedResults = cloneResults(list);
  host.innerHTML = '';
  if (!list || !list.length) {
    const empty = document.createElement('div');
    empty.className = 'result-item';
    empty.textContent = 'No results.';
    host.appendChild(empty);
    return;
  }
  list.forEach(rec => host.appendChild(buildResultItem(rec)));
}

// ------------- Open a case in Manage Case form -------------------------
/** Resolve once `selector` exists, or with null once `timeoutMs` has passed. */
function waitForElement(selector, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - started > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function openCaseInManage(year, month, caseName) {
  const manageCard = document.getElementById('card-manage');
  // A card click TOGGLES. When Manage Case was already the open form this
  // closed it, so choosing a case from the search results appeared to do
  // nothing at all and had to be repeated. Only click to open it.
  if (manageCard && !manageCard.classList.contains('active')) manageCard.click();

  // The form is built asynchronously, so wait for its fields to exist rather
  // than assuming a single frame was long enough.
  waitForElement('#mc-year').then(async () => {
    const yearSel  = document.getElementById('mc-year');
    const monthSel = document.getElementById('mc-month');
    const caseSel  = document.getElementById('mc-case');
    if (!yearSel || !monthSel || !caseSel) return;

    // Ensure years are loaded
    if (!Array.from(yearSel.options).some(opt => opt.value === year)) {
      const r = await fetch('/api/years');
      const data = await r.json().catch(() => ({years:[]}));
      yearSel.innerHTML = '<option value="">Year</option>';
      (data.years || []).forEach(y => {
        const o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.append(o);
      });
    }
    yearSel.value = year;

    // Load months
    const mResp = await fetch(`/api/months?${new URLSearchParams({year})}`);
    const mData = await mResp.json().catch(() => ({months:[]}));
    monthSel.innerHTML = '<option value="">Month</option>';
    (mData.months || []).forEach(m => {
      const o = document.createElement('option'); o.value = m; o.textContent = m; monthSel.append(o);
    });
    monthSel.disabled = false;
    monthSel.value = month;

    // Load cases
    const cResp = await fetch(`/api/cases?${new URLSearchParams({year, month})}`);
    const cData = await cResp.json().catch(() => ({cases:[]}));
    caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>';
    (cData.cases || []).forEach(cn => {
      const o = document.createElement('option'); o.value = cn; o.textContent = cn; caseSel.append(o);
    });
    caseSel.disabled = false;
    caseSel.value = caseName;
    caseSel.dispatchEvent(new Event('change'));
  });
}

// ------------- Case-name search results --------------------------------
function renderCaseResults(list, query) {
  const host = document.getElementById('results');
  if (!host) return;

  // Exit directory search mode if active
  if (dirSearchState.active) {
    dirSearchState.active = false;
    dirSearchState.previousScroll = 0;
    dirSearchState.currentPath = '';
    dirSearchState.searchRootPath = '';
    const dirBtn = document.getElementById('dir-search');
    if (dirBtn) {
      dirBtn.classList.remove('active');
      dirBtn.textContent = 'Directory Search';
      dirBtn.setAttribute('aria-pressed', 'false');
    }
  }

  // Save for returning from directory browsing
  dirSearchState.savedCaseResults = list;
  dirSearchState.savedQuery = query || '';

  document.querySelectorAll('.case-action-menu').forEach(m => m.remove());
  host.innerHTML = '';
  if (!list || !list.length) {
    const empty = document.createElement('div');
    empty.className = 'result-item';
    empty.textContent = 'No results.';
    host.appendChild(empty);
    return;
  }

  list.forEach(rec => {
    const row = document.createElement('div');
    row.className = 'result-item folder case-result';
    row.dataset.rel = rec.rel;

    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.innerHTML = `<i class="fa-solid fa-folder-open" style="color: var(--accent); margin-right:6px;"></i>${escapeHtml(rec.case)}`;

    const sub = document.createElement('div');
    sub.className = 'case-meta';
    sub.textContent = `${rec.month} ${rec.year}`;

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    info.appendChild(nameEl);
    info.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'icon-row';

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'icon-btn';
    menuBtn.setAttribute('title', 'Case actions');
    menuBtn.innerHTML = `<i class="fa-solid fa-bars" aria-hidden="true" style="line-height:1;"></i><span class="sr-only">Actions</span>`;

    const menu = document.createElement('div');
    menu.className = 'case-action-menu';

    const manageOpt = document.createElement('button');
    manageOpt.type = 'button';
    manageOpt.innerHTML = `<i class="fa-solid fa-folder-open"></i> Manage Case`;
    manageOpt.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.remove('open');
      openCaseInManage(rec.year, rec.month, rec.case);
    });
    menu.appendChild(manageOpt);

    if (CASEORG_IS_ADMIN) {
      const renameOpt = document.createElement('button');
      renameOpt.type = 'button';
      renameOpt.innerHTML = `<i class="fa-solid fa-pen"></i> Edit Case Name`;
      renameOpt.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.classList.remove('open');
        const newName = await openRenamePrompt(rec.case);
        if (!newName) return;
        try {
          const resp = await fetch('/api/rename-case', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
            body: JSON.stringify({ path: rec.path, new_name: newName })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data.ok) {
            alert(`Rename failed: ${data.msg || 'HTTP ' + resp.status}`);
            return;
          }
          nameEl.innerHTML = `<i class="fa-solid fa-folder-open" style="color: var(--accent); margin-right:6px;"></i>${escapeHtml(newName)}`;
          rec.case = newName;
          rec.path = data.new_path || rec.path;
        } catch (err) {
          alert(`Rename failed: ${err}`);
        }
      });
      menu.appendChild(renameOpt);

      const deleteOpt = document.createElement('button');
      deleteOpt.type = 'button';
      deleteOpt.className = 'danger';
      deleteOpt.innerHTML = `<i class="fa-solid fa-trash"></i> Delete Case`;
      deleteOpt.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.classList.remove('open');
        const ok = await openConfirm(`Delete entire case folder "${escapeHtml(rec.case)}"? This will remove ALL files inside.`);
        if (!ok) return;
        try {
          const resp = await fetch('/api/delete-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
            body: JSON.stringify({ path: rec.path })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data.ok) {
            alert(`Delete failed: ${data.msg || 'HTTP ' + resp.status}`);
            return;
          }
          menu.remove();
          row.remove();
        } catch (err) {
          alert(`Delete failed: ${err}`);
        }
      });
      menu.appendChild(deleteOpt);
    }

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.case-action-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
      const rect = menuBtn.getBoundingClientRect();
      menu.style.transformOrigin = 'top right';
      menu.style.top = (rect.bottom + 6) + 'px';
      menu.style.left = (rect.right - menu.offsetWidth) + 'px';
      menu.classList.toggle('open');
    });

    // Right-clicking the row opens the same action menu at the cursor
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.case-action-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
      const pad = 8;
      const left = Math.max(pad, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - pad));
      const top = Math.max(pad, Math.min(e.clientY + 4, window.innerHeight - menu.offsetHeight - pad));
      menu.style.transformOrigin = 'top left';
      menu.style.top = top + 'px';
      menu.style.left = left + 'px';
      menu.classList.add('open');
    });

    actions.appendChild(menuBtn);
    document.body.appendChild(menu);

    row.appendChild(info);
    row.appendChild(actions);

    // Click the row to browse into the case directory
    row.addEventListener('click', () => {
      dirSearchState.active = true;
      dirSearchState.searchRootPath = rec.rel;
      dirSearchState.currentPath = rec.rel;
      activateSearchResetMode('basic');
      showDirLevel(rec.rel);
    });

    host.appendChild(row);
  });
}

// ------------- Directory tree (optional button #dir-search) -------------
async function showDirLevel(relPath) {
  if (!dirSearchState.active) return;
  const results = document.getElementById('results');
  if (!results) return;

  dirSearchState.currentPath = relPath || '';

  const url = new URL('/api/dir-tree', location.origin);
  if (relPath) url.searchParams.set('path', relPath);

  try {
    const resp = await fetch(url.toString());
    const data = await resp.json().catch(() => ({}));
    if (!dirSearchState.active) return;
    results.innerHTML = '';

    // Up directory / back to case list
    if (relPath) {
      const up = document.createElement('div');
      up.className = 'result-item folder';
      // If we're at the search root (a case folder opened from search), go back to case list
      up.innerHTML = `<i class="fa-solid fa-arrow-up" style="margin-right:6px;"></i> ..`;
      if (dirSearchState.searchRootPath && relPath === dirSearchState.searchRootPath) {
        up.addEventListener('click', () => {
          dirSearchState.active = false;
          dirSearchState.currentPath = '';
          dirSearchState.searchRootPath = '';
          if (dirSearchState.savedCaseResults) {
            renderCaseResults(dirSearchState.savedCaseResults, dirSearchState.savedQuery);
            activateSearchResetMode('basic');
          }
        });
      } else {
        up.addEventListener('click', () => {
          const parts = relPath.split('/');
          parts.pop();
          showDirLevel(parts.join('/'));
        });
      }
      results.appendChild(up);
    }

    // Directories (strings from /api/dir-tree)
    (data.dirs || []).forEach(dir => {
      const dirName = String(typeof dir === 'object' ? dir.name : dir);
      const dirRelPath = relPath ? `${relPath}/${dirName}` : dirName;

      const row = document.createElement('div');
      row.className = 'result-item folder';
      const label = document.createElement('span');
      label.className = 'name';
      label.innerHTML = `<i class="fa-solid fa-folder-open" style="color: var(--accent); margin-right:6px;"></i>${escapeHtml(dirName)}`;
      row.appendChild(label);
      row.addEventListener('click', () => showDirLevel(dirRelPath));

      // Admin delete button for directories (only depth >= 3: year/month/case level and below)
      const dirDepth = dirRelPath.split('/').length;
      if (CASEORG_IS_ADMIN && dirDepth >= 3) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn';
        del.setAttribute('title', 'Delete folder');
        del.innerHTML = `<i class="fa-solid fa-trash" aria-hidden="true"></i><span class="sr-only">Delete</span>`;
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = await openConfirm(`Delete folder "${escapeHtml(dirName)}" and ALL its contents?`);
          if (!ok) return;
          try {
            const r = await fetch('/api/delete-item', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
              body: JSON.stringify({ rel: dirRelPath })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) {
              alert(`Delete failed: ${d.msg || 'HTTP ' + r.status}`);
              return;
            }
            row.remove();
          } catch (err) {
            alert(`Delete failed: ${err}`);
          }
        });
        row.appendChild(del);
      }

      results.appendChild(row);
    });

    // Files
    (data.files || []).forEach(f => {
      results.appendChild(buildResultItem({
        file: f.name,
        path: f.path,
        rel: f.name
      }));
    });

    if ((!data.dirs || !data.dirs.length) && (!data.files || !data.files.length)) {
      const empty = document.createElement('div');
      empty.className = 'result-item';
      empty.textContent = '(empty)';
      results.appendChild(empty);
    }
  } catch (e) {
    if (!dirSearchState.active) return;
    results.innerHTML = `<div class="result-item">Error: ${e}</div>`;
  }
}

// -------------------- Create Case form --------------------
function setActive(card, others){
  card.classList.add('active'); card.setAttribute('aria-pressed','true');
  others.forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed','false'); });
}

function createCaseForm(){
  const host = $('#form-host');
  if (!host) return;
  host.innerHTML = '';
  const wrap = el('div','form-card');
  wrap.innerHTML = `
    <h3>Create Case</h3>
    <div class="form-grid">
      <!-- Parties -->
      <input type="text" id="pn" placeholder="Petitioner Name" />
      <input type="text" id="rn" placeholder="Respondent Name" />
      <input type="text" id="pa" placeholder="Petitioner Address" />
      <input type="text" id="ra" placeholder="Respondent Address" />
      <input type="text" id="pc" placeholder="Petitioner Contact" />
      <input type="text" id="rc" placeholder="Respondent Contact" />

      <!-- Date + Auto Case Name (preview) -->
      <input type="date" id="cc-date" />
      <input type="text" id="cc-name-preview" placeholder="Case Name (auto)" disabled />
      <input type="hidden" id="cc-name" />

      <!-- Representing -->
      <div style="grid-column: span 2;">
        <input type="hidden" id="op" value="Petitioner" />
        <div class="op-tabs" role="tablist">
          <button type="button" class="op-tab active" data-value="Petitioner" role="tab" aria-selected="true">Petitioner</button>
          <button type="button" class="op-tab" data-value="Respondent" role="tab" aria-selected="false">Respondent</button>
        </div>
      </div>

      <!-- Classification -->
      <div class="full-span">
        <select id="cat"><option value="">Case Category</option><option>Criminal</option><option>Civil</option><option>Commercial</option></select>
      </div>

      <!-- Original court -->
      <input type="text" id="os" placeholder="Original State" />
      <input type="text" id="od" placeholder="Original District" />
      <div id="of-host" class="full-span"></div>

      <!-- Current forum / place -->
      <div class="full-span">
        <select id="current-status">
          <option>Same as Original</option>
          <option>Transferred</option>
          <option>To be transferred</option>
          <option>In Appeal</option>
        </select>
      </div>
      <div id="current-extra" class="full-span"></div>

      <textarea id="an" class="full-span cc-additional-notes" rows="4" placeholder="Additional Notes"></textarea>
    </div>
    <div class="form-actions">
      <button id="cc-go" class="btn-primary" type="button">Create Case & Save Note</button>
    </div>
  `;
  host.append(wrap);

  // defaults
  initIndianDateField('cc-date', todayIso());

  // "We're Representing" tab buttons
  const opHidden = $('#op');
  wrap.querySelectorAll('.op-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      wrap.querySelectorAll('.op-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      if (opHidden) opHidden.value = tab.dataset.value;
    });
  });

  // Auto case name from PN/RN
  function updateCaseName(){
    const pn = ($('#pn')?.value || '').trim();
    const rn = ($('#rn')?.value || '').trim();
    const name = (pn && rn) ? `${pn} v. ${rn}` : '';
    const hidden = $('#cc-name');
    const preview = $('#cc-name-preview');
    if (hidden) hidden.value = name;
    if (preview) preview.value = name;
  }
  ['pn','rn'].forEach(id => $('#'+id)?.addEventListener('input', updateCaseName));
  updateCaseName();

  // Original Court/Forum — unified Supreme Court + High Court searchable dropdown
  // (with free-text fallback for trial / lower courts not in the list).
  const ofHost = $('#of-host');
  if (ofHost) {
    const ofDD = buildSearchableDropdown(
      'of-input', 'of',
      'Original Court / Forum — search Supreme Court / High Courts, or type a lower court',
      { includeSupremeCourt: true, allowFreeText: true }
    );
    ofHost.appendChild(ofDD.wrapper);
  }

  // Current Forum/Place — reveal only the fields that apply.
  function renderCurrentExtra(status) {
    const host = $('#current-extra');
    if (!host) return;
    host.innerHTML = '';
    // "Same as Original" needs nothing. Transferred / To be transferred / In
    // Appeal all take State + District + a FREE-TEXT Court/Forum — an appeal
    // often goes from a Magistrate to a District/Sessions Court, not a High
    // Court, so the forum must be typeable (like the Original Court/Forum).
    if (status === 'Same as Original') return;
    const proposed = (status === 'To be transferred');
    const forumPh = {
      'Transferred': 'Current Court / Forum — search or type any court',
      'To be transferred': 'Proposed transferee Court / Forum (if known) — type any court',
      'In Appeal': 'Appellate Court / Forum — High Court, District/Sessions Court, or type any court',
    }[status] || 'Current Court / Forum';
    host.innerHTML = `
      <div class="form-grid">
        <input type="text" id="cs" placeholder="${proposed ? 'Proposed State (if known)' : 'Current State'}" />
        <input type="text" id="cd" placeholder="${proposed ? 'Proposed District (if known)' : 'Current District'}" />
        <div id="cf-host" class="full-span"></div>
      </div>`;
    const dd = buildSearchableDropdown(
      'cf-input', 'cf', forumPh,
      { includeSupremeCourt: true, allowFreeText: true }
    );
    $('#cf-host')?.appendChild(dd.wrapper);
  }
  $('#current-status')?.addEventListener('change', () => renderCurrentExtra($('#current-status').value || 'Same as Original'));

  // Convert all selects to Long-List Dropdowns
  convertAllSelectsToLLD(wrap);

  // Submit
  $('#cc-go')?.addEventListener('click', async ()=>{
    const fd = new FormData();
    fd.set('Date', $('#cc-date')?.value || '');
    fd.set('Case Name', $('#cc-name')?.value || '');  // auto-built
    fd.set('Petitioner Name', ($('#pn')?.value || '').trim());
    fd.set('Petitioner Address', ($('#pa')?.value || '').trim());
    fd.set('Petitioner Contact', ($('#pc')?.value || '').trim());
    fd.set('Respondent Name', ($('#rn')?.value || '').trim());
    fd.set('Respondent Address', ($('#ra')?.value || '').trim());
    fd.set('Respondent Contact', ($('#rc')?.value || '').trim());
    fd.set('Our Party', $('#op')?.value || '');
    fd.set('Case Category', $('#cat')?.value || '');
    fd.set('Origin State', ($('#os')?.value || '').trim());
    fd.set('Origin District', ($('#od')?.value || '').trim());
    fd.set('Origin Court/Forum', ($('#of')?.value || '').trim());
    const status = $('#current-status')?.value || 'Same as Original';
    fd.set('Current Status', status);
    if (status === 'Same as Original') {
      fd.set('Current State', '');
      fd.set('Current District', '');
      fd.set('Current Court/Forum', '');
    } else {
      // Transferred / To be transferred / In Appeal all use State/District/Forum.
      fd.set('Current State', ($('#cs')?.value || '').trim());
      fd.set('Current District', ($('#cd')?.value || '').trim());
      fd.set('Current Court/Forum', ($('#cf')?.value || '').trim());
    }
    fd.set('Additional Notes', ($('#an')?.value || '').trim());

    if (!($('#cc-name')?.value)) { alert('Enter Petitioner and Respondent to form the Case Name.'); return; }

    const r = await fetch('/create-case', { method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd });
    const data = await r.json().catch(()=>({ok:false,msg:'Bad JSON'}));
    alert(data.ok ? 'Case created at: ' + data.path : ('Error: ' + (data.msg || 'Failed')));
  });
}

// -------------------- Manage Case form --------------------
function manageCaseForm(){
  const host = $('#form-host');
  if (!host) return;
  host.innerHTML = '';
  const wrap = el('div','form-card manage-case-card');
  wrap.innerHTML = `
    <h3 class="section-title">Manage Case</h3>

    <!-- Case picker — identical structure to the calendar's event-modal picker:
         a search row, then Year / Month / Case on one line. -->
    <div class="mc-name-search">
      <input type="text" id="mc-name-input" placeholder="Search case by party name…" />
      <button type="button" id="mc-name-search" class="btn-secondary">Search</button>
    </div>
    <div id="mc-name-results" class="results mc-name-results" hidden></div>
    <div class="case-picker">
      <select id="mc-year"><option value="">Year</option></select>
      <select id="mc-month" disabled><option value="">Month</option></select>
      <select id="mc-case" disabled><option value="">Case (Petitioner v. Respondent)</option></select>
    </div>

    <!-- Proceedings — ALWAYS present; faded + read-only until a case is picked. -->
    <div class="mc-proceeding mc-locked" id="mc-proceeding" aria-disabled="true">

      <!-- File Category then Subcategory. The subcategory IS the main proceeding
           (the cause of action); Primary/Misc are only what gets filed within
           it, so both are chosen here — before the tabs unlock. -->
      <div class="form-grid mc-classify">
        <select id="domain">
          <option value="">File Category</option>
          <option>Criminal</option><option>Civil</option><option>Commercial</option><option>Case Law</option><option>Invoices</option><option>Legal Notices</option>
        </select>
        <div id="subcategory-host"></div>
      </div>

      <!-- Primary vs Misc — unlocked only once a category + subcategory are set. -->
      <div class="mc-proc-body is-locked" id="mc-proc-body">
        <div class="mc-tabs mc-proc-tabs" id="mc-proc-tabs" role="tablist">
          <button type="button" class="mc-proc-tab active" data-ptab="primary" role="tab" aria-selected="true">Primary Proceedings</button>
          <button type="button" class="mc-proc-tab" data-ptab="misc" role="tab" aria-selected="false">Misc Proceedings</button>
        </div>

        <div class="form-grid mc-fields">
          <!-- Misc only: the interlocutory application filed WITHIN the chosen
               subcategory (a grouped, searchable set of CPC / CrPC / Commercial
               Courts Act interim remedies — not a fresh subcategory). -->
          <div id="misc-proceeding-host" class="mc-only-misc"></div>

          <select id="mc-subfolder"><option value="">(no sub-folder — subcategory root)</option></select>
          <input type="text" id="main-type" placeholder="Main Type (e.g., Writ Petition, Rejoinder)" />
          <input type="date" id="mc-date" class="full-span" />
        </div>
      </div>
    </div>

    <div class="dropzone" id="drop" tabindex="0">Drag & drop files here or click to select</div>
    <input type="file" id="file" hidden accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.json" multiple />
    <div id="file-list" class="results"></div>

    <div class="form-actions">
      <button id="mc-go" class="btn-primary" type="button">Upload & Categorize File(s)</button>
      <div class="mc-actions-right">
        <button id="mc-invoice" class="btn-secondary mc-icon-btn" type="button" title="Generate Invoice" aria-label="Generate Invoice" disabled><i class="fa-solid fa-file-invoice-dollar" aria-hidden="true"></i></button>
        <button id="create-note-btn" class="btn-secondary" type="button" disabled>View / Edit Note.json</button>
      </div>
    </div>
  `;
  host.append(wrap);

  // defaults
  initIndianDateField('mc-date', todayIso());

  // --- Populate Year / Month / Case from backend -----------------------
  const yearSel  = $('#mc-year');
  const monthSel = $('#mc-month');
  const caseSel  = $('#mc-case');
  const noteBtn  = $('#create-note-btn');
  const invoiceBtn = $('#mc-invoice');
  const nameInput = $('#mc-name-input');
  const nameBtn = $('#mc-name-search');
  const nameResults = $('#mc-name-results');

  const setVisibility = (el, show) => {
    if (!el) return;
    if (show) {
      el.classList.remove('is-hidden');
      el.removeAttribute('hidden');
    } else {
      el.classList.add('is-hidden');
      el.setAttribute('hidden', '');
    }
  };

  // v4.8: the note button is always visible; it starts disabled (faded,
  // read-only) and lights up once a case is selected.
  if (noteBtn) {
    noteBtn.disabled = true;
    delete noteBtn.dataset.hasNote;
    delete noteBtn.dataset.intent;
    noteBtn.onclick = null;
  }

  function activateTab(target){
    const tabs = Array.from(document.querySelectorAll('.mc-tab'));
    const panels = Array.from(document.querySelectorAll('.mc-panel'));
    tabs.forEach(tab => {
      const active = tab.dataset.tab === target;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    panels.forEach(panel => {
      panel.hidden = panel.dataset.tab !== target;
    });
  }

  Array.from(document.querySelectorAll('.mc-tab')).forEach(tab => {
    tab.addEventListener('click', () => {
      if (!tab.dataset.tab) return;
      activateTab(tab.dataset.tab);
    });
  });
  activateTab('date');

  async function loadYears(){
    const r = await fetch('/api/years');
    const data = await r.json().catch(()=>({years:[]}));
    yearSel.innerHTML = '<option value="">Year</option>';
    (data.years || []).forEach(y => {
      const o = el('option'); o.value = y; o.textContent = y; yearSel.append(o);
    });
    yearSel.disabled = false;
    monthSel.innerHTML = '<option value="">Month</option>'; monthSel.disabled = true;
    caseSel.innerHTML  = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true;
    updateCaseActions();
  }

  async function loadMonths(year){
    const r = await fetch(`/api/months?${new URLSearchParams({year})}`);
    const data = await r.json().catch(()=>({months:[]}));
    monthSel.innerHTML = '<option value="">Month</option>';
    (data.months || []).forEach(m => {
      const o = el('option'); o.value = m; o.textContent = m; monthSel.append(o);
    });
    monthSel.disabled = false;
    caseSel.innerHTML  = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true;
    updateCaseActions();
  }

  async function loadCases(year, month){
    const r = await fetch(`/api/cases?${new URLSearchParams({year, month})}`);
    const data = await r.json().catch(()=>({cases:[]}));
    caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>';
    (data.cases || []).forEach(cn => {
      const o = el('option'); o.value = cn; o.textContent = cn; caseSel.append(o);
    });
    caseSel.disabled = false;
    updateCaseActions();
  }

  yearSel.addEventListener('change', () => {
    const y = yearSel.value || '';
    if (!y){
      monthSel.innerHTML = '<option value="">Month</option>'; monthSel.disabled = true;
      caseSel.innerHTML  = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true;
      updateCaseActions();
      return;
    }
    loadMonths(y);
  });

  monthSel.addEventListener('change', () => {
    const y = yearSel.value || ''; const m = monthSel.value || '';
    if (y && m) loadCases(y, m);
    else { caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true; updateCaseActions(); }
  });

  caseSel.addEventListener('change', updateCaseActions);

  if (invoiceBtn) {
    invoiceBtn.disabled = true;
    invoiceBtn.setAttribute('aria-disabled', 'true');
    invoiceBtn.addEventListener('click', () => {
      if (invoiceBtn.disabled) return;
      const year = yearSel.value || '';
      const month = monthSel.value || '';
      const cname = caseSel.value || '';
      if (!year || !month || !cname) return;
      const params = new URLSearchParams({ year, month, case: cname });
      window.location.href = `/invoice?${params.toString()}`;
    });
  }

  // --- Notes presence check + button wiring -----------------
  async function getNoteState(year, month, cname) {
      try {
          const resp = await fetch(`/api/note/${year}/${month}/${encodeURIComponent(cname)}`);
          const data = await resp.json().catch(()=>null);
          if (resp.ok && data?.ok) {
              return {
                  exists: true,
                  content: data.content || '',
                  template: data.template || defaultNoteTemplate()
              };
          }
          return {
              exists: false,
              content: '',
              template: (data && data.template) || defaultNoteTemplate()
          };
      } catch (err) {
          console.warn('Note check failed', err);
          return { exists: false, content: '', template: defaultNoteTemplate() };
      }
  }

  async function updateCaseActions() {
      const year  = yearSel.value || '';
      const month = monthSel.value || '';
      const cname = caseSel.value || '';
      const hasSelection = Boolean(year && month && cname);

      // v4.8: the proceedings block is ALWAYS visible — it just stays faded +
      // non-interactive (read-only) until a case is picked, exactly like the
      // View/Edit Note button.
      const proc = $('#mc-proceeding');
      if (proc) {
          proc.classList.toggle('mc-locked', !hasSelection);
          proc.setAttribute('aria-disabled', hasSelection ? 'false' : 'true');
      }

      if (invoiceBtn) {
          invoiceBtn.disabled = !hasSelection;
          invoiceBtn.setAttribute('aria-disabled', hasSelection ? 'false' : 'true');
      }
      if (noteBtn) noteBtn.disabled = !hasSelection;

      if (!hasSelection) {
          if (noteBtn) {
              delete noteBtn.dataset.hasNote;
              delete noteBtn.dataset.intent;
              noteBtn.onclick = null;
          }
          return;
      }

      const noteState = await getNoteState(year, month, cname);

      // Which side we represent is fixed at case creation (Note.json "Our
      // Party") — read it and drive the Primary taxonomy from it; no toggle,
      // no on-screen label.
      try {
          const obj = JSON.parse(noteState.content || '{}');
          representing = (obj['Our Party'] === 'Respondent') ? 'Respondent' : 'Petitioner';
      } catch (_) { representing = 'Petitioner'; }
      mountPrimarySubcat();
      updateProcLock();

      if (!noteBtn) return;

      if (!noteState.exists) {
          // A selected case with no Note.json is unusual (cases get one at
          // creation) — keep the button enabled but report it clearly.
          delete noteBtn.dataset.hasNote;
          noteBtn.dataset.intent = 'update';
          noteBtn.textContent = 'View / Edit Note.json';
          noteBtn.onclick = () => { alert('Note.json not found for this case.'); };
          return;
      }

      noteBtn.dataset.hasNote = '1';
      noteBtn.dataset.intent = 'update';
      noteBtn.textContent = 'View / Edit Note.json';
      noteBtn.onclick = async () => {
          const currentState = await getNoteState(yearSel.value || '', monthSel.value || '', caseSel.value || '');
          if (!currentState.exists) {
              alert('Note.json not found for this case.');
              updateCaseActions();
              return;
          }
          const context = {
              kind: 'case',
              year: yearSel.value || '',
              month: monthSel.value || '',
              caseName: caseSel.value || ''
          };
          openNotesModal(currentState.content || '', 'update', context);
      };
  }

  // expose so the modal save handler can refresh after writes
  window.__refreshNoteButton = updateCaseActions;

  async function renderNameResults(list){
    if (!nameResults) return;
    nameResults.innerHTML = '';
    if (!Array.isArray(list) || !list.length) {
      nameResults.innerHTML = '<div class="result-item">No cases found.</div>';
      return;
    }
    list.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'result-item mc-name-result';
      btn.innerHTML = `
        <div class="name">${escapeHtml(item.case)}</div>
        <div class="meta">${escapeHtml(item.month)} ${escapeHtml(item.year)}</div>
      `;
      btn.addEventListener('click', async () => {
        activateTab('date');
        if (!yearSel || !monthSel || !caseSel) return;
        if (!Array.from(yearSel.options).some(opt => opt.value === item.year)) {
          await loadYears();
        }
        yearSel.value = item.year;
        await loadMonths(item.year);
        monthSel.value = item.month;
        await loadCases(item.year, item.month);
        caseSel.value = item.case;
        caseSel.dispatchEvent(new Event('change'));
        updateCaseActions();
        // Picking a result resets the search: the case is now loaded on the
        // Date tab, so a stale query and result list are just noise.
        if (nameInput) nameInput.value = '';
        nameResults.innerHTML = '';
      });
      nameResults.append(btn);
    });
  }

  async function performNameSearch(){
    if (!nameInput || !nameResults) return;
    const q = nameInput.value.trim();
    if (!q) {
      alert('Enter a case name to search.');
      nameInput.focus();
      return;
    }
    nameResults.innerHTML = '<div class="result-item">Searching…</div>';
    try {
      const resp = await fetch(`/api/cases/search?${new URLSearchParams({q})}`);
      const data = await resp.json().catch(()=>({}));
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      renderNameResults(data.cases || []);
    } catch (err) {
      nameResults.innerHTML = `<div class="result-item">Search failed: ${escapeHtml(err.message || err)}</div>`;
    }
  }

  nameBtn?.addEventListener('click', performNameSearch);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      performNameSearch();
    }
  });


  // Load initial years
  loadYears();

  // --- File Category -> File Subcategory (grouped searchable taxonomy) -------
  // Civil/Criminal/Commercial → searchable taxonomy dropdown. Case Law / Invoices
  // / Legal Notices keep NO subcategory (a disabled placeholder is shown).
  // ---- v4.8: role-aware primary taxonomy + Misc proceedings ----
  let representing = 'Petitioner';
  function branchOf() {
    const d = $('#domain')?.value || '';
    return (d === 'Civil' || d === 'Criminal' || d === 'Commercial') ? d : null;
  }
  function fillSelect(sel, placeholder, values, disabled) {
    if (!sel) return;
    sel.innerHTML = `<option value="">${placeholder}</option>`;
    (values || []).forEach((v) => { const o = el('option'); o.value = v; o.textContent = v; sel.append(o); });
    if (disabled != null) sel.disabled = disabled;
  }
  function mountPrimarySubcat() {
    const host = $('#subcategory-host');
    if (!host) return;
    host.innerHTML = '';
    const branch = branchOf();
    if (branch) {
      buildGroupedSearchableDropdown(host, 'subcategory', 'Search file subcategory…',
        primarySubcats(branch, representing));
    } else {
      const ph = document.createElement('input');
      ph.type = 'text'; ph.disabled = true; ph.className = 'mc-subcat-placeholder';
      const dom = $('#domain')?.value || '';
      ph.placeholder = dom ? `Subcategory (not used for ${dom})` : 'Subcategory';
      host.appendChild(ph);
    }
  }
  function mountMiscProceeding() {
    const host = $('#misc-proceeding-host');
    if (!host) return;
    host.innerHTML = '';
    const branch = branchOf();
    if (branch) {
      buildGroupedSearchableDropdown(host, 'misc-proceeding',
        'Search misc application / interim relief…', MISC_SUBCATS[branch] || []);
    } else {
      const ph = document.createElement('input');
      ph.type = 'text'; ph.disabled = true; ph.className = 'mc-subcat-placeholder';
      ph.placeholder = 'Misc application (Civil / Criminal / Commercial only)';
      host.appendChild(ph);
    }
  }
  function syncDomainUI() {
    const branch = branchOf();
    // Misc proceedings only apply to Civil/Criminal/Commercial. Keep the tab
    // visible but disabled (faded) for other categories, and fall back to
    // Primary if it was active.
    const miscTab = wrap.querySelector('.mc-proc-tab[data-ptab="misc"]');
    if (miscTab) {
      miscTab.classList.toggle('is-disabled', !branch);
      miscTab.disabled = !branch;
    }
    if (!branch && activePTab() === 'misc') activateProcTab('primary');
    mountPrimarySubcat();
    // Misc = the interlocutory applications for this branch (CPC / CrPC /
    // Commercial Courts Act interim remedies), grouped + searchable, filed
    // WITHIN the chosen subcategory.
    mountMiscProceeding();
    const mt = $('#main-type');
    const dom = $('#domain')?.value || '';
    if (mt) {
      if (dom === 'Case Law') mt.placeholder = 'Case Law title / citation (used as filename)';
      else if (dom === 'Legal Notices') mt.placeholder = 'Notice title / reference (used as filename)';
      else mt.placeholder = 'Main Type (e.g., Writ Petition, Rejoinder)';
    }
    updateProcLock();
  }
  // The Primary/Misc tabs + fields stay locked until a category and (for a
  // branch) a subcategory are chosen — every proceeding is filed within a
  // subcategory.
  function updateProcLock() {
    const dom = $('#domain')?.value || '';
    const branch = branchOf();
    const subcat = $('#subcategory')?.value || '';
    const ready = !!dom && (branch ? !!subcat : true);
    const body = $('#mc-proc-body');
    if (body) body.classList.toggle('is-locked', !ready);
  }
  // A converted <select> lives inside a .ll-dropdown wrapper that takes its
  // grid slot — toggle the wrapper (not the select) to show/hide a field.
  const lldWrap = (id) => document.getElementById(id)?.closest('.ll-dropdown') || document.getElementById(id);
  function activateProcTab(target) {
    const primary = target !== 'misc';
    wrap.querySelectorAll('.mc-proc-tab').forEach((t) => {
      const on = t.dataset.ptab === target;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on));
    });
    // The subcategory now lives ABOVE the tabs, so only the Misc application
    // dropdown is tab-specific (a searchable host div, not an LLD select).
    const mw = $('#misc-proceeding-host');
    if (mw) mw.hidden = primary;
    // Keep Main Type + Date as the final full-width rows in BOTH modes so the
    // grid stays perfectly paired (no orphaned half-cells).
    const mt = $('#main-type');
    if (mt) mt.classList.toggle('full-span', !primary);
  }
  // active proceeding tab (for the upload target)
  function activePTab() {
    const t = wrap.querySelector('.mc-proc-tab.active');
    return t ? t.dataset.ptab : 'primary';
  }

  // static sub-folder options + initial mount
  fillSelect($('#mc-subfolder'), '(no sub-folder — subcategory root)', STANDARD_SUBDIRS);
  syncDomainUI();

  $('#domain')?.addEventListener('change', syncDomainUI);
  wrap.querySelectorAll('.mc-proc-tab').forEach((t) =>
    t.addEventListener('click', () => activateProcTab(t.dataset.ptab)));
  // Subcategory picked (grouped search dropdown, above the tabs) → unlock the
  // Primary/Misc tabs. The change event bubbles from the hidden #subcategory
  // input up to its stable host element.
  $('#subcategory-host')?.addEventListener('change', updateProcLock);

  // Convert all selects to Long-List Dropdowns
  convertAllSelectsToLLD(wrap);
  // Now that the .ll-dropdown wrappers exist, set the initial Primary/Misc
  // field visibility (hides the Misc dropdowns until that tab is chosen).
  activateProcTab('primary');

  // --- File selection / upload -----------------------------------------
  const dz = $('#drop');
  const fileInput = $('#file');
  const fileList  = $('#file-list');
  let selectedFiles = [];

  function renderSelected(){
    if (!fileList) return;
    fileList.innerHTML = '';
    if (!selectedFiles.length){ fileList.textContent = 'No files selected.'; return; }
    selectedFiles.forEach((f, idx) => {
      const row = el('div','result-item');
      const name = el('div'); name.textContent = f.name;
      const meta = el('span','badge'); meta.textContent = `${(f.size/1024).toFixed(1)} KB`;
      const rm = el('button'); rm.type = 'button'; rm.textContent = '✕'; rm.className = 'btn-ghost';
      rm.style.padding = '4px 8px'; rm.style.marginLeft = 'auto';
      rm.addEventListener('click', ()=>{ selectedFiles.splice(idx,1); renderSelected(); });
      row.append(name, meta, rm);
      fileList.append(row);
    });
  }

  function chooseFiles(){ fileInput?.click(); }
  dz?.addEventListener('click', chooseFiles);
  dz?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFiles(); }});
  fileInput?.addEventListener('change', ()=>{ selectedFiles = Array.from(fileInput.files || []); renderSelected(); });
  dz?.addEventListener('dragover', e=>{ e.preventDefault(); dz.classList.add('dragover'); });
  dz?.addEventListener('dragleave', ()=> dz.classList.remove('dragover'));
  dz?.addEventListener('drop', e=>{
    e.preventDefault(); dz.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const key = f => `${f.name}-${f.size}`;
    const have = new Set(selectedFiles.map(key));
    files.forEach(f => { if (!have.has(key(f))) selectedFiles.push(f); });
    renderSelected();
  });

  $('#mc-go')?.addEventListener('click', async ()=>{
    const year  = yearSel.value || '';
    const month = monthSel.value || '';
    const cname = caseSel.value || '';
    if (!year || !month || !cname){ alert('Select Year, Month, and Case.'); return; }
    if (!selectedFiles.length){ alert('Select at least one file'); return; }

    // v4.8: the subcategory (chosen above the tabs) IS the main proceeding.
    // Primary files directly under it; Misc files under an interim-application
    // folder within it.
    //  Primary → Case/<Subcategory>/[<Subfolder>]
    //  Misc    → Case/<Subcategory>/<Misc application>/[<Subfolder>]
    const branch = branchOf();
    const subcategory = branch ? ($('#subcategory')?.value || '') : '';
    let proceeding = '';
    if (branch && !subcategory) { alert('Choose a subcategory (Step 2) first.'); return; }
    if (branch && activePTab() === 'misc') {
      proceeding = $('#misc-proceeding')?.value || '';
      if (!proceeding) { alert('Choose a misc application / interim relief.'); return; }
    }

    const fd = new FormData();
    fd.set('Year', year);
    fd.set('Month', month);
    fd.set('Case Name', cname);
    fd.set('Domain', $('#domain')?.value || '');
    fd.set('Subcategory', subcategory);
    fd.set('Proceeding', proceeding);
    fd.set('Subfolder', $('#mc-subfolder')?.value || '');
    fd.set('Main Type', ($('#main-type')?.value || '').trim());
    fd.set('Date', $('#mc-date')?.value || '');
    selectedFiles.forEach(f => fd.append('file', f));

    const progress = makeProgressBar(fileList);
    let r;
    try {
      // Oversized files go up in slices first; the form then just references
      // them, keeping every request under Cloudflare's 100 MB body limit.
      await offloadLargeFiles(fd, 'file', selectedFiles, (frac) => progress.set(frac * 0.9));
      r = await uploadWithProgress('/manage-case/upload', fd, (frac) => progress.set(0.9 + frac * 0.1));
    } catch (err) {
      progress.done();
      alert('Upload failed: ' + (err.message || err));
      return;
    } finally {
      progress.done();
    }
    let data = r.data;
    if (!data) {
      const compact = (r.text || '').replace(/\s+/g, ' ').trim();
      const fallback = compact ? compact.slice(0, 220) : '';
      data = {
        ok: false,
        msg: fallback || `Upload failed (HTTP ${r.status}).`,
      };
    }
    if (!r.ok && (!data || data.ok)) {
      data = { ok: false, msg: `Upload failed (HTTP ${r.status}).` };
    }
    if (data.ok) {
      const saved = Array.isArray(data.saved_as) ? data.saved_as.join('\n') : data.saved_as;
      alert('Saved:\n' + saved);
      selectedFiles = []; if (fileInput) fileInput.value = ''; renderSelected();
    } else {
      alert('Error: ' + (data.msg || 'Upload failed'));
    }
  });

  renderSelected();
}

function caseLawUploadForm(){
  const host = $('#form-host');
  if (!host) return;
  host.innerHTML = '';

  const wrap = el('div', 'form-card');
  wrap.innerHTML = `
    <h3>Upload Case Law</h3>
    <div class="form-grid">
      <input type="text" id="clu-petitioner" placeholder="Petitioner Name" />
      <input type="text" id="clu-respondent" placeholder="Respondent Name" />

      <select id="clu-court-type"><option value="">Choose Court/Forum</option></select>
      <div id="clu-court-name-container" data-input-id="clu-court-name"></div>

      <div id="clu-year-wrap"></div>
      <div id="clu-case-name-display" class="case-name-display" title="Auto-generated case name"></div>

      <select id="clu-primary"><option value="">Category (Civil / Criminal / Commercial)</option></select>
      <div id="clu-case-type-host"></div>

      <label class="file-field full-span" for="clu-file">
        <input type="file" id="clu-file" class="file-input" accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.json" />
        <span id="clu-file-label">Select judgment file…</span>
        <button type="button" class="btn-secondary file-btn" id="clu-file-btn">Browse</button>
      </label>

      <div class="citations-section full-span">
        <h4>Citations</h4>
        <div class="citations-row-wrapper">
          <div id="clu-citations-list" class="citations-list"></div>
          <button type="button" id="clu-add-citation" class="cite-add-btn" title="Add Citation">+</button>
        </div>
      </div>

      <textarea id="clu-note" class="full-span" rows="4" placeholder="Brief Note / Summary"></textarea>
    </div>
    <div class="form-actions">
      <button id="clu-submit" class="btn-primary" type="button">Upload Case Law</button>
    </div>
  `;
  host.append(wrap);

  // Court type / name wiring
  const courtTypeSel = document.getElementById('clu-court-type');
  const courtNameContainer = document.getElementById('clu-court-name-container');
  // Populate court type options
  COURT_TYPES.forEach(ct => {
    const o = document.createElement('option');
    o.value = ct; o.textContent = ct;
    courtTypeSel.appendChild(o);
  });
  const courtCtrl = wireCourtFields(courtTypeSel, courtNameContainer, null);

  // Citations
  const citList = document.getElementById('clu-citations-list');
  const addCiteBtn = document.getElementById('clu-add-citation');
  addCiteBtn?.addEventListener('click', () => {
    // Pre-fill year from Decision Year dropdown or from an existing citation row
    const y = yearDD?.getValue() || '';
    const existingYear = !y ? (citList.querySelector('.cite-year')?.value || '') : '';
    const prefillYear = y || existingYear;
    createCitationRow(citList, prefillYear ? { year: prefillYear } : null, () => courtCtrl.getCourtAbbrev());
  });
  // Start with one empty row
  createCitationRow(citList, null, () => courtCtrl.getCourtAbbrev());

  const primarySel = $('#clu-primary');

  // Year — long-list dropdown (scrollable, max ~10 visible, no text cursor)
  const yearWrap = document.getElementById('clu-year-wrap');
  const yearOptions = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= 1950; y--) yearOptions.push(String(y));
  const yearDD = buildLongListDropdown(yearWrap, 'clu-year', 'Decision Year', yearOptions);

  // Case name auto-display
  const petInput = document.getElementById('clu-petitioner');
  const resInput = document.getElementById('clu-respondent');
  const caseNameBox = document.getElementById('clu-case-name-display');
  function updateCaseName() {
    const p = petInput?.value.trim() || '';
    const r = resInput?.value.trim() || '';
    if (p || r) {
      caseNameBox.textContent = (p || '___') + ' v. ' + (r || '___');
      caseNameBox.classList.add('has-value');
    } else {
      caseNameBox.textContent = 'Case Name';
      caseNameBox.classList.remove('has-value');
    }
  }
  petInput?.addEventListener('input', updateCaseName);
  resInput?.addEventListener('input', updateCaseName);
  updateCaseName();

  // Bidirectional year sync: Decision Year ↔ Citation years
  yearDD.onChange((y) => {
    if (y) {
      citList.querySelectorAll('.cite-year').forEach(inp => {
        if (!inp.value) inp.value = y;
      });
    }
  });
  citList.addEventListener('change', (e) => {
    if (e.target.classList.contains('cite-year') && !yearDD.getValue()) {
      const v = e.target.value.trim();
      if (v && /^\d{4}$/.test(v)) yearDD.setValue(v);
    }
  });

  if (primarySel) {
    // Category list from the same taxonomy the rest of the app uses.
    populateOptions(primarySel, Object.keys(FILE_SUBCATS), 'Category (Civil / Criminal / Commercial)');
  }

  // Case Law subcategory now uses the full grouped taxonomy (FILE_SUBCATS),
  // searchable — the same system as Manage Case, not the old flat CASE_TYPES.
  const cluCaseTypeHost = $('#clu-case-type-host');
  function mountCluCaseType(branch) {
    if (!cluCaseTypeHost) return;
    cluCaseTypeHost.innerHTML = '';
    if (branch && FILE_SUBCATS[branch]) {
      buildGroupedSearchableDropdown(cluCaseTypeHost, 'clu-case-type',
        'Search subcategory…', FILE_SUBCATS[branch]);
    } else {
      const ph = document.createElement('input');
      ph.type = 'text'; ph.disabled = true; ph.className = 'mc-subcat-placeholder';
      ph.placeholder = 'Subcategory — choose a category first';
      cluCaseTypeHost.appendChild(ph);
    }
  }
  mountCluCaseType('');
  primarySel?.addEventListener('change', () => mountCluCaseType(primarySel.value || ''));

  // Convert all selects to Long-List Dropdowns
  convertAllSelectsToLLD(wrap);

  const fileInput = document.getElementById('clu-file');
  const fileLabel = document.getElementById('clu-file-label');
  const fileBtn = document.getElementById('clu-file-btn');
  const fileField = wrap.querySelector('.file-field');
  if (fileBtn && fileInput) {
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileLabel.textContent = file ? file.name : 'Select judgment file…';
    });
  }

  if (fileField && fileInput) {
    const setFile = (file) => {
      if (!file) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileLabel.textContent = file.name;
    };

    ['dragenter','dragover'].forEach(evt => {
      fileField.addEventListener(evt, (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        fileField.classList.add('dragover');
      });
    });

    ['dragleave','dragend'].forEach(evt => {
      fileField.addEventListener(evt, () => {
        fileField.classList.remove('dragover');
      });
    });

    fileField.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        setFile(files[0]);
      }
      fileField.classList.remove('dragover');
    });
  }

  const submitBtn = $('#clu-submit');
  submitBtn?.addEventListener('click', async () => {
    const petitioner = ($('#clu-petitioner')?.value || '').trim();
    const respondent = ($('#clu-respondent')?.value || '').trim();
    const courtType = courtCtrl.getCourtType();
    const courtName = courtCtrl.getCourtName();
    const year = ($('#clu-year')?.value || '').trim();
    const primary = ($('#clu-primary')?.value || '').trim();
    const caseType = ($('#clu-case-type')?.value || '').trim();
    const note = ($('#clu-note')?.value || '').trim();
    const file = fileInput?.files?.[0];

    if (!petitioner || !respondent) { alert('Petitioner and Respondent are required.'); return; }
    if (!courtType) { alert('Select a court/forum.'); return; }
    if (!courtName) { alert('Select the court name.'); return; }
    const citations = collectCitations(citList);
    if (!citations.length) { alert('Add at least one citation.'); return; }
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      if (!c.journal) { alert(`Citation ${i+1}: select a journal.`); return; }
      if (!c.year) { alert(`Citation ${i+1}: enter a year.`); return; }
      if (!c.page) { alert(`Citation ${i+1}: enter a page/entry number.`); return; }
    }
    if (!year) { alert('Decision year is required.'); return; }
    if (!primary) { alert('Select a primary classification.'); return; }
    if (!caseType) { alert('Select a case type.'); return; }
    if (!note) { alert('Please provide a brief note.'); return; }
    if (!file) { alert('Select a judgment file to upload.'); return; }

    const fd = new FormData();
    fd.set('petitioner', petitioner);
    fd.set('respondent', respondent);
    fd.set('court_type', courtType);
    fd.set('court_name', courtName);
    fd.set('citations_json', JSON.stringify(citations));
    fd.set('decision_year', year);
    fd.set('primary_type', primary);
    fd.set('case_type', caseType);
    fd.set('note', note);
    fd.append('file', file);

    const progress = makeProgressBar(fileLabel?.parentElement);
    try {
      const resp = await uploadWithProgress('/case-law/upload', fd, (frac) => progress.set(frac));
      const data = resp.data || {};
      if (!resp.ok || !data.ok) {
        throw new Error(data.msg || `HTTP ${resp.status}`);
      }
      alert('Case law uploaded successfully.');
      ['clu-petitioner','clu-respondent','clu-note'].forEach(id => {
        const elField = document.getElementById(id);
        if (elField) elField.value = '';
      });
      updateCaseName();
      if (primarySel) primarySel.selectedIndex = 0;
      mountCluCaseType('');
      yearDD.reset();
      if (courtTypeSel) courtTypeSel.selectedIndex = 0;
      courtCtrl.setValues('', '');
      citList.innerHTML = '';
      createCitationRow(citList, null, () => courtCtrl.getCourtAbbrev());
      if (fileInput) {
        fileInput.value = '';
        fileLabel.textContent = 'Select judgment file…';
      }
    } catch (err) {
      alert(`Upload failed: ${err.message || err}`);
    } finally {
      progress.done();
    }
  });
}

function caseLawSearchForm(){
  const host = $('#form-host');
  if (!host) return;
  host.innerHTML = '';

  const wrap = el('div', 'form-card');
  wrap.innerHTML = `
    <div class="cls-mode-header">
      <h3>Search Case Law</h3>
      <div class="cls-mode-tabs" role="tablist" aria-label="Case law search mode">
        <button type="button" class="cls-mode-tab active" data-mode="name" role="tab" aria-selected="true">Name</button>
        <button type="button" class="cls-mode-tab" data-mode="citation" role="tab" aria-selected="false">Citation</button>
        <button type="button" class="cls-mode-tab" data-mode="type" role="tab" aria-selected="false">Type</button>
        <button type="button" class="cls-mode-tab" data-mode="advanced" role="tab" aria-selected="false">Advanced</button>
      </div>
    </div>
    <input type="radio" name="cls-mode" value="name" checked hidden>
    <input type="radio" name="cls-mode" value="citation" hidden>
    <input type="radio" name="cls-mode" value="type" hidden>
    <input type="radio" name="cls-mode" value="advanced" hidden>
    <div class="form-grid cls-form">
      <div class="cls-mode-panel full-span" data-mode="name">
        <div class="cl-name-row">
          <label class="cl-name-option">
            <input type="radio" name="cls-name-mode" value="petitioner" data-target="cls-name-petitioner" checked>
            <span>Petitioner</span>
            <input type="text" id="cls-name-petitioner" class="cl-name-input" placeholder="Petitioner Name" />
          </label>
          <label class="cl-name-option">
            <input type="radio" name="cls-name-mode" value="respondent" data-target="cls-name-respondent">
            <span>Respondent</span>
            <input type="text" id="cls-name-respondent" class="cl-name-input" placeholder="Respondent Name" disabled />
          </label>
          <label class="cl-name-option">
            <input type="radio" name="cls-name-mode" value="either" data-target="cls-name-either">
            <span>Either Party</span>
            <input type="text" id="cls-name-either" class="cl-name-input" placeholder="Either Party Name" disabled />
          </label>
        </div>
      </div>
      <div class="cls-mode-panel full-span" data-mode="citation" hidden>
        <div class="cls-cite-row">
          <select id="cls-cite-journal"><option value="">Journal</option></select>
          <input type="text" inputmode="numeric" id="cls-cite-year" placeholder="Year" maxlength="4" />
          <input type="text" inputmode="numeric" id="cls-cite-volume" placeholder="Volume" />
          <input type="text" inputmode="numeric" id="cls-cite-page" placeholder="Page / Entry No." />
        </div>
      </div>
      <div class="cls-mode-panel full-span" data-mode="type" hidden>
        <div class="cls-type-row">
          <select id="cls-primary"><option value="">Category (Civil / Criminal / Commercial)</option></select>
          <div id="cls-case-type-host"></div>
        </div>
      </div>
      <div class="cls-mode-panel full-span" data-mode="advanced" hidden>
        <textarea id="cls-text" rows="3" placeholder="Enter boolean query, e.g. bail AND 498A NOT dowry or maintenance NEAR/5 interim"></textarea>
        <p class="form-help">Boolean operators (AND/OR/NOT) and proximity syntax (term NEAR/5 term) are supported.</p>
      </div>
    </div>
    <div class="form-actions form-actions-right">
      <button id="cls-search" class="btn-primary" type="button">Search</button>
      <button id="cls-reset" class="btn-ghost" type="button">Reset</button>
    </div>
    <div id="cls-results" class="results"></div>
  `;
  host.append(wrap);

  const resultsHost = $('#cls-results');
  const modeRadios = Array.from(document.querySelectorAll('input[name="cls-mode"]'));
  const modeTabs = Array.from(document.querySelectorAll('.cls-mode-tab'));
  const panels = Array.from(document.querySelectorAll('.cls-mode-panel'));

  const nameModeRadios = Array.from(document.querySelectorAll('input[name="cls-name-mode"]'));
  const citeJournalSel = $('#cls-cite-journal');
  const citeYearInp = $('#cls-cite-year');
  const citeVolumeInp = $('#cls-cite-volume');
  const citePageInp = $('#cls-cite-page');
  if (citeYearInp) integerOnly(citeYearInp);
  if (citeVolumeInp) integerOnly(citeVolumeInp);
  if (citePageInp) integerOnly(citePageInp);
  const primarySel = $('#cls-primary');
  const textInput = $('#cls-text');
  // Case Law search subcategory uses the full grouped taxonomy (FILE_SUBCATS),
  // searchable — same as Manage Case, not the old flat CASE_TYPES.
  const clsCaseTypeHost = $('#cls-case-type-host');
  function mountClsCaseType(branch) {
    if (!clsCaseTypeHost) return;
    clsCaseTypeHost.innerHTML = '';
    if (branch && FILE_SUBCATS[branch]) {
      buildGroupedSearchableDropdown(clsCaseTypeHost, 'cls-case-type',
        'Search subcategory…', FILE_SUBCATS[branch]);
    } else {
      const ph = document.createElement('input');
      ph.type = 'text'; ph.disabled = true; ph.className = 'mc-subcat-placeholder';
      ph.placeholder = 'Subcategory — choose a category first';
      clsCaseTypeHost.appendChild(ph);
    }
  }
  const nameTextInputs = nameModeRadios.map(radio => {
    const targetId = radio.dataset.target;
    return targetId ? document.getElementById(targetId) : null;
  });

  // Populate citation journal dropdown
  if (citeJournalSel) {
    CITATION_JOURNALS.forEach(j => {
      const o = document.createElement('option');
      o.value = j; o.textContent = j;
      citeJournalSel.appendChild(o);
    });
    // Toggle volume field based on journal
    citeJournalSel.addEventListener('change', () => {
      const cfg = JOURNAL_CONFIG[citeJournalSel.value];
      if (citeVolumeInp) {
        citeVolumeInp.disabled = !(cfg && cfg.hasVolume);
        if (!cfg || !cfg.hasVolume) citeVolumeInp.value = '';
      }
    });
  }

  if (primarySel) populateOptions(primarySel, Object.keys(FILE_SUBCATS), 'Category (Civil / Criminal / Commercial)');
  mountClsCaseType('');

  // Convert all selects to Long-List Dropdowns
  convertAllSelectsToLLD(wrap);

  if (resultsHost) {
    resultsHost.innerHTML = '<div class="result-item">Use the search tools above to view results.</div>';
  }

  function showPanel(mode){
    panels.forEach(panel => {
      panel.hidden = panel.dataset.mode !== mode;
    });
  }

  function updateNameInputs(){
    let activeInput = null;
    nameModeRadios.forEach(radio => {
      const targetId = radio.dataset.target;
      const input = targetId ? document.getElementById(targetId) : null;
      if (!input) return;
      if (radio.checked) {
        input.disabled = false;
        activeInput = input;
      } else {
        input.disabled = true;
      }
    });
    if (activeInput) activeInput.focus();
  }

  updateNameInputs();

  nameModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (document.querySelector('input[name="cls-mode"]:checked')?.value === 'name') {
        updateNameInputs();
      }
    });
  });

  function activateMode(mode){
    modeTabs.forEach(tab => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    modeRadios.forEach(radio => {
      radio.checked = radio.value === mode;
    });
    showPanel(mode);
    if (mode === 'advanced') {
      textInput?.focus();
    }
    if (mode === 'name') {
      updateNameInputs();
    }
    if (mode === 'type') {
      if (primarySel && primarySel.childElementCount === 0) {
        populateOptions(primarySel, Object.keys(FILE_SUBCATS), 'Category (Civil / Criminal / Commercial)');
      }
    }
    if (mode !== 'name') {
      nameModeRadios.forEach(r => {
        const targetId = r.dataset.target;
        const input = targetId ? document.getElementById(targetId) : null;
        if (input) input.disabled = true;
      });
    }
  }

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      if (mode) activateMode(mode);
    });
  });

  modeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) activateMode(radio.value);
    });
  });

  activateMode('name');

  primarySel?.addEventListener('change', () => mountClsCaseType(primarySel.value || ''));

  function applyFilters(filters){
    // No year dropdown to populate anymore; filters kept for future use
  }

  function renderResults(list){
    if (!resultsHost) return;
    resultsHost.innerHTML = '';
    if (!Array.isArray(list) || !list.length) {
      resultsHost.innerHTML = '<div class="result-item">No case law found.</div>';
      return;
    }

    list.forEach(item => {
      const card = el('div', 'result-item case-law-card');
      const citDisplay = item.citation_display || item.citation || '';
      const title = `${item.petitioner} vs ${item.respondent}` + (citDisplay ? ` [${citDisplay}]` : '');
      const metaParts = [item.court_name, item.primary_type, item.case_type, item.decision_year].filter(Boolean);
      const meta = metaParts.join(' \u00B7 ');
      const notePreview = item.note_preview || 'No note saved yet.';
      const notePreviewHtml = renderMarkdownOrFallback(notePreview, 'No note saved yet.');
      const textPreview = (item.text_preview || '').trim();

      const head = el('div', 'cl-card-head');
      const headMain = el('div', 'cl-card-head-main');
      const titleEl = el('div', 'cl-card-title');
      titleEl.textContent = title;
      const metaEl = el('div', 'cl-card-meta');
      metaEl.textContent = meta;
      headMain.append(titleEl, metaEl);
      head.append(headMain);

      let deleteBtn = null;
      if (CASEORG_IS_ADMIN) {
        deleteBtn = el('button', 'cl-delete-btn');
        deleteBtn.type = 'button';
        deleteBtn.textContent = '✕';
        deleteBtn.setAttribute('title', 'Delete case law entry');
        deleteBtn.setAttribute('aria-label', 'Delete case law entry');
        head.append(deleteBtn);
      }

      const body = el('div', 'cl-card-body');
      const snippetHtml = textPreview ? `<div class="cl-snippet">${escapeHtml(textPreview)}</div>` : '';
      body.innerHTML = `
        ${snippetHtml}
        <div class="cl-note-preview cl-muted note-markdown">${notePreviewHtml}</div>
      `;

      const actionsRow = el('div', 'cl-card-actions');
      const downloadLink = document.createElement('a');
      downloadLink.className = 'btn-secondary cl-download';
      downloadLink.href = item.download_url;
      downloadLink.target = '_blank';
      downloadLink.rel = 'noopener';
      downloadLink.textContent = 'Download Judgment';

      const noteBtn = el('button', 'btn-primary cl-note');
      noteBtn.type = 'button';
      noteBtn.textContent = 'View / Edit Note';

      actionsRow.append(downloadLink, noteBtn);

      card.append(head, body, actionsRow);

      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const confirmMessage = `Delete "${title}"? This will remove the stored files and note.`;
          const ok = await openConfirm(confirmMessage);
          if (!ok) return;

          try {
            const resp = await fetch(`/case-law/${item.id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': _csrfToken() } });
            const data = await resp.json().catch(()=>({}));
            if (!resp.ok || !data.ok) {
              throw new Error(data.msg || `HTTP ${resp.status}`);
            }
            card.remove();
            if (resultsHost && !resultsHost.querySelector('.case-law-card')) {
              resultsHost.innerHTML = '<div class="result-item">No case law found.</div>';
            }
          } catch (err) {
            alert(`Delete failed: ${err.message || err}`);
          }
        });
      }

      const previewEl = body.querySelector('.cl-note-preview');
      noteBtn?.addEventListener('click', async () => {
        try {
          const resp = await fetch(`/case-law/${item.id}/note`);
          const data = await resp.json().catch(()=>({}));
          if (!resp.ok || !data.ok) {
            throw new Error(data.msg || `HTTP ${resp.status}`);
          }
          const context = {
            kind: 'case-law',
            id: item.id,
            onSaved: (summary) => {
              if (previewEl) {
                previewEl.innerHTML = renderMarkdownOrFallback(summary || '', 'No note saved yet.');
              }
              // Refresh card title/meta from DB after edit
              fetch(`/case-law/${item.id}/detail`).then(r => r.json()).then(d => {
                if (d.ok && d.case) {
                  const c = d.case;
                  const citD = c.citation_display || c.citation || '';
                  titleEl.textContent = `${c.petitioner} vs ${c.respondent}` + (citD ? ` [${citD}]` : '');
                  const mp = [c.court_name, c.primary_type, c.case_type, c.decision_year].filter(Boolean);
                  metaEl.textContent = mp.join(' \u00B7 ');
                }
              }).catch(() => {});
            }
          };
          openNotesModal(data.content || '', data.content ? 'update' : 'create', context);
        } catch (err) {
          alert(`Unable to load note: ${err.message || err}`);
        }
      });

      resultsHost.append(card);
    });
  }

  function currentMode(){
    return document.querySelector('input[name="cls-mode"]:checked')?.value || 'name';
  }

  async function performSearch(){
    const mode = currentMode();
    const params = new URLSearchParams();

    if (mode === 'name') {
      const selectedRadio = document.querySelector('input[name="cls-name-mode"]:checked');
      const targetId = selectedRadio?.dataset.target;
      const input = targetId ? document.getElementById(targetId) : null;
      const party = input?.value.trim();
      if (!party) { alert('Enter a party name to search.'); return; }
      const modeSel = selectedRadio?.value || 'either';
      params.set('party', party);
      params.set('party_mode', modeSel);
    } else if (mode === 'citation') {
      const journal = citeJournalSel?.value || '';
      const year = citeYearInp?.value.trim() || '';
      const volume = citeVolumeInp?.value.trim() || '';
      const page = citePageInp?.value.trim() || '';
      if (!journal && !year && !page) { alert('Enter at least a journal, year, or page number.'); return; }
      if (journal) params.set('cite_journal', journal);
      if (year) params.set('cite_year', year);
      if (volume) params.set('cite_volume', volume);
      if (page) params.set('cite_page', page);
    } else if (mode === 'type') {
      const primary = primarySel?.value.trim();
      const caseType = ($('#cls-case-type')?.value || '').trim();
      if (!primary) { alert('Choose a category.'); return; }
      params.set('primary_type', primary);
      if (caseType) params.set('case_type', caseType);
    } else if (mode === 'advanced') {
      const text = textInput?.value.trim();
      if (!text) { alert('Enter a query for advanced search.'); return; }
      params.set('text', text);
    }

    params.set('limit', '200');

    try {
      const resp = await fetch(`/case-law/search?${params.toString()}`);
      const data = await resp.json().catch(()=>({}));
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      renderResults(data.results || []);
      if (data.filters) {
        applyFilters(data.filters);
      }
    } catch (err) {
      alert(`Search failed: ${err.message || err}`);
    }
  }

  $('#cls-search')?.addEventListener('click', performSearch);
  textInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      performSearch();
    }
  });

  $('#cls-reset')?.addEventListener('click', () => {
    activateMode(modeRadios[0]?.value || 'name');
    nameModeRadios.forEach((radio, idx) => { radio.checked = idx === 0; });
    nameTextInputs.forEach((input, idx) => {
      if (!input) return;
      input.value = '';
      input.disabled = idx !== 0;
    });
    updateNameInputs();
    if (citeJournalSel) citeJournalSel.selectedIndex = 0;
    if (citeYearInp) citeYearInp.value = '';
    if (citeVolumeInp) { citeVolumeInp.value = ''; citeVolumeInp.disabled = false; }
    if (citePageInp) citePageInp.value = '';
    if (textInput) textInput.value = '';
    if (primarySel) primarySel.selectedIndex = 0;
    mountClsCaseType('');
    if (resultsHost) {
      resultsHost.innerHTML = '<div class="result-item">Use the search tools above to view results.</div>';
    }
  });

  async function loadFilters(){
    try {
      const resp = await fetch('/case-law/search?limit=1');
      const data = await resp.json().catch(()=>({}));
      if (data.filters) {
        applyFilters(data.filters);
      }
    } catch (err) {
      console.warn('Failed to load case-law filters', err);
    }
  }

  loadFilters();
}

// -------------------- Notes modal global handlers --------------------
function bindGlobalNotesModalHandlers(){
  const modal   = document.getElementById('notesModal');
  const modalContent = modal?.querySelector('.modal-content');
  const editor  = document.getElementById('notesEditor');
  const viewer  = document.getElementById('notesDisplay');
  let caseForm = null;
  let caseLawForm = null;
  let casePartySel = null;
  let caseCatSel = null;
  let caseSubcatSel = null;
  let caseTypeSel = null;
  let caseTypeOther = null;
  let caseTypeOtherField = null;
  let caseLawPrimarySel = null;
  let caseLawTypeSel = null;
  const saveBtn = document.getElementById('saveNotesBtn');
  const cancel  = document.getElementById('cancelNotesBtn');
  const close   = document.getElementById('notesClose');
  const editBtn = document.getElementById('editNotesBtn');
  const title   = document.getElementById('notesTitle');
  const MIN_NOTE_TEXTAREA_HEIGHT = 90;
  let activeLeftResize = null;

  if (!modal || !editor || !saveBtn || !cancel || !close || !editBtn) return;

  function onLeftResizePointerMove(e){
    if (!activeLeftResize) return;
    e.preventDefault();
    const nextHeight = Math.max(
      MIN_NOTE_TEXTAREA_HEIGHT,
      Math.round(activeLeftResize.startHeight + (e.clientY - activeLeftResize.startY))
    );
    activeLeftResize.textarea.style.height = `${nextHeight}px`;
  }

  function stopLeftResize(){
    if (!activeLeftResize) return;
    const { handle, pointerId } = activeLeftResize;
    handle.classList.remove('is-resizing');
    if (typeof handle.releasePointerCapture === 'function' && pointerId !== undefined) {
      try { handle.releasePointerCapture(pointerId); } catch (_) {}
    }
    activeLeftResize = null;
    window.removeEventListener('pointermove', onLeftResizePointerMove);
    window.removeEventListener('pointerup', stopLeftResize);
    window.removeEventListener('pointercancel', stopLeftResize);
  }

  function startLeftResize(e){
    const handle = e.target.closest('[data-resize-left]');
    if (!handle || !modal.contains(handle)) return;
    const wrap = handle.closest('.note-wide-wrap');
    const textarea = wrap?.querySelector('textarea.note-wide');
    if (!textarea) return;
    e.preventDefault();
    stopLeftResize();
    activeLeftResize = {
      handle,
      textarea,
      startY: e.clientY,
      startHeight: textarea.getBoundingClientRect().height,
      pointerId: e.pointerId,
    };
    handle.classList.add('is-resizing');
    if (typeof handle.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    }
    window.addEventListener('pointermove', onLeftResizePointerMove);
    window.addEventListener('pointerup', stopLeftResize);
    window.addEventListener('pointercancel', stopLeftResize);
  }

  modal.addEventListener('pointerdown', startLeftResize);

  function refreshNotesFormRefs(){
    caseForm = document.getElementById('notesCaseForm');
    caseLawForm = document.getElementById('notesCaseLawForm');
    casePartySel = document.getElementById('note-case-party');
    caseCatSel = document.getElementById('note-case-category');
    caseSubcatSel = document.getElementById('note-case-subcategory');
    caseTypeSel = document.getElementById('note-case-type');
    caseTypeOther = document.getElementById('note-case-type-other');
    caseTypeOtherField = caseTypeOther?.closest('.note-type-other') || null;
    caseLawPrimarySel = document.getElementById('note-cl-primary');
    caseLawTypeSel = document.getElementById('note-cl-type');

    [caseForm, caseLawForm].forEach((form) => {
      if (!form || form.dataset.noSubmit === '1') return;
      form.dataset.noSubmit = '1';
      form.addEventListener('submit', (e) => e.preventDefault());
    });
  }

  function ensureNotesFormMounted(kind){
    const mount = document.getElementById('notesFormsMount');
    if (!mount) return;

    if (kind === 'case-law') {
      if (document.getElementById('notesCaseLawForm')) return;
      const tpl = document.getElementById('notesCaseLawFormTemplate');
      if (tpl && tpl.content) {
        mount.appendChild(tpl.content.cloneNode(true));
        const form = document.getElementById('notesCaseLawForm');
        if (form) convertAllSelectsToLLD(form);
      }
    } else {
      if (document.getElementById('notesCaseForm')) return;
      const tpl = document.getElementById('notesCaseFormTemplate');
      if (tpl && tpl.content) {
        mount.appendChild(tpl.content.cloneNode(true));
        const form = document.getElementById('notesCaseForm');
        if (form) {
          convertAllSelectsToLLD(form);
          wireCaseNoteParties(form);
        }
      }
    }
  }

  /** Sync the hidden "We're Representing" value from the Create-Case style tabs. */
  function setNoteParty(value){
    const hidden = document.getElementById('note-case-party');
    if (hidden) hidden.value = value || '';
    document.querySelectorAll('#notesCaseForm .op-tab').forEach((tab) => {
      const on = tab.dataset.value === value;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    });
  }

  /** Live "Case Name (auto)" preview — mirrors Create Case, and is what the case
   *  folder gets renamed to on save. */
  function noteDerivedCaseName(){
    const pn = (document.getElementById('note-case-pn')?.value || '').trim();
    const rn = (document.getElementById('note-case-rn')?.value || '').trim();
    return (pn && rn) ? `${pn} v. ${rn}` : '';
  }

  function refreshNoteCaseNamePreview(){
    const preview = document.getElementById('note-case-name-preview');
    if (preview) preview.value = noteDerivedCaseName();
  }

  function wireCaseNoteParties(form){
    form.querySelectorAll('.op-tab').forEach((tab) => {
      tab.addEventListener('click', () => setNoteParty(tab.dataset.value));
    });
    ['note-case-pn', 'note-case-rn'].forEach((id) => {
      form.querySelector('#' + id)?.addEventListener('input', refreshNoteCaseNamePreview);
    });
  }

  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  };
  const setVal = (id, value = '') => {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  };

  function safeParseJson(raw){
    if (!raw || !String(raw).trim()) return {};
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  const formatValue = (value) => escapeHtml(String(value || '—')).replace(/\r\n|\n|\r/g, '<br>');
  const formatMarkdownValue = (value, fallback = '—') => renderMarkdownOrFallback(value, fallback);

  function currentKind(){
    return noteContext && noteContext.kind === 'case-law' ? 'case-law' : 'case';
  }

  const CASE_NOTE_CATEGORIES = ['Criminal','Civil','Commercial'];

  function showCaseTypeOther(show){
    if (!caseTypeOtherField) return;
    caseTypeOtherField.classList.toggle('is-hidden', !show);
  }

  function setCaseCategoryOptions(selected){
    if (!caseCatSel) return;
    populateOptions(caseCatSel, CASE_NOTE_CATEGORIES, 'Case Category');
    caseCatSel.value = CASE_NOTE_CATEGORIES.includes(selected) ? selected : '';
  }

  // Mount a unified Supreme Court + High Court searchable dropdown (with free-text
  // fallback) into a host, caching the instance so re-opens just update the value.
  function mountNoteCourtDD(hostId, hiddenId, placeholder, value){
    const host = document.getElementById(hostId);
    if (!host) return;
    if (!host._courtDD) {
      host.innerHTML = '';
      host._courtDD = buildSearchableDropdown(hiddenId + '-input', hiddenId, placeholder,
        { includeSupremeCourt: true, allowFreeText: true });
      host.appendChild(host._courtDD.wrapper);
    }
    host._courtDD.setVal(value || '');
  }

  // Current Forum/Place — reveal only the fields the chosen status needs.
  function renderNoteCurrentExtra(status, data){
    const host = document.getElementById('note-case-current-extra');
    if (!host) return;
    host.innerHTML = '';
    // "Same as Original" → no extra fields. Transferred / To be transferred /
    // In Appeal all take State + District + a free-text Court/Forum (an appeal
    // may go to a District/Sessions Court, not just a High Court).
    if (status === 'Same as Original') return;
    const forumPh = {
      'Transferred': 'Current Court / Forum — search or type any court',
      'To be transferred': 'Proposed transferee Court / Forum (if known) — type any court',
      'In Appeal': 'Appellate Court / Forum — High Court, District/Sessions Court, or type any court',
    }[status] || 'Current Court / Forum';
    host.innerHTML = `
      <div class="note-grid">
        <label class="note-field"><span>State</span><input id="note-case-current-state" type="text" autocomplete="off"></label>
        <label class="note-field"><span>District</span><input id="note-case-current-district" type="text" autocomplete="off"></label>
        <label class="note-field note-field-wide"><span>Court / Forum</span><div id="note-case-current-forum-host"></div></label>
      </div>`;
    setVal('note-case-current-state', data ? data.currentState : '');
    setVal('note-case-current-district', data ? data.currentDistrict : '');
    mountNoteCourtDD('note-case-current-forum-host', 'note-case-current-forum', forumPh, data ? data.currentForum : '');
  }

  function setCaseLawPrimaryOptions(selected){
    if (!caseLawPrimarySel) return;
    populateOptions(caseLawPrimarySel, CASE_NOTE_CATEGORIES, 'Primary Type');
    caseLawPrimarySel.value = CASE_NOTE_CATEGORIES.includes(selected) ? selected : '';
  }

  function setCaseLawTypeOptions(primary, selected){
    if (!caseLawTypeSel) return;
    const groups = FILE_SUBCATS[primary];
    if (primary && groups) {
      // Use the same grouped taxonomy as the rest of the app (flattened for the
      // native/LLD select), not the retired flat CASE_TYPES list.
      const items = Array.from(new Set(
        groups.flatMap((g) => g.items).filter((x) => x && x !== 'Other')));
      populateOptions(caseLawTypeSel, items, 'Case Type');
      caseLawTypeSel.disabled = false;
      caseLawTypeSel.value = (selected && items.includes(selected)) ? selected : '';
    } else {
      caseLawTypeSel.innerHTML = '<option value="">Case Type</option>';
      caseLawTypeSel.disabled = true;
    }
  }

  function normalizeCaseNote(rawObj){
    const obj = (rawObj && typeof rawObj === 'object') ? rawObj : {};
    const origin = obj['Court of Origin'] || {};
    const current = obj['Current Court/Forum'] || {};
    const cState = current['State'] || '';
    const cDistrict = current['District'] || '';
    const cForum = current['Court/Forum'] || '';
    let currentStatus = obj['Current Status'] || '';
    if (!currentStatus) {
      // Back-compat: derive a status from a legacy note's current-court values.
      if (cState || cDistrict) currentStatus = 'Transferred';
      else if (cForum) currentStatus = 'In Appeal';
      else currentStatus = 'Same as Original';
    }
    return {
      petitionerName: obj['Petitioner Name'] || '',
      petitionerAddress: obj['Petitioner Address'] || '',
      petitionerContact: obj['Petitioner Contact'] || '',
      respondentName: obj['Respondent Name'] || '',
      respondentAddress: obj['Respondent Address'] || '',
      respondentContact: obj['Respondent Contact'] || '',
      ourParty: obj['Our Party'] || '',
      caseCategory: obj['Case Category'] || '',
      originState: origin['State'] || '',
      originDistrict: origin['District'] || '',
      originForum: origin['Court/Forum'] || '',
      currentStatus,
      currentState: cState,
      currentDistrict: cDistrict,
      currentForum: cForum,
      additionalNotes: obj['Additional Notes'] || '',
    };
  }

  function normalizeCaseLawNote(rawObj){
    const obj = (rawObj && typeof rawObj === 'object') ? rawObj : {};
    return {
      petitioner: obj['Petitioner'] || '',
      respondent: obj['Respondent'] || '',
      courtType: obj['Court Type'] || '',
      courtName: obj['Court Name'] || '',
      citation: obj['Citation'] || '',
      citations: obj['Citations'] || [],
      decisionYear: obj['Decision Year'] || '',
      primaryType: obj['Primary Type'] || '',
      caseType: obj['Case Type'] || obj['Subtype'] || '',
      note: obj['Note'] || obj['Brief'] || '',
      savedAt: obj['Saved At'] || '',
    };
  }

  function renderCaseNoteView(data){
    if (!viewer) return;
    viewer.innerHTML = `
      <div class="note-section">
        <div class="note-heading">Parties</div>
        <div class="note-row"><span class="note-label">Petitioner</span><span class="note-value">${formatValue(data.petitionerName)}</span></div>
        <div class="note-row"><span class="note-label">Petitioner Address</span><span class="note-value">${formatValue(data.petitionerAddress)}</span></div>
        <div class="note-row"><span class="note-label">Petitioner Contact</span><span class="note-value">${formatValue(data.petitionerContact)}</span></div>
        <div class="note-row"><span class="note-label">Respondent</span><span class="note-value">${formatValue(data.respondentName)}</span></div>
        <div class="note-row"><span class="note-label">Respondent Address</span><span class="note-value">${formatValue(data.respondentAddress)}</span></div>
        <div class="note-row"><span class="note-label">Respondent Contact</span><span class="note-value">${formatValue(data.respondentContact)}</span></div>
        <div class="note-row"><span class="note-label">We’re Representing</span><span class="note-value">${formatValue(data.ourParty)}</span></div>
      </div>
      <div class="note-section">
        <div class="note-heading">Classification</div>
        <div class="note-row"><span class="note-label">Case Category</span><span class="note-value">${formatValue(data.caseCategory)}</span></div>
      </div>
      <div class="note-section">
        <div class="note-heading">Original Court</div>
        <div class="note-row"><span class="note-label">State</span><span class="note-value">${formatValue(data.originState)}</span></div>
        <div class="note-row"><span class="note-label">District</span><span class="note-value">${formatValue(data.originDistrict)}</span></div>
        <div class="note-row"><span class="note-label">Court / Forum</span><span class="note-value">${formatValue(data.originForum)}</span></div>
      </div>
      <div class="note-section">
        <div class="note-heading">Current Forum / Place</div>
        <div class="note-row"><span class="note-label">Status</span><span class="note-value">${formatValue(data.currentStatus)}</span></div>
        ${data.currentStatus === 'Transferred' ? `
        <div class="note-row"><span class="note-label">State</span><span class="note-value">${formatValue(data.currentState)}</span></div>
        <div class="note-row"><span class="note-label">District</span><span class="note-value">${formatValue(data.currentDistrict)}</span></div>
        <div class="note-row"><span class="note-label">Court / Forum</span><span class="note-value">${formatValue(data.currentForum)}</span></div>` : ''}
        ${data.currentStatus === 'In Appeal' ? `
        <div class="note-row"><span class="note-label">Court / Forum</span><span class="note-value">${formatValue(data.currentForum)}</span></div>` : ''}
      </div>
      <div class="note-section note-additional">
        <div class="note-row"><div class="note-value note-wide note-markdown">${formatMarkdownValue(data.additionalNotes || '', '—')}</div></div>
      </div>
    `;
  }

  function renderCaseLawNoteView(data){
    if (!viewer) return;
    const saved = data.savedAt ? `<div class="note-row small"><span class="note-label">Saved</span><span class="note-value">${formatValue(data.savedAt)}</span></div>` : '';

    // Court display
    let courtHtml = '';
    if (data.courtType || data.courtName) {
      const courtStr = [data.courtType, data.courtName].filter(Boolean).join(' \u2014 ');
      courtHtml = `<div class="note-row"><span class="note-label">Court / Forum</span><span class="note-value">${formatValue(courtStr)}</span></div>`;
    }

    // Citations display
    let citationsHtml = '';
    if (data.citations && data.citations.length) {
      citationsHtml = data.citations.map(c => {
        const display = c.Display || c.display || '';
        return `<div class="note-row"><span class="note-label">Citation</span><span class="note-value">${formatValue(display)}</span></div>`;
      }).join('');
    } else if (data.citation) {
      citationsHtml = `<div class="note-row"><span class="note-label">Citation</span><span class="note-value">${formatValue(data.citation)}</span></div>`;
    }

    viewer.innerHTML = `
      <div class="note-section">
        <div class="note-heading">Brief</div>
        <div class="note-row"><span class="note-label">Petitioner</span><span class="note-value">${formatValue(data.petitioner)}</span></div>
        <div class="note-row"><span class="note-label">Respondent</span><span class="note-value">${formatValue(data.respondent)}</span></div>
        ${courtHtml}
        ${citationsHtml}
        <div class="note-row"><span class="note-label">Decision Year</span><span class="note-value">${formatValue(data.decisionYear)}</span></div>
        <div class="note-row"><span class="note-label">Primary Type</span><span class="note-value">${formatValue(data.primaryType)}</span></div>
        <div class="note-row"><span class="note-label">Case Type</span><span class="note-value">${formatValue(data.caseType)}</span></div>
        ${saved}
      </div>
      <div class="note-section note-additional">
        <div class="note-row"><div class="note-value note-wide note-markdown">${formatMarkdownValue(data.note || '', '\u2014')}</div></div>
      </div>
    `;
  }

  function renderFallback(raw){
    if (viewer) {
      viewer.innerHTML = `<pre class="notes-pre">${escapeHtml(raw || 'No note saved yet.')}</pre>`;
    }
  }

  let originalContent = '';
  let rawContent = '';
  let noteContext = null;

  const toggleVisibility = (el, shouldShow) => {
    if (!el) return;
    el.hidden = !shouldShow;
    el.classList.toggle('is-hidden', !shouldShow);
  };

  function updateDirtyState() {
    if (modal.dataset.state !== 'edit') {
      saveBtn.disabled = true;
      return;
    }
    const editingRaw = editor && editor.style.display !== 'none';
    if (editingRaw) {
      saveBtn.disabled = editor.value === originalContent;
    } else {
      saveBtn.disabled = false;
    }
  }

  function hideAllEditors(){
    if (viewer) viewer.hidden = true;
    if (caseForm) { caseForm.hidden = true; caseForm.classList.remove('is-active'); }
    if (caseLawForm) { caseLawForm.hidden = true; caseLawForm.classList.remove('is-active'); }
    if (editor) editor.style.display = 'none';
  }

  function populateForm(kind, parsedObj){
    if (kind === 'case') {
      const data = normalizeCaseNote(parsedObj);
      setVal('note-case-pn', data.petitionerName);
      setVal('note-case-pa', data.petitionerAddress);
      setVal('note-case-pc', data.petitionerContact);
      setVal('note-case-rn', data.respondentName);
      setVal('note-case-ra', data.respondentAddress);
      setVal('note-case-rc', data.respondentContact);
      setNoteParty(data.ourParty || '');
      refreshNoteCaseNamePreview();
      setCaseCategoryOptions(data.caseCategory || '');
      setVal('note-case-origin-state', data.originState);
      setVal('note-case-origin-district', data.originDistrict);
      mountNoteCourtDD('note-case-origin-forum-host', 'note-case-origin-forum', 'Original Court / Forum', data.originForum);
      const cStatusSel = document.getElementById('note-case-current-status');
      const status = data.currentStatus || 'Same as Original';
      if (cStatusSel) cStatusSel.value = status;
      renderNoteCurrentExtra(status, data);
      setVal('note-case-additional', data.additionalNotes);
    } else {
      const data = normalizeCaseLawNote(parsedObj);
      setVal('note-cl-petitioner', data.petitioner);
      setVal('note-cl-respondent', data.respondent);
      setVal('note-cl-year', data.decisionYear);
      setCaseLawPrimaryOptions(data.primaryType || '');
      setCaseLawTypeOptions(data.primaryType || '', data.caseType || '');
      const noteBox = document.getElementById('note-cl-note');
      if (noteBox) noteBox.value = data.note || '';

      // Court / Forum
      const clCourtType = document.getElementById('note-cl-court-type');
      const clCourtContainer = document.getElementById('note-cl-court-name-container');
      if (clCourtType && clCourtContainer) {
        // Populate court type options if not yet done
        if (clCourtType.options.length <= 1) {
          COURT_TYPES.forEach(ct => {
            const o = document.createElement('option');
            o.value = ct; o.textContent = ct;
            clCourtType.appendChild(o);
          });
        }
        if (!clCourtContainer._courtCtrl) {
          clCourtContainer._courtCtrl = wireCourtFields(clCourtType, clCourtContainer, null);
        }
        clCourtContainer._courtCtrl.setValues(data.courtType || '', data.courtName || '');
      }

      // Citations
      const clCitList = document.getElementById('note-cl-citations-list');
      const clLegacy = document.getElementById('note-cl-legacy-citation');
      const clLegacyText = document.getElementById('note-cl-legacy-citation-text');
      const clAddCite = document.getElementById('note-cl-add-citation');

      if (clCitList) {
        clCitList.innerHTML = '';
        const courtGetter = () => {
          if (clCourtContainer?._courtCtrl) return clCourtContainer._courtCtrl.getCourtAbbrev();
          return '';
        };

        if (data.citations && data.citations.length) {
          data.citations.forEach(c => {
            createCitationRow(clCitList, {
              journal: c.Journal || c.journal || '',
              year: c.Year || c.year || '',
              volume: c.Volume || c.volume || '',
              court_abbrev: c['Court Abbreviation'] || c.court_abbrev || '',
              page: c.Page || c.page || '',
            }, courtGetter);
          });
          if (clLegacy) clLegacy.hidden = true;
        } else if (data.citation) {
          if (clLegacy && clLegacyText) {
            clLegacy.hidden = false;
            clLegacyText.textContent = data.citation;
          }
        }

        // Wire add citation button
        if (clAddCite && !clAddCite._wired) {
          clAddCite._wired = true;
          clAddCite.addEventListener('click', () => {
            const y = document.getElementById('note-cl-year')?.value || '';
            const existingYear = !y ? (clCitList.querySelector('.cite-year')?.value || '') : '';
            const prefillYear = y || existingYear;
            createCitationRow(clCitList, prefillYear ? { year: prefillYear } : null, courtGetter);
          });
        }
      }
    }
  }

  function renderView(parsedObj){
    const kind = currentKind();
    if (parsedObj === null) {
      renderFallback(rawContent);
      return;
    }
    if (kind === 'case-law') {
      renderCaseLawNoteView(normalizeCaseLawNote(parsedObj));
    } else {
      renderCaseNoteView(normalizeCaseNote(parsedObj));
    }
  }

  function buildPayloadFromForm(kind){
    const existing = safeParseJson(rawContent) || {};
    if (kind === 'case-law' && caseLawForm && !caseLawForm.hidden) {
      const payload = { ...existing };
      payload['Petitioner'] = getVal('note-cl-petitioner');
      payload['Respondent'] = getVal('note-cl-respondent');

      // Court / Forum
      const clCourtContainer = document.getElementById('note-cl-court-name-container');
      const ctrl = clCourtContainer?._courtCtrl;
      payload['Court Type'] = ctrl ? ctrl.getCourtType() : '';
      payload['Court Name'] = ctrl ? ctrl.getCourtName() : '';

      // Structured citations
      const clCitList = document.getElementById('note-cl-citations-list');
      if (clCitList) {
        const cites = collectCitations(clCitList);
        payload['Citations'] = cites.map(c => ({
          Journal: c.journal, Year: c.year,
          Volume: c.volume || '', 'Court Abbreviation': c.court_abbrev || '',
          Page: c.page,
        }));
      }

      payload['Decision Year'] = getVal('note-cl-year');
      payload['Primary Type'] = getVal('note-cl-primary');
      payload['Case Type'] = getVal('note-cl-type');
      payload['Note'] = document.getElementById('note-cl-note')?.value || '';
      payload['Saved At'] = new Date().toISOString();
      return JSON.stringify(payload, null, 2);
    }
    if (kind === 'case' && caseForm && !caseForm.hidden) {
      const payload = { ...existing };
      payload['Petitioner Name'] = getVal('note-case-pn');
      payload['Petitioner Address'] = getVal('note-case-pa');
      payload['Petitioner Contact'] = getVal('note-case-pc');
      payload['Respondent Name'] = getVal('note-case-rn');
      payload['Respondent Address'] = getVal('note-case-ra');
      payload['Respondent Contact'] = getVal('note-case-rc');
      payload['Our Party'] = casePartySel ? (casePartySel.value || '') : getVal('note-case-party');
      payload['Case Category'] = caseCatSel ? (caseCatSel.value || '') : getVal('note-case-category');
      // Drop the retired classification keys if a legacy note carried them.
      delete payload['Case Subcategory'];
      delete payload['Case Type'];
      payload['Court of Origin'] = {
        'State': getVal('note-case-origin-state'),
        'District': getVal('note-case-origin-district'),
        'Court/Forum': getVal('note-case-origin-forum'),
      };
      const cStatus = document.getElementById('note-case-current-status')?.value || 'Same as Original';
      payload['Current Status'] = cStatus;
      if (cStatus === 'Same as Original') {
        payload['Current Court/Forum'] = { 'State': '', 'District': '', 'Court/Forum': '' };
      } else {
        // Transferred / To be transferred / In Appeal all carry State/District/Forum.
        payload['Current Court/Forum'] = {
          'State': getVal('note-case-current-state'),
          'District': getVal('note-case-current-district'),
          'Court/Forum': getVal('note-case-current-forum'),
        };
      }
      payload['Additional Notes'] = document.getElementById('note-case-additional')?.value || '';
      return JSON.stringify(payload, null, 2);
    }
    return null;
  }

  function setState(state){
    modal.dataset.state = state;
    refreshNotesFormRefs();
    const editing = state === 'edit';
    const parsed = safeParseJson(rawContent);
    hideAllEditors();
    if (modalContent) {
      modalContent.classList.toggle('mode-edit', editing);
      modalContent.classList.toggle('mode-view', !editing);
    }

    if (!editing) {
      if (viewer) viewer.hidden = false;
      renderView(parsed);
      editor.readOnly = true;
      editor.classList.add('notes-readonly');
      toggleVisibility(saveBtn, false);
      toggleVisibility(cancel, false);
      toggleVisibility(editBtn, true);
	    } else {
	      if (viewer) viewer.hidden = true;
	      const kind = currentKind();
	      const canUseForm = parsed !== null;
	      if (canUseForm) {
	        ensureNotesFormMounted(kind);
	        refreshNotesFormRefs();
	      }
      if (canUseForm && kind === 'case-law' && caseLawForm) {
        populateForm('case-law', parsed || {});
        caseLawForm.hidden = false;
        caseLawForm.classList.add('is-active');
        if (!caseLawForm.dataset.wired) {
          caseLawForm.dataset.wired = '1';
          caseLawPrimarySel?.addEventListener('change', () => {
            const primary = caseLawPrimarySel.value || '';
            setCaseLawTypeOptions(primary, '');
          });
        }
      } else if (canUseForm && kind === 'case' && caseForm) {
        populateForm('case', parsed || {});
        caseForm.hidden = false;
        caseForm.classList.add('is-active');
        if (!caseForm.dataset.wired) {
          caseForm.dataset.wired = '1';
          document.getElementById('note-case-current-status')?.addEventListener('change', (e) => {
            renderNoteCurrentExtra((e.target && e.target.value) || 'Same as Original', null);
          });
        }
      } else {
        editor.value = rawContent || '';
        editor.style.display = 'block';
        if (viewer) viewer.hidden = true;
      }

      editor.readOnly = false;
      editor.classList.remove('notes-readonly');
      toggleVisibility(saveBtn, true);
      toggleVisibility(cancel, true);
      toggleVisibility(editBtn, false);
    }
    updateDirtyState();
  }

  function openModal(content, intent){
    modal.dataset.intent = intent === 'create' ? 'create' : 'update';
    rawContent = content || '';
    originalContent = rawContent;
    setState(intent === 'create' ? 'edit' : 'view');
    if (viewer) viewer.hidden = modal.dataset.state === 'edit';
    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden','false');
    if (title) {
      title.textContent = intent === 'create' ? 'Create Note.json' : 'Case Notes (Note.json)';
    }
    if (modal.dataset.state === 'edit') {
      const target = editor && editor.style.display !== 'none' ? editor : (caseForm && !caseForm.hidden ? caseForm : caseLawForm);
      target?.focus();
    }
  }

  function closeModal(){
    stopLeftResize();
    modal.setAttribute('hidden','');
    modal.setAttribute('aria-hidden','true');
    editor.readOnly = true;
    editor.blur();
    if (editor) editor.style.display = 'none';
    if (viewer) viewer.hidden = true;
    if (caseForm) caseForm.hidden = true;
    if (caseLawForm) caseLawForm.hidden = true;
    noteContext = null;
  }

  // Public helper used by manageCaseForm
  window._openNotesWith = function(content, intent, context){
    noteContext = context || null;
    openModal(content || '', intent || 'update');
  };

  editBtn.addEventListener('click', async () => {
    rawContent = originalContent;

    // For case-law, fetch full detail (structured citations) from the DB before populating
    if (noteContext && noteContext.kind === 'case-law' && noteContext.id) {
      try {
        const resp = await fetch(`/case-law/${noteContext.id}/detail`);
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.ok && data.case) {
          // Merge DB data into the note content so populateForm gets structured citations
          const merged = safeParseJson(rawContent) || {};
          merged['Court Type'] = data.case.court_type || merged['Court Type'] || '';
          merged['Court Name'] = data.case.court_name || merged['Court Name'] || '';
          if (data.case.citations && data.case.citations.length) {
            merged['Citations'] = data.case.citations.map(c => ({
              Journal: c.journal, Year: c.year,
              Volume: c.volume || '', 'Court Abbreviation': c.court_abbrev || '',
              Page: c.page,
            }));
          }
          rawContent = JSON.stringify(merged, null, 2);
        }
      } catch (_) { /* proceed with existing data */ }
    }

    setState('edit');
    const target = editor && editor.style.display !== 'none' ? editor : (caseForm && !caseForm.hidden ? caseForm : caseLawForm);
    target?.focus();
  });

  async function saveCurrent(){
    const intent = modal.dataset.intent === 'create' ? 'create' : 'update';
    const kind = currentKind();
    if (kind === 'case-law' && caseLawForm && !caseLawForm.hidden) {
      const primaryVal = getVal('note-cl-primary');
      const caseTypeVal = getVal('note-cl-type');
      if (!primaryVal) {
        showClientFlash('Select a primary classification.', 'error');
        return;
      }
      if (!caseTypeVal) {
        showClientFlash('Select a case type.', 'error');
        return;
      }
    }
    const formPayload = buildPayloadFromForm(kind);
    const payloadContent = formPayload !== null ? formPayload : editor.value;

    if (noteContext && noteContext.kind === 'case-law') {
      const caseId = noteContext.id;
      if (!caseId) {
        alert('Missing case-law identifier.');
        return;
      }

      // If the form is active, use the structured edit endpoint
      if (caseLawForm && !caseLawForm.hidden) {
        const parsedPayload = safeParseJson(payloadContent) || {};
        const clCourtContainer = document.getElementById('note-cl-court-name-container');
        const ctrl = clCourtContainer?._courtCtrl;
        const clCitList = document.getElementById('note-cl-citations-list');

        const editBody = {
          petitioner: parsedPayload['Petitioner'] || '',
          respondent: parsedPayload['Respondent'] || '',
          court_type: ctrl ? ctrl.getCourtType() : (parsedPayload['Court Type'] || ''),
          court_name: ctrl ? ctrl.getCourtName() : (parsedPayload['Court Name'] || ''),
          decision_year: parsedPayload['Decision Year'] || '',
          primary_type: parsedPayload['Primary Type'] || '',
          case_type: parsedPayload['Case Type'] || '',
          note: parsedPayload['Note'] || '',
          citations: clCitList ? collectCitations(clCitList) : [],
        };

        try {
          const resp = await fetch(`/case-law/${caseId}/edit`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
            body: JSON.stringify(editBody),
          });
          const data = await resp.json().catch(()=>({}));
          if (!resp.ok || !data.ok) {
            throw new Error(data.msg || `HTTP ${resp.status}`);
          }
          rawContent = payloadContent;
          originalContent = rawContent;
          showClientFlash('Case law updated.', 'success');
          if (typeof noteContext.onSaved === 'function') {
            noteContext.onSaved(data.case?.note_preview || '');
          }
          modal.dataset.intent = 'update';
          setState('view');
        } catch (err) {
          showClientFlash(`Save failed: ${err.message || err}`, 'error');
        }
        return;
      }

      // Fallback: raw editor mode — use the old note endpoint
      try {
        const resp = await fetch(`/case-law/${caseId}/note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
          body: JSON.stringify({ content: payloadContent })
        });
        const data = await resp.json().catch(()=>({}));
        if (!resp.ok || !data.ok) {
          throw new Error(data.msg || `HTTP ${resp.status}`);
        }
        rawContent = payloadContent;
        originalContent = rawContent;
        showClientFlash('Notes saved.', 'success');
        if (typeof noteContext.onSaved === 'function') {
          noteContext.onSaved(data.summary || '');
        }
        modal.dataset.intent = 'update';
        setState('view');
      } catch (err) {
        showClientFlash(`Save failed: ${err.message || err}`, 'error');
      }
      return;
    }

    const yEl = document.getElementById('mc-year');
    const mEl = document.getElementById('mc-month');
    const cEl = document.getElementById('mc-case');
    const year  = (noteContext && noteContext.year) || yEl?.value || '';
    const month = (noteContext && noteContext.month) || mEl?.value || '';
    const cname = (noteContext && noteContext.caseName) || cEl?.value || '';

    if (!year || !month || !cname) {
      alert('Select Year, Month, and Case first.');
      return;
    }

    const body = { content: payloadContent };
    let resp;
    try {
      if (intent === 'create') {
        resp = await fetch('/api/create-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
          body: JSON.stringify({ year, month, case: cname, content: payloadContent })
        });
      } else {
        resp = await fetch(`/api/note/${year}/${month}/${encodeURIComponent(cname)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
          body: JSON.stringify(body)
        });
      }
      const data = await resp.json().catch(()=>({}));
      if (!resp.ok || !data.ok) {
        throw new Error(data.msg || `HTTP ${resp.status}`);
      }
      rawContent = payloadContent;
      originalContent = rawContent;
      showClientFlash(intent === 'create' ? 'Note.json created.' : 'Notes saved.', 'success');
      // The folder name follows the party names, exactly as Create Case derives
      // it.  Done after the write so the note lands before the path moves.
      await maybeRenameCaseFolder(year, month, cname);
      modal.dataset.intent = 'update';
      setState('view');
      if (typeof window.__refreshNoteButton === 'function') {
        window.__refreshNoteButton();
      }
    } catch (err) {
      showClientFlash(`Save failed: ${err.message || err}`, 'error');
    }
  }

  /**
   * Rename the case directory when the party names now derive a different case
   * name.  The note itself is already saved, so a failure here is reported
   * without losing the edit (renaming is admin-only).
   */
  async function maybeRenameCaseFolder(year, month, cname){
    const derived = noteDerivedCaseName();
    if (!derived || derived === cname) return;
    let data = {};
    try {
      const resp = await fetch('/api/rename-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
        body: JSON.stringify({ year, month, case: cname, new_name: derived }),
      });
      data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        showClientFlash(
          `Notes saved, but the case folder was not renamed: ${data.msg || 'HTTP ' + resp.status}`,
          'error');
        return;
      }
    } catch (err) {
      showClientFlash(`Notes saved, but the case folder was not renamed: ${err.message || err}`, 'error');
      return;
    }

    if (noteContext) noteContext.caseName = derived;
    // Keep the Manage Case picker pointing at the case under its new name.
    const caseSel = document.getElementById('mc-case');
    if (caseSel) {
      Array.from(caseSel.options).forEach((opt) => {
        if (opt.value === cname) { opt.value = derived; opt.textContent = derived; }
      });
      if (caseSel.value === cname) caseSel.value = derived;
    }
    showClientFlash(`Case folder renamed to “${derived}”.`, 'success');
  }

  function handleCancel(){
    const editing = modal.dataset.state === 'edit';
    if (!editing) {
      rawContent = originalContent;
      setState('view');
      return;
    }
    rawContent = originalContent;
    if (modal.dataset.intent === 'create') {
      closeModal();
      setState('view');
      return;
    }
    setState('view');
  }

	  // ensure starting state obeys visibility rules
	  toggleVisibility(saveBtn, false);
	  toggleVisibility(cancel, false);
	  toggleVisibility(editBtn, true);
	  refreshNotesFormRefs();
	  saveBtn.disabled = true;

  editor.addEventListener('input', updateDirtyState);

  saveBtn.addEventListener('click', saveCurrent);
  cancel.addEventListener('click', handleCancel);
  close.addEventListener('click', () => {
    rawContent = originalContent;
    closeModal();
    setState('view');
  });
}

// -------------------- Theme + flashes --------------------
function autoDismissFlashes(ms = 3000){
  const flashes = document.querySelectorAll('.flash-stack .flash');
  flashes.forEach(el => {
    // click to dismiss immediately
    const removeNow = () => { el.classList.add('flash-fade'); setTimeout(()=> el.remove(), 350); };
    el.addEventListener('click', removeNow, { once: true });

    // timed auto-dismiss
    setTimeout(() => {
      if (!document.body.contains(el)) return;
      el.classList.add('flash-fade');
      setTimeout(() => el.remove(), 350);
    }, ms);
  });
}

function showClientFlash(message, category = 'info', duration = 3000){
  let stack = document.querySelector('.flash-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'flash-stack';
    stack.setAttribute('role','status');
    stack.setAttribute('aria-live','polite');
    document.body.appendChild(stack);
  }
  const item = document.createElement('div');
  item.className = `flash ${category}`;
  item.textContent = message;
  stack.appendChild(item);

  const removeNow = () => { item.classList.add('flash-fade'); setTimeout(()=> item.remove(), 350); };
  item.addEventListener('click', removeNow, { once: true });
  setTimeout(removeNow, duration);
}

const THEME_KEY = 'caseOrg.theme';
function applyTheme(theme){
  const root = document.documentElement;
  const current = root.getAttribute('data-theme') || 'light';
  if (current !== theme) {
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }
  const btn = document.getElementById('theme-toggle');
  if (btn && btn.dataset.iconTheme !== theme) {
    btn.dataset.iconTheme = theme;
    btn.innerHTML = theme === 'dark'
      ? '<i class="fa-solid fa-sun"></i>'
      : '<i class="fa-solid fa-moon"></i>';
  }
}

function initTheme(){
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved);
    return;
  }
  // Keep consistent with the inline <head> theme bootstrap (dark default unless user chose light).
  applyTheme('dark');
}

function setupThemeToggle(){
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });

  const saved = localStorage.getItem(THEME_KEY);
  if (!saved && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', e => applyTheme(e.matches ? 'dark' : 'light'));
  }
}

function setupSessionKeepalive(){
  const role = (document.body?.dataset?.role || '').trim();
  if (!role) return;
  if (document.documentElement.dataset.sessionKeepaliveBound === '1') return;
  document.documentElement.dataset.sessionKeepaliveBound = '1';

  const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
  const KEEPALIVE_INTERVAL_MS = 60 * 1000;
  const ACTIVITY_CHECK_INTERVAL_MS = 15 * 1000;
  const IDLE_CUTOFF_MS = SESSION_TIMEOUT_MS - (60 * 1000);

  let lastUserActivityAt = Date.now();
  let lastPingAt = 0;
  let pingInFlight = false;

  const markUserActive = () => {
    lastUserActivityAt = Date.now();
  };

  const shouldPing = (force = false) => {
    const now = Date.now();
    if (!force && document.visibilityState === 'hidden') return false;
    if (!force && (now - lastUserActivityAt) > IDLE_CUTOFF_MS) return false;
    if (!force && (now - lastPingAt) < KEEPALIVE_INTERVAL_MS) return false;
    return true;
  };

  const pingKeepalive = async (force = false) => {
    if (!shouldPing(force) || pingInFlight) return;
    pingInFlight = true;
    try {
      const resp = await fetch('/api/session/keepalive', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': _csrfToken() },
        keepalive: true,
      });
      if (resp.ok) {
        lastPingAt = Date.now();
      }
    } catch (_err) {
      // Ignore transient network errors; next activity check retries.
    } finally {
      pingInFlight = false;
    }
  };

  ['pointerdown', 'keydown', 'input', 'scroll', 'touchstart', 'wheel'].forEach((evt) => {
    window.addEventListener(evt, markUserActive, { passive: true, capture: true });
  });

  window.addEventListener('focus', () => {
    markUserActive();
    void pingKeepalive(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      markUserActive();
      void pingKeepalive(true);
    }
  });

  window.setInterval(() => {
    void pingKeepalive(false);
  }, ACTIVITY_CHECK_INTERVAL_MS);

  void pingKeepalive(true);
}

// -------------------- Startup wiring (single DOMContentLoaded) --------------------
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', () => {
    document.querySelectorAll('.case-action-menu.open').forEach(m => m.classList.remove('open'));
  });
  // Right-clicking anywhere else also dismisses any open case menu
  // (case rows stop propagation before this runs).
  document.addEventListener('contextmenu', () => {
    document.querySelectorAll('.case-action-menu.open').forEach(m => m.classList.remove('open'));
  });

  autoDismissFlashes(3000);

  // Theme (attribute is bootstrapped inline in <head>; this just syncs UI + listeners)
  initTheme();
  setupThemeToggle();

  // Topbar user dropdown menu
  bindUserMenus();
  setupSessionKeepalive();

  const tasks = [
    // Year dropdown in Advanced Search
    () => initYearDropdown('year-dd', 'year'),

    // Simple search
    () => {
      const searchBtn = $('#search-btn');
      const searchQ = $('#search-q');
      searchBtn?.addEventListener('click', runBasicSearch);
      searchQ?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') { e.preventDefault(); runBasicSearch(); }});
    },

    // Advanced toggle
    () => {
      const advToggle = $('#adv-toggle');
      const advForm = $('#adv-form');
      advToggle?.addEventListener('click', ()=>{
        if (!advForm) return;
        const isHidden = advForm.hidden;
        advForm.hidden = !isHidden;
        advToggle.setAttribute('aria-expanded', String(!isHidden));
      });
    },

    // Advanced domain -> subcat (grouped searchable taxonomy)
    () => {
      const advDom = $('#adv-domain');
      mountAdvSubcat('');
      advDom?.addEventListener('change', ()=>{
        mountAdvSubcat(advDom.value || '');
      });
    },

    // Advanced search run
    () => {
      const advSearch = $('#adv-search');
      if (!advSearch) return;
      setSearchResetButton(false);
      advSearch.addEventListener('click', async () => {
        if (searchUiState.resetMode) {
          resetSearchUi();
          return;
        }
        await runAdvancedSearch();
      });
    },

    // Directory search (if button exists)
    () => {
      const dirBtn = document.getElementById('dir-search');
      if (!dirBtn) return;
      dirBtn.setAttribute('aria-pressed', 'false');
      dirBtn.addEventListener('click', async () => {
        const results = document.getElementById('results');
        if (!results) return;

        if (!dirSearchState.active) {
          dirSearchState.active = true;
          dirSearchState.previousScroll = results.scrollTop || 0;
          dirSearchState.currentPath = '';
          dirBtn.classList.add('active');
          dirBtn.textContent = 'Regular Search';
          dirBtn.setAttribute('aria-pressed', 'true');
          results.innerHTML = '<div class="result-item">Loading directory tree...</div>';
          activateSearchResetMode('directory');
          await showDirLevel('');
        } else {
          dirSearchState.active = false;
          dirSearchState.currentPath = '';
          dirBtn.classList.remove('active');
          dirBtn.textContent = 'Directory Search';
          dirBtn.setAttribute('aria-pressed', 'false');
          const snapshot = cloneResults(lastRenderedResults) || null;
          if (Array.isArray(snapshot)) {
            renderResults(snapshot);
            const host = document.getElementById('results');
            if (host) host.scrollTop = dirSearchState.previousScroll || 0;
            activateSearchResetMode(searchUiState.activeMode === 'directory' ? 'basic' : searchUiState.activeMode);
          } else {
            results.innerHTML = `<div class="result-item">${SEARCH_DEFAULT_HINT}</div>`;
            searchUiState.resetMode = false;
            searchUiState.activeMode = 'none';
            setSearchResetButton(false);
          }
          dirSearchState.previousScroll = 0;
        }
      });
    },

    // Cards + forms
    () => {
      const cardConfigs = [
        { el: $('#card-create'), handler: createCaseForm },
        { el: $('#card-manage'), handler: manageCaseForm },
        { el: $('#card-upload-case-law'), handler: caseLawUploadForm },
        { el: $('#card-search-case-law'), handler: caseLawSearchForm },
      ];

      const cardElements = cardConfigs.map(cfg => cfg.el).filter(Boolean);

      cardConfigs.forEach(({ el, handler }) => {
        if (!el || typeof handler !== 'function') return;
        const others = cardElements.filter(other => other !== el);
        const activate = () => {
          // Clicking the already-active card again toggles it off: deselect
          // and clear the form area.
          if (el.classList.contains('active')) {
            el.classList.remove('active');
            el.setAttribute('aria-pressed', 'false');
            const host = document.getElementById('form-host');
            if (host) host.innerHTML = '';
            return;
          }
          setActive(el, others);
          handler();
        };
        el.addEventListener('click', activate);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        });
      });
    },

    // Notes modal global handlers (Save/Cancel/Close)
    () => bindGlobalNotesModalHandlers(),
  ];

  const schedule = (fn) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 200 });
      return;
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(fn);
      return;
    }
    setTimeout(fn, 0);
  };

  const runNext = () => {
    const task = tasks.shift();
    if (!task) return;
    try {
      task();
    } catch (err) {
      console.warn('Init task failed', err);
    }
    schedule(runNext);
  };

  const kickOff = () => schedule(runNext);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(kickOff));
  } else {
    kickOff();
  }
});

/* ── Confirmation prompts (CSP-safe replacement for inline onclick) ───────
   Any submit button with a data-confirm attribute asks for confirmation
   before its form is submitted. */
document.addEventListener('submit', (e) => {
  const btn = e.submitter;
  if (btn && btn.dataset && btn.dataset.confirm && !window.confirm(btn.dataset.confirm)) {
    e.preventDefault();
  }
}, true);

/* ==========================================================================
   Phone chrome.

   Front-end only: no template or backend change. Everything below is built at
   runtime and ONLY on small screens — on a desktop viewport this block exits
   immediately and the DOM is untouched.

   The drawer is populated by cloning the existing .user-menu-item links, so it
   always lists exactly what the server rendered for this user's role (interns
   see no generators, non-admins see no Settings) and can never drift from the
   real navigation.
   ========================================================================== */
(function () {
  'use strict';

  const MOBILE = window.matchMedia('(max-width: 640px)');
  if (!MOBILE.matches) return;
  if (document.getElementById('m-bottombar')) return;      // already built
  if (document.body.classList.contains('login-body')) return;  // login has no chrome

  const ICON = (cls) => `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;

  /* ---------- drawer, cloned from the server-rendered account menu ---------- */

  const drawer = document.createElement('nav');
  drawer.id = 'm-drawer';
  drawer.className = 'm-drawer';
  drawer.setAttribute('aria-label', 'All pages');
  drawer.hidden = true;

  const sheet = document.createElement('div');
  sheet.className = 'm-drawer-sheet';

  // Who am I? Read it from the account toggle the server rendered (hidden on
  // phones), so the drawer always names the signed-in user.
  const toggle = document.querySelector('.user-menu-toggle');
  const who = toggle ? toggle.textContent.trim() : '';
  const role = document.body.dataset.role || '';
  const initial = who ? who.trim().charAt(0).toUpperCase() : '?';

  sheet.innerHTML =
      '<div class="m-drawer-grip" aria-hidden="true"></div>'
    + (who
        ? '<div class="m-drawer-account">'
        +   '<span class="m-drawer-avatar" aria-hidden="true">' + initial + '</span>'
        +   '<span class="m-drawer-who">'
        +     '<span class="m-drawer-email"></span>'
        +     (role ? '<span class="m-drawer-role">' + role + '</span>' : '')
        +   '</span>'
        + '</div>'
        : '')
    + '<h2 class="m-drawer-title">Go to</h2>';

  // Set the address as text, never as HTML.
  const emailEl = sheet.querySelector('.m-drawer-email');
  if (emailEl) emailEl.textContent = who;

  const grid = document.createElement('div');
  grid.className = 'm-drawer-grid';

  // Home is not in the account menu, so it leads the list.
  const brand = document.querySelector('a.brand');
  const dest = [];
  if (brand) dest.push({ href: brand.getAttribute('href'), icon: 'fa-house', label: 'Home' });
  document.querySelectorAll('.user-menu-item').forEach((a) => {
    const label = a.querySelector('.user-menu-label');
    const i = a.querySelector('i');
    dest.push({
      href: a.getAttribute('href'),
      icon: i ? i.className.replace('fa-solid', '').trim() : 'fa-link',
      label: label ? label.textContent.trim() : a.textContent.trim(),
      badge: a.querySelector('.badge') ? a.querySelector('.badge').textContent.trim() : '',
    });
  });

  const here = location.pathname;
  dest.forEach((d) => {
    const a = document.createElement('a');
    a.className = 'm-drawer-item' + (d.href === here ? ' active' : '');
    a.href = d.href;
    a.innerHTML = `<span class="m-drawer-icon">${ICON(d.icon)}</span>`
                + `<span class="m-drawer-label">${d.label}</span>`
                + (d.badge ? `<span class="m-drawer-badge">${d.badge}</span>` : '');
    grid.appendChild(a);
  });

  sheet.appendChild(grid);

  // Sign out sits apart from navigation.
  const logout = document.querySelector('a[href*="logout"], form[action*="logout"] button');
  if (logout) {
    const out = document.createElement('a');
    out.className = 'm-drawer-item danger';
    out.href = logout.tagName === 'A' ? logout.getAttribute('href') : '#';
    out.innerHTML = `<span class="m-drawer-icon">${ICON('fa-right-from-bracket')}</span>`
                  + '<span class="m-drawer-label">Sign out</span>';
    if (logout.tagName !== 'A') {
      out.addEventListener('click', (e) => { e.preventDefault(); logout.click(); });
    }
    sheet.appendChild(out);
  }

  drawer.appendChild(sheet);
  document.body.appendChild(drawer);
  makeSheetDraggable(sheet, () => closeDrawer());

  function openDrawer() {
    drawer.hidden = false;
    requestAnimationFrame(() => drawer.classList.add('open'));
    document.body.classList.add('m-locked');
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    document.body.classList.remove('m-locked');
    setTimeout(() => { drawer.hidden = true; }, 200);
  }
  drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
  });

  /* ---------- bottom bar ---------- */

  const bar = document.createElement('nav');
  bar.id = 'm-bottombar';
  bar.className = 'm-bottombar';
  bar.setAttribute('aria-label', 'Primary');

  const find = (frag) => dest.find((d) => d.href && d.href.indexOf(frag) !== -1);
  const tabs = [
    { href: brand ? brand.getAttribute('href') : '/', icon: 'fa-house', label: 'Home' },
    find('/calendar') && { href: find('/calendar').href, icon: 'fa-calendar-days', label: 'Calendar' },
    find('/messages') && { href: find('/messages').href, icon: 'fa-envelope', label: 'Mail',
                           badge: (find('/messages') || {}).badge },
  ].filter(Boolean);

  tabs.forEach((t) => {
    const a = document.createElement('a');
    a.className = 'm-tabbtn' + (t.href === here ? ' active' : '');
    a.href = t.href;
    a.innerHTML = ICON(t.icon)
                + `<span>${t.label}</span>`
                + (t.badge ? `<span class="m-tab-badge">${t.badge}</span>` : '');
    bar.appendChild(a);
  });

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'm-tabbtn';
  more.setAttribute('aria-haspopup', 'true');
  more.innerHTML = ICON('fa-bars') + '<span>Menu</span>';
  more.addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
  bar.appendChild(more);

  document.body.appendChild(bar);
  document.body.classList.add('m-has-bottombar');

  /* ---------- swipe a sheet down to dismiss it ---------------------------
     A bottom sheet you can only escape by tapping the backdrop feels stuck.
     This adds the expected drag: pull down on the grip (or on the sheet's own
     header) and it follows your finger, releasing past a threshold — or with
     enough downward velocity — to close.

     The drag is bound to the grip/header, not the whole sheet, so it never
     competes with scrolling the content inside. */
  function makeSheetDraggable(sheet, onClose, headerSelector) {
    if (!sheet || sheet.dataset.sheetDrag === '1') return;
    sheet.dataset.sheetDrag = '1';

    // Reuse an existing grip rather than adding a second one, and always place
    // it as a full-width bar ABOVE the header so it sits top-centre instead of
    // squashed in beside the back button.
    let grip = sheet.querySelector('.m-sheet-grip, .m-drawer-grip');
    if (grip) {
      grip.className = 'm-sheet-grip';
    } else {
      grip = document.createElement('div');
      grip.className = 'm-sheet-grip';
    }
    sheet.insertBefore(grip, sheet.firstChild);

    const header = headerSelector ? sheet.querySelector(headerSelector) : null;

    let startY = 0, lastY = 0, startT = 0, armed = false, dragging = false;

    const canStart = (target) => {
      if (sheet.scrollTop > 0) return false;          // scrolled: let it scroll
      if (!target) return true;
      // Never hijack a gesture that begins on something interactive.
      return !target.closest('button, a, input, select, textarea, .ll-dropdown');
    };

    const begin = (y, target) => {
      if (!canStart(target)) return;
      armed = true; dragging = false;
      startY = lastY = y; startT = Date.now();
    };

    const move = (y, e) => {
      if (!armed) return;
      const dy = y - startY;
      // Only take over once the gesture is clearly a downward pull. Anything
      // upward, or a small jitter, stays with the scroller.
      if (!dragging) {
        if (dy < 8) return;
        dragging = true;
        sheet.style.transition = 'none';
      }
      lastY = y;
      sheet.style.transform = 'translateY(' + Math.max(0, dy) + 'px)';
      if (e && e.cancelable) e.preventDefault();      // stop it scrolling instead
    };

    const end = () => {
      if (!armed) return;
      const wasDragging = dragging;
      armed = dragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (!wasDragging) return;
      const dy = lastY - startY;
      const velocity = dy / Math.max(1, Date.now() - startT);
      if (dy > 90 || velocity > 0.5) onClose();
    };

    // Bound to the whole sheet (and its header), so the pull works anywhere in
    // the sheet when it is scrolled to the top — not only on the 5px grip.
    [sheet, header].filter(Boolean).forEach((zone) => {
      zone.addEventListener('touchstart', (e) => begin(e.touches[0].clientY, e.target), { passive: true });
      zone.addEventListener('touchmove', (e) => move(e.touches[0].clientY, e), { passive: false });
      zone.addEventListener('touchend', end);
      zone.addEventListener('touchcancel', end);
      zone.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') return;
        begin(e.clientY, e.target);
        const mv = (ev) => move(ev.clientY, ev);
        const up = () => { end(); window.removeEventListener('pointermove', mv);
                           window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
      });
    });
  }

  window.__caseorgMakeSheetDraggable = makeSheetDraggable;

  /* ---------- the open form sits directly under the card that opened it ---
     On desktop #form-host is a section below the whole card grid, which is fine
     when the grid is 2x2. Stacked on a phone that puts the form three cards
     below the one you tapped. Move the host under the active card instead; the
     remaining cards flow beneath it. */
  const cardGrid = document.querySelector('.cards-grid');
  const formHost = document.getElementById('form-host');
  if (cardGrid && formHost) {
    const homeForCards = formHost.parentElement;
    const hostAnchor = document.createComment('form-host-home');
    homeForCards.insertBefore(hostAnchor, formHost);

    document.addEventListener('click', (e) => {
      const card = e.target.closest('.card.selectable');
      if (!card || !cardGrid.contains(card)) return;
      setTimeout(() => {
        if (card.classList.contains('active') && formHost.innerHTML.trim()) {
          card.insertAdjacentElement('afterend', formHost);
          formHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          // Toggled off (or another card took over): park it back where it lives.
          hostAnchor.parentNode.insertBefore(formHost, hostAnchor.nextSibling);
        }
      }, 80);
    });
  }

  /* ---------- long-press opens the case action menu -----------------------
     There is no right-click on a phone, and the desktop menu is positioned at
     the pointer. Long-press (500ms) opens it, and the CSS presents it as a
     bottom sheet with a backdrop rather than a floating menu at a coordinate. */
  (function () {
    let timer = null, startY = 0, fired = false;

    function sheetFor(menu) {
      if (!menu) return;
      document.querySelectorAll('.m-menu-backdrop').forEach((b) => b.remove());
      const back = document.createElement('div');
      back.className = 'm-menu-backdrop';
      document.body.appendChild(back);
      const close = () => {
        menu.classList.remove('open');
        back.remove();
      };
      back.addEventListener('click', close);
      menu.querySelectorAll('button, a').forEach((b) => b.addEventListener('click', close, { once: true }));
      menu.classList.add('open');
    }

    document.addEventListener('touchstart', (e) => {
      const row = e.target.closest('.result-item, .mc-name-result, [data-case-row]');
      if (!row) return;
      fired = false;
      startY = e.touches[0].clientY;
      timer = setTimeout(() => {
        const btn = row.querySelector('.case-menu-btn, [data-case-menu], .icon-btn');
        fired = true;
        if (btn) { btn.click(); setTimeout(() => sheetFor(document.querySelector('.case-action-menu.open')), 30); }
        else { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 }));
               setTimeout(() => sheetFor(document.querySelector('.case-action-menu.open')), 30); }
      }, 500);
    }, { passive: true });

    const cancel = (e) => {
      if (timer && e.touches && e.touches[0] && Math.abs(e.touches[0].clientY - startY) > 12) {
        clearTimeout(timer); timer = null;                    // treat as a scroll
      }
    };
    document.addEventListener('touchmove', cancel, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (fired) { e.preventDefault(); fired = false; }        // don't also open the case
    });
  })();

  /* ---------- calendar: tap a day to select, tap again to open it -------
     On desktop the day agenda is a side column. On a phone that column ends up
     below the fold, so the day you tapped appears to do nothing. Here it
     becomes a sheet you push into, iOS-style, and pop back out of. */
  const calGrid = document.getElementById('cal-month-grid');
  const calSide = document.querySelector('.cal-side');
  if (calGrid && calSide) {
    const backdrop = document.createElement('div');
    backdrop.className = 'm-day-backdrop';
    document.body.appendChild(backdrop);

    const head = document.createElement('div');
    head.className = 'm-day-head';
    head.innerHTML = '<button type="button" class="m-day-back" aria-label="Back to month">'
                   + '<i class="fa-solid fa-chevron-left"></i></button>'
                   + '<span class="m-day-title"></span>';
    calSide.insertBefore(head, calSide.firstChild);

    const title = head.querySelector('.m-day-title');

    function openDay() {
      // Mirror whatever the agenda is showing as the sheet's title.
      const h = calSide.querySelector('.cal-side-title, h2, h3');
      title.textContent = h ? h.textContent.trim() : 'Day';
      document.body.classList.add('m-day-open');
      calSide.scrollTop = 0;
    }
    function closeDay() { document.body.classList.remove('m-day-open'); }

    makeSheetDraggable(calSide, closeDay, '.m-day-head');
    head.querySelector('.m-day-back').addEventListener('click', closeDay);
    backdrop.addEventListener('click', closeDay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('m-day-open')) closeDay();
    });

    // Capture phase: read `selected` BEFORE calendar.js re-renders the grid, so
    // "already selected" means this is the second tap on the same day.
    calGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-cell');
      if (!cell || cell.classList.contains('other-month')) return;
      if (cell.classList.contains('selected')) setTimeout(openDay, 60);
    }, true);

    // Opening the event modal from inside the sheet would trap it behind the
    // backdrop; drop the sheet first.
    calSide.addEventListener('click', (e) => {
      const t = e.target.closest('button, a');
      if (!t) return;
      // Controls that belong to the sheet itself (its Day/Case tabs, the swap
      // button, the back chevron) must NOT dismiss it — only things that open a
      // modal on top should, so the modal is not trapped behind the backdrop.
      if (t.classList.contains('m-day-back')) return;
      if (t.closest('.cal-side-tabs, .cal-side-head, .m-day-head')) return;
      if (t.hasAttribute('data-cal-tab') || t.classList.contains('mc-tab')) return;
      setTimeout(closeDay, 30);
    });
  }
})();
