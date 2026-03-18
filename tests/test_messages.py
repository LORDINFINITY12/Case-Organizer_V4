"""Tests for services/messages.py — messaging system."""

from __future__ import annotations

import pytest
from services.users import create_user
from services.messages import (
    create_message,
    list_inbox,
    list_sent,
    get_message,
    mark_message_read,
    count_unread,
    delete_message,
)


@pytest.fixture
def sender(db):
    return create_user("sender@test.com", "Pass1234!")


@pytest.fixture
def recipient(db):
    return create_user("recipient@test.com", "Pass1234!")


class TestCreateMessage:

    def test_basic(self, db, sender, recipient):
        mid = create_message(sender, recipient, "Hello", "Hello body")
        assert mid > 0

    def test_self_message_raises(self, db, sender):
        with pytest.raises(ValueError, match="Cannot send a message to yourself"):
            create_message(sender, sender, "Self", "Self message")

    def test_strips_whitespace(self, db, sender, recipient):
        mid = create_message(sender, recipient, "  Subject  ", "  Body  ")
        msg = get_message(mid, sender)
        assert msg.subject == "Subject"
        assert msg.body == "Body"


class TestListMessages:

    def test_inbox(self, db, sender, recipient):
        create_message(sender, recipient, "Msg 1", "Body 1")
        create_message(sender, recipient, "Msg 2", "Body 2")
        inbox = list_inbox(recipient)
        assert len(inbox) == 2
        # Both messages present (ordering depends on timestamp precision)
        subjects = {m.subject for m in inbox}
        assert subjects == {"Msg 1", "Msg 2"}

    def test_sent(self, db, sender, recipient):
        create_message(sender, recipient, "Sent 1", "Body")
        sent = list_sent(sender)
        assert len(sent) == 1
        assert sent[0].subject == "Sent 1"


class TestReadMessages:

    def test_mark_read(self, db, sender, recipient):
        mid = create_message(sender, recipient, "Read test", "Body")
        msg = get_message(mid, recipient)
        assert msg.is_read is False
        mark_message_read(mid, recipient)
        msg = get_message(mid, recipient)
        assert msg.is_read is True

    def test_count_unread(self, db, sender, recipient):
        mid = create_message(sender, recipient, "Unread", "Body")
        assert count_unread(recipient) == 1
        mark_message_read(mid, recipient)
        assert count_unread(recipient) == 0


class TestDeleteMessage:

    def test_delete_by_recipient(self, db, sender, recipient):
        mid = create_message(sender, recipient, "Delete me", "Body")
        assert delete_message(mid, recipient) is True
        assert get_message(mid, recipient) is None

    def test_delete_by_sender(self, db, sender, recipient):
        mid = create_message(sender, recipient, "Delete me", "Body")
        assert delete_message(mid, sender) is True

    def test_delete_wrong_user(self, db, sender, recipient):
        other = create_user("other@test.com", "Pass1234!")
        mid = create_message(sender, recipient, "Secret", "Body")
        assert delete_message(mid, other) is False


class TestGetMessage:

    def test_sender_can_read(self, db, sender, recipient):
        mid = create_message(sender, recipient, "Visible", "Body")
        assert get_message(mid, sender) is not None

    def test_recipient_can_read(self, db, sender, recipient):
        mid = create_message(sender, recipient, "Visible", "Body")
        assert get_message(mid, recipient) is not None

    def test_other_cannot_read(self, db, sender, recipient):
        other = create_user("stranger@test.com", "Pass1234!")
        mid = create_message(sender, recipient, "Private", "Body")
        assert get_message(mid, other) is None
