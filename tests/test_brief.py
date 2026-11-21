"""Tests for case briefs: one PDF per case at <case>/Brief.pdf, managed from
Manage Case (File Category -> Brief) and previewed in the shared viewer."""

from __future__ import annotations

import io

import pytest


CSRF = {"X-CSRF-Token": "test-csrf-token"}
CASE = {"year": "2026", "month": "Jun", "case": "Alpha v. Beta"}


def _pdf(tag: bytes = b"ONE"):
    return io.BytesIO(b"%PDF-1.4\n" + tag + b"\n%%EOF\n")


@pytest.fixture()
def case_dir(tmp_path, monkeypatch):
    import app as app_module
    root = tmp_path / "fs"
    d = root / "2026" / "Jun" / "Alpha v. Beta"
    d.mkdir(parents=True)
    (d / "Note.json").write_text("{}")
    monkeypatch.setattr(app_module, "FS_ROOT", root)
    return d


def _upload(client, *files):
    data = {"Year": "2026", "Month": "Jun", "Case Name": "Alpha v. Beta",
            "Domain": "Brief", "file": list(files)}
    return client.post("/manage-case/upload", data=data, headers=CSRF,
                       content_type="multipart/form-data")


class TestUpload:
    def test_saves_brief_beside_note(self, auth_client, case_dir):
        r = _upload(auth_client, (_pdf(), "my brief for AMS.pdf"))
        assert r.status_code == 200, r.get_data(as_text=True)
        assert r.get_json()["replaced"] is False
        assert (case_dir / "Brief.pdf").is_file()
        assert (case_dir / "Note.json").read_text() == "{}", "the note must not be touched"

    def test_second_upload_overwrites(self, auth_client, case_dir):
        _upload(auth_client, (_pdf(b"FIRST"), "a.pdf"))
        r = _upload(auth_client, (_pdf(b"SECOND"), "b.pdf"))
        assert r.get_json()["replaced"] is True
        assert b"SECOND" in (case_dir / "Brief.pdf").read_bytes()
        pdfs = sorted(p.name for p in case_dir.iterdir() if p.suffix == ".pdf")
        assert pdfs == ["Brief.pdf"], "replace should overwrite, not keep a copy"
        assert not [p for p in case_dir.iterdir() if p.name.startswith(".")], "temp file left behind"

    def test_word_file_refused(self, auth_client, case_dir):
        r = _upload(auth_client, (io.BytesIO(b"PK\x03\x04word"), "brief.docx"))
        assert r.status_code == 400
        assert not (case_dir / "Brief.pdf").exists()

    def test_disguised_pdf_refused(self, auth_client, case_dir):
        r = _upload(auth_client, (io.BytesIO(b"not a pdf"), "brief.pdf"))
        assert r.status_code == 400

    def test_one_file_only(self, auth_client, case_dir):
        r = _upload(auth_client, (_pdf(), "a.pdf"), (_pdf(), "b.pdf"))
        assert r.status_code == 400
        assert not (case_dir / "Brief.pdf").exists()

    def test_failed_replace_keeps_old_brief(self, auth_client, case_dir):
        _upload(auth_client, (_pdf(b"KEEP"), "a.pdf"))
        _upload(auth_client, (io.BytesIO(b"garbage"), "b.pdf"))
        assert b"KEEP" in (case_dir / "Brief.pdf").read_bytes()


class TestReadAndDelete:
    def test_status_without_brief(self, auth_client, case_dir):
        body = auth_client.get("/api/case-brief", query_string=CASE).get_json()
        assert body == {"ok": True, "exists": False}

    def test_status_and_inline_file(self, auth_client, case_dir):
        _upload(auth_client, (_pdf(b"READ"), "a.pdf"))
        body = auth_client.get("/api/case-brief", query_string=CASE).get_json()
        assert body["exists"] is True and body["name"] == "Brief - Alpha v. Beta.pdf"
        r = auth_client.get("/api/case-brief/file", query_string=CASE)
        assert r.status_code == 200 and r.mimetype == "application/pdf"
        assert b"READ" in r.get_data()
        # Shown in the viewer's frame, so not an attachment, and revalidated
        # because a replacement keeps the same name.
        assert "attachment" not in r.headers.get("Content-Disposition", "")
        assert "no-cache" in r.headers.get("Cache-Control", "")

    def test_download_is_an_attachment(self, auth_client, case_dir):
        _upload(auth_client, (_pdf(), "a.pdf"))
        r = auth_client.get("/api/case-brief/file", query_string={**CASE, "download": "1"})
        assert "attachment" in r.headers.get("Content-Disposition", "")

    def test_staff_can_delete(self, auth_client, case_dir):
        _upload(auth_client, (_pdf(), "a.pdf"))
        r = auth_client.post("/api/case-brief/delete", json=CASE, headers=CSRF)
        assert r.status_code == 200
        assert not (case_dir / "Brief.pdf").exists()
        assert (case_dir / "Note.json").exists()

    def test_delete_without_brief_is_404(self, auth_client, case_dir):
        r = auth_client.post("/api/case-brief/delete", json=CASE, headers=CSRF)
        assert r.status_code == 404

    @pytest.mark.parametrize("over", [
        {"year": "../.."}, {"case": "../../etc"}, {"year": "Case Law"}, {"case": "Nope v. Nobody"},
    ])
    def test_bad_case_refused(self, auth_client, case_dir, over):
        r = auth_client.get("/api/case-brief", query_string={**CASE, **over})
        assert r.status_code == 400

    def test_bad_case_cannot_delete_outside(self, auth_client, case_dir, tmp_path):
        outside = tmp_path / "Brief.pdf"
        outside.write_bytes(b"%PDF-1.4\n%%EOF\n")
        auth_client.post("/api/case-brief/delete", json={**CASE, "year": "..", "month": "..",
                                                         "case": ".."}, headers=CSRF)
        assert outside.is_file()


def test_interns_cannot_reach_briefs(client, db, case_dir):
    from services.users import create_user, get_user_by_id, create_session
    user = get_user_by_id(create_user("intern2@example.com", "InternPass123!", role="intern"))
    token = create_session(user.id, user_agent="pytest", ip_address="127.0.0.1")
    with client.session_transaction() as sess:
        sess.update(session_token=token, user_id=user.id, user_role=user.role,
                    user_email=user.email, _csrf_token="test-csrf-token")
    r = client.get("/api/case-brief", query_string=CASE)
    assert r.status_code == 403 and r.is_json


def test_home_page_has_the_shared_viewer(auth_client, case_dir):
    body = auth_client.get("/").get_data(as_text=True)
    assert 'id="docViewer"' in body and 'id="docViewerBody"' in body


def test_create_case_returns_where_it_filed_the_case(auth_client, tmp_path, monkeypatch):
    """The form files a brief attached at creation using these, so they must
    name the case that was actually created."""
    import app as app_module
    root = tmp_path / "fs2"
    root.mkdir()
    monkeypatch.setattr(app_module, "FS_ROOT", root)
    r = auth_client.post("/create-case", data={
        "Petitioner Name": "Gamma", "Respondent Name": "Delta", "Date": "2026-11-21",
        "Our Party": "Petitioner", "Case Category": "Civil"}, headers=CSRF)
    body = r.get_json()
    assert body["ok"] is True
    assert (body["year"], body["month"], body["case"]) == ("2026", "Nov", "Gamma v. Delta")

    up = auth_client.post("/manage-case/upload", data={
        "Year": body["year"], "Month": body["month"], "Case Name": body["case"],
        "Domain": "Brief", "file": (_pdf(), "brief.pdf")},
        headers=CSRF, content_type="multipart/form-data")
    assert up.get_json()["ok"] is True
    assert (root / "2026" / "Nov" / "Gamma v. Delta" / "Brief.pdf").is_file()
