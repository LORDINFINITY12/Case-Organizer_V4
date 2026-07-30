/* Calendar / court-event tracker page logic.
   Runs only on /calendar (guards on #cal-month-grid). Interns get the same
   views read-only: mutating buttons are absent from the template and every
   write endpoint 403s them server-side regardless. */

(function () {
  'use strict';

  const grid = document.getElementById('cal-month-grid');
  if (!grid) return;

  /* ---------- helpers ---------- */

  const $id = (s) => document.getElementById(s);
  const csrf = () => (typeof _csrfToken === 'function'
    ? _csrfToken()
    : (document.querySelector('meta[name="csrf-token"]') || {}).content || '');
  const esc = (s) => (typeof escapeHtml === 'function'
    ? escapeHtml(String(s ?? ''))
    : String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c])));

  const readOnly = (window.CaseOrg && window.CaseOrg.role) === 'intern';

  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const TODAY_ISO = fmtDate(new Date());

  function prettyDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  /* ---------- Indian dd/mm/yyyy date fields ----------
     Native <input type="date"> renders in the BROWSER's locale (often
     mm/dd/yyyy) and cannot be forced to dd/mm/yyyy, so the modals use a
     text field in Indian format with a calendar button that opens a hidden
     native picker. */

  function isoToIn(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  function inToIso(text) {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec((text || '').trim());
    if (!m) return null;
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${y}-${p(mo)}-${p(d)}`;
  }

  function initDateField(textId) {
    const input = $id(textId);
    const wrap = input.closest('.cal-date-wrap');
    const native = wrap.querySelector('.cal-date-native');
    const btn = wrap.querySelector('.cal-date-btn');

    // Auto-insert slashes while typing digits (dd/mm/yyyy).
    input.addEventListener('input', (e) => {
      if (e.inputType && e.inputType.startsWith('delete')) return;
      const digits = input.value.replace(/\D/g, '').slice(0, 8);
      let out = digits;
      if (digits.length > 4) out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
      else if (digits.length > 2) out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
      input.value = out;
    });

    btn.addEventListener('click', () => {
      native.value = inToIso(input.value) || TODAY_ISO;
      try { native.showPicker(); } catch (_) { native.click(); }
    });
    native.addEventListener('change', () => {
      if (native.value) input.value = isoToIn(native.value);
    });

    return {
      get() { return inToIso(input.value); },        // ISO or null
      set(iso) { input.value = isoToIn(iso || ''); },
      clear() { input.value = ''; },
    };
  }

  async function api(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        'X-CSRF-Token': csrf(),
        ...(opts.headers || {}),
      },
    });
    return r.json().catch(() => ({ ok: false, msg: 'Bad response' }));
  }

  /* ---------- state ---------- */

  const now = new Date();
  const state = {
    year: now.getFullYear(),
    month: now.getMonth(),        // 0-based
    eventsByDate: new Map(),      // iso date -> [event]
    selectedDay: null,
    users: [],                    // assignable users
    editingEvent: null,           // event dict when editing
    appearanceHearing: null,      // hearing event ctx for the appearance modal
  };

  /* ---------- month grid ---------- */

  const TYPE_LABEL = { hearing: 'H', filing: 'F', deadline: 'D', appearance: 'A', task: 'T', meeting: 'M' };

  // "HH:MM " prefix for timed events (blank for all-day).
  function timePrefix(ev) {
    return (!ev.all_day && ev.start_time) ? `${ev.start_time} ` : '';
  }

  function chipFor(ev, filedChip) {
    const cls = filedChip ? 'filing' : ev.event_type;
    const text = filedChip
      ? `Filed: ${ev.title || ev.case_name}`
      : (ev.event_type === 'hearing'
          ? (ev.purpose ? `${ev.case_name} — ${ev.purpose}` : ev.case_name)
          : `${timePrefix(ev)}${ev.case_name}${ev.title ? ' — ' + ev.title : ''}`);
    const over = !filedChip && ev.overdue ? ' overdue' : '';
    return `<span class="cal-chip cal-chip--${cls}${over}" title="${esc(text)}">` +
           `${TYPE_LABEL[ev.event_type] || '?'} · ${esc(text)}</span>`;
  }

  function renderMonthGrid() {
    const y = state.year;
    const m = state.month;
    $id('cal-title').textContent = new Date(y, m, 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7;   // Monday-first
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < startOffset; i++) {
      const d = new Date(y, m, i - startOffset + 1);
      cells.push({ date: d, other: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(y, m, d), other: false });
    }
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      const d = new Date(last);
      d.setDate(d.getDate() + 1);
      cells.push({ date: d, other: true });
    }

    grid.innerHTML = '';
    cells.forEach(({ date: d, other }) => {
      const iso = fmtDate(d);
      const evs = state.eventsByDate.get(iso) || [];
      const cell = document.createElement('div');
      cell.className = 'cal-cell'
        + (other ? ' other-month' : '')
        + (iso === TODAY_ISO ? ' today' : '')
        + (iso === state.selectedDay ? ' selected' : '');
      cell.setAttribute('role', 'gridcell');
      cell.dataset.date = iso;

      const shown = evs.slice(0, 3);
      const extra = evs.length - shown.length;
      cell.innerHTML = `<span class="cal-cell-num">${d.getDate()}</span>`
        + shown.map((e) => chipFor(e.ev, e.filedChip)).join('')
        + (extra > 0 ? `<span class="cal-more">+${extra} more</span>` : '');

      cell.addEventListener('click', () => selectDay(iso));
      grid.appendChild(cell);
    });
  }

  async function loadMonth() {
    const data = await api(`/api/calendar/events?year=${state.year}&month=${state.month + 1}`);
    state.eventsByDate = new Map();
    if (data.ok) {
      data.events.forEach((ev) => {
        const put = (iso, filedChip) => {
          if (!state.eventsByDate.has(iso)) state.eventsByDate.set(iso, []);
          state.eventsByDate.get(iso).push({ ev, filedChip });
        };
        put(ev.event_date, false);
        if (ev.filed_in_month && ev.filed_on && ev.filed_on !== ev.event_date) {
          put(ev.filed_on, true);
        }
      });
    }
    renderMonthGrid();
  }

  /* ---------- day agenda ---------- */

  function eventActions(ev) {
    if (readOnly) return '';
    const btn = (act, icon, label, danger) =>
      `<button type="button" class="btn-ghost cal-act${danger ? ' cal-act-danger' : ''}" ` +
      `data-act="${act}" data-event-id="${ev.id}" title="${label}">` +
      `<i class="fa-solid ${icon}"></i></button>`;
    let html = '';
    if (ev.event_type === 'hearing' && ev.status === 'pending') {
      html += btn('appear', 'fa-gavel', 'Record appearance');
    }
    if (ev.event_type === 'filing' && !ev.filed_on) {
      html += btn('file', 'fa-check', 'Mark filed (today)');
    }
    if ((ev.event_type === 'task' || ev.event_type === 'deadline')
        && !ev.completed_at && ev.status === 'pending') {
      html += btn('complete', 'fa-circle-check', 'Mark complete');
    }
    html += btn('edit', 'fa-pen', 'Edit');
    html += btn('del', 'fa-trash', 'Delete', true);
    return `<span class="cal-act-row">${html}</span>`;
  }

  function agendaItem(ev) {
    const bits = [];
    if (!ev.all_day && ev.start_time) bits.push(`<span class="cal-time">${esc(ev.start_time)}</span>`);
    if (ev.event_type === 'hearing' && ev.purpose) bits.push(esc(ev.purpose));
    if (ev.event_type !== 'hearing' && ev.title) bits.push(esc(ev.title));
    if (ev.completed_on) {
      bits.push(`<span class="cal-done">✓ ${esc(ev.display_note || ('completed on ' + ev.completed_on))}</span>`);
    } else {
      if (ev.status && ev.status !== 'pending') bits.push(`<em>${esc(ev.status)}</em>`);
      if (ev.overdue) {
        bits.push(`<strong class="overdue-text">${ev.rolled_forward
          ? 'overdue since ' + esc(isoToIn(ev.due_date || ev.event_date)) : 'overdue'}</strong>`);
      }
    }
    if (ev.participants && ev.participants.length) {
      bits.push('by ' + esc(ev.participants.map((p) => p.display_name).join(', ')));
    }
    if (ev.assignees && ev.assignees.length) {
      bits.push(`<span class="cal-assigned">→ ${esc(ev.assignees.map((a) => a.email).join(', '))}</span>`);
    }
    if (ev.outcome) bits.push(esc(ev.outcome));
    return `<div class="agenda-item agenda-item--${ev.event_type}" data-event-id="${ev.id}">
      <div class="agenda-item-main">
        <a href="#" class="agenda-case" data-act="timeline"
           data-year="${esc(ev.case_year)}" data-month="${esc(ev.case_month)}"
           data-case="${esc(ev.case_name)}">${esc(ev.case_name)}</a>
        <span class="agenda-meta">${esc(ev.case_year)}/${esc(ev.case_month)}${bits.length ? ' · ' + bits.join(' · ') : ''}</span>
      </div>
      ${eventActions(ev)}
    </div>`;
  }

  function agendaSection(title, events) {
    // The empty row is keyed like a real agenda item so headers and content
    // stay visually distinct even on an empty day.
    return `<div class="agenda-section">
      <h4>${title} (${events.length})</h4>
      ${events.length ? events.map(agendaItem).join('') : '<div class="agenda-empty">Nothing.</div>'}
    </div>`;
  }

  async function selectDay(iso) {
    state.selectedDay = iso;
    renderMonthGrid();
    activateTab('day');
    $id('day-title').textContent = prettyDate(iso);
    const host = $id('day-agenda');
    host.innerHTML = '<p class="empty-state">Loading…</p>';
    const data = await api(`/api/calendar/day?date=${encodeURIComponent(iso)}`);
    if (!data.ok) { host.innerHTML = `<p class="empty-state">${esc(data.msg || 'Failed')}</p>`; return; }
    host.innerHTML =
      agendaSection('Listed', data.listings) +
      agendaSection('Meetings', data.meetings || []) +
      agendaSection('Due', data.due) +
      agendaSection('Filed', data.filed) +
      agendaSection('Appearances', data.appearances);
  }

  /* ---------- case timeline ---------- */

  const TL_ICON = { hearing: 'fa-scale-balanced', filing: 'fa-file-arrow-up', deadline: 'fa-hourglass-half', appearance: 'fa-gavel', task: 'fa-list-check', meeting: 'fa-people-group' };

  function timelineItem(ev) {
    const bits = [];
    if (ev.purpose) bits.push(esc(ev.purpose));
    if (ev.title && ev.title !== 'Hearing' && ev.title !== 'Appearance') bits.push(esc(ev.title));
    if (ev.status !== 'pending') bits.push(`<em>${esc(ev.status)}</em>`);
    if (ev.filed_on) bits.push(`filed ${esc(isoToIn(ev.filed_on))}`);
    if (ev.overdue) bits.push('<strong class="overdue-text">overdue</strong>');
    if (ev.participants && ev.participants.length) {
      bits.push('by ' + esc(ev.participants.map((p) => p.display_name).join(', ')));
    }
    if (ev.outcome) bits.push(esc(ev.outcome));
    if (ev.notes) bits.push(esc(ev.notes));
    return `<div class="timeline-item timeline-item--${ev.event_type}">
      <span class="timeline-icon"><i class="fa-solid ${TL_ICON[ev.event_type] || 'fa-circle'}"></i></span>
      <div class="timeline-body">
        <div class="timeline-head">
          <span class="timeline-date">${esc(isoToIn(ev.event_date))}</span>
          <span class="timeline-type">${esc(ev.event_type)}</span>
          ${eventActions(ev)}
        </div>
        ${bits.length ? `<div class="timeline-detail">${bits.join(' · ')}</div>` : ''}
      </div>
    </div>`;
  }

  async function loadTimeline(year, month, caseName) {
    activateTab('case');
    $id('timeline-title').textContent = `${caseName} (${year}/${month})`;
    const host = $id('timeline');
    host.innerHTML = '<p class="empty-state">Loading…</p>';
    const qs = new URLSearchParams({ year, month, case: caseName });
    const data = await api(`/api/calendar/case-timeline?${qs}`);
    if (!data.ok) { host.innerHTML = `<p class="empty-state">${esc(data.msg || 'Failed')}</p>`; return; }

    const past = data.events.filter((e) => e.event_date < TODAY_ISO);
    const future = data.events.filter((e) => e.event_date >= TODAY_ISO);
    let html = '';
    if (!data.events.length) html = '<p class="empty-state">No events recorded for this case yet.</p>';
    if (!data.case_exists) {
      html += '<p class="form-help">Note: the case folder was not found on disk (moved or renamed outside the app).</p>';
    }
    html += past.map(timelineItem).join('');
    html += `<div class="timeline-today-divider"><span>Today — ${prettyDate(TODAY_ISO)}</span></div>`;
    html += future.map(timelineItem).join('');
    host.innerHTML = html;
    state.timelineCtx = { year, month, caseName };
  }

  /* ---------- tabs ---------- */

  function activateTab(name) {
    document.querySelectorAll('[data-cal-tab]').forEach((t) => {
      const on = t.dataset.calTab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    ['day', 'case'].forEach((n) => {
      const p = $id('panel-' + n);
      p.classList.toggle('active', n === name);
      p.hidden = n !== name;
    });
  }

  /* ---------- sidebar: side + width, persisted per browser ---------- */

  const layout = $id('calendar-layout');
  const SIDE_KEY = 'caseOrg.cal.side';
  const WIDTH_KEY = 'caseOrg.cal.sideWidth';

  function applySide(side) {
    layout.classList.toggle('side-left', side === 'left');
    try { localStorage.setItem(SIDE_KEY, side); } catch (_) { /* private mode */ }
  }
  try {
    applySide(localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right');
    const w = parseInt(localStorage.getItem(WIDTH_KEY), 10);
    if (w >= 320) layout.style.setProperty('--cal-side-w', w + 'px');
  } catch (_) { /* private mode */ }

  $id('cal-side-toggle')?.addEventListener('click', () => {
    applySide(layout.classList.contains('side-left') ? 'right' : 'left');
  });

  $id('cal-divider')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('cal-resizing');
    const rect = layout.getBoundingClientRect();
    const onMove = (ev) => {
      const sideLeft = layout.classList.contains('side-left');
      let w = sideLeft ? (ev.clientX - rect.left) : (rect.right - ev.clientX);
      w = Math.max(320, Math.min(w, rect.width * 0.5));
      layout.style.setProperty('--cal-side-w', w + 'px');
    };
    const onUp = () => {
      document.body.classList.remove('cal-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        const cur = parseInt(layout.style.getPropertyValue('--cal-side-w'), 10);
        if (cur) localStorage.setItem(WIDTH_KEY, String(cur));
      } catch (_) { /* private mode */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  /* ---------- case search (same lookup as Manage Case) ---------- */

  function wireCaseSearch(inputId, btnId, resultsId, onPick) {
    const input = $id(inputId);
    const btn = $id(btnId);
    const results = $id(resultsId);
    if (!input || !btn || !results) return;

    async function run() {
      const q = input.value.trim();
      if (!q) { results.hidden = true; results.innerHTML = ''; return; }
      results.hidden = false;
      results.innerHTML = '<p class="empty-state">Searching…</p>';
      const data = await api(`/api/cases/search?${new URLSearchParams({ q })}`);
      const list = data.cases || [];
      if (!list.length) {
        results.innerHTML = '<p class="empty-state">No cases found.</p>';
        return;
      }
      results.innerHTML = '';
      list.forEach((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cal-case-hit';
        b.innerHTML = `${esc(item.case)}<span class="meta">${esc(item.month)} ${esc(item.year)}</span>`;
        b.addEventListener('click', () => {
          results.hidden = true;
          input.value = item.case;
          onPick(item.year, item.month, item.case);
        });
        results.appendChild(b);
      });
    }

    btn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
    });
  }

  /* ---------- chained case pickers (year -> month -> case) ---------- */

  function initCasePicker(prefix, onPick) {
    const yearSel = $id(`${prefix}-year`);
    const monthSel = $id(`${prefix}-month`);
    const caseSel = $id(`${prefix}-case`);

    function fill(sel, placeholder, values) {
      sel.innerHTML = `<option value="">${placeholder}</option>`;
      (values || []).forEach((v) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = v; sel.appendChild(o);
      });
    }

    async function loadYears() {
      const data = await api('/api/years');
      fill(yearSel, 'Year', data.years);
    }
    async function loadMonths(year) {
      fill(monthSel, 'Month', []);
      fill(caseSel, 'Case (Petitioner v. Respondent)', []);
      caseSel.disabled = true;
      monthSel.disabled = !year;
      if (!year) return;
      const data = await api(`/api/months?${new URLSearchParams({ year })}`);
      fill(monthSel, 'Month', data.months);
    }
    async function loadCases(year, month) {
      fill(caseSel, 'Case (Petitioner v. Respondent)', []);
      caseSel.disabled = !month;
      if (!month) return;
      const data = await api(`/api/cases?${new URLSearchParams({ year, month })}`);
      fill(caseSel, 'Case (Petitioner v. Respondent)', data.cases);
    }

    yearSel.addEventListener('change', () => loadMonths(yearSel.value));
    monthSel.addEventListener('change', () => loadCases(yearSel.value, monthSel.value));
    caseSel.addEventListener('change', () => {
      if (caseSel.value && typeof onPick === 'function') {
        onPick(yearSel.value, monthSel.value, caseSel.value);
      }
    });

    const yearsReady = loadYears();
    return {
      get() {
        return { year: yearSel.value, month: monthSel.value, case: caseSel.value };
      },
      // Awaits each fetch instead of racing it — a slow /api/months or
      // /api/cases response used to leave month/case unpopulated.
      async set(year, month, caseName) {
        await yearsReady;
        yearSel.value = String(year);
        await loadMonths(String(year));
        monthSel.value = String(month);
        await loadCases(String(year), String(month));
        caseSel.value = String(caseName);
      },
      lock(on) {
        [yearSel, monthSel, caseSel].forEach((s) => { s.disabled = on; });
      },
    };
  }

  /* ---------- modals ---------- */

  function openModal(id) {
    const m = $id(id);
    m.hidden = false;
    m.setAttribute('aria-hidden', 'false');
  }
  function closeModal(id) {
    const m = $id(id);
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
  }
  document.querySelectorAll('[data-close-modal]').forEach((b) =>
    b.addEventListener('click', () => closeModal(b.dataset.closeModal)));

  const dateFields = {
    ev: initDateField('ev-date'),
    ap: initDateField('ap-date'),
    apNext: initDateField('ap-next-date'),
  };

  async function loadUsers() {
    if (readOnly || state.users.length) return;
    const data = await api('/api/calendar/assignable-users');
    if (data.ok) state.users = data.users;
  }

  function renderAssignees(hostId, selected = []) {
    const host = $id(hostId);
    const sel = new Set(selected.map(Number));
    host.innerHTML = state.users.map((u) =>
      `<label class="assignee-option">
        <input type="checkbox" value="${u.id}" ${sel.has(u.id) ? 'checked' : ''}> ${esc(u.email)}
      </label>`).join('') || '<p class="empty-state">No users.</p>';
  }
  const checkedIds = (hostId) =>
    [...$id(hostId).querySelectorAll('input:checked')].map((i) => Number(i.value));

  /* ----- event modal ----- */

  let eventPicker = null;

  // Tasks & deadlines: recurrence is automatic — an all-day one repeats daily
  // until marked complete; a fixed-time one is a one-off. Show a note instead
  // of a control. (Meetings keep an explicit recurrence selector.)
  function updateContinuingHint() {
    const t = $id('ev-type').value;
    const hint = $id('ev-continuing-hint');
    if (!hint) return;
    const taskish = (t === 'task' || t === 'deadline');
    hint.hidden = !taskish;
    if (taskish) {
      hint.textContent = $id('ev-all-day').checked
        ? '↻ Repeats every day until marked complete.'
        : 'One-time — fixed at the time above.';
    }
  }
  function syncEventTypeFields() {
    const t = $id('ev-type').value;
    $id('ev-purpose-field').hidden = t !== 'hearing';
    $id('ev-title-field').hidden = t === 'hearing';
    // Explicit recurrence selector is for meetings only.
    const isMeeting = (t === 'meeting');
    $id('ev-recur-field').hidden = !isMeeting;
    if (!isMeeting) $id('ev-recur-extra').hidden = true;
    $id('ev-reminders-field').hidden = (t === 'appearance');
    updateContinuingHint();
  }
  $id('ev-type')?.addEventListener('change', syncEventTypeFields);

  // All-day toggle: the start/end box stays on screen (right of All day) but
  // is faded + read-only when all-day is on, and becomes writable when it's off.
  function syncAllDay() {
    const el = $id('ev-all-day');
    const allDay = el.checked;
    el.dataset.on = allDay ? '1' : '0';
    $id('ev-time-fields').classList.toggle('is-disabled', allDay);
    $id('ev-start-time').disabled = allDay;
    $id('ev-end-time').disabled = allDay;
  }
  // A lone radio can't untick itself on re-click, so drive All day as a toggle.
  $id('ev-all-day')?.addEventListener('click', () => {
    const el = $id('ev-all-day');
    el.checked = el.dataset.on !== '1';
    syncAllDay();
    updateContinuingHint();
  });
  // Recurrence frequency reveals interval/until (meetings).
  $id('ev-recur-freq')?.addEventListener('change', () => {
    $id('ev-recur-extra').hidden = !$id('ev-recur-freq').value;
  });

  /* ----- reminder rows ----- */
  // Which "every" cadences are offered for each "from … before" lead time
  // (value = lead in minutes → list of [repeat_every, label]). The lead is
  // chosen first; only then does the every option appear, with reasonable splits.
  const EVERY_BY_LEAD = {
    '30':    [['10min','10 min'], ['15min','15 min']],
    '60':    [['10min','10 min'], ['15min','15 min'], ['30min','30 min']],
    '720':   [['30min','30 min'], ['hourly','hour'], ['3hourly','3 hours'], ['6hourly','6 hours']],
    '1440':  [['hourly','hour'], ['3hourly','3 hours'], ['6hourly','6 hours'], ['12hourly','12 hours']],
    '10080': [['hourly','hour'], ['12hourly','12 hours'], ['daily','day']],
    '43200': [['weekly','week'], ['daily','day']],
  };
  function reminderRow(spec) {
    spec = spec || {};
    const row = document.createElement('div');
    row.className = 'cal-reminder-row';
    row.innerHTML =
      `<div class="rem-main">
         <select class="rem-kind">
           <option value="at_event">At the event time</option>
           <option value="at_time">At a set time that day</option>
           <option value="repeating">Repeating before</option>
         </select>
         <button type="button" class="btn-ghost rem-del" title="Remove reminder" aria-label="Remove reminder">
           <i class="fa-solid fa-xmark"></i></button>
       </div>
       <label class="rem-extra rem-attime-wrap" hidden>At <input type="time" class="rem-attime" /></label>
       <div class="rem-extra rem-repeat" hidden>
         <label class="rem-lead-field">From
           <select class="rem-lead-sel">
             <option value="">choose…</option>
             <option value="30">30 min</option>
             <option value="60">1 hour</option>
             <option value="720">12 hours</option>
             <option value="1440">1 day</option>
             <option value="10080">1 week</option>
             <option value="43200">1 month</option>
           </select></label>
         <span class="rem-before-word" hidden>before</span>
         <label class="rem-every-wrap" hidden>every
           <select class="rem-every"></select></label>
       </div>`;
    const kind = row.querySelector('.rem-kind');
    const attime = row.querySelector('.rem-attime');
    const repeat = row.querySelector('.rem-repeat');
    const leadSel = row.querySelector('.rem-lead-sel');
    const everyWrap = row.querySelector('.rem-every-wrap');
    const everySel = row.querySelector('.rem-every');
    const beforeWord = row.querySelector('.rem-before-word');
    const sync = () => {
      row.querySelector('.rem-attime-wrap').hidden = kind.value !== 'at_time';
      repeat.hidden = kind.value !== 'repeating';
    };
    function populateEvery(keep) {
      const opts = EVERY_BY_LEAD[leadSel.value] || [];
      everySel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      // "before" belongs to the cadence phrase, so it only appears once a lead
      // has been picked — otherwise it dangles on its own at the row's centre.
      everyWrap.hidden = !opts.length;
      beforeWord.hidden = !opts.length;
      if (opts.length) {
        everySel.value = (keep && opts.some(([v]) => v === keep)) ? keep : opts[0][0];
      }
    }
    kind.addEventListener('change', sync);
    leadSel.addEventListener('change', () => populateEvery());
    row.querySelector('.rem-del').addEventListener('click', () => row.remove());
    if (spec.kind) kind.value = spec.kind;
    if (spec.at_time) attime.value = spec.at_time;
    if (spec.lead_minutes != null) leadSel.value = String(spec.lead_minutes);
    populateEvery(spec.repeat_every);
    sync();
    // Match the home-page dropdowns: use the shared Long-List Dropdown.
    if (typeof convertAllSelectsToLLD === 'function') convertAllSelectsToLLD(row);
    return row;
  }
  $id('ev-add-reminder')?.addEventListener('click', () => {
    $id('ev-reminders-list').appendChild(reminderRow());
  });
  // Convert the modals' static <select>s to the same dropdown component the rest
  // of the app uses, so calendar dropdowns are identical to the home page.
  if (typeof convertAllSelectsToLLD === 'function') {
    ['event-modal', 'appearance-modal'].forEach((id) => {
      const m = document.getElementById(id);
      if (m) convertAllSelectsToLLD(m);
    });
  }
  function collectReminders() {
    return [...document.querySelectorAll('#ev-reminders-list .cal-reminder-row')].map((r) => {
      const kind = r.querySelector('.rem-kind').value;
      if (kind === 'at_time') {
        const at = r.querySelector('.rem-attime').value;
        return at ? { kind, at_time: at } : null;
      }
      if (kind === 'repeating') {
        const lead = Number(r.querySelector('.rem-lead-sel').value) || 0;
        const every = r.querySelector('.rem-every').value;
        if (!lead || !every) return null;   // needs a "from … before" and an "every"
        return { kind, repeat_every: every, lead_minutes: lead };
      }
      return { kind: 'at_event' };
    }).filter(Boolean);
  }

  async function openEventModal(existing, presetDate) {
    await loadUsers();
    state.editingEvent = existing || null;
    $id('event-modal-title').textContent = existing ? 'Edit Event' : 'Add Event';
    $id('ev-type').value = existing ? existing.event_type : 'hearing';
    $id('ev-type').disabled = !!existing;
    dateFields.ev.set(existing ? existing.event_date : (presetDate || TODAY_ISO));
    $id('ev-title').value = existing ? (existing.title || '') : '';
    $id('ev-purpose').value = existing ? (existing.purpose || '') : '';
    $id('ev-notes').value = existing ? (existing.notes || '') : '';
    $id('ev-status-field').hidden = !existing;
    if (existing) $id('ev-status').value = existing.status;
    renderAssignees('ev-assignees', (existing?.assignees || []).map((a) => a.user_id));

    // Timing / recurrence / continuing
    const allDay = existing ? !!existing.all_day : true;
    $id('ev-all-day').checked = allDay;
    $id('ev-start-time').value = existing ? (existing.start_time || '') : '';
    $id('ev-end-time').value = existing ? (existing.end_time || '') : '';
    syncAllDay();
    $id('ev-recur-freq').value = existing ? (existing.recur_freq || '') : '';
    $id('ev-recur-interval').value = existing ? (existing.recur_interval || 1) : 1;
    $id('ev-recur-until').value = (existing && existing.recur_until) ? isoToIn(existing.recur_until) : '';
    $id('ev-recur-extra').hidden = !$id('ev-recur-freq').value;
    $id('ev-continuing').checked = existing ? !!existing.continuing : false;

    // Reminders — load existing on edit
    $id('ev-reminders-list').innerHTML = '';
    if (existing) {
      const rl = await api(`/api/calendar/events/${existing.id}/reminders`);
      (rl.reminders || []).forEach((r) => $id('ev-reminders-list').appendChild(reminderRow(r)));
    }
    syncEventTypeFields();

    if (!eventPicker) {
      eventPicker = initCasePicker('ev');
      wireCaseSearch('ev-case-q', 'ev-case-q-btn', 'ev-case-results',
        (y, m, c) => eventPicker.set(y, m, c));
    }
    const evSearch = $id('ev-case-q').parentElement;
    $id('ev-case-q').value = '';
    $id('ev-case-results').hidden = true;
    if (existing) {
      await eventPicker.set(existing.case_year, existing.case_month, existing.case_name);
      eventPicker.lock(true);
      evSearch.hidden = true;
    } else {
      eventPicker.lock(false);
      evSearch.hidden = false;
    }
    openModal('event-modal');
  }

  $id('ev-save')?.addEventListener('click', async () => {
    const editing = state.editingEvent;
    const eventDate = dateFields.ev.get();
    if (!eventDate) { alert('Enter the date as dd/mm/yyyy.'); return; }
    const allDay = $id('ev-all-day').checked;
    const evType = $id('ev-type').value;
    const taskish = (evType === 'task' || evType === 'deadline');
    // Tasks/deadlines auto-continue: all-day ones roll forward daily until
    // marked complete; fixed-time ones are one-off. Explicit recurrence is
    // meetings-only.
    const continuing = taskish && allDay;
    const freq = (evType === 'meeting') ? $id('ev-recur-freq').value : '';
    const payload = {
      event_date: eventDate,
      title: $id('ev-title').value,
      purpose: $id('ev-purpose').value,
      notes: $id('ev-notes').value,
      assignee_ids: checkedIds('ev-assignees'),
      all_day: allDay,
      start_time: allDay ? null : ($id('ev-start-time').value || null),
      end_time: allDay ? null : ($id('ev-end-time').value || null),
      continuing: continuing,
      recur_freq: freq || null,
      recur_interval: freq ? (Number($id('ev-recur-interval').value) || 1) : 1,
      recur_until: freq ? (inToIso($id('ev-recur-until').value) || null) : null,
      reminders: $id('ev-reminders-field').hidden ? [] : collectReminders(),
    };
    let data;
    if (editing) {
      payload.status = $id('ev-status').value;
      data = await api(`/api/calendar/events/${editing.id}`, {
        method: 'PUT', body: JSON.stringify(payload),
      });
    } else {
      const c = eventPicker.get();
      Object.assign(payload, {
        event_type: $id('ev-type').value,
        case_year: c.year, case_month: c.month, case_name: c.case,
      });
      data = await api('/api/calendar/events', {
        method: 'POST', body: JSON.stringify(payload),
      });
    }
    if (!data.ok) { alert(data.msg || 'Save failed'); return; }
    closeModal('event-modal');
    await refreshAll();
  });

  /* ----- appearance modal ----- */

  let appearancePicker = null;

  function participantRow(preset) {
    const row = document.createElement('div');
    row.className = 'participant-row';
    const userOpts = state.users.map((u) =>
      `<option value="${u.id}">${esc(u.email)}</option>`).join('');
    row.innerHTML = `
      <select class="pr-user" aria-label="Team member">
        <option value="">Other (type name)</option>${userOpts}
      </select>
      <input type="text" class="pr-name" maxlength="120" placeholder="Name (e.g. Sr. Adv. Rao)" />
      <button type="button" class="btn-ghost pr-remove" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button>`;
    const sel = row.querySelector('.pr-user');
    const name = row.querySelector('.pr-name');
    sel.addEventListener('change', () => {
      name.hidden = !!sel.value;
      if (sel.value) name.value = '';
      row.classList.toggle('pr-has-user', !!sel.value);
    });
    row.querySelector('.pr-remove').addEventListener('click', () => row.remove());
    if (preset && preset.user_id) {
      sel.value = String(preset.user_id); name.hidden = true;
      row.classList.add('pr-has-user');
    } else if (preset) name.value = preset.display_name || '';
    return row;
  }

  $id('ap-add-participant')?.addEventListener('click', () =>
    $id('ap-participants').appendChild(participantRow()));

  async function openAppearanceModal(hearing) {
    await loadUsers();
    state.appearanceHearing = hearing || null;
    dateFields.ap.set(TODAY_ISO);
    $id('ap-outcome').value = '';
    dateFields.apNext.clear();
    $id('ap-next-purpose').value = '';
    const host = $id('ap-participants');
    host.innerHTML = '';
    host.appendChild(participantRow());
    renderAssignees('ap-assignees', (hearing?.assignees || []).map((a) => a.user_id));

    if (!appearancePicker) {
      appearancePicker = initCasePicker('ap');
      wireCaseSearch('ap-case-q', 'ap-case-q-btn', 'ap-case-results',
        (y, m, c) => appearancePicker.set(y, m, c));
    }
    const apSearch = $id('ap-case-q').parentElement;
    $id('ap-case-q').value = '';
    $id('ap-case-results').hidden = true;
    const ctxEl = $id('ap-hearing-context');
    if (hearing) {
      await appearancePicker.set(hearing.case_year, hearing.case_month, hearing.case_name);
      appearancePicker.lock(true);
      apSearch.hidden = true;
      ctxEl.hidden = false;
      $id('ap-hearing-label').textContent =
        `Recording against the hearing listed on ${isoToIn(hearing.event_date)}` +
        (hearing.purpose ? ` (${hearing.purpose})` : '');
    } else {
      appearancePicker.lock(false);
      apSearch.hidden = false;
      ctxEl.hidden = true;
    }
    openModal('appearance-modal');
  }

  $id('ap-save')?.addEventListener('click', async () => {
    const c = appearancePicker.get();
    const appearanceDate = dateFields.ap.get();
    if (!appearanceDate) { alert('Enter the appearance date as dd/mm/yyyy.'); return; }
    const nextDateRaw = $id('ap-next-date').value.trim();
    const nextDate = dateFields.apNext.get();
    if (nextDateRaw && !nextDate) { alert('Enter the next hearing date as dd/mm/yyyy.'); return; }
    const participants = [...$id('ap-participants').querySelectorAll('.participant-row')]
      .map((row) => {
        const uid = row.querySelector('.pr-user').value;
        const name = row.querySelector('.pr-name').value.trim();
        if (uid) return { user_id: Number(uid) };
        if (name) return { display_name: name };
        return null;
      }).filter(Boolean);
    const payload = {
      case_year: c.year, case_month: c.month, case_name: c.case,
      appearance_date: appearanceDate,
      participants,
      outcome: $id('ap-outcome').value,
      next_date: nextDate || '',
      next_purpose: $id('ap-next-purpose').value,
      assignee_ids: checkedIds('ap-assignees'),
      hearing_event_id: state.appearanceHearing ? state.appearanceHearing.id : null,
    };
    const data = await api('/api/calendar/record-appearance', {
      method: 'POST', body: JSON.stringify(payload),
    });
    if (!data.ok) { alert(data.msg || 'Save failed'); return; }
    closeModal('appearance-modal');
    await refreshAll();
  });

  /* ---------- shared actions (agenda + timeline) ---------- */

  async function getEvent(id) {
    // Events are cached per-month; fall back to the day agenda copies.
    for (const list of state.eventsByDate.values()) {
      for (const { ev } of list) if (ev.id === id) return ev;
    }
    return null;
  }

  document.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-act]');
    if (!link) return;
    const act = link.dataset.act;

    if (act === 'timeline') {
      e.preventDefault();
      loadTimeline(link.dataset.year, link.dataset.month, link.dataset.case);
      return;
    }

    const id = Number(link.dataset.eventId);
    if (!id) return;

    if (act === 'del') {
      if (!confirm('Delete this event?')) return;
      const data = await api(`/api/calendar/events/${id}`, { method: 'DELETE' });
      if (!data.ok) { alert(data.msg || 'Delete failed'); return; }
      await refreshAll();
    } else if (act === 'file') {
      const data = await api(`/api/calendar/events/${id}/mark-filed`, {
        method: 'POST', body: JSON.stringify({}),
      });
      if (!data.ok) { alert(data.msg || 'Failed'); return; }
      await refreshAll();
    } else if (act === 'complete') {
      const input = prompt('Mark complete — completion date (dd/mm/yyyy). You can back-date.',
        isoToIn(TODAY_ISO));
      if (input === null) return;
      const iso = inToIso(input);
      if (!iso) { alert('Enter the date as dd/mm/yyyy.'); return; }
      const data = await api(`/api/calendar/events/${id}/mark-complete`, {
        method: 'POST', body: JSON.stringify({ completed_at: iso }),
      });
      if (!data.ok) { alert(data.msg || 'Failed'); return; }
      await refreshAll();
    } else if (act === 'edit' || act === 'appear') {
      let ev = await getEvent(id);
      if (!ev) {
        // Not in the month cache (e.g. timeline of another month) — refetch day.
        const day = link.closest('[data-event-id]');
        ev = null;
      }
      if (!ev && state.timelineCtx) {
        const qs = new URLSearchParams({
          year: state.timelineCtx.year, month: state.timelineCtx.month,
          case: state.timelineCtx.caseName,
        });
        const data = await api(`/api/calendar/case-timeline?${qs}`);
        if (data.ok) ev = data.events.find((x) => x.id === id) || null;
      }
      if (!ev) { alert('Event not found'); return; }
      if (act === 'edit') openEventModal(ev);
      else openAppearanceModal(ev);
    }
  });

  async function refreshAll() {
    await loadMonth();
    if (state.selectedDay) await selectDay(state.selectedDay);
    if (state.timelineCtx) {
      await loadTimeline(state.timelineCtx.year, state.timelineCtx.month, state.timelineCtx.caseName);
      activateTab(state.selectedDay ? 'day' : 'case');
    }
  }

  /* ---------- wiring ---------- */

  $id('cal-prev').addEventListener('click', () => {
    state.month -= 1;
    if (state.month < 0) { state.month = 11; state.year -= 1; }
    loadMonth();
  });
  $id('cal-next').addEventListener('click', () => {
    state.month += 1;
    if (state.month > 11) { state.month = 0; state.year += 1; }
    loadMonth();
  });
  $id('cal-prev-year').addEventListener('click', () => {
    state.year -= 1;
    loadMonth();
  });
  $id('cal-next-year').addEventListener('click', () => {
    state.year += 1;
    loadMonth();
  });
  $id('cal-today').addEventListener('click', () => {
    state.year = now.getFullYear();
    state.month = now.getMonth();
    loadMonth().then(() => selectDay(TODAY_ISO));
  });

  document.querySelectorAll('[data-cal-tab]').forEach((t) =>
    t.addEventListener('click', () => activateTab(t.dataset.calTab)));

  $id('btn-add-event')?.addEventListener('click', () =>
    openEventModal(null, state.selectedDay));
  $id('btn-record-appearance')?.addEventListener('click', () =>
    openAppearanceModal(null));

  const timelinePicker = initCasePicker('tl', (y, m, c) => loadTimeline(y, m, c));
  wireCaseSearch('tl-search-q', 'tl-search-btn', 'tl-search-results', (y, m, c) => {
    timelinePicker.set(y, m, c);   // reflect the pick in the dropdowns
    loadTimeline(y, m, c);
  });

  /* Deep link: /calendar?year=2025&month=Jan&case=Foo%20v.%20Bar */
  const params = new URLSearchParams(location.search);
  const dlYear = params.get('year');
  const dlMonth = params.get('month');
  const dlCase = params.get('case');

  loadMonth().then(async () => {
    if (dlYear && dlMonth && dlCase) {
      await timelinePicker.set(dlYear, dlMonth, dlCase);
      loadTimeline(dlYear, dlMonth, dlCase);
    } else {
      selectDay(TODAY_ISO);
    }
  });
})();
