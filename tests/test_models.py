"""Tests for services/models.py — dataclass models and _RowCompat mixin."""

from __future__ import annotations

import pytest
from services.models import User, PasswordReset, Message, _RowCompat


class TestRowCompat:

    def test_getitem(self):
        u = User(id=1, email="a@b.com", role="user", is_active=True,
                 created_at="now", updated_at="now")
        assert u["email"] == "a@b.com"

    def test_getitem_missing_raises_keyerror(self):
        u = User(id=1, email="a@b.com", role="user", is_active=True,
                 created_at="now", updated_at="now")
        with pytest.raises(KeyError):
            u["nonexistent"]

    def test_get_default(self):
        u = User(id=1, email="a@b.com", role="user", is_active=True,
                 created_at="now", updated_at="now")
        assert u.get("email") == "a@b.com"
        assert u.get("nonexistent", "default") == "default"
        assert u.get("nonexistent") is None

    def test_contains(self):
        u = User(id=1, email="a@b.com", role="user", is_active=True,
                 created_at="now", updated_at="now")
        assert "email" in u
        assert "nonexistent" not in u

    def test_keys(self):
        u = User(id=1, email="a@b.com", role="user", is_active=True,
                 created_at="now", updated_at="now")
        keys = u.keys()
        assert "id" in keys
        assert "email" in keys
        assert "role" in keys


class TestUserModel:

    def test_from_row(self, db):
        from services.users import create_user, get_user_by_id
        uid = create_user("model@test.com", "Pass1234!", role="user")
        user = get_user_by_id(uid)
        assert isinstance(user, User)
        assert user.email == "model@test.com"
        assert user.role == "user"
        assert user.is_active is True

    def test_attribute_and_dict_access(self, db):
        from services.users import create_user, get_user_by_id
        uid = create_user("access@test.com", "Pass1234!")
        user = get_user_by_id(uid)
        assert user.email == user["email"]


class TestPasswordResetModel:

    def test_from_row(self, db):
        from services.users import create_user, create_password_reset_token, get_password_reset
        uid = create_user("reset@test.com", "Pass1234!")
        token = create_password_reset_token(uid)
        reset = get_password_reset(token)
        assert isinstance(reset, PasswordReset)
        assert reset.user_id == uid
        assert reset["token"] == token


class TestMessageModel:

    def test_from_row(self, db):
        from services.users import create_user
        from services.messages import create_message, get_message
        u1 = create_user("sender@test.com", "Pass1234!")
        u2 = create_user("recipient@test.com", "Pass1234!")
        mid = create_message(u1, u2, "Subject", "Body")
        msg = get_message(mid, u1)
        assert isinstance(msg, Message)
        assert msg.subject == "Subject"
        assert msg["body"] == "Body"
