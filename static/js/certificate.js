/* ── Certificate Generator JS (free-form sandbox) ─────────────── */

function _csrfToken() {
  const m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.content : '';
}

document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.getElementById('cert-download');
  if (!downloadBtn) return;

  const certDoc = document.getElementById('cert-doc');
  if (!certDoc) return;

  // ── Region references ────────────────────────────────────────
  const titleRegion = certDoc.querySelector('[data-cert-title]');
  const internInfoRegion = certDoc.querySelector('[data-intern-info]');
  const bodyRegion = certDoc.querySelector('[data-cert-body]');
  const signatureRegion = certDoc.querySelector('[data-cert-signature]');
  const certNumberEl = certDoc.querySelector('[data-cert-number]');
  const certDateEl = certDoc.querySelector('[data-cert-date]');
  const internNameEl = certDoc.querySelector('[data-intern-name]');

  // ── Toolbar setup ────────────────────────────────────────────
  const toolbar = document.getElementById('cert-toolbar');
  const sizeSelect = document.getElementById('tb-size');
  const lineHeightSelect = document.getElementById('tb-lineheight');

  // Ensure execCommand uses CSS spans for font styling
  document.execCommand('styleWithCSS', false, true);

  // Toolbar button commands (bold, italic, underline, alignment)
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    certDoc.focus();
    document.execCommand(btn.dataset.cmd, false, null);
  });

  // Font size — use fontSize command then convert browser's <font size="N">
  // to inline style since execCommand fontSize only supports 1-7
  sizeSelect.addEventListener('change', () => {
    certDoc.focus();
    const pt = parseInt(sizeSelect.value, 10);
    // Use a marker font size then immediately convert
    document.execCommand('fontSize', false, '7');
    // Find all font[size="7"] inside our doc and convert to inline style
    const bigFonts = certDoc.querySelectorAll('font[size="7"]');
    bigFonts.forEach(f => {
      f.removeAttribute('size');
      f.style.fontSize = pt + 'pt';
    });
  });

  // Line height — apply to the block containing the cursor
  lineHeightSelect.addEventListener('change', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const node = sel.anchorNode;
    const block = _closestBlock(node);
    if (block && certDoc.contains(block)) {
      block.style.lineHeight = lineHeightSelect.value;
    }
  });

  function _closestBlock(node) {
    let el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== certDoc) {
      const display = window.getComputedStyle(el).display;
      if (display === 'block' || display === 'list-item') return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── Letterhead Picker ────────────────────────────────────────
  let selectedLetterheadId = null;
  const thumbsContainer = document.getElementById('letterhead-thumbs');

  async function loadLetterheads() {
    if (!thumbsContainer) return;
    try {
      const resp = await fetch('/api/letterheads', {
        headers: { 'X-CSRF-Token': _csrfToken() },
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

      // Uploaded letterheads
      for (const lh of data.letterheads) {
        const card = document.createElement('div');
        card.className = 'letterhead-thumb';
        card.dataset.id = String(lh.id);
        const fallbackIcon = lh.kind === 'pdf' ? 'fa-file-pdf' : 'fa-image';
        const thumbUrl = lh.thumbnail_url || lh.image_url;
        const preview = `<div class="letterhead-thumb-preview">`
          + `<img src="${_escHtml(thumbUrl)}" alt="${_escHtml(lh.label)}" loading="lazy" `
          + `onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />`
          + `<span class="letterhead-thumb-fallback" style="display:none;"><i class="fa-solid ${fallbackIcon}"></i></span>`
          + `</div>`;
        card.innerHTML = `
          ${preview}
          <span class="letterhead-thumb-label">${_escHtml(lh.label)}</span>
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
  }

  function _escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  loadLetterheads();

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

  // ── Auto-populate certificate number + date ──────────────────

  async function loadNextNumber() {
    try {
      const resp = await fetch('/api/certificates/next-number', {
        headers: { 'X-CSRF-Token': _csrfToken() },
      });
      const data = await resp.json();
      if (data.ok && data.certificate_number && certNumberEl) {
        certNumberEl.textContent = data.certificate_number;
      }
    } catch (e) {
      // ignore
    }
  }
  loadNextNumber();

  // Default date to today
  if (certDateEl) {
    certDateEl.textContent = formatDateObj(new Date());
    certDateEl.addEventListener('blur', () => {
      const val = (certDateEl.textContent || '').replace(/\s+/g, ' ').trim();
      certDateEl.textContent = normaliseDate(val, { fallbackToToday: true });
    });
  }

  // ── Helper: extract plain text from an element ───────────────
  function textOf(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ── Helper: extract intern name from intern info region ──────
  function extractInternName() {
    // Try the dedicated span first
    if (internNameEl) {
      const t = textOf(internNameEl);
      if (t) return t;
    }
    // Fallback: parse the first line of intern info for "Name: <value>"
    const text = textOf(internInfoRegion);
    const m = text.match(/Name:\s*(.+?)(?:\s*Address:|$)/i);
    return m ? m[1].trim() : '';
  }

  // ── Download handler ─────────────────────────────────────────

  downloadBtn.addEventListener('click', async () => {
    const internName = extractInternName();
    if (!internName) {
      alert('Intern name is required. Please fill in the Name field in the intern details section.');
      return;
    }

    const certDate = normaliseDate(textOf(certDateEl), { fallbackToToday: true });
    if (certDateEl) certDateEl.textContent = certDate;

    const payload = {
      certificate_number: textOf(certNumberEl) || null,
      certificate_date: certDate,
      title_html: titleRegion ? titleRegion.innerHTML : '',
      intern_name: internName,
      intern_info_html: internInfoRegion ? internInfoRegion.innerHTML : '',
      body_html: bodyRegion ? bodyRegion.innerHTML : '',
      signature_html: signatureRegion ? signatureRegion.innerHTML : '',
      letterhead_id: selectedLetterheadId,
    };

    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Generating...';

    try {
      const url = downloadBtn.dataset.downloadUrl;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': _csrfToken(),
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(err.msg || 'Certificate generation failed.');
        return;
      }

      // Update displayed certificate number from server response
      const serverNumber = resp.headers.get('X-Certificate-Number');
      if (serverNumber && certNumberEl) {
        certNumberEl.textContent = serverNumber;
      }

      // Download the PDF blob
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

      // Refresh the number for the next certificate
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
