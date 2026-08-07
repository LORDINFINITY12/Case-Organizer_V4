"""Calendar / court-event tracking for Case Organizer.

All SQL for the case_events, event_participants, event_assignees and
event_reminders tables lives here (reminders CRUD is in services/reminders.py).
Cases have no database rows — they are filesystem directories — so every event
references its case by the path triple (case_year, case_month, case_name), and
every query must filter on all three.

``related_event_id`` semantics by event type:
  * hearing     — the next hearing this one was adjourned to
  * appearance  — the hearing this appearance records

v4.8 timing / recurrence / rollover model:
  * ``all_day`` (default 1) + ``start_time``/``end_time`` (HH:MM) give an event
    a clock time.  Overdue is time-aware: a timed item goes overdue once the
    start time passes on its day; an all-day item goes overdue the next day
    (so a legacy all-day row reduces exactly to the old ``event_date < today``).
  * Recurrence (``recur_freq``/``recur_interval``/``recur_until``) is stored as a
    single rule on ``task``/``deadline``/``meeting`` and expanded to virtual
    occurrences at query time — never one row per occurrence.  ``hourly`` means
    "repeat every N hours within the event's active span each day".
  * A ``continuing`` task/deadline appears on every day from its due date until
    ``completed_at`` — also computed at read time.  A back-dated completion
    trims the tail automatically; earlier days stay visible, annotated.

Every function takes an explicit sqlite3 connection so both Flask request
handlers (get_app_db) and the scheduler thread (open_app_db_direct) can share
the logic.  Callers commit.
"""

from __future__ import annotations

import calendar as _calendar
import math
import sqlite3
from contextlib import suppress
from datetime import date, datetime, time as dtime, timedelta
from typing import Any, Dict, Iterable, List, Mapping, Optional

VALID_EVENT_TYPES = {"hearing", "filing", "appearance", "deadline", "task", "meeting"}
VALID_STATUSES = {"pending", "done", "adjourned", "cancelled"}
VALID_RECUR_FREQ = {"hourly", "daily", "weekly", "monthly", "yearly"}

# Event types that may recur / may be "continuing".
RECURRENCE_TYPES = {"task", "deadline", "meeting"}
CONTINUING_TYPES = {"task", "deadline"}

# Cap on generated occurrences per series/window — a belt-and-suspenders guard
# against a pathological rule (day/month windows keep the real count tiny).
_MAX_OCCURRENCES = 10_000

# Suggested hearing purposes for the UI dropdown; free text is also allowed.
HEARING_PURPOSES = [
    "Appearance",
    "Arguments",
    "Evidence",
    "Final Hearing",
    "Judgment",
    "Mention",
    "Directions",
    "Other",
]

# Columns the API may update in place.  completed_at is deliberately excluded —
# completion goes through mark_complete so it can enforce type rules and let the
# route recompute reminders.
_UPDATABLE_FIELDS = {
    "event_date", "title", "purpose", "status", "outcome",
    "filed_on", "notes", "related_event_id",
    "all_day", "start_time", "end_time",
    "recur_freq", "recur_interval", "recur_until", "continuing",
}


# ---------------------------------------------------------------------------
# Time helpers & overdue
# ---------------------------------------------------------------------------

def _parse_hhmm(value: str) -> tuple[int, int]:
    h, m = value.split(":")
    return int(h), int(m)


def _overdue_anchor(row: Mapping[str, Any]) -> datetime:
    """The moment an item first counts as overdue.

    Timed item → its start datetime.  All-day (or timed without a start) →
    midnight of the *next* day, so ``now >= anchor`` reduces exactly to the
    pre-v4.8 ``event_date < today`` test.
    """
    d = date.fromisoformat(row["event_date"])
    if not row["all_day"] and row["start_time"]:
        h, m = _parse_hhmm(row["start_time"])
        return datetime.combine(d, dtime(h, m))
    return datetime.combine(d + timedelta(days=1), dtime(0, 0))


def _is_overdue(row: Mapping[str, Any], now: datetime) -> bool:
    """Filing unfiled past its anchor, or a pending deadline/task past its
    anchor.  Works on a sqlite3.Row or a plain occurrence dict."""
    et = row["event_type"]
    if et == "filing":
        return (row["filed_on"] is None
                and row["status"] not in ("done", "cancelled")
                and now >= _overdue_anchor(row))
    if et in ("deadline", "task"):
        return (row["status"] == "pending"
                and row["completed_at"] is None
                and now >= _overdue_anchor(row))
    return False


def _event_to_dict(
    row: sqlite3.Row,
    assignees: Optional[List[Dict[str, Any]]] = None,
    participants: Optional[List[Dict[str, Any]]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    now = now or datetime.now()
    d = {key: row[key] for key in row.keys()}
    d["overdue"] = _is_overdue(row, now)
    d["is_timed"] = not row["all_day"]
    if assignees is not None:
        d["assignees"] = assignees
    if participants is not None:
        d["participants"] = participants
    return d


def _assignees_for(conn: sqlite3.Connection, event_id: int) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT ea.user_id, u.email
        FROM event_assignees ea JOIN users u ON u.id = ea.user_id
        WHERE ea.event_id = ? ORDER BY u.email
        """,
        (event_id,),
    ).fetchall()
    return [{"user_id": r["user_id"], "email": r["email"]} for r in rows]


def _participants_for(conn: sqlite3.Connection, event_id: int) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT user_id, display_name FROM event_participants WHERE event_id = ? ORDER BY id",
        (event_id,),
    ).fetchall()
    return [{"user_id": r["user_id"], "display_name": r["display_name"]} for r in rows]


def _attach_relations(
    conn: sqlite3.Connection, rows: Iterable[sqlite3.Row], now: Optional[datetime] = None
) -> List[Dict[str, Any]]:
    now = now or datetime.now()
    return [
        _event_to_dict(r, _assignees_for(conn, r["id"]), _participants_for(conn, r["id"]), now)
        for r in rows
    ]


def _attach_dict(conn: sqlite3.Connection, d: Dict[str, Any]) -> Dict[str, Any]:
    """Attach assignees/participants to an already-built (occurrence/rollover) dict."""
    d["assignees"] = _assignees_for(conn, d["id"])
    d["participants"] = _participants_for(conn, d["id"])
    return d


# ---------------------------------------------------------------------------
# Recurrence expansion
# ---------------------------------------------------------------------------

def _add_months(d: date, n: int) -> date:
    """Add n months, clamping to the last valid day (Jan 31 + 1mo -> Feb 28/29)."""
    total = d.month - 1 + n
    y = d.year + total // 12
    mo = total % 12 + 1
    last = _calendar.monthrange(y, mo)[1]
    return date(y, mo, min(d.day, last))


def _advance(d: date, freq: str, interval: int) -> date:
    if freq == "daily":
        return d + timedelta(days=interval)
    if freq == "weekly":
        return d + timedelta(weeks=interval)
    if freq == "monthly":
        return _add_months(d, interval)
    if freq == "yearly":
        return _add_months(d, 12 * interval)
    # 'hourly' advances its date grid by one day (slots handle the hours)
    return d + timedelta(days=1)


def _first_on_or_after(start: date, freq: str, interval: int, win_start: date) -> date:
    if start >= win_start:
        return start
    if freq in ("daily", "hourly"):
        step = interval if freq == "daily" else 1
        k = math.ceil((win_start - start).days / step)
        return start + timedelta(days=k * step)
    if freq == "weekly":
        step = interval * 7
        k = math.ceil((win_start - start).days / step)
        return start + timedelta(days=k * step)
    occ = start  # monthly / yearly: iterate (bounded)
    guard = 0
    while occ < win_start and guard < 100_000:
        occ = _advance(occ, freq, interval)
        guard += 1
    return occ


def _hourly_slots(row: Mapping[str, Any], interval: int) -> List[str]:
    """HH:MM slots from start_time (or 00:00) to end_time (or 23:59) every N hours."""
    sh, sm = _parse_hhmm(row["start_time"]) if row["start_time"] else (0, 0)
    if row["end_time"]:
        eh, em = _parse_hhmm(row["end_time"])
    else:
        eh, em = 23, 59
    cur = sh * 60 + sm
    end = eh * 60 + em
    step = max(1, interval) * 60
    slots: List[str] = []
    while cur <= end:
        slots.append(f"{cur // 60:02d}:{cur % 60:02d}")
        cur += step
    return slots or [f"{sh:02d}:{sm:02d}"]


def expand_occurrences(row: Mapping[str, Any], win_start: date, win_end: date):
    """Yield (occurrence_date, hhmm_or_None) for a base row within a window.

    A row without recur_freq yields at most its own date.  A cancelled series
    yields nothing.  'hourly' yields every day in the span with one slot per
    interval-hours within the event's active time span.
    """
    freq = row["recur_freq"]
    start = date.fromisoformat(row["event_date"])
    base_time = row["start_time"]
    if not freq:
        if win_start <= start <= win_end:
            yield (start, base_time)
        return
    if row["status"] == "cancelled":
        return

    interval = row["recur_interval"] or 1
    until = date.fromisoformat(row["recur_until"]) if row["recur_until"] else None
    hard_stop = win_end if until is None else min(win_end, until)
    if start > hard_stop:
        return

    count = 0
    if freq == "hourly":
        day = _first_on_or_after(start, "hourly", interval, win_start)
        while day <= hard_stop:
            for hhmm in _hourly_slots(row, interval):
                yield (day, hhmm)
                count += 1
                if count >= _MAX_OCCURRENCES:
                    return
            day += timedelta(days=1)
        return

    occ = _first_on_or_after(start, freq, interval, win_start)
    while occ <= hard_stop:
        yield (occ, base_time)
        count += 1
        if count >= _MAX_OCCURRENCES:
            return
        occ = _advance(occ, freq, interval)


def _occurrence_view(
    conn: sqlite3.Connection, row: sqlite3.Row, occ_date: date, occ_time: Optional[str], now: datetime
) -> Dict[str, Any]:
    d = {key: row[key] for key in row.keys()}
    d["event_date"] = occ_date.isoformat()
    d["start_time"] = occ_time
    d["is_timed"] = not row["all_day"]
    d["is_occurrence"] = True
    d["occurrence_of"] = row["id"]
    d["overdue"] = _is_overdue(d, now)
    return _attach_dict(conn, d)


# ---------------------------------------------------------------------------
# Continuing-overdue rollover (computed, no row-per-day)
# ---------------------------------------------------------------------------

def _completion_date(row: Mapping[str, Any]) -> Optional[date]:
    ca = row["completed_at"]
    return date.fromisoformat(ca[:10]) if ca else None


def continuing_view_on(
    conn: sqlite3.Connection, row: sqlite3.Row, D: date, now: datetime
) -> Optional[Dict[str, Any]]:
    """How a continuing task/deadline shows on date D, or None if it does not
    appear.  Appearance span is [due .. completion_date], and for an item that is
    still open it stops at TODAY — a pre-dated completion trims later days for
    free while the days it occupied stay visible and annotated."""
    if not row["continuing"] or row["event_type"] not in CONTINUING_TYPES:
        return None
    due = date.fromisoformat(row["event_date"])
    if D < due:
        return None
    comp = _completion_date(row)
    if comp is not None and D > comp:
        return None
    # An still-open item rolls forward only as far as today.  Without this an
    # overdue task was drawn on every future day for ever (it has no end date),
    # flooding next month and every month after it.
    if comp is None and D > due and D > now.date():
        return None

    d = {key: row[key] for key in row.keys()}
    d["due_date"] = row["event_date"]      # original due date
    d["event_date"] = D.isoformat()        # the day this appearance lands on
    d["is_timed"] = not row["all_day"]
    d["rolled_forward"] = (D > due)
    if comp is not None and D <= comp:
        d["completed_on"] = row["completed_at"]
        # Completing an item does not un-ring the bell: the days it sat past its
        # due date WERE overdue and stay marked so, otherwise a long-overdue
        # task becomes indistinguishable from one done on time the moment it is
        # ticked off, and the history of how late it ran is lost.
        late_days = (D - due).days
        d["overdue"] = late_days > 0
        d["was_overdue"] = late_days > 0
        d["days_late"] = late_days
        total_late = (comp - due).days
        d["display_note"] = (
            f"completed on {comp.isoformat()}"
            + (f" — {total_late} day{'s' if total_late != 1 else ''} overdue"
               if total_late > 0 else " — on time")
        )
    else:
        d["overdue"] = _is_overdue(row, datetime.combine(D, dtime(23, 59)))
    return _attach_dict(conn, d)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def create_event(
    conn: sqlite3.Connection,
    *,
    event_type: str,
    case_year: str,
    case_month: str,
    case_name: str,
    event_date: str,
    title: str = "",
    purpose: Optional[str] = None,
    status: str = "pending",
    outcome: Optional[str] = None,
    filed_on: Optional[str] = None,
    related_event_id: Optional[int] = None,
    notes: Optional[str] = None,
    created_by: Optional[int] = None,
    all_day: bool = True,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    recur_freq: Optional[str] = None,
    recur_interval: int = 1,
    recur_until: Optional[str] = None,
    continuing: bool = False,
    assignee_ids: Iterable[int] = (),
    participants: Iterable[Dict[str, Any]] = (),
) -> int:
    if event_type not in VALID_EVENT_TYPES:
        raise ValueError(f"Invalid event type: {event_type!r}")
    if status not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {status!r}")
    if recur_freq is not None:
        if recur_freq not in VALID_RECUR_FREQ:
            raise ValueError(f"Invalid recurrence: {recur_freq!r}")
        if event_type not in RECURRENCE_TYPES:
            raise ValueError("Recurrence is only allowed on tasks, deadlines and meetings")
    if continuing and event_type not in CONTINUING_TYPES:
        raise ValueError("Only tasks and deadlines can be continuing")
    cur = conn.execute(
        """
        INSERT INTO case_events(
            event_type, case_year, case_month, case_name, event_date,
            title, purpose, status, outcome, filed_on, related_event_id,
            notes, created_by, all_day, start_time, end_time,
            recur_freq, recur_interval, recur_until, continuing
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_type, case_year, case_month, case_name, event_date,
            title, purpose, status, outcome, filed_on, related_event_id,
            notes, created_by, 1 if all_day else 0, start_time, end_time,
            recur_freq, int(recur_interval or 1), recur_until, 1 if continuing else 0,
        ),
    )
    event_id = int(cur.lastrowid)
    if assignee_ids:
        set_assignees(conn, event_id, assignee_ids)
    if participants:
        set_participants(conn, event_id, participants)
    return event_id


def get_event(conn: sqlite3.Connection, event_id: int) -> Optional[Dict[str, Any]]:
    row = conn.execute("SELECT * FROM case_events WHERE id = ?", (event_id,)).fetchone()
    if row is None:
        return None
    return _event_to_dict(row, _assignees_for(conn, event_id), _participants_for(conn, event_id))


def update_event(conn: sqlite3.Connection, event_id: int, fields: Dict[str, Any]) -> bool:
    updates = {k: v for k, v in fields.items() if k in _UPDATABLE_FIELDS}
    if "status" in updates and updates["status"] not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {updates['status']!r}")
    if "recur_freq" in updates and updates["recur_freq"] is not None \
            and updates["recur_freq"] not in VALID_RECUR_FREQ:
        raise ValueError(f"Invalid recurrence: {updates['recur_freq']!r}")
    if "all_day" in updates:
        updates["all_day"] = 1 if updates["all_day"] else 0
    if "continuing" in updates:
        updates["continuing"] = 1 if updates["continuing"] else 0

    # Reopening. completed_at is not a client-updatable field, so without this
    # a task edited from 'done' back to 'pending' kept its completion stamp —
    # and _is_overdue requires completed_at IS NULL, so the item could never
    # become overdue or pending again however it was edited.
    if "status" in updates and updates["status"] != "done":
        updates["completed_at"] = None

    if not updates:
        return False
    sets = ", ".join(f"{col} = ?" for col in updates)
    cur = conn.execute(
        f"UPDATE case_events SET {sets} WHERE id = ?",
        (*updates.values(), event_id),
    )
    return cur.rowcount > 0


# Child tables that hang off an event and are cascaded away with it.
_EVENT_CHILD_TABLES = ("event_participants", "event_assignees", "event_reminders")


def snapshot_event(conn: sqlite3.Connection, event_id: int) -> Optional[Dict[str, Any]]:
    """Capture an event and its children so a delete can be undone.

    Returned as plain dicts, which lets the caller hand it straight back to the
    client and pass it to restore_event() later. Soft-deleting instead would
    mean filtering `deleted_at` in every query in this module, and one missed
    query would put deleted events back on screen.
    """
    row = conn.execute("SELECT * FROM case_events WHERE id = ?", (event_id,)).fetchone()
    if row is None:
        return None
    snap: Dict[str, Any] = {"event": {k: row[k] for k in row.keys()}, "children": {}}
    for table in _EVENT_CHILD_TABLES:
        try:
            rows = conn.execute(
                f"SELECT * FROM {table} WHERE event_id = ?", (event_id,)
            ).fetchall()
        except sqlite3.Error:
            continue
        snap["children"][table] = [{k: r[k] for k in r.keys()} for r in rows]
    return snap


def restore_event(conn: sqlite3.Connection, snap: Mapping[str, Any]) -> Optional[int]:
    """Re-insert a snapshot produced by snapshot_event(), keeping its id.

    Returns the event id, or None if the snapshot is unusable or that id is
    already back (a double-undo, which should be a no-op rather than an error).
    """
    if not isinstance(snap, Mapping):
        return None
    ev = snap.get("event")
    if not isinstance(ev, Mapping) or "id" not in ev:
        return None
    event_id = ev["id"]
    if conn.execute("SELECT 1 FROM case_events WHERE id = ?", (event_id,)).fetchone():
        return event_id

    cols = [c for c in ev.keys()]
    conn.execute(
        f"INSERT INTO case_events ({', '.join(cols)}) "
        f"VALUES ({', '.join('?' for _ in cols)})",
        tuple(ev[c] for c in cols),
    )
    for table, rows in (snap.get("children") or {}).items():
        if table not in _EVENT_CHILD_TABLES:
            continue
        for r in rows or []:
            cols = list(r.keys())
            with suppress(sqlite3.Error):
                conn.execute(
                    f"INSERT INTO {table} ({', '.join(cols)}) "
                    f"VALUES ({', '.join('?' for _ in cols)})",
                    tuple(r[c] for c in cols),
                )
    return event_id


def delete_event(conn: sqlite3.Connection, event_id: int) -> bool:
    cur = conn.execute("DELETE FROM case_events WHERE id = ?", (event_id,))
    return cur.rowcount > 0


def set_assignees(conn: sqlite3.Connection, event_id: int, user_ids: Iterable[int]) -> None:
    conn.execute("DELETE FROM event_assignees WHERE event_id = ?", (event_id,))
    for uid in dict.fromkeys(user_ids):  # de-dupe, keep order
        conn.execute(
            "INSERT INTO event_assignees(event_id, user_id) VALUES(?, ?)",
            (event_id, int(uid)),
        )


def set_participants(
    conn: sqlite3.Connection, event_id: int, participants: Iterable[Dict[str, Any]]
) -> None:
    conn.execute("DELETE FROM event_participants WHERE event_id = ?", (event_id,))
    for p in participants:
        display_name = (p.get("display_name") or "").strip()
        if not display_name:
            raise ValueError("Participant display_name is required")
        user_id = p.get("user_id")
        conn.execute(
            "INSERT INTO event_participants(event_id, user_id, display_name) VALUES(?, ?, ?)",
            (event_id, int(user_id) if user_id is not None else None, display_name),
        )


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

def events_for_month(conn: sqlite3.Connection, year: int, month: int) -> List[Dict[str, Any]]:
    """Every event (and virtual occurrence / rollover appearance) visible in the
    month.  Branch A = plain exact-date rows; B = recurring occurrences;
    C = continuing rollover appearances."""
    now = datetime.now()
    win_start = date(year, month, 1)
    win_end = date(year + 1, 1, 1) - timedelta(days=1) if month == 12 \
        else date(year, month + 1, 1) - timedelta(days=1)
    start = win_start.isoformat()
    end_excl = (win_end + timedelta(days=1)).isoformat()

    # A. plain rows (unchanged query + the two exclusion guards)
    a_rows = conn.execute(
        """
        SELECT * FROM case_events
        WHERE recur_freq IS NULL AND continuing = 0
          AND ((event_date >= ? AND event_date < ?)
               OR (filed_on IS NOT NULL AND filed_on >= ? AND filed_on < ?))
        ORDER BY event_date, id
        """,
        (start, end_excl, start, end_excl),
    ).fetchall()
    out = _attach_relations(conn, a_rows, now)
    for d in out:
        d["filed_in_month"] = bool(d.get("filed_on") and start <= d["filed_on"] < end_excl)

    # B. recurring rows overlapping the window
    b_rows = conn.execute(
        "SELECT * FROM case_events WHERE recur_freq IS NOT NULL "
        "AND event_date <= ? AND (recur_until IS NULL OR recur_until >= ?)",
        (win_end.isoformat(), start),
    ).fetchall()
    for row in b_rows:
        for occ_date, occ_time in expand_occurrences(row, win_start, win_end):
            out.append(_occurrence_view(conn, row, occ_date, occ_time, now))

    # C. continuing rollover rows (recur NULL) overlapping the window
    c_rows = conn.execute(
        "SELECT * FROM case_events WHERE continuing = 1 AND recur_freq IS NULL "
        "AND event_date <= ?",
        (win_end.isoformat(),),
    ).fetchall()
    for row in c_rows:
        due = date.fromisoformat(row["event_date"])
        comp = _completion_date(row)
        if comp is None:
            # Still open: roll forward to today, never into future months.
            last = min(win_end, max(due, now.date()))
        else:
            last = min(win_end, comp)
        day = max(win_start, due)
        while day <= last:
            v = continuing_view_on(conn, row, day, now)
            if v is not None:
                out.append(v)
            day += timedelta(days=1)

    out.sort(key=lambda d: (d["event_date"], d.get("start_time") or "", d["id"]))
    return out


def _day_query(conn, sql, params, now):
    return _attach_relations(conn, conn.execute(sql, params).fetchall(), now)


def day_agenda(conn: sqlite3.Connection, date_iso: str) -> Dict[str, List[Dict[str, Any]]]:
    """What is listed / due / filed / appeared / meeting on the given date."""
    now = datetime.now()
    D = date.fromisoformat(date_iso)

    # A. plain exact-date rows (recur NULL, continuing 0)
    listings = _day_query(
        conn,
        "SELECT * FROM case_events WHERE event_type = 'hearing' AND event_date = ? "
        "AND recur_freq IS NULL AND continuing = 0 ORDER BY id",
        (date_iso,), now)
    due = _day_query(
        conn,
        "SELECT * FROM case_events WHERE event_type IN ('filing','deadline','task') "
        "AND event_date = ? AND recur_freq IS NULL AND continuing = 0 "
        "ORDER BY event_type, id",
        (date_iso,), now)
    meetings = _day_query(
        conn,
        "SELECT * FROM case_events WHERE event_type = 'meeting' AND event_date = ? "
        "AND recur_freq IS NULL ORDER BY id",
        (date_iso,), now)
    filed = _day_query(
        conn,
        "SELECT * FROM case_events WHERE event_type = 'filing' AND filed_on = ? ORDER BY id",
        (date_iso,), now)
    appearances = _day_query(
        conn,
        "SELECT * FROM case_events WHERE event_type = 'appearance' AND event_date = ? "
        "AND recur_freq IS NULL ORDER BY id",
        (date_iso,), now)

    # B. recurring occurrences landing on D
    b_rows = conn.execute(
        "SELECT * FROM case_events WHERE recur_freq IS NOT NULL "
        "AND event_date <= ? AND (recur_until IS NULL OR recur_until >= ?)",
        (date_iso, date_iso),
    ).fetchall()
    for row in b_rows:
        for occ_date, occ_time in expand_occurrences(row, D, D):
            occ = _occurrence_view(conn, row, occ_date, occ_time, now)
            et = row["event_type"]
            if et == "meeting":
                meetings.append(occ)
            elif et == "hearing":
                listings.append(occ)
            elif et in ("filing", "deadline", "task"):
                due.append(occ)

    # C. continuing rollover onto D
    c_rows = conn.execute(
        "SELECT * FROM case_events WHERE continuing = 1 AND recur_freq IS NULL "
        "AND event_date <= ?",
        (date_iso,),
    ).fetchall()
    for row in c_rows:
        v = continuing_view_on(conn, row, D, now)
        if v is not None:
            due.append(v)

    def _sort(items):
        items.sort(key=lambda d: (d.get("start_time") or "99:99", d["event_type"], d["id"]))
        return items

    return {
        "listings": _sort(listings),
        "due": _sort(due),
        "filed": _sort(filed),
        "appearances": _sort(appearances),
        "meetings": _sort(meetings),
    }


def case_timeline(
    conn: sqlite3.Connection, case_year: str, case_month: str, case_name: str
) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT * FROM case_events
        WHERE case_year = ? AND case_month = ? AND case_name = ?
        ORDER BY event_date, id
        """,
        (case_year, case_month, case_name),
    ).fetchall()
    return _attach_relations(conn, rows)


# ---------------------------------------------------------------------------
# Workflow operations
# ---------------------------------------------------------------------------

def mark_filed(conn: sqlite3.Connection, event_id: int, filed_on: str) -> bool:
    """Record that a filing was actually filed.  Filing events only."""
    row = conn.execute(
        "SELECT event_type FROM case_events WHERE id = ?", (event_id,)
    ).fetchone()
    if row is None:
        return False
    if row["event_type"] != "filing":
        raise ValueError("Only filing events can be marked filed")
    conn.execute(
        "UPDATE case_events SET filed_on = ?, status = 'done' WHERE id = ?",
        (filed_on, event_id),
    )
    return True


def mark_complete(conn: sqlite3.Connection, event_id: int, completed_at: str) -> bool:
    """Mark a task/deadline complete at a (possibly back-dated) time.

    ``completed_at`` is an ISO date or datetime and becomes the cutoff for a
    continuing item's rolled-forward appearances.
    """
    row = conn.execute(
        "SELECT event_type FROM case_events WHERE id = ?", (event_id,)
    ).fetchone()
    if row is None:
        return False
    if row["event_type"] not in CONTINUING_TYPES:
        raise ValueError("Only tasks and deadlines can be marked complete")
    conn.execute(
        "UPDATE case_events SET completed_at = ?, status = 'done' WHERE id = ?",
        (completed_at, event_id),
    )
    return True


def record_appearance(
    conn: sqlite3.Connection,
    *,
    case_year: str,
    case_month: str,
    case_name: str,
    appearance_date: str,
    participants: Iterable[Dict[str, Any]],
    outcome: Optional[str] = None,
    notes: Optional[str] = None,
    hearing_event_id: Optional[int] = None,
    next_date: Optional[str] = None,
    next_purpose: Optional[str] = None,
    assignee_ids: Iterable[int] = (),
    created_by: Optional[int] = None,
) -> Dict[str, Optional[int]]:
    """The post-court composite: who appeared + outcome + the next date.

    1. Creates an 'appearance' event (linked to the hearing it records).
    2. If a hearing is given, stores the outcome on it and marks it
       'adjourned' (a next date was taken) or 'done'.
    3. If a next date was taken, creates the next 'hearing' (carrying the
       assignees) and points the old hearing's related_event_id at it.
    """
    appearance_id = create_event(
        conn,
        event_type="appearance",
        case_year=case_year,
        case_month=case_month,
        case_name=case_name,
        event_date=appearance_date,
        title="Appearance",
        outcome=outcome,
        notes=notes,
        related_event_id=hearing_event_id,
        status="done",
        created_by=created_by,
        participants=participants,
    )

    next_hearing_id: Optional[int] = None
    if next_date:
        next_hearing_id = create_event(
            conn,
            event_type="hearing",
            case_year=case_year,
            case_month=case_month,
            case_name=case_name,
            event_date=next_date,
            title="Hearing",
            purpose=next_purpose,
            created_by=created_by,
            assignee_ids=assignee_ids,
        )

    if hearing_event_id is not None:
        conn.execute(
            """
            UPDATE case_events
            SET outcome = COALESCE(?, outcome),
                status = ?,
                related_event_id = COALESCE(?, related_event_id)
            WHERE id = ? AND event_type = 'hearing'
            """,
            (
                outcome,
                "adjourned" if next_date else "done",
                next_hearing_id,
                hearing_event_id,
            ),
        )

    return {"appearance_id": appearance_id, "next_hearing_id": next_hearing_id}


# ---------------------------------------------------------------------------
# Case lifecycle cascades (called by rename-case / delete-item endpoints)
# ---------------------------------------------------------------------------

def rename_case_events(
    conn: sqlite3.Connection, case_year: str, case_month: str,
    old_name: str, new_name: str,
) -> int:
    cur = conn.execute(
        """
        UPDATE case_events SET case_name = ?
        WHERE case_year = ? AND case_month = ? AND case_name = ?
        """,
        (new_name, case_year, case_month, old_name),
    )
    return cur.rowcount


def delete_case_events(
    conn: sqlite3.Connection, case_year: str, case_month: str, case_name: str
) -> int:
    cur = conn.execute(
        """
        DELETE FROM case_events
        WHERE case_year = ? AND case_month = ? AND case_name = ?
        """,
        (case_year, case_month, case_name),
    )
    return cur.rowcount
