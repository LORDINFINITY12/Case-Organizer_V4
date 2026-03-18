"""Shared test fixtures for Case Organizer."""

from __future__ import annotations

import os
import sys
import tempfile
import shutil
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Ensure the Root directory is on sys.path so imports work.
# ---------------------------------------------------------------------------
_ROOT_DIR = Path(__file__).resolve().parent.parent
if str(_ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(_ROOT_DIR))

# ---------------------------------------------------------------------------
# Session-scoped temp directory for config isolation.
# Must be set BEFORE importing any application modules so that
# ``services.settings.settings_manager`` picks up the temp config dir.
# ---------------------------------------------------------------------------
_SESSION_TMP = tempfile.mkdtemp(prefix="caseorg_test_")
os.environ.setdefault("XDG_CONFIG_HOME", str(Path(_SESSION_TMP) / "config"))
os.environ.setdefault("CASEORG_SECRET_KEY", "test-secret-key-for-tests-only")


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path, monkeypatch):
    """Point the application database at a fresh temp file for every test."""
    db_path = tmp_path / "test_organizer.db"

    import services.db as db_mod
    monkeypatch.setattr(db_mod, "_app_db_path", lambda: db_path)

    # Reset the rate limiter's lazy table flag so it creates the table
    # in each test's fresh database.
    import services.rate_limit as rl_mod
    monkeypatch.setattr(rl_mod, "_TABLE_READY", False)

    # Also ensure FS_ROOT points somewhere safe.
    fs_root = tmp_path / "fs_root"
    fs_root.mkdir()
    import caseorg_config
    monkeypatch.setattr(caseorg_config, "FS_ROOT", str(fs_root))

    yield


@pytest.fixture
def app():
    """Create a Flask test application."""
    from app import app as flask_app

    flask_app.config["TESTING"] = True
    flask_app.config["SERVER_NAME"] = "localhost"

    with flask_app.app_context():
        yield flask_app


@pytest.fixture
def client(app):
    """Flask test client."""
    return app.test_client()


@pytest.fixture
def db(app):
    """Get a database connection within app context."""
    from services.db import get_app_db
    return get_app_db()


@pytest.fixture
def test_user(db):
    """Create a test user and return the User object."""
    from services.users import create_user, get_user_by_id
    user_id = create_user("testuser@example.com", "TestPass123!", role="user")
    return get_user_by_id(user_id)


@pytest.fixture
def test_admin(db):
    """Create a test admin and return the User object."""
    from services.users import create_user, get_user_by_id
    user_id = create_user("admin@example.com", "AdminPass123!", role="admin")
    return get_user_by_id(user_id)


@pytest.fixture
def auth_client(client, test_user):
    """A test client already authenticated with a DB-backed session."""
    from services.users import create_session

    token = create_session(test_user.id, user_agent="pytest", ip_address="127.0.0.1")
    with client.session_transaction() as sess:
        sess["session_token"] = token
        sess["user_id"] = test_user.id
        sess["user_role"] = test_user.role
        sess["user_email"] = test_user.email
        sess["_csrf_token"] = "test-csrf-token"
    return client


@pytest.fixture
def csrf_token():
    """The CSRF token used in auth_client sessions."""
    return "test-csrf-token"


def pytest_sessionfinish(session, exitstatus):
    """Clean up the session-scoped temp directory."""
    shutil.rmtree(_SESSION_TMP, ignore_errors=True)
