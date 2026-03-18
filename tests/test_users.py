"""Tests for services/users.py — user management."""

from __future__ import annotations

import pytest
from services.users import (
    create_user,
    get_user_by_id,
    get_user_by_email,
    authenticate_user,
    set_user_password,
    set_user_active,
    update_user_email,
    update_user_role,
    list_users,
    count_users,
    count_admins,
    create_password_reset_token,
    get_password_reset,
    consume_password_reset,
    UserExistsError,
    EmailInUseError,
    normalize_email,
)


class TestCreateUser:

    def test_basic(self, db):
        uid = create_user("new@test.com", "Password1!")
        assert uid > 0
        user = get_user_by_id(uid)
        assert user.email == "new@test.com"
        assert user.role == "user"
        assert user.is_active is True

    def test_admin_role(self, db):
        uid = create_user("adm@test.com", "Password1!", role="admin")
        user = get_user_by_id(uid)
        assert user.role == "admin"

    def test_duplicate_email_raises(self, db):
        create_user("dup@test.com", "Pass1234!")
        with pytest.raises(UserExistsError):
            create_user("dup@test.com", "Pass5678!")

    def test_invalid_role_raises(self, db):
        with pytest.raises(ValueError, match="Invalid role"):
            create_user("role@test.com", "Pass1234!", role="superadmin")

    def test_empty_email_raises(self, db):
        with pytest.raises(ValueError, match="Email is required"):
            create_user("", "Pass1234!")


class TestAuthentication:

    def test_correct_credentials(self, db):
        create_user("auth@test.com", "CorrectPass1!")
        assert authenticate_user("auth@test.com", "CorrectPass1!") is not None

    def test_wrong_password(self, db):
        create_user("wrong@test.com", "CorrectPass1!")
        assert authenticate_user("wrong@test.com", "WrongPassword") is None

    def test_nonexistent_user(self, db):
        assert authenticate_user("ghost@test.com", "anything") is None

    def test_inactive_user(self, db):
        uid = create_user("inactive@test.com", "Pass1234!")
        set_user_active(uid, False)
        assert authenticate_user("inactive@test.com", "Pass1234!") is None


class TestPasswordManagement:

    def test_change_password(self, db):
        uid = create_user("pw@test.com", "OldPass1!")
        set_user_password(uid, "NewPass1!")
        assert authenticate_user("pw@test.com", "OldPass1!") is None
        assert authenticate_user("pw@test.com", "NewPass1!") is not None

    def test_reset_flow(self, db):
        uid = create_user("reset@test.com", "Pass1234!")
        token = create_password_reset_token(uid)
        reset = get_password_reset(token)
        assert reset is not None
        assert reset.user_id == uid
        consume_password_reset(reset.id)
        assert get_password_reset(token) is None


class TestEmailNormalization:

    def test_strips_and_lowercases(self):
        assert normalize_email("  MixedCase@Test.COM  ") == "mixedcase@test.com"

    def test_empty_returns_empty(self):
        assert normalize_email("") == ""
        assert normalize_email(None) == ""

    def test_lookup_normalised(self, db):
        create_user("  Upper@Test.COM  ", "Pass1234!")
        user = get_user_by_email("upper@test.com")
        assert user is not None


class TestUserUpdates:

    def test_update_email(self, db):
        uid = create_user("old@test.com", "Pass1234!")
        update_user_email(uid, "new@test.com")
        user = get_user_by_id(uid)
        assert user.email == "new@test.com"

    def test_update_email_duplicate_raises(self, db):
        create_user("taken@test.com", "Pass1234!")
        uid2 = create_user("other@test.com", "Pass1234!")
        with pytest.raises(EmailInUseError):
            update_user_email(uid2, "taken@test.com")

    def test_update_role(self, db):
        uid = create_user("role@test.com", "Pass1234!", role="user")
        update_user_role(uid, "admin")
        user = get_user_by_id(uid)
        assert user.role == "admin"

    def test_update_role_invalid_raises(self, db):
        uid = create_user("badrole@test.com", "Pass1234!")
        with pytest.raises(ValueError, match="Invalid role"):
            update_user_role(uid, "superadmin")


class TestListAndCount:

    def test_list_users(self, db):
        create_user("list1@test.com", "Pass1234!")
        create_user("list2@test.com", "Pass1234!")
        users = list_users()
        emails = [u.email for u in users]
        assert "list1@test.com" in emails
        assert "list2@test.com" in emails

    def test_count_users(self, db):
        create_user("count@test.com", "Pass1234!")
        assert count_users() >= 1

    def test_count_admins(self, db):
        create_user("cadm@test.com", "Pass1234!", role="admin")
        assert count_admins() >= 1
