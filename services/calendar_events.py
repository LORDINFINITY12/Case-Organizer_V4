"""Calendar / court-event tracking for Case Organizer.

All SQL for the case_events, event_participants, and event_assignees tables
lives here.  Cases have no database rows — they are filesystem directories —
so every event references its case by the path triple
(case_year, case_month, case_name), and every query must filter on all three.

``related_event_id`` semantics by event type:
  * hearing     — the next hearing this one was adjourned to
  * appearance  — the hearing this appearance records

Every function takes an explicit sqlite3 connection so both Flask request
handlers (get_app_db) and the digest scheduler thread (open_app_db_direct)
can share the logic.  Callers commit.
"""

from __future__ import annotations

import sqlite3
from datetime import date
from typing import Any, Dict, Iterable, List, Optional

VALID_EVENT_TYPES = {"hearing", "filing", "appearance", "deadline", "task"}
VALID_STATUSES = {"pending", "done", "adjourned", "cancelled"}

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

# Columns the API may update in place.
_UPDATABLE_FIELDS = {
    "event_date", "title", "purpose", "status", "outcome",
    "filed_on", "notes", "related_event_id",
}


def _is_overdue(row: sqlite3.Row, today_iso: str) -> bool:
    """A filing that is unfiled, or a pending deadline/task, past its date."""
    if row["event_type"] == "filing":
        return row["filed_on"] is None and row["status"] not in ("done", "cancelled") \
            and row["event_date"] < today_iso
    if row["event_type"] in ("deadline", "task"):
        return row["status"] == "pending" and row["event_date"] < today_iso
    return False


def _event_to_dict(
    row: sqlite3.Row,
    assignees: Optional[List[Dict[str, Any]]] = None,
    participants: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    d = {key: row[key] for key in row.keys()}
    d["overdue"] = _is_overdue(row, date.today().isoformat())
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


def _attach_relations(conn: sqlite3.Connection, rows: Iterable[sqlite3.Row]) -> List[Dict[str, Any]]:
    return [
        _event_to_dict(r, _assignees_for(conn, r["id"]), _participants_for(conn, r["id"]))
        for r in rows
    ]


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
    assignee_ids: Iterable[int] = (),
    participants: Iterable[Dict[str, Any]] = (),
) -> int:
    if event_type not in VALID_EVENT_TYPES:
        raise ValueError(f"Invalid event type: {event_type!r}")
    if status not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {status!r}")
    cur = conn.execute(
        """
        INSERT INTO case_events(
            event_type, case_year, case_month, case_name, event_date,
            title, purpose, status, outcome, filed_on, related_event_id,
            notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_type, case_year, case_month, case_name, event_date,
            title, purpose, status, outcome, filed_on, related_event_id,
            notes, created_by,
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
    if not updates:
        return False
    sets = ", ".join(f"{col} = ?" for col in updates)
    cur = conn.execute(
        f"UPDATE case_events SET {sets} WHERE id = ?",
        (*updates.values(), event_id),
    )
    return cur.rowcount > 0


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
    """All events whose event_date OR filed_on falls inside the month."""
    start = f"{year:04d}-{month:02d}-01"
    end = f"{year + 1:04d}-01-01" if month == 12 else f"{year:04d}-{month + 1:02d}-01"
    rows = conn.execute(
        """
        SELECT * FROM case_events
        WHERE (event_date >= ? AND event_date < ?)
           OR (filed_on IS NOT NULL AND filed_on >= ? AND filed_on < ?)
        ORDER BY event_date, id
        """,
        (start, end, start, end),
    ).fetchall()
    out = _attach_relations(conn, rows)
    for d in out:
        d["filed_in_month"] = bool(d.get("filed_on") and start <= d["filed_on"] < end)
    return out


def day_agenda(conn: sqlite3.Connection, date_iso: str) -> Dict[str, List[Dict[str, Any]]]:
    """What is listed / due / filed / appeared on the given date."""
    listings = conn.execute(
        "SELECT * FROM case_events WHERE event_type = 'hearing' AND event_date = ? ORDER BY id",
        (date_iso,),
    ).fetchall()
    due = conn.execute(
        """
        SELECT * FROM case_events
        WHERE event_type IN ('filing', 'deadline', 'task') AND event_date = ?
        ORDER BY event_type, id
        """,
        (date_iso,),
    ).fetchall()
    filed = conn.execute(
        "SELECT * FROM case_events WHERE event_type = 'filing' AND filed_on = ? ORDER BY id",
        (date_iso,),
    ).fetchall()
    appearances = conn.execute(
        "SELECT * FROM case_events WHERE event_type = 'appearance' AND event_date = ? ORDER BY id",
        (date_iso,),
    ).fetchall()
    return {
        "listings": _attach_relations(conn, listings),
        "due": _attach_relations(conn, due),
        "filed": _attach_relations(conn, filed),
        "appearances": _attach_relations(conn, appearances),
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
