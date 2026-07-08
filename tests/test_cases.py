"""Tests for the reworked case classification + court model and file filing.

Covers:
- ``make_note_json`` → only a Case Category + a Current Status (no retired
  Case Type / Case Subcategory), with the origin/current court structure.
- ``/create-case`` → writes Note.json with the new structure for each
  Current Status (Same as Original / Transferred / In Appeal).
- ``/manage-case/upload`` → flattens a "/"-bearing File Subcategory into a
  single safe folder and never escapes FS_ROOT.
"""

from __future__ import annotations

import io
import json

import pytest


# ---------------------------------------------------------------------------
# Unit: make_note_json
# ---------------------------------------------------------------------------
class TestMakeNoteJson:
    def test_classification_is_category_only(self, app):
        from app import make_note_json

        obj = json.loads(make_note_json({
            "Petitioner Name": "A", "Respondent Name": "B",
            "Case Category": "Civil",
            "Current Status": "Same as Original",
        }))
        assert obj["Case Category"] == "Civil"
        assert obj["Current Status"] == "Same as Original"
        assert "Case Subcategory" not in obj
        assert "Case Type" not in obj
        assert set(obj["Court of Origin"].keys()) == {"State", "District", "Court/Forum"}

    def test_court_values_passthrough(self, app):
        from app import make_note_json

        obj = json.loads(make_note_json({
            "Origin State": "Delhi", "Origin District": "New Delhi",
            "Origin Court/Forum": "District Court",
            "Current Status": "In Appeal",
            "Current Court/Forum": "Supreme Court of India",
        }))
        assert obj["Court of Origin"]["State"] == "Delhi"
        assert obj["Current Status"] == "In Appeal"
        assert obj["Current Court/Forum"]["Court/Forum"] == "Supreme Court of India"


# ---------------------------------------------------------------------------
# Route: /create-case
# ---------------------------------------------------------------------------
class TestCreateCase:
    CSRF = {"X-CSRF-Token": "test-csrf-token"}

    def _create(self, client, fsroot, monkeypatch, extra):
        import app as app_module
        monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
        fsroot.mkdir(parents=True, exist_ok=True)
        data = {
            "Petitioner Name": "Alpha", "Respondent Name": "Beta",
            "Case Name": "Alpha v. Beta",
            "Date": "2026-06-15",
            "Case Category": "Civil",
            "Origin State": "Delhi", "Origin District": "New Delhi",
            "Origin Court/Forum": "Tis Hazari District Court",
        }
        data.update(extra)
        return client.post("/create-case", data=data, headers=self.CSRF,
                           content_type="multipart/form-data")

    def _read_note(self, fsroot):
        note = fsroot / "2026" / "Jun" / "Alpha v. Beta" / "Note.json"
        assert note.exists(), "Note.json was not written"
        return json.loads(note.read_text(encoding="utf-8"))

    def test_same_as_original(self, auth_client, tmp_path, monkeypatch):
        resp = self._create(auth_client, tmp_path / "fs", monkeypatch,
                            {"Current Status": "Same as Original"})
        assert resp.status_code == 200 and resp.get_json()["ok"]
        obj = self._read_note(tmp_path / "fs")
        assert obj["Case Category"] == "Civil"
        assert obj["Current Status"] == "Same as Original"
        assert obj["Court of Origin"]["Court/Forum"] == "Tis Hazari District Court"
        cur = obj["Current Court/Forum"]
        assert cur["State"] == "" and cur["District"] == "" and cur["Court/Forum"] == ""
        assert "Case Type" not in obj and "Case Subcategory" not in obj

    def test_transferred(self, auth_client, tmp_path, monkeypatch):
        resp = self._create(auth_client, tmp_path / "fs", monkeypatch, {
            "Current Status": "Transferred",
            "Current State": "Maharashtra", "Current District": "Mumbai",
            "Current Court/Forum": "Bombay High Court",
        })
        assert resp.status_code == 200
        cur = self._read_note(tmp_path / "fs")["Current Court/Forum"]
        assert cur["State"] == "Maharashtra"
        assert cur["District"] == "Mumbai"
        assert cur["Court/Forum"] == "Bombay High Court"

    def test_in_appeal(self, auth_client, tmp_path, monkeypatch):
        resp = self._create(auth_client, tmp_path / "fs", monkeypatch, {
            "Current Status": "In Appeal",
            "Current State": "", "Current District": "",
            "Current Court/Forum": "Supreme Court of India",
        })
        assert resp.status_code == 200
        obj = self._read_note(tmp_path / "fs")
        assert obj["Current Status"] == "In Appeal"
        cur = obj["Current Court/Forum"]
        assert cur["Court/Forum"] == "Supreme Court of India"
        assert cur["State"] == "" and cur["District"] == ""


# ---------------------------------------------------------------------------
# Route: /manage-case/upload — File Subcategory folder safety
# ---------------------------------------------------------------------------
class TestHomeRenders:
    def test_home_has_new_markup(self, auth_client):
        body = auth_client.get("/").get_data(as_text=True)
        # New note-modal court model + advanced-search subcategory host.
        assert 'id="note-case-current-status"' in body
        assert 'id="note-case-origin-forum-host"' in body
        assert 'id="adv-subcat-host"' in body
        # Retired classification fields are gone.
        assert 'id="note-case-subcategory"' not in body
        assert 'id="note-case-type"' not in body


class TestManageUploadSubcategory:
    CSRF = {"X-CSRF-Token": "test-csrf-token"}

    def _pdf(self):
        return io.BytesIO(b"%PDF-1.4\n%%EOF\n")

    def _case_dir(self, fsroot):
        d = fsroot / "2026" / "Jun" / "Alpha v. Beta"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _upload(self, client, fsroot, monkeypatch, subcategory):
        import app as app_module
        monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
        self._case_dir(fsroot)
        data = {
            "Year": "2026", "Month": "Jun", "Case Name": "Alpha v. Beta",
            "Domain": "Criminal", "Subcategory": subcategory,
            "Main Type": "", "Date": "2026-06-15",
            "file": (self._pdf(), "doc.pdf"),
        }
        return client.post("/manage-case/upload", data=data, headers=self.CSRF,
                           content_type="multipart/form-data")

    def test_slash_subcategory_becomes_single_folder(self, auth_client, tmp_path, monkeypatch):
        fsroot = tmp_path / "fs"
        resp = self._upload(auth_client, fsroot, monkeypatch,
                            "Section 482 CrPC / Section 528 BNSS")
        assert resp.status_code == 200, resp.get_data(as_text=True)
        case = fsroot / "2026" / "Jun" / "Alpha v. Beta"
        # Flattened to ONE folder (no nested "Section 528 BNSS" under "Section 482 CrPC").
        flat = case / "Section 482 CrPC - Section 528 BNSS"
        assert flat.is_dir()
        assert not (case / "Section 482 CrPC").exists()
        assert list(flat.glob("*.pdf")), "uploaded file not stored in the flattened folder"

    def test_traversal_subcategory_stays_within_case(self, auth_client, tmp_path, monkeypatch):
        fsroot = tmp_path / "fs"
        resp = self._upload(auth_client, fsroot, monkeypatch, "../../../../etc")
        # Either rejected, or sanitised to a literal folder inside the case — never
        # written outside FS_ROOT.
        assert resp.status_code in (200, 400)
        assert not (tmp_path / "etc").exists()
        for stray in ("etc",):
            assert not (fsroot.parent / stray).exists()
