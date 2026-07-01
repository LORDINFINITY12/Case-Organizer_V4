"""Tests for the upload-and-stamp Internship Certificate generator.

The certificate flow mirrors the Legal Notice generator: the user uploads an
A4 certificate PDF and the backend stamps a proforma header band (intern name +
duration on the left, certificate number + date on the right) onto page 1, then
merges the chosen letterhead behind every page.
"""

from __future__ import annotations

import io

import pytest

pytest.importorskip("reportlab")
pytest.importorskip("pypdf")
pytest.importorskip("PIL")

CSRF_HEADERS = {"X-CSRF-Token": "test-csrf-token"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_content_pdf(pages: int = 1) -> io.BytesIO:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for i in range(pages):
        c.drawString(72, 500, f"Certificate body page {i + 1}")
        c.showPage()
    c.save()
    buf.seek(0)
    return buf


def _make_letterhead_png(path):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, 1240, 200], fill=(20, 20, 20))        # header band
    draw.rectangle([0, 1554, 1240, 1754], fill=(20, 20, 20))    # footer band
    img.save(str(path))
    return path


def _page_count(pdf_bytes: bytes) -> int:
    from pypdf import PdfReader

    return len(PdfReader(io.BytesIO(pdf_bytes)).pages)


def _extract_text(pdf_bytes: bytes) -> str:
    from pypdf import PdfReader

    r = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join(pg.extract_text() or "" for pg in r.pages)


def _store_letterhead(db, fsroot, monkeypatch, disk_name="cert_lh.png"):
    import app as app_module

    (fsroot / "Letterheads").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
    _make_letterhead_png(fsroot / "Letterheads" / disk_name)
    db.execute(
        "INSERT INTO letterheads(label, filename, uploaded_by) VALUES(?, ?, ?)",
        ("Office", disk_name, None),
    )
    db.commit()
    return db.execute(
        "SELECT id FROM letterheads WHERE filename = ?", (disk_name,)
    ).fetchone()["id"]


# ---------------------------------------------------------------------------
# Unit: generate_certificate_pdf (stamping)
# ---------------------------------------------------------------------------
class TestGenerateCertificatePdf:
    def test_stamps_band_and_preserves_pages(self, app):
        from app import generate_certificate_pdf

        body = _make_content_pdf(2).getvalue()
        cert = {
            "certificate_number": "001/intern/2026",
            "certificate_date": "30-06-2026",
            "letterhead_id": None,
        }
        out = generate_certificate_pdf(body, cert)
        data = out.getvalue()
        assert data.startswith(b"%PDF")
        assert _page_count(data) == 2

        text = _extract_text(data)
        # The auto-stamped title lands on the page.
        assert "CERTIFICATE OF INTERNSHIP" in text
        # The single stamped line: date (left) + certificate number (right).
        assert "Date:" in text
        assert "Certificate No:" in text
        assert "001/intern/2026" in text
        assert "30-06-2026" in text
        # The uploaded body survives the merge.
        assert "Certificate body page 1" in text

    def test_does_not_stamp_name_or_duration(self, app):
        """Name / duration must NOT be stamped — they live in the upload."""
        from app import generate_certificate_pdf

        body = _make_content_pdf(1).getvalue()
        out = generate_certificate_pdf(body, {
            "certificate_number": "003/intern/2026",
            "certificate_date": "30-06-2026",
            # These keys are ignored by the stamper now:
            "intern_name": "Jane Doe", "start_date": "01-01-2026",
            "end_date": "30-06-2026", "letterhead_id": None,
        })
        text = _extract_text(out.getvalue())
        assert "Jane Doe" not in text
        assert "Duration" not in text

    def test_rejects_empty_pdf(self, app):
        from app import generate_certificate_pdf

        with pytest.raises(ValueError):
            generate_certificate_pdf(b"not a pdf", {"intern_name": "X"})

    def test_merges_letterhead_behind_pages(self, app, db, tmp_path, monkeypatch):
        from app import generate_certificate_pdf

        lid = _store_letterhead(db, tmp_path / "fs", monkeypatch)
        body = _make_content_pdf(1).getvalue()
        out = generate_certificate_pdf(
            body, {"intern_name": "A", "certificate_number": "002/intern/2026",
                   "certificate_date": "01-02-2026", "letterhead_id": str(lid)}
        )
        data = out.getvalue()
        assert data.startswith(b"%PDF")
        assert _page_count(data) == 1


# ---------------------------------------------------------------------------
# Unit: _certificate_margin_guidance (+2cm)
# ---------------------------------------------------------------------------
class TestMarginGuidance:
    def test_none_when_not_measurable(self, app):
        from app import _certificate_margin_guidance

        assert _certificate_margin_guidance(None) is None

    def test_no_extra_padding_first_page_reserves_title_and_band(self, app, monkeypatch):
        import app as app_module

        # Measured letterhead: 30 mm header clearance, 25 mm footer clearance.
        monkeypatch.setattr(
            app_module, "_measure_letterhead_margins",
            lambda _id: {"top_margin_mm": 30.0, "bottom_margin_mm": 25.0,
                         "header_mm": 28.0, "footer_mm": 23.0},
        )
        m = app_module._certificate_margin_guidance(7)
        # Every-page margins are exactly the measured clearances (no +2 cm).
        assert m["top_cm"] == 3.0
        assert m["bottom_cm"] == 2.5
        # First page = top + band_gap(6) + title(10) + line(8) = 54 mm = 5.4 cm.
        assert m["first_page_cm"] == 5.4


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
class TestCertificatePage:
    def test_requires_login(self, client, test_admin):
        resp = client.get("/certificate")
        assert resp.status_code == 302
        assert "/login" in resp.headers.get("Location", "")

    def test_renders_upload_form(self, auth_client):
        body = auth_client.get("/certificate").get_data(as_text=True)
        assert resp_ok(body)

    def test_no_contenteditable_editor(self, auth_client):
        """The broken in-browser editor must be gone."""
        body = auth_client.get("/certificate").get_data(as_text=True)
        assert 'id="cert-doc"' not in body
        assert 'contenteditable' not in body
        assert 'cert-toolbar' not in body

    def test_letterhead_picker_matches_notice(self, auth_client):
        """Letterhead preview must use the same markup + CSS as Legal Notice."""
        cert = auth_client.get("/certificate").get_data(as_text=True)
        notice = auth_client.get("/legal-notice").get_data(as_text=True)
        # Same picker container and the same shared stylesheets the notice uses.
        for needle in ('id="letterhead-thumbs"', "css/style.css", "legal_notice.css"):
            assert needle in cert, needle
            assert needle in notice, needle
        # The dead, conflicting certificate.css must not be linked any more.
        assert "css/certificate.css" not in cert


def resp_ok(body: str) -> bool:
    # Only certificate number + date + upload remain; name/duration are gone.
    return (
        'id="cert-number"' in body
        and 'id="cert-date"' in body
        and 'id="cert-drop"' in body
        and 'id="cert-download"' in body
        and 'id="cert-intern-name"' not in body
        and 'id="cert-start-date"' not in body
        and 'id="cert-end-date"' not in body
    )


class TestCertificateApis:
    def test_next_number(self, auth_client):
        resp = auth_client.get("/api/certificates/next-number", headers=CSRF_HEADERS)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert "/intern/" in data["certificate_number"]

    def test_margins_none(self, auth_client):
        resp = auth_client.get("/api/certificates/margins", headers=CSRF_HEADERS)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["margins"] is None


class TestCertificateSave:
    def _post(self, client, *, fsroot, monkeypatch, filename="cert.pdf",
              content=None, extra=None):
        import app as app_module

        # Ensure FS_ROOT is a writable temp dir for the save.
        monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
        fsroot.mkdir(parents=True, exist_ok=True)

        if content is None:
            content = _make_content_pdf(1).getvalue()
        data = {
            "certificate_date": "30-06-2026",
        }
        if extra:
            data.update(extra)
        data["file"] = (io.BytesIO(content), filename)
        return client.post(
            "/certificate/save",
            data=data,
            headers=CSRF_HEADERS,
            content_type="multipart/form-data",
        )

    def test_requires_file(self, auth_client, tmp_path, monkeypatch):
        import app as app_module
        monkeypatch.setattr(app_module, "FS_ROOT", tmp_path / "fs")
        (tmp_path / "fs").mkdir()
        resp = auth_client.post(
            "/certificate/save",
            data={"certificate_date": "30-06-2026"},
            headers=CSRF_HEADERS,
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400

    def test_rejects_non_pdf(self, auth_client, tmp_path, monkeypatch):
        resp = self._post(
            auth_client, fsroot=tmp_path / "fs", monkeypatch=monkeypatch,
            filename="cert.txt", content=b"hello",
        )
        assert resp.status_code == 400

    def test_full_save_returns_pdf_and_inserts_row(self, auth_client, db, tmp_path, monkeypatch):
        resp = self._post(auth_client, fsroot=tmp_path / "fs", monkeypatch=monkeypatch)
        assert resp.status_code == 200
        assert resp.mimetype == "application/pdf"
        number = resp.headers.get("X-Certificate-Number")
        assert number and "/intern/" in number

        row = db.execute(
            "SELECT intern_name, certificate_number FROM certificates WHERE certificate_number = ?",
            (number,),
        ).fetchone()
        assert row is not None
        # Name is no longer collected — stored blank, filename is just the number.
        assert row["intern_name"] == ""

    def test_duplicate_number_conflicts(self, auth_client, db, tmp_path, monkeypatch):
        first = self._post(
            auth_client, fsroot=tmp_path / "fs", monkeypatch=monkeypatch,
            extra={"certificate_number": "099/intern/2026"},
        )
        assert first.status_code == 200
        again = self._post(
            auth_client, fsroot=tmp_path / "fs", monkeypatch=monkeypatch,
            extra={"certificate_number": "099/intern/2026"},
        )
        assert again.status_code == 409
