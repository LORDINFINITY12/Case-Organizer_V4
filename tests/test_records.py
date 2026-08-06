"""Tests for the legal notice recipient block and the Records admin tab
(deletion of legal notice / certificate registry entries)."""

import pytest

CSRF = {"X-CSRF-Token": "test-csrf-token"}


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


# ---------------------------------------------------------------------------
# Unit tests: _legal_notice_recipient_lines (trailing comma fix)
# ---------------------------------------------------------------------------
class TestRecipientLines:
    def test_no_contact_last_address_line_has_no_comma(self, app):
        from app import _legal_notice_recipient_lines

        lines = _legal_notice_recipient_lines({
            "recipient_name": "Rahul Sharma",
            "relation_type": "S/o",
            "relation_value": "Mohan Sharma",
            "address_line1": "12 MG Road",
            "address_line2": "New Delhi 110001",
            "contact": "",
        })
        assert lines == [
            "To,",
            "<b>Rahul Sharma</b>,",
            "S/o Mohan Sharma,",
            "12 MG Road,",
            "New Delhi 110001",
        ]

    def test_with_contact_address_keeps_comma_contact_bare(self, app):
        from app import _legal_notice_recipient_lines

        lines = _legal_notice_recipient_lines({
            "recipient_name": "Rahul Sharma",
            "address_line1": "12 MG Road",
            "contact": "9999999999",
        })
        assert lines == [
            "To,",
            "<b>Rahul Sharma</b>,",
            "12 MG Road,",
            "9999999999",
        ]

    def test_name_only_has_no_trailing_comma(self, app):
        from app import _legal_notice_recipient_lines

        assert _legal_notice_recipient_lines({"recipient_name": "X"}) == ["To,", "<b>X</b>"]

    def test_all_empty_yields_only_salutation(self, app):
        from app import _legal_notice_recipient_lines

        assert _legal_notice_recipient_lines({}) == ["To,"]


# ---------------------------------------------------------------------------
# Records tab delete endpoints
# ---------------------------------------------------------------------------
@pytest.fixture
def fsroot(tmp_path, monkeypatch):
    """A real FS_ROOT dir wired into the already-imported app module."""
    import app as app_module

    root = tmp_path / "records_fs_root"
    root.mkdir()
    monkeypatch.setattr(app_module, "FS_ROOT", root)
    return root


def _seed_notice(db, fsroot, number="1/LN/26", with_file=True):
    pdf = fsroot / "Legal_Notices" / f"notice_{number.replace('/', '-')}.pdf"
    if with_file:
        pdf.parent.mkdir(parents=True, exist_ok=True)
        pdf.write_bytes(b"%PDF-1.4 test")
    db.execute(
        "INSERT INTO legal_notices(notice_number, recipient_name, file_path, payload_json, generated_by)"
        " VALUES(?, ?, ?, '{}', NULL)",
        (number, "Rahul Sharma", str(pdf)),
    )
    db.commit()
    nid = db.execute(
        "SELECT id FROM legal_notices WHERE notice_number = ?", (number,)
    ).fetchone()["id"]
    return nid, pdf


def _seed_certificate(db, fsroot, number="1/C/26", with_file=True):
    pdf = fsroot / "Certificates" / f"cert_{number.replace('/', '-')}.pdf"
    if with_file:
        pdf.parent.mkdir(parents=True, exist_ok=True)
        pdf.write_bytes(b"%PDF-1.4 test")
    db.execute(
        "INSERT INTO certificates(certificate_number, intern_name, file_path, payload_json, generated_by)"
        " VALUES(?, ?, ?, '{}', NULL)",
        (number, "Asha Intern", str(pdf)),
    )
    db.commit()
    cid = db.execute(
        "SELECT id FROM certificates WHERE certificate_number = ?", (number,)
    ).fetchone()["id"]
    return cid, pdf


class TestDeleteLegalNotice:
    def test_admin_delete_removes_row_and_file(self, client, test_admin, db, fsroot):
        nid, pdf = _seed_notice(db, fsroot)
        _login_as(client, test_admin)
        resp = client.delete(f"/api/legal-notices/{nid}", headers=CSRF)
        assert resp.status_code == 200 and resp.get_json()["ok"] is True
        assert db.execute("SELECT 1 FROM legal_notices WHERE id = ?", (nid,)).fetchone() is None
        assert not pdf.exists()

    def test_missing_file_still_deletes_row(self, client, test_admin, db, fsroot):
        nid, pdf = _seed_notice(db, fsroot, number="2/LN/26", with_file=False)
        _login_as(client, test_admin)
        resp = client.delete(f"/api/legal-notices/{nid}", headers=CSRF)
        assert resp.status_code == 200
        assert db.execute("SELECT 1 FROM legal_notices WHERE id = ?", (nid,)).fetchone() is None

    def test_non_admin_forbidden(self, client, test_user, db, fsroot):
        nid, pdf = _seed_notice(db, fsroot, number="3/LN/26")
        _login_as(client, test_user)
        resp = client.delete(f"/api/legal-notices/{nid}", headers=CSRF)
        assert resp.status_code == 403
        assert db.execute("SELECT 1 FROM legal_notices WHERE id = ?", (nid,)).fetchone() is not None
        assert pdf.exists()

    def test_unknown_id_404(self, client, test_admin, fsroot):
        _login_as(client, test_admin)
        assert client.delete("/api/legal-notices/99999", headers=CSRF).status_code == 404


class TestDeleteCertificate:
    def test_admin_delete_removes_row_and_file(self, client, test_admin, db, fsroot):
        cid, pdf = _seed_certificate(db, fsroot)
        _login_as(client, test_admin)
        resp = client.delete(f"/api/certificates/{cid}", headers=CSRF)
        assert resp.status_code == 200 and resp.get_json()["ok"] is True
        assert db.execute("SELECT 1 FROM certificates WHERE id = ?", (cid,)).fetchone() is None
        assert not pdf.exists()

    def test_non_admin_forbidden(self, client, test_user, db, fsroot):
        cid, pdf = _seed_certificate(db, fsroot, number="2/C/26")
        _login_as(client, test_user)
        assert client.delete(f"/api/certificates/{cid}", headers=CSRF).status_code == 403
        assert pdf.exists()

    def test_unknown_id_404(self, client, test_admin, fsroot):
        _login_as(client, test_admin)
        assert client.delete("/api/certificates/99999", headers=CSRF).status_code == 404


class TestDownloadRecords:
    """Manage Records offers download alongside delete."""

    def test_admin_downloads_certificate(self, client, test_admin, db, fsroot):
        cid, pdf = _seed_certificate(db, fsroot, number="10/C/26")
        _login_as(client, test_admin)
        resp = client.get(f"/api/certificates/{cid}/download")
        assert resp.status_code == 200
        assert resp.data == pdf.read_bytes()
        assert "attachment" in resp.headers.get("Content-Disposition", "")
        # the row and the file both survive a download
        assert db.execute("SELECT 1 FROM certificates WHERE id = ?", (cid,)).fetchone()
        assert pdf.exists()

    def test_admin_downloads_legal_notice(self, client, test_admin, db, fsroot):
        nid, pdf = _seed_notice(db, fsroot, number="10/LN/26")
        _login_as(client, test_admin)
        resp = client.get(f"/api/legal-notices/{nid}/download")
        assert resp.status_code == 200
        assert resp.data == pdf.read_bytes()
        assert "attachment" in resp.headers.get("Content-Disposition", "")

    def test_missing_file_reports_404_not_500(self, client, test_admin, db, fsroot):
        cid, _ = _seed_certificate(db, fsroot, number="11/C/26", with_file=False)
        _login_as(client, test_admin)
        assert client.get(f"/api/certificates/{cid}/download").status_code == 404

    def test_unknown_id_404(self, client, test_admin, fsroot):
        _login_as(client, test_admin)
        assert client.get("/api/certificates/99999/download").status_code == 404
        assert client.get("/api/legal-notices/99999/download").status_code == 404

    def test_non_admin_cannot_download(self, client, test_user, db, fsroot):
        cid, _ = _seed_certificate(db, fsroot, number="12/C/26")
        nid, _ = _seed_notice(db, fsroot, number="12/LN/26")
        _login_as(client, test_user)
        assert client.get(f"/api/certificates/{cid}/download").status_code in (302, 403)
        assert client.get(f"/api/legal-notices/{nid}/download").status_code in (302, 403)

    def test_path_outside_storage_root_refused(self, client, test_admin, db, fsroot, tmp_path):
        """A row whose file_path escapes FS_ROOT must not be served."""
        outside = tmp_path / "outside.pdf"
        outside.write_bytes(b"%PDF-1.4 secret")
        db.execute(
            "INSERT INTO certificates(certificate_number, intern_name, file_path,"
            " payload_json, generated_by) VALUES(?, ?, ?, '{}', NULL)",
            ("13/C/26", "Asha Intern", str(outside)),
        )
        db.commit()
        cid = db.execute(
            "SELECT id FROM certificates WHERE certificate_number = ?", ("13/C/26",)
        ).fetchone()["id"]
        _login_as(client, test_admin)
        assert client.get(f"/api/certificates/{cid}/download").status_code == 404
