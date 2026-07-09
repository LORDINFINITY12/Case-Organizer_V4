"""Database utilities for Case Organizer 2.0."""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from typing import Optional

from flask import g

import caseorg_config
from services.settings import settings_manager


# Global schema version for the application database.
_SCHEMA_VERSION = 8


def _app_db_path() -> Path:
    """Return the path for the primary application database."""
    legacy_cfg = getattr(caseorg_config, 'CASEORG_CONFIG', None)
    if legacy_cfg:
        return Path(legacy_cfg).with_name('organizer.db')
    return settings_manager.paths.config_dir / 'organizer.db'


def _ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )

    row = conn.execute(
        "SELECT value FROM app_meta WHERE key = 'schema_version'"
    ).fetchone()
    current_version = int(row["value"]) if row else 0

    if current_version < 1:
        _migrate_to_v1(conn)
        current_version = 1

    if current_version < 2:
        _migrate_to_v2(conn)
        current_version = 2

    if current_version < 3:
        _migrate_to_v3(conn)
        current_version = 3

    if current_version < 4:
        _migrate_to_v4(conn)
        current_version = 4

    if current_version < 5:
        _migrate_to_v5(conn)
        current_version = 5

    if current_version < 6:
        _migrate_to_v6(conn)
        current_version = 6

    if current_version < 7:
        _migrate_to_v7(conn)
        current_version = 7

    if current_version < 8:
        _migrate_to_v8(conn)
        current_version = 8

    if current_version != _SCHEMA_VERSION:
        # Placeholder for future migrations.
        conn.execute(
            "INSERT INTO app_meta(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(_SCHEMA_VERSION),),
        )


def _migrate_to_v1(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','user')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_login_at TEXT
        )
        """
    )

    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
        AFTER UPDATE ON users
        BEGIN
            UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            recipient_id INTEGER NOT NULL,
            subject TEXT,
            body TEXT NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_messages_recipient ON user_messages(recipient_id, is_read)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            protected INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_settings_updated_at
        AFTER UPDATE ON app_settings
        BEGIN
            UPDATE app_settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
        END;
        """
    )

    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES('schema_version', '1') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def _migrate_to_v2(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT NOT NULL UNIQUE,
            case_year TEXT,
            case_month TEXT,
            case_name TEXT,
            file_path TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            generated_by INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(generated_by) REFERENCES users(id) ON DELETE SET NULL
        )
        """
    )

    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_invoices_updated_at
        AFTER UPDATE ON invoices
        BEGIN
            UPDATE invoices SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        """
    )

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_invoices_case ON invoices(case_year, case_month, case_name)"
    )

    conn.execute(
        """
        INSERT INTO app_settings(key, value, protected)
        VALUES('invoice_next_number', '1', 0)
        ON CONFLICT(key) DO NOTHING
        """
    )


def _migrate_to_v3(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_token TEXT NOT NULL UNIQUE,
            user_agent TEXT,
            ip_address TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)"
    )
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES('schema_version', '3') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def _migrate_to_v4(conn: sqlite3.Connection) -> None:
    # Letterheads: admin-uploaded images used as PDF headers for invoices/certificates
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS letterheads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            filename TEXT NOT NULL UNIQUE,
            uploaded_by INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(uploaded_by) REFERENCES users(id) ON DELETE SET NULL
        )
        """
    )

    # Certificates: internship certificate generation (mirrors invoices table)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS certificates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            certificate_number TEXT NOT NULL UNIQUE,
            intern_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            generated_by INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(generated_by) REFERENCES users(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_certificates_updated_at
        AFTER UPDATE ON certificates
        BEGIN
            UPDATE certificates SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        """
    )
    conn.execute(
        """
        INSERT INTO app_settings(key, value, protected)
        VALUES('certificate_next_number', '1', 0)
        ON CONFLICT(key) DO NOTHING
        """
    )

    # Vakalatnamas: admin-uploaded PDF templates for download
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS vakalatnamas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            filename TEXT NOT NULL UNIQUE,
            uploaded_by INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(uploaded_by) REFERENCES users(id) ON DELETE SET NULL
        )
        """
    )

    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES('schema_version', '4') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def _migrate_to_v5(conn: sqlite3.Connection) -> None:
    # Legal notices: user-uploaded notice PDFs stamped with letterhead + a
    # recipient/notice header band.  Numbered N/LN/YY, reset yearly.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS legal_notices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            notice_number TEXT NOT NULL UNIQUE,
            recipient_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            generated_by INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(generated_by) REFERENCES users(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_legal_notices_updated_at
        AFTER UPDATE ON legal_notices
        BEGIN
            UPDATE legal_notices SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        """
    )

    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES('schema_version', '5') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def _migrate_to_v6(conn: sqlite3.Connection) -> None:
    # Store session tokens as SHA-256 hashes so read access to the database
    # (backup leak, file exposure) cannot be used to hijack active sessions.
    # Existing plaintext tokens are hashed in place, which keeps every
    # current login valid — the client-side cookie token is unchanged.
    conn.execute(
        "ALTER TABLE user_sessions RENAME COLUMN session_token TO session_token_hash"
    )
    rows = conn.execute("SELECT id, session_token_hash FROM user_sessions").fetchall()
    for row in rows:
        digest = hashlib.sha256((row["session_token_hash"] or "").encode("utf-8")).hexdigest()
        conn.execute(
            "UPDATE user_sessions SET session_token_hash = ? WHERE id = ?",
            (digest, row["id"]),
        )

    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES('schema_version', '6') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def _migrate_to_v7(conn: sqlite3.Connection) -> None:
    # Allow a third user role, 'intern'.  SQLite cannot alter a CHECK
    # constraint in place, so rebuild the users table with the widened
    # constraint, preserving every row and id.  password_resets/user_sessions
    # reference users(id); FKs stay valid because the name and ids are
    # unchanged, and foreign_keys is disabled during the swap so the DROP does
    # not cascade-delete children.  executescript() commits any pending
    # transaction first (PRAGMA toggles must live outside a transaction).
    conn.executescript(
        """
        PRAGMA foreign_keys=OFF;
        BEGIN;
        CREATE TABLE users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','user','intern')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_login_at TEXT
        );
        INSERT INTO users_new
            (id, email, password_hash, role, is_active, created_at, updated_at, last_login_at)
        SELECT id, email, password_hash, role, is_active, created_at, updated_at, last_login_at
        FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        COMMIT;
        PRAGMA foreign_keys=ON;
        """
    )

    # The updated_at trigger was attached to the old users table and dropped
    # with it; recreate it (identical to _migrate_to_v1).
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
        AFTER UPDATE ON users
        BEGIN
            UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        """
    )

    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES('schema_version', '7') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def _migrate_to_v8(conn: sqlite3.Connection) -> None:
    # Calendar / court-event tracker.  Cases have no database rows — they are
    # filesystem directories — so events reference them by the path triple
    # (case_year, case_month, case_name).  related_event_id semantics by type:
    # on a 'hearing' it points at the next hearing it was adjourned to; on an
    # 'appearance' it points at the hearing the appearance records.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS case_events (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type       TEXT NOT NULL CHECK(event_type IN ('hearing','filing','appearance','deadline')),
            case_year        TEXT NOT NULL,
            case_month       TEXT NOT NULL,
            case_name        TEXT NOT NULL,
            event_date       TEXT NOT NULL,
            title            TEXT NOT NULL DEFAULT '',
            purpose          TEXT,
            status           TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','done','adjourned','cancelled')),
            outcome          TEXT,
            filed_on         TEXT,
            related_event_id INTEGER REFERENCES case_events(id) ON DELETE SET NULL,
            notes            TEXT,
            created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_case_events_date ON case_events(event_date)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_case_events_case "
        "ON case_events(case_year, case_month, case_name, event_date)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_case_events_status ON case_events(status, event_date)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_case_events_filed_on "
        "ON case_events(filed_on) WHERE filed_on IS NOT NULL"
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_case_events_updated_at
        AFTER UPDATE ON case_events
        BEGIN
            UPDATE case_events SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS event_participants (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id     INTEGER NOT NULL REFERENCES case_events(id) ON DELETE CASCADE,
            user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
            display_name TEXT NOT NULL CHECK(display_name <> '')
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants(event_id)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS event_assignees (
            event_id INTEGER NOT NULL REFERENCES case_events(id) ON DELETE CASCADE,
            user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (event_id, user_id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_event_assignees_user ON event_assignees(user_id)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS reminder_log (
            digest_date      TEXT PRIMARY KEY,
            sent_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            recipients_count INTEGER NOT NULL DEFAULT 0,
            detail           TEXT
        )
        """
    )

    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES('schema_version', '8') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def get_app_db() -> sqlite3.Connection:
    """Return a connection to the application database bound to Flask's context."""
    if 'app_db' not in g:
        g.app_db = open_app_db_direct()
    return g.app_db


def open_app_db_direct() -> sqlite3.Connection:
    """Open an application-DB connection NOT bound to Flask's context.

    For background threads (e.g. the digest scheduler) that run outside any
    app context — the caller owns the connection and must close it.
    """
    db_path = _app_db_path()
    _ensure_parent_dir(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    _ensure_schema(conn)
    return conn


def close_app_db(_: Optional[BaseException]) -> None:
    conn = g.pop('app_db', None)
    if conn is not None:
        conn.close()
