"""Tests for import-time environment switches.

These settings are read once when app.py is imported, so they are verified
in a fresh interpreter rather than the already-imported test app.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent

_PROBE = (
    "import app;"
    "print('COOKIE_SECURE=%s' % app.app.config['SESSION_COOKIE_SECURE']);"
    "print('BENTO_HAS_CDN=%s' % ('cdn.jsdelivr.net' in app._CSP_BENTO))"
)


def _run_probe(extra_env: dict[str, str]) -> str:
    env = dict(os.environ, **extra_env)
    result = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


class TestEnvOverrides:

    def test_hardened_overrides(self):
        """CASEORG_COOKIE_SECURE=0 (plain-HTTP LAN) and CASEORG_BENTO_CDN=0
        (no jsDelivr in the Bento CSP) must both take effect."""
        out = _run_probe({"CASEORG_COOKIE_SECURE": "0", "CASEORG_BENTO_CDN": "0"})
        assert "COOKIE_SECURE=False" in out
        assert "BENTO_HAS_CDN=False" in out

    def test_production_defaults(self):
        """Without overrides (and without FLASK_DEBUG) cookies are Secure and
        the Bento CDN origin is allowed."""
        env = {k: v for k, v in os.environ.items()
               if k not in ("CASEORG_COOKIE_SECURE", "CASEORG_BENTO_CDN", "FLASK_DEBUG")}
        result = subprocess.run(
            [sys.executable, "-c", _PROBE],
            cwd=_ROOT, env=env, capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0, result.stderr
        assert "COOKIE_SECURE=True" in result.stdout
        assert "BENTO_HAS_CDN=True" in result.stdout
