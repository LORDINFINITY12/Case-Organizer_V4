"""User management helpers for Case Organizer."""

from __future__ import annotations

import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from services.db import get_app_db
from services.security import hash_password, verify_password
from services.models import User, PasswordReset


class UserExistsError(ValueError):
    """Raised when attempting to create a user with an email that already exists."""


class EmailInUseError(UserExistsError):
    """Raised when updating a user to an email that already exists."""


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def create_user(email: str, password: str, role: str = "user", is_active: bool = True) -> int:
    email_norm = normalize_email(email)
    if not email_norm:
        raise ValueError("Email is required")
    if role not in {"admin", "user"}:
        raise ValueError("Invalid role")
    password_hash = hash_password(password)

    conn = get_app_db()
    try:
        cur = conn.execute(
            """
            INSERT INTO users(email, password_hash, role, is_active)
            VALUES(?, ?, ?, ?)
            """,
            (email_norm, password_hash, role, 1 if is_active else 0),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise UserExistsError(f"User with email {email_norm!r} already exists") from exc

    return int(cur.lastrowid)


def get_user_by_email(email: str) -> Optional[User]:
    email_norm = normalize_email(email)
    if not email_norm:
        return None
    conn = get_app_db()
    row = conn.execute(
        "SELECT * FROM users WHERE email = ?",
        (email_norm,),
    ).fetchone()
    return User.from_row(row) if row else None


def get_user_by_id(user_id: int) -> Optional[User]:
    conn = get_app_db()
    row = conn.execute(
        "SELECT * FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return User.from_row(row) if row else None


def authenticate_user(email: str, password: str) -> Optional[User]:
    user = get_user_by_email(email)
    if not user or not user.is_active:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def count_users() -> int:
    conn = get_app_db()
    row = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()
    return int(row["c"] if row else 0)


def set_user_password(user_id: int, password: str) -> None:
    conn = get_app_db()
    conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (hash_password(password), user_id),
    )
    conn.commit()


def mark_user_login(user_id: int) -> None:
    conn = get_app_db()
    conn.execute(
        "UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?",
        (user_id,),
    )
    conn.commit()


def create_password_reset_token(user_id: int, expires_minutes: int = 30) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=expires_minutes)).isoformat()

    conn = get_app_db()
    conn.execute("DELETE FROM password_resets WHERE user_id = ? AND consumed_at IS NULL", (user_id,))
    conn.execute(
        """
        INSERT INTO password_resets(user_id, token, expires_at)
        VALUES(?, ?, ?)
        """,
        (user_id, token, expires_at),
    )
    conn.commit()
    return token


def get_password_reset(token: str) -> Optional[PasswordReset]:
    if not token:
        return None
    conn = get_app_db()
    row = conn.execute(
        "SELECT * FROM password_resets WHERE token = ?",
        (token,),
    ).fetchone()
    if not row or row["consumed_at"] is not None:
        return None
    expires_at_raw = row["expires_at"]
    try:
        expires_at = datetime.fromisoformat(expires_at_raw)
    except Exception:
        return None
    if expires_at < datetime.now(timezone.utc).replace(tzinfo=None):
        return None
    return PasswordReset.from_row(row)


def consume_password_reset(reset_id: int) -> None:
    conn = get_app_db()
    conn.execute(
        "UPDATE password_resets SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?",
        (reset_id,),
    )
    conn.commit()


def list_users() -> list[User]:
    conn = get_app_db()
    rows = conn.execute(
        "SELECT id, email, role, is_active, created_at, updated_at, last_login_at FROM users ORDER BY email COLLATE NOCASE"
    ).fetchall()
    return [User.from_row(r) for r in rows]


def set_user_active(user_id: int, active: bool) -> None:
    conn = get_app_db()
    conn.execute(
        "UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (1 if active else 0, user_id),
    )
    conn.commit()


def count_admins(active_only: bool = True) -> int:
    conn = get_app_db()
    if active_only:
        row = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1").fetchone()
    else:
        row = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").fetchone()
    return int(row["c"] if row else 0)


def update_user_email(user_id: int, new_email: str) -> None:
    email_norm = normalize_email(new_email)
    if not email_norm:
        raise ValueError("Email must not be empty")
    conn = get_app_db()
    try:
        conn.execute(
            "UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (email_norm, user_id),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise EmailInUseError(f"Email {email_norm!r} is already registered") from exc


def update_user_role(user_id: int, new_role: str) -> None:
    if new_role not in {"admin", "user"}:
        raise ValueError("Invalid role")
    conn = get_app_db()
    conn.execute(
        "UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (new_role, user_id),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Persistent session management
# ---------------------------------------------------------------------------

SESSION_DURATION_DAYS = 30
SESSION_EXTEND_THRESHOLD_DAYS = 7


def create_session(user_id: int, user_agent: str = "", ip_address: str = "") -> str:
    """Create a persistent session record and return the session token."""
    token = secrets.token_urlsafe(48)
    expires_at = (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=SESSION_DURATION_DAYS)).isoformat()
    conn = get_app_db()
    conn.execute(
        """
        INSERT INTO user_sessions(user_id, session_token, user_agent, ip_address, expires_at)
        VALUES(?, ?, ?, ?, ?)
        """,
        (user_id, token, user_agent or "", ip_address or "", expires_at),
    )
    conn.commit()
    return token


def validate_session(token: str) -> Optional[int]:
    """Validate a session token. Returns user_id if valid, None otherwise.

    Also updates ``last_active_at`` and extends ``expires_at`` when the
    remaining lifetime drops below ``SESSION_EXTEND_THRESHOLD_DAYS``.
    """
    if not token:
        return None
    conn = get_app_db()
    row = conn.execute(
        "SELECT id, user_id, expires_at FROM user_sessions WHERE session_token = ?",
        (token,),
    ).fetchone()
    if not row:
        return None
    try:
        expires_at = datetime.fromisoformat(row["expires_at"])
    except (ValueError, TypeError):
        return None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if expires_at < now:
        conn.execute("DELETE FROM user_sessions WHERE id = ?", (row["id"],))
        conn.commit()
        return None
    remaining = expires_at - now
    if remaining < timedelta(days=SESSION_EXTEND_THRESHOLD_DAYS):
        new_expires = (now + timedelta(days=SESSION_DURATION_DAYS)).isoformat()
        conn.execute(
            "UPDATE user_sessions SET last_active_at = CURRENT_TIMESTAMP, expires_at = ? WHERE id = ?",
            (new_expires, row["id"]),
        )
    else:
        conn.execute(
            "UPDATE user_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?",
            (row["id"],),
        )
    conn.commit()
    return int(row["user_id"])


def delete_session(token: str) -> None:
    """Delete a single session (used on explicit logout)."""
    if not token:
        return
    conn = get_app_db()
    conn.execute("DELETE FROM user_sessions WHERE session_token = ?", (token,))
    conn.commit()


def invalidate_user_sessions(user_id: int, except_token: Optional[str] = None) -> int:
    """Delete all sessions for a user, optionally keeping one.

    Returns the number of sessions deleted.
    """
    conn = get_app_db()
    if except_token:
        cur = conn.execute(
            "DELETE FROM user_sessions WHERE user_id = ? AND session_token != ?",
            (user_id, except_token),
        )
    else:
        cur = conn.execute(
            "DELETE FROM user_sessions WHERE user_id = ?",
            (user_id,),
        )
    conn.commit()
    return cur.rowcount


def cleanup_expired_sessions() -> int:
    """Delete all expired session records. Returns count deleted."""
    conn = get_app_db()
    cur = conn.execute(
        "DELETE FROM user_sessions WHERE expires_at < ?",
        (datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),),
    )
    conn.commit()
    return cur.rowcount
