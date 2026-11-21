"""Tests for the Interns page: applicants, their documents and their status."""

from __future__ import annotations

import io

import pytest


CSRF = {"X-CSRF-Token": "test-csrf-token"}
PDF = b"%PDF-1.4\n%%EOF\n"


def _pdf(body: bytes = PDF):
    return io.BytesIO(body)


@pytest.fixture()
def fsroot(tmp_path, monkeypatch):
    import app as app_module
    root = tmp_path / "fs"
    root.mkdir()
    monkeypatch.setattr(app_module, "FS_ROOT", root)
    return root


@pytest.fixture()
def intern_client(client, db):
    from services.users import create_user, get_user_by_id, create_session
    user = get_user_by_id(create_user("intern@example.com", "InternPass123!", role="intern"))
    token = create_session(user.id, user_agent="pytest", ip_address="127.0.0.1")
    with client.session_transaction() as sess:
        sess["session_token"] = token
        sess["user_id"] = user.id
        sess["user_role"] = user.role
        sess["user_email"] = user.email
        sess["_csrf_token"] = "test-csrf-token"
    return client


def _create(client, **over):
    data = {
        "name": "Aadya Sharma", "email": "aadya@example.com", "phone": "98100 00000",
        "college": "Faculty of Law, DU", "applied_on": "2026-11-02",
    }
    data.update(over)
    return client.post("/api/interns", data=data, headers=CSRF,
                       content_type="multipart/form-data")


def _list(client):
    body = client.get("/api/interns").get_json()
    assert body["ok"] is True
    return body


class TestCreate:
    def test_creates_applicant_in_process_with_documents(self, auth_client, fsroot):
        r = _create(auth_client,
                    cv=(_pdf(), "my cv.pdf"),
                    cover_letter=(_pdf(), "cover.pdf"),
                    lor=[(_pdf(), "lor1.pdf"), (_pdf(), "lor2.pdf")])
        assert r.status_code == 200, r.get_data(as_text=True)
        body = _list(auth_client)
        assert body["counts"] == {"in_process": 1, "accepted": 0, "rejected": 0}
        a = body["applicants"][0]
        assert a["name"] == "Aadya Sharma" and a["college"] == "Faculty of Law, DU"
        assert a["status"] == "in_process" and a["applied_on"] == "2026-11-02"
        kinds = sorted(d["kind"] for d in a["documents"])
        assert kinds == ["cover_letter", "cv", "lor", "lor"]
        assert not any(d["missing"] for d in a["documents"])

    def test_files_live_under_interns_folder(self, auth_client, fsroot):
        _create(auth_client, cv=(_pdf(), "cv.pdf"))
        folder = next((fsroot / "Interns").iterdir())
        assert folder.name.endswith("Aadya Sharma")
        assert (folder / "CV - Aadya Sharma.pdf").is_file()

    def test_documents_are_optional(self, auth_client, fsroot):
        assert _create(auth_client).status_code == 200
        assert _list(auth_client)["applicants"][0]["documents"] == []

    @pytest.mark.parametrize("over,needle", [
        ({"name": ""}, "name"),
        ({"applied_on": ""}, "Date"),
        ({"applied_on": "2026-02-31"}, "valid date"),
        ({"email": "not-an-email"}, "email"),
    ])
    def test_bad_details_rejected(self, auth_client, fsroot, over, needle):
        r = _create(auth_client, **over)
        assert r.status_code == 400
        assert needle.lower() in r.get_json()["msg"].lower()
        assert _list(auth_client)["applicants"] == []

    def test_bad_document_creates_nothing(self, auth_client, fsroot):
        """One bad file must not leave a half-made applicant behind."""
        r = _create(auth_client, cv=(_pdf(), "cv.pdf"),
                    lor=[(io.BytesIO(b"MZ binary"), "virus.exe")])
        assert r.status_code == 400
        assert _list(auth_client)["applicants"] == []
        assert not (fsroot / "Interns").exists() or not any((fsroot / "Interns").iterdir())

    def test_disguised_file_rejected(self, auth_client, fsroot):
        r = _create(auth_client, cv=(io.BytesIO(b"not really a pdf"), "cv.pdf"))
        assert r.status_code == 400

    def test_json_is_not_accepted_as_a_document(self, auth_client, fsroot):
        r = _create(auth_client, cv=(io.BytesIO(b"{}"), "cv.json"))
        assert r.status_code == 400


class TestManage:
    def _one(self, client):
        _create(client, cv=(_pdf(b"%PDF-1.4\nOLD\n%%EOF\n"), "cv.pdf"))
        return _list(client)["applicants"][0]

    @pytest.mark.parametrize("status", ["accepted", "rejected", "in_process"])
    def test_status_moves(self, auth_client, fsroot, status):
        a = self._one(auth_client)
        r = auth_client.post(f"/api/interns/{a['id']}/status", json={"status": status}, headers=CSRF)
        assert r.status_code == 200
        assert _list(auth_client)["counts"][status] == 1

    def test_unknown_status_refused(self, auth_client, fsroot):
        a = self._one(auth_client)
        r = auth_client.post(f"/api/interns/{a['id']}/status", json={"status": "hired"}, headers=CSRF)
        assert r.status_code == 400

    def test_edit_details_keeps_folder(self, auth_client, fsroot):
        a = self._one(auth_client)
        folder_before = sorted(p.name for p in (fsroot / "Interns").iterdir())
        r = auth_client.post(f"/api/interns/{a['id']}", json={
            "name": "Aadya S.", "email": "", "phone": "", "college": "NLU",
            "applied_on": "2026-11-05"}, headers=CSRF)
        assert r.status_code == 200
        b = _list(auth_client)["applicants"][0]
        assert b["name"] == "Aadya S." and b["college"] == "NLU"
        # Renaming the applicant must not orphan their files.
        assert sorted(p.name for p in (fsroot / "Interns").iterdir()) == folder_before
        assert not any(d["missing"] for d in b["documents"])

    def test_cv_upload_replaces_the_old_one(self, auth_client, fsroot):
        a = self._one(auth_client)
        r = auth_client.post(f"/api/interns/{a['id']}/documents", data={
            "kind": "cv", "file": (_pdf(b"%PDF-1.4\nNEW\n%%EOF\n"), "cv2.pdf")},
            headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 200, r.get_data(as_text=True)
        docs = [d for d in _list(auth_client)["applicants"][0]["documents"] if d["kind"] == "cv"]
        assert len(docs) == 1
        files = list(next((fsroot / "Interns").iterdir()).glob("CV*"))
        assert len(files) == 1, "the old CV was left on disk"
        assert files[0].name == "CV - Aadya Sharma.pdf", "replacement kept a suffixed name"
        assert b"NEW" in files[0].read_bytes()

    def test_cv_takes_one_file(self, auth_client, fsroot):
        a = self._one(auth_client)
        r = auth_client.post(f"/api/interns/{a['id']}/documents", data={
            "kind": "cv", "file": [(_pdf(), "a.pdf"), (_pdf(), "b.pdf")]},
            headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_lors_accumulate(self, auth_client, fsroot):
        a = self._one(auth_client)
        for name in ("lor-a.pdf", "lor-b.pdf", "lor-c.pdf"):
            auth_client.post(f"/api/interns/{a['id']}/documents", data={
                "kind": "lor", "file": (_pdf(), name)},
                headers=CSRF, content_type="multipart/form-data")
        lors = [d for d in _list(auth_client)["applicants"][0]["documents"] if d["kind"] == "lor"]
        assert len(lors) == 3
        assert len({d["name"] for d in lors}) == 3, "LOR files collided on disk"

    def test_remove_document_deletes_file(self, auth_client, fsroot):
        a = self._one(auth_client)
        doc = a["documents"][0]
        r = auth_client.post(f"/api/interns/documents/{doc['id']}/delete", headers=CSRF)
        assert r.status_code == 200
        assert _list(auth_client)["applicants"][0]["documents"] == []
        assert not list(next((fsroot / "Interns").iterdir()).glob("CV*"))

    def test_download_document(self, auth_client, fsroot):
        a = self._one(auth_client)
        doc = a["documents"][0]
        r = auth_client.get(f"/api/interns/documents/{doc['id']}?download=1")
        assert r.status_code == 200
        assert b"OLD" in r.get_data()
        assert "attachment" in r.headers.get("Content-Disposition", "")

    def test_unknown_applicant_and_document_are_404(self, auth_client, fsroot):
        assert auth_client.post("/api/interns/999/status", json={"status": "accepted"},
                                headers=CSRF).status_code == 404
        assert auth_client.get("/api/interns/documents/999").status_code == 404

    def test_tampered_path_is_never_served(self, auth_client, fsroot, db):
        """A stored path pointing outside Interns/ is refused, not followed."""
        a = self._one(auth_client)
        secret = fsroot / "2026" / "Jun" / "Case" / "secret.pdf"
        secret.parent.mkdir(parents=True)
        secret.write_bytes(PDF)
        db.execute("UPDATE intern_documents SET file_path = ? WHERE applicant_id = ?",
                   ("2026/Jun/Case/secret.pdf", a["id"]))
        db.commit()
        doc_id = a["documents"][0]["id"]
        assert auth_client.get(f"/api/interns/documents/{doc_id}").status_code == 404
        auth_client.post(f"/api/interns/documents/{doc_id}/delete", headers=CSRF)
        assert secret.is_file(), "deleting a tampered record removed a case file"


class TestAccess:
    def test_page_renders_for_staff(self, auth_client, fsroot):
        body = auth_client.get("/interns").get_data(as_text=True)
        assert 'id="card-intern-new"' in body and 'id="card-intern-manage"' in body
        assert 'href="/certificate"' in body
        assert body.index("js/main.js") < body.index("js/interns.js")
        assert 'id="confirmModal"' in body

    def test_menu_entry_for_staff(self, auth_client, fsroot):
        assert 'href="/interns"' in auth_client.get("/").get_data(as_text=True)

    def test_interns_are_kept_out(self, intern_client, fsroot):
        r = intern_client.get("/interns")
        assert r.status_code == 302
        r = intern_client.get("/api/interns")
        assert r.status_code == 403 and r.is_json
        assert 'href="/interns"' not in intern_client.get("/").get_data(as_text=True)


def test_schema_is_v12(db):
    row = db.execute("SELECT value FROM app_meta WHERE key = 'schema_version'").fetchone()
    assert row["value"] == "12"


@pytest.fixture()
def admin_client(client, test_admin):
    from services.users import create_session
    token = create_session(test_admin.id, user_agent="pytest", ip_address="127.0.0.1")
    with client.session_transaction() as sess:
        sess["session_token"] = token
        sess["user_id"] = test_admin.id
        sess["user_role"] = test_admin.role
        sess["user_email"] = test_admin.email
        sess["_csrf_token"] = "test-csrf-token"
    return client


class TestDelete:
    def _one(self, client):
        _create(client, cv=(_pdf(), "cv.pdf"), lor=[(_pdf(), "l1.pdf"), (_pdf(), "l2.pdf")])
        return _list(client)["applicants"][0]

    def test_admin_deletes_applicant_documents_and_folder(self, admin_client, fsroot, db):
        a = self._one(admin_client)
        folder = next((fsroot / "Interns").iterdir())
        r = admin_client.post(f"/api/interns/{a['id']}/delete", headers=CSRF)
        assert r.status_code == 200, r.get_data(as_text=True)
        assert _list(admin_client)["applicants"] == []
        assert not folder.exists()
        left = db.execute("SELECT COUNT(*) AS n FROM intern_documents").fetchone()["n"]
        assert left == 0
        # Interns/ itself survives — only the applicant's own folder goes.
        assert (fsroot / "Interns").is_dir()

    def test_staff_cannot_delete(self, auth_client, fsroot):
        a = self._one(auth_client)
        r = auth_client.post(f"/api/interns/{a['id']}/delete", headers=CSRF)
        assert r.status_code == 403
        assert len(_list(auth_client)["applicants"]) == 1

    def test_unknown_applicant_is_404(self, admin_client, fsroot):
        assert admin_client.post("/api/interns/999/delete", headers=CSRF).status_code == 404

    def test_tampered_folder_outside_interns_is_left_alone(self, admin_client, fsroot, db):
        a = self._one(admin_client)
        case = fsroot / "2026" / "Jun" / "Alpha v. Beta"
        case.mkdir(parents=True)
        (case / "Note.json").write_text("{}")
        db.execute("UPDATE intern_applicants SET folder = ? WHERE id = ?",
                   ("2026/Jun/Alpha v. Beta", a["id"]))
        db.commit()
        admin_client.post(f"/api/interns/{a['id']}/delete", headers=CSRF)
        assert (case / "Note.json").is_file(), "deleting an applicant removed a case folder"

    def test_interns_folder_itself_is_never_removed(self, admin_client, fsroot, db):
        a = self._one(admin_client)
        db.execute("UPDATE intern_applicants SET folder = 'Interns' WHERE id = ?", (a["id"],))
        db.commit()
        admin_client.post(f"/api/interns/{a['id']}/delete", headers=CSRF)
        assert (fsroot / "Interns").is_dir()
