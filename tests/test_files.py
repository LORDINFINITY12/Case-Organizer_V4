"""Tests for the Files page — a Drive-like view confined to the case tree.

The scope rule is the whole security story here: everything under
``FS_ROOT/<YYYY>/…`` is fair game, and every other top-level directory
(Case Law, Invoices, Letterheads, …) must be unreachable.
"""

from __future__ import annotations

import pytest


CSRF = {"X-CSRF-Token": "test-csrf-token"}

# Every non-case top-level directory the store actually uses.
NON_CASE_DIRS = ["Case Law", "Invoices", "Letterheads",
                 "Vakalatnamas", "Certificates", "Legal_Notices"]


@pytest.fixture()
def fsroot(tmp_path, monkeypatch):
    """An FS_ROOT with one real case and every non-case sibling populated."""
    import app as app_module

    root = tmp_path / "fs"
    case = root / "2026" / "Jun" / "Alpha v. Beta"
    (case / "Anticipatory Bail" / "Pleadings").mkdir(parents=True)
    (case / "Anticipatory Bail" / "Pleadings" / "petition.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
    (case / "Note.json").write_text("{}")
    for name in NON_CASE_DIRS:
        d = root / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "secret.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
    # A realistically-nested case-law judgement: the search page deletes these
    # through /api/delete-item, and depth < 3 is refused outright.
    law = root / "Case Law" / "Civil" / "Others" / "Foo vs Bar"
    law.mkdir(parents=True, exist_ok=True)
    (law / "judgment.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
    monkeypatch.setattr(app_module, "FS_ROOT", root)
    return root


class TestScope:
    def test_root_lists_only_year_directories(self, auth_client, fsroot):
        body = auth_client.get("/api/files/list").get_json()
        assert body["ok"] is True
        names = [d["name"] for d in body["dirs"]]
        assert names == ["2026"]
        for name in NON_CASE_DIRS:
            assert name not in names

    @pytest.mark.parametrize("name", NON_CASE_DIRS)
    def test_non_case_directories_are_unreachable(self, auth_client, fsroot, name):
        resp = auth_client.get("/api/files/list", query_string={"path": name})
        assert resp.status_code == 400
        assert resp.get_json()["ok"] is False

    def test_traversal_rejected(self, auth_client, fsroot):
        for bad in ["../../etc", "2026/../../etc", "..", "./.."]:
            resp = auth_client.get("/api/files/list", query_string={"path": bad})
            assert resp.status_code == 400, bad

    def test_symlink_out_of_the_tree_is_rejected(self, auth_client, fsroot):
        """The year check must run AFTER resolution, or a symlink defeats it."""
        link = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "shortcut"
        link.symlink_to(fsroot / "Case Law", target_is_directory=True)
        resp = auth_client.get("/api/files/list", query_string={
            "path": "2026/Jun/Alpha v. Beta/shortcut"})
        assert resp.status_code == 400
        assert "case tree" in resp.get_json()["msg"]


class TestListing:
    def test_lists_dirs_and_files_with_metadata(self, auth_client, fsroot):
        body = auth_client.get("/api/files/list", query_string={
            "path": "2026/Jun/Alpha v. Beta/Anticipatory Bail/Pleadings"}).get_json()
        assert [f["name"] for f in body["files"]] == ["petition.pdf"]
        entry = body["files"][0]
        assert entry["size"] > 0
        assert entry["mtime"] > 0
        assert entry["viewable"] is True
        assert entry["rel"].endswith("Pleadings/petition.pdf")
        assert entry["abs"].startswith(str(fsroot))

    def test_non_whitelisted_files_are_listed_but_not_viewable(self, auth_client, fsroot):
        case = fsroot / "2026" / "Jun" / "Alpha v. Beta"
        (case / "notes.md").write_text("# research")
        body = auth_client.get("/api/files/list", query_string={
            "path": "2026/Jun/Alpha v. Beta"}).get_json()
        md = [f for f in body["files"] if f["name"] == "notes.md"]
        assert md, "a non-whitelisted file must still be visible"
        assert md[0]["viewable"] is False

    def test_crumbs_and_parent(self, auth_client, fsroot):
        body = auth_client.get("/api/files/list", query_string={
            "path": "2026/Jun/Alpha v. Beta"}).get_json()
        assert [c["name"] for c in body["crumbs"]] == ["2026", "Jun", "Alpha v. Beta"]
        assert body["crumbs"][1]["rel"] == "2026/Jun"
        assert body["parent"] == "2026/Jun"
        assert body["depth"] == 3

    def test_missing_folder_is_404(self, auth_client, fsroot):
        resp = auth_client.get("/api/files/list", query_string={"path": "2026/Jun/Nope"})
        assert resp.status_code == 404

    def test_can_delete_is_false_for_non_admin(self, auth_client, fsroot):
        body = auth_client.get("/api/files/list").get_json()
        assert body["can_delete"] is False
        assert body["can_write"] is True


@pytest.fixture
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


PLEADINGS = "2026/Jun/Alpha v. Beta/Anticipatory Bail/Pleadings"


class TestRenameItem:
    def test_renames_a_file(self, auth_client, fsroot):
        r = auth_client.post("/api/rename-item", json={
            "rel": f"{PLEADINGS}/petition.pdf", "new_name": "Anticipatory Bail Petition.pdf",
        }, headers=CSRF)
        assert r.status_code == 200, r.get_data(as_text=True)
        base = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Anticipatory Bail" / "Pleadings"
        assert (base / "Anticipatory Bail Petition.pdf").is_file()
        assert not (base / "petition.pdf").exists()

    def test_renames_a_folder(self, auth_client, fsroot):
        r = auth_client.post("/api/rename-item", json={
            "rel": PLEADINGS, "new_name": "Court Copies"}, headers=CSRF)
        assert r.status_code == 200
        base = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Anticipatory Bail"
        assert (base / "Court Copies").is_dir()

    def test_case_folder_is_refused(self, auth_client, fsroot):
        r = auth_client.post("/api/rename-item", json={
            "rel": "2026/Jun/Alpha v. Beta", "new_name": "Gamma v. Delta"}, headers=CSRF)
        assert r.status_code == 403
        assert "case rename" in r.get_json()["msg"]
        assert (fsroot / "2026" / "Jun" / "Alpha v. Beta").is_dir()

    def test_extension_cannot_change(self, auth_client, fsroot):
        r = auth_client.post("/api/rename-item", json={
            "rel": f"{PLEADINGS}/petition.pdf", "new_name": "petition.html"}, headers=CSRF)
        assert r.status_code == 400
        assert "extension" in r.get_json()["msg"]

    def test_existing_target_is_conflict(self, auth_client, fsroot):
        base = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Anticipatory Bail" / "Pleadings"
        (base / "other.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
        r = auth_client.post("/api/rename-item", json={
            "rel": f"{PLEADINGS}/petition.pdf", "new_name": "other.pdf"}, headers=CSRF)
        assert r.status_code == 409

    def test_windows_reserved_name_refused(self, auth_client, fsroot):
        r = auth_client.post("/api/rename-item", json={
            "rel": f"{PLEADINGS}/petition.pdf", "new_name": "CON.pdf"}, headers=CSRF)
        assert r.status_code == 400

    def test_outside_case_tree_refused(self, auth_client, fsroot):
        r = auth_client.post("/api/rename-item", json={
            "rel": "Case Law/secret.pdf", "new_name": "mine.pdf"}, headers=CSRF)
        assert r.status_code == 400
        assert (fsroot / "Case Law" / "secret.pdf").is_file()


class TestNewFolder:
    def test_creates_a_standard_subfolder(self, auth_client, fsroot):
        r = auth_client.post("/api/files/new-folder", json={
            "rel": "2026/Jun/Alpha v. Beta", "name": "Research"}, headers=CSRF)
        assert r.status_code == 200, r.get_data(as_text=True)
        assert (fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Research").is_dir()

    def test_arbitrary_names_refused(self, auth_client, fsroot):
        r = auth_client.post("/api/files/new-folder", json={
            "rel": "2026/Jun/Alpha v. Beta", "name": "Random Thoughts"}, headers=CSRF)
        assert r.status_code == 400
        assert not (fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Random Thoughts").exists()

    def test_refused_above_case_level(self, auth_client, fsroot):
        r = auth_client.post("/api/files/new-folder", json={
            "rel": "2026/Jun", "name": "Research"}, headers=CSRF)
        assert r.status_code == 400
        assert not (fsroot / "2026" / "Jun" / "Research").exists()


class TestFilesUpload:
    def _pdf(self):
        import io
        return io.BytesIO(b"%PDF-1.4\n%%EOF\n")

    def test_standard_naming_appends_case_name(self, auth_client, fsroot):
        r = auth_client.post("/api/files/upload", data={
            "rel": PLEADINGS, "file": (self._pdf(), "affidavit.pdf"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 200, r.get_data(as_text=True)
        base = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Anticipatory Bail" / "Pleadings"
        # secure_filename underscores the spaces, which is the convention
        # every existing case file on the server already follows.
        assert (base / "affidavit_-_Alpha_v._Beta.pdf").is_file()

    def test_original_naming_keeps_the_name(self, auth_client, fsroot):
        r = auth_client.post("/api/files/upload", data={
            "rel": PLEADINGS, "naming": "original", "file": (self._pdf(), "affidavit.pdf"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 200
        base = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Anticipatory Bail" / "Pleadings"
        assert (base / "affidavit.pdf").is_file()

    def test_refused_above_case_level(self, auth_client, fsroot):
        r = auth_client.post("/api/files/upload", data={
            "rel": "2026/Jun", "file": (self._pdf(), "stray.pdf"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 400
        assert not (fsroot / "2026" / "Jun" / "stray.pdf").exists()

    def test_non_whitelisted_type_not_saved(self, auth_client, fsroot):
        import io
        r = auth_client.post("/api/files/upload", data={
            "rel": PLEADINGS, "file": (io.BytesIO(b"MZ binary"), "tool.exe"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 400
        base = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Anticipatory Bail" / "Pleadings"
        assert not list(base.glob("*.exe"))


class TestReplace:
    def _pdf(self, body=b"%PDF-1.4\nREPLACED\n%%EOF\n"):
        import io
        return io.BytesIO(body)

    def test_content_swapped_name_unchanged(self, auth_client, fsroot):
        target = (fsroot / "2026" / "Jun" / "Alpha v. Beta"
                  / "Anticipatory Bail" / "Pleadings" / "petition.pdf")
        r = auth_client.post("/api/files/replace", data={
            "rel": f"{PLEADINGS}/petition.pdf", "file": (self._pdf(), "whatever.pdf"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 200, r.get_data(as_text=True)
        assert target.is_file()
        assert b"REPLACED" in target.read_bytes()

    def test_wrong_type_refused_and_original_intact(self, auth_client, fsroot):
        import io
        target = (fsroot / "2026" / "Jun" / "Alpha v. Beta"
                  / "Anticipatory Bail" / "Pleadings" / "petition.pdf")
        before = target.read_bytes()
        r = auth_client.post("/api/files/replace", data={
            "rel": f"{PLEADINGS}/petition.pdf",
            "file": (io.BytesIO(b"PK\x03\x04docx"), "thing.docx"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 400
        assert target.read_bytes() == before, "the original must survive a rejected replace"

    def test_no_temp_file_left_behind(self, auth_client, fsroot):
        base = (fsroot / "2026" / "Jun" / "Alpha v. Beta"
                / "Anticipatory Bail" / "Pleadings")
        auth_client.post("/api/files/replace", data={
            "rel": f"{PLEADINGS}/petition.pdf", "file": (self._pdf(), "x.pdf"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert not list(base.glob("*.tmp-*")), "a spool temp survived the swap"

    def test_directory_cannot_be_replaced(self, auth_client, fsroot):
        r = auth_client.post("/api/files/replace", data={
            "rel": PLEADINGS, "file": (self._pdf(), "x.pdf"),
        }, headers=CSRF, content_type="multipart/form-data")
        assert r.status_code == 404


class TestDeleteScope:
    def test_scope_cases_refuses_outside_the_tree(self, admin_client, fsroot):
        law = "Case Law/Civil/Others/Foo vs Bar/judgment.pdf"
        r = admin_client.post("/api/delete-item", json={
            "rel": law, "scope": "cases"}, headers=CSRF)
        assert r.status_code == 403
        assert (fsroot / law).is_file()

    def test_without_scope_existing_callers_unaffected(self, admin_client, fsroot):
        """The search page deletes case-law files through this same route."""
        law = "Case Law/Civil/Others/Foo vs Bar/judgment.pdf"
        r = admin_client.post("/api/delete-item", json={"rel": law}, headers=CSRF)
        assert r.status_code == 200, r.get_data(as_text=True)
        assert not (fsroot / law).exists()

    def test_scope_cases_allows_inside_the_tree(self, admin_client, fsroot):
        r = admin_client.post("/api/delete-item", json={
            "rel": f"{PLEADINGS}/petition.pdf", "scope": "cases"}, headers=CSRF)
        assert r.status_code == 200, r.get_data(as_text=True)
