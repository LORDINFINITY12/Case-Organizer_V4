"""Tests for authentication flows, session persistence, and decorators."""

from __future__ import annotations

import pytest
from services.users import (
    create_user,
    create_session,
    validate_session,
    delete_session,
    invalidate_user_sessions,
    set_user_active,
    set_user_password,
)


class TestSessionManagement:

    def test_create_and_validate(self, db):
        uid = create_user("sess@test.com", "Pass1234!")
        token = create_session(uid)
        assert isinstance(token, str)
        assert len(token) > 20
        assert validate_session(token) == uid

    def test_validate_invalid_token(self, db):
        assert validate_session("bogus-token") is None
        assert validate_session("") is None
        assert validate_session(None) is None

    def test_delete_session(self, db):
        uid = create_user("del@test.com", "Pass1234!")
        token = create_session(uid)
        assert validate_session(token) == uid
        delete_session(token)
        assert validate_session(token) is None

    def test_invalidate_all_sessions(self, db):
        uid = create_user("inv@test.com", "Pass1234!")
        t1 = create_session(uid)
        t2 = create_session(uid)
        count = invalidate_user_sessions(uid)
        assert count == 2
        assert validate_session(t1) is None
        assert validate_session(t2) is None

    def test_invalidate_except_current(self, db):
        uid = create_user("keep@test.com", "Pass1234!")
        t1 = create_session(uid)
        t2 = create_session(uid)
        count = invalidate_user_sessions(uid, except_token=t1)
        assert count == 1
        assert validate_session(t1) == uid
        assert validate_session(t2) is None

    def test_password_change_invalidates_others(self, db):
        uid = create_user("pwchg@test.com", "Pass1234!")
        current = create_session(uid)
        other = create_session(uid)
        set_user_password(uid, "NewPass1!")
        invalidate_user_sessions(uid, except_token=current)
        assert validate_session(current) == uid
        assert validate_session(other) is None

    def test_deactivation_invalidates_all(self, db):
        uid = create_user("deact@test.com", "Pass1234!")
        token = create_session(uid)
        set_user_active(uid, False)
        invalidate_user_sessions(uid)
        assert validate_session(token) is None


class TestLoginLogout:

    def test_login_page_loads(self, client):
        resp = client.get("/login")
        assert resp.status_code == 200

    def test_unauthenticated_redirects(self, client):
        resp = client.get("/account", follow_redirects=False)
        assert resp.status_code == 302
        location = resp.headers.get("Location", "")
        # Fresh DB may redirect to /setup or /login depending on setup state
        assert "/login" in location or "/setup" in location

    def test_authenticated_can_access_account(self, auth_client):
        resp = auth_client.get("/account")
        assert resp.status_code == 200

    def test_logout_clears_session(self, auth_client):
        resp = auth_client.get("/logout", follow_redirects=False)
        assert resp.status_code == 302
        resp2 = auth_client.get("/account", follow_redirects=False)
        assert resp2.status_code == 302
        assert "/login" in resp2.headers.get("Location", "")

    def test_api_unauthenticated_returns_401(self, client):
        resp = client.post("/api/session/keepalive")
        assert resp.status_code in (401, 403)


class TestSessionPersistence:

    def test_session_survives_multiple_requests(self, auth_client):
        resp1 = auth_client.get("/account")
        assert resp1.status_code == 200
        resp2 = auth_client.get("/account")
        assert resp2.status_code == 200

    def test_expired_token_forces_relogin(self, client, db):
        uid = create_user("expired@test.com", "Pass1234!")
        token = create_session(uid)

        # Manually expire the session in DB
        db.execute(
            "UPDATE user_sessions SET expires_at = '2000-01-01T00:00:00' WHERE session_token = ?",
            (token,),
        )
        db.commit()

        with client.session_transaction() as sess:
            sess["session_token"] = token
            sess["user_id"] = uid
            sess["user_role"] = "user"
            sess["user_email"] = "expired@test.com"
            sess["_csrf_token"] = "test"

        resp = client.get("/account", follow_redirects=False)
        assert resp.status_code == 302
        assert "/login" in resp.headers.get("Location", "")
