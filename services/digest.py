"""Daily digest email for the calendar / court-event tracker.

Builds and sends the morning digest: today's listings, filings due today,
overdue unfiled items, and a look-ahead at tomorrow.  Every active admin/user
receives the shared body; users with assignments among those events receive a
personalized copy with an "ASSIGNED TO YOU" section prepended.

``build_digest_body`` and ``collect_digest_data`` are pure given a connection
and a date, so tests can assert on content without SMTP.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from services.db import open_app_db_direct
from services.email import EmailConfigError, send_email

log = logging.getLogger(__name__)


def collect_digest_data(conn: sqlite3.Connection, today: date) -> Dict[str, Any]:
    today_iso = today.isoformat()
    tomorrow_iso = (today + timedelta(days=1)).isoformat()

    def q(sql: str, params: tuple) -> List[sqlite3.Row]:
        return conn.execute(sql, params).fetchall()

    today_hearings = q(
        "SELECT * FROM case_events WHERE event_type = 'hearing' AND event_date = ? "
        "AND status NOT IN ('cancelled') ORDER BY id",
        (today_iso,),
    )
    due_today = q(
        "SELECT * FROM case_events WHERE event_type IN ('filing','deadline') "
        "AND event_date = ? AND status NOT IN ('done','cancelled') ORDER BY event_type, id",
        (today_iso,),
    )
    overdue = q(
        "SELECT * FROM case_events WHERE "
        "((event_type = 'filing' AND filed_on IS NULL) OR event_type = 'deadline') "
        "AND status = 'pending' AND event_date < ? ORDER BY event_date, id",
        (today_iso,),
    )
    tomorrow = q(
        "SELECT * FROM case_events WHERE event_date = ? "
        "AND event_type IN ('hearing','filing','deadline') "
        "AND status NOT IN ('done','cancelled') ORDER BY event_type, id",
        (tomorrow_iso,),
    )

    rows_by_id: Dict[int, sqlite3.Row] = {}
    for bucket in (today_hearings, due_today, overdue, tomorrow):
        for row in bucket:
            rows_by_id[row["id"]] = row

    assigned: Dict[int, List[int]] = {}
    assignee_emails: Dict[int, List[str]] = {}
    if rows_by_id:
        marks = ",".join("?" for _ in rows_by_id)
        for r in conn.execute(
            f"""
            SELECT ea.event_id, ea.user_id, u.email
            FROM event_assignees ea JOIN users u ON u.id = ea.user_id
            WHERE ea.event_id IN ({marks})
            ORDER BY u.email
            """,
            tuple(rows_by_id),
        ):
            assigned.setdefault(r["user_id"], []).append(r["event_id"])
            assignee_emails.setdefault(r["event_id"], []).append(r["email"])

    def as_dicts(rows: List[sqlite3.Row]) -> List[Dict[str, Any]]:
        return [
            {**{k: row[k] for k in row.keys()},
             "assignee_emails": assignee_emails.get(row["id"], [])}
            for row in rows
        ]

    return {
        "today_hearings": as_dicts(today_hearings),
        "due_today": as_dicts(due_today),
        "overdue": as_dicts(overdue),
        "tomorrow": as_dicts(tomorrow),
        "assigned": assigned,
    }


def has_content(data: Dict[str, Any]) -> bool:
    return any(data[k] for k in ("today_hearings", "due_today", "overdue", "tomorrow"))


def get_digest_recipients(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT id, email FROM users "
        "WHERE is_active = 1 AND role IN ('admin','user') ORDER BY email"
    ).fetchall()
    return [{"id": r["id"], "email": r["email"]} for r in rows]


def _case_ref(ev: Dict[str, Any]) -> str:
    return f"{ev['case_name']} ({ev['case_year']}/{ev['case_month']})"


def _line(ev: Dict[str, Any], today: date) -> str:
    kind = ev["event_type"].upper()
    parts = [f"  * [{kind}] {_case_ref(ev)}"]
    detail = ev.get("purpose") if ev["event_type"] == "hearing" else ev.get("title")
    if detail:
        parts.append(f"— {detail}")
    if ev["event_type"] in ("filing", "deadline"):
        due = ev["event_date"]
        try:
            days_over = (today - date.fromisoformat(due)).days
        except ValueError:
            days_over = 0
        if days_over > 0:
            parts.append(f"(due {due}, {days_over} day{'s' if days_over != 1 else ''} overdue)")
        else:
            parts.append(f"(due {due})")
    if ev.get("assignee_emails"):
        parts.append(f"[assigned: {', '.join(ev['assignee_emails'])}]")
    return " ".join(parts)


def build_digest_body(
    data: Dict[str, Any], today: date, *, for_user_id: Optional[int] = None
) -> str:
    lines: List[str] = [
        f"Case Organizer — Daily Digest for {today.strftime('%a, %d %b %Y')}",
        "",
    ]

    if for_user_id is not None and data["assigned"].get(for_user_id):
        own_ids = set(data["assigned"][for_user_id])
        own_events = [
            ev
            for bucket in ("today_hearings", "due_today", "overdue", "tomorrow")
            for ev in data[bucket]
            if ev["id"] in own_ids
        ]
        seen: set = set()
        lines.append("== ASSIGNED TO YOU ==")
        for ev in own_events:
            if ev["id"] in seen:
                continue
            seen.add(ev["id"])
            lines.append(_line(ev, today))
        lines.append("")

    def section(header: str, events: List[Dict[str, Any]]) -> None:
        lines.append(f"== {header} ({len(events)}) ==")
        if events:
            lines.extend(_line(ev, today) for ev in events)
        else:
            lines.append("  Nothing scheduled.")
        lines.append("")

    section("TODAY'S LISTINGS", data["today_hearings"])
    section("FILINGS / DEADLINES DUE TODAY", data["due_today"])
    section("OVERDUE / UNFILED", data["overdue"])
    section("TOMORROW", data["tomorrow"])

    lines.append("— Case Organizer (automated daily digest)")
    return "\n".join(lines)


def send_daily_digest(today: Optional[date] = None, *, force: bool = False) -> Dict[str, Any]:
    """Build and send the digest.  Idempotent per calendar day unless forced.

    Runs outside any Flask context (scheduler thread) — opens its own
    connection.  ``force=True`` (admin test button) neither checks nor writes
    the reminder_log claim.
    """
    today = today or date.today()
    today_iso = today.isoformat()
    conn = open_app_db_direct()
    try:
        if not force:
            cur = conn.execute(
                "INSERT OR IGNORE INTO reminder_log(digest_date) VALUES(?)", (today_iso,)
            )
            conn.commit()
            if cur.rowcount == 0:
                return {"sent": 0, "failed": 0, "skipped": True, "empty": False}

        data = collect_digest_data(conn, today)
        if not has_content(data):
            if not force:
                conn.execute(
                    "UPDATE reminder_log SET detail = 'empty' WHERE digest_date = ?",
                    (today_iso,),
                )
                conn.commit()
            return {"sent": 0, "failed": 0, "skipped": False, "empty": True}

        recipients = get_digest_recipients(conn)
        subject = f"Daily Digest — {today.strftime('%d %b %Y')}"
        shared_body = build_digest_body(data, today)

        sent = failed = 0
        for user in recipients:
            body = (
                build_digest_body(data, today, for_user_id=user["id"])
                if data["assigned"].get(user["id"])
                else shared_body
            )
            try:
                send_email(user["email"], subject, body)
                sent += 1
            except EmailConfigError:
                raise  # config problem affects everyone — bail out entirely
            except Exception as exc:
                failed += 1
                log.warning("Digest to %s failed: %s", user["email"], exc)

        if not force:
            conn.execute(
                "UPDATE reminder_log SET recipients_count = ?, detail = ? WHERE digest_date = ?",
                (sent, f"sent to {sent}, failed {failed}", today_iso),
            )
            conn.commit()
        return {"sent": sent, "failed": failed, "skipped": False, "empty": False}
    finally:
        conn.close()
