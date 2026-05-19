"""Lightweight SQLite-backed rate limiting for Case Organizer."""

from __future__ import annotations

import os
import time
from typing import Optional

from flask import request

_TRUSTED_PROXY_HOPS = int(os.environ.get("CASEORG_TRUSTED_PROXY", "0"))


def _get_client_ip() -> str:
    """Return the client IP address.

    When ``CASEORG_TRUSTED_PROXY`` is set to a positive integer *N*, the
    function trusts *N* proxy hops and extracts the real client IP from the
    ``X-Forwarded-For`` header.  When unset or ``0`` (the default), only
    ``request.remote_addr`` is used — safe for direct-to-server deployments.
    """
    if _TRUSTED_PROXY_HOPS > 0:
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            parts = [p.strip() for p in forwarded.split(",")]
            idx = max(0, len(parts) - _TRUSTED_PROXY_HOPS)
            return parts[idx]
    return request.remote_addr or "unknown"


_TABLE_READY = False


def _ensure_table(conn) -> None:
    global _TABLE_READY
    if _TABLE_READY:
        return
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rate_limit_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            action     TEXT    NOT NULL,
            client_key TEXT    NOT NULL,
            attempted_at REAL  NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rate_limit_action_key "
        "ON rate_limit_log(action, client_key, attempted_at)"
    )
    conn.commit()
    _TABLE_READY = True


def is_rate_limited(
    conn,
    action: str,
    window_seconds: int = 300,
    max_attempts: int = 5,
    key: Optional[str] = None,
) -> bool:
    """Check whether *action* is rate-limited for the current client.

    Returns ``True`` if the client has exceeded *max_attempts* within
    *window_seconds*.  Otherwise records the attempt and returns ``False``.
    """
    _ensure_table(conn)

    if key is None:
        key = _get_client_ip()

    now = time.time()
    cutoff = now - window_seconds

    row = conn.execute(
        "SELECT COUNT(*) AS cnt FROM rate_limit_log "
        "WHERE action = ? AND client_key = ? AND attempted_at > ?",
        (action, key, cutoff),
    ).fetchone()

    count = row[0] if row else 0

    if count >= max_attempts:
        return True

    conn.execute(
        "INSERT INTO rate_limit_log(action, client_key, attempted_at) VALUES(?, ?, ?)",
        (action, key, now),
    )
    conn.commit()

    # Periodic cleanup — purge entries older than 2× the window
    conn.execute(
        "DELETE FROM rate_limit_log WHERE attempted_at < ?",
        (now - window_seconds * 2,),
    )
    conn.commit()

    return False


def record_success(conn, action: str, key: Optional[str] = None) -> None:
    """Clear rate-limit history after a successful action (e.g. login).

    Prevents a legitimate user from being locked out after a few typos
    followed by the correct password.
    """
    _ensure_table(conn)

    if key is None:
        key = _get_client_ip()

    conn.execute(
        "DELETE FROM rate_limit_log WHERE action = ? AND client_key = ?",
        (action, key),
    )
    conn.commit()
