"""Per-event reminders for the calendar / event manager (v4.8).

A reminder belongs to an event and fires to the event's **assignees** via both
an SMTP email and an internal inbox message.  The 60s scheduler thread drives
firing (``fire_due_reminders``); everything here takes an explicit connection
and is safe to call from that thread (it never uses Flask's ``g``-bound
``get_app_db`` — internal messages are inserted directly, sent from the reserved
system account).

Three reminder kinds:
  * ``at_event``  — fire at the event's start datetime (all-day → midnight).
  * ``at_time``   — fire at ``at_time`` (HH:MM) on the event day (good for
                    all-day events with no natural time).
  * ``repeating`` — fire every ``repeat_every`` (30min/hourly/daily) starting
                    ``lead_minutes`` before the event, stopping at the event.

On a **recurring** event, a reminder re-arms to the next occurrence after each
fire, so one reminder row drives the whole series.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import date, datetime, time as dtime, timedelta
from typing import Any, Dict, List, Optional

from services import calendar_events as cal
from services.db import SYSTEM_USER_EMAIL, open_app_db_direct
from services.email import EmailConfigError, send_email

log = logging.getLogger(__name__)

VALID_REMINDER_KINDS = {"at_event", "at_time", "repeating"}
_STEP_MINUTES = {
    "10min": 10, "15min": 15, "30min": 30,
    "hourly": 60, "3hourly": 180, "6hourly": 360, "12hourly": 720,
    "daily": 1440, "weekly": 10080,
}
VALID_REPEAT_EVERY = set(_STEP_MINUTES)

# How far ahead to look for the next occurrence of a recurring event when
# scheduling a reminder (2 years — well beyond any realistic lead time).
_LOOKAHEAD_DAYS = 730


# ---------------------------------------------------------------------------
# Fire-time computation
# ---------------------------------------------------------------------------

def _anchor_dt(event: Dict[str, Any], occ_date: date, occ_time: Optional[str]) -> datetime:
    """The start datetime of one occurrence (midnight for all-day / untimed)."""
    if event["all_day"] or not occ_time:
        return datetime.combine(occ_date, dtime(0, 0))
    h, m = cal._parse_hhmm(occ_time)
    return datetime.combine(occ_date, dtime(h, m))


def _occurrence_anchors(event: Dict[str, Any], after: datetime):
    """Yield occurrence start datetimes from ``after``'s date forward.

    Non-recurring events yield exactly their own anchor; recurring events yield
    their occurrences within a bounded look-ahead window.
    """
    if event.get("recur_freq"):
        win_start = after.date()
        win_end = win_start + timedelta(days=_LOOKAHEAD_DAYS)
        for occ_date, occ_time in cal.expand_occurrences(event, win_start, win_end):
            yield _anchor_dt(event, occ_date, occ_time)
    else:
        occ_date = date.fromisoformat(event["event_date"])
        yield _anchor_dt(event, occ_date, event.get("start_time"))


def compute_next_fire(
    event: Dict[str, Any], reminder: Dict[str, Any], after: datetime
) -> Optional[datetime]:
    """Earliest fire datetime strictly after ``after`` (None if the reminder has
    no future fire — a past one-off event, or a series that has ended)."""
    kind = reminder["kind"]
    for anchor in _occurrence_anchors(event, after):
        if kind == "at_event":
            if anchor > after:
                return anchor
        elif kind == "at_time":
            h, m = cal._parse_hhmm(reminder["at_time"])
            candidate = datetime.combine(anchor.date(), dtime(h, m))
            if candidate > after:
                return candidate
        elif kind == "repeating":
            step = _STEP_MINUTES.get(reminder["repeat_every"] or "hourly", 60)
            lead = int(reminder["lead_minutes"] or 0)
            window_start = anchor - timedelta(minutes=lead)
            t = window_start
            if t <= after:
                missed = (after - t).total_seconds() / 60.0
                jumps = int(missed // step) + 1
                t = window_start + timedelta(minutes=jumps * step)
            while t <= anchor:
                if t > after:
                    return t
                t += timedelta(minutes=step)
        # this occurrence yielded nothing after `after`; try the next one
    return None


def _fmt(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat(timespec="minutes") if dt else None


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def _validate_spec(kind: str, at_time: Optional[str], repeat_every: Optional[str],
                   lead_minutes: Optional[int]) -> None:
    if kind not in VALID_REMINDER_KINDS:
        raise ValueError(f"Invalid reminder kind: {kind!r}")
    if kind == "at_time":
        if not at_time or not _valid_hhmm(at_time):
            raise ValueError("at_time reminders need a valid HH:MM time")
    if kind == "repeating":
        if repeat_every not in VALID_REPEAT_EVERY:
            raise ValueError(f"Invalid repeat_every: {repeat_every!r}")
        if lead_minutes is None or int(lead_minutes) < 0:
            raise ValueError("repeating reminders need a non-negative lead_minutes")


def _valid_hhmm(value: str) -> bool:
    try:
        cal._parse_hhmm(value)
        h, m = cal._parse_hhmm(value)
        return 0 <= h < 24 and 0 <= m < 60
    except Exception:
        return False


def create_reminder(
    conn: sqlite3.Connection,
    *,
    event_id: int,
    kind: str,
    at_time: Optional[str] = None,
    repeat_every: Optional[str] = None,
    lead_minutes: Optional[int] = None,
    created_by: Optional[int] = None,
    now: Optional[datetime] = None,
) -> int:
    now = now or datetime.now()
    _validate_spec(kind, at_time, repeat_every, lead_minutes)
    event = cal.get_event(conn, event_id)
    if event is None:
        raise ValueError("Event not found")
    reminder = {"kind": kind, "at_time": at_time,
                "repeat_every": repeat_every, "lead_minutes": lead_minutes}
    nxt = compute_next_fire(event, reminder, now)
    cur = conn.execute(
        """
        INSERT INTO event_reminders
            (event_id, kind, at_time, repeat_every, lead_minutes,
             next_fire_at, active, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (event_id, kind, at_time, repeat_every,
         int(lead_minutes) if lead_minutes is not None else None,
         _fmt(nxt), 1 if nxt else 0, created_by),
    )
    return int(cur.lastrowid)


def reminders_for_event(conn: sqlite3.Connection, event_id: int) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM event_reminders WHERE event_id = ? ORDER BY id", (event_id,)
    ).fetchall()
    return [{k: r[k] for k in r.keys()} for r in rows]


def delete_reminder(conn: sqlite3.Connection, reminder_id: int) -> bool:
    cur = conn.execute("DELETE FROM event_reminders WHERE id = ?", (reminder_id,))
    return cur.rowcount > 0


def replace_reminders(
    conn: sqlite3.Connection, event_id: int, specs: List[Dict[str, Any]],
    created_by: Optional[int] = None, now: Optional[datetime] = None,
) -> None:
    """Delete the event's reminders and (re)create from ``specs`` — used by the
    create/update event endpoints so the reminder set follows the event."""
    conn.execute("DELETE FROM event_reminders WHERE event_id = ?", (event_id,))
    for s in specs or []:
        create_reminder(
            conn, event_id=event_id, kind=s.get("kind"),
            at_time=s.get("at_time"), repeat_every=s.get("repeat_every"),
            lead_minutes=s.get("lead_minutes"), created_by=created_by, now=now,
        )


def recompute_event_reminders(
    conn: sqlite3.Connection, event_id: int, now: Optional[datetime] = None
) -> None:
    """Recompute next_fire_at for all of an event's reminders — call after the
    event's date/time/recurrence changes."""
    now = now or datetime.now()
    event = cal.get_event(conn, event_id)
    if event is None:
        return
    for r in reminders_for_event(conn, event_id):
        nxt = compute_next_fire(event, r, now)
        conn.execute(
            "UPDATE event_reminders SET next_fire_at = ?, active = ?, last_fired_at = NULL "
            "WHERE id = ?",
            (_fmt(nxt), 1 if nxt else 0, r["id"]),
        )


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------

def _system_sender_id(conn: sqlite3.Connection) -> Optional[int]:
    row = conn.execute("SELECT id FROM users WHERE email = ?", (SYSTEM_USER_EMAIL,)).fetchone()
    if row:
        return row["id"]
    conn.execute(
        "INSERT OR IGNORE INTO users(email, password_hash, role, is_active) "
        "VALUES(?, 'x', 'admin', 0)", (SYSTEM_USER_EMAIL,),
    )
    row = conn.execute("SELECT id FROM users WHERE email = ?", (SYSTEM_USER_EMAIL,)).fetchone()
    return row["id"] if row else None


def assignee_rows(conn: sqlite3.Connection, event_id: int) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT ea.user_id, u.email FROM event_assignees ea JOIN users u ON u.id = ea.user_id "
        "WHERE ea.event_id = ? AND u.is_active = 1 ORDER BY u.email",
        (event_id,),
    ).fetchall()
    return [{"user_id": r["user_id"], "email": r["email"]} for r in rows]


def _insert_internal_message_direct(
    conn: sqlite3.Connection, sender_id: Optional[int], recipient_id: int,
    subject: str, body: str,
) -> None:
    conn.execute(
        "INSERT INTO user_messages(sender_id, recipient_id, subject, body) VALUES(?, ?, ?, ?)",
        (sender_id, recipient_id, subject, body),
    )


def render_reminder(event: Dict[str, Any], reminder: Dict[str, Any], fired_slot: str):
    case = event.get("case_name", "")
    et = (event.get("event_type") or "event")
    title = event.get("title") or event.get("purpose") or et.capitalize()
    when = event["event_date"]
    if not event.get("all_day") and event.get("start_time"):
        when += f" {event['start_time']}"
    subject = f"Reminder: {title} — {case} ({when})"
    lines = [
        f"This is an automated reminder for the {et} in {case}.",
        "",
        f"Title: {title}",
        f"When: {when}",
    ]
    if event.get("purpose"):
        lines.append(f"Purpose: {event['purpose']}")
    if event.get("notes"):
        lines.append(f"Notes: {event['notes']}")
    lines += ["", "— Case Organizer (automated reminder)"]
    return subject, "\n".join(lines)


def _deliver(conn: sqlite3.Connection, event: Dict[str, Any], reminder: sqlite3.Row,
             fired_slot: str) -> None:
    recipients = assignee_rows(conn, event["id"])
    if not recipients:
        return
    subject, body = render_reminder(event, reminder, fired_slot)
    sender_id = _system_sender_id(conn)
    email_broken = False
    for u in recipients:
        # Internal inbox message always (works with no SMTP configured).
        try:
            _insert_internal_message_direct(conn, sender_id, u["user_id"], subject, body)
        except Exception as exc:
            log.warning("Reminder inbox message to user %s failed: %s", u["user_id"], exc)
        # Email best-effort; stop attempting after a config error (affects all).
        if not email_broken:
            try:
                send_email(u["email"], subject, body)
            except EmailConfigError:
                email_broken = True
                log.info("Reminder emails skipped — SMTP is not configured")
            except Exception as exc:
                log.warning("Reminder email to %s failed: %s", u["email"], exc)


def fire_due_reminders(now: Optional[datetime] = None) -> int:
    """Scheduler entry point: fire every reminder whose next_fire_at has passed,
    then advance/deactivate it.  Opens and closes its own direct connection."""
    now = now or datetime.now()
    now_iso = now.isoformat(timespec="minutes")
    conn = open_app_db_direct()
    fired = 0
    try:
        due = conn.execute(
            "SELECT * FROM event_reminders WHERE active = 1 AND next_fire_at IS NOT NULL "
            "AND next_fire_at <= ? ORDER BY next_fire_at LIMIT 500",
            (now_iso,),
        ).fetchall()
        for r in due:
            event = cal.get_event(conn, r["event_id"])
            if event is None or event["status"] == "cancelled":
                conn.execute("UPDATE event_reminders SET active = 0 WHERE id = ?", (r["id"],))
                conn.commit()
                continue
            fired_slot = r["next_fire_at"]
            # Idempotency: skip the actual send if this exact slot already fired
            # (a crash between send and commit re-enters here at most once).
            already = bool(r["last_fired_at"]) and r["last_fired_at"] >= fired_slot
            if not already:
                _deliver(conn, event, r, fired_slot)
                fired += 1
            nxt = compute_next_fire(event, r, datetime.fromisoformat(fired_slot))
            conn.execute(
                "UPDATE event_reminders SET last_fired_at = ?, next_fire_at = ?, active = ? "
                "WHERE id = ?",
                (fired_slot, _fmt(nxt), 1 if nxt else 0, r["id"]),
            )
            conn.commit()
    finally:
        conn.close()
    return fired
