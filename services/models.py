"""Typed data models for Case Organizer.

Each model wraps a ``sqlite3.Row`` result with typed attributes while
remaining backward-compatible with dict-style access (``obj["key"]``)
via the ``_RowCompat`` mixin.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, fields
from typing import Any, Optional


class _RowCompat:
    """Mixin that lets dataclass instances behave like dicts for legacy code."""

    def __getitem__(self, key: str) -> Any:
        try:
            return getattr(self, key)
        except AttributeError:
            raise KeyError(key) from None

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)

    def __contains__(self, key: str) -> bool:
        return hasattr(self, key)

    def keys(self) -> list[str]:
        return [f.name for f in fields(self)]


# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------

@dataclass
class User(_RowCompat):
    id: int
    email: str
    role: str
    is_active: bool
    created_at: str
    updated_at: str
    last_login_at: Optional[str] = None
    password_hash: Optional[str] = None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> User:
        return cls(
            id=row["id"],
            email=row["email"],
            role=row["role"],
            is_active=bool(row["is_active"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_login_at=row["last_login_at"],
            password_hash=row["password_hash"] if "password_hash" in row.keys() else None,
        )


# ---------------------------------------------------------------------------
# PasswordReset
# ---------------------------------------------------------------------------

@dataclass
class PasswordReset(_RowCompat):
    id: int
    user_id: int
    token: str
    expires_at: str
    consumed_at: Optional[str]
    created_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> PasswordReset:
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            token=row["token"],
            expires_at=row["expires_at"],
            consumed_at=row["consumed_at"],
            created_at=row["created_at"],
        )


# ---------------------------------------------------------------------------
# Message
# ---------------------------------------------------------------------------

@dataclass
class Message(_RowCompat):
    id: int
    sender_id: int
    recipient_id: int
    subject: str
    body: str
    is_read: bool
    created_at: str
    sender_email: Optional[str] = None
    recipient_email: Optional[str] = None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> Message:
        keys = row.keys()
        return cls(
            id=row["id"],
            sender_id=row["sender_id"],
            recipient_id=row["recipient_id"],
            subject=row["subject"],
            body=row["body"],
            is_read=bool(row["is_read"]),
            created_at=row["created_at"],
            sender_email=row["sender_email"] if "sender_email" in keys else None,
            recipient_email=row["recipient_email"] if "recipient_email" in keys else None,
        )


# ---------------------------------------------------------------------------
# CaseLawEntry
# ---------------------------------------------------------------------------

@dataclass
class CaseLawEntry(_RowCompat):
    id: int
    petitioner: str
    respondent: str
    primary_type: str
    case_type: str
    folder_rel: str
    file_name: str
    created_at: str
    updated_at: str
    citation: Optional[str] = None
    citation_display: Optional[str] = None
    court_type: Optional[str] = None
    court_name: Optional[str] = None
    court_abbrev: Optional[str] = None
    decision_year: Optional[int] = None
    decision_month: Optional[str] = None
    note_path_rel: Optional[str] = None
    note_text: Optional[str] = None
    subtype: Optional[str] = None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> CaseLawEntry:
        keys = row.keys()
        return cls(
            id=row["id"],
            petitioner=row["petitioner"],
            respondent=row["respondent"],
            primary_type=row["primary_type"],
            case_type=row.get("case_type") if hasattr(row, "get") else (row["case_type"] if "case_type" in keys else ""),
            folder_rel=row["folder_rel"],
            file_name=row["file_name"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            citation=row["citation"] if "citation" in keys else None,
            citation_display=row["citation_display"] if "citation_display" in keys else None,
            court_type=row["court_type"] if "court_type" in keys else None,
            court_name=row["court_name"] if "court_name" in keys else None,
            court_abbrev=row["court_abbrev"] if "court_abbrev" in keys else None,
            decision_year=row["decision_year"] if "decision_year" in keys else None,
            decision_month=row["decision_month"] if "decision_month" in keys else None,
            note_path_rel=row["note_path_rel"] if "note_path_rel" in keys else None,
            note_text=row["note_text"] if "note_text" in keys else None,
            subtype=row["subtype"] if "subtype" in keys else None,
        )
