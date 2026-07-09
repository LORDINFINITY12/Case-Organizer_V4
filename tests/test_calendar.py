"""Tests for the calendar / court-event tracker and the daily digest."""

from datetime import date, datetime, timedelta

import pytest

CSRF = {"X-CSRF-Token": "test-csrf-token"}
TODAY = date.today()
TODAY_ISO = TODAY.isoformat()


def _login_as(client, user):
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
def fsroot(tmp_path, monkeypatch):
    import app as app_module

    root = tmp_path / "cal_fs_root"
    root.mkdir()
    monkeypatch.setattr(app_module, "FS_ROOT", root)
    return root


def _mk_case(fsroot, year="2026", month="Jul", name="Foo v. Bar"):
    (fsroot / year / month / name).mkdir(parents=True, exist_ok=True)
    return {"case_year": year, "case_month": month, "case_name": name}


@pytest.fixture
def user_client(client, test_user):
    return _login_as(client, test_user)


@pytest.fixture
def test_intern(db):
    from services.users import create_user, get_user_by_id

    uid = create_user("intern@example.com", "InternPass123!", role="intern")
    return get_user_by_id(uid)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
class TestSchema:
    def test_v8_tables_exist(self, db):
        names = {
            r["name"] for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {"case_events", "event_participants", "event_assignees", "reminder_log"} <= names

    def test_delete_event_cascades_children(self, db, test_user):
        from services import calendar_events as cal

        eid = cal.create_event(
            db, event_type="hearing", case_year="2026", case_month="Jul",
            case_name="X v. Y", event_date=TODAY_ISO,
            assignee_ids=[test_user.id],
            participants=[{"user_id": None, "display_name": "Sr. Adv. Rao"}],
        )
        db.commit()
        cal.delete_event(db, eid)
        db.commit()
        assert db.execute("SELECT 1 FROM event_assignees WHERE event_id = ?", (eid,)).fetchone() is None
        assert db.execute("SELECT 1 FROM event_participants WHERE event_id = ?", (eid,)).fetchone() is None


# ---------------------------------------------------------------------------
# Event CRUD via API
# ---------------------------------------------------------------------------
class TestEventCrud:
    def _create(self, client, fsroot, **overrides):
        payload = {
            **_mk_case(fsroot),
            "event_type": "hearing",
            "event_date": TODAY_ISO,
            "purpose": "Arguments",
        }
        payload.update(overrides)
        return client.post("/api/calendar/events", json=payload, headers=CSRF)

    @pytest.mark.parametrize("etype", ["hearing", "filing", "appearance", "deadline"])
    def test_create_each_type(self, user_client, fsroot, etype):
        resp = self._create(user_client, fsroot, event_type=etype)
        assert resp.status_code == 200, resp.get_json()
        body = resp.get_json()
        assert body["ok"] and body["event"]["event_type"] == etype

    def test_create_rejects_bad_type(self, user_client, fsroot):
        assert self._create(user_client, fsroot, event_type="party").status_code == 400

    def test_create_rejects_bad_date(self, user_client, fsroot):
        assert self._create(user_client, fsroot, event_date="9-9-2026").status_code == 400

    def test_create_rejects_bad_month(self, user_client, fsroot):
        assert self._create(user_client, fsroot, case_month="July").status_code == 400

    def test_create_rejects_missing_case_dir(self, user_client, fsroot):
        resp = user_client.post("/api/calendar/events", json={
            "case_year": "2026", "case_month": "Jul", "case_name": "Ghost v. Case",
            "event_type": "hearing", "event_date": TODAY_ISO,
        }, headers=CSRF)
        assert resp.status_code == 400

    def test_assignees_round_trip(self, user_client, fsroot, test_user):
        resp = self._create(user_client, fsroot, assignee_ids=[test_user.id])
        ev = resp.get_json()["event"]
        assert [a["user_id"] for a in ev["assignees"]] == [test_user.id]

    def test_intern_assignee_rejected(self, user_client, fsroot, test_intern):
        resp = self._create(user_client, fsroot, assignee_ids=[test_intern.id])
        assert resp.status_code == 400

    def test_update_and_delete(self, user_client, fsroot):
        eid = self._create(user_client, fsroot).get_json()["event"]["id"]
        resp = user_client.put(f"/api/calendar/events/{eid}",
                               json={"purpose": "Final Hearing", "status": "adjourned"},
                               headers=CSRF)
        assert resp.status_code == 200
        ev = resp.get_json()["event"]
        assert ev["purpose"] == "Final Hearing" and ev["status"] == "adjourned"

        assert user_client.delete(f"/api/calendar/events/{eid}", headers=CSRF).status_code == 200
        assert user_client.delete(f"/api/calendar/events/{eid}", headers=CSRF).status_code == 404


# ---------------------------------------------------------------------------
# Queries: day agenda, month range, timeline
# ---------------------------------------------------------------------------
class TestQueries:
    def test_day_agenda_buckets(self, user_client, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        cal.create_event(db, event_type="hearing", event_date=TODAY_ISO, **case)
        cal.create_event(db, event_type="filing", event_date=TODAY_ISO, title="Reply", **case)
        cal.create_event(db, event_type="filing",
                         event_date=(TODAY - timedelta(days=3)).isoformat(),
                         filed_on=TODAY_ISO, status="done", title="Rejoinder", **case)
        cal.create_event(db, event_type="appearance", event_date=TODAY_ISO,
                         participants=[{"user_id": None, "display_name": "A. Vakil"}], **case)
        db.commit()

        data = user_client.get(f"/api/calendar/day?date={TODAY_ISO}", headers=CSRF).get_json()
        assert data["ok"]
        assert len(data["listings"]) == 1
        assert len(data["due"]) == 1 and data["due"][0]["title"] == "Reply"
        assert len(data["filed"]) == 1 and data["filed"][0]["title"] == "Rejoinder"
        assert len(data["appearances"]) == 1
        assert data["appearances"][0]["participants"][0]["display_name"] == "A. Vakil"

    def test_month_range_boundaries(self, user_client, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        cal.create_event(db, event_type="hearing", event_date="2026-07-01", **case)
        cal.create_event(db, event_type="hearing", event_date="2026-07-31", **case)
        cal.create_event(db, event_type="hearing", event_date="2026-06-30", **case)
        cal.create_event(db, event_type="hearing", event_date="2026-08-01", **case)
        db.commit()

        data = user_client.get("/api/calendar/events?year=2026&month=7", headers=CSRF).get_json()
        dates = sorted(e["event_date"] for e in data["events"])
        assert dates == ["2026-07-01", "2026-07-31"]

    def test_timeline_ordering(self, user_client, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        cal.create_event(db, event_type="hearing", event_date="2026-03-10", **case)
        cal.create_event(db, event_type="filing", event_date="2026-01-05", title="WS", **case)
        cal.create_event(db, event_type="hearing", event_date="2026-09-01", **case)
        db.commit()

        qs = "year=2026&month=Jul&case=Foo%20v.%20Bar"
        data = user_client.get(f"/api/calendar/case-timeline?{qs}", headers=CSRF).get_json()
        assert data["ok"] and data["case_exists"]
        assert [e["event_date"] for e in data["events"]] == \
            ["2026-01-05", "2026-03-10", "2026-09-01"]


# ---------------------------------------------------------------------------
# Workflow: mark filed, record appearance
# ---------------------------------------------------------------------------
class TestWorkflows:
    def test_mark_filed(self, user_client, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        eid = cal.create_event(db, event_type="filing", event_date=TODAY_ISO, title="WS", **case)
        db.commit()
        resp = user_client.post(f"/api/calendar/events/{eid}/mark-filed", json={}, headers=CSRF)
        ev = resp.get_json()["event"]
        assert ev["filed_on"] == TODAY_ISO and ev["status"] == "done"

    def test_mark_filed_rejects_non_filing(self, user_client, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        eid = cal.create_event(db, event_type="hearing", event_date=TODAY_ISO, **case)
        db.commit()
        resp = user_client.post(f"/api/calendar/events/{eid}/mark-filed", json={}, headers=CSRF)
        assert resp.status_code == 400

    def test_record_appearance_composite(self, user_client, fsroot, db, test_user):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        hearing_id = cal.create_event(db, event_type="hearing", event_date=TODAY_ISO,
                                      purpose="Arguments", **case)
        db.commit()

        next_iso = (TODAY + timedelta(days=30)).isoformat()
        resp = user_client.post("/api/calendar/record-appearance", json={
            **case,
            "appearance_date": TODAY_ISO,
            "participants": [{"user_id": test_user.id}, {"display_name": "Sr. Adv. Rao"}],
            "outcome": "Part-heard",
            "hearing_event_id": hearing_id,
            "next_date": next_iso,
            "next_purpose": "Final Hearing",
        }, headers=CSRF)
        body = resp.get_json()
        assert resp.status_code == 200 and body["ok"], body

        hearing = cal.get_event(db, hearing_id)
        assert hearing["status"] == "adjourned"
        assert hearing["outcome"] == "Part-heard"
        assert hearing["related_event_id"] == body["next_hearing_id"]

        nxt = cal.get_event(db, body["next_hearing_id"])
        assert nxt["event_type"] == "hearing" and nxt["event_date"] == next_iso
        assert nxt["purpose"] == "Final Hearing"

        appearance = cal.get_event(db, body["appearance_id"])
        assert appearance["related_event_id"] == hearing_id
        names = {p["display_name"] for p in appearance["participants"]}
        assert "Sr. Adv. Rao" in names and test_user.email in names

    def test_record_appearance_without_next_date_marks_done(self, user_client, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        hearing_id = cal.create_event(db, event_type="hearing", event_date=TODAY_ISO, **case)
        db.commit()
        resp = user_client.post("/api/calendar/record-appearance", json={
            **case,
            "appearance_date": TODAY_ISO,
            "participants": [{"display_name": "A. Vakil"}],
            "hearing_event_id": hearing_id,
        }, headers=CSRF)
        assert resp.status_code == 200
        assert cal.get_event(db, hearing_id)["status"] == "done"
        assert resp.get_json()["next_hearing_id"] is None


# ---------------------------------------------------------------------------
# Case rename / delete cascades
# ---------------------------------------------------------------------------
class TestCascades:
    def test_rename_case_moves_events(self, client, test_admin, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        cal.create_event(db, event_type="hearing", event_date=TODAY_ISO, **case)
        db.commit()
        _login_as(client, test_admin)

        resp = client.post("/api/rename-case", json={
            "path": str(fsroot / case["case_year"] / case["case_month"] / case["case_name"]),
            "new_name": "Foo v. Renamed",
        }, headers=CSRF)
        assert resp.status_code == 200, resp.get_json()

        rows = db.execute("SELECT case_name FROM case_events").fetchall()
        assert [r["case_name"] for r in rows] == ["Foo v. Renamed"]

    def test_delete_case_removes_events(self, client, test_admin, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        cal.create_event(db, event_type="hearing", event_date=TODAY_ISO, **case)
        db.commit()
        _login_as(client, test_admin)

        resp = client.post("/api/delete-item", json={
            "path": str(fsroot / case["case_year"] / case["case_month"] / case["case_name"]),
        }, headers=CSRF)
        assert resp.status_code == 200
        assert db.execute("SELECT 1 FROM case_events").fetchone() is None

    def test_subdir_delete_keeps_events(self, client, test_admin, fsroot, db):
        from services import calendar_events as cal

        case = _mk_case(fsroot)
        sub = fsroot / case["case_year"] / case["case_month"] / case["case_name"] / "Invoices"
        sub.mkdir()
        cal.create_event(db, event_type="hearing", event_date=TODAY_ISO, **case)
        db.commit()
        _login_as(client, test_admin)

        resp = client.post("/api/delete-item", json={"path": str(sub)}, headers=CSRF)
        assert resp.status_code == 200
        assert db.execute("SELECT 1 FROM case_events").fetchone() is not None


# ---------------------------------------------------------------------------
# Intern access: view-only
# ---------------------------------------------------------------------------
class TestInternAccess:
    @pytest.fixture
    def intern_client(self, client, test_intern):
        return _login_as(client, test_intern)

    @pytest.mark.parametrize("path", [
        "/calendar",
        f"/api/calendar/day?date={TODAY_ISO}",
        "/api/calendar/events?year=2026&month=7",
        "/api/calendar/case-timeline?year=2026&month=Jul&case=Foo%20v.%20Bar",
    ])
    def test_reads_allowed(self, intern_client, path):
        assert intern_client.get(path).status_code == 200

    def test_writes_blocked(self, intern_client, fsroot):
        case = _mk_case(fsroot)
        assert intern_client.post("/api/calendar/events", json={
            **case, "event_type": "hearing", "event_date": TODAY_ISO,
        }, headers=CSRF).status_code == 403
        assert intern_client.put("/api/calendar/events/1", json={}, headers=CSRF).status_code == 403
        assert intern_client.delete("/api/calendar/events/1", headers=CSRF).status_code == 403
        assert intern_client.post("/api/calendar/record-appearance", json={}, headers=CSRF).status_code == 403
        assert intern_client.post("/api/calendar/events/1/mark-filed", json={}, headers=CSRF).status_code == 403
        assert intern_client.get("/api/calendar/assignable-users").status_code == 403


# ---------------------------------------------------------------------------
# Digest
# ---------------------------------------------------------------------------
class TestDigest:
    def _seed(self, db, test_user):
        from services import calendar_events as cal

        case = {"case_year": "2026", "case_month": "Jul", "case_name": "Foo v. Bar"}
        cal.create_event(db, event_type="hearing", event_date=TODAY_ISO,
                         purpose="Arguments", assignee_ids=[test_user.id], **case)
        cal.create_event(db, event_type="filing", event_date=TODAY_ISO, title="Reply", **case)
        cal.create_event(db, event_type="filing", title="Rejoinder",
                         event_date=(TODAY - timedelta(days=7)).isoformat(), **case)
        cal.create_event(db, event_type="hearing",
                         event_date=(TODAY + timedelta(days=1)).isoformat(), **case)
        db.commit()

    def test_build_digest_body(self, db, test_user):
        from services.digest import build_digest_body, collect_digest_data

        self._seed(db, test_user)
        data = collect_digest_data(db, TODAY)
        shared = build_digest_body(data, TODAY)
        assert "== TODAY'S LISTINGS (1) ==" in shared
        assert "== FILINGS / DEADLINES DUE TODAY (1) ==" in shared
        assert "== OVERDUE / UNFILED (1) ==" in shared
        assert "7 days overdue" in shared
        assert "== TOMORROW (1) ==" in shared
        assert "ASSIGNED TO YOU" not in shared

        personal = build_digest_body(data, TODAY, for_user_id=test_user.id)
        assert "== ASSIGNED TO YOU ==" in personal
        assert "Arguments" in personal

    def test_send_daily_digest_recipients_and_idempotency(
        self, app, db, test_user, test_admin, test_intern, monkeypatch
    ):
        import services.digest as digest_mod
        from services.users import create_user, set_user_active

        inactive_id = create_user("inactive@example.com", "Password123!", role="user")
        set_user_active(inactive_id, False)
        self._seed(db, test_user)
        db.commit()

        sent = []
        monkeypatch.setattr(digest_mod, "send_email",
                            lambda to, subject, body: sent.append((to, body)))

        result = digest_mod.send_daily_digest(TODAY)
        assert result == {"sent": 2, "failed": 0, "skipped": False, "empty": False}
        recipients = {to for to, _ in sent}
        assert recipients == {test_user.email, test_admin.email}

        bodies = {to: body for to, body in sent}
        assert "ASSIGNED TO YOU" in bodies[test_user.email]
        assert "ASSIGNED TO YOU" not in bodies[test_admin.email]

        # Same day again -> claimed, skipped.
        assert digest_mod.send_daily_digest(TODAY)["skipped"] is True
        # Force bypasses the claim.
        assert digest_mod.send_daily_digest(TODAY, force=True)["sent"] == 2

    def test_empty_digest_sends_nothing(self, app, db, test_user, monkeypatch):
        import services.digest as digest_mod

        sent = []
        monkeypatch.setattr(digest_mod, "send_email",
                            lambda *a: sent.append(a))
        result = digest_mod.send_daily_digest(TODAY)
        assert result["empty"] is True and not sent
        row = db.execute("SELECT detail FROM reminder_log WHERE digest_date = ?",
                         (TODAY_ISO,)).fetchone()
        assert row and row["detail"] == "empty"


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
class TestScheduler:
    @pytest.mark.parametrize("now_hm,send_time,already,expected", [
        ("06:59", "07:00", False, False),
        ("07:00", "07:00", False, True),
        ("08:30", "07:00", False, True),
        ("08:30", "07:00", True, False),
        ("07:30", "not-a-time", False, True),   # falls back to 07:00
        ("06:30", "not-a-time", False, False),
    ])
    def test_digest_due(self, now_hm, send_time, already, expected):
        from services.scheduler import _digest_due

        now = datetime.strptime(f"2026-07-09 {now_hm}", "%Y-%m-%d %H:%M")
        assert _digest_due(now, send_time, already) is expected

    def test_tick_noop_when_disabled(self, app, db, monkeypatch):
        from services.settings import settings_manager
        import services.scheduler as sched

        settings_manager.set("digest_enabled", False)
        called = []
        monkeypatch.setattr("services.digest.send_daily_digest",
                            lambda *a, **k: called.append(1))
        sched._tick(datetime(2026, 7, 9, 23, 59))
        assert not called
        assert db.execute("SELECT 1 FROM reminder_log").fetchone() is None
