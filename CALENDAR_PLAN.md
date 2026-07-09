# Calendar, Court-Event Tracker & Daily Digest — Implementation Plan

Status: **implemented in v4.6** (2026-07-10). Kept as the design record — the court-API research summary below documents why auto-sync was left out and what the options are if it's ever wanted.

## Context

The firm needs to track, per case: hearing/listing dates (with purpose), filing deadlines (document due by date, later marked filed), appearance records (who appeared, when, in which matter — including non-user senior counsel), and misc deadlines (limitation periods). Required views: per-case timeline (history + upcoming), per-day agenda ("on date D: what's listed / due / filed / who appeared"), a month calendar, and a **daily morning reminder email**.

**User-confirmed decisions:**
- Digest: **morning-of**, default 07:00 (server local = IST), time + on/off configurable in admin Settings. Content: today's listings, filings due today, overdue unfiled, tomorrow look-ahead.
- Recipients: **all active admin/user roles** (never interns); events can optionally be **assigned** to users, who get an "ASSIGNED TO YOU" section in their copy.
- **Court API sync (eCourts/SCI/DHC): OUT OF SCOPE** — research (July 2026) found no free official API for practitioners: NAPIX/NJDG access is institution-gated; SCI exposes only PDF cause lists; DHC has no API. Options if ever needed: paid aggregators (eCourtsIndia ₹/query, Vakeel360, LegalKart — CNR-based) or fragile captcha-solving scrapers (bharat-courts, openjustice-in/ecourts). User chose pure manual entry, no CNR fields, no sync interface.
- Interns: **view-only** — calendar page + read APIs allowed, all writes blocked, excluded from digest.

**Codebase facts (verified):** cases are pure-filesystem `FS_ROOT/YYYY/MMM/Case Name/` triples (no DB rows); DB at schema v7 (`services/db.py`, `_migrate_to_vN` pattern); email via `services/email.py` `send_email`/`send_email_async` (plain-text, SMTP settings + `EmailConfigError`); **no scheduler exists** (Waitress single-process, `serve(threads=16)`; debug branch `app.run(debug=True)`); intern gating = default-deny `_INTERN_ALLOWED_ENDPOINTS` allowlist in app.py; CSRF hook accepts `X-CSRF-Token` header on all mutating methods incl. PUT/DELETE; strict CSP — every inline script needs `nonce="{{ csp_nonce }}"`.

New files: `services/calendar_events.py`, `services/digest.py`, `services/scheduler.py`, `templates/calendar.html`, `static/js/calendar.js`, `static/css/calendar.css`, `tests/test_calendar.py`. Modified: `services/db.py`, `app.py`, `templates/_user_menu.html`, `templates/index.html`, `templates/settings.html`, `debian/changelog`.

---

## 1. DB migration v8 (`services/db.py`)

Bump `_SCHEMA_VERSION = 8`; add `_migrate_to_v8(conn)` + chain step in `_ensure_schema`:

```sql
CREATE TABLE IF NOT EXISTS case_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type       TEXT NOT NULL CHECK(event_type IN ('hearing','filing','appearance','deadline')),
    case_year        TEXT NOT NULL,
    case_month       TEXT NOT NULL,
    case_name        TEXT NOT NULL,
    event_date       TEXT NOT NULL,              -- ISO YYYY-MM-DD (hearing: listing date; filing: DUE date)
    title            TEXT NOT NULL DEFAULT '',   -- filing: document name; others: short label
    purpose          TEXT,                        -- hearing only (Arguments/Evidence/Final Hearing/...)
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','done','adjourned','cancelled')),
    outcome          TEXT,                        -- hearing/appearance outcome notes
    filed_on         TEXT,                        -- filing only: actual filing date (NULL = unfiled)
    related_event_id INTEGER REFERENCES case_events(id) ON DELETE SET NULL,
                     -- hearing: adjourned-to next hearing; appearance: the hearing it records
    notes            TEXT,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_case_events_date     ON case_events(event_date);
CREATE INDEX idx_case_events_case     ON case_events(case_year, case_month, case_name, event_date);
CREATE INDEX idx_case_events_status   ON case_events(status, event_date);
CREATE INDEX idx_case_events_filed_on ON case_events(filed_on) WHERE filed_on IS NOT NULL;
-- + trg_case_events_updated_at trigger (same pattern as trg_users_updated_at)

CREATE TABLE event_participants (            -- who appeared (free-text or user)
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES case_events(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL CHECK(display_name <> '')
);
CREATE TABLE event_assignees (               -- digest call-outs / responsibility
    event_id INTEGER NOT NULL REFERENCES case_events(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, user_id)
);
CREATE TABLE reminder_log (                  -- one-digest-per-day idempotency claim
    digest_date TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recipients_count INTEGER NOT NULL DEFAULT 0,
    detail TEXT
);
```
(+ indexes on the join tables; standard `schema_version='8'` upsert closer.)

Also in db.py: **`open_app_db_direct() -> sqlite3.Connection`** — non-`g` clone of `get_app_db()` (row_factory, `PRAGMA foreign_keys=ON`, `_ensure_schema`) for the scheduler thread. The thread must NEVER call `get_app_db()` (needs app context).

## 2. `services/calendar_events.py` (NEW — all event SQL; every fn takes `conn`)

`VALID_EVENT_TYPES`, `VALID_STATUSES`, `HEARING_PURPOSES` (UI suggestions, free text allowed). Functions:
- `create_event(conn, *, event_type, case_year, case_month, case_name, event_date, title='', purpose=None, status='pending', outcome=None, filed_on=None, related_event_id=None, notes=None, created_by=None, assignee_ids=(), participants=()) -> int`
- `get_event / update_event(whitelisted fields) / delete_event`
- `set_assignees(conn, event_id, user_ids)` / `set_participants(conn, event_id, [{'user_id':int|None,'display_name':str}])` (delete+reinsert)
- `events_for_month(conn, year, month)` — `event_date` in range OR `filed_on` in range (tagged so grid can show "filed" chips)
- `day_agenda(conn, date_iso)` → `{'listings': hearings, 'due': filings+deadlines, 'filed': filed_on=D, 'appearances': [...]}`
- `case_timeline(conn, y, m, name)` — ORDER BY event_date, id
- `mark_filed(conn, event_id, filed_on)` — filing-type only; sets filed_on + status='done'
- `record_appearance(conn, *, case triple, appearance_date, participants, outcome=None, notes=None, hearing_event_id=None, next_date=None, next_purpose=None, assignee_ids=(), created_by=None) -> {'appearance_id', 'next_hearing_id'|None}` — the post-court composite: creates the appearance (linked to the hearing), sets hearing outcome + status ('adjourned' if next_date else 'done'), auto-creates the next hearing (carrying assignees) and links `related_event_id` old→new
- `rename_case_events(conn, y, m, old_name, new_name) -> int` / `delete_case_events(conn, y, m, name) -> int`
- Serializer adds computed `overdue: bool` (unfiled filing / pending deadline past date).

## 3. `services/digest.py` (NEW — pure content builder + sender)

- `collect_digest_data(conn, today)` → buckets `today_hearings / due_today / overdue / tomorrow` + `assigned: {user_id: [events]}`
- `build_digest_body(data, today, *, for_user_id=None) -> str` — **pure** (unit-testable); plain-text sections `== ASSIGNED TO YOU ==` (personalized only), `== TODAY'S LISTINGS (n) ==`, `== FILINGS DUE TODAY ==`, `== OVERDUE / UNFILED ==` (with "N days overdue"), `== TOMORROW ==`
- `get_digest_recipients(conn)` — active users, role in (admin,user)
- `send_daily_digest(today=None, *, force=False) -> {'sent','failed','skipped','empty'}` — opens `open_app_db_direct()`; claim via `INSERT OR IGNORE INTO reminder_log` (rowcount 0 ⇒ skip) unless `force`; shared base body, personalized copy for users with assignments; sequential `send_email()` with per-recipient try/except; empty digest ⇒ skip sending, log `detail='empty'`; updates `reminder_log` detail/count. `force=True` (admin test button) bypasses the log entirely.

## 4. `services/scheduler.py` (NEW — daemon thread, no new deps)

- `_digest_due(now, send_time_raw, already_sent) -> bool` — pure; `_parse_send_time` falls back to 07:00 on bad input
- `_tick(now)`: settings check (`digest_enabled`, `digest_send_time`) → if due, `send_daily_digest()`; conn opened per-wake, closed in `finally`
- `_digest_loop()`: `while not _stop_event.wait(60): try _tick except log` (thread never dies); `start_digest_scheduler()` / `stop_digest_scheduler()` (for tests)
- Settings: `digest_enabled` default **True** (user explicitly wants reminder emails; `EmailConfigError` → warning log, so unconfigured-SMTP installs just log), `digest_send_time` default `"07:00"`. Naive local time (IST server).

## 5. `app.py` — routes, cascades, settings, startup

**Routes** (new section after case APIs; JSON bodies; CSRF automatic):

| Route | Auth | Intern |
|---|---|---|
| `GET /calendar` → `calendar_page()` | `@require_login` | YES |
| `GET /api/calendar/events?year=&month=` → `api_calendar_month` | `@require_login_api` | YES |
| `GET /api/calendar/day?date=` → `api_calendar_day` | `@require_login_api` | YES |
| `GET /api/calendar/case-timeline?year=&month=&case=` → `api_calendar_case_timeline` | `@require_login_api` | YES |
| `GET /api/calendar/assignable-users` (active admin/user `{id,email}`) | `@require_login_api` | no |
| `POST /api/calendar/events` / `PUT+DELETE /api/calendar/events/<int:id>` | `@require_login_api` | no |
| `POST /api/calendar/events/<int:id>/mark-filed` | `@require_login_api` | no |
| `POST /api/calendar/record-appearance` | `@require_login_api` | no |
| `POST /api/calendar/send-test-digest` (`force=True`, friendly 400 on `EmailConfigError`) | `@require_admin_api` | no |

Validation helper `_validate_case_triple`: year `\d{4}`, month in Jan..Dec, non-empty name; dir-exists check on **create** only. Enum/date (`%Y-%m-%d`) validation; assignees must be active non-intern users. Add the 4 read endpoints to `_INTERN_ALLOWED_ENDPOINTS` — writes stay blocked automatically (interns get 403 JSON on `/api/` paths).

**Cascades** (verified insertion points):
- `api_rename_case` — after `source.rename(target)`, when `len(rel.parts) == 3`: `rename_case_events(get_app_db(), *rel.parts, new_name)` + commit, in try/except that logs but never fails the rename (FS is source of truth).
- `api_delete_item` — after `shutil.rmtree(target)`, when `target.is_dir() and depth == 3`: `delete_case_events(...)` + commit, same posture.

**Settings**: `admin_settings()` new branch `elif form_name == "digest":` — checkbox + `HH:MM` validation → `settings_manager.set(...)`; pass current values to template.

**Startup** (`__main__` block): debug branch — start scheduler only when `os.environ.get("WERKZEUG_RUN_MAIN") == "true"` (reloader child; avoids double-start); waitress branch — `start_digest_scheduler()` just before `serve(...)`. Never at import time (pytest never spawns it).

## 6. Frontend

**`templates/calendar.html`** — standard skeleton cloned from invoice.html (theme bootstrap + csrf meta + `static_url` CSS/JS, topbar with `{% include "_user_menu.html" %}`, `_flash.html`, nonce'd `window.CaseOrg` script). Layout `.calendar-layout` (CSS grid `minmax(0,1fr) 380px`, single column <900px): left month-grid card; right `.glow-tabs` panel with **Day** tab (agenda sections Listed/Due/Filed/Appeared with per-item quick actions) and **Case** tab (case search via `/api/cases/search` → vertical timeline with "today" divider). Two modals (existing `.modal` pattern): `#event-modal` (create/edit; type select toggles per-type rows; chained `buildLongListDropdown` case picker on `/api/years`→`/api/months`→`/api/cases`; assignee checkboxes) and `#appearance-modal` (participants = user dropdown or free-text rows; outcome; optional next date+purpose). All mutating controls in `{% if current_user.role != 'intern' %}`.

**`static/js/calendar.js`** — IIFE (invoice.js pattern): `renderMonthGrid` (hand-rolled 7-col CSS grid from `Date` math — no libraries; ≤3 type-colored chips/cell + "+N more"; overdue ring on unfiled-past-due), `loadMonth/loadDay/loadTimeline`, modal open/submit fns, `markFiled`, `deleteEvent` (confirm). Writes: `fetch` with `{'Content-Type':'application/json','X-CSRF-Token':_csrfToken()}`. Deep link: `/calendar?year=&month=&case=` activates Case tab on load.

**`static/css/calendar.css`** — `.cal-grid`, `.cal-cell` (+ `.today`, `.other-month`), `.cal-chip--hearing/--filing/--deadline/--appearance` + `.overdue`, `.agenda-section`, `.timeline-item` + `.timeline-today-divider`, `.participant-row`. Only style.css CSS vars → dark theme automatic.

**Nav**: `_user_menu.html` — Calendar item (`fa-calendar-days`) in the all-roles section (above the intern-excluded block). `index.html` — anchor card `#card-calendar` in main cards-grid **and** in `.intern-welcome .cards-grid` (anchor cards navigate; no main.js change). `settings.html` — "Daily Digest" `.settings-card` in `#panel-system`: enabled checkbox, `<input type="time">`, save (form_name=digest), plus nonce'd-script "Send test digest now" button hitting `/api/calendar/send-test-digest`.

## 7. Tests (`tests/test_calendar.py`; reuse conftest fixtures + test_intern.py `_login_as` pattern)

- Schema: v8 tables/indexes exist; FK cascades event→participants/assignees.
- CRUD APIs: each type; reject bad type/status/date/month; assignee round-trip; intern assignee rejected.
- Day agenda buckets (incl. filing due-but-already-filed not in "due"); month range boundaries; timeline ordering.
- `mark_filed` (400 on non-filing). `record_appearance` composite: links both directions, hearing→adjourned+outcome; without next_date→done.
- Cascades: real tmp dirs; rename → events follow; delete case dir → events gone; deeper-path ops don't touch events.
- Intern: page + 3 read APIs 200; all writes 403.
- Digest: `build_digest_body` pure assertions (sections, overdue day-count, assigned-only personalization, empty→skip); `send_daily_digest` with monkeypatched `send_email` (recipients exclude intern/inactive; personalized vs shared; second call same day → skipped; `force=True` bypasses).
- Scheduler: `_digest_due` matrix; `_tick` no-ops when disabled.

## Verification

1. `cd Root && python3 -m pytest -q` — full suite green (per-test temp DB exercises v8 migration from scratch); plus one manual migration check against a copy of a real `organizer.db` (`schema_version` → 8, data intact).
2. Manual UI: add one event of each type; month chips + day agenda + case timeline; record-appearance flow auto-creates linked next hearing; mark-filed moves item to Filed; deep link works; rename case → events follow; intern sees page but no buttons and writes 403; dark theme pass.
3. Digest without waiting for 07:00: Settings → "Send test digest now"; scheduler path: set send time 2 min ahead, restart, watch log + `reminder_log` row; restart again → no resend; `FLASK_DEBUG=1` → exactly one "scheduler started" log line.
4. Update `debian/changelog`.

## Risks

- **Out-of-band FS renames** (SMB) orphan events — only the two API endpoints cascade; timeline UI must tolerate a missing case dir (link 404s gracefully). Future "orphaned events" admin report possible.
- **Claim-then-send**: crash between claim and SMTP loses that day's digest (visible in `reminder_log.detail`); reverse order risks duplicates — worse.
- **Threads + SQLite**: scheduler uses `open_app_db_direct()` per wake, closed in `finally`; never `get_app_db()`.
- **CHECK rigidity**: new event_type later needs a v7-style table rebuild — accepted, pattern exists.
- **CSP**: every new inline script needs `nonce="{{ csp_nonce }}"`.
