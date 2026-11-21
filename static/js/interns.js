/* ── Interns page ──────────────────────────────────────────────────
 *
 * Two big cards in the home page's grid: New Internship Applicant and Manage
 * Interns.  Choosing one renders its form into #form-host; choosing it again
 * closes it — the same behaviour as Create Case / Manage Case.  The long bar
 * under them is a plain link to the certificate generator.
 *
 * Loaded after main.js, which supplies $, el, escapeHtml, setActive,
 * initIndianDateField, dateIsoToIn, todayIso, openConfirm and _csrfToken.
 */
(function () {
  const newCard = document.getElementById('card-intern-new');
  const manageCard = document.getElementById('card-intern-manage');
  if (!newCard || !manageCard) return;   // not the Interns page

  const STATUS_LABELS = { rejected: 'Rejected', in_process: 'In Process', accepted: 'Accepted' };
  // The order the tabs appear in.
  const STATUS_ORDER = ['rejected', 'in_process', 'accepted'];
  const DOC_LABELS = { cv: 'CV', cover_letter: 'Cover Letter', lor: 'Letters of Recommendation' };
  const ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg';

  // ---- shared helpers ----------------------------------------------------
  function sizeLabel(bytes) {
    if (bytes === null || bytes === undefined) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function postJSON(url, payload) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': _csrfToken() },
      body: JSON.stringify(payload || {}),
    });
    return r.json();
  }

  async function postForm(url, fd) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'X-CSRF-Token': _csrfToken() }, body: fd,
    });
    return r.json();
  }

  // The date field becomes dd/mm/yyyy text; say what the date is for.
  function labelDate(hiddenId, label) {
    const hidden = document.getElementById(hiddenId);
    const text = hidden && hidden.closest('.date-in-wrap')?.querySelector('.date-in-text');
    if (text) { text.setAttribute('aria-label', label); text.title = label; }
  }

  /* A dropzone + hidden file input + selected-file list, built exactly like
   * Manage Case's.  Returns { files(), clear(), node }. */
  function fileDrop({ prompt, multiple }) {
    const node = el('div', 'intern-drop');
    node.innerHTML =
      `<div class="dropzone" tabindex="0">${escapeHtml(prompt)}</div>` +
      `<input type="file" hidden accept="${ACCEPT}" ${multiple ? 'multiple' : ''} />` +
      '<div class="results"></div>';
    const dz = node.querySelector('.dropzone');
    const input = node.querySelector('input[type=file]');
    const list = node.querySelector('.results');
    let picked = [];

    function render() {
      list.innerHTML = '';
      picked.forEach((f, idx) => {
        const row = el('div', 'result-item');
        const name = el('div'); name.textContent = f.name;
        const meta = el('span', 'badge'); meta.textContent = sizeLabel(f.size);
        const rm = el('button'); rm.type = 'button'; rm.textContent = '✕'; rm.className = 'btn-ghost';
        rm.style.padding = '4px 8px'; rm.style.marginLeft = 'auto';
        rm.setAttribute('aria-label', `Remove ${f.name}`);
        rm.addEventListener('click', () => { picked.splice(idx, 1); render(); });
        row.append(name, meta, rm);
        list.append(row);
      });
    }
    function take(files) {
      const arr = Array.from(files || []);
      picked = multiple ? picked.concat(arr) : arr.slice(0, 1);
      render();
    }
    const choose = () => input.click();
    dz.addEventListener('click', choose);
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
    input.addEventListener('change', () => { take(input.files); input.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); dz.classList.remove('dragover'); take(e.dataTransfer.files);
    });
    return { node, files: () => picked.slice(), clear: () => { picked = []; render(); } };
  }

  // ---- Document viewer ---------------------------------------------------
  // A pop-up over the page, never a new tab. PDFs show in a frame and images
  // as images; a Word file cannot be rendered by a browser, so it says so and
  // offers the download rather than silently downloading.
  const viewerModal = document.getElementById('internViewer');
  const viewerBody = document.getElementById('internViewerBody');
  const viewerTitle = document.getElementById('internViewerTitle');
  const viewerDownload = document.getElementById('internViewerDownload');
  let viewerReturnFocus = null;

  function openViewer(doc, opener) {
    if (!viewerModal) return;
    const src = `/api/interns/documents/${doc.id}`;
    const ext = (doc.name.split('.').pop() || '').toLowerCase();
    viewerTitle.textContent = doc.name;
    viewerDownload.href = `${src}?download=1`;
    viewerBody.innerHTML = '';

    if (ext === 'pdf') {
      const frame = el('iframe');
      frame.src = src;
      frame.title = doc.name;
      viewerBody.append(frame);
    } else if (['png', 'jpg', 'jpeg'].includes(ext)) {
      const img = el('img');
      img.src = src;
      img.alt = doc.name;
      viewerBody.append(img);
    } else {
      const note = el('div', 'intern-viewer-note');
      note.innerHTML =
        '<i class="fa-solid fa-file-word" aria-hidden="true"></i>' +
        '<p>Word documents can’t be shown in the browser.</p>';
      const dl = el('a', 'btn-secondary');
      dl.href = `${src}?download=1`;
      dl.textContent = 'Download to open';
      note.append(dl);
      viewerBody.append(note);
    }

    viewerReturnFocus = opener || null;
    viewerModal.removeAttribute('hidden');
    viewerModal.setAttribute('aria-hidden', 'false');
    document.getElementById('internViewerClose')?.focus();
  }

  function closeViewer() {
    if (!viewerModal || viewerModal.hasAttribute('hidden')) return;
    viewerModal.setAttribute('hidden', '');
    viewerModal.setAttribute('aria-hidden', 'true');
    viewerBody.innerHTML = '';   // unloads the frame
    viewerReturnFocus?.focus();
    viewerReturnFocus = null;
  }

  document.getElementById('internViewerClose')?.addEventListener('click', closeViewer);
  // A click on the dimmed backdrop — not inside the window — closes it.
  viewerModal?.addEventListener('click', (e) => { if (e.target === viewerModal) closeViewer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });

  // ---- New Internship Applicant -----------------------------------------
  function newApplicantForm() {
    const host = $('#form-host');
    if (!host) return;
    host.innerHTML = '';
    const wrap = el('div', 'form-card intern-card');
    wrap.innerHTML = `
      <h3>New Internship Applicant</h3>
      <div class="form-grid">
        <input type="text" id="ia-name" placeholder="Applicant Name *" maxlength="180" />
        <input type="date" id="ia-date" />
        <input type="email" id="ia-email" placeholder="Email (optional)" maxlength="200" />
        <input type="text" id="ia-phone" placeholder="Phone (optional)" maxlength="60" />
        <input type="text" id="ia-college" class="full-span" placeholder="College / University (optional)" maxlength="200" />
      </div>
      <div class="intern-doc-grid intern-new-docs" id="ia-docs"></div>
      <div class="form-actions">
        <button id="ia-go" class="btn-primary" type="button">Add Applicant</button>
      </div>
    `;
    host.append(wrap);
    initIndianDateField('ia-date', todayIso());
    labelDate('ia-date', 'Date of application');

    const cv = fileDrop({ prompt: 'CV — drag & drop or click to select', multiple: false });
    const cover = fileDrop({ prompt: 'Cover Letter — drag & drop or click to select', multiple: false });
    const lor = fileDrop({ prompt: 'Letters of Recommendation — drag & drop or click to select (any number)', multiple: true });
    lor.node.classList.add('full-span');
    wrap.querySelector('#ia-docs').append(cv.node, cover.node, lor.node);

    const go = wrap.querySelector('#ia-go');
    go.addEventListener('click', async () => {
      const name = ($('#ia-name')?.value || '').trim();
      const date = $('#ia-date')?.value || '';
      if (!name) { alert('Enter the applicant\'s name.'); return; }
      if (!date) { alert('Enter the date of application.'); return; }

      const fd = new FormData();
      fd.set('name', name);
      fd.set('applied_on', date);
      fd.set('email', ($('#ia-email')?.value || '').trim());
      fd.set('phone', ($('#ia-phone')?.value || '').trim());
      fd.set('college', ($('#ia-college')?.value || '').trim());
      cv.files().forEach((f) => fd.append('cv', f));
      cover.files().forEach((f) => fd.append('cover_letter', f));
      lor.files().forEach((f) => fd.append('lor', f));

      go.disabled = true;
      try {
        const data = await postForm('/api/interns', fd);
        if (!data.ok) { alert('Error: ' + (data.msg || 'Could not add the applicant.')); return; }
        alert(`${name} added under In Process.`);
        newApplicantForm();   // a clean form for the next applicant
      } catch (err) {
        alert(`Could not add the applicant: ${err}`);
      } finally {
        go.disabled = false;
      }
    });
  }

  // ---- Manage Interns -----------------------------------------------------
  let activeStatus = 'in_process';
  const openRows = new Set();   // applicant ids whose details are expanded

  function manageForm() {
    const host = $('#form-host');
    if (!host) return;
    host.innerHTML = '';
    const wrap = el('div', 'form-card intern-card');
    wrap.innerHTML = `
      <h3>Manage Interns</h3>
      <div class="mc-tabs intern-tabs" role="tablist">
        ${STATUS_ORDER.map((s) => `
          <button type="button" class="mc-proc-tab${s === activeStatus ? ' active' : ''}"
                  data-status="${s}" role="tab" aria-selected="${s === activeStatus}">
            ${STATUS_LABELS[s]} <span class="intern-count" data-count="${s}"></span>
          </button>`).join('')}
      </div>
      <div id="im-list" class="results"></div>
    `;
    host.append(wrap);
    wrap.querySelectorAll('.mc-proc-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activeStatus = tab.dataset.status;
        wrap.querySelectorAll('.mc-proc-tab').forEach((t) => {
          const on = t === tab;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', String(on));
        });
        refresh();
      });
    });
    refresh();
  }

  let cache = null;

  async function refresh() {
    const list = document.getElementById('im-list');
    if (!list) return;
    let data;
    try {
      const r = await fetch('/api/interns');
      data = await r.json();
    } catch (err) {
      list.innerHTML = `<div class="result-item">Could not load the applicants: ${escapeHtml(String(err))}</div>`;
      return;
    }
    if (!data.ok) {
      list.innerHTML = `<div class="result-item">${escapeHtml(data.msg || 'Could not load the applicants.')}</div>`;
      return;
    }
    cache = data;
    document.querySelectorAll('.intern-count').forEach((n) => {
      n.textContent = `(${data.counts[n.dataset.count] || 0})`;
    });
    renderList();
  }

  function renderList() {
    const list = document.getElementById('im-list');
    if (!list || !cache) return;
    list.innerHTML = '';
    const rows = cache.applicants.filter((a) => a.status === activeStatus);
    if (!rows.length) {
      list.innerHTML = `<div class="result-item">No applicants under ${STATUS_LABELS[activeStatus]}.</div>`;
      return;
    }
    rows.forEach((a) => {
      list.append(applicantRow(a));
      if (openRows.has(a.id)) list.append(applicantDetail(a));
    });
  }

  function applicantRow(a) {
    const row = el('div', 'result-item folder case-result intern-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(openRows.has(a.id)));
    // Same structure as a case search result: name over a meta line, both
    // inside a flexible wrapper.
    const name = el('div', 'name');
    name.innerHTML = `<i class="fa-solid fa-user-graduate" style="color: var(--accent); margin-right:6px;"></i>${escapeHtml(a.name)}`;
    const meta = el('div', 'case-meta');
    const bits = [];
    if (a.college) bits.push(a.college);
    bits.push(`Applied ${dateIsoToIn(a.applied_on)}`);
    bits.push(`${a.documents.length} document${a.documents.length === 1 ? '' : 's'}`);
    meta.textContent = bits.join(' · ');
    const info = el('div');
    info.style.cssText = 'flex:1;min-width:0;';
    info.append(name, meta);
    row.append(info);
    const toggle = () => {
      if (openRows.has(a.id)) openRows.delete(a.id); else openRows.add(a.id);
      renderList();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return row;
  }

  function applicantDetail(a) {
    const box = el('div', 'intern-detail');
    const ids = {
      name: `im-name-${a.id}`, date: `im-date-${a.id}`, email: `im-email-${a.id}`,
      phone: `im-phone-${a.id}`, college: `im-college-${a.id}`,
    };
    // Each section reads in the order it is used: its title, then what you
    // fill in or drop, then the button that acts on it — never above it.
    box.innerHTML = `
      <div class="intern-section">
        <div class="intern-doc-title">Details</div>
        <div class="form-grid">
          <input type="text" id="${ids.name}" placeholder="Applicant Name *" maxlength="180" />
          <input type="date" id="${ids.date}" />
          <input type="email" id="${ids.email}" placeholder="Email (optional)" maxlength="200" />
          <input type="text" id="${ids.phone}" placeholder="Phone (optional)" maxlength="60" />
          <input type="text" id="${ids.college}" class="full-span" placeholder="College / University (optional)" maxlength="200" />
        </div>
        <div class="form-actions">
          <button type="button" class="btn-secondary" data-act="save">Save Details</button>
        </div>
      </div>
      <div class="intern-doc-grid"></div>
      <div class="form-actions intern-status-actions"></div>
    `;
    // Values set via the DOM, never interpolated into markup.
    box.querySelector(`#${ids.name}`).value = a.name;
    box.querySelector(`#${ids.email}`).value = a.email || '';
    box.querySelector(`#${ids.phone}`).value = a.phone || '';
    box.querySelector(`#${ids.college}`).value = a.college || '';

    // initIndianDateField needs the element in the document.
    queueMicrotask(() => {
      initIndianDateField(ids.date, a.applied_on);
      labelDate(ids.date, 'Date of application');
    });

    box.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const data = await postJSON(`/api/interns/${a.id}`, {
          name: document.getElementById(ids.name).value,
          applied_on: document.getElementById(ids.date).value,
          email: document.getElementById(ids.email).value,
          phone: document.getElementById(ids.phone).value,
          college: document.getElementById(ids.college).value,
        });
        if (!data.ok) { alert('Error: ' + (data.msg || 'Could not save.')); return; }
        await refresh();
      } finally {
        btn.disabled = false;
      }
    });

    const docs = box.querySelector('.intern-doc-grid');
    ['cv', 'cover_letter', 'lor'].forEach((kind) => docs.append(docGroup(a, kind)));

    const actions = box.querySelector('.intern-status-actions');
    STATUS_ORDER.filter((s) => s !== a.status).forEach((s) => {
      const b = el('button', 'btn-secondary');
      b.type = 'button';
      b.textContent = `Move to ${STATUS_LABELS[s]}`;
      b.addEventListener('click', async () => {
        b.disabled = true;
        const data = await postJSON(`/api/interns/${a.id}/status`, { status: s });
        if (!data.ok) { alert('Error: ' + (data.msg || 'Could not change the status.')); b.disabled = false; return; }
        openRows.delete(a.id);
        await refresh();
      });
      actions.append(b);
    });

    // Admins only — the server enforces it too; this just hides a button
    // that would be refused.
    if (CASEORG_IS_ADMIN) {
      const del = el('button', 'btn-danger intern-delete');
      del.type = 'button';
      del.textContent = 'Delete Applicant';
      del.addEventListener('click', async () => {
        const n = a.documents.length;
        const docs = n ? ` and ${n === 1 ? 'their document' : `all ${n} of their documents`}` : '';
        const ok = await openConfirm(`Delete ${a.name}${docs}? This cannot be undone.`);
        if (!ok) return;
        del.disabled = true;
        const data = await postJSON(`/api/interns/${a.id}/delete`);
        if (!data.ok) { alert('Error: ' + (data.msg || 'Could not delete the applicant.')); del.disabled = false; return; }
        openRows.delete(a.id);
        await refresh();
      });
      actions.append(del);
    }
    return box;
  }

  function docGroup(a, kind) {
    // CV and Cover Letter sit side by side; LORs span both columns — the
    // same shape as the details grid above (two fields, then a full row).
    const group = el('div', `intern-doc-group intern-section${kind === 'lor' ? ' full-span' : ''}`);
    const title = el('div', 'intern-doc-title');
    title.textContent = DOC_LABELS[kind];
    group.append(title);

    const have = a.documents.filter((d) => d.kind === kind);
    const list = el('div', 'results');
    have.forEach((d) => {
      const row = el('div', 'result-item');
      const name = el('div', 'name');
      name.textContent = d.name;
      const meta = el('span', 'badge');
      meta.textContent = d.missing ? 'missing on disk' : sizeLabel(d.size);
      const icons = el('div', 'icon-row');
      if (!d.missing) {
        const view = el('button', 'icon-btn');
        view.type = 'button';
        view.title = 'Preview';
        view.innerHTML = '<i class="fa-solid fa-eye"></i><span class="sr-only">Preview</span>';
        view.addEventListener('click', () => openViewer(d, view));
        const dl = el('a', 'icon-btn');
        dl.href = `/api/interns/documents/${d.id}?download=1`;
        dl.title = 'Download';
        dl.innerHTML = '<i class="fa-solid fa-download"></i><span class="sr-only">Download</span>';
        icons.append(view, dl);
      }
      const del = el('button', 'icon-btn');
      del.type = 'button';
      // "Delete" is what the app's red delete-icon rule keys on.
      del.title = 'Delete';
      del.innerHTML = '<i class="fa-solid fa-trash"></i><span class="sr-only">Delete</span>';
      del.addEventListener('click', async () => {
        const ok = await openConfirm(`Remove “${d.name}”? The file is deleted and cannot be recovered.`);
        if (!ok) return;
        const data = await postJSON(`/api/interns/documents/${d.id}/delete`);
        if (!data.ok) { alert('Error: ' + (data.msg || 'Could not remove the document.')); return; }
        await refresh();
      });
      icons.append(del);
      row.append(name, meta, icons);
      list.append(row);
    });
    // An empty slot still gets a row, so CV and Cover Letter — side by side —
    // always line up whether or not each has a file.
    if (!have.length) {
      const none = el('div', 'result-item intern-doc-empty');
      none.textContent = kind === 'lor'
        ? 'No letters of recommendation uploaded'
        : `No ${DOC_LABELS[kind]} uploaded`;
      list.append(none);
    }
    group.append(list);

    const single = kind !== 'lor';
    const prompt = single
      ? `${have.length ? 'Replace' : 'Upload'} ${DOC_LABELS[kind]} — drag & drop or click to select`
      : 'Add Letters of Recommendation — drag & drop or click to select';
    const drop = fileDrop({ prompt, multiple: !single });
    const upload = el('button', 'btn-secondary');
    upload.type = 'button';
    upload.textContent = single ? (have.length ? 'Replace' : 'Upload') : 'Add';
    upload.addEventListener('click', async () => {
      const files = drop.files();
      if (!files.length) { alert('Choose a file first.'); return; }
      const fd = new FormData();
      fd.set('kind', kind);
      files.forEach((f) => fd.append('file', f));
      upload.disabled = true;
      try {
        const data = await postForm(`/api/interns/${a.id}/documents`, fd);
        if (!data.ok) { alert('Error: ' + (data.msg || 'Could not upload.')); return; }
        await refresh();
      } finally {
        upload.disabled = false;
      }
    });
    const actions = el('div', 'form-actions');
    actions.append(upload);
    group.append(drop.node, actions);
    return group;
  }

  // ---- cards --------------------------------------------------------------
  // Identical to the home page: choosing the active card again closes it.
  [
    { card: newCard, handler: newApplicantForm },
    { card: manageCard, handler: manageForm },
  ].forEach(({ card, handler }, _i, all) => {
    const others = all.map((x) => x.card).filter((c) => c !== card);
    const activate = () => {
      if (card.classList.contains('active')) {
        card.classList.remove('active');
        card.setAttribute('aria-pressed', 'false');
        const host = document.getElementById('form-host');
        if (host) host.innerHTML = '';
        return;
      }
      setActive(card, others);
      handler();
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });
})();
