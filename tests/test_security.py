"""Tests for password hashing, CSRF validation, and rate limiting."""

from __future__ import annotations

import pytest


class TestPasswordHashing:

    def test_hash_returns_argon2_string(self):
        from services.security import hash_password
        h = hash_password("test123")
        assert isinstance(h, str)
        assert h.startswith("$argon2")

    def test_verify_correct_password(self):
        from services.security import hash_password, verify_password
        h = hash_password("mypassword")
        assert verify_password("mypassword", h) is True

    def test_verify_wrong_password(self):
        from services.security import hash_password, verify_password
        h = hash_password("mypassword")
        assert verify_password("wrongpassword", h) is False

    def test_verify_empty_password(self):
        from services.security import verify_password
        assert verify_password("", "somehash") is False

    def test_verify_empty_hash(self):
        from services.security import verify_password
        assert verify_password("password", "") is False

    def test_hash_empty_raises(self):
        from services.security import hash_password
        with pytest.raises(ValueError):
            hash_password("")


class TestCSRF:

    def test_post_without_csrf_rejected(self, client, test_user):
        with client.session_transaction() as sess:
            from services.users import create_session
            token = create_session(test_user.id)
            sess["session_token"] = token
            sess["user_id"] = test_user.id
            sess["user_role"] = test_user.role
            sess["user_email"] = test_user.email
            sess["_csrf_token"] = "expected-token"

        resp = client.post("/account", data={"form_name": "update_email"})
        assert resp.status_code in (302, 403)

    def test_post_with_valid_csrf_passes(self, auth_client, csrf_token):
        resp = auth_client.post(
            "/account",
            data={
                "form_name": "update_email",
                "_csrf_token": csrf_token,
                "new_email": "new@example.com",
                "current_password": "TestPass123!",
            },
        )
        # Should not be a CSRF rejection
        assert resp.status_code != 403


class TestRateLimiting:

    def test_rate_limit_blocks_after_threshold(self, db):
        from services.rate_limit import is_rate_limited
        for _ in range(5):
            assert is_rate_limited(db, "test_action", max_attempts=5, key="testip") is False
        assert is_rate_limited(db, "test_action", max_attempts=5, key="testip") is True

    def test_rate_limit_clears_on_success(self, db):
        from services.rate_limit import is_rate_limited, record_success
        for _ in range(5):
            is_rate_limited(db, "clear_action", max_attempts=5, key="testip")
        assert is_rate_limited(db, "clear_action", max_attempts=5, key="testip") is True
        record_success(db, "clear_action", key="testip")
        assert is_rate_limited(db, "clear_action", max_attempts=5, key="testip") is False
