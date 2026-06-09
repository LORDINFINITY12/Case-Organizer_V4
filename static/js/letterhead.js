/* ── Letterhead Stamping JS (pick letterhead + upload + stamp) ──── */

function _lhCsrfToken() {
  const m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.content : '';
}

function _lhEscHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.getElementById('lh-download');
  if (!downloadBtn) return;

  const fileInput = document.getElementById('lh-file');
  const dropzone = document.getElementById('lh-drop');
  const fileList = document.getElementById('lh-file-list');

  let selectedFile = null;

  // ── Letterhead Picker ────────────────────────────────────────
  let selectedLetterheadId = null;
  const thumbsContainer = document.getElementById('letterhead-thumbs');
  const marginsBox = document.getElementById('lh-margins');
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
        + '</ul>'
        + '<p>Set these margins in your document so the text clears the letterhead’s header and footer on every page.</p>';
    } else if (id !== null && id !== undefined) {
      // A letterhead is selected but could not be measured automatically.
      marginsBox.className = 'ln-margins ln-margins-warn';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-triangle-exclamation"></i> Could not measure this letterhead</div>'
        + '<p>Leave top and bottom margins that match its printed header and footer so your '
        + 'text does not overlap the letterhead.</p>';
    } else {
      // "None" — no letterhead chosen.
      marginsBox.className = 'ln-margins ln-margins-none';
      marginsBox.innerHTML =
        '<div class="ln-margins-title"><i class="fa-solid fa-circle-info"></i> No letterhead selected</div>'
        + '<p>Pick a letterhead above to see the exact top and bottom margins it needs. '
        + 'With <strong>None</strong> selected, your PDF is returned unchanged.</p>';
    }
  }
  applyMarginGuidance(null);   // default state: "None" selected

  async function loadLetterheads() {
    if (!thumbsContainer) return;
    try {
      const resp = await fetch('/api/letterheads', {
        headers: { 'X-CSRF-Token': _lhCsrfToken() },
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
          + `<img src="${_lhEscHtml(thumbUrl)}" alt="${_lhEscHtml(lh.label)}" loading="lazy" `
          + `onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />`
          + `<span class="letterhead-thumb-fallback" style="display:none;"><i class="fa-solid ${fallbackIcon}"></i></span>`
          + `</div>`;
        card.innerHTML = `
          ${preview}
          <span class="letterhead-thumb-label">${_lhEscHtml(lh.label)}</span>
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
      fileList.innerHTML = `<div class="result-item"><i class="fa-solid fa-file-pdf"></i> ${_lhEscHtml(file.name)}</div>`;
    }
    downloadBtn.disabled = false;
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

  // ── Download handler ─────────────────────────────────────────
  downloadBtn.addEventListener('click', async () => {
    if (!selectedFile) {
      alert('Please upload a PDF.');
      return;
    }

    const fd = new FormData();
    fd.append('file', selectedFile);
    if (selectedLetterheadId !== null && selectedLetterheadId !== undefined) {
      fd.append('letterhead_id', String(selectedLetterheadId));
    }

    downloadBtn.disabled = true;
    const originalHtml = downloadBtn.innerHTML;
    downloadBtn.textContent = 'Stamping...';

    try {
      const url = downloadBtn.dataset.stampUrl;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'X-CSRF-Token': _lhCsrfToken() },
        body: fd,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(err.msg || 'Letterhead stamping failed.');
        return;
      }

      const blob = await resp.blob();
      const disposition = resp.headers.get('Content-Disposition') || '';
      let filename = 'letter_letterhead.pdf';
      const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
      if (filenameMatch) filename = filenameMatch[1];

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert('Network error. Please try again.');
      console.error(e);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = originalHtml;
    }
  });
});
