"""In-process scheduler for the daily digest email.

A single daemon thread wakes every minute and sends the digest once per day
when the configured send time has passed.  Idempotency lives in the
reminder_log table (claimed by send_daily_digest), so restarts never resend
and a crashed pass is visible in reminder_log.detail.

Started explicitly from app.py's __main__ block — never at import time — so
pytest and WSGI-module imports don't spawn it.  Uses open_app_db_direct();
Flask's g-bound get_app_db() must not be called from this thread.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, time as dtime
from typing import Optional

from services.db import open_app_db_direct
from services.email import EmailConfigError
from services.settings import settings_manager

log = logging.getLogger(__name__)

_WAKE_SECONDS = 60.0
_DEFAULT_SEND_TIME = "07:00"

_stop_event = threading.Event()
_thread: Optional[threading.Thread] = None


def _parse_send_time(value: str) -> dtime:
    try:
        return datetime.strptime((value or "").strip(), "%H:%M").time()
    except ValueError:
        log.warning("Invalid digest_send_time %r; falling back to %s", value, _DEFAULT_SEND_TIME)
        return datetime.strptime(_DEFAULT_SEND_TIME, "%H:%M").time()


def _digest_due(now: datetime, send_time_raw: str, already_sent: bool) -> bool:
    """True when the send time has passed today and no digest went out yet."""
    if already_sent:
        return False
    return now.time() >= _parse_send_time(send_time_raw)


def _already_sent(conn, date_iso: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM reminder_log WHERE digest_date = ?", (date_iso,)
    ).fetchone()
    return row is not None


def _tick(now: Optional[datetime] = None) -> None:
    now = now or datetime.now()
    if not settings_manager.get("digest_enabled", True):
        return
    send_time_raw = str(settings_manager.get("digest_send_time", _DEFAULT_SEND_TIME))

    conn = open_app_db_direct()
    try:
        already_sent = _already_sent(conn, now.date().isoformat())
    finally:
        conn.close()

    if not _digest_due(now, send_time_raw, already_sent):
        return

    from services.digest import send_daily_digest

    try:
        result = send_daily_digest(now.date())
        if result.get("skipped"):
            return
        if result.get("empty"):
            log.info("Daily digest %s: nothing scheduled, no email sent", now.date())
        else:
            log.info(
                "Daily digest %s: sent to %s recipient(s), %s failed",
                now.date(), result.get("sent"), result.get("failed"),
            )
    except EmailConfigError as exc:
        log.warning("Daily digest not sent — SMTP is not configured: %s", exc)


def _digest_loop() -> None:
    log.info("Digest scheduler started (wake interval %ss)", int(_WAKE_SECONDS))
    while not _stop_event.wait(_WAKE_SECONDS):
        try:
            _tick()
        except Exception:
            log.exception("Digest scheduler tick failed; will retry next wake")


def start_digest_scheduler() -> threading.Thread:
    global _thread
    if _thread is not None and _thread.is_alive():
        return _thread
    _stop_event.clear()
    _thread = threading.Thread(target=_digest_loop, daemon=True, name="caseorg-digest")
    _thread.start()
    return _thread


def stop_digest_scheduler() -> None:
    _stop_event.set()
    global _thread
    if _thread is not None:
        _thread.join(timeout=5)
        _thread = None
