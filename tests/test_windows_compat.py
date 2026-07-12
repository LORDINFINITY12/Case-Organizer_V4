"""Windows-portability shims: filename validation, gs lookup, setup prefill.

The validation rules apply identically on Linux and Windows so a case store
created on one OS stays readable on the other.
"""

from __future__ import annotations

import shutil

import pytest

CSRF = {"X-CSRF-Token": "test-csrf-token"}


@pytest.fixture
def fsroot(tmp_path, monkeypatch):
    import app as app_module

    root = tmp_path / "win_fs_root"
    root.mkdir()
    monkeypatch.setattr(app_module, "FS_ROOT", root)
    return root


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


# ---------------------------------------------------------------------------
# validate_fs_component
# ---------------------------------------------------------------------------
class TestValidateFsComponent:

    @pytest.mark.parametrize("name", [
        "CON", "con", "Con.txt", "PRN", "NUL", "nul.pdf",
        "COM1", "com9", "lpt9.pdf", "LPT1.tar.gz",
        "name.", "name ", "trailing.dot.", "trailing space ",
        "a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b",
        ".", "..", "", "   ",
    ])
    def test_rejects(self, app, name):
        from app import validate_fs_component
        assert validate_fs_component(name) is not None

    @pytest.mark.parametrize("name", [
        "Foo v. Bar",
        "Sharma v. State (2)",
        "M.S. Dhoni v. X",           # dots inside are fine
        "CONTRACT v. Party",          # only exact reserved base-names blocked
        "Company Ltd.  v. Union",     # internal spacing fine
        "consumer v. seller",         # 'con' prefix but not reserved
        "Note.json",
    ])
    def test_accepts(self, app, name):
        from app import validate_fs_component
        assert validate_fs_component(name) is None


class TestSanitizeCaseLawComponent:

    def test_strips_trailing_dots_and_spaces(self, app):
        from app import sanitize_case_law_component
        assert sanitize_case_law_component("State of A.P.") == "State of A.P"
        assert sanitize_case_law_component("Name ") == "Name"

    def test_reserved_name_disarmed(self, app):
        from app import sanitize_case_law_component
        out = sanitize_case_law_component("CON")
        assert out.split(".", 1)[0].upper() not in {"CON"}

    def test_illegal_chars_still_removed(self, app):
        from app import sanitize_case_law_component
        assert ":" not in sanitize_case_law_component("Order 21: Execution")


# ---------------------------------------------------------------------------
# API-level enforcement
# ---------------------------------------------------------------------------
class TestCreateCaseValidation:

    def _create(self, client, petitioner, respondent):
        return client.post("/create-case", data={
            "Petitioner Name": petitioner,
            "Respondent Name": respondent,
            "_csrf_token": "test-csrf-token",
        }, headers=CSRF)

    def test_illegal_char_case_name_rejected(self, auth_client, fsroot):
        # ":" in a party name would produce a folder Windows cannot create
        resp = self._create(auth_client, "State: Special Cell", "Accused")
        assert resp.status_code == 400
        assert "not allowed" in resp.get_json()["msg"]

    def test_trailing_dot_rejected(self, auth_client, fsroot):
        resp = self._create(auth_client, "Sharma", "Union of India Ltd.")
        # case name becomes "Sharma v. Union of India Ltd." -> trailing dot
        assert resp.status_code == 400

    def test_normal_names_still_work(self, auth_client, fsroot):
        resp = self._create(auth_client, "Sharma", "State")
        assert resp.status_code == 200, resp.get_json()
        assert resp.get_json()["ok"] is True


class TestRenameValidation:

    def test_rename_to_reserved_rejected(self, admin_client, fsroot):
        r = admin_client.post("/create-case", data={
            "Petitioner Name": "Rename", "Respondent Name": "Target",
            "_csrf_token": "test-csrf-token",
        }, headers=CSRF)
        assert r.status_code == 200
        path = r.get_json()["path"]
        for bad in ("COM1", "case.", "a|b"):
            resp = admin_client.post("/api/rename-case",
                                     json={"path": path, "new_name": bad},
                                     headers=CSRF)
            assert resp.status_code == 400, bad


# ---------------------------------------------------------------------------
# Ghostscript binary shim
# ---------------------------------------------------------------------------
class TestGsBinary:

    def test_prefers_gs(self, monkeypatch):
        from services import pdf_tools
        monkeypatch.setattr(shutil, "which",
                            lambda name: f"/usr/bin/{name}" if name == "gs" else None)
        assert pdf_tools._gs_binary() == "/usr/bin/gs"

    def test_falls_back_to_gswin64c(self, monkeypatch):
        from services import pdf_tools
        monkeypatch.setattr(shutil, "which",
                            lambda name: r"C:\gs\gswin64c.exe" if name == "gswin64c" else None)
        assert pdf_tools._gs_binary() == r"C:\gs\gswin64c.exe"

    def test_none_when_missing(self, monkeypatch, tmp_path):
        from services import pdf_tools
        monkeypatch.setattr(shutil, "which", lambda name: None)
        assert pdf_tools._gs_binary() is None
        with pytest.raises(RuntimeError, match="Ghostscript"):
            pdf_tools._compress_photon(
                input_pdf=tmp_path / "in.pdf",
                output_pdf=tmp_path / "out.pdf",
                level="medium",
            )


# ---------------------------------------------------------------------------
# Setup storage-folder prefill
# ---------------------------------------------------------------------------
class TestSetupPrefill:

    def test_posix_stays_empty(self, app, monkeypatch):
        import app as app_mod
        monkeypatch.setattr(app_mod.os, "name", "posix")
        assert app_mod._default_fs_root_hint() == ""

    def test_windows_documents_default(self, app, monkeypatch):
        import app as app_mod
        monkeypatch.setattr(app_mod.os, "name", "nt")
        monkeypatch.delenv("CASEORG_HEADLESS", raising=False)
        hint = app_mod._default_fs_root_hint()
        # separator-agnostic: os.path joins with "/" when run on Linux
        assert "Documents" in hint and "Case Organizer Files" in hint

    def test_windows_service_programdata_default(self, app, monkeypatch):
        import app as app_mod
        monkeypatch.setattr(app_mod.os, "name", "nt")
        monkeypatch.setenv("CASEORG_HEADLESS", "1")
        monkeypatch.setenv("PROGRAMDATA", r"C:\ProgramData")
        hint = app_mod._default_fs_root_hint()
        assert hint.startswith("C:") and "Case Files" in hint
