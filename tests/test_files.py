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
