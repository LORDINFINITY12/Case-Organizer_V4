"""Tests for password hashing, CSRF validation, and rate limiting."""

from __future__ import annotations

import pytest


class TestPasswordHashing:

    def test_hash_returns_argon2_string(self):
        from services.security import hash_password
        h = hash_password("test123")
        assert isinstance(h, str)
        assert h.startswith("$argon2")

    def test_verify_correct_password(self):
        from services.security import hash_password, verify_password
        h = hash_password("mypassword")
        assert verify_password("mypassword", h) is True

    def test_verify_wrong_password(self):
        from services.security import hash_password, verify_password
        h = hash_password("mypassword")
        assert verify_password("wrongpassword", h) is False

    def test_verify_empty_password(self):
        from services.security import verify_password
        assert verify_password("", "somehash") is False

    def test_verify_empty_hash(self):
        from services.security import verify_password
        assert verify_password("password", "") is False

    def test_hash_empty_raises(self):
        from services.security import hash_password
        with pytest.raises(ValueError):
            hash_password("")


class TestCSRF:

    def test_post_without_csrf_rejected(self, client, test_user):
        with client.session_transaction() as sess:
            from services.users import create_session
            token = create_session(test_user.id)
            sess["session_token"] = token
            sess["user_id"] = test_user.id
            sess["user_role"] = test_user.role
            sess["user_email"] = test_user.email
            sess["_csrf_token"] = "expected-token"

        resp = client.post("/account", data={"form_name": "update_email"})
        assert resp.status_code in (302, 403)

    def test_post_with_valid_csrf_passes(self, auth_client, csrf_token):
        resp = auth_client.post(
            "/account",
            data={
                "form_name": "update_email",
                "_csrf_token": csrf_token,
                "new_email": "new@example.com",
                "current_password": "TestPass123!",
            },
        )
        # Should not be a CSRF rejection
        assert resp.status_code != 403


class TestRateLimiting:

    def test_rate_limit_blocks_after_threshold(self, db):
        from services.rate_limit import is_rate_limited
        for _ in range(5):
            assert is_rate_limited(db, "test_action", max_attempts=5, key="testip") is False
        assert is_rate_limited(db, "test_action", max_attempts=5, key="testip") is True

    def test_rate_limit_clears_on_success(self, db):
        from services.rate_limit import is_rate_limited, record_success
        for _ in range(5):
            is_rate_limited(db, "clear_action", max_attempts=5, key="testip")
        assert is_rate_limited(db, "clear_action", max_attempts=5, key="testip") is True
        record_success(db, "clear_action", key="testip")
        assert is_rate_limited(db, "clear_action", max_attempts=5, key="testip") is False


class TestSessionTokenHashing:

    def test_plaintext_token_not_stored(self, db, test_user):
        from services.users import create_session, _hash_token

        token = create_session(test_user.id)
        row = db.execute(
            "SELECT session_token_hash FROM user_sessions WHERE user_id = ?",
            (test_user.id,),
        ).fetchone()
        assert row is not None
        assert row["session_token_hash"] != token
        assert row["session_token_hash"] == _hash_token(token)

    def test_validate_session_with_plaintext_token(self, db, test_user):
        from services.users import create_session, validate_session

        token = create_session(test_user.id)
        assert validate_session(token) == test_user.id
        assert validate_session("not-a-real-token") is None


class TestFTSQuerySanitization:

    def test_bare_terms_are_quoted(self, app):
        from app import normalize_boolean_query
        assert normalize_boolean_query("privacy liberty") == '"privacy" "liberty"'

    def test_operators_preserved(self, app):
        from app import normalize_boolean_query
        assert normalize_boolean_query("privacy and liberty") == '"privacy" AND "liberty"'
        assert normalize_boolean_query("privacy NEAR/5 liberty") == 'NEAR("privacy" "liberty", 5)'

    def test_fts_operators_neutralized(self, app):
        from app import normalize_boolean_query
        for hostile in ("col:val", "pre*", "^anchor", "a NEAR(b, 10000)"):
            result = normalize_boolean_query(hostile)
            # No unquoted FTS5 syntax characters may survive
            for chunk in result.split():
                if chunk in ("AND", "OR", "NOT"):
                    continue
                assert chunk.startswith('"') or chunk.startswith("NEAR(")

    def test_dangling_operators_dropped(self, app):
        from app import normalize_boolean_query
        assert normalize_boolean_query("AND") == ""
        assert normalize_boolean_query("privacy AND") == '"privacy"'
        assert normalize_boolean_query("OR privacy") == '"privacy"'

    def test_query_length_capped(self, app):
        from app import normalize_boolean_query, _FTS_MAX_QUERY_LEN
        result = normalize_boolean_query("a" * 5000)
        assert len(result) <= _FTS_MAX_QUERY_LEN + 2

    def test_search_endpoint_handles_hostile_query(self, auth_client):
        resp = auth_client.get('/case-law/search?text=a:b* OR ^"')
        assert resp.status_code == 200


class TestUploadValidation:

    def test_double_extension_masking_rejected(self, app):
        from app import allowed_file
        assert allowed_file("report.pdf") is True
        assert allowed_file("State v. Sharma order.pdf") is True
        assert allowed_file("notes.html.txt") is False
        assert allowed_file("img.svg.png") is False
        assert allowed_file("script.js.json") is False
        assert allowed_file("malware.exe") is False

    def test_html_content_in_txt_rejected(self, app):
        from io import BytesIO
        from werkzeug.datastructures import FileStorage
        from app import validate_upload

        fake = FileStorage(stream=BytesIO(b"<html><script>x</script>"), filename="notes.txt")
        assert validate_upload(fake) is not None

        ok = FileStorage(stream=BytesIO(b"plain text notes"), filename="notes.txt")
        assert validate_upload(ok) is None


class TestPasswordPolicy:

    def test_short_password_rejected_on_account_change(self, auth_client, csrf_token):
        resp = auth_client.post(
            "/account",
            data={
                "form_name": "update_password",
                "_csrf_token": csrf_token,
                "current_password": "TestPass123!",
                "new_password": "short1!",
                "confirm_password": "short1!",
            },
            follow_redirects=True,
        )
        assert b"at least 8 characters" in resp.data

    def test_overlong_password_rejected(self, app):
        from app import password_policy_error
        assert password_policy_error("x" * 200) is not None
        assert password_policy_error("a-perfectly-fine-password") is None


class TestSchemaV6Migration:

    def test_existing_sessions_survive_v5_to_v6_upgrade(self, tmp_path):
        """Simulate a production upgrade: a v5 database with live plaintext
        session tokens must migrate to v6 with logins still valid."""
        import sqlite3
        from services import db as db_mod
        from services.users import _hash_token

        conn = sqlite3.connect(tmp_path / "upgrade_test.db")
        conn.row_factory = sqlite3.Row

        # Build a v5-state database (migrations v1..v5 only)
        conn.execute("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db_mod._migrate_to_v1(conn)
        db_mod._migrate_to_v2(conn)
        db_mod._migrate_to_v3(conn)
        db_mod._migrate_to_v4(conn)
        db_mod._migrate_to_v5(conn)
        conn.execute(
            "INSERT INTO app_meta(key, value) VALUES('schema_version', '5') "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )

        conn.execute(
            "INSERT INTO users(email, password_hash, role) VALUES('u@x.com', 'h', 'admin')"
        )
        uid = conn.execute("SELECT id FROM users").fetchone()["id"]
        plaintext_token = "live-production-session-token-123"
        conn.execute(
            "INSERT INTO user_sessions(user_id, session_token, expires_at) VALUES(?, ?, '2099-01-01T00:00:00')",
            (uid, plaintext_token),
        )
        conn.commit()

        # Run the real migration entry point
        db_mod._ensure_schema(conn)
        conn.commit()

        version = conn.execute(
            "SELECT value FROM app_meta WHERE key = 'schema_version'"
        ).fetchone()["value"]
        # _ensure_schema upgrades all the way to the current version; the point
        # of this test is that the v5->v6 session-token hashing survives it.
        assert version == str(db_mod._SCHEMA_VERSION)

        # Old column gone, token stored hashed, lookup by hash succeeds
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(user_sessions)")]
        assert "session_token_hash" in cols and "session_token" not in cols
        row = conn.execute(
            "SELECT user_id FROM user_sessions WHERE session_token_hash = ?",
            (_hash_token(plaintext_token),),
        ).fetchone()
        assert row is not None and row["user_id"] == uid
        conn.close()


class TestCSPNonceCoverage:
    """Every authenticated page must render with all inline scripts nonced —
    an un-nonced inline script is dead under the nonce-based CSP."""

    PAGES = [
        "/", "/account", "/messages", "/invoice", "/certificate",
        "/letterhead", "/legal-notice", "/vakalatnama", "/settings",
    ]

    def test_all_pages_render_with_nonced_scripts(self, client, test_admin):
        import re
        from services.users import create_session

        token = create_session(test_admin.id)
        with client.session_transaction() as sess:
            sess["session_token"] = token
            sess["user_id"] = test_admin.id
            sess["user_role"] = test_admin.role
            sess["user_email"] = test_admin.email
            sess["_csrf_token"] = "test-csrf-token"

        inline_script = re.compile(r"<script(?![^>]*\bsrc=)([^>]*)>")
        for page in self.PAGES:
            resp = client.get(page)
            assert resp.status_code == 200, f"{page} -> {resp.status_code}"
            html = resp.get_data(as_text=True)
            for m in inline_script.finditer(html):
                assert "nonce=" in m.group(1), f"{page}: un-nonced inline <script{m.group(1)}>"


class TestTimingOracleMitigation:

    def test_unknown_email_still_runs_password_verification(self, db, monkeypatch):
        """The M2 fix: an Argon2 verification must run even when the email
        does not exist, so response timing cannot enumerate accounts."""
        import services.users as users_mod

        calls = []

        def spy(password, hashed):
            calls.append(hashed)
            return False

        monkeypatch.setattr(users_mod, "verify_password", spy)
        assert users_mod.authenticate_user("ghost@nowhere.test", "whatever") is None
        assert calls == [users_mod._DUMMY_HASH]

    def test_inactive_user_rejected_even_with_correct_password(self, db):
        from services.users import create_user, set_user_active, authenticate_user

        create_user("active@test.com", "Pass1234!")
        assert authenticate_user("active@test.com", "Pass1234!") is not None

        uid = create_user("inactive@test.com", "Pass1234!")
        set_user_active(uid, False)
        assert authenticate_user("inactive@test.com", "Pass1234!") is None


class TestPasswordResetTimingSafeLookup:

    def test_correct_token_matched_among_many(self, db):
        """The M8 rewrite scans all unconsumed tokens — each token must
        still resolve to its own reset row."""
        from services.users import create_user, create_password_reset_token, get_password_reset

        uid1 = create_user("r1@test.com", "Pass1234!")
        uid2 = create_user("r2@test.com", "Pass1234!")
        tok1 = create_password_reset_token(uid1)
        tok2 = create_password_reset_token(uid2)

        assert get_password_reset(tok1)["user_id"] == uid1
        assert get_password_reset(tok2)["user_id"] == uid2
        assert get_password_reset("bogus-token") is None
        assert get_password_reset("") is None


class TestRateLimitProxyTrust:

    def test_xff_ignored_by_default(self, app):
        import services.rate_limit as rl
        assert rl._TRUSTED_PROXY_HOPS == 0  # CASEORG_TRUSTED_PROXY unset
        with app.test_request_context(
            "/", environ_base={"REMOTE_ADDR": "9.9.9.9"},
            headers={"X-Forwarded-For": "6.6.6.6"},
        ):
            assert rl._get_client_ip() == "9.9.9.9"

    def test_xff_used_when_proxy_trusted(self, app, monkeypatch):
        import services.rate_limit as rl
        monkeypatch.setattr(rl, "_TRUSTED_PROXY_HOPS", 1)
        with app.test_request_context(
            "/", environ_base={"REMOTE_ADDR": "10.0.0.1"},
            headers={"X-Forwarded-For": "1.1.1.1, 2.2.2.2"},
        ):
            # One trusted hop: the last XFF entry is the real client
            assert rl._get_client_ip() == "2.2.2.2"


class TestOcrLanguageValidation:

    def test_language_code_pattern(self):
        from services.pdf_tools import _TESSERACT_LANG_CODE_RE as pat

        for good in ("eng", "hin", "chi_sim", "deu_frak", "script/Devanagari", "osd"):
            assert pat.fullmatch(good), good
        for bad in ("-l", "--oem 1", "../evil", "eng+hin", "a b", "e", "/etc/passwd", "script/../x"):
            assert not pat.fullmatch(bad), bad


class TestZipSizeCap:

    def test_oversized_input_rejected(self, tmp_path, monkeypatch):
        import services.pdf_tools as pt

        big = tmp_path / "big.bin"
        big.write_bytes(b"x" * 100)
        monkeypatch.setattr(pt, "MAX_ZIP_BYTES", 10)
        with pytest.raises(ValueError):
            pt.zip_paths([big], tmp_path / "out.zip")

    def test_normal_zip_succeeds(self, tmp_path):
        from services.pdf_tools import zip_paths

        f = tmp_path / "doc.txt"
        f.write_text("hello")
        out = tmp_path / "out.zip"
        zip_paths([f], out)
        assert out.exists() and out.stat().st_size > 0


class TestArgon2PinnedParameters:

    def test_parameters_are_pinned(self):
        from services.security import ph
        assert ph.time_cost == 3
        assert ph.memory_cost == 65536
        assert ph.parallelism == 4
        assert ph.hash_len == 32
        assert ph.salt_len == 16

    def test_hashes_with_other_params_still_verify(self):
        """Existing user hashes embed their own parameters and must keep
        verifying after the pinning change."""
        from argon2 import PasswordHasher
        from services.security import verify_password

        legacy = PasswordHasher(time_cost=2, memory_cost=32768, parallelism=2)
        h = legacy.hash("OldPassword1!")
        assert verify_password("OldPassword1!", h) is True
        assert verify_password("wrong", h) is False


class TestSettingsHardening:

    def test_fresh_install_gets_600k_iterations(self, tmp_path):
        import json
        from services.settings import SettingsManager

        SettingsManager(config_dir=tmp_path / "fresh")
        data = json.loads((tmp_path / "fresh" / "settings.json").read_text())
        assert data["secret_iterations"] == 600_000

    def test_existing_iteration_count_preserved(self, tmp_path):
        """Upgrading installs keep their persisted PBKDF2 iteration count so
        the existing secrets.enc remains decryptable."""
        import base64, json, os
        from services.settings import SettingsManager

        cfg = tmp_path / "existing"
        cfg.mkdir()
        (cfg / "settings.json").write_text(json.dumps({
            "schema_version": 1,
            "secret_iterations": 390_000,
            "secret_salt": base64.urlsafe_b64encode(os.urandom(16)).decode(),
        }))
        mgr = SettingsManager(config_dir=cfg)
        assert mgr.get("secret_iterations") == 390_000

    def test_master_key_chmod_failure_logged(self, tmp_path, monkeypatch, caplog):
        import logging
        from pathlib import Path
        from services.settings import SettingsManager

        # Force the master.key path (no env passphrase) and a failing chmod
        monkeypatch.delenv("CASEORG_SECRET_KEY", raising=False)
        monkeypatch.setattr(Path, "chmod", lambda self, mode: (_ for _ in ()).throw(OSError("not supported")))

        with caplog.at_level(logging.WARNING, logger="caseorg.settings"):
            mgr = SettingsManager(config_dir=tmp_path / "chmodfail")

        assert mgr.default_passphrase  # key still created and usable
        assert any("master.key" in rec.message for rec in caplog.records)


class TestPdfJobIdEntropy:

    def test_job_ids_are_256_bit(self):
        from services.pdf_jobs import create_job

        job_id = create_job(tool="merge", owner_user_id=1)
        # secrets.token_urlsafe(32) -> 43 url-safe chars (256 bits)
        assert len(job_id) >= 43


class TestOpenRedirectOnCSRFFailure:

    def test_csrf_failure_redirects_home_not_request_url(self, client, test_user):
        from services.users import create_session

        token = create_session(test_user.id)
        with client.session_transaction() as sess:
            sess["session_token"] = token
            sess["user_id"] = test_user.id
            sess["user_role"] = test_user.role
            sess["user_email"] = test_user.email
            sess["_csrf_token"] = "expected-token"

        resp = client.post("/account", data={"form_name": "update_email"}, follow_redirects=False)
        assert resp.status_code == 302
        location = resp.headers.get("Location", "")
        # Must land on home, never echo the (client-controlled) request URL
        assert "/account" not in location
        assert location.rstrip("/").endswith("localhost") or location == "/"
