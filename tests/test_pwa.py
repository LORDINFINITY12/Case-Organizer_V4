"""Service worker delivery and the dd/mm/yyyy display filter."""

from __future__ import annotations

from datetime import date, datetime


# ---------------------------------------------------------------------------
# /sw.js
# ---------------------------------------------------------------------------

def test_service_worker_is_served_from_the_root(client):
    """A worker can only control paths at or below its own URL.

    Served from /static/ it would only see /static/*, which would make it
    useless for catching failed page loads.
    """
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert b"serviceWorker" in r.data or b"addEventListener" in r.data


def test_service_worker_declares_root_scope(client):
    r = client.get("/sw.js")
    assert r.headers["Service-Worker-Allowed"] == "/"


def test_service_worker_is_javascript(client):
    r = client.get("/sw.js")
    assert "javascript" in r.headers["Content-Type"]


def test_service_worker_is_not_cached_hard(client):
    """A pinned stale worker is very hard to displace, so it must revalidate."""
    r = client.get("/sw.js")
    assert "no-cache" in r.headers.get("Cache-Control", "")


def test_service_worker_needs_no_session(client):
    """It is requested before the user has logged in, so it cannot 302 away."""
    r = client.get("/sw.js")
    assert r.status_code == 200


def test_offline_page_is_reachable(client):
    """The worker falls back to this; if it 404s the fallback is worthless."""
    r = client.get("/static/offline.html")
    assert r.status_code == 200
    assert b"Reconnecting" in r.data


def test_offline_page_probes_ping(client):
    """It recovers by polling /ping, which must not require a session."""
    assert client.get("/ping").status_code == 200
    assert b"/ping" in client.get("/static/offline.html").data


# ---------------------------------------------------------------------------
# dd/mm/yyyy filter
# ---------------------------------------------------------------------------

def _dmy(app, value, **kw):
    return app.jinja_env.filters["dmy"](value, **kw)


def test_dmy_formats_sqlite_timestamp(app):
    assert _dmy(app, "2025-10-11 16:59:38") == "11/10/2025 16:59"


def test_dmy_formats_bare_date_without_a_time(app):
    assert _dmy(app, "2025-10-11") == "11/10/2025"


def test_dmy_formats_iso_with_t_separator(app):
    assert _dmy(app, "2026-07-08T09:05:00") == "08/07/2026 09:05"


def test_dmy_drops_a_midnight_time(app):
    """00:00:00 is how a date-only value arrives; showing it as a time is noise."""
    assert _dmy(app, "2026-07-08 00:00:00") == "08/07/2026"


def test_dmy_accepts_datetime_objects(app):
    assert _dmy(app, datetime(2026, 3, 1, 14, 30)) == "01/03/2026 14:30"


def test_dmy_accepts_date_objects(app):
    assert _dmy(app, date(2026, 3, 1)) == "01/03/2026"


def test_dmy_can_suppress_the_time(app):
    assert _dmy(app, "2025-10-11 16:59:38", with_time=False) == "11/10/2025"


def test_dmy_blanks_empty_values(app):
    """Templates fall back with `or '—'`, which needs a falsy result."""
    assert _dmy(app, None) == ""
    assert _dmy(app, "") == ""


def test_dmy_passes_through_anything_it_cannot_parse(app):
    """Better a visibly odd value than a silently blanked one."""
    assert _dmy(app, "not a date") == "not a date"


def test_dmy_is_unambiguous_for_a_day_after_the_twelfth(app):
    """The whole point: 13/10 cannot be misread as a month."""
    assert _dmy(app, "2025-10-13 08:00:00").startswith("13/10/2025")
