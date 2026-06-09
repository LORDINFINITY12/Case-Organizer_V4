"""Tests for security response headers."""

from __future__ import annotations


class TestSecurityHeaders:

    def test_x_content_type_options(self, client):
        resp = client.get("/login")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"

    def test_x_frame_options(self, client):
        resp = client.get("/login")
        assert resp.headers.get("X-Frame-Options") == "SAMEORIGIN"

    def test_x_xss_protection_disabled(self, client):
        # The legacy XSS auditor is deprecated; it must be explicitly off.
        resp = client.get("/login")
        assert resp.headers.get("X-XSS-Protection") == "0"

    def test_referrer_policy(self, client):
        resp = client.get("/login")
        assert resp.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"

    def test_csp_present(self, client):
        resp = client.get("/login")
        csp = resp.headers.get("Content-Security-Policy")
        assert csp is not None
        assert "default-src 'self'" in csp
        # Nonce-based script policy: no unsafe-inline / unsafe-eval.
        assert "script-src 'self' 'nonce-" in csp
        assert "'wasm-unsafe-eval'" in csp
        assert "'unsafe-eval'" not in csp
        assert "fonts.googleapis.com" in csp
        assert "worker-src 'self' blob:" in csp
        assert "object-src 'self'" in csp

    def test_csp_nonce_matches_inline_scripts(self, client):
        resp = client.get("/login")
        csp = resp.headers.get("Content-Security-Policy", "")
        nonce = csp.split("'nonce-", 1)[1].split("'", 1)[0]
        assert nonce
        assert f'nonce="{nonce}"' in resp.get_data(as_text=True)

    def test_csp_nonce_unique_per_request(self, client):
        csp1 = client.get("/login").headers.get("Content-Security-Policy", "")
        csp2 = client.get("/login").headers.get("Content-Security-Policy", "")
        nonce1 = csp1.split("'nonce-", 1)[1].split("'", 1)[0]
        nonce2 = csp2.split("'nonce-", 1)[1].split("'", 1)[0]
        assert nonce1 != nonce2

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
            # Secure by default outside FLASK_DEBUG (CASEORG_COOKIE_SECURE
            # is unset in the test environment)
            assert "Secure" in cookie_header

    def test_hsts_present_in_production_mode(self, client):
        # FLASK_DEBUG is unset in tests, so the production header must be set.
        resp = client.get("/login")
        assert resp.headers.get("Strict-Transport-Security") == "max-age=31536000; includeSubDomains"

    def test_bento_csp_profile(self, client):
        # The bento CSP is applied by path, even on redirects.
        resp = client.get("/bento", follow_redirects=False)
        csp = resp.headers.get("Content-Security-Policy", "")
        assert "default-src 'self';" in csp           # narrowed: no CDN fallback
        assert "https://cdn.jsdelivr.net" in csp      # CDN allowed by default (CASEORG_BENTO_CDN unset)
        assert "'nonce-" not in csp                   # bento keeps unsafe-inline, no nonce

    def test_default_csp_not_applied_to_bento(self, client):
        bento_csp = client.get("/bento", follow_redirects=False).headers.get("Content-Security-Policy", "")
        app_csp = client.get("/login").headers.get("Content-Security-Policy", "")
        assert bento_csp != app_csp
        assert "cdn.jsdelivr.net" not in app_csp
