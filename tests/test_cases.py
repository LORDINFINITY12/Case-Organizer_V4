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

    def test_misc_proceeding_nests_under_subcategory(self, auth_client, tmp_path, monkeypatch):
        import app as app_module
        fsroot = tmp_path / "fs"
        monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
        self._case_dir(fsroot)
        data = {
            "Year": "2026", "Month": "Jun", "Case Name": "Alpha v. Beta",
            "Domain": "Civil", "Subcategory": "Writ Petition",
            "Proceeding": "Interim Injunction", "Subfolder": "Pleadings",
            "Main Type": "", "Date": "2026-06-15",
            "file": (self._pdf(), "draft.pdf"),
        }
        resp = auth_client.post("/manage-case/upload", data=data, headers=self.CSRF,
                                content_type="multipart/form-data")
        assert resp.status_code == 200, resp.get_data(as_text=True)
        target = (fsroot / "2026" / "Jun" / "Alpha v. Beta"
                  / "Writ Petition" / "Interim Injunction" / "Pleadings")
        assert target.is_dir()
        assert list(target.glob("*.pdf")), "file not stored in the nested proceeding folder"

    def test_invalid_standard_subfolder_rejected(self, auth_client, tmp_path, monkeypatch):
        import app as app_module
        fsroot = tmp_path / "fs"
        monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
        self._case_dir(fsroot)
        data = {
            "Year": "2026", "Month": "Jun", "Case Name": "Alpha v. Beta",
            "Domain": "Civil", "Subcategory": "Writ Petition",
            "Subfolder": "Not A Standard Folder",
            "Main Type": "", "Date": "2026-06-15",
            "file": (self._pdf(), "x.pdf"),
        }
        resp = auth_client.post("/manage-case/upload", data=data, headers=self.CSRF,
                                content_type="multipart/form-data")
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Chunked uploads (Cloudflare's 100 MB body limit)
# ---------------------------------------------------------------------------
class TestChunkedUpload:
    """A sliced upload must land byte-identical and go through the same
    validation as a direct one."""

    @staticmethod
    def _login(client, user):
        from services.users import create_session
        token = create_session(user.id, user_agent="pytest", ip_address="127.0.0.1")
        with client.session_transaction() as sess:
            sess["session_token"] = token
            sess["user_id"] = user.id
            sess["user_role"] = user.role
            sess["user_email"] = user.email
            sess["_csrf_token"] = "test-csrf-token"
        return client

    def test_chunks_reassemble_in_order(self, client, test_user, app):
        import io, json
        self._login(client, test_user)
        parts = [b"%PDF-1.4 " + bytes([65 + i]) * 32 for i in range(4)]
        for i, part in enumerate(parts):
            r = client.post("/api/upload/chunk", data={
                "upload_id": "abcd1234efgh", "index": str(i),
                "chunk": (io.BytesIO(part), "big.pdf"),
            }, content_type="multipart/form-data",
               headers={"X-CSRF-Token": "test-csrf-token"})
            assert r.status_code == 200, r.get_json()
            assert r.get_json()["ok"] is True

        import app as app_mod
        spool = app_mod._chunk_path("abcd1234efgh")
        assert spool.read_bytes() == b"".join(parts), "chunks did not reassemble in order"

    def test_index_zero_restarts_a_retried_upload(self, client, test_user, app):
        """A retry must not append to the leftovers of a failed attempt."""
        import io
        self._login(client, test_user)
        for payload in (b"%PDF-1.4 first attempt", b"%PDF-1.4 retry"):
            client.post("/api/upload/chunk", data={
                "upload_id": "retry1234567", "index": "0",
                "chunk": (io.BytesIO(payload), "f.pdf"),
            }, content_type="multipart/form-data",
               headers={"X-CSRF-Token": "test-csrf-token"})
        import app as app_mod
        assert app_mod._chunk_path("retry1234567").read_bytes() == b"%PDF-1.4 retry"

    def test_upload_id_cannot_escape_the_spool(self, client, test_user, app):
        import io
        self._login(client, test_user)
        for bad in ("../../etc/passwd", "a/b", "..", "x" * 200, ""):
            r = client.post("/api/upload/chunk", data={
                "upload_id": bad, "index": "0",
                "chunk": (io.BytesIO(b"x"), "f.pdf"),
            }, content_type="multipart/form-data",
               headers={"X-CSRF-Token": "test-csrf-token"})
            assert r.status_code == 400, f"{bad!r} was accepted"

    def test_anonymous_cannot_upload_chunks(self, client, app):
        import io
        r = client.post("/api/upload/chunk", data={
            "upload_id": "anon12345678", "index": "0",
            "chunk": (io.BytesIO(b"x"), "f.pdf"),
        }, content_type="multipart/form-data",
           headers={"X-CSRF-Token": "test-csrf-token"})
        assert r.status_code in (302, 401, 403)

    def test_a_chunked_upload_lands_in_the_case_folder(self, client, test_user, app,
                                                       tmp_path, monkeypatch):
        """The handoff, end to end — spool through to a file on disk.

        The tests above only ever exercised /api/upload/chunk, the part that
        writes the spool. Nothing drove the other half, where the finished
        spool is turned back into an upload, so a NameError on that line
        survived a full green suite and shipped: every chunked upload 500'd.
        """
        import io, json
        import app as app_module
        fsroot = tmp_path / "fs"
        monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
        self._login(client, test_user)

        case_dir = fsroot / "2026" / "Aug" / "Alpha v. Beta"
        case_dir.mkdir(parents=True, exist_ok=True)

        body = b"%PDF-1.4 " + b"z" * 4096
        for i, part in enumerate((body[:2048], body[2048:])):
            r = client.post("/api/upload/chunk", data={
                "upload_id": "handoff12345", "index": str(i),
                "chunk": (io.BytesIO(part), "big.pdf"),
            }, content_type="multipart/form-data",
               headers={"X-CSRF-Token": "test-csrf-token"})
            assert r.status_code == 200, r.get_json()

        r = client.post("/manage-case/upload", data={
            "Year": "2026", "Month": "Aug", "Case Name": "Alpha v. Beta",
            "Domain": "Civil",
            "chunked": json.dumps([{"id": "handoff12345", "filename": "big.pdf"}]),
        }, content_type="multipart/form-data",
           headers={"X-CSRF-Token": "test-csrf-token"})

        assert r.status_code == 200, f"chunked upload failed: {r.status_code} {r.get_data(as_text=True)[:300]}"
        assert r.get_json()["ok"] is True, r.get_json()

        written = [p for p in case_dir.rglob("*") if p.is_file()]
        assert written, "the assembled file never reached the case folder"
        assert any(p.read_bytes() == body for p in written), "assembled contents do not match"

    def test_a_finished_chunk_spool_is_cleaned_up(self, client, test_user, app,
                                                  tmp_path, monkeypatch):
        """Spools are large; leaving them behind fills the upload disk."""
        import io, json
        import app as app_mod
        fsroot = tmp_path / "fs"
        monkeypatch.setattr(app_mod, "FS_ROOT", fsroot)
        self._login(client, test_user)

        case_dir = fsroot / "2026" / "Aug" / "Gamma v. Delta"
        case_dir.mkdir(parents=True, exist_ok=True)

        client.post("/api/upload/chunk", data={
            "upload_id": "cleanup12345", "index": "0",
            "chunk": (io.BytesIO(b"%PDF-1.4 cleanup"), "c.pdf"),
        }, content_type="multipart/form-data",
           headers={"X-CSRF-Token": "test-csrf-token"})
        assert app_mod._chunk_path("cleanup12345").exists()

        r = client.post("/manage-case/upload", data={
            "Year": "2026", "Month": "Aug", "Case Name": "Gamma v. Delta",
            "Domain": "Civil",
            "chunked": json.dumps([{"id": "cleanup12345", "filename": "c.pdf"}]),
        }, content_type="multipart/form-data",
           headers={"X-CSRF-Token": "test-csrf-token"})
        assert r.status_code == 200 and r.get_json().get("ok") is True, r.get_json()

        assert not app_mod._chunk_path("cleanup12345").exists(), "spool file was left behind"

    def test_a_rejected_upload_still_cleans_up_its_spool(self, client, test_user, app,
                                                         tmp_path, monkeypatch):
        """The failure paths leak too, and they are the ones that repeat.

        A user retrying a large upload that keeps being refused would otherwise
        strand a full-size spool on every attempt.
        """
        import io, json
        import app as app_mod
        fsroot = tmp_path / "fs"
        monkeypatch.setattr(app_mod, "FS_ROOT", fsroot)
        (fsroot / "2026" / "Aug" / "Eps v. Zeta").mkdir(parents=True, exist_ok=True)
        self._login(client, test_user)

        # Not a PDF by magic bytes, so the handler refuses to save it.
        client.post("/api/upload/chunk", data={
            "upload_id": "rejected1234", "index": "0",
            "chunk": (io.BytesIO(b"MZ this is an executable"), "x.pdf"),
        }, content_type="multipart/form-data",
           headers={"X-CSRF-Token": "test-csrf-token"})
        assert app_mod._chunk_path("rejected1234").exists()

        r = client.post("/manage-case/upload", data={
            "Year": "2026", "Month": "Aug", "Case Name": "Eps v. Zeta",
            "Domain": "Civil",
            "chunked": json.dumps([{"id": "rejected1234", "filename": "x.pdf"}]),
        }, content_type="multipart/form-data",
           headers={"X-CSRF-Token": "test-csrf-token"})
        assert r.get_json().get("ok") is not True, "a non-PDF should not have been saved"

        assert not app_mod._chunk_path("rejected1234").exists(), \
            "spool survived a rejected upload"
