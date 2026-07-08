"""Tests for the 'intern' user role and its access restrictions."""

import pytest


def _login_as(client, user):
    """Attach a DB-backed session for ``user`` to ``client``."""
    from services.users import create_session

    token = create_session(user.id, user_agent="pytest", ip_address="127.0.0.1")
    with client.session_transaction() as sess:
        sess["session_token"] = token
        sess["user_id"] = user.id
        sess["user_role"] = user.role
        sess["user_email"] = user.email
        sess["_csrf_token"] = "test-csrf-token"
    return client


@pytest.fixture
def test_intern(db):
    """Create an intern user (exercises the widened role CHECK constraint)."""
    from services.users import create_user, get_user_by_id

    user_id = create_user("intern@example.com", "InternPass123!", role="intern")
    return get_user_by_id(user_id)


@pytest.fixture
def intern_client(client, test_intern):
    return _login_as(client, test_intern)


def test_create_intern_user_allowed(db):
    """After migration v7 the DB accepts role='intern'."""
    from services.users import create_user, get_user_by_id

    uid = create_user("someintern@example.com", "InternPass123!", role="intern")
    assert get_user_by_id(uid).role == "intern"


def test_invalid_role_still_rejected(db):
    from services.users import create_user

    with pytest.raises(ValueError):
        create_user("bad@example.com", "BadPass123!", role="superuser")


@pytest.mark.parametrize("path", ["/", "/account", "/messages", "/bento/tools.html"])
def test_intern_can_reach_allowed_pages(intern_client, path):
    resp = intern_client.get(path)
    assert resp.status_code == 200, f"{path} -> {resp.status_code}"


def test_intern_bento_index_redirects_to_tools(intern_client):
    """`/bento/` is allowed (redirects to the tools page, not blocked home)."""
    resp = intern_client.get("/bento/")
    assert resp.status_code == 302
    assert resp.headers["Location"].endswith("/bento/tools.html")


@pytest.mark.parametrize(
    "path",
    ["/invoice", "/certificate", "/vakalatnama", "/legal-notice", "/letterhead", "/settings"],
)
def test_intern_html_routes_redirect_home(intern_client, path):
    resp = intern_client.get(path)
    assert resp.status_code == 302
    assert resp.headers["Location"].endswith("/")


@pytest.mark.parametrize("path", ["/search", "/case-law/search", "/api/dir-tree"])
def test_intern_api_routes_forbidden(intern_client, path):
    resp = intern_client.get(path)
    assert resp.status_code == 403
    assert resp.is_json
    assert resp.get_json()["ok"] is False


def test_regular_user_unaffected(client, test_user):
    """A normal user still reaches the document tools (no behavior change)."""
    _login_as(client, test_user)
    assert client.get("/invoice").status_code == 200


def test_admin_unaffected(client, test_admin):
    _login_as(client, test_admin)
    assert client.get("/settings").status_code == 200
