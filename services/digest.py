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
        "SELECT * FROM case_events WHERE event_type IN ('filing','deadline','task') "
        "AND event_date = ? AND status NOT IN ('done','cancelled') ORDER BY event_type, id",
        (today_iso,),
    )
    overdue = q(
        "SELECT * FROM case_events WHERE "
        "((event_type = 'filing' AND filed_on IS NULL) OR event_type IN ('deadline','task')) "
        "AND status = 'pending' AND event_date < ? ORDER BY event_date, id",
        (today_iso,),
    )
    tomorrow = q(
        "SELECT * FROM case_events WHERE event_date = ? "
        "AND event_type IN ('hearing','filing','deadline','task') "
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
    if ev["event_type"] in ("filing", "deadline", "task"):
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


# ---------------------------------------------------------------------------
# PDF rendering — a proper tabular version of the same digest data.
# ---------------------------------------------------------------------------
def _pdf_when(ev: Dict[str, Any], today: date) -> str:
    """The 'Due / Date' cell: due-date + overdue for work items, else the
    event date plus a time when the event is not all-day."""
    if ev["event_type"] in ("filing", "deadline", "task"):
        due = ev["event_date"]
        try:
            days_over = (today - date.fromisoformat(due)).days
        except ValueError:
            days_over = 0
        return f"{due} (+{days_over}d overdue)" if days_over > 0 else due
    out = ev["event_date"]
    if not ev.get("all_day", 1) and ev.get("start_time"):
        span = ev["start_time"] + (f"–{ev['end_time']}" if ev.get("end_time") else "")
        out = f"{out} {span}"
    return out


def _ordered_sections(
    data: Dict[str, Any], today: date, for_user_id: Optional[int]
) -> List[tuple[str, List[Dict[str, Any]]]]:
    sections: List[tuple[str, List[Dict[str, Any]]]] = []
    if for_user_id is not None and data["assigned"].get(for_user_id):
        own_ids = set(data["assigned"][for_user_id])
        seen: set = set()
        own: List[Dict[str, Any]] = []
        for bucket in ("today_hearings", "due_today", "overdue", "tomorrow"):
            for ev in data[bucket]:
                if ev["id"] in own_ids and ev["id"] not in seen:
                    seen.add(ev["id"])
                    own.append(ev)
        sections.append(("Assigned to you", own))
    sections += [
        ("Today's Listings", data["today_hearings"]),
        ("Filings / Deadlines Due Today", data["due_today"]),
        ("Overdue / Unfiled", data["overdue"]),
        ("Tomorrow", data["tomorrow"]),
    ]
    return sections


def build_digest_pdf(
    data: Dict[str, Any], today: date, *, for_user_id: Optional[int] = None
) -> bytes:
    """Render the digest as a one-page A4 PDF with a real table."""
    from io import BytesIO
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    base = getSampleStyleSheet()["Normal"]
    cell = ParagraphStyle("cell", parent=base, fontSize=8, leading=10)
    head = ParagraphStyle("head", parent=base, fontSize=8, leading=10,
                          fontName="Helvetica-Bold", textColor=colors.white)
    sect = ParagraphStyle("sect", parent=base, fontSize=9, leading=11,
                          fontName="Helvetica-Bold")
    muted = ParagraphStyle("muted", parent=cell, textColor=colors.grey)
    title = ParagraphStyle("title", parent=base, fontSize=15, leading=18,
                           fontName="Helvetica-Bold")
    subtitle = ParagraphStyle("subtitle", parent=base, fontSize=9,
                              textColor=colors.grey, spaceAfter=8)

    accent = colors.HexColor("#2f6f57")
    section_bg = colors.HexColor("#eef4f1")
    grid = colors.HexColor("#c9d6cf")

    def P(text: str, style: ParagraphStyle = cell) -> Paragraph:
        return Paragraph(escape(str(text or "")), style)

    header = [P(t, head) for t in ("Type", "Case (Yr/Mo)", "Detail", "Due / Date", "Assigned")]
    rows: List[list] = [header]
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("GRID", (0, 0), (-1, -1), 0.4, grid),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]

    r = 1
    for name, events in _ordered_sections(data, today, for_user_id):
        rows.append([P(f"{name} ({len(events)})", sect), "", "", "", ""])
        style_cmds += [("SPAN", (0, r), (-1, r)),
                       ("BACKGROUND", (0, r), (-1, r), section_bg)]
        r += 1
        if not events:
            rows.append([P("Nothing scheduled.", muted), "", "", "", ""])
            style_cmds.append(("SPAN", (0, r), (-1, r)))
            r += 1
            continue
        for ev in events:
            detail = ev.get("purpose") if ev["event_type"] == "hearing" else ev.get("title")
            rows.append([
                P(ev["event_type"].upper()),
                P(_case_ref(ev)),
                P(detail or ""),
                P(_pdf_when(ev, today)),
                P(", ".join(ev.get("assignee_emails") or [])),
            ])
            r += 1

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=15 * mm, bottomMargin=15 * mm,
        title=f"Daily Digest {today.isoformat()}",
    )
    table = Table(rows, colWidths=[18 * mm, 44 * mm, 56 * mm, 30 * mm, 32 * mm],
                  repeatRows=1)
    table.setStyle(TableStyle(style_cmds))
    story = [
        Paragraph("Case Organizer — Daily Digest", title),
        Paragraph(today.strftime("%A, %d %B %Y"), subtitle),
        table,
        Spacer(1, 8),
        Paragraph("Automated daily digest — Case Organizer", subtitle),
    ]
    doc.build(story)
    return buf.getvalue()


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
        pdf_name = f"daily-digest-{today_iso}.pdf"

        def _digest_pdf(uid: Optional[int]) -> Optional[bytes]:
            """Best-effort PDF table — a render error must never block the email."""
            try:
                return build_digest_pdf(data, today, for_user_id=uid)
            except Exception as exc:  # pragma: no cover - defensive
                log.warning("Digest PDF render failed: %s", exc)
                return None

        shared_pdf = _digest_pdf(None)

        sent = failed = 0
        for user in recipients:
            personalized = bool(data["assigned"].get(user["id"]))
            body = (
                build_digest_body(data, today, for_user_id=user["id"])
                if personalized
                else shared_body
            )
            pdf = _digest_pdf(user["id"]) if personalized else shared_pdf
            attachments = [(pdf_name, pdf)] if pdf else None
            try:
                send_email(user["email"], subject, body, attachments=attachments)
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
