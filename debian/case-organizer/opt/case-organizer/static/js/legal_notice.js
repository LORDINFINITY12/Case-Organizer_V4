/* ── Legal Notice Generator JS (upload + stamp) ───────────────── */

function _lnCsrfToken() {
  const m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.content : '';
}

function _lnEscHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.getElementById('ln-download');
  if (!downloadBtn) return;

  // ── Field references ─────────────────────────────────────────
  const recipientEl = document.getElementById('ln-recipient-name');
  const relTypeEl = document.getElementById('ln-relation-type');
  const relValueEl = document.getElementById('ln-relation-value');
  const addr1El = document.getElementById('ln-address1');
  const addr2El = document.getElementById('ln-address2');
  const contactEl = document.getElementById('ln-contact');
  const numberEl = document.getElementById('ln-number');
  const dateEl = document.getElementById('ln-date');

  const fileInput = document.getElementById('ln-file');
  const dropzone = document.getElementById('ln-drop');
  const fileList = document.getElementById('ln-file-list');

  const addCaseToggle = document.getElementById('ln-addcase-toggle');
  const addCasePanel = document.getElementById('ln-addcase');

  let selectedFile = null;
  let lastNoticeNumber = null;

  // ── Date helpers ─────────────────────────────────────────────
  function formatDateObj(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    return `${day}-${month}-${year}`;
  }

  function normaliseDate(value, { fallbackToToday = false } = {}) {
    const raw = (value || '').trim();
    if (!raw || raw === 'DD-MM-YYYY') {
      return fallbackToToday ? formatDateObj(new Date()) : '';
    }
    let day, month, year;
    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      year = Number(isoMatch[1]);
      month = Number(isoMatch[2]);
      day = Number(isoMatch[3]);
    } else {
      const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
      if (!dmy) return fallbackToToday ? formatDateObj(new Date()) : raw;
      day = Number(dmy[1]);
      month = Number(dmy[2]);
      year = Number(dmy[3]);
    }
    const parsed = new Date(year, month - 1, day);
    const valid =
      parsed.getFullYear() === year &&
      parsed.getMonth() === month - 1 &&
      parsed.getDate() === day;
    if (!valid) return fallbackToToday ? formatDateObj(new Date()) : raw;
    return formatDateObj(parsed);
  }

  if (dateEl) {
    dateEl.value = formatDateObj(new Date());
    dateEl.addEventListener('blur', () => {
      dateEl.value = normaliseDate(dateEl.value, { fallbackToToday: true });
    });
  }

  // ── Auto-populate notice number ──────────────────────────────
  async function loadNextNumber() {
    try {
      const resp = await fetch('/api/legal-notices/next-number', {
        headers: { 'X-CSRF-Token': _lnCsrfToken() },
      });
      const data = await resp.json();
      if (data.ok && data.notice_number && numberEl && !numberEl.value.trim()) {
        numberEl.value = data.notice_number;
      }
    } catch (e) {
      // ignore — user can type a number manually
    }
  }
  loadNextNumber();

  // ── Letterhead Picker ────────────────────────────────────────
  let selectedLetterheadId = null;
  const thumbsContainer = document.getElementById('letterhead-thumbs');
  const marginsBox = document.getElementById('ln-margins');
  const letterheadMargins = {};   // id -> { top_cm, bottom_cm, first_page_cm } | null

  function fmtCm(v) {
    return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  }

  // Render exact margin guidance for the currently-selected letterhead.
  function applyMarginGuidance(id) {
    if (!marginsBox) return;
    const m = (id === null || id === undefined) ? null : letterheadMargins[id];
    if (m && typeof m.top_cm === 'number') {
      marginsBox.className = 'ln-margins ln-margins-exact';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-ruler-combined"></i> Margins for this letterhead</div>'
        + '<ul>'
        + `<li><strong>Every page</strong> — top <strong>${fmtCm(m.top_cm)}&nbsp;cm</strong>, bottom <strong>${fmtCm(m.bottom_cm)}&nbsp;cm</strong></li>`
        + `<li><strong>First page</strong> — top <strong>${fmtCm(m.first_page_cm)}&nbsp;cm</strong> (room for the recipient block &amp; notice number)</li>`
        + '</ul>';
    } else if (id !== null && id !== undefined) {
      // A letterhead is selected but could not be measured automatically.
      marginsBox.className = 'ln-margins ln-margins-warn';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-triangle-exclamation"></i> Could not measure this letterhead</div>'
        + '<p>Leave top and bottom margins that match its printed header and footer, '
        + 'and at least <strong>8.5&nbsp;cm</strong> at the top of the first page.</p>';
    } else {
      // "None" — printing onto physical pre-printed letterhead paper.
      marginsBox.className = 'ln-margins ln-margins-none';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-circle-info"></i> No letterhead selected</div>'
        + '<p>Match the top and bottom margins to the printed header and footer on your '
        + 'physical letterhead paper. On the first page leave at least <strong>8.5&nbsp;cm</strong> '
        + 'at the top for the recipient block and the notice number.</p>';
    }
  }
  applyMarginGuidance(null);   // default state: "None" selected

  async function loadLetterheads() {
    if (!thumbsContainer) return;
    try {
      const resp = await fetch('/api/letterheads', {
        headers: { 'X-CSRF-Token': _lnCsrfToken() },
      });
      const data = await resp.json();
      if (!data.ok) return;

      thumbsContainer.innerHTML = '';

      // "None" option
      const noneCard = document.createElement('div');
      noneCard.className = 'letterhead-thumb selected';
      noneCard.dataset.id = '';
      noneCard.innerHTML = '<span class="letterhead-thumb-label">None</span>';
      noneCard.addEventListener('click', () => selectLetterhead(noneCard, null));
      thumbsContainer.appendChild(noneCard);

      for (const lh of data.letterheads) {
        letterheadMargins[lh.id] = lh.margins || null;
        const card = document.createElement('div');
        card.className = 'letterhead-thumb';
        card.dataset.id = String(lh.id);
        const fallbackIcon = lh.kind === 'pdf' ? 'fa-file-pdf' : 'fa-image';
        const thumbUrl = lh.thumbnail_url || lh.image_url;
        const preview = `<div class="letterhead-thumb-preview">`
          + `<img src="${_lnEscHtml(thumbUrl)}" alt="${_lnEscHtml(lh.label)}" loading="lazy" `
          + `onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />`
          + `<span class="letterhead-thumb-fallback" style="display:none;"><i class="fa-solid ${fallbackIcon}"></i></span>`
          + `</div>`;
        card.innerHTML = `
          ${preview}
          <span class="letterhead-thumb-label">${_lnEscHtml(lh.label)}</span>
        `;
        card.addEventListener('click', () => selectLetterhead(card, lh.id));
        thumbsContainer.appendChild(card);
      }
    } catch (e) {
      console.warn('Failed to load letterheads:', e);
    }
  }

  function selectLetterhead(card, id) {
    selectedLetterheadId = id;
    thumbsContainer.querySelectorAll('.letterhead-thumb').forEach(el => el.classList.remove('selected'));
    card.classList.add('selected');
    applyMarginGuidance(id);
  }

  loadLetterheads();

  // ── File upload (dropzone) ───────────────────────────────────
  function setFile(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.pdf')) {
      alert('Only PDF files are allowed.');
      return;
    }
    selectedFile = file;
    if (fileList) {
      fileList.innerHTML = `<div class="result-item"><i class="fa-solid fa-file-pdf"></i> ${_lnEscHtml(file.name)}</div>`;
    }
  }

  if (dropzone) {
    dropzone.addEventListener('click', () => fileInput && fileInput.click());
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput && fileInput.click(); }
    });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) setFile(fileInput.files[0]);
    });
  }

  // ── Download & Save handler ──────────────────────────────────
  downloadBtn.addEventListener('click', async () => {
    const recipientName = (recipientEl?.value || '').trim();
    if (!recipientName) {
      alert('Recipient name is required.');
      recipientEl && recipientEl.focus();
      return;
    }
    if (!selectedFile) {
      alert('Please upload the notice PDF.');
      return;
    }

    const noticeDate = normaliseDate(dateEl?.value, { fallbackToToday: true });
    if (dateEl) dateEl.value = noticeDate;

    const fd = new FormData();
    fd.append('file', selectedFile);
    fd.append('recipient_name', recipientName);
    fd.append('relation_type', relTypeEl?.value || '');
    fd.append('relation_value', relValueEl?.value || '');
    fd.append('address_line1', addr1El?.value || '');
    fd.append('address_line2', addr2El?.value || '');
    fd.append('contact', contactEl?.value || '');
    fd.append('notice_number', (numberEl?.value || '').trim());
    fd.append('notice_date', noticeDate);
    if (selectedLetterheadId !== null && selectedLetterheadId !== undefined) {
      fd.append('letterhead_id', String(selectedLetterheadId));
    }

    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Generating...';

    try {
      const url = downloadBtn.dataset.saveUrl;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'X-CSRF-Token': _lnCsrfToken() },
        body: fd,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(err.msg || 'Notice generation failed.');
        return;
      }

      const serverNumber = resp.headers.get('X-Legal-Notice-Number');
      if (serverNumber) {
        if (numberEl) numberEl.value = serverNumber;
        lastNoticeNumber = serverNumber;
      }

      const blob = await resp.blob();
      const disposition = resp.headers.get('Content-Disposition') || '';
      let filename = 'legal_notice.pdf';
      const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
      if (filenameMatch) filename = filenameMatch[1];

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);

      // Enable "Add to Case" now that a notice exists
      if (addCaseToggle) {
        addCaseToggle.disabled = false;
        addCaseToggle.setAttribute('aria-disabled', 'false');
      }
    } catch (e) {
      alert('Network error. Please try again.');
      console.error(e);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = '<i class="fa-solid fa-file-arrow-down"></i> Download &amp; Save Notice';
    }
  });

  // ── Add to Case ──────────────────────────────────────────────
  const yearSel = document.getElementById('ln-year');
  const monthSel = document.getElementById('ln-month');
  const caseSel = document.getElementById('ln-case');
  const nameInput = document.getElementById('ln-name-input');
  const nameBtn = document.getElementById('ln-name-search');
  const nameResults = document.getElementById('ln-name-results');
  const addCaseGo = document.getElementById('ln-addcase-go');

  if (addCaseToggle) {
    addCaseToggle.addEventListener('click', () => {
      if (addCaseToggle.disabled) return;
      const willShow = addCasePanel.hidden;
      addCasePanel.hidden = !willShow;
      if (willShow) {
        loadYears();
        addCasePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  function refreshAddCaseGo() {
    const ready = Boolean(yearSel?.value && monthSel?.value && caseSel?.value);
    if (addCaseGo) {
      addCaseGo.disabled = !ready;
      addCaseGo.setAttribute('aria-disabled', ready ? 'false' : 'true');
    }
  }

  function activateLnTab(target) {
    document.querySelectorAll('.mc-tab[data-ln-tab]').forEach(tab => {
      const active = tab.dataset.lnTab === target;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.mc-panel[data-ln-tab]').forEach(panel => {
      panel.hidden = panel.dataset.lnTab !== target;
    });
  }
  document.querySelectorAll('.mc-tab[data-ln-tab]').forEach(tab => {
    tab.addEventListener('click', () => activateLnTab(tab.dataset.lnTab));
  });

  async function loadYears() {
    if (!yearSel) return;
    const r = await fetch('/api/years');
    const data = await r.json().catch(() => ({ years: [] }));
    yearSel.innerHTML = '<option value="">Year</option>';
    (data.years || []).forEach(y => {
      const o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o);
    });
    yearSel.disabled = false;
    monthSel.innerHTML = '<option value="">Month</option>'; monthSel.disabled = true;
    caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true;
    refreshAddCaseGo();
  }

  async function loadMonths(year) {
    const r = await fetch(`/api/months?${new URLSearchParams({ year })}`);
    const data = await r.json().catch(() => ({ months: [] }));
    monthSel.innerHTML = '<option value="">Month</option>';
    (data.months || []).forEach(m => {
      const o = document.createElement('option'); o.value = m; o.textContent = m; monthSel.appendChild(o);
    });
    monthSel.disabled = false;
    caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true;
    refreshAddCaseGo();
  }

  async function loadCases(year, month) {
    const r = await fetch(`/api/cases?${new URLSearchParams({ year, month })}`);
    const data = await r.json().catch(() => ({ cases: [] }));
    caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>';
    (data.cases || []).forEach(cn => {
      const o = document.createElement('option'); o.value = cn; o.textContent = cn; caseSel.appendChild(o);
    });
    caseSel.disabled = false;
    refreshAddCaseGo();
  }

  yearSel?.addEventListener('change', () => {
    const y = yearSel.value || '';
    if (!y) {
      monthSel.innerHTML = '<option value="">Month</option>'; monthSel.disabled = true;
      caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true;
      refreshAddCaseGo();
      return;
    }
    loadMonths(y);
  });
  monthSel?.addEventListener('change', () => {
    const y = yearSel.value || ''; const m = monthSel.value || '';
    if (y && m) loadCases(y, m);
    else { caseSel.innerHTML = '<option value="">Case (Petitioner v. Respondent)</option>'; caseSel.disabled = true; refreshAddCaseGo(); }
  });
  caseSel?.addEventListener('change', refreshAddCaseGo);

  function renderNameResults(list) {
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
        <div class="name">${_lnEscHtml(item.case)}</div>
        <div class="meta">${_lnEscHtml(item.month)} ${_lnEscHtml(item.year)}</div>
      `;
      btn.addEventListener('click', async () => {
        activateLnTab('date');
        if (!Array.from(yearSel.options).some(opt => opt.value === item.year)) {
          await loadYears();
        }
        yearSel.value = item.year;
        await loadMonths(item.year);
        monthSel.value = item.month;
        await loadCases(item.year, item.month);
        caseSel.value = item.case;
        refreshAddCaseGo();
      });
      nameResults.appendChild(btn);
    });
  }

  async function performNameSearch() {
    if (!nameInput || !nameResults) return;
    const q = nameInput.value.trim();
    if (!q) { alert('Enter a case name to search.'); nameInput.focus(); return; }
    nameResults.innerHTML = '<div class="result-item">Searching…</div>';
    try {
      const resp = await fetch(`/api/cases/search?${new URLSearchParams({ q })}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      renderNameResults(data.cases || []);
    } catch (err) {
      nameResults.innerHTML = `<div class="result-item">Search failed: ${_lnEscHtml(err.message || String(err))}</div>`;
    }
  }
  nameBtn?.addEventListener('click', performNameSearch);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); performNameSearch(); }
  });

  addCaseGo?.addEventListener('click', async () => {
    const noticeNumber = lastNoticeNumber || (numberEl?.value || '').trim();
    if (!noticeNumber) { alert('Save the notice first.'); return; }
    const year = yearSel?.value || '';
    const month = monthSel?.value || '';
    const caseName = caseSel?.value || '';
    if (!year || !month || !caseName) { alert('Select a year, month, and case.'); return; }

    addCaseGo.disabled = true;
    addCaseGo.textContent = 'Copying...';
    try {
      const resp = await fetch('/api/legal-notices/add-to-case', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': _lnCsrfToken(),
        },
        body: JSON.stringify({ notice_number: noticeNumber, year, month, case: caseName }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        alert(data.msg || 'Could not add the notice to the case.');
        return;
      }
      alert(`Notice copied to ${caseName}.`);
    } catch (e) {
      alert('Network error. Please try again.');
      console.error(e);
    } finally {
      addCaseGo.textContent = 'Copy to Selected Case';
      refreshAddCaseGo();
    }
  });
});
