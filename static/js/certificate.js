/* ── Internship Certificate Generator JS (upload + stamp) ─────────── */

function _certCsrfToken() {
  const m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.content : '';
}

function _certEscHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.getElementById('cert-download');
  if (!downloadBtn) return;

  // ── Field references ─────────────────────────────────────────
  const numberEl = document.getElementById('cert-number');
  const dateEl = document.getElementById('cert-date');

  const fileInput = document.getElementById('cert-file');
  const dropzone = document.getElementById('cert-drop');
  const fileList = document.getElementById('cert-file-list');

  let selectedFile = null;

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

  // ── Auto-populate certificate number ─────────────────────────
  async function loadNextNumber() {
    try {
      const resp = await fetch('/api/certificates/next-number', {
        headers: { 'X-CSRF-Token': _certCsrfToken() },
      });
      const data = await resp.json();
      if (data.ok && data.certificate_number && numberEl && !numberEl.value.trim()) {
        numberEl.value = data.certificate_number;
      }
    } catch (e) {
      // ignore — user can type a number manually
    }
  }
  loadNextNumber();

  // ── Letterhead picker + margin guidance ──────────────────────
  let selectedLetterheadId = null;
  const thumbsContainer = document.getElementById('letterhead-thumbs');
  const marginsBox = document.getElementById('cert-margins');
  const marginCache = {};   // 'none' | '<id>' -> margins | null

  function fmtCm(v) {
    return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  }

  function renderMargins(m, id) {
    if (!marginsBox) return;
    if (m && typeof m.top_cm === 'number') {
      marginsBox.className = 'ln-margins ln-margins-exact';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-ruler-combined"></i> Margins for this letterhead</div>'
        + '<ul>'
        + `<li><strong>Every page</strong> — top <strong>${fmtCm(m.top_cm)}&nbsp;cm</strong>, bottom <strong>${fmtCm(m.bottom_cm)}&nbsp;cm</strong></li>`
        + `<li><strong>First page</strong> — top <strong>${fmtCm(m.first_page_cm)}&nbsp;cm</strong> (room for the intern details &amp; certificate number)</li>`
        + '</ul>';
    } else if (id !== null && id !== undefined) {
      // A letterhead is selected but could not be measured automatically.
      marginsBox.className = 'ln-margins ln-margins-warn';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-triangle-exclamation"></i> Could not measure this letterhead</div>'
        + '<p>Leave top and bottom margins that match its printed header and footer, '
        + 'and at least <strong>7&nbsp;cm</strong> at the top of the first page.</p>';
    } else {
      // "None" — printing onto physical pre-printed letterhead paper.
      marginsBox.className = 'ln-margins ln-margins-none';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-circle-info"></i> No letterhead selected</div>'
        + '<p>Match the top and bottom margins to the printed header and footer on your '
        + 'physical letterhead paper. On the first page leave at least <strong>7&nbsp;cm</strong> '
        + 'at the top for the title and the intern / certificate details.</p>';
    }
  }

  async function applyMarginGuidance(id) {
    const key = (id === null || id === undefined) ? 'none' : String(id);
    if (key in marginCache) { renderMargins(marginCache[key], id); return; }
    try {
      const qs = (id === null || id === undefined) ? '' : ('?letterhead_id=' + encodeURIComponent(id));
      const resp = await fetch('/api/certificates/margins' + qs, {
        headers: { 'X-CSRF-Token': _certCsrfToken() },
      });
      const data = await resp.json();
      marginCache[key] = (data && data.ok) ? data.margins : null;
    } catch (e) {
      marginCache[key] = null;
    }
    renderMargins(marginCache[key], id);
  }
  applyMarginGuidance(null);   // default state: "None" selected

  async function loadLetterheads() {
    if (!thumbsContainer) return;
    try {
      const resp = await fetch('/api/letterheads', {
        headers: { 'X-CSRF-Token': _certCsrfToken() },
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
        const card = document.createElement('div');
        card.className = 'letterhead-thumb';
        card.dataset.id = String(lh.id);
        const fallbackIcon = lh.kind === 'pdf' ? 'fa-file-pdf' : 'fa-image';
        const thumbUrl = lh.thumbnail_url || lh.image_url;
        const preview = `<div class="letterhead-thumb-preview">`
          + `<img src="${_certEscHtml(thumbUrl)}" alt="${_certEscHtml(lh.label)}" loading="lazy" `
          + `onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />`
          + `<span class="letterhead-thumb-fallback" style="display:none;"><i class="fa-solid ${fallbackIcon}"></i></span>`
          + `</div>`;
        card.innerHTML = `
          ${preview}
          <span class="letterhead-thumb-label">${_certEscHtml(lh.label)}</span>
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
      fileList.innerHTML = `<div class="result-item"><i class="fa-solid fa-file-pdf"></i> ${_certEscHtml(file.name)}</div>`;
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
    if (!selectedFile) {
      alert('Please upload the certificate PDF.');
      return;
    }

    const certDate = normaliseDate(dateEl?.value, { fallbackToToday: true });
    if (dateEl) dateEl.value = certDate;

    const fd = new FormData();
    fd.append('file', selectedFile);
    fd.append('certificate_number', (numberEl?.value || '').trim());
    fd.append('certificate_date', certDate);
    if (selectedLetterheadId !== null && selectedLetterheadId !== undefined) {
      fd.append('letterhead_id', String(selectedLetterheadId));
    }

    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Generating...';

    try {
      const url = downloadBtn.dataset.saveUrl;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'X-CSRF-Token': _certCsrfToken() },
        body: fd,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(err.msg || 'Certificate generation failed.');
        return;
      }

      const serverNumber = resp.headers.get('X-Certificate-Number');
      if (serverNumber && numberEl) numberEl.value = serverNumber;

      const blob = await resp.blob();
      const disposition = resp.headers.get('Content-Disposition') || '';
      let filename = 'certificate.pdf';
      const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
      if (filenameMatch) filename = filenameMatch[1];

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);

      // Refresh the number for the next certificate.
      if (numberEl) numberEl.value = '';
      loadNextNumber();
    } catch (e) {
      alert('Network error. Please try again.');
      console.error(e);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = '<i class="fa-solid fa-file-arrow-down"></i> Download &amp; Save Certificate';
    }
  });
});
