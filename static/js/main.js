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

// --- Data: subcategories & case types ----------------------------------
const SUBCATS = {
  Criminal: [
    "Anticipatory Bail","Appeals","Bail","Charges","Criminal Miscellaneous",
    "Orders/Judgments","Office Reports","Primary Documents","Revisions","Trial","Writs",
    "Reference","Transfer Petitions","Special Leave Petition"
  ],
  Civil: [
    "Civil Main","Civil Miscellaneous Main","Civil Appeal","Civil Revision",
    "Civil Writ Petition","Orders/Judgments","Office Reports","Primary Documents",
    "Reference","Transfer Petitions","Special Leave Petition"
  ],
  Commercial: [
    "Civil Main","Civil Miscellaneous Main","Civil Appeal","Civil Revision",
    "Civil Writ Petition","Constitutional","Orders/Judgments","Office Reports","Primary Documents",
    "Reference","Transfer Petitions","Special Leave Petition"
  ],
  // NOTE: Intentionally no "Case Law" key so subcategory is disabled when selected.
};

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
 * Build a searchable dropdown for High Court selection.
 * Returns { wrapper, input, hiddenInput, setVal(name) }
 */
function buildSearchableDropdown(inputId, hiddenId, placeholder) {
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

    const addGroup = (label, items) => {
      const filtered = items.filter(hc => hc.name.toLowerCase().includes(q));
      if (!filtered.length) return;
      const lbl = document.createElement('div');
      lbl.className = 'sd-group-label';
      lbl.textContent = label;
      panel.appendChild(lbl);
      for (const hc of filtered) {
        const opt = document.createElement('div');
        opt.className = 'sd-option';
        opt.textContent = hc.name;
        opt.dataset.value = hc.name;
        opt.dataset.abbrev = hc.abbrev;
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectOption(hc.name, hc.abbrev);
        });
        panel.appendChild(opt);
        allFiltered.push(opt);
      }
    };

    addGroup('Current', current);
    if (historical.length) {
      const div = document.createElement('div');
      div.className = 'sd-divider';
      panel.appendChild(div);
      addGroup('Historical', historical);
    }

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
    const hc = HIGH_COURTS.find(h => h.name === name);
    if (hc) selectOption(hc.name, hc.abbrev);
    else { inp.value = name || ''; hidden.value = name || ''; }
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

    // Use fixed positioning to escape all ancestor overflow clipping
    const rect = trigger.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.left = rect.left + 'px';
    panel.style.width = rect.width + 'px';
    panel.style.right = 'auto';

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
  renderResults(data.results || []);
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
  renderResults(data.results || []);
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
        const resp = await fetch('/api/delete-file', {
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
  currentPath: ''
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
  const subcat = document.getElementById('adv-subcat');
  if (subcat) {
    subcat.innerHTML = '<option value="">Subcategory</option>';
    subcat.disabled = true;
  }
  const typeEl = document.getElementById('type');
  if (typeEl) typeEl.value = '';
}

function resetSearchUi(){
  dirSearchState.active = false;
  dirSearchState.previousScroll = 0;
  dirSearchState.currentPath = '';

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

    // Up directory
    if (relPath) {
      const up = document.createElement('div');
      up.className = 'result-item folder';
      up.innerHTML = `<i class="fa-solid fa-arrow-up" style="margin-right:6px;"></i> ..`;
      up.addEventListener('click', () => {
        const parts = relPath.split('/');
        parts.pop();
        showDirLevel(parts.join('/'));
      });
      results.appendChild(up);
    }

    // Directories
    (data.dirs || []).forEach(dir => {
      const row = document.createElement('div');
      row.className = 'result-item folder';
      row.innerHTML = `<i class="fa-solid fa-folder-open" style="color: var(--accent); margin-right:6px;"></i> ${dir}`;
      row.addEventListener('click', () => {
        const newPath = relPath ? `${relPath}/${dir}` : dir;
        showDirLevel(newPath);
      });
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
      <input type="date" id="cc-date" />

      <!-- Parties -->
      <input type="text" id="pn" placeholder="Petitioner Name" />
      <input type="text" id="rn" placeholder="Respondent Name" />
      <input type="text" id="pa" placeholder="Petitioner Address" />
      <input type="text" id="ra" placeholder="Respondent Address" />
      <input type="text" id="pc" placeholder="Petitioner Contact" />
      <input type="text" id="rc" placeholder="Respondent Contact" />

      <!-- Auto Case Name (preview) -->
      <input type="text" id="cc-name-preview" placeholder="Case Name (auto)" disabled />
      <input type="hidden" id="cc-name" />

      <!-- Representing -->
      <div style="grid-column: span 2;">
        <label style="display:block;margin:6px 0 4px;">We’re Representing:</label>
        <input type="hidden" id="op" value="Petitioner" />
        <div class="op-tabs" role="tablist">
          <button type="button" class="op-tab active" data-value="Petitioner" role="tab" aria-selected="true">Petitioner</button>
          <button type="button" class="op-tab" data-value="Respondent" role="tab" aria-selected="false">Respondent</button>
        </div>
      </div>

      <!-- Domain -> Case Type -> Subcategory -->
      <select id="cat"><option value="">Case Category</option><option>Criminal</option><option>Civil</option><option>Commercial</option></select>
      <select id="ctype" disabled><option value="">Case Type</option></select>
      <input type="text" id="ctype-other" placeholder="Case Type (Other)" style="display:none;" />
      <select id="subcat" disabled><option value="">Subcategory</option></select>
      
      <!-- Courts -->
      <input type="text" id="os" placeholder="Origin State" />
      <input type="text" id="od" placeholder="Origin District" />
      <input type="text" id="of" placeholder="Origin Court/Forum" />
      <input type="text" id="cs" placeholder="Current State" />
      <input type="text" id="cd" placeholder="Current District" />
      <input type="text" id="cf" placeholder="Current Court/Forum" />

      <textarea id="an" class="full-span cc-additional-notes" rows="4" placeholder="Additional Notes"></textarea>
    </div>
    <div class="form-actions">
      <button id="cc-go" class="btn-primary" type="button">Create Case & Save Note</button>
    </div>
  `;
  host.append(wrap);

  // defaults
  const dateEl = $('#cc-date');
  if (dateEl) dateEl.valueAsDate = new Date();

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

  // Domain -> Subcategory -> CaseType
  $('#cat')?.addEventListener('change', () => {
    const dom = $('#cat').value || '';
    if (dom && SUBCATS[dom]) {
      const _ccExclude = new Set(["Orders/Judgments", "Office Reports", "Primary Documents"]);
      populateOptions($('#subcat'), SUBCATS[dom].filter(s => !_ccExclude.has(s)), "Subcategory");
      populateOptions($('#ctype'), CASE_TYPES[dom], "Case Type");
      $('#ctype').disabled = false;
    } else {
      if ($('#subcat')) { $('#subcat').innerHTML = '<option value="">Subcategory</option>'; $('#subcat').disabled = true; }
      if ($('#ctype')) { $('#ctype').innerHTML = '<option value="">Case Type</option>'; $('#ctype').disabled = true; }
      if ($('#ctype-other')) $('#ctype-other').style.display = 'none';
    }
  });

  // Show text input only if Case Type == Others
  $('#ctype')?.addEventListener('change', () => {
    const val = $('#ctype').value || '';
    if ($('#ctype-other')) $('#ctype-other').style.display = (val === 'Others') ? 'block' : 'none';
  });

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
    const cat = $('#cat')?.value || '';
    const subcat = $('#subcat')?.value || '';
    fd.set('Case Category', cat);
    fd.set('Case Subcategory', subcat);
    const ctypeSel = $('#ctype')?.value || '';
    const ctype = (ctypeSel === 'Others') ? (($('#ctype-other')?.value || '').trim()) : ctypeSel;
    fd.set('Case Type', ctype);
    fd.set('Origin State', ($('#os')?.value || '').trim());
    fd.set('Origin District', ($('#od')?.value || '').trim());
    fd.set('Origin Court/Forum', ($('#of')?.value || '').trim());
    fd.set('Current State', ($('#cs')?.value || '').trim());
    fd.set('Current District', ($('#cd')?.value || '').trim());
    fd.set('Current Court/Forum', ($('#cf')?.value || '').trim());
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
    <div class="mc-tabs" role="tablist" aria-label="Manage case lookup">
      <button type="button" class="mc-tab active" data-tab="date" role="tab" aria-selected="true">Year & Month</button>
      <button type="button" class="mc-tab" data-tab="name" role="tab" aria-selected="false">Case Name</button>
    </div>
    <div class="mc-panel" data-tab="date">
      <div class="form-grid">
        <select id="mc-year"><option value="">Year</option></select>
        <select id="mc-month" disabled><option value="">Month</option></select>
        <select id="mc-case" disabled><option value="">Case (Petitioner v. Respondent)</option></select>
        <select id="domain">
          <option value="">File Category</option>
          <option>Criminal</option><option>Civil</option><option>Commercial</option><option>Case Law</option><option>Invoices</option>
        </select>
        <select id="subcategory" disabled><option value="">Subcategory</option></select>
        <input type="text" id="main-type" placeholder="Main Type (e.g., Transfer Petition, Criminal Revision, Orders)" />
        <input type="date" id="mc-date" />
        <button id="create-note-btn" class="btn-secondary" type="button" hidden>
          View / Edit Note.json
        </button>
      </div>
    </div>
    <div class="mc-panel" data-tab="name" hidden>
      <div class="mc-name-search">
        <input type="text" id="mc-name-input" placeholder="Search case name…" />
        <button type="button" id="mc-name-search" class="btn-secondary">Search</button>
      </div>
      <div id="mc-name-results" class="results mc-name-results">
        <div class="result-item">Search for a case to begin.</div>
      </div>
    </div>

    <div class="dropzone" id="drop" tabindex="0">Drag & drop files here or click to select</div>
    <input type="file" id="file" hidden accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.json" multiple />
    <div id="file-list" class="results"></div>

    <div class="form-actions">
      <button id="mc-go" class="btn-primary" type="button">Upload & Categorize File(s)</button>
      <button id="mc-invoice" class="btn-secondary" type="button" disabled>Generate Invoice</button>
    </div>
  `;
  host.append(wrap);

  // defaults
  const mcDate = $('#mc-date'); if (mcDate) mcDate.valueAsDate = new Date();

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

  setVisibility(noteBtn, false);
  if (noteBtn) {
    noteBtn.dataset.hasNote && delete noteBtn.dataset.hasNote;
    noteBtn.dataset.intent && delete noteBtn.dataset.intent;
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
    invoiceBtn.style.marginLeft = 'auto';
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

      if (invoiceBtn) {
          invoiceBtn.disabled = !hasSelection;
          invoiceBtn.setAttribute('aria-disabled', hasSelection ? 'false' : 'true');
      }

      if (!noteBtn) return;

      if (!hasSelection) {
          setVisibility(noteBtn, false);
          delete noteBtn.dataset.hasNote;
          delete noteBtn.dataset.intent;
          noteBtn.onclick = null;
          return;
      }

      const noteState = await getNoteState(year, month, cname);
      if (!noteState.exists) {
          setVisibility(noteBtn, false);
          delete noteBtn.dataset.hasNote;
          delete noteBtn.dataset.intent;
          noteBtn.onclick = null;
          return;
      }

      setVisibility(noteBtn, true);
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

  // --- Domain -> Subcategory ------------------------------------------
  $('#domain')?.addEventListener('change', () => {
    const dom = $('#domain').value || '';
    const subSel = $('#subcategory');
    const mt = $('#main-type');

    if (dom === 'Case Law') {
      if (subSel) { subSel.innerHTML = '<option value="">Subcategory (not used for Case Law)</option>'; subSel.disabled = true; }
      if (mt) mt.placeholder = 'Case Law title / citation (used as filename)';
      return;
    }
    if (dom === 'Invoices') {
      if (subSel) { subSel.innerHTML = '<option value="">Subcategory (not used for Invoices)</option>'; subSel.disabled = true; }
      if (mt) mt.placeholder = 'Main Type (e.g., Transfer Petition, Criminal Revision, Orders)';
      return;
    }

    if (mt) mt.placeholder = 'Main Type (e.g., Transfer Petition, Criminal Revision, Orders)';
    if (dom && SUBCATS[dom]) {
      populateOptions(subSel, SUBCATS[dom], "Subcategory");
    } else if (subSel) {
      subSel.innerHTML = '<option value="">Subcategory</option>'; subSel.disabled = true;
    }
  });

  $('#subcategory')?.addEventListener('change', () => {
    const val = ($('#subcategory')?.value || '').toLowerCase();
    const mt  = $('#main-type');
    if (!mt) return;
    if (val === 'primary documents') {
      mt.value = '';
      mt.disabled = true;
      mt.placeholder = 'Main Type (not used for Primary Documents)';
    } else {
      mt.disabled = false;
      if (($('#domain')?.value || '') !== 'Case Law') {
        mt.placeholder = 'Main Type (e.g., Transfer Petition, Criminal Revision, Orders)';
      }
    }
  });

  // Convert all selects to Long-List Dropdowns
  convertAllSelectsToLLD(wrap);

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

    const fd = new FormData();
    fd.set('Year', year);
    fd.set('Month', month);
    fd.set('Case Name', cname);
    fd.set('Domain', $('#domain')?.value || '');
    fd.set('Subcategory', $('#subcategory')?.value || '');
    fd.set('Main Type', ($('#main-type')?.value || '').trim());
    fd.set('Date', $('#mc-date')?.value || '');
    selectedFiles.forEach(f => fd.append('file', f));

    const r = await fetch('/manage-case/upload', { method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd });
    let data = null;
    try {
      data = await r.json();
    } catch (_err) {
      const raw = await r.text().catch(() => '');
      const compact = (raw || '').replace(/\s+/g, ' ').trim();
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

      <select id="clu-primary"><option value="">Primary Type</option></select>
      <select id="clu-case-type" disabled><option value="">Case Type</option></select>

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
  const caseTypeSel = $('#clu-case-type');

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
    populateOptions(primarySel, Object.keys(CASE_TYPES), 'Primary Type');
  }

  if (caseTypeSel) {
    caseTypeSel.innerHTML = '<option value="">Case Type</option>';
    caseTypeSel.disabled = true;
  }

  primarySel?.addEventListener('change', () => {
    const val = primarySel.value || '';
    if (val && CASE_TYPES[val]) {
      populateOptions(caseTypeSel, CASE_TYPES[val], 'Case Type');
    } else if (caseTypeSel) {
      caseTypeSel.innerHTML = '<option value="">Case Type</option>';
      caseTypeSel.disabled = true;
    }
  });

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

    try {
      const resp = await fetch('/case-law/upload', { method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd });
      const data = await resp.json().catch(()=>({}));
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
      if (caseTypeSel) {
        caseTypeSel.innerHTML = '<option value="">Case Type</option>';
        caseTypeSel.disabled = true;
      }
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
      <div class="cls-mode-panel" data-mode="name">
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
          <select id="cls-primary"><option value="">Primary Type</option></select>
          <select id="cls-case-type" disabled><option value="">Case Type</option></select>
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
  const caseTypeSel = $('#cls-case-type');
  const textInput = $('#cls-text');
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

  if (primarySel) populateOptions(primarySel, Object.keys(CASE_TYPES), 'Primary Type');
  if (caseTypeSel) {
    caseTypeSel.innerHTML = '<option value="">Case Type</option>';
    caseTypeSel.disabled = true;
  }

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
        populateOptions(primarySel, Object.keys(CASE_TYPES), 'Primary Type');
      }
    } else if (caseTypeSel) {
      caseTypeSel.disabled = true;
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

  primarySel?.addEventListener('change', () => {
    const val = primarySel.value || '';
    if (val && CASE_TYPES[val]) {
      populateOptions(caseTypeSel, CASE_TYPES[val], 'Case Type');
    } else if (caseTypeSel) {
      caseTypeSel.innerHTML = '<option value="">Case Type</option>';
      caseTypeSel.disabled = true;
    }
  });

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
      const caseType = caseTypeSel?.value.trim();
      if (!primary) { alert('Choose a primary type.'); return; }
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
    if (caseTypeSel) {
      caseTypeSel.innerHTML = '<option value="">Case Type</option>';
      caseTypeSel.disabled = true;
    }
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
        if (form) convertAllSelectsToLLD(form);
      }
    }
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

  function setCaseSubcategoryOptions(category, selected){
    if (!caseSubcatSel) return;
    if (category && SUBCATS[category]) {
      populateOptions(caseSubcatSel, SUBCATS[category], 'Subcategory');
      caseSubcatSel.disabled = false;
      caseSubcatSel.value = selected && SUBCATS[category].includes(selected) ? selected : '';
    } else {
      caseSubcatSel.innerHTML = '<option value=\"\">Subcategory</option>';
      caseSubcatSel.disabled = true;
    }
  }

  function setCaseTypeOptions(category, selected){
    if (!caseTypeSel) return;
    if (category && CASE_TYPES[category]) {
      populateOptions(caseTypeSel, CASE_TYPES[category], 'Case Type');
      caseTypeSel.disabled = false;
      if (selected && CASE_TYPES[category].includes(selected)) {
        caseTypeSel.value = selected;
        showCaseTypeOther(false);
      } else if (selected) {
        caseTypeSel.value = 'Others';
        if (caseTypeOther) caseTypeOther.value = selected;
        showCaseTypeOther(true);
      } else {
        caseTypeSel.value = '';
        showCaseTypeOther(false);
      }
    } else {
      caseTypeSel.innerHTML = '<option value=\"\">Case Type</option>';
      caseTypeSel.disabled = true;
      showCaseTypeOther(false);
    }
  }

  function setCaseLawPrimaryOptions(selected){
    if (!caseLawPrimarySel) return;
    populateOptions(caseLawPrimarySel, CASE_NOTE_CATEGORIES, 'Primary Type');
    caseLawPrimarySel.value = CASE_NOTE_CATEGORIES.includes(selected) ? selected : '';
  }

  function setCaseLawTypeOptions(primary, selected){
    if (!caseLawTypeSel) return;
    if (primary && CASE_TYPES[primary]) {
      populateOptions(caseLawTypeSel, CASE_TYPES[primary], 'Case Type');
      caseLawTypeSel.disabled = false;
      if (selected && CASE_TYPES[primary].includes(selected)) {
        caseLawTypeSel.value = selected;
      } else {
        caseLawTypeSel.value = '';
      }
    } else {
      caseLawTypeSel.innerHTML = '<option value=\"\">Case Type</option>';
      caseLawTypeSel.disabled = true;
    }
  }

  function normalizeCaseNote(rawObj){
    const obj = (rawObj && typeof rawObj === 'object') ? rawObj : {};
    const origin = obj['Court of Origin'] || {};
    const current = obj['Current Court/Forum'] || {};
    return {
      petitionerName: obj['Petitioner Name'] || '',
      petitionerAddress: obj['Petitioner Address'] || '',
      petitionerContact: obj['Petitioner Contact'] || '',
      respondentName: obj['Respondent Name'] || '',
      respondentAddress: obj['Respondent Address'] || '',
      respondentContact: obj['Respondent Contact'] || '',
      ourParty: obj['Our Party'] || '',
      caseCategory: obj['Case Category'] || '',
      caseSubcategory: obj['Case Subcategory'] || '',
      caseType: obj['Case Type'] || '',
      originState: origin['State'] || '',
      originDistrict: origin['District'] || '',
      originForum: origin['Court/Forum'] || '',
      currentState: current['State'] || '',
      currentDistrict: current['District'] || '',
      currentForum: current['Court/Forum'] || '',
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
        <div class="note-row"><span class="note-label">Case Subcategory</span><span class="note-value">${formatValue(data.caseSubcategory)}</span></div>
        <div class="note-row"><span class="note-label">Case Type</span><span class="note-value">${formatValue(data.caseType)}</span></div>
      </div>
      <div class="note-section">
        <div class="note-heading">Court of Origin</div>
        <div class="note-row"><span class="note-label">State</span><span class="note-value">${formatValue(data.originState)}</span></div>
        <div class="note-row"><span class="note-label">District</span><span class="note-value">${formatValue(data.originDistrict)}</span></div>
        <div class="note-row"><span class="note-label">Court / Forum</span><span class="note-value">${formatValue(data.originForum)}</span></div>
      </div>
      <div class="note-section">
        <div class="note-heading">Current Court / Forum</div>
        <div class="note-row"><span class="note-label">State</span><span class="note-value">${formatValue(data.currentState)}</span></div>
        <div class="note-row"><span class="note-label">District</span><span class="note-value">${formatValue(data.currentDistrict)}</span></div>
        <div class="note-row"><span class="note-label">Court / Forum</span><span class="note-value">${formatValue(data.currentForum)}</span></div>
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
      if (casePartySel) {
        casePartySel.value = data.ourParty || '';
      }
      setCaseCategoryOptions(data.caseCategory || '');
      setCaseSubcategoryOptions(data.caseCategory || '', data.caseSubcategory || '');
      setCaseTypeOptions(data.caseCategory || '', data.caseType || '');
      setVal('note-case-origin-state', data.originState);
      setVal('note-case-origin-district', data.originDistrict);
      setVal('note-case-origin-forum', data.originForum);
      setVal('note-case-current-state', data.currentState);
      setVal('note-case-current-district', data.currentDistrict);
      setVal('note-case-current-forum', data.currentForum);
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
      const catVal = caseCatSel ? (caseCatSel.value || '') : getVal('note-case-category');
      const subVal = caseSubcatSel ? (caseSubcatSel.value || '') : getVal('note-case-subcategory');
      const typeSelVal = caseTypeSel ? (caseTypeSel.value || '') : getVal('note-case-type');
      const typeOtherVal = caseTypeOther ? (caseTypeOther.value || '') : '';
      const finalType = (typeSelVal === 'Others') ? typeOtherVal : typeSelVal;
      payload['Case Category'] = catVal;
      payload['Case Subcategory'] = subVal;
      payload['Case Type'] = finalType;
      payload['Court of Origin'] = {
        'State': getVal('note-case-origin-state'),
        'District': getVal('note-case-origin-district'),
        'Court/Forum': getVal('note-case-origin-forum'),
      };
      payload['Current Court/Forum'] = {
        'State': getVal('note-case-current-state'),
        'District': getVal('note-case-current-district'),
        'Court/Forum': getVal('note-case-current-forum'),
      };
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
          caseCatSel?.addEventListener('change', () => {
            const cat = caseCatSel.value || '';
            setCaseSubcategoryOptions(cat, '');
            setCaseTypeOptions(cat, '');
          });
          caseTypeSel?.addEventListener('change', () => {
            const val = caseTypeSel.value || '';
            if (val === 'Others') {
              showCaseTypeOther(true);
            } else {
              if (caseTypeOther) caseTypeOther.value = '';
              showCaseTypeOther(false);
            }
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
      modal.dataset.intent = 'update';
      setState('view');
      if (typeof window.__refreshNoteButton === 'function') {
        window.__refreshNoteButton();
      }
    } catch (err) {
      showClientFlash(`Save failed: ${err.message || err}`, 'error');
    }
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

    // Advanced domain -> subcat
    () => {
      const advDom = $('#adv-domain');
      const advSub = $('#adv-subcat');
      advDom?.addEventListener('change', ()=>{
        if (!advSub) return;
        const dom = advDom.value || '';
        if (dom && SUBCATS[dom]) {
          populateOptions(advSub, SUBCATS[dom], "Subcategory");
        } else {
          advSub.innerHTML = '<option value="">Subcategory</option>';
          advSub.disabled = true;
        }
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
