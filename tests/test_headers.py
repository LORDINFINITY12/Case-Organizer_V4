"""Tests for security response headers."""

from __future__ import annotations


class TestSecurityHeaders:

    def test_x_content_type_options(self, client):
        resp = client.get("/login")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"

    def test_x_frame_options(self, client):
        resp = client.get("/login")
        assert resp.headers.get("X-Frame-Options") == "SAMEORIGIN"

    def test_x_xss_protection(self, client):
        resp = client.get("/login")
        assert resp.headers.get("X-XSS-Protection") == "1; mode=block"

    def test_referrer_policy(self, client):
        resp = client.get("/login")
        assert resp.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"

    def test_csp_present(self, client):
        resp = client.get("/login")
        csp = resp.headers.get("Content-Security-Policy")
        assert csp is not None
        assert "default-src 'self'" in csp
        assert "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'" in csp
        assert "fonts.googleapis.com" in csp
        assert "worker-src 'self' blob:" in csp
        assert "object-src 'self'" in csp

    def test_headers_on_404(self, client):
        resp = client.get("/nonexistent-page-xyz-12345")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"
        assert resp.headers.get("X-Frame-Options") == "SAMEORIGIN"

    def test_headers_on_api(self, auth_client, csrf_token):
        resp = auth_client.post(
            "/api/session/keepalive",
            headers={"X-CSRF-Token": csrf_token},
        )
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"

    def test_session_cookie_flags(self, client):
        resp = client.get("/login")
        cookie_header = resp.headers.get("Set-Cookie", "")
        if cookie_header:
            assert "HttpOnly" in cookie_header
            assert "SameSite=Lax" in cookie_header
