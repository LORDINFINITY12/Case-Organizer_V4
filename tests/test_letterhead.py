"""Tests for the dedicated letterhead-stamping page.

Covers two layers:

* ``_apply_letterhead_to_pdf`` — the pure PDF-merging helper that stamps a
  letterhead behind every page (image and PDF letterheads, the "None"
  passthrough, and graceful fallback on a corrupt letterhead).
* The ``/letterhead`` (GET) and ``/letterhead/stamp`` (POST) routes —
  rendering, auth, CSRF, upload validation, filename sanitisation, and the
  full stamp-with-a-stored-letterhead path.
"""

from __future__ import annotations

import io

import pytest

# These ship as hard dependencies of the app; skip cleanly if a stripped
# environment is missing them rather than erroring the whole suite.
pytest.importorskip("reportlab")
pytest.importorskip("pypdf")
pytest.importorskip("PIL")

CSRF_HEADERS = {"X-CSRF-Token": "test-csrf-token"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_content_pdf(pages: int = 2) -> io.BytesIO:
    """Return an A4 PDF (BytesIO) with ``pages`` simple text pages."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for i in range(pages):
        c.drawString(72, 720, f"Body page {i + 1}")
        c.showPage()
    c.save()
    buf.seek(0)
    return buf


def _make_letterhead_png(path):
    """Write a full-page white PNG with dark header/footer bands."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, 1240, 200], fill=(20, 20, 20))        # header band
    draw.rectangle([0, 1554, 1240, 1754], fill=(20, 20, 20))    # footer band
    img.save(str(path))
    return path


def _make_letterhead_pdf(path):
    """Write a single-page A4 PDF to act as a PDF letterhead."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4

    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(72, 800, "LETTERHEAD")
    c.showPage()
    c.save()
    return path


def _make_blank_png(path):
    """Write a fully blank (white) full-page PNG — no header/footer artwork."""
    from PIL import Image

    Image.new("RGB", (1240, 1754), "white").save(str(path))
    return path


def _page_count(pdf_bytes: bytes) -> int:
    from pypdf import PdfReader

    return len(PdfReader(io.BytesIO(pdf_bytes)).pages)


def _store_letterhead(db, fsroot, monkeypatch, png_maker,
                      disk_name="stored_lh.png", label="Office"):
    """Create a letterhead on disk + a matching DB row; return its id.

    Repoints ``app.FS_ROOT`` at ``fsroot`` so the letterhead helpers resolve
    the file we just wrote (conftest only patches ``caseorg_config.FS_ROOT``,
    which app.py has already resolved into its own module global).
    """
    import app as app_module

    (fsroot / "Letterheads").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(app_module, "FS_ROOT", fsroot)
    png_maker(fsroot / "Letterheads" / disk_name)
    db.execute(
        "INSERT INTO letterheads(label, filename, uploaded_by) VALUES(?, ?, ?)",
        (label, disk_name, None),
    )
    db.commit()
    return db.execute(
        "SELECT id FROM letterheads WHERE filename = ?", (disk_name,)
    ).fetchone()["id"]


# ---------------------------------------------------------------------------
# Unit tests: _apply_letterhead_to_pdf
# ---------------------------------------------------------------------------
class TestApplyLetterheadToPdf:
    def test_none_letterhead_returns_unchanged(self, app):
        from app import _apply_letterhead_to_pdf

        content = _make_content_pdf(2)
        original = content.getvalue()
        content.seek(0)

        out = _apply_letterhead_to_pdf(content, None)
        assert out.getvalue() == original

    def test_image_letterhead_preserves_page_count(self, app, tmp_path):
        from app import _apply_letterhead_to_pdf

        png = _make_letterhead_png(tmp_path / "lh.png")
        content = _make_content_pdf(3)

        out = _apply_letterhead_to_pdf(content, png)
        data = out.getvalue()
        assert data.startswith(b"%PDF")
        assert _page_count(data) == 3

    def test_pdf_letterhead_preserves_page_count(self, app, tmp_path):
        from app import _apply_letterhead_to_pdf

        lh = _make_letterhead_pdf(tmp_path / "lh.pdf")
        content = _make_content_pdf(2)

        out = _apply_letterhead_to_pdf(content, lh)
        data = out.getvalue()
        assert data.startswith(b"%PDF")
        assert _page_count(data) == 2

    def test_corrupt_letterhead_falls_back_unchanged(self, app, tmp_path):
        from app import _apply_letterhead_to_pdf

        bogus = tmp_path / "broken.png"
        bogus.write_bytes(b"this is not a real image")
        content = _make_content_pdf(2)
        original = content.getvalue()
        content.seek(0)

        # Must not raise; returns the original document untouched.
        out = _apply_letterhead_to_pdf(content, bogus)
        assert out.getvalue() == original


# ---------------------------------------------------------------------------
# Route tests: GET /letterhead
# ---------------------------------------------------------------------------
class TestLetterheadPage:
    def test_requires_login(self, client, test_admin):
        # An admin exists (setup guard satisfied), but this client carries no
        # session — so @require_login should bounce it to the login page.
        resp = client.get("/letterhead")
        assert resp.status_code == 302
        assert "/login" in resp.headers.get("Location", "")

    def test_renders_for_logged_in_user(self, auth_client):
        resp = auth_client.get("/letterhead")
        assert resp.status_code == 200
        body = resp.get_data(as_text=True)
        # Core controls are present.
        assert 'id="lh-drop"' in body
        assert 'id="letterhead-thumbs"' in body
        assert 'id="lh-download"' in body

    def test_omits_notice_specific_controls(self, auth_client):
        """The page must NOT carry recipient/notice/add-to-case UI."""
        body = auth_client.get("/letterhead").get_data(as_text=True)
        assert "ln-recipient-name" not in body
        assert "Add to Case" not in body
        assert "Notice number" not in body


# ---------------------------------------------------------------------------
# Route tests: POST /letterhead/stamp
# ---------------------------------------------------------------------------
class TestLetterheadStamp:
    def _post(self, client, *, filename="letter.pdf", content=None, extra=None,
              headers=None):
        if content is None:
            content = _make_content_pdf(2).getvalue()
        data = {"file": (io.BytesIO(content), filename)}
        if extra:
            data.update(extra)
        return client.post(
            "/letterhead/stamp",
            data=data,
            content_type="multipart/form-data",
            headers=CSRF_HEADERS if headers is None else headers,
        )

    def test_requires_csrf(self, auth_client):
        resp = self._post(auth_client, headers={})
        assert resp.status_code == 302  # CSRF redirect

    def test_stamp_without_letterhead_returns_pdf(self, auth_client):
        resp = self._post(auth_client)
        assert resp.status_code == 200, resp.get_data(as_text=True)
        assert resp.mimetype == "application/pdf"
        data = resp.get_data()
        assert data.startswith(b"%PDF")
        assert _page_count(data) == 2

    def test_rejects_non_pdf_extension(self, auth_client):
        resp = self._post(auth_client, filename="note.txt",
                          content=b"plain text not a pdf")
        assert resp.status_code == 400

    def test_rejects_fake_pdf_content(self, auth_client):
        resp = self._post(auth_client, filename="fake.pdf",
                          content=b"definitely not a pdf body")
        assert resp.status_code == 400

    def test_rejects_missing_file(self, auth_client):
        resp = auth_client.post(
            "/letterhead/stamp",
            data={},
            content_type="multipart/form-data",
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 400

    def test_download_filename_is_sanitised(self, auth_client):
        resp = self._post(auth_client, filename="My Report (Final).pdf")
        assert resp.status_code == 200
        disposition = resp.headers.get("Content-Disposition", "")
        assert "_letterhead.pdf" in disposition
        # No path separators leak into the suggested filename.
        assert "/" not in disposition.split("filename=", 1)[-1]
        assert "\\" not in disposition

    def test_stamp_with_stored_letterhead(self, auth_client, db, tmp_path,
                                          monkeypatch):
        """Full HTTP path: a stored letterhead is resolved and merged in."""
        lid = _store_letterhead(db, tmp_path / "fs", monkeypatch,
                                _make_letterhead_png)

        resp = self._post(auth_client, extra={"letterhead_id": str(lid)})
        assert resp.status_code == 200, resp.get_data(as_text=True)
        data = resp.get_data()
        assert data.startswith(b"%PDF")
        assert _page_count(data) == 2


# ---------------------------------------------------------------------------
# Margin auto-detection — guards against shipping wrong margins (the bug that
# previously caused page-2 letterhead overlap).
# ---------------------------------------------------------------------------
class TestMarginMeasurement:
    def test_none_id_is_not_measurable(self, app):
        from app import _measure_letterhead_margins, _letterhead_margin_guidance

        assert _measure_letterhead_margins(None) is None
        assert _letterhead_margin_guidance(None) is None

    def test_measures_header_and_footer_bands(self, app, db, tmp_path,
                                              monkeypatch):
        from app import _measure_letterhead_margins

        lid = _store_letterhead(db, tmp_path / "fs", monkeypatch,
                                _make_letterhead_png)
        m = _measure_letterhead_margins(lid)
        assert m is not None
        # Bands are ~11% of page height each → ~33-34 mm of a 297 mm sheet.
        assert 25.0 < m["header_mm"] < 45.0
        assert 25.0 < m["footer_mm"] < 45.0
        # The recommended margin is the measured band plus the safety pad.
        assert m["top_margin_mm"] == pytest.approx(m["header_mm"] + 2.0, abs=0.05)
        assert m["bottom_margin_mm"] == pytest.approx(m["footer_mm"] + 2.0, abs=0.05)

    def test_guidance_is_derived_from_measurement(self, app, db, tmp_path,
                                                  monkeypatch):
        import math
        from app import (_measure_letterhead_margins, _letterhead_margin_guidance,
                         _LN_BAND_GAP_MM, _LN_BAND_HEIGHT_MM)

        lid = _store_letterhead(db, tmp_path / "fs", monkeypatch,
                                _make_letterhead_png)
        m = _measure_letterhead_margins(lid)
        g = _letterhead_margin_guidance(lid)
        assert g is not None

        # cm values are the mm measurements rounded *up* to 0.1 cm — never under.
        assert g["top_cm"] == math.ceil(m["top_margin_mm"]) / 10.0
        assert g["bottom_cm"] == math.ceil(m["bottom_margin_mm"]) / 10.0
        extra = _LN_BAND_GAP_MM + _LN_BAND_HEIGHT_MM
        assert g["first_page_cm"] == math.ceil(m["top_margin_mm"] + extra) / 10.0
        # First page must always reserve more room than an ordinary page.
        assert g["first_page_cm"] > g["top_cm"]

    def test_blank_letterhead_is_not_measurable(self, app, db, tmp_path,
                                                monkeypatch):
        from app import _measure_letterhead_margins, _letterhead_margin_guidance

        lid = _store_letterhead(db, tmp_path / "fs", monkeypatch,
                                _make_blank_png, disk_name="blank.png")
        assert _measure_letterhead_margins(lid) is None
        assert _letterhead_margin_guidance(lid) is None


# ---------------------------------------------------------------------------
# Route test: GET /api/letterheads exposes the per-letterhead margins.
# ---------------------------------------------------------------------------
class TestLetterheadsApi:
    def test_listing_includes_margins(self, auth_client, db, tmp_path,
                                      monkeypatch):
        lid = _store_letterhead(db, tmp_path / "fs", monkeypatch,
                                _make_letterhead_png, label="Head Office")

        resp = auth_client.get("/api/letterheads")
        assert resp.status_code == 200
        payload = resp.get_json()
        assert payload["ok"] is True

        item = next((x for x in payload["letterheads"] if x["id"] == lid), None)
        assert item is not None
        assert item["label"] == "Head Office"
        margins = item["margins"]
        assert margins is not None
        for key in ("top_cm", "bottom_cm", "first_page_cm"):
            assert isinstance(margins[key], (int, float))
            assert margins[key] > 0
        assert margins["first_page_cm"] > margins["top_cm"]

    def test_listing_requires_login(self, client, test_admin):
        resp = client.get("/api/letterheads")
        assert resp.status_code == 401
