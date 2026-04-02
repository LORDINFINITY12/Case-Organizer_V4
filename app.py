# ════════════════════════════════════════════════════════════════════
# IMPORTS & CONSTANTS
# ════════════════════════════════════════════════════════════════════
#
# Standard library, Flask/Werkzeug, and internal service imports.
# Also defines all application-wide constants: file-system root,
# allowed extensions, court/citation lookup tables, and spool dirs.
# ════════════════════════════════════════════════════════════════════

from __future__ import annotations

# ---- Standard library ----------------------------------------------------
import logging
import os
import re
import sqlite3
import shutil
import secrets
import tempfile
from concurrent.futures import TimeoutError as FutureTimeout
from decimal import Decimal, InvalidOperation
from io import BytesIO
from html.parser import HTMLParser
from contextlib import contextmanager, suppress
from datetime import datetime, timedelta, timezone
import time
from functools import wraps
from pathlib import Path
import json
from typing import Dict, Any, Iterable, Optional

# ---- Flask / Werkzeug ---------------------------------------------------
from flask import (
    Request,
    Flask, request, jsonify, session, redirect, url_for,
    render_template, render_template_string, flash, send_file, send_from_directory, g, abort
)
from markupsafe import Markup
from werkzeug.exceptions import BadRequest, InternalServerError, RequestEntityTooLarge
from werkzeug.utils import secure_filename

# ---- Internal services ---------------------------------------------------
from services.db import get_app_db, close_app_db
from services.settings import settings_manager
from services.users import (
    create_user,
    count_users,
    count_admins,
    UserExistsError,
    EmailInUseError,
    authenticate_user,
    get_user_by_email,
    get_user_by_id,
    create_password_reset_token,
    get_password_reset,
    consume_password_reset,
    set_user_password,
    mark_user_login,
    list_users,
    set_user_active,
    update_user_email,
    update_user_role,
    create_session,
    validate_session,
    delete_session,
    invalidate_user_sessions,
    cleanup_expired_sessions,
)
from services.email import send_email_async, EmailConfigError, clear_email_cache
from services.rate_limit import is_rate_limited, record_success
from services.messages import (
    create_message,
    list_inbox,
    list_sent,
    mark_message_read,
    get_message,
    count_unread,
    delete_message,
)

log = logging.getLogger(__name__)  # module-level logger shared by all routes

# ---- App config (pulled from caseorg_config.py) ------------------------
try:
    import caseorg_config as config  # renamed to avoid clashing with Debian's 'config' module
except Exception as e:
    raise RuntimeError("caseorg_config.py missing or invalid") from e


FS_ROOT = Path(config.FS_ROOT).resolve() if getattr(config, "FS_ROOT", None) else None  # user-defined storage root
SECRET_KEY = getattr(config, "SECRET_KEY", "dev-local-secret-key")
ALLOWED_EXTENSIONS = set(getattr(config, "ALLOWED_EXTENSIONS", []))  # e.g. {"pdf","docx","txt","json",...}

POSTFIX_PREFILL_FILE = settings_manager.paths.config_dir / "postfix.json"  # Debian postfix auto-config

SESSION_TIMEOUT = timedelta(days=30)  # rolling window; refreshed on every authenticated request

# ---- Case law storage constants ------------------------------------------
CASE_LAW_ROOT_NAME = "Case Law"       # sub-directory name under FS_ROOT
CASE_LAW_DB_NAME = "case_law_index.db"  # SQLite index sitting at FS_ROOT level
CASE_LAW_PRIMARY_TYPES = ("Criminal", "Civil", "Commercial")
CASE_LAW_CASE_TYPES = {
    "Criminal": [
        "498A (Cruelty/Dowry)", "Murder", "Rape", "Sexual Harassment", "Hurt",
        "138 NI Act", "Fraud", "Human Trafficking", "NDPS", "PMLA", "POCSO", "Constitutional", "Others"
    ],
    "Civil": [
        "Property", "Rent Control", "Inheritance/Succession", "Contract",
        "Marital Divorce", "Marital Maintenance", "Marital Guardianship", "Constitutional", "Others"
    ],
    "Commercial": [
        "Trademark", "Copyright", "Patent", "Banking", "Constitutional", "Others"
    ],
}

# ── Court / Forum constants ──────────────────────────────────────────────────
COURT_TYPES = ("Supreme Court", "Federal Court", "Privy Council", "High Court")

# Top-level courts (not High Courts) with (full_name, scc_online_abbreviation)
TOP_COURTS = {
    "Supreme Court": ("Supreme Court of India", "SC"),
    "Federal Court": ("Federal Court of India", "FC"),
    "Privy Council": ("Judicial Committee of the Privy Council", "PC"),
}

# Each entry: (display_name, scc_online_abbrev, is_historical)
HIGH_COURTS = [
    # ── Current ──
    ("Allahabad High Court", "All", False),
    ("Andhra Pradesh High Court", "AP", False),
    ("Bombay High Court", "Bom", False),
    ("Calcutta High Court", "Cal", False),
    ("Chhattisgarh High Court", "CG", False),
    ("Delhi High Court", "Del", False),
    ("Gauhati High Court", "Gau", False),
    ("Gujarat High Court", "Guj", False),
    ("Himachal Pradesh High Court", "HP", False),
    ("Jammu and Kashmir and Ladakh High Court", "J&K", False),
    ("Jharkhand High Court", "Jhar", False),
    ("Karnataka High Court", "Kar", False),
    ("Kerala High Court", "Ker", False),
    ("Madhya Pradesh High Court", "MP", False),
    ("Madras High Court", "Mad", False),
    ("Manipur High Court", "Mani", False),
    ("Meghalaya High Court", "Meg", False),
    ("Orissa High Court", "Ori", False),
    ("Patna High Court", "Pat", False),
    ("Punjab and Haryana High Court", "P&H", False),
    ("Rajasthan High Court", "Raj", False),
    ("Sikkim High Court", "Sik", False),
    ("Telangana High Court", "Tel", False),
    ("Tripura High Court", "Tri", False),
    ("Uttarakhand High Court", "Utt", False),
    # ── Historical / Defunct ──
    ("Hyderabad High Court", "Hyd", True),
    ("Mysore High Court", "Mys", True),
    ("Travancore-Cochin High Court", "TC", True),
    ("PEPSU High Court", "PEPSU", True),
    ("Nagpur High Court", "Nag", True),
]

# Lookup: court_name → abbreviation (covers top courts + all high courts)
_COURT_ABBREV_MAP = {}
for _ct_key, (_ct_name, _ct_abbr) in TOP_COURTS.items():
    _COURT_ABBREV_MAP[_ct_name] = _ct_abbr
for _hc_name, _hc_abbr, _hc_hist in HIGH_COURTS:
    _COURT_ABBREV_MAP[_hc_name] = _hc_abbr

# ── Citation / Journal constants ─────────────────────────────────────────────
CITATION_JOURNALS = ("INSC", "SCC", "SCC Online", "SCR", "AIR")

CITATION_JOURNAL_CONFIG = {
    "INSC":       {"has_volume": False, "has_court_abbrev": False,
                   "format": "({year}) INSC {page}"},
    "SCC":        {"has_volume": True,  "has_court_abbrev": False,
                   "format": "({year}) {volume} SCC {page}"},
    "SCC Online": {"has_volume": False, "has_court_abbrev": True,
                   "format": "{year} SCC OnLine {court_abbrev} {page}"},
    "SCR":        {"has_volume": True,  "has_court_abbrev": False,
                   "format": "({year}) {volume} SCR {page}"},
    "AIR":        {"has_volume": False, "has_court_abbrev": True,
                   "format": "AIR {year} {court_abbrev} {page}"},
}


# ---- Upload spool directory ----------------------------------------------
# Temporary staging area for file uploads before they are moved to FS_ROOT.
# Overridable via CASEORG_UPLOAD_TMP_DIR; defaults to config_dir/upload_spool.
UPLOAD_SPOOL_DIR = Path(
    os.environ.get(
        "CASEORG_UPLOAD_TMP_DIR",
        str(settings_manager.paths.config_dir / "upload_spool"),
    )
).expanduser().resolve()
with suppress(Exception):
    UPLOAD_SPOOL_DIR.mkdir(parents=True, exist_ok=True)
if UPLOAD_SPOOL_DIR.exists():
    tempfile.tempdir = str(UPLOAD_SPOOL_DIR)  # redirect Python tempfile calls here


class CaseOrganizerRequest(Request):
    # Keep request-body size unlimited at Flask/Werkzeug layer.
    # If uploads fail due to size, it is typically proxy/storage bound.
    max_content_length = None
    max_form_memory_size = None


# ════════════════════════════════════════════════════════════════════
# APP INITIALISATION
# ════════════════════════════════════════════════════════════════════
#
# Create the Flask app instance, wire up env-var-based tunables
# (slow-request threshold, static cache age, PDF thumbnail limits),
# and configure the session cookie.
# ════════════════════════════════════════════════════════════════════

# ---- Env-var tunables (all have sensible defaults) -------------------
SLOW_REQ_THRESHOLD_MS = float(os.environ.get("CASEORG_SLOW_MS", "250") or "250")     # log requests slower than this
STATIC_MAX_AGE = int(os.environ.get("CASEORG_STATIC_MAX_AGE", "86400") or "86400")   # Cache-Control max-age for static files
PDF_THUMB_MAX_PAGES = int(os.environ.get("CASEORG_PDF_THUMB_MAX_PAGES", "200") or "200")
PDF_THUMB_MAX_DIM_PX = int(
    os.environ.get(
        "CASEORG_PDF_THUMB_MAX_DIM",
        os.environ.get("CASEORG_PDF_THUMB_WIDTH", "520"),
    )
    or "520"
)

# ---- Flask app creation --------------------------------------------------
app = Flask(__name__)
app.request_class = CaseOrganizerRequest  # removes Werkzeug body-size limits
app.secret_key = SECRET_KEY
app.permanent_session_lifetime = SESSION_TIMEOUT
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = STATIC_MAX_AGE
app.config["MAX_CONTENT_LENGTH"] = None           # no server-side upload cap (proxy handles it)
app.config["SESSION_COOKIE_HTTPONLY"] = True        # prevent JS access to session cookie
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"      # CSRF baseline protection

_SESSION_CLEANUP_INTERVAL = 3600.0   # purge expired DB sessions at most once per hour
_SESSION_CLEANUP_LAST_RUN = 0.0

log.info("Running app.py from: %s", os.path.abspath(__file__))
log.info("FS_ROOT: %s", FS_ROOT)
log.info("UPLOAD_SPOOL_DIR: %s", UPLOAD_SPOOL_DIR)


# ════════════════════════════════════════════════════════════════════
# UTILITY HELPERS
# ════════════════════════════════════════════════════════════════════
#
# Pure functions and small helpers used across multiple sections.
# No route-level side effects — safe to call from anywhere.
# ════════════════════════════════════════════════════════════════════

# ---- Request-type detection ----------------------------------------------
def _wants_json_response() -> bool:
    """True when the current request expects a JSON reply (API or upload endpoint)."""
    return (
        request.path.startswith("/api/")
        or request.path == "/manage-case/upload"
        or request.path == "/case-law/upload"
    )


# ---- Filename / text sanitisation ----------------------------------------
def _sanitize_filename_fragment(value: str) -> str:
    """Strip anything that isn't alphanumeric, dash, or underscore."""
    return re.sub(r"[^a-zA-Z0-9_-]+", "", (value or "").strip().replace(" ", "-")).lower()


def _build_invoice_filename(invoice: Dict[str, Any]) -> str:
    parts = [
        _sanitize_filename_fragment(invoice.get("invoice_number", "")),
        _sanitize_filename_fragment(invoice.get("client_name", "")),
        _sanitize_filename_fragment(invoice.get("invoice_date", "")),
    ]
    filtered = [part for part in parts if part]
    base = "_".join(filtered) or "invoice"
    if not base.endswith(".pdf"):
        base += ".pdf"
    return base


def safe_text(value: Any) -> str:
    """Minimal HTML-escape for embedding user text in invoice PDF HTML."""
    text = str(value or "").strip() or "—"
    return (
        text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
    )


# ---- File-system utilities -----------------------------------------------
def ensure_root() -> None:
    """Create the storage root if configured."""
    if FS_ROOT:
        FS_ROOT.mkdir(parents=True, exist_ok=True)


def _is_static_request() -> bool:
    """True for /static/ requests — skips auth/session DB to keep asset serving fast."""
    endpoint = request.endpoint or ""
    return endpoint == "static" or (request.path or "").startswith("/static/")


def allowed_file(filename: str) -> bool:
    """Check extension against the whitelist from caseorg_config."""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# Magic-byte signatures for MIME validation of uploaded files.
_MAGIC_SIGNATURES: dict[str, list[bytes]] = {
    "pdf":  [b"%PDF"],
    "png":  [b"\x89PNG"],
    "jpg":  [b"\xFF\xD8\xFF"],
    "jpeg": [b"\xFF\xD8\xFF"],
    "docx": [b"PK\x03\x04"],       # OOXML is a ZIP container
    "json": [],                      # plain text — skip magic check
    "txt":  [],                      # plain text — skip magic check
}


def validate_upload(file_storage) -> Optional[str]:
    """Check extension AND magic bytes.  Returns an error string, or None if OK."""
    filename = file_storage.filename or ""
    if not allowed_file(filename):
        return f"File type not allowed: {filename}"

    ext = filename.rsplit(".", 1)[1].lower()
    sigs = _MAGIC_SIGNATURES.get(ext)
    if not sigs:
        return None  # no magic-byte check for this type

    header = file_storage.stream.read(8)
    file_storage.stream.seek(0)
    if not any(header.startswith(sig) for sig in sigs):
        return f"File content does not match its .{ext} extension."
    return None


def _safe_path(path: Path, root: Path) -> Path:
    """Resolve *path* and verify it lives under *root*.

    Returns the resolved path.  Raises ``ValueError`` if the resolved
    path escapes the root directory.
    """
    resolved = path.resolve()
    root_resolved = root.resolve()
    # Allow exact match (root itself) or a child of root
    if resolved != root_resolved and not str(resolved).startswith(str(root_resolved) + os.sep):
        raise ValueError("Path escapes allowed root")
    return resolved


# ---- Date / string formatting helpers ------------------------------------
def month_dir_name(dt: datetime) -> str:
    """Short month name for directory names, e.g. 'Jan', 'Feb'."""
    return dt.strftime("%b")

def ddmmyyyy(dt: datetime) -> str:
    """Date stamp used in case filenames, e.g. '19032026'."""
    return dt.strftime("%d%m%Y")

def normalize_ws(s: str) -> str:
    """Collapse all whitespace runs to a single space and strip edges."""
    return re.sub(r"\s+", " ", s or "").strip()


_ILLEGAL_FS_CHARS = re.compile(r"[\\/:*?\"<>|]")  # characters forbidden in Win/Linux filenames


def sanitize_case_law_component(text: str, replacement: str = " ") -> str:
    """Remove filesystem-illegal characters from a case-law path fragment."""
    cleaned = normalize_ws(text)
    cleaned = _ILLEGAL_FS_CHARS.sub(replacement, cleaned)
    cleaned = normalize_ws(cleaned)
    return cleaned


def ensure_unique_path(path: Path) -> Path:
    """Append ' (1)', ' (2)', … to *path* until it no longer collides on disk."""
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    counter = 1
    while True:
        candidate = parent / f"{stem} ({counter}){suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def short_excerpt(text: str, limit: int = 200, collapse_whitespace: bool = True) -> str:
    """Truncate *text* for search-result previews, adding '…' if trimmed."""
    if not text:
        return ""
    compact = normalize_ws(text) if collapse_whitespace else str(text).strip()
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 1)].rstrip() + "…"


# ════════════════════════════════════════════════════════════════════
# MIDDLEWARE & LIFECYCLE
# ════════════════════════════════════════════════════════════════════
#
# before_request / after_request hooks, error handlers, teardown
# callbacks, and Jinja2 context processors.  Registration order
# matters: hooks run in the order they are registered.
# ════════════════════════════════════════════════════════════════════

# ---- Request timing (slow request logger) --------------------------------
@app.before_request
def _capture_request_start() -> None:
    g._req_started_at = time.perf_counter()


@app.after_request
def _log_slow_requests(response):
    started = getattr(g, "_req_started_at", None)
    if started is None:
        return response
    duration_ms = (time.perf_counter() - started) * 1000.0
    if duration_ms >= SLOW_REQ_THRESHOLD_MS and not _is_static_request():
        app.logger.info("slow request %.1f ms %s %s", duration_ms, request.method, request.path)
    return response


# ---- Security headers & Content-Security-Policy --------------------------
# Two CSP profiles: a strict default for the main app and a permissive one
# for /bento/* routes (the integrated BentoPDF suite needs CDN WASM access).
_CSP_DEFAULT = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com "
    "https://cdnjs.cloudflare.com https://unpkg.com; "
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://unpkg.com; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "frame-src 'self'; "
    "worker-src 'self' blob:; "
    "object-src 'self'; "
    "base-uri 'self'"
)
_CSP_BENTO = (
    "default-src 'self' https://cdn.jsdelivr.net; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' "
    "https://cdn.jsdelivr.net blob:; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com "
    "https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; "
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://unpkg.com; "
    "img-src 'self' data: blob:; "
    "connect-src 'self' https://cdn.jsdelivr.net blob: data:; "
    "frame-src 'self' blob:; "
    "worker-src 'self' blob:; "
    "object-src 'self'; "
    "base-uri 'self'"
)


@app.after_request
def _set_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if request.path.startswith("/bento"):
        response.headers["Content-Security-Policy"] = _CSP_BENTO
    else:
        response.headers["Content-Security-Policy"] = _CSP_DEFAULT
    return response


# ---- Error handlers (JSON for API endpoints, HTML otherwise) -------------
@app.errorhandler(RequestEntityTooLarge)
def _handle_request_entity_too_large(_: RequestEntityTooLarge):
    if _wants_json_response():
        return jsonify({"ok": False, "msg": "Uploaded file is too large for the current server limit."}), 413
    return "Uploaded file is too large for the current server limit.", 413


@app.errorhandler(BadRequest)
def _handle_bad_request(exc: BadRequest):
    if _wants_json_response():
        msg = str(getattr(exc, "description", "") or "Invalid request payload.")
        return jsonify({"ok": False, "msg": msg}), 400
    return exc


@app.errorhandler(InternalServerError)
def _handle_internal_server_error(exc: InternalServerError):
    if not _wants_json_response():
        return exc

    root_exc = getattr(exc, "original_exception", None)
    if isinstance(root_exc, OSError):
        detail = str(root_exc)
        return jsonify(
            {
                "ok": False,
                "msg": (
                    f"Server failed while processing the upload ({detail}). "
                    f"Check available disk space for upload spool path: {UPLOAD_SPOOL_DIR}"
                ),
            }
        ), 500

    return jsonify(
        {
            "ok": False,
            "msg": (
                "Server failed while processing the upload. "
                "If file is large, check reverse-proxy body limits and upload spool storage."
            ),
        }
    ), 500


# ---- Teardown: close per-request DB connections at end of each request ---
@app.teardown_appcontext
def close_case_law_db(_: Optional[BaseException]) -> None:
    conn = g.pop('case_law_db', None)
    if conn is not None:
        conn.close()


@app.teardown_appcontext
def close_application_db(exc: Optional[BaseException]) -> None:
    close_app_db(exc)


# ---- Jinja2 context processors (auto-injected into every template) -------
@app.context_processor
def inject_current_user() -> Dict[str, Any]:
    """Make current_user, unread_count, and current_year available in all templates."""
    return {
        "current_user": g.get('current_user'),
        "unread_count": g.get('unread_count', 0),
        "current_year": datetime.now().year,
    }


@app.context_processor
def inject_csrf() -> Dict[str, Any]:
    """Provide csrf_token (string) and csrf_input (ready-made hidden field) to templates."""
    token = _ensure_csrf_token()
    return {
        "csrf_token": token,
        "csrf_input": Markup(f'<input type="hidden" name="_csrf_token" value="{token}">'),
    }


@app.context_processor
def inject_static_url() -> Dict[str, Any]:
    """Provide static_url() — like url_for('static') but appends ?v=mtime for cache-busting."""
    def static_url(filename: str) -> str:
        safe_name = (filename or "").lstrip("/")
        rel_path = Path(safe_name)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            return url_for("static", filename=safe_name)
        try:
            full_path = Path(app.static_folder) / rel_path
            version = int(full_path.stat().st_mtime)
        except OSError:
            version = None

        if version is None:
            return url_for("static", filename=safe_name)
        return url_for("static", filename=safe_name, v=version)

    return {"static_url": static_url}


# ════════════════════════════════════════════════════════════════════
# AUTH DECORATORS
# ════════════════════════════════════════════════════════════════════
#
# Four decorators for protecting routes:
#   require_login      – HTML redirect to /login if not authenticated
#   require_login_api  – JSON 401 if not authenticated
#   require_admin      – HTML redirect if not admin
#   require_admin_api  – JSON 401/403 if not admin
# ════════════════════════════════════════════════════════════════════


def is_initial_setup_complete() -> bool:
    """Quick check used by login/setup routes to gate the first-run wizard."""
    return _setup_complete_live()


def require_login(handler):
    """Decorator: redirect unauthenticated users to the login page."""
    @wraps(handler)
    def wrapper(*args, **kwargs):
        if g.get('current_user') is None:
            flash("Please log in first.", "error")
            return redirect(url_for("login"))
        return handler(*args, **kwargs)

    return wrapper


def require_login_api(handler):
    """Decorator: return JSON 401 for unauthenticated API callers."""
    @wraps(handler)
    def wrapper(*args, **kwargs):
        user = g.get('current_user')
        if user is None:
            return jsonify({"ok": False, "msg": "Authentication required."}), 401
        return handler(*args, **kwargs)

    return wrapper


def require_admin(handler):
    """Decorator: require admin role or redirect to home."""
    @wraps(handler)
    def wrapper(*args, **kwargs):
        if g.get('current_user') is None:
            flash("Please log in first.", "error")
            return redirect(url_for("login"))
        if g.current_user['role'] != 'admin':
            flash("Administrator access required.", "error")
            return redirect(url_for("home"))
        return handler(*args, **kwargs)

    return wrapper


def require_admin_api(handler):
    """Decorator: require admin role or return JSON 403."""
    @wraps(handler)
    def wrapper(*args, **kwargs):
        user = g.get('current_user')
        if user is None:
            return jsonify({"ok": False, "msg": "Authentication required."}), 401
        if user['role'] != 'admin':
            return jsonify({"ok": False, "msg": "Administrator access required."}), 403
        return handler(*args, **kwargs)

    return wrapper


# ════════════════════════════════════════════════════════════════════
# SESSION & AUTH HELPERS
# ════════════════════════════════════════════════════════════════════
#
# Session management (create/destroy/validate), CSRF token handling,
# and the chain of before_request hooks that enforce authentication:
#   1. _enforce_session_timeout  — verify DB-backed session token
#   2. _validate_csrf_token      — reject mutating requests without CSRF
#   3. _load_current_user        — populate g.current_user from session
#   4. _cleanup_expired_sessions — periodic DB purge (hourly)
#   5. _require_setup            — redirect to /setup if first-run
# ════════════════════════════════════════════════════════════════════

# ---- Session lifecycle ---------------------------------------------------
def login_user_session(user) -> None:
    """Create a fresh server-side session for *user* after successful authentication."""
    session.clear()
    session.permanent = True
    token = create_session(
        user_id=user['id'],
        user_agent=request.headers.get('User-Agent', ''),
        ip_address=request.remote_addr or '',
    )
    session['session_token'] = token
    session['user_id'] = user['id']
    session['user_role'] = user['role']
    session['user_email'] = user.get('email', '')
    session['_csrf_token'] = secrets.token_urlsafe(32)


def logout_user_session() -> None:
    """Invalidate the DB session row and clear the cookie."""
    token = session.get('session_token')
    if token:
        delete_session(token)
    session.clear()


def _ensure_csrf_token() -> str:
    """Return the CSRF token for the current session, creating one if absent."""
    token = session.get("_csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["_csrf_token"] = token
    return token


def _session_expired_response():
    """Return the appropriate expired-session response for API vs HTML requests."""
    wants_json = (
        request.accept_mimetypes.best == "application/json"
        or request.accept_mimetypes["application/json"] > request.accept_mimetypes["text/html"]
        or request.path.startswith("/api/")
    )
    if wants_json:
        return jsonify({"ok": False, "msg": "Session expired. Please log in again."}), 401
    flash("Session expired. Please log in again.", "warning")
    return redirect(url_for("login"))


@app.before_request
def _enforce_session_timeout():
    if _is_static_request():
        return
    user_id = session.get('user_id')
    if user_id is None:
        return
    token = session.get('session_token')
    if not token:
        session.clear()
        return _session_expired_response()
    valid_user_id = validate_session(token)
    if valid_user_id is None or valid_user_id != user_id:
        session.clear()
        return _session_expired_response()
    session.permanent = True


# ---- CSRF protection (before_request) ------------------------------------
_CSRF_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})  # read-only verbs skip CSRF check


@app.before_request
def _validate_csrf_token():
    if request.method in _CSRF_SAFE_METHODS:
        return
    if _is_static_request():
        return

    token = (
        request.form.get("_csrf_token")
        or request.headers.get("X-CSRF-Token")
    )
    if not token and request.is_json:
        json_data = request.get_json(silent=True)
        if isinstance(json_data, dict):
            token = json_data.get("_csrf_token")

    expected = session.get("_csrf_token")
    if not expected or not token or not secrets.compare_digest(token, expected):
        accept = request.accept_mimetypes
        wants_json = (
            accept.best == "application/json"
            or accept["application/json"] > accept["text/html"]
            or request.path.startswith("/api/")
        )
        if wants_json:
            return jsonify({"ok": False, "msg": "CSRF validation failed. Please refresh and try again."}), 403
        flash("Your session token expired or was invalid. Please try again.", "error")
        return redirect(request.url)


# ---- Load authenticated user into Flask g --------------------------------
@app.before_request
def _load_current_user() -> None:
    if _is_static_request():
        return
    g.current_user = None
    g.unread_count = 0
    user_id = session.get('user_id')
    if user_id is None:
        return
    user = get_user_by_id(user_id)
    if user and user['is_active']:
        g.current_user = user
        g.unread_count = count_unread(user['id'])
    else:
        session.clear()


# ---- Periodic housekeeping (expired session purge, once per hour) --------
@app.before_request
def _cleanup_expired_sessions() -> None:
    if _is_static_request():
        return
    global _SESSION_CLEANUP_LAST_RUN
    now = time.monotonic()
    if (now - _SESSION_CLEANUP_LAST_RUN) < _SESSION_CLEANUP_INTERVAL:
        return
    _SESSION_CLEANUP_LAST_RUN = now
    with suppress(Exception):
        cleanup_expired_sessions()


# ---- First-run guard: redirect everything to /setup until admin exists ---
@app.before_request
def _require_setup():
    if _is_static_request():
        return
    allowed_endpoints = {  # routes accessible before setup is complete
        "setup",
        "login",
        "static",
        "ping",
        "__routes",
        "forgot_password",
        "reset_password",
    }

    endpoint = request.endpoint or ""

    setup_complete = _setup_complete_cached()
    if not setup_complete:
        # Reconcile stale/failed cache values before forcing setup redirects.
        setup_complete = _update_setup_cache(_setup_complete_live())

    if not setup_complete:
        if endpoint not in allowed_endpoints:
            return redirect(url_for("setup"))
        return

    if g.get('current_user') is None and endpoint not in allowed_endpoints:
        wants_json = request.path.startswith("/api/") or request.path in {
            "/manage-case/upload",
            "/case-law/upload",
        }
        if wants_json:
            return jsonify({"ok": False, "msg": "Authentication required."}), 401
        flash("Please log in first.", "error")
        return redirect(url_for("login"))


# ════════════════════════════════════════════════════════════════════
# APP SETUP & BOOTSTRAP
# ════════════════════════════════════════════════════════════════════
#
# First-run setup wizard (/setup), case-law DB schema creation &
# migrations, setup-complete caching, and the one-time bootstrap
# hook that runs on the very first request.
# ════════════════════════════════════════════════════════════════════

# ---- Case-law DB paths ---------------------------------------------------
def _case_law_root() -> Path:
    """Return (and create) FS_ROOT/Case Law/ directory."""
    if not FS_ROOT:
        raise RuntimeError("Storage root is not configured yet")
    root = FS_ROOT / CASE_LAW_ROOT_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _case_law_db_file() -> Path:
    """Path to the SQLite index file (FS_ROOT/case_law_index.db)."""
    ensure_root()
    root = FS_ROOT
    if not root:
        raise RuntimeError("Storage root is not configured yet")
    return root / CASE_LAW_DB_NAME


# ---- Setup-complete cache (avoids a DB hit on every request) -------------
_SETUP_CACHE = {"done": None, "checked_at": 0.0}
_SETUP_CACHE_TTL = 300.0  # re-check the DB every 5 minutes until setup is done


def _setup_complete_live() -> bool:
    """Authoritative check: FS_ROOT configured and at least one user exists."""
    try:
        return bool(config.FS_ROOT) and count_users() > 0
    except Exception:
        return False


def _update_setup_cache(done: bool) -> bool:
    _SETUP_CACHE["done"] = bool(done)
    _SETUP_CACHE["checked_at"] = time.perf_counter()
    return bool(done)


def _setup_complete_cached() -> bool:
    now = time.perf_counter()
    if _SETUP_CACHE["done"] is True:
        return True
    if (now - _SETUP_CACHE["checked_at"]) < _SETUP_CACHE_TTL:
        return bool(_SETUP_CACHE["done"])
    return _update_setup_cache(_setup_complete_live())


# ---- Case-law SQLite schema & migrations ---------------------------------
def _ensure_case_law_schema(conn: sqlite3.Connection) -> None:
    """Create tables/FTS if missing, run column migrations, backfill citations."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS case_law (
            id INTEGER PRIMARY KEY,
            petitioner TEXT NOT NULL,
            respondent TEXT NOT NULL,
            citation TEXT NOT NULL,
            decision_year INTEGER NOT NULL,
            decision_month TEXT,
            primary_type TEXT NOT NULL,
            subtype TEXT NOT NULL,
            folder_rel TEXT NOT NULL,
            file_name TEXT NOT NULL,
            note_path_rel TEXT NOT NULL,
            note_text TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(petitioner, respondent, citation, primary_type, subtype, decision_year)
        )
        """
    )
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS case_law_fts USING fts5(
            content,
            petitioner,
            respondent,
            citation,
            note,
            case_id UNINDEXED
        )
        """
    )

    # ── v2 migration: court/forum + structured citations ─────────────────
    for col, coldef in [
        ("court_type", "TEXT DEFAULT NULL"),
        ("court_name", "TEXT DEFAULT NULL"),
        ("court_abbrev", "TEXT DEFAULT NULL"),
        ("citation_display", "TEXT DEFAULT ''"),
    ]:
        try:
            conn.execute(f"ALTER TABLE case_law ADD COLUMN {col} {coldef}")
        except sqlite3.OperationalError:
            pass  # column already exists

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS case_law_citations (
            id INTEGER PRIMARY KEY,
            case_id INTEGER NOT NULL REFERENCES case_law(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL DEFAULT 0,
            journal TEXT NOT NULL,
            cite_year INTEGER NOT NULL,
            volume TEXT DEFAULT NULL,
            court_abbrev TEXT DEFAULT NULL,
            page_number TEXT NOT NULL,
            display_text TEXT NOT NULL,
            UNIQUE(case_id, journal, cite_year, page_number)
        )
        """
    )

    # Backfill citation_display from legacy citation column
    conn.execute("""
        UPDATE case_law SET citation_display = citation
        WHERE (citation_display IS NULL OR citation_display = '') AND citation != ''
    """)

    # One-time migration: try to parse legacy citations into structured rows
    _migrate_legacy_citations(conn)

    conn.commit()


# ---- Legacy citation parsing (one-time migration from free-text field) ---
_CITE_RE_INSC       = re.compile(r"\((\d{4})\)\s+INSC\s+(\d+)")
_CITE_RE_SCC        = re.compile(r"\((\d{4})\)\s+(\d+)\s+SCC\s+(\d+)")
_CITE_RE_SCC_ONLINE = re.compile(r"(\d{4})\s+SCC\s+OnLine\s+(\S+)\s+(\d+)")
_CITE_RE_SCR        = re.compile(r"\((\d{4})\)\s+(\d+)\s+SCR\s+(\d+)")
_CITE_RE_AIR        = re.compile(r"AIR\s+(\d{4})\s+(\S+)\s+(\d+)")


def _migrate_legacy_citations(conn: sqlite3.Connection) -> None:
    """Attempt to parse existing free-text citations into case_law_citations rows."""
    rows = conn.execute("""
        SELECT cl.id, cl.citation FROM case_law cl
        WHERE cl.citation != ''
          AND NOT EXISTS (
              SELECT 1 FROM case_law_citations clc WHERE clc.case_id = cl.id
          )
    """).fetchall()

    for row in rows:
        case_id, raw = row["id"], row["citation"]
        parsed = _parse_citation_text(raw)
        if parsed:
            journal, year, volume, court_ab, page = parsed
            display = format_citation(journal, year, volume, court_ab, page)
            try:
                conn.execute("""
                    INSERT INTO case_law_citations
                        (case_id, ordinal, journal, cite_year, volume, court_abbrev, page_number, display_text)
                    VALUES (?, 0, ?, ?, ?, ?, ?, ?)
                """, (case_id, journal, year, volume, court_ab, page, display))
                conn.execute(
                    "UPDATE case_law SET citation_display = ? WHERE id = ?",
                    (display, case_id),
                )
            except sqlite3.IntegrityError:
                pass  # already migrated


def get_case_law_db() -> sqlite3.Connection:
    """Return (or create) a per-request connection to the case-law SQLite DB."""
    if 'case_law_db' not in g:
        path = _case_law_db_file()
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        _ensure_case_law_schema(conn)
        g.case_law_db = conn
    return g.case_law_db


def _migrate_plaintext_smtp_password() -> None:
    """One-time migration: move any plaintext SMTP password to the encrypted store."""
    import logging
    plain_pw = settings_manager.get("smtp_password")
    if plain_pw and isinstance(plain_pw, str):
        try:
            settings_manager.set_secret("smtp_password", plain_pw)
            settings_manager.delete("smtp_password")
            logging.getLogger("caseorg.security").info(
                "Migrated plaintext SMTP password to encrypted store."
            )
        except RuntimeError:
            logging.getLogger("caseorg.security").warning(
                "Plaintext SMTP password exists but encryption key is unavailable. "
                "Set CASEORG_SECRET_KEY to complete migration."
            )


# ---- First-request bootstrap (run once on startup) -----------------------
def _bootstrap_app_state() -> None:
    """Initialise the app DB connection and migrate legacy SMTP passwords."""
    conn = get_app_db()
    conn.close()
    g.pop('app_db', None)
    _migrate_plaintext_smtp_password()


_bootstrap_app_state_ran = False  # guard flag for the compat shim below

# Flask < 2.3 has before_first_request; Flask 3+ removed it — use a one-shot hook instead
if hasattr(app, 'before_first_request'):
    app.before_first_request(_bootstrap_app_state)
else:
    @app.before_request
    def _bootstrap_app_state_once():
        global _bootstrap_app_state_ran
        if _bootstrap_app_state_ran:
            return
        _bootstrap_app_state()
        _bootstrap_app_state_ran = True


# ---- /setup — first-run wizard (FS_ROOT, SMTP config, admin account) -----
@app.route("/setup", methods=["GET", "POST"])
def setup():
    global FS_ROOT

    if is_initial_setup_complete():
        _update_setup_cache(True)
        return redirect(url_for("login"))

    prefill = load_installed_postfix_defaults()

    try:
        stored_password = settings_manager.get_secret("smtp_password", "")
    except RuntimeError:
        stored_password = ""

    existing_tls = settings_manager.get("smtp_use_tls", None)

    form_state = {
        "fs_root": config.FS_ROOT or "",
        "smtp_host": settings_manager.get("smtp_host", ""),
        "smtp_port": settings_manager.get("smtp_port", ""),
        "smtp_username": settings_manager.get("smtp_username", ""),
        "smtp_use_tls": bool(existing_tls if existing_tls is not None else prefill.get("smtp_use_tls", True)),
        "smtp_from_email": settings_manager.get("smtp_from_email", ""),
        "admin_email": "",
        "smtp_password": stored_password,
    }

    smtp_locked = bool(prefill)

    def _coalesce(value, fallback):
        return value if value not in ("", None) else fallback

    form_state["smtp_host"] = _coalesce(form_state["smtp_host"], prefill.get("smtp_host", ""))
    form_state["smtp_username"] = _coalesce(form_state["smtp_username"], prefill.get("smtp_username", ""))
    form_state["smtp_from_email"] = _coalesce(form_state["smtp_from_email"], prefill.get("smtp_from_email", ""))
    form_state["smtp_password"] = _coalesce(form_state["smtp_password"], prefill.get("smtp_password", ""))

    prefill_port = prefill.get("smtp_port")
    current_port = form_state["smtp_port"]
    if isinstance(current_port, int):
        current_port_str = str(current_port)
    elif current_port in (None, ""):
        current_port_str = ""
    else:
        current_port_str = str(current_port)
    if (not current_port_str) and prefill_port not in (None, ""):
        current_port_str = str(prefill_port)
    form_state["smtp_port"] = current_port_str

    if existing_tls is None and prefill.get("smtp_use_tls") is not None:
        form_state["smtp_use_tls"] = bool(prefill["smtp_use_tls"])


    if request.method == "POST":
        form_state.update({
            "fs_root": (request.form.get("fs_root") or "").strip(),
            "smtp_host": (request.form.get("smtp_host") or "").strip(),
            "smtp_port": request.form.get("smtp_port") or "",
            "smtp_username": (request.form.get("smtp_username") or "").strip(),
            "smtp_use_tls": request.form.get("smtp_use_tls") in {"1", "true", "on"},
            "smtp_from_email": (request.form.get("smtp_from_email") or "").strip(),
            "admin_email": (request.form.get("admin_email") or "").strip(),
        })
        form_state["smtp_port"] = str(form_state["smtp_port"] or "").strip()
        smtp_password = request.form.get("smtp_password") or ""
        admin_password = request.form.get("admin_password") or ""
        admin_password2 = request.form.get("admin_password2") or ""

        if not smtp_password:
            smtp_password = form_state.get("smtp_password", "")
        form_state["smtp_password"] = smtp_password
        form_state["smtp_use_tls"] = bool(form_state["smtp_use_tls"])

        errors = []

        if not form_state["fs_root"]:
            errors.append("Please provide a storage path for FS Root.")

        if not form_state["smtp_host"]:
            errors.append("SMTP host is required.")

        try:
            smtp_port_int = int(form_state["smtp_port"]) if form_state["smtp_port"] else 0
            if smtp_port_int <= 0:
                raise ValueError
        except ValueError:
            errors.append("Enter a valid SMTP port.")
            smtp_port_int = 0

        if not form_state["smtp_from_email"]:
            errors.append("Default from-address is required for outgoing email.")

        if not form_state["admin_email"]:
            errors.append("Administrator email is required.")

        if not admin_password or len(admin_password) < 8:
            errors.append("Administrator password must be at least 8 characters long.")
        elif admin_password != admin_password2:
            errors.append("Administrator password confirmation does not match.")

        fs_root_path: Optional[Path] = None
        if not errors:
            try:
                fs_root_path = Path(form_state["fs_root"]).expanduser().resolve()
                fs_root_path.mkdir(parents=True, exist_ok=True)
            except Exception as exc:
                errors.append(f"Failed to prepare storage directory: {exc}")

        admin_id = None
        if not errors:
            try:
                config.save_fs_root(str(fs_root_path))
                FS_ROOT = fs_root_path

                settings_manager.set("smtp_host", form_state["smtp_host"])
                settings_manager.set("smtp_port", smtp_port_int)
                settings_manager.set("smtp_username", form_state["smtp_username"])
                settings_manager.set("smtp_use_tls", bool(form_state["smtp_use_tls"]))
                settings_manager.set("smtp_from_email", form_state["smtp_from_email"])

                if smtp_password:
                    try:
                        settings_manager.set_secret("smtp_password", smtp_password)
                    except RuntimeError:
                        flash(
                            "Unable to encrypt SMTP password. Ensure CASEORG_SECRET_KEY is set "
                            "or the master key file is accessible.",
                            "error",
                        )

                clear_email_cache()

                secret_key = settings_manager.get("flask_secret_key")
                if not secret_key:
                    secret_key = secrets.token_urlsafe(32)
                    settings_manager.set("flask_secret_key", secret_key)
                config.SECRET_KEY = secret_key
                app.secret_key = secret_key

                admin_id = create_user(form_state["admin_email"], admin_password, role="admin")
            except UserExistsError:
                errors.append("An account with that email already exists.")
            except Exception as exc:
                errors.append(f"Failed to finalise setup: {exc}")

        if errors:
            for err in errors:
                flash(err, "error")
        else:
            if admin_id is not None:
                user_row = get_user_by_id(admin_id)
                if user_row:
                    login_user_session(user_row)
            if smtp_password and not smtp_locked:
                port_value = form_state.get("smtp_port") or smtp_port_int or ""
                write_postfix_prefill_files(
                    form_state["smtp_host"],
                    port_value,
                    form_state.get("smtp_username", ""),
                    smtp_password,
                    bool(form_state.get("smtp_use_tls", True)),
                    form_state.get("smtp_from_email", ""),
                )
            _update_setup_cache(True)
            flash("Initial setup complete. You are signed in as the administrator.", "success")
            return redirect(url_for("home"))

    template = """
      <!doctype html>
      <title>Case Organizer – Setup</title>
      <link rel="stylesheet" href="{{ url_for('static', filename='css/style.css') }}">
      <div class="login-body">
        <div class="login-card">
          <h2>Initial Setup</h2>
          {% include '_flash.html' %}
          <form method="post" class="login-form">
            {{ csrf_input }}
            <label for="fs_root">Storage Folder</label>
            <input id="fs_root" name="fs_root" type="text" value="{{ state.fs_root }}" placeholder="/mnt/data/case-files" required>

            <h3>Outbound Email (SMTP)</h3>
            {% if smtp_locked %}
            <p class="setup-hint">
              These SMTP settings were captured during installation. To change them later, run
              <code>sudo dpkg-reconfigure case-organizer</code> after updating Postfix.
            </p>
            {% endif %}
            <label for="smtp_host">SMTP Host</label>
            <input id="smtp_host" name="smtp_host" type="text" value="{{ state.smtp_host }}" required{{ ' readonly' if smtp_locked else '' }}>

            <label for="smtp_port">SMTP Port</label>
            <input id="smtp_port" name="smtp_port" type="number" value="{{ state.smtp_port }}" required{{ ' readonly' if smtp_locked else '' }}>

            <label for="smtp_username">SMTP Username</label>
            <input id="smtp_username" name="smtp_username" type="text" value="{{ state.smtp_username }}"{{ ' readonly' if smtp_locked else '' }}>

            <label for="smtp_password">SMTP Password</label>
            <input id="smtp_password" name="smtp_password" type="password" autocomplete="new-password"{{ ' readonly' if smtp_locked else '' }}>

            {% if smtp_locked %}
            <label class="checkbox-inline locked-checkbox">
              <input type="checkbox" value="1" {% if state.smtp_use_tls %}checked{% endif %} disabled>
              Use TLS/STARTTLS
            </label>
            <input type="hidden" name="smtp_use_tls" value="{{ '1' if state.smtp_use_tls else '' }}">
            {% else %}
            <label class="checkbox-inline">
              <input type="checkbox" name="smtp_use_tls" value="1" {% if state.smtp_use_tls %}checked{% endif %}>
              Use TLS/STARTTLS
            </label>
            {% endif %}

            <label for="smtp_from_email">From Email</label>
            <input id="smtp_from_email" name="smtp_from_email" type="email" value="{{ state.smtp_from_email }}" required{{ ' readonly' if smtp_locked else '' }}>

            <h3>Administrator Account</h3>
            <label for="admin_email">Admin Email</label>
            <input id="admin_email" name="admin_email" type="email" value="{{ state.admin_email }}" required>

            <label for="admin_password">Password</label>
            <input id="admin_password" name="admin_password" type="password" autocomplete="new-password" required>

            <label for="admin_password2">Confirm Password</label>
            <input id="admin_password2" name="admin_password2" type="password" autocomplete="new-password" required>

            <button class="btn-primary" type="submit">Complete Setup</button>
          </form>
          <p class="login-foot">Settings stored in {{ settings_path }}</p>
        </div>
      </div>
    """

    return render_template_string(
        template,
        state=form_state,
        settings_path=str(settings_manager.paths.settings_file),
    )


# ════════════════════════════════════════════════════════════════════
# AUTHENTICATION ROUTES
# ════════════════════════════════════════════════════════════════════
#
# /login, /logout, /forgot-password, /reset-password/<token>, /account
# All templates have a render_template_string fallback in case the
# template file is missing (e.g. first deploy before static files).
# ════════════════════════════════════════════════════════════════════

# ---- POST /login — email + password authentication ----------------------
@app.route("/login", methods=["GET", "POST"])
def login():
    if is_initial_setup_complete() and g.get('current_user') is not None:
        flash("You are already signed in.", "info")
        return redirect(url_for("home"))

    email_value = ""
    if request.method == "POST":
        raw_email = request.form.get("email") or request.form.get("username") or ""
        email_value = normalize_ws(raw_email).lower()
        password = request.form.get("password") or ""

        conn = get_app_db()
        if is_rate_limited(conn, "login", window_seconds=300, max_attempts=5):
            flash("Too many login attempts. Please wait a few minutes and try again.", "error")
        else:
            user = authenticate_user(email_value, password)
            if user:
                record_success(conn, "login")
                login_user_session(user)
                mark_user_login(user["id"])
                flash(f"Welcome back, {user['email']}", "success")
                return redirect(url_for("home"))
            flash("Invalid email or password.", "error")

    try:
        return render_template("login.html", email=email_value, username=email_value)
    except Exception:
        return render_template_string("""
            <!doctype html><title>Login</title>
            <h1>Case Organizer</h1>
            <form method="post">
              {{ csrf_input }}
              <input name="email" type="email" placeholder="Email" value="{{ email }}" required>
              <input name="password" type="password" placeholder="Password" required>
              <button>Sign In</button>
            </form>
            <p><a href="{{ url_for('forgot_password') }}">Forgot your password?</a></p>
        """, email=email_value)


# ---- GET /logout — destroy session and redirect to login -----------------
@app.route("/logout")
def logout():
    logout_user_session()
    flash("Logged out.", "info")
    return redirect(url_for("login"))


# ---- POST /forgot-password — send reset link via email -------------------
@app.route("/forgot-password", methods=["GET", "POST"])
def forgot_password():
    if not is_initial_setup_complete():
        return redirect(url_for("setup"))

    if request.method == "POST":
        conn = get_app_db()
        if is_rate_limited(conn, "forgot_password", window_seconds=600, max_attempts=3):
            flash("Too many reset requests. Please wait before trying again.", "error")
            return redirect(url_for("forgot_password"))

        email = normalize_ws(request.form.get("email") or "").lower()
        user = get_user_by_email(email)
        if user:
            token = create_password_reset_token(user["id"])
            reset_link = url_for("reset_password", token=token, _external=True)
            body = (
                "Hello,\n\n"
                "A password reset was requested for your Case Organizer account.\n"
                f"Use the following link to set a new password: {reset_link}\n\n"
                "If you did not request this change, you can ignore this email."
            )
            try:
                future = send_email_async(user["email"], "Case Organizer password reset", body)
            except EmailConfigError:
                flash("Email is not configured. Contact an administrator to reset your password.", "error")
                return redirect(url_for("forgot_password"))
            except Exception:
                flash("Unable to send the reset email. Try again later or contact an administrator.", "error")
                return redirect(url_for("forgot_password"))
            else:
                try:
                    future.result(timeout=1.0)
                except FutureTimeout:
                    app.logger.info("Password reset email queued for %s", user["email"])
                except Exception as exc:
                    app.logger.error("Password reset email failed quickly: %s", exc, exc_info=True)
                    flash("Unable to send the reset email. Try again later or contact an administrator.", "error")
                    return redirect(url_for("forgot_password"))

        flash("If that email is registered, reset instructions have been sent.", "info")
        return redirect(url_for("login"))

    try:
        return render_template("forgot_password.html")
    except Exception:
        return render_template_string("""
            <!doctype html><title>Forgot Password</title>
            <h1>Reset your password</h1>
            <form method="post">
              {{ csrf_input }}
              <input name="email" type="email" placeholder="Email" required>
              <button>Send reset link</button>
            </form>
            <p><a href="{{ url_for('login') }}">Back to login</a></p>
        """)


# ---- POST /reset-password/<token> — consume token, set new password ------
@app.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token: str):
    if not token:
        flash("Reset token is required.", "error")
        return redirect(url_for("forgot_password"))

    reset_row = get_password_reset(token)
    if not reset_row:
        flash("This reset link is invalid or has expired.", "error")
        return redirect(url_for("forgot_password"))

    user = get_user_by_id(reset_row["user_id"])
    if not user or not user["is_active"]:
        flash("The account associated with this link is no longer available.", "error")
        return redirect(url_for("forgot_password"))

    if request.method == "POST":
        conn = get_app_db()
        if is_rate_limited(conn, "reset_password", window_seconds=300, max_attempts=5):
            flash("Too many attempts. Please wait before trying again.", "error")
        else:
            password = request.form.get("password") or ""
            password2 = request.form.get("password2") or ""
            if len(password) < 8:
                flash("Password must be at least 8 characters long.", "error")
            elif password != password2:
                flash("Passwords do not match.", "error")
            else:
                set_user_password(user["id"], password)
                invalidate_user_sessions(user["id"])
                consume_password_reset(reset_row["id"])
                mark_user_login(user["id"])
                login_user_session(user)
                flash("Password updated. You are now signed in.", "success")
                return redirect(url_for("home"))

    try:
        return render_template("reset_password.html")
    except Exception:
        return render_template_string("""
            <!doctype html><title>Reset Password</title>
            <h1>Choose a new password</h1>
            <form method="post">
              {{ csrf_input }}
              <input name="password" type="password" placeholder="New password" required>
              <input name="password2" type="password" placeholder="Confirm password" required>
              <button>Update password</button>
            </form>
            <p><a href="{{ url_for('login') }}">Back to login</a></p>
        """)


# ---- POST /account — change email or password ----------------------------
@app.route("/account", methods=["GET", "POST"])
@require_login
def account():
    user = g.current_user

    if request.method == "POST":
        form_name = request.form.get("form_name") or ""

        if form_name == "update_email":
            new_email = normalize_ws(request.form.get("new_email") or "").lower()
            current_password = request.form.get("current_password") or ""
            if not new_email:
                flash("Email cannot be empty.", "error")
            elif authenticate_user(user['email'], current_password) is None:
                flash("Current password is incorrect.", "error")
            else:
                try:
                    update_user_email(user['id'], new_email)
                    refreshed = get_user_by_id(user['id'])
                    if refreshed:
                        login_user_session(refreshed)
                        g.current_user = refreshed
                    flash("Email updated.", "success")
                except EmailInUseError:
                    flash("That email is already registered.", "error")
                except Exception as exc:
                    flash(f"Failed to update email: {exc}", "error")

        elif form_name == "update_password":
            current_password = request.form.get("current_password") or ""
            new_password = request.form.get("new_password") or ""
            confirm_password = request.form.get("confirm_password") or ""
            if authenticate_user(user['email'], current_password) is None:
                flash("Current password is incorrect.", "error")
            elif len(new_password) < 8:
                flash("New password must be at least 8 characters long.", "error")
            elif new_password != confirm_password:
                flash("Confirmation password does not match.", "error")
            else:
                set_user_password(user['id'], new_password)
                current_token = session.get('session_token')
                invalidate_user_sessions(user['id'], except_token=current_token)
                mark_user_login(user['id'])
                flash("Password updated successfully.", "success")
        else:
            flash("Unknown action submitted.", "error")

    try:
        return render_template("account.html")
    except Exception:
        return render_template_string("""
            <!doctype html><title>My Account</title>
            <h1>My Account</h1>
            <p>Email: {{ current_user.email }}</p>
        """)


# ════════════════════════════════════════════════════════════════════
# DASHBOARD
# ════════════════════════════════════════════════════════════════════
#
# The main landing page after login — search, create/manage case,
# upload case law.  All interactivity lives in main.js.
# ════════════════════════════════════════════════════════════════════


@app.route("/")
def home():
    try:
        return render_template("index.html")
    except Exception:
        return render_template_string("""
            <!doctype html><title>Home</title>
            <h1>Home (fallback)</h1>
            {% if current_user %}
              <p>Logged in as: {{ current_user.email }}</p>
            {% else %}
              <p>You are not signed in.</p>
            {% endif %}
            <p><a href="{{ url_for('logout') }}">Logout</a></p>
        """)


# ════════════════════════════════════════════════════════════════════
# CASE MANAGEMENT
# ════════════════════════════════════════════════════════════════════
#
# Helpers and routes for creating / uploading / searching / deleting
# ordinary case files.  Directory layout:
#   FS_ROOT / <year> / <month> / <Petitioner v. Respondent> / files…
#
# Routes: /create-case, /manage-case/upload, /static-serve, /search,
#         /api/delete-file, /api/years, /api/months, /api/cases,
#         /api/cases/search, /api/dir-tree
# ════════════════════════════════════════════════════════════════════

# ---- Path & naming helpers -----------------------------------------------
def case_dir(year: int, month_str: str, case_name: str) -> Path:
    """Build the case folder path: FS_ROOT/<year>/<month>/<case_name>."""
    return FS_ROOT / f"{year}" / month_str / case_name

def domain_code(domain: str) -> str:
    """Map 'Criminal'→'CRL', 'Civil'→'CIVIL', 'Commercial'→'COMM' for filenames."""
    d = (domain or "").strip().lower()
    if d == "criminal": return "CRL"
    if d == "civil":    return "CIVIL"
    if d == "commercial": return "COMM"
    return d.upper() if d else ""

def type_code(main_type: str) -> str:
    """Map full case type to abbreviated code, e.g. 'Writ Petition'→'WP'."""
    m = (main_type or "").strip().lower()
    # Extend this mapping as needed
    if m == "transfer petition":      return "TP"
    if m == "criminal revision":      return "CRL.REV."
    if m == "writ petition":          return "WP"
    if m == "bail application":       return "BAIL"
    if m == "orders" or m == "order": return "ORD"
    if m == "criminal miscellaneous": return "CRL.MISC."
    return (main_type or "").upper()

def build_filename(dt: datetime, main_type: str, domain: str, case_name: str, ext: str) -> str:
    """Compose standard case filename: (DDMMYYYY) TYPE DOMAIN Petitioner v. Respondent.ext"""
    # (DDMMYYYY) TYPE DOMAIN Petitioner v. Respondent.ext
    prefix = f"({ddmmyyyy(dt)}) {type_code(main_type)} {domain_code(domain)} {case_name}"
    return f"{prefix}.{ext}"

def build_case_name_from_parties(petitioner: str, respondent: str) -> str:
    """'Smith' + 'Jones' → 'Smith v. Jones' (used as directory name)."""
    pn = normalize_ws(petitioner)
    rn = normalize_ws(respondent)
    return f"{pn} v. {rn}" if pn and rn else ""


# ---- Text extraction for full-text search indexing -----------------------
def extract_text_for_index(file_path: Path) -> str:
    """Extract plain text from PDF, DOCX, or TXT for the search index."""
    suffix = file_path.suffix.lower()
    try:
        if suffix == ".pdf":
            from pdfminer.high_level import extract_text  # type: ignore

            return extract_text(str(file_path))
        if suffix == ".txt":
            return file_path.read_text(encoding="utf-8", errors="ignore")
        if suffix == ".docx":
            from docx import Document  # type: ignore

            doc = Document(str(file_path))
            return "\n".join(p.text for p in doc.paragraphs)
    except Exception as exc:
        log.warning("case-law: Failed to extract text from %s: %s", file_path, exc)
    return ""


def make_note_json(payload: Dict[str, Any]) -> str:
    """
    Produce a human-readable JSON-like text with blank lines between sections.
    Valid JSON with extra blank lines (allowed) for easy reading in editors.
    """
    from collections import OrderedDict
    from json import dumps

    od = OrderedDict()
    # Parties
    od["Petitioner Name"] = payload.get("Petitioner Name", "")
    od["Petitioner Address"] = payload.get("Petitioner Address", "")
    od["Petitioner Contact"] = payload.get("Petitioner Contact", "")
    od["__BLANK1__"] = ""
    od["Respondent Name"] = payload.get("Respondent Name", "")
    od["Respondent Address"] = payload.get("Respondent Address", "")
    od["Respondent Contact"] = payload.get("Respondent Contact", "")
    od["__BLANK2__"] = ""
    od["Our Party"] = payload.get("Our Party", "")
    od["__BLANK3__"] = ""
    # Classification
    od["Case Category"] = payload.get("Case Category", "")
    od["Case Subcategory"] = payload.get("Case Subcategory", "")
    od["Case Type"] = payload.get("Case Type", "")
    od["__BLANK4__"] = ""
    # Courts
    od["Court of Origin"] = {
        "State":   payload.get("Origin State", ""),
        "District":payload.get("Origin District", ""),
        "Court/Forum": payload.get("Origin Court/Forum", ""),
    }
    od["__BLANK5__"] = ""
    od["Current Court/Forum"] = {
        "State":   payload.get("Current State", ""),
        "District":payload.get("Current District", ""),
        "Court/Forum": payload.get("Current Court/Forum", ""),
    }
    od["__BLANK6__"] = ""
    od["Additional Notes"] = payload.get("Additional Notes", "")

    s = dumps(od, indent=2, ensure_ascii=False)
    # Replace spacer keys with blank lines
    s = re.sub(r'\n\s+"__BLANK[0-9]+__":\s*"",\n', "\n\n", s)
    return s


# ---- Browse APIs for Manage Case ---------------------------------------
@app.get("/api/years")
@require_login_api
def api_years():
    years = []
    if FS_ROOT.exists():
        for p in FS_ROOT.iterdir():
            if p.is_dir() and re.fullmatch(r"\d{4}", p.name):
                years.append(p.name)
    years.sort()  # ascending "2024", "2025"
    return jsonify({"years": years})

@app.get("/api/months")
@require_login_api
def api_months():
    year = (request.args.get("year") or "").strip()
    months = []
    base = FS_ROOT / year
    if year and base.exists() and base.is_dir():
        for m in base.iterdir():
            if m.is_dir():
                months.append(m.name)
    # order by calendar month if using Jan..Dec names
    order = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    months.sort(key=lambda x: order.index(x) if x in order else x)
    return jsonify({"months": months})

@app.get("/api/cases")
@require_login_api
def api_cases():
    year  = (request.args.get("year") or "").strip()
    month = (request.args.get("month") or "").strip()
    cases = []
    base = FS_ROOT / year / month
    if base.exists() and base.is_dir():
        for d in base.iterdir():
            if d.is_dir():
                cases.append(d.name)
    cases.sort(key=lambda s: s.lower())  # alphabetical by case name
    return jsonify({"cases": cases})


@app.get("/api/cases/search")
@require_login_api
def api_case_search():
    query = (request.args.get("q") or "").strip()
    matches: list[dict[str, str]] = []
    if not query:
        return jsonify({"cases": matches})

    lowered = query.lower()
    if FS_ROOT.exists():
        for year_dir in FS_ROOT.iterdir():
            if not year_dir.is_dir():
                continue
            year = year_dir.name
            if not re.fullmatch(r"\d{4}", year):
                continue
            for month_dir in year_dir.iterdir():
                if not month_dir.is_dir():
                    continue
                month = month_dir.name
                for case_dir in month_dir.iterdir():
                    if not case_dir.is_dir():
                        continue
                    case_name = case_dir.name
                    if lowered in case_name.lower():
                        matches.append({
                            "year": year,
                            "month": month,
                            "case": case_name,
                        })
                        if len(matches) >= 100:
                            return jsonify({"cases": matches})
    return jsonify({"cases": matches})


# ---- Create Case --------------------------------------------------------
@app.post("/create-case")
@require_login
def create_case():
    form = request.form

    # Parties (authoritative for Case Name)
    pn = normalize_ws(form.get("Petitioner Name"))
    rn = normalize_ws(form.get("Respondent Name"))
    case_name = normalize_ws(form.get("Case Name"))  # UI may send it; we recompute to be safe
    auto_case_name = build_case_name_from_parties(pn, rn)
    if not auto_case_name:
        return jsonify({"ok": False, "msg": "Petitioner Name and Respondent Name are required to form Case Name."}), 400
    if not case_name:
        case_name = auto_case_name

    # Date (YYYY-MM-DD) or today
    date_str = normalize_ws(form.get("Date"))
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d") if date_str else datetime.now()
    except ValueError:
        return jsonify({"ok": False, "msg": "Invalid Date. Use YYYY-MM-DD."}), 400

    year = int(dt.strftime("%Y"))
    month = month_dir_name(dt)
    cdir = case_dir(year, month, case_name)
    cdir.mkdir(parents=True, exist_ok=True)

    # Note.json payload (Title Case keys with spaces)
    fields = [
        "Petitioner Name", "Petitioner Address", "Petitioner Contact",
        "Respondent Name", "Respondent Address", "Respondent Contact",
        "Our Party", "Case Category", "Case Subcategory", "Case Type",
        "Origin State", "Origin District", "Origin Court/Forum",
        "Current State", "Current District", "Current Court/Forum",
        "Additional Notes",
    ]
    payload = {k: form.get(k, "") for k in fields}
    # Ensure consistency with Case Name used
    payload["Petitioner Name"] = pn
    payload["Respondent Name"] = rn

    note_text = make_note_json(payload)
    (cdir / "Note.json").write_text(note_text, encoding="utf-8")

    return jsonify({"ok": True, "path": str(cdir)})


# ---- Manage Case (Upload, Copy & Rename) --------------------------------

@app.post("/manage-case/upload")
@require_login_api
def manage_case_upload():
    form = request.form

    # Locate existing case folder by Year + Month + Case Name
    year_sel  = (form.get("Year") or "").strip()
    month_sel = (form.get("Month") or "").strip()
    case_name = normalize_ws(form.get("Case Name"))
    if not (year_sel and month_sel and case_name):
        return jsonify({"ok": False, "msg": "Year, Month, and Case Name are required."}), 400

    # Classification that influences filename
    domain      = normalize_ws(form.get("Domain"))        # Criminal / Civil / Commercial / Case Law
    subcategory = normalize_ws(form.get("Subcategory"))   # optional subfolder
    main_type   = normalize_ws(form.get("Main Type"))     # OPTIONAL now

    if not domain:
        return jsonify({"ok": False, "msg": "Case Category (Domain) is required."}), 400

    # Date used for filename (only in the 'typed' scheme)
    date_str = normalize_ws(form.get("Date"))
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d") if date_str else datetime.now()
    except ValueError:
        return jsonify({"ok": False, "msg": "Invalid Date. Use YYYY-MM-DD."}), 400

    # Accept MULTIPLE files
    files = request.files.getlist("file")
    if not files:
        return jsonify({"ok": False, "msg": "No files provided."}), 400

    cdir = FS_ROOT / year_sel / month_sel / case_name
    if not cdir.exists():
        return jsonify({"ok": False, "msg": "Case directory does not exist. Create the case first."}), 400

    # Helper: safe original base (without extension)
    def safe_stem(filename: str) -> str:
        base = Path(secure_filename(filename)).stem
        return re.sub(r"\s+", " ", base).strip()

    saved_paths = []

    def resolve_unique_destination(directory: Path, desired_filename: str) -> Path:
        safe_name = secure_filename(desired_filename) or "upload.bin"
        dest = directory / safe_name
        final_dest = dest
        counter = 1
        while final_dest.exists():
            final_dest = directory / f"{dest.stem}_{counter}{dest.suffix}"
            counter += 1
        return final_dest

    # ---------- NEW: Case Law handling ----------
    if domain.lower() == "case law":
        target_dir = cdir / "Case Laws"
        target_dir.mkdir(parents=True, exist_ok=True)

        for f in files:
            if not f or f.filename == "":
                continue
            upload_err = validate_upload(f)
            if upload_err:
                continue

            ext = f.filename.rsplit(".", 1)[1].lower()

            # Filename = Main Type (as typed) OR fallback to original stem
            base = (main_type or "").strip() or safe_stem(f.filename)
            # sanitize whitespace
            base = re.sub(r"\s+", " ", base).strip()
            new_name = f"{base}.{ext}"
            final_dest = resolve_unique_destination(target_dir, new_name)
            try:
                f.save(final_dest)
            except OSError as exc:
                return jsonify({"ok": False, "msg": f"Failed to save uploaded file: {exc}"}), 500
            saved_paths.append(str(final_dest))

        if not saved_paths:
            return jsonify({"ok": False, "msg": "No files were saved (unsupported type?)"}), 400

        return jsonify({"ok": True, "saved_as": saved_paths})
    # ---------- END Case Law handling ----------

    # Regular categories (Criminal/Civil/Commercial)
    target_dir = cdir / subcategory if subcategory else cdir
    target_dir.mkdir(parents=True, exist_ok=True)

    for f in files:
        if not f or f.filename == "":
            continue
        upload_err = validate_upload(f)
        if upload_err:
            continue

        ext = f.filename.rsplit(".", 1)[1].lower()

        # Naming rules:
        # - If subcategory is "Primary Documents" OR main_type is empty => keep original name, append " - {Case Name}"
        # - Else => use the typed scheme "(DDMMYYYY) TYPE DOMAIN CaseName.ext"
        is_primary_docs = subcategory and subcategory.strip().lower() == "primary documents"
        if is_primary_docs or not main_type:
            base = safe_stem(f.filename)
            new_name = f"{base} - {case_name}.{ext}"
        else:
            new_name = build_filename(dt, main_type, domain, case_name, ext)
        final_dest = resolve_unique_destination(target_dir, new_name)
        try:
            f.save(final_dest)
        except OSError as exc:
            return jsonify({"ok": False, "msg": f"Failed to save uploaded file: {exc}"}), 500
        saved_paths.append(str(final_dest))

    if not saved_paths:
        return jsonify({"ok": False, "msg": "No files were saved (unsupported type?)"}), 400

    return jsonify({"ok": True, "saved_as": saved_paths})

# ---- Safe file serving (whitelist FS_ROOT) ------------------------------

@app.get("/static-serve")
def static_serve():
    raw = request.args.get("path", "")
    download = request.args.get("download") in {"1", "true", "yes"}
    try:
        path = _safe_path(Path(raw), FS_ROOT)
    except (ValueError, OSError):
        return "Not found", 404
    if not path.is_file():
        return "Not found", 404
    resp = send_file(path, as_attachment=download, conditional=True)
    resp.cache_control.public = True
    resp.cache_control.max_age = STATIC_MAX_AGE
    resp.expires = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=STATIC_MAX_AGE)
    return resp


# ---- Search -------------------------------------------------------------

@app.get("/search")
def search():
    """
    Query params:
      q: free text (matches relative path)
      year: '2025'
      month: 'Jan' | 'Feb' | ...
      party: fragment to match in Case folder name (Petitioner v. Respondent)
      domain: 'Criminal' | 'Civil' | 'Commercial'
      subcategory: subfolder name e.g. 'Transfer Petitions', 'Orders/Judgments', 'Primary Documents'
      type: ignored for folder-driven search (still accepted but not required)
    Behavior:
      - If domain is given but subcategory is empty => return empty result set (force specificity).
      - If subcategory is provided => enumerate case dirs and list files found under that subfolder only.
      - Otherwise (no domain/subcategory) => fallback to broad scan with q/party/year/month filters.
    """
    q        = normalize_ws(request.args.get("q"))
    year     = normalize_ws(request.args.get("year"))
    month    = normalize_ws(request.args.get("month"))
    party    = normalize_ws(request.args.get("party"))
    domain   = normalize_ws(request.args.get("domain"))        # used only to require subcat if provided
    subcat   = normalize_ws(request.args.get("subcategory"))
    # ftype kept for backward compat but not used in folder mode
    # ftype    = normalize_ws(request.args.get("type"))

    results = []
    if not FS_ROOT.exists():
        return jsonify({"results": results})

    # Helper: yield candidate month directories given year/month filters
    def month_dirs():
        root = FS_ROOT
        years = [FS_ROOT / year] if year else [d for d in root.iterdir() if d.is_dir()]
        for y in years:
            if not y.is_dir():
                continue
            months = [y / month] if month else [d for d in y.iterdir() if d.is_dir()]
            for m in months:
                if m.is_dir():
                    yield m  # e.g., fs-files/2025/Jan

    # HARD RULE: if domain is given but subcategory is missing -> force empty
    if domain and not subcat:
        return jsonify({"results": []})

    # FOLDER-DRIVEN SEARCH when subcategory is present
    if subcat:
        subcat_lower = subcat.lower()

        for mdir in month_dirs():
            # case directories: fs-files/YYYY/Mon/<Case Name>
            for case_dir_path in mdir.iterdir():
                if not case_dir_path.is_dir():
                    continue

                case_name = case_dir_path.name  # "Petitioner v. Respondent"

                # party filter against case folder name
                if party and party.lower() not in case_name.lower():
                    continue

                # locate a child directory whose name matches subcategory (case-insensitive)
                target = None
                for child in case_dir_path.iterdir():
                    if child.is_dir() and child.name.lower() == subcat_lower:
                        target = child
                        break
                if target is None:
                    continue  # this case has no such subcategory folder

                # list allowed files inside that subcategory folder (non-recursive)
                for name in sorted(os.listdir(target)):
                    p = target / name
                    if not p.is_file():
                        continue
                    if not allowed_file(name):
                        continue

                    rel = p.relative_to(FS_ROOT)
                    # optional q filter against relative path text
                    if q and (q.lower() not in str(rel).lower()):
                        continue

                    results.append({
                        "file": name,
                        "path": str(p),
                        "rel":  str(rel),
                    })

        return jsonify({"results": results})

    # FALLBACK: no subcategory provided -> optional broad search
    # (Only if user didn't specify domain; if domain is provided we already early-returned empty)
    for root, dirs, files in os.walk(FS_ROOT):
        # Apply year/month filters by relative path segments
        try:
            rel = Path(root).relative_to(FS_ROOT)
            parts = rel.parts  # e.g., ('2025','Jan','Case Name', 'Some Subdir'...)
        except Exception:
            parts = ()

        if year and (len(parts) < 1 or parts[0] != year):
            continue
        if month and (len(parts) < 2 or parts[1] != month):
            continue

        # party filter checks the Case Name when available (3rd segment)
        if party:
            case_seg = parts[2] if len(parts) >= 3 else ""
            if party.lower() not in case_seg.lower():
                continue

        for name in files:
            if not allowed_file(name):
                continue
            p = Path(root) / name
            rel_file = p.relative_to(FS_ROOT)

            if q and (q.lower() not in str(rel_file).lower()):
                continue

            results.append({
                "file": name,
                "path": str(p),
                "rel":  str(rel_file),
            })

    return jsonify({"results": results})


# ---- delete-file --------------------------------


@app.post("/api/delete-file")
@require_admin_api
def api_delete_file():
    """
    Delete a file under FS_ROOT, given JSON:
      {"path": "/full/path/inside/FS_ROOT/.."}
    """
    try:
        data = request.get_json(silent=True) or {}
        raw = (data.get("path") or "").strip()
        if not raw:
            return jsonify({"ok": False, "msg": "Missing 'path'"}), 400

        try:
            target = _safe_path(Path(raw), FS_ROOT)
        except ValueError:
            return jsonify({"ok": False, "msg": "Not found"}), 404
        if not target.is_file():
            return jsonify({"ok": False, "msg": "Not a file"}), 400

        target.unlink()
        return jsonify({"ok": True})
    except FileNotFoundError:
        return jsonify({"ok": False, "msg": "File not found"}), 404
    except Exception as e:
        return jsonify({"ok": False, "msg": f"Delete failed: {e}"}), 500


# ---- Directory Search --------------------------

@app.get("/api/dir-tree")
def api_dir_tree():
    """
    List directory contents starting from FS_ROOT.
    Query param:
      path: relative path under FS_ROOT (optional)
    Returns:
      { "dirs": [names], "files": [ {name, path} ] }
    """
    rel = (request.args.get("path") or "").strip()
    base = FS_ROOT
    try:
        if rel:
            try:
                base = _safe_path(FS_ROOT / rel, FS_ROOT)
            except ValueError:
                return jsonify({"dirs": [], "files": []})
        if not base.exists() or not base.is_dir():
            return jsonify({"dirs": [], "files": []})

        dirs = []
        files = []
        for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if entry.is_dir():
                dirs.append(entry.name)
            elif entry.is_file():
                if allowed_file(entry.name):
                    files.append({"name": entry.name, "path": str(entry)})
        return jsonify({"dirs": dirs, "files": files})
    except Exception as e:
        return jsonify({"dirs": [], "files": [], "error": str(e)}), 500


# ════════════════════════════════════════════════════════════════════
# CASE LAW
# ════════════════════════════════════════════════════════════════════
#
# Upload, search, edit, and manage case-law judgements.  Each upload
# is indexed in case_law_index.db (SQLite + FTS5).  Directory layout:
#   FS_ROOT/Case Law/<Primary>/<SubType>/<Petitioner v Respondent>/
#
# Helpers: display-name builder, court/citation normalisation,
#          FTS boolean-query rewriter, index refresh.
# Routes: /case-law/upload, /case-law/search, /case-law/<id>/…
# ════════════════════════════════════════════════════════════════════

# ---- Display-name & normalisation helpers --------------------------------
def build_case_law_display_name(petitioner: str, respondent: str, citation: str) -> str:
    return f"{petitioner} vs {respondent} [{citation}]"


def normalize_primary_type(value: str) -> Optional[str]:
    candidate = normalize_ws(value)
    for option in CASE_LAW_PRIMARY_TYPES:
        if candidate.lower() == option.lower():
            return option
    return None


def normalize_case_type(primary: str, value: str) -> Optional[str]:
    pool = CASE_LAW_CASE_TYPES.get(primary)
    if not pool:
        return None
    candidate = normalize_ws(value)
    for option in pool:
        if candidate.lower() == option.lower():
            return option
    return None


# ── Court / Citation helpers ──────────────────────────────────────────────────

def normalize_court_type(value: str) -> Optional[str]:
    v = normalize_ws(value)
    for ct in COURT_TYPES:
        if v.lower() == ct.lower():
            return ct
    return None


def normalize_court_name(court_type: str, value: str) -> Optional[str]:
    v = normalize_ws(value)
    if court_type in TOP_COURTS:
        expected = TOP_COURTS[court_type][0]
        if not v or v.lower() == expected.lower():
            return expected
        return None
    if court_type == "High Court":
        for hc_name, _abbr, _hist in HIGH_COURTS:
            if v.lower() == hc_name.lower():
                return hc_name
        return None
    return None


def get_court_abbrev(court_type: str, court_name: str) -> str:
    if court_type in TOP_COURTS:
        return TOP_COURTS[court_type][1]
    return _COURT_ABBREV_MAP.get(court_name, "")


def format_citation(journal: str, year: int, volume: Optional[str],
                    court_abbrev: Optional[str], page: str) -> str:
    cfg = CITATION_JOURNAL_CONFIG.get(journal)
    if not cfg:
        return f"{journal} {year} {page}"
    return cfg["format"].format(
        year=year,
        volume=volume or "",
        court_abbrev=court_abbrev or "",
        page=page,
    ).strip()


def build_citation_display(citations: list) -> str:
    parts = []
    for c in citations:
        parts.append(format_citation(
            c.get("journal", ""),
            c.get("year", 0),
            c.get("volume"),
            c.get("court_abbrev"),
            c.get("page", ""),
        ))
    return "; ".join(parts) if parts else ""


def validate_citations(citations_data: list) -> tuple:
    """Validate list of citation dicts.
    Returns (ok: bool, error: str, normalized: list[dict])."""
    if not citations_data:
        return False, "At least one citation is required.", []
    normalized = []
    for i, c in enumerate(citations_data):
        journal = normalize_ws(c.get("journal", ""))
        if journal not in CITATION_JOURNALS:
            return False, f"Citation {i+1}: invalid journal '{journal}'.", []
        try:
            year = int(c.get("year", 0))
        except (ValueError, TypeError):
            return False, f"Citation {i+1}: year must be a number.", []
        if year < 1800 or year > datetime.now().year + 1:
            return False, f"Citation {i+1}: year looks invalid.", []
        volume = normalize_ws(c.get("volume", "") or "")
        court_ab = normalize_ws(c.get("court_abbrev", "") or "")
        page = normalize_ws(c.get("page", "") or "")
        cfg = CITATION_JOURNAL_CONFIG.get(journal, {})
        if cfg.get("has_volume") and not volume:
            return False, f"Citation {i+1}: volume is required for {journal}.", []
        if cfg.get("has_court_abbrev") and not court_ab:
            return False, f"Citation {i+1}: court abbreviation is required for {journal}.", []
        if not page:
            return False, f"Citation {i+1}: page/entry number is required.", []
        display = format_citation(journal, year, volume, court_ab, page)
        normalized.append({
            "journal": journal, "year": year, "volume": volume or None,
            "court_abbrev": court_ab or None, "page": page,
            "display": display, "ordinal": i,
        })
    return True, "", normalized


def save_citations(conn: sqlite3.Connection, case_id: int, citations: list) -> str:
    """Replace all citations for a case. Returns the display string."""
    conn.execute("DELETE FROM case_law_citations WHERE case_id = ?", (case_id,))
    for c in citations:
        conn.execute("""
            INSERT INTO case_law_citations
                (case_id, ordinal, journal, cite_year, volume, court_abbrev, page_number, display_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (case_id, c["ordinal"], c["journal"], c["year"],
              c.get("volume"), c.get("court_abbrev"), c["page"], c["display"]))
    display = build_citation_display(citations)
    conn.execute(
        "UPDATE case_law SET citation_display = ?, citation = ? WHERE id = ?",
        (display, display, case_id),
    )
    return display


def load_citations(conn: sqlite3.Connection, case_id: int) -> list:
    rows = conn.execute(
        "SELECT * FROM case_law_citations WHERE case_id = ? ORDER BY ordinal",
        (case_id,),
    ).fetchall()
    return [
        {
            "journal": r["journal"],
            "year": r["cite_year"],
            "volume": r["volume"],
            "court_abbrev": r["court_abbrev"],
            "page": r["page_number"],
            "display": r["display_text"],
            "ordinal": r["ordinal"],
        }
        for r in rows
    ]


# ---- Error / serialisation helpers ----------------------------------------
def case_law_error(message: str, status: int = 400):
    return jsonify({"ok": False, "msg": message}), status


def extract_note_summary(content: str) -> str:
    raw = content or ""
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            for key in ("Note", "note", "Summary", "summary", "Additional Notes", "additional_notes"):
                value = parsed.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    except json.JSONDecodeError:
        pass
    return raw.strip()


def fetch_case_law_record(conn: sqlite3.Connection, case_id: int) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM case_law WHERE id = ?", (case_id,)).fetchone()


def case_law_file_path(row: sqlite3.Row) -> Path:
    try:
        full = _safe_path(FS_ROOT / row["folder_rel"] / row["file_name"], FS_ROOT)
    except ValueError:
        raise RuntimeError("Resolved file path escapes storage root")
    return full


def case_law_folder_path(row: sqlite3.Row) -> Path:
    try:
        folder = _safe_path(FS_ROOT / row["folder_rel"], FS_ROOT)
    except ValueError:
        raise RuntimeError("Resolved folder path escapes storage root")
    return folder


def case_law_note_path(row: sqlite3.Row) -> Path:
    try:
        note = _safe_path(FS_ROOT / row["note_path_rel"], FS_ROOT)
    except ValueError:
        raise RuntimeError("Resolved note path escapes storage root")
    return note


def serialize_case_law(row: sqlite3.Row, text_preview: str = "") -> Dict[str, Any]:
    keys = row.keys()
    return {
        "id": row["id"],
        "petitioner": row["petitioner"],
        "respondent": row["respondent"],
        "citation": row["citation"],
        "citation_display": row["citation_display"] if "citation_display" in keys else row["citation"],
        "court_type": row["court_type"] if "court_type" in keys else None,
        "court_name": row["court_name"] if "court_name" in keys else None,
        "court_abbrev": row["court_abbrev"] if "court_abbrev" in keys else None,
        "decision_year": row["decision_year"],
        "decision_month": row["decision_month"],
        "primary_type": row["primary_type"],
        "case_type": row["case_type"],
        "folder": row["folder_rel"],
        "file_name": row["file_name"],
        "note_path": row["note_path_rel"],
        "note_preview": short_excerpt(row["note_text"], collapse_whitespace=False),
        "text_preview": short_excerpt(text_preview),
        "download_url": url_for("case_law_download", case_id=row["id"]),
        "note_url": url_for("case_law_note", case_id=row["id"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _parse_citation_text(raw: str) -> Optional[tuple]:
    """Try to match a citation string against known Indian legal citation formats.
    Returns (journal, year, volume, court_abbrev, page) or None."""
    m = _CITE_RE_SCC_ONLINE.search(raw)
    if m:
        return ("SCC Online", int(m.group(1)), None, m.group(2), m.group(3))
    m = _CITE_RE_SCC.search(raw)
    if m:
        return ("SCC", int(m.group(1)), m.group(2), None, m.group(3))
    m = _CITE_RE_SCR.search(raw)
    if m:
        return ("SCR", int(m.group(1)), m.group(2), None, m.group(3))
    m = _CITE_RE_INSC.search(raw)
    if m:
        return ("INSC", int(m.group(1)), None, None, m.group(2))
    m = _CITE_RE_AIR.search(raw)
    if m:
        return ("AIR", int(m.group(1)), m.group(2), m.group(2), m.group(3))
    return None


# ---- FTS5 index maintenance ----------------------------------------------
def refresh_case_law_index(
    conn: sqlite3.Connection,
    case_id: int,
    judgement_text: str,
    petitioner: str,
    respondent: str,
    citation: str,
    note_text: str,
) -> None:
    conn.execute("DELETE FROM case_law_fts WHERE rowid = ?", (case_id,))
    conn.execute(
        """
        INSERT INTO case_law_fts(rowid, content, petitioner, respondent, citation, note, case_id)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        """,
        (
            case_id,
            judgement_text or "",
            petitioner,
            respondent,
            citation,
            note_text or "",
            case_id,
        ),
    )


_NEAR_RE = re.compile(r'("[^"]+"|\S+)\s+NEAR/(\d+)\s+("[^"]+"|\S+)', re.IGNORECASE)
_BOOLEAN_OPERATORS = {
    "and": "AND",
    "or": "OR",
    "not": "NOT",
    "near": "NEAR",
}


def normalize_boolean_query(raw: str) -> str:
    """Convert a human-typed search query into FTS5 boolean syntax."""
    query = normalize_ws(raw)
    if not query:
        return ""

    def _near_sub(match: re.Match) -> str:
        left, distance, right = match.groups()
        return f"NEAR({left} {right}, {distance})"

    query = _NEAR_RE.sub(_near_sub, query)
    for lower, upper in _BOOLEAN_OPERATORS.items():
        query = re.sub(rf"\b{lower}\b", upper, query, flags=re.IGNORECASE)
    return query


# ---- Case Law Upload & Search -------------------------------------------


# ---- POST /case-law/upload — accept judgement PDF, index, create Note.json
@app.post("/case-law/upload")
@require_login_api
def case_law_upload():
    if not FS_ROOT:
        return case_law_error("Storage root is not configured yet.")

    ensure_root()

    form = request.form
    petitioner = normalize_ws(form.get("petitioner") or "")
    respondent = normalize_ws(form.get("respondent") or "")
    decision_year_raw = normalize_ws(form.get("decision_year") or "")
    primary_raw = normalize_ws(form.get("primary_type") or "")
    case_type_raw = normalize_ws(form.get("case_type") or form.get("subtype") or "")
    note_text = (form.get("note") or "").strip()

    if not petitioner:
        return case_law_error("Petitioner name is required.")
    if not respondent:
        return case_law_error("Respondent name is required.")

    # ── Court / Forum validation ──
    court_type_raw = normalize_ws(form.get("court_type") or "")
    court_name_raw = normalize_ws(form.get("court_name") or "")
    if not court_type_raw:
        return case_law_error("Court/Forum selection is required.")
    court_type = normalize_court_type(court_type_raw)
    if not court_type:
        return case_law_error("Invalid court type.")
    court_name = normalize_court_name(court_type, court_name_raw)
    if not court_name:
        return case_law_error("Invalid court name for the selected court type.")
    court_ab = get_court_abbrev(court_type, court_name)

    # ── Structured citations ──
    citations_raw = form.get("citations_json") or "[]"
    try:
        citations_data = json.loads(citations_raw)
    except json.JSONDecodeError:
        return case_law_error("Invalid citations data.")
    ok, err, citations = validate_citations(citations_data)
    if not ok:
        return case_law_error(err)
    citation_display = build_citation_display(citations)

    try:
        decision_year = int(decision_year_raw)
    except ValueError:
        return case_law_error("Decision year must be a number.")

    current_year = datetime.now().year
    if decision_year < 1800 or decision_year > current_year + 1:
        return case_law_error("Decision year looks invalid.")

    decision_month = ""

    primary = normalize_primary_type(primary_raw)
    if not primary:
        return case_law_error("Primary classification must be Civil, Criminal, or Commercial.")

    case_type = normalize_case_type(primary, case_type_raw)
    if not case_type:
        return case_law_error("Please select a valid case type for the chosen classification.")

    if not note_text:
        return case_law_error("An additional note is required for case law entries.")

    upload = request.files.get("file")
    if not upload or upload.filename == "":
        return case_law_error("Attach the judgment file to upload.")

    upload_err = validate_upload(upload)
    if upload_err:
        return case_law_error(upload_err)

    ext = upload.filename.rsplit(".", 1)[1].lower()

    conn = get_case_law_db()
    existing = conn.execute(
        """
        SELECT id FROM case_law
        WHERE petitioner = ? AND respondent = ? AND citation = ?
          AND primary_type = ? AND subtype = ? AND decision_year = ?
        """,
        (petitioner, respondent, citation_display, primary, case_type, decision_year),
    ).fetchone()
    if existing:
        return case_law_error("A case law record with the same metadata already exists.", 409)

    display_name = build_case_law_display_name(petitioner, respondent, citation_display)
    safe_case_name = sanitize_case_law_component(display_name) or f"Case Law {decision_year}"

    case_law_root = _case_law_root()
    primary_segment = sanitize_case_law_component(primary, replacement="-") or "General"
    type_segment = sanitize_case_law_component(case_type, replacement="-") or "General"
    base_dir = case_law_root / primary_segment / type_segment / str(decision_year)
    base_dir.mkdir(parents=True, exist_ok=True)

    case_dir = ensure_unique_path(base_dir / safe_case_name)
    case_dir.mkdir(exist_ok=False)

    tmp_name = secure_filename(f"upload_{datetime.now().timestamp()}_{upload.filename}")
    tmp_path = case_dir / tmp_name
    upload.save(tmp_path)

    target_file = case_dir / f"{safe_case_name}.{ext}"
    target_file = ensure_unique_path(target_file)
    tmp_path.rename(target_file)

    cite_list_json = [
        {
            "Journal": c["journal"], "Year": c["year"],
            "Volume": c.get("volume") or "",
            "Court Abbreviation": c.get("court_abbrev") or "",
            "Page": c["page"], "Display": c["display"],
        }
        for c in citations
    ]
    note_payload = {
        "Petitioner": petitioner,
        "Respondent": respondent,
        "Court Type": court_type,
        "Court Name": court_name,
        "Citations": cite_list_json,
        "Citation": citation_display,
        "Decision Year": decision_year,
        "Primary Type": primary,
        "Case Type": case_type,
        "Note": note_text,
        "Saved At": datetime.now().isoformat(timespec="seconds"),
    }
    note_json = json.dumps(note_payload, indent=2)

    note_file = case_dir / "note.json"
    note_file.write_text(note_json, encoding="utf-8")

    judgement_text = extract_text_for_index(target_file)
    folder_rel = str(case_dir.relative_to(FS_ROOT))
    note_rel = str(note_file.relative_to(FS_ROOT))

    try:
        cur = conn.execute(
            """
            INSERT INTO case_law (
                petitioner, respondent, citation, citation_display,
                court_type, court_name, court_abbrev,
                decision_year, decision_month,
                primary_type, subtype, folder_rel, file_name, note_path_rel, note_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                petitioner,
                respondent,
                citation_display,
                citation_display,
                court_type,
                court_name,
                court_ab,
                decision_year,
                decision_month,
                primary,
                case_type,
                folder_rel,
                target_file.name,
                note_rel,
                note_text,
            ),
        )
        case_id = cur.lastrowid
        save_citations(conn, case_id, citations)
        refresh_case_law_index(
            conn,
            case_id,
            judgement_text,
            petitioner,
            respondent,
            citation_display,
            note_json,
        )
        conn.commit()
    except Exception as exc:
        shutil.rmtree(case_dir, ignore_errors=True)
        raise exc

    return jsonify({
        "ok": True,
        "case_id": case_id,
        "folder": folder_rel,
        "file": target_file.name,
        "note": note_rel,
    })


# ---- GET /case-law/search — FTS5 full-text + faceted search --------------
@app.get("/case-law/search")
def case_law_search():
    if not FS_ROOT:
        return jsonify({"results": [], "filters": {}})

    conn = get_case_law_db()
    params: list[Any] = []
    where: list[str] = []
    join_fts = False

    text_query_raw = request.args.get("text") or ""
    text_query = normalize_ws(text_query_raw)
    if text_query:
        fts_query = normalize_boolean_query(text_query)
        if not fts_query:
            return jsonify({"results": []})
        join_fts = True
        where.append("c.id IN (SELECT rowid FROM case_law_fts WHERE case_law_fts MATCH ?)")
        params.append(fts_query)

    party_raw = normalize_ws(request.args.get("party") or "")
    party_mode = normalize_ws(request.args.get("party_mode") or "either")
    if party_raw:
        like = f"%{party_raw.lower()}%"
        if party_mode == "petitioner":
            where.append("LOWER(c.petitioner) LIKE ?")
            params.append(like)
        elif party_mode == "respondent":
            where.append("LOWER(c.respondent) LIKE ?")
            params.append(like)
        else:
            where.append("(LOWER(c.petitioner) LIKE ? OR LOWER(c.respondent) LIKE ?)")
            params.extend([like, like])

    citation_raw = normalize_ws(request.args.get("citation") or "")
    if citation_raw:
        where.append("LOWER(c.citation) LIKE ?")
        params.append(f"%{citation_raw.lower()}%")

    # Structured citation search (from Citation tab)
    cite_journal = normalize_ws(request.args.get("cite_journal") or "")
    cite_year_raw = normalize_ws(request.args.get("cite_year") or "")
    cite_volume = normalize_ws(request.args.get("cite_volume") or "")
    cite_page = normalize_ws(request.args.get("cite_page") or "")
    if cite_journal or cite_year_raw or cite_page:
        cite_where: list[str] = []
        cite_params: list[Any] = []
        if cite_journal:
            cite_where.append("cc.journal = ?")
            cite_params.append(cite_journal)
        if cite_year_raw:
            try:
                cite_where.append("cc.cite_year = ?")
                cite_params.append(int(cite_year_raw))
            except ValueError:
                return jsonify({"results": [], "error": "Invalid citation year."}), 400
        if cite_volume:
            cite_where.append("cc.volume = ?")
            cite_params.append(cite_volume)
        if cite_page:
            cite_where.append("cc.page_number = ?")
            cite_params.append(cite_page)
        sub = "SELECT cc.case_id FROM case_law_citations cc WHERE " + " AND ".join(cite_where)
        where.append(f"c.id IN ({sub})")
        params.extend(cite_params)

    year_raw = normalize_ws(request.args.get("year") or "")
    if year_raw:
        try:
            year_val = int(year_raw)
        except ValueError:
            return jsonify({"results": [], "error": "Invalid year filter supplied."}), 400
        where.append("c.decision_year = ?")
        params.append(year_val)

    primary_raw = normalize_ws(request.args.get("primary_type") or "")
    if primary_raw:
        primary = normalize_primary_type(primary_raw)
        if not primary:
            return jsonify({"results": [], "error": "Invalid primary classification."}), 400
        where.append("c.primary_type = ?")
        params.append(primary)

    case_type_raw = normalize_ws(request.args.get("case_type") or "")
    if case_type_raw and primary_raw:
        primary = normalize_primary_type(primary_raw)
        case_type = normalize_case_type(primary or "", case_type_raw)
        if not case_type:
            return jsonify({"results": [], "error": "Invalid case type supplied."}), 400
        where.append("c.subtype = ?")
        params.append(case_type)

    try:
        limit = int(request.args.get("limit", "50"))
    except ValueError:
        limit = 50
    limit = max(1, min(limit, 200))

    select_fields = [
        "c.id",
        "c.petitioner",
        "c.respondent",
        "c.citation",
        "c.citation_display",
        "c.court_type",
        "c.court_name",
        "c.court_abbrev",
        "c.decision_year",
        "c.decision_month",
        "c.primary_type",
        "c.subtype AS case_type",
        "c.folder_rel",
        "c.file_name",
        "c.note_path_rel",
        "c.note_text",
        "c.created_at",
        "c.updated_at",
    ]

    select_fields.append("'' AS fts_content")

    sql = "SELECT " + ", ".join(select_fields) + " FROM case_law c"

    if where:
        sql += " WHERE " + " AND ".join(where)

    sql += " ORDER BY c.decision_year DESC, c.created_at DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    results = [
        serialize_case_law(row, row["fts_content"]) for row in rows
    ]

    years = [r[0] for r in conn.execute("SELECT DISTINCT decision_year FROM case_law ORDER BY decision_year DESC").fetchall()]
    return jsonify({
        "results": results,
        "filters": {
            "years": years,
            "primary_types": list(CASE_LAW_PRIMARY_TYPES),
            "case_types": CASE_LAW_CASE_TYPES,
        },
    })


# ---- DELETE /case-law/<id> — remove record, files, and FTS entry ---------
@app.delete("/case-law/<int:case_id>")
@require_admin_api
def case_law_delete(case_id: int):
    if not FS_ROOT:
        return case_law_error("Storage root is not configured yet.")

    conn = get_case_law_db()
    row = fetch_case_law_record(conn, case_id)
    if not row:
        return case_law_error("Case law entry not found.", 404)

    try:
        folder_path = case_law_folder_path(row)
    except Exception as exc:
        return case_law_error(f"Invalid case law folder: {exc}", 500)

    try:
        if folder_path.exists():
            shutil.rmtree(folder_path)
    except FileNotFoundError:
        pass
    except Exception as exc:
        return case_law_error(f"Failed to remove case files: {exc}", 500)

    try:
        conn.execute("DELETE FROM case_law WHERE id = ?", (case_id,))
        conn.execute("DELETE FROM case_law_fts WHERE rowid = ?", (case_id,))
        conn.commit()
    except Exception as exc:
        return case_law_error(f"Failed to remove database record: {exc}", 500)

    return jsonify({"ok": True, "deleted_id": case_id})


# ---- GET /case-law/<id>/download — stream the judgement file -------------
@app.get("/case-law/<int:case_id>/download")
def case_law_download(case_id: int):
    if not FS_ROOT:
        return "Not found", 404

    conn = get_case_law_db()
    row = fetch_case_law_record(conn, case_id)
    if not row:
        return "Not found", 404

    try:
        file_path = case_law_file_path(row)
    except Exception:
        return "Not found", 404

    if not file_path.exists():
        return "Not found", 404

    return send_file(file_path, as_attachment=True)


# ---- GET|POST /case-law/<id>/note — read or update Note.json -------------
@app.route("/case-law/<int:case_id>/note", methods=["GET", "POST"])
def case_law_note(case_id: int):
    if not FS_ROOT:
        return case_law_error("Storage root is not configured yet.")

    conn = get_case_law_db()
    row = fetch_case_law_record(conn, case_id)
    if not row:
        return case_law_error("Case law record not found.", 404)

    try:
        note_path = case_law_note_path(row)
    except Exception:
        return case_law_error("Invalid note path for this record."), 400

    if request.method == "GET":
        content = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
        return jsonify({
            "ok": True,
            "content": content,
            "summary": row["note_text"],
        })

    data = request.get_json(silent=True) or {}
    content = data.get("content", "")

    parsed_payload: Optional[Dict[str, Any]] = None
    if isinstance(content, str) and content.strip():
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                parsed_payload = parsed
        except json.JSONDecodeError:
            parsed_payload = None

    current_primary = row["primary_type"]
    current_case_type = row["subtype"]

    primary_raw = None
    case_type_raw = None
    if parsed_payload is not None:
        primary_raw = parsed_payload.get("Primary Type") or parsed_payload.get("primary_type")
        case_type_raw = (
            parsed_payload.get("Case Type")
            or parsed_payload.get("Subtype")
            or parsed_payload.get("case_type")
        )

    primary_final = normalize_primary_type(primary_raw) if primary_raw else current_primary
    if not primary_final:
        return case_law_error("Invalid primary classification.", 400)

    case_type_candidate = case_type_raw or current_case_type
    case_type_final = normalize_case_type(primary_final, case_type_candidate or "")
    if not case_type_final:
        return case_law_error("Invalid case type for the selected classification.", 400)

    if parsed_payload is not None:
        parsed_payload["Primary Type"] = primary_final
        parsed_payload["Case Type"] = case_type_final
        content = json.dumps(parsed_payload, indent=2)

    summary = extract_note_summary(content)

    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(content, encoding="utf-8")

    judgement_row = conn.execute("SELECT content FROM case_law_fts WHERE rowid = ?", (case_id,)).fetchone()
    judgement_text = judgement_row["content"] if judgement_row else ""

    refresh_case_law_index(
        conn,
        case_id,
        judgement_text,
        row["petitioner"],
        row["respondent"],
        row["citation"],
        content,
    )

    conn.execute(
        """
        UPDATE case_law
        SET note_text = ?,
            primary_type = ?,
            subtype = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (summary, primary_final, case_type_final, case_id),
    )
    conn.commit()

    return jsonify({"ok": True, "summary": summary})


# ---- Court / Citation metadata API --------------------------------

# ---- GET /case-law/courts — JSON list of courts for the form dropdowns ---
@app.get("/case-law/courts")
def case_law_courts():
    """Return all court/forum and citation journal metadata for the frontend."""
    return jsonify({
        "court_types": list(COURT_TYPES),
        "top_courts": {k: {"name": v[0], "abbrev": v[1]} for k, v in TOP_COURTS.items()},
        "high_courts": [
            {"name": n, "abbrev": a, "historical": h}
            for n, a, h in HIGH_COURTS
        ],
        "journals": list(CITATION_JOURNALS),
        "journal_config": CITATION_JOURNAL_CONFIG,
    })


# ---- GET /case-law/<id>/detail — full record JSON for the edit modal -----
@app.get("/case-law/<int:case_id>/detail")
def case_law_detail(case_id: int):
    """Return full case data including structured citations for the edit form."""
    if not FS_ROOT:
        return case_law_error("Storage root is not configured yet.")

    conn = get_case_law_db()
    row = conn.execute(
        "SELECT *, subtype AS case_type FROM case_law WHERE id = ?",
        (case_id,),
    ).fetchone()
    if not row:
        return case_law_error("Case law record not found.", 404)

    result = serialize_case_law(row)
    result["citations"] = load_citations(conn, case_id)

    # Also return note content from file
    try:
        npath = case_law_note_path(row)
        result["note_content"] = npath.read_text(encoding="utf-8") if npath.exists() else ""
    except Exception:
        result["note_content"] = ""

    return jsonify({"ok": True, "case": result})


# ---- PUT|POST /case-law/<id>/edit — update metadata, rename folder/file --
@app.route("/case-law/<int:case_id>/edit", methods=["PUT", "POST"])
@require_login_api
def case_law_edit(case_id: int):
    """Edit all metadata for a case law entry (except the judgment file)."""
    if not FS_ROOT:
        return case_law_error("Storage root is not configured yet.")

    conn = get_case_law_db()
    row = fetch_case_law_record(conn, case_id)
    if not row:
        return case_law_error("Case law record not found.", 404)

    data = request.get_json(silent=True) or {}

    petitioner = normalize_ws(data.get("petitioner") or "")
    respondent = normalize_ws(data.get("respondent") or "")
    if not petitioner:
        return case_law_error("Petitioner name is required.")
    if not respondent:
        return case_law_error("Respondent name is required.")

    # Court / forum
    court_type_raw = normalize_ws(data.get("court_type") or "")
    court_name_raw = normalize_ws(data.get("court_name") or "")
    court_type = normalize_court_type(court_type_raw) if court_type_raw else None
    court_name = normalize_court_name(court_type, court_name_raw) if court_type else None
    court_ab = get_court_abbrev(court_type, court_name) if court_type and court_name else None

    # Decision year
    try:
        decision_year = int(data.get("decision_year", 0))
    except (ValueError, TypeError):
        return case_law_error("Decision year must be a number.")
    current_year = datetime.now().year
    if decision_year < 1800 or decision_year > current_year + 1:
        return case_law_error("Decision year looks invalid.")

    # Classification
    primary_raw = normalize_ws(data.get("primary_type") or "")
    primary = normalize_primary_type(primary_raw)
    if not primary:
        return case_law_error("Primary classification must be Civil, Criminal, or Commercial.")

    case_type_raw = normalize_ws(data.get("case_type") or "")
    case_type = normalize_case_type(primary, case_type_raw)
    if not case_type:
        return case_law_error("Please select a valid case type for the chosen classification.")

    note_text = (data.get("note") or "").strip()

    # Citations
    citations_data = data.get("citations")
    if citations_data and isinstance(citations_data, list) and len(citations_data) > 0:
        ok, err, citations = validate_citations(citations_data)
        if not ok:
            return case_law_error(err)
        citation_display = build_citation_display(citations)
    else:
        citations = []
        citation_display = row["citation"]

    # Update DB row
    conn.execute("""
        UPDATE case_law SET
            petitioner = ?, respondent = ?, citation = ?,
            citation_display = ?, decision_year = ?,
            primary_type = ?, subtype = ?,
            court_type = ?, court_name = ?, court_abbrev = ?,
            note_text = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    """, (petitioner, respondent, citation_display, citation_display,
          decision_year, primary, case_type,
          court_type, court_name, court_ab,
          note_text, case_id))

    if citations:
        save_citations(conn, case_id, citations)

    # Rewrite note.json
    try:
        npath = case_law_note_path(row)
        cite_list_json = [
            {
                "Journal": c["journal"], "Year": c["year"],
                "Volume": c.get("volume") or "",
                "Court Abbreviation": c.get("court_abbrev") or "",
                "Page": c["page"], "Display": c["display"],
            }
            for c in citations
        ]
        note_payload = {
            "Petitioner": petitioner,
            "Respondent": respondent,
            "Court Type": court_type or "",
            "Court Name": court_name or "",
            "Citations": cite_list_json,
            "Citation": citation_display,
            "Decision Year": decision_year,
            "Primary Type": primary,
            "Case Type": case_type,
            "Note": note_text,
            "Saved At": datetime.now().isoformat(timespec="seconds"),
        }
        npath.parent.mkdir(parents=True, exist_ok=True)
        npath.write_text(json.dumps(note_payload, indent=2), encoding="utf-8")
    except Exception:
        pass  # DB is source of truth

    # Refresh FTS
    fts_row = conn.execute(
        "SELECT content FROM case_law_fts WHERE rowid = ?", (case_id,)
    ).fetchone()
    judgement_text = fts_row["content"] if fts_row else ""
    refresh_case_law_index(
        conn, case_id, judgement_text,
        petitioner, respondent, citation_display, note_text,
    )

    conn.commit()

    updated_row = conn.execute(
        "SELECT *, subtype AS case_type FROM case_law WHERE id = ?",
        (case_id,),
    ).fetchone()
    result = serialize_case_law(updated_row)
    result["citations"] = load_citations(conn, case_id)
    return jsonify({"ok": True, "case": result})


# ---- API: fetch Note.json content (for modal) --------------------------
# ---- Note.json CRUD for ordinary cases (non-case-law) --------------------
@app.route("/api/note/<year>/<month>/<case_name>", methods=["POST"])
def api_update_note(year, month, case_name):
    cdir = FS_ROOT / year / month / case_name
    note_path = cdir / "Note.json"

    if not note_path.exists():
        template = make_note_json({})
        return jsonify({"ok": False, "msg": "Note.json not found", "template": template}), 404

    data = request.get_json(silent=True) or {}
    content = data.get("content", "")
    try:
        note_path.write_text(content, encoding="utf-8")
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "msg": f"Write failed: {e}"}), 500



# ---- API: Create Note.json --------------------------------
@app.post("/api/create-note")
def api_create_note():
    data = request.get_json(silent=True) or {}
    case_path = (data.get("case_path") or "").strip()
    if case_path:
        parts = Path(case_path).parts
        if len(parts) < 3:
            return jsonify({"ok": False, "msg": "Invalid case_path"}), 400
        year, month, case = parts[-3], parts[-2], parts[-1]
    else:
        year  = (data.get("year") or "").strip()
        month = (data.get("month") or "").strip()
        case  = normalize_ws(data.get("case") or "")

    if not (year and month and case):
        return jsonify({"ok": False, "msg": "Year, month, and case are required"}), 400

    try:
        cdir = _safe_path(FS_ROOT / year / month / case, FS_ROOT)
    except ValueError:
        return jsonify({"ok": False, "msg": "Invalid path"}), 400
    if not cdir.exists():
        return jsonify({"ok": False, "msg": "Case folder not found"}), 404

    note_file = cdir / "Note.json"
    if note_file.exists():
        return jsonify({"ok": False, "msg": "Note.json already exists"}), 400

    content = data.get("content") or ""

    payload: Dict[str, Any] = {}
    if content.strip():
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                payload = parsed
            else:
                payload = {"Additional Notes": content}
        except json.JSONDecodeError:
            payload = {"Additional Notes": content}

    try:
        text_out = make_note_json(payload)
        note_file.write_text(text_out, encoding="utf-8")
        return jsonify({"ok": True, "path": str(note_file)})
    except Exception as e:
        return jsonify({"ok": False, "msg": f"Write failed: {e}"}), 500

@app.route("/api/note/<year>/<month>/<case_name>", methods=["GET", "POST"])
def api_note(year, month, case_name):
    cdir = FS_ROOT / year / month / case_name
    note_path = cdir / "Note.json"
    if not note_path.exists():
        template = make_note_json({})
        return jsonify({"ok": False, "msg": "Note.json not found", "template": template}), 404

    if request.method == "GET":
        content = note_path.read_text(encoding="utf-8")
        return jsonify({"ok": True, "content": content, "template": make_note_json({})})

    data = request.get_json(silent=True) or {}
    content = data.get("content", "")
    try:
        note_path.write_text(content, encoding="utf-8")
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "msg": f"Write failed: {e}"}), 500


# ════════════════════════════════════════════════════════════════════
# MESSAGES
# ════════════════════════════════════════════════════════════════════
#
# Internal messaging between users (inbox, sent, compose, delete).
# Messages are stored in the app SQLite DB via services.messages.
# ════════════════════════════════════════════════════════════════════

# ---- GET /messages — inbox + sent list; POST to compose ------------------
@app.route("/messages", methods=["GET", "POST"])
@require_login
def messages_home():
    user = g.current_user
    draft = {
        "recipient_id": "",
        "subject": "",
        "body": "",
    }
    tab = (request.args.get("tab") or "inbox").lower()
    if tab not in {"inbox", "sent"}:
        tab = "inbox"

    if request.method == "POST":
        form_name = (request.form.get("form_name") or "").strip()
        if form_name == "send_message":
            draft["recipient_id"] = (request.form.get("recipient_id") or "").strip()
            draft["subject"] = (request.form.get("subject") or "").strip()
            draft["body"] = request.form.get("body") or ""

            try:
                recipient_id = int(draft["recipient_id"])
            except (TypeError, ValueError):
                recipient_id = 0

            subject = normalize_ws(draft["subject"])
            body = draft["body"].strip()

            if recipient_id <= 0:
                flash("Select a recipient.", "error")
            elif recipient_id == user['id']:
                flash("You cannot send a message to yourself.", "error")
            elif not body:
                flash("Message body cannot be empty.", "error")
            else:
                recipient = get_user_by_id(recipient_id)
                if not recipient or not recipient['is_active']:
                    flash("Recipient not found or inactive.", "error")
                else:
                    try:
                        message_id = create_message(user['id'], recipient_id, subject, body)
                    except Exception as exc:
                        flash(f"Unable to send message: {exc}", "error")
                    else:
                        try:
                            message_url = url_for("message_detail", message_id=message_id, _external=True)
                        except RuntimeError:
                            message_url = url_for("message_detail", message_id=message_id)

                        email_subject = subject or "You have a new message"
                        email_subject = f"New message in Case Organizer - {email_subject}" if subject else "New message in Case Organizer"
                        email_body_parts = [
                            f"You have received a new message from {user['email']}.",
                        ]
                        if subject:
                            email_body_parts.append(f"Subject: {subject}")
                        email_body_parts.extend(
                            [
                                "",
                                f"Read it here: {message_url}",
                                "",
                                "This is an automated notification from Case Organizer.",
                            ]
                        )
                        email_body = "\n".join(email_body_parts)

                        try:
                            future = send_email_async(recipient['email'], email_subject, email_body)
                        except EmailConfigError as exc:
                            app.logger.warning("Email notification skipped: %s", exc)
                            flash("Message sent, but notification email could not be delivered (email not configured).", "warning")
                        except Exception as exc:
                            app.logger.exception("Failed to queue notification email: %s", exc)
                            flash("Message sent, but notification email could not be queued.", "warning")
                        else:
                            try:
                                future.result(timeout=1.0)
                            except FutureTimeout:
                                app.logger.info("Notification email queued for message %s", message_id)
                            except Exception as exc:
                                app.logger.exception("Failed to send notification email: %s", exc)
                                flash("Message sent, but notification email failed to send.", "warning")

                        flash("Message sent.", "success")
                        return redirect(url_for("messages_home", tab="sent"))
        else:
            flash("Unknown action submitted.", "error")

    inbox_rows = list_inbox(user['id'])
    sent_rows = list_sent(user['id'])
    recipients = [u for u in list_users() if u['is_active'] and u['id'] != user['id']]
    smtp_locked = False

    try:
        return render_template(
            "messages.html",
            tab=tab,
            inbox=inbox_rows,
            sent=sent_rows,
            recipients=recipients,
            draft=draft,
            smtp_locked=smtp_locked,
        )
    except Exception:
        return render_template_string(
            """
            <!doctype html><title>Messages</title>
            <h1>Messages</h1>
            <p>This feature requires HTML templates. Inbox entries: {{ inbox|length }}</p>
            """,
            tab=tab,
            inbox=inbox_rows,
            sent=sent_rows,
            recipients=recipients,
            draft=draft,
            smtp_locked=smtp_locked,
        )


# ---- GET /messages/<id> — read a single message --------------------------
@app.route("/messages/<int:message_id>")
@require_login
def message_detail(message_id: int):
    user = g.current_user
    row = get_message(message_id, user['id'])
    if not row:
        flash("Message not found.", "error")
        return redirect(url_for("messages_home"))

    message = dict(row)
    if message['recipient_id'] == user['id'] and not message['is_read']:
        mark_message_read(message_id, user['id'])
        message['is_read'] = 1
        try:
            g.unread_count = count_unread(user['id'])
        except Exception:
            pass

    try:
        return render_template("message_detail.html", message=message)
    except Exception:
        return render_template_string(
            """
            <!doctype html><title>Message</title>
            <h1>{{ message.subject or 'No subject' }}</h1>
            <p>From: {{ message.sender_email }} | To: {{ message.recipient_email }}</p>
            <pre>{{ message.body }}</pre>
            """,
            message=message,
        )


# ---- POST /messages/<id>/delete — soft-delete a message ------------------
@app.post("/messages/<int:message_id>/delete")
@require_login
def delete_message_action(message_id: int):
    user = g.current_user
    tab = (request.form.get("current_tab") or "inbox").lower()
    if tab not in {"inbox", "sent"}:
        tab = "inbox"

    try:
        removed = delete_message(message_id, user['id'])
    except Exception as exc:
        flash(f"Unable to delete message: {exc}", "error")
    else:
        if removed:
            flash("Message deleted.", "success")
        else:
            flash("Message not found or cannot be deleted.", "error")

    return redirect(url_for("messages_home", tab=tab))


# ════════════════════════════════════════════════════════════════════
# INVOICES
# ════════════════════════════════════════════════════════════════════
#
# PDF invoice generation via ReportLab, auto-incrementing invoice
# numbers, and storage to FS_ROOT/Invoices/<year>/.
#
# Helpers: generate_invoice_pdf (PDF builder), _invoice_target_path,
#          _insert_invoice_row, _compute_next_invoice_number, etc.
# Routes: /invoice (form), /invoice/save, /api/invoices/next-number
# ════════════════════════════════════════════════════════════════════

# ---- PDF generation (ReportLab) ------------------------------------------
def generate_invoice_pdf(invoice: Dict[str, Any]) -> tuple[BytesIO, str]:
    """Build an A4 invoice PDF and return (BytesIO buffer, suggested filename)."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise RuntimeError(
            "ReportLab is required to generate invoices. Install it with `pip install reportlab`."
        ) from exc

    pdf_buffer = BytesIO()
    letterhead_margin = 12.7 * mm  # existing half-inch allowance for printed letterhead
    extra_letterhead_margin = 25.4 * mm  # add one more inch for larger letterheads
    doc = SimpleDocTemplate(
        pdf_buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=(24 * mm) + letterhead_margin + extra_letterhead_margin,
        bottomMargin=20 * mm,
        title=f"Invoice {invoice.get('invoice_number') or ''}".strip() or "Invoice",
    )
    AVAILABLE_MARGIN = 24  # ensure tables stay comfortably within the frame
    available_width = max(doc.width - AVAILABLE_MARGIN, doc.width * 0.9)

    styles = getSampleStyleSheet()
    title_style = styles["Title"].clone("InvoiceTitle")
    title_style.fontSize = 22
    title_style.leading = 26
    title_style.alignment = 0

    meta_block_style = ParagraphStyle(
        "InvoiceMetaBlock",
        parent=styles["Normal"],
        fontSize=11,
        leading=14,
        alignment=2,
        leftIndent=available_width * 0.55,
    )
    party_style = ParagraphStyle("InvoiceParty", parent=styles["Normal"], fontSize=10, leading=14)
    party_style_right = ParagraphStyle(
        "InvoicePartyRight", parent=party_style, alignment=2  # right-align
    )
    table_header_style = ParagraphStyle(
        "InvoiceHeader",
        parent=styles["Normal"],
        fontSize=10,
        leading=13,
        alignment=1,
        textColor=colors.whitesmoke,
        spaceAfter=4,
    )
    table_cell_style = ParagraphStyle("InvoiceCell", parent=styles["Normal"], fontSize=10, leading=13)
    money_style = ParagraphStyle(
        "InvoiceMoney", parent=styles["Normal"], fontSize=10, leading=13, alignment=2
    )
    total_label_style = ParagraphStyle(
        "InvoiceTotalLabel", parent=styles["Normal"], fontSize=10, leading=13, alignment=2
    )

    TWO_PLACES = Decimal("0.01")

    def as_decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
        if value in (None, "", False):
            return default
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError, TypeError):
            return default

    def money_text(amount: Decimal) -> str:
        quantized = amount.quantize(TWO_PLACES)
        return f"{quantized:,}"

    raw_items = invoice.get("items") or []
    processed_items: list[dict[str, Any]] = []
    sum_from_items = Decimal("0")
    for row in raw_items:
        if not isinstance(row, dict):
            continue
        amount = as_decimal(row.get("amount"))
        sum_from_items += amount
        processed_items.append(
            {
                "sn": str(row.get("sn") or ""),
                "item": row.get("item") or "",
                "description": row.get("description") or "",
                "amount": amount,
                "amount_display": money_text(amount),
            }
        )

    requested_total = as_decimal(
        invoice.get("total"), sum_from_items if processed_items else Decimal("0")
    )
    if processed_items and requested_total == Decimal("0") and sum_from_items > Decimal("0"):
        requested_total = sum_from_items
    total_display = money_text(requested_total)

    story: list = []

    story.append(Paragraph("INVOICE", title_style))
    story.append(Spacer(1, 6))
    story.append(Paragraph(_invoice_meta_block_html(invoice), meta_block_style))
    story.append(Spacer(1, 18))

    def format_party(heading: str, lines, alignment: str = "left"):
        body = "<br/>".join(lines) if lines else "—"
        style = party_style_right if alignment == "right" else party_style
        return Paragraph(f"<b>{heading}</b><br/>{body}", style)

    party_col_widths = [available_width * 0.55, available_width * 0.45]
    parties_table = Table(
        [
            [
                format_party("From", invoice.get("issuer_lines") or []),
                format_party("To", invoice.get("recipient_lines") or [], alignment="right"),
            ]
        ],
        colWidths=party_col_widths,
    )
    parties_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
            ]
        )
    )
    story.append(parties_table)
    story.append(Spacer(1, 18))

    table_data = [
        [
            Paragraph("S/N", table_header_style),
            Paragraph("Item", table_header_style),
            Paragraph("Description", table_header_style),
            Paragraph("Amount", table_header_style),
        ]
    ]

    if processed_items:
        for row in processed_items:
            table_data.append(
                [
                    Paragraph(row.get("sn") or "", table_cell_style),
                    Paragraph(row.get("item") or "", table_cell_style),
                    Paragraph(row.get("description") or "", table_cell_style),
                    Paragraph(row.get("amount_display") or "", money_style),
                ]
            )
    else:
        table_data.append(
            [
                Paragraph("", table_cell_style),
                Paragraph("", table_cell_style),
                Paragraph("No line items recorded", table_cell_style),
                Paragraph("", money_style),
            ]
        )

    table_data.append(
        [
            Paragraph("", table_cell_style),
            Paragraph("", table_cell_style),
            Paragraph("<b>Total</b>", total_label_style),
            Paragraph(total_display, money_style),
        ]
    )

    item_col_widths = [
        available_width * 0.12,
        available_width * 0.24,
        available_width * 0.38,
        available_width * 0.26,
    ]
    items_table = Table(
        table_data,
        colWidths=item_col_widths,
        repeatRows=1,
    )
    items_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                ("LINEBELOW", (0, 0), (-1, 0), 1, colors.black),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
                ("ALIGN", (0, 0), (0, -1), "CENTER"),
                ("ALIGN", (3, 0), (3, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.lightgrey),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f3f4f6")),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )

    story.append(items_table)
    story.append(Spacer(1, 12))

    doc.build(story)
    pdf_buffer.seek(0)
    filename = _build_invoice_filename(invoice)
    return pdf_buffer, filename


# ---- Invoice metadata & numbering helpers --------------------------------
def _invoice_meta_block_html(invoice: dict) -> str:
    return (
        "<font size=9><b>Invoice #</b></font><br/>"
        f"{safe_text(invoice.get('invoice_number'))}<br/><br/>"
        "<font size=9><b>Date</b></font><br/>"
        f"{safe_text(invoice.get('invoice_date'))}"
    )

INVOICE_NUMBER_PAD = 5


class InvoiceNumberConflict(Exception):
    """Raised when the chosen invoice number is already taken."""
    """Raised when trying to reuse an existing invoice number."""


class InvoiceStorageError(Exception):
    """Raised when saving the invoice PDF to disk fails."""
    """Raised when an invoice cannot be written to disk."""


def _format_invoice_number_value(value: int) -> str:
    return str(max(value, 0)).zfill(INVOICE_NUMBER_PAD)


def _parse_invoice_number(raw: Optional[str]) -> Optional[int]:
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def _get_invoice_counter(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?", ("invoice_next_number",)
    ).fetchone()
    if not row:
        return 1
    try:
        value = int(row["value"])
    except (TypeError, ValueError):
        value = 1
    return max(value, 1)


def _set_invoice_counter(conn: sqlite3.Connection, value: int) -> None:
    value = max(int(value), 1)
    conn.execute(
        """
        INSERT INTO app_settings(key, value, protected)
        VALUES('invoice_next_number', ?, 0)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (str(value),),
    )


def _compute_next_invoice_number(conn: sqlite3.Connection) -> int:
    counter = _get_invoice_counter(conn)
    row = conn.execute(
        """
        SELECT invoice_number
        FROM invoices
        WHERE invoice_number GLOB '[0-9]*'
        ORDER BY CAST(invoice_number AS INTEGER) DESC
        LIMIT 1
        """
    ).fetchone()
    if row:
        highest = _parse_invoice_number(row["invoice_number"])
        if highest is not None and highest >= counter:
            counter = highest + 1
    return counter


def _suggest_invoice_number(conn: sqlite3.Connection) -> str:
    return _format_invoice_number_value(_compute_next_invoice_number(conn))


def _reserve_invoice_number(conn: sqlite3.Connection) -> str:
    next_value = _compute_next_invoice_number(conn)
    _set_invoice_counter(conn, next_value + 1)
    return _format_invoice_number_value(next_value)


def _ensure_counter_after_use(conn: sqlite3.Connection, used_number: Optional[int]) -> None:
    if used_number is None:
        return
    current = _get_invoice_counter(conn)
    desired = used_number + 1
    if desired > current:
        _set_invoice_counter(conn, desired)


# ---- Invoice file storage ------------------------------------------------
def _invoice_target_path(
    invoice_number: str,
    case_year: Optional[str],
    case_month: Optional[str],
    case_name: Optional[str],
) -> tuple[Path, Optional[Path]]:
    if FS_ROOT is None:
        raise InvoiceStorageError("File storage root is not configured.")

    main_invoices_dir = FS_ROOT / "Invoices"
    main_invoices_dir.mkdir(parents=True, exist_ok=True)

    case_year = (case_year or "").strip()
    case_month = (case_month or "").strip()
    case_name = (case_name or "").strip()

    case_invoices_dir: Optional[Path] = None
    if case_year and case_month and case_name:
        base_dir = FS_ROOT / case_year / case_month / case_name
        if not base_dir.exists():
            raise InvoiceStorageError("Case directory not found on disk.")
        case_invoices_dir = base_dir / "Invoices"
        case_invoices_dir.mkdir(parents=True, exist_ok=True)
    else:
        case_invoices_dir = None

    safe_number = re.sub(r"[^a-zA-Z0-9_-]", "_", invoice_number).strip("_") or "invoice"
    base_filename = f"Invoice_{safe_number}"

    def choose_filename() -> str:
        attempt = 0
        while True:
            if attempt == 0:
                candidate = f"{base_filename}.pdf"
            elif attempt == 1:
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                candidate = f"{base_filename}_{ts}.pdf"
            else:
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                candidate = f"{base_filename}_{ts}_{secrets.token_hex(2)}.pdf"
            primary_exists = (main_invoices_dir / candidate).exists()
            case_exists = bool(case_invoices_dir and (case_invoices_dir / candidate).exists())
            if not primary_exists and not case_exists:
                return candidate
            attempt += 1

    final_filename = choose_filename()
    primary_path = main_invoices_dir / final_filename
    case_path = case_invoices_dir / final_filename if case_invoices_dir else None
    return primary_path, case_path


def _insert_invoice_row(
    conn: sqlite3.Connection,
    invoice_number: str,
    case_year: Optional[str],
    case_month: Optional[str],
    case_name: Optional[str],
    relative_path: str,
    payload_json: str,
    user_id: Optional[int],
) -> None:
    try:
        conn.execute(
            """
            INSERT INTO invoices (
                invoice_number,
                case_year,
                case_month,
                case_name,
                file_path,
                payload_json,
                generated_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                invoice_number,
                case_year or None,
                case_month or None,
                case_name or None,
                relative_path,
                payload_json,
                user_id,
            ),
        )
    except sqlite3.IntegrityError as exc:
        if "invoice_number" in str(exc).lower():
            raise InvoiceNumberConflict from exc
        raise


def _clean_lines(values: Any) -> list[str]:
    lines: list[str] = []
    if not isinstance(values, list):
        return lines
    for item in values:
        text = str(item or "").strip()
        if text:
            lines.append(text)
    return lines


_INVOICE_DATE_OUTPUT_FORMAT = "%d-%m-%Y"
_INVOICE_DATE_ACCEPTED_FORMATS = (
    "%d-%m-%Y",
    "%Y-%m-%d",
    "%d/%m/%Y",
    "%d.%m.%Y",
)


def _normalize_invoice_date(value: Any) -> str:
    raw = normalize_ws(str(value or ""))
    if not raw:
        return datetime.now().strftime(_INVOICE_DATE_OUTPUT_FORMAT)
    for fmt in _INVOICE_DATE_ACCEPTED_FORMATS:
        try:
            parsed = datetime.strptime(raw, fmt)
            return parsed.strftime(_INVOICE_DATE_OUTPUT_FORMAT)
        except ValueError:
            continue
    raise ValueError("Invoice date must be in DD-MM-YYYY format.")


# ---- GET /invoice — render the invoice form ------------------------------
@app.route("/invoice", methods=["GET"])
@require_login
def invoice_form():
    case_year = (request.args.get("year") or "").strip()
    case_month = (request.args.get("month") or "").strip()
    case_name = (request.args.get("case") or "").strip()
    case_context = None
    if case_year and case_month and case_name:
        case_context = {
            "year": case_year,
            "month": case_month,
            "case": case_name,
            "label": f"{case_year} / {case_month} — {case_name}",
        }
    try:
        return render_template("invoice.html", case_context=case_context)
    except Exception:
        return render_template_string("""
            <!doctype html><title>Generate Invoice</title>
            <h1>Invoice Generator</h1>
            <p>Unable to load the styled template. Please contact support.</p>
        """)


# ---- POST /invoice/save — generate PDF, store on disk, return download ---
@app.post("/invoice/save")
@require_login
def invoice_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "msg": "Invalid invoice payload."}), 400
    case_year = (payload.get("case_year") or "").strip()
    case_month = (payload.get("case_month") or "").strip()
    case_name = (payload.get("case_name") or "").strip()
    requested_number = str(payload.get("invoice_number") or "").strip()

    try:
        normalized_invoice_date = _normalize_invoice_date(payload.get("invoice_date"))
    except ValueError as exc:
        return jsonify({"ok": False, "msg": str(exc)}), 400

    invoice_data: Dict[str, Any] = {
        "invoice_number": requested_number,
        "invoice_date": normalized_invoice_date,
        "client_name": str(payload.get("client_name") or "").strip()[:180],
        "issuer_lines": _clean_lines(payload.get("issuer_lines") or []),
        "recipient_lines": _clean_lines(payload.get("recipient_lines") or []),
        "generated_at": payload.get("generated_at") or datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
    }

    two_places = Decimal("0.01")

    def _as_decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
        if value in (None, "", False):
            return default
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError, TypeError):
            return default

    items: list[dict[str, Any]] = []
    computed_total = Decimal("0")
    for row in payload.get("items") or []:
        if not isinstance(row, dict):
            continue
        amount_decimal = _as_decimal(row.get("amount"))
        computed_total += amount_decimal
        cleaned = {
            "sn": str(row.get("sn") or "").strip()[:40],
            "item": str(row.get("item") or "").strip()[:160],
            "description": str(row.get("description") or "").strip()[:600],
            "amount": str(amount_decimal.quantize(two_places)),
        }
        if any(cleaned.values()):
            items.append(cleaned)
    invoice_data["items"] = items

    requested_total = _as_decimal(payload.get("total"), computed_total if items else Decimal("0"))
    if items and requested_total == Decimal("0") and computed_total > Decimal("0"):
        requested_total = computed_total
    invoice_data["total"] = str(requested_total.quantize(two_places))

    conn = get_app_db()
    user_id = g.current_user["id"] if g.get("current_user") else None
    pdf_bytes: Optional[bytes] = None
    final_number: Optional[str] = None
    primary_path: Optional[Path] = None
    case_copy_path: Optional[Path] = None
    relative_path = ""
    auto_assigned = False

    try:
        with conn:
            if requested_number:
                final_number = requested_number
                existing = conn.execute(
                    "SELECT 1 FROM invoices WHERE invoice_number = ?",
                    (final_number,),
                ).fetchone()
                if existing:
                    raise InvoiceNumberConflict
            else:
                final_number = _reserve_invoice_number(conn)
                auto_assigned = True

            invoice_data["invoice_number"] = final_number

            try:
                pdf_buffer, _ = generate_invoice_pdf(invoice_data)
            except RuntimeError as exc:
                raise RuntimeError(str(exc)) from exc
            except Exception as exc:
                raise InvoiceStorageError(f"Failed to render invoice: {exc}") from exc

            pdf_bytes = pdf_buffer.getvalue()
            primary_path, case_copy_path = _invoice_target_path(
                final_number, case_year, case_month, case_name
            )
            try:
                primary_path.write_bytes(pdf_bytes)
                if case_copy_path:
                    case_copy_path.write_bytes(pdf_bytes)
            except OSError as exc:
                with suppress(FileNotFoundError):
                    primary_path.unlink()
                if case_copy_path:
                    with suppress(FileNotFoundError):
                        case_copy_path.unlink()
                raise InvoiceStorageError(f"Unable to write invoice PDF: {exc}") from exc

            try:
                relative_path = (
                    str(primary_path.relative_to(FS_ROOT))
                    if FS_ROOT
                    else str(primary_path)
                )
            except Exception:
                relative_path = str(primary_path)

            payload_for_record = dict(invoice_data)
            payload_for_record.update(
                {
                    "case_year": case_year,
                    "case_month": case_month,
                    "case_name": case_name,
                }
            )
            payload_json = json.dumps(payload_for_record, ensure_ascii=False)

            try:
                _insert_invoice_row(
                    conn,
                    final_number,
                    case_year,
                    case_month,
                    case_name,
                    relative_path,
                    payload_json,
                    user_id,
                )
            except InvoiceNumberConflict:
                with suppress(FileNotFoundError):
                    primary_path.unlink()
                if case_copy_path:
                    with suppress(FileNotFoundError):
                        case_copy_path.unlink()
                raise

            if not auto_assigned:
                used_int = _parse_invoice_number(final_number)
                _ensure_counter_after_use(conn, used_int)
    except InvoiceNumberConflict:
        return jsonify({"ok": False, "msg": "Invoice number already exists."}), 409
    except RuntimeError as exc:
        return jsonify({"ok": False, "msg": str(exc)}), 503
    except InvoiceStorageError as exc:
        return jsonify({"ok": False, "msg": str(exc)}), 500
    except Exception as exc:  # pragma: no cover - defensive
        return jsonify({"ok": False, "msg": f"Failed to save invoice: {exc}"}), 500

    if pdf_bytes is None or primary_path is None or final_number is None:
        return jsonify({"ok": False, "msg": "Invoice could not be generated."}), 500

    response = send_file(
        BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=primary_path.name,
    )
    response.headers["X-Invoice-Number"] = final_number
    if relative_path:
        response.headers["X-Invoice-Path"] = relative_path
    return response


# ---- GET /api/invoices/next-number — suggest next sequential number ------
@app.get("/api/invoices/next-number")
@require_login_api
def api_invoice_next_number():
    conn = get_app_db()
    try:
        suggestion = _suggest_invoice_number(conn)
    except Exception as exc:  # pragma: no cover - defensive
        return jsonify({"ok": False, "msg": f"Unable to determine invoice number: {exc}"}), 500
    return jsonify({"ok": True, "invoice_number": suggestion})


# ════════════════════════════════════════════════════════════════════
# BENTO PDF TOOLS
# ════════════════════════════════════════════════════════════════════
#
# Integrated BentoPDF suite (103 client-side PDF tools).  Static HTML
# tool pages live in static/bento/ and are served through a Flask
# wrapper that:
#   1. Extracts the <body> inner HTML from the bento page
#   2. Strips nav, footer, FAQ, and "Related Tools" sections
#   3. Injects head tags (CSS/JS modules) into bento_tool.html
#   4. Wraps the content in the Case Organizer shell (topbar, theme)
#
# Non-HTML assets (JS, CSS, WASM, workers) are served raw via
# send_from_directory.  A permissive CSP is applied to /bento/*
# routes so the tools can fetch WASM modules from CDN.
# ════════════════════════════════════════════════════════════════════

# IDs of the container divs that hold tool functionality in bento HTML
_BENTO_TOOL_IDS = (
    "uploader",
    "loader-modal",
    "alert-modal",
    "loading-overlay",
    "modal",
    "modal-container",
)


# ---- HTML parser: extract specific div fragments by ID -------------------
class _BentoFragmentParser(HTMLParser):
    """Extracts raw HTML of divs matching target_ids (fallback extraction method)."""
    def __init__(self, target_ids: Iterable[str]):
        super().__init__(convert_charrefs=False)
        self._target_ids = set(target_ids)
        self._current_id: Optional[str] = None
        self._depth = 0
        self.fragments: Dict[str, list[str]] = {target_id: [] for target_id in self._target_ids}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        tag_text = self.get_starttag_text() or ""
        tag_id = None
        for key, value in attrs:
            if key == "id":
                tag_id = value
                break

        if self._current_id is None and tag_id in self._target_ids:
            self._current_id = tag_id
            self._depth = 1
            self.fragments[tag_id].append(tag_text)
            return

        if self._current_id is not None:
            self._depth += 1
            self.fragments[self._current_id].append(tag_text)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        tag_text = self.get_starttag_text() or ""
        if self._current_id is not None:
            self.fragments[self._current_id].append(tag_text)
            return

        for key, value in attrs:
            if key == "id" and value in self._target_ids:
                self.fragments[value].append(tag_text)
                return

    def handle_endtag(self, tag: str) -> None:
        if self._current_id is None:
            return
        self.fragments[self._current_id].append(f"</{tag}>")
        self._depth -= 1
        if self._depth <= 0:
            self._current_id = None
            self._depth = 0

    def handle_data(self, data: str) -> None:
        if self._current_id is not None:
            self.fragments[self._current_id].append(data)

    def handle_comment(self, data: str) -> None:
        if self._current_id is not None:
            self.fragments[self._current_id].append(f"<!--{data}-->")

    def handle_entityref(self, name: str) -> None:
        if self._current_id is not None:
            self.fragments[self._current_id].append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self._current_id is not None:
            self.fragments[self._current_id].append(f"&#{name};")


# ---- Bento HTML extraction helpers ----------------------------------------
def _extract_bento_head_tags(html: str) -> list[str]:
    """Pull <script type="module">, modulepreload, and stylesheet links from <head>."""
    pattern = re.compile(
        r'(<script[^>]+type="module"[^>]*></script>'
        r'|<link[^>]+rel="modulepreload"[^>]*>'
        r'|<link[^>]+rel="stylesheet"[^>]*>)',
        re.IGNORECASE,
    )
    tags = []
    for match in pattern.finditer(html):
        tag = match.group(1)
        if "/bento/" in tag or "/assets/" in tag or "assets/" in tag:
            tag = re.sub(
                r'(src|href)=(["\'])(/?)assets/',
                r'\1=\2/bento/assets/',
                tag,
                flags=re.IGNORECASE,
            )
            tags.append(tag)
    return tags


def _extract_bento_body_inner(html: str) -> str:
    """Return everything between <body> and </body> (primary extraction)."""
    match = re.search(r"<body\b[^>]*>(.*)</body>", html, re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return match.group(1)


def _extract_bento_body_class(html: str) -> str:
    """Extract the class attribute from the <body> tag (Tailwind classes)."""
    match = re.search(r"<body\b[^>]*\bclass=\"([^\"]*)\"", html, re.IGNORECASE)
    if not match:
        return ""
    return match.group(1).strip()


def _strip_bento_sections(html: str) -> str:
    """Remove nav, footer, FAQ, How-It-Works, and Related-Tools sections."""
    cleaned = re.sub(r"<nav\b[^>]*>.*?</nav>", "", html, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"<footer\b[^>]*>.*?</footer>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)

    section_markers = [
        r'data-i18n="howItWorks\.title"',
        r'How It Works',
        r'data-i18n="relatedTools\.title"',
        r'Related PDF Tools',
        r'Related Tools',
        r'data-i18n="faq\.sectionTitle"',
        r'data-i18n="faq\.title"',
        r'Frequently Asked Questions',
        r'\bFAQ\b',
    ]
    for marker in section_markers:
        pattern = re.compile(
            rf"<section\b[^>]*>.*?{marker}.*?</section>",
            re.IGNORECASE | re.DOTALL,
        )
        cleaned = pattern.sub("", cleaned)

    return cleaned


_BENTO_ACRONYMS = frozenset({
    "pdf", "jpg", "png", "svg", "bmp", "tiff", "csv", "json", "xml",
    "rtf", "odt", "ods", "odp", "odg", "epub", "mobi", "cbz", "fb2",
    "psd", "xps", "pub", "vsd", "wpd", "wps", "heic", "webp", "ocr",
    "ai", "zip", "docx", "pdfa", "n",
})
_BENTO_TITLE_LOWERCASE = frozenset({"to", "of", "and", "for", "a"})


def _bento_title_from_filename(filename: str) -> str:
    stem = filename.rsplit("/", 1)[-1].removesuffix(".html")
    words = stem.split("-")
    parts = []
    for i, w in enumerate(words):
        low = w.lower()
        if low in _BENTO_ACRONYMS:
            parts.append(w.upper())
        elif i > 0 and low in _BENTO_TITLE_LOWERCASE:
            parts.append(low)
        else:
            parts.append(w.capitalize())
    return " ".join(parts) or "PDF Tool"


def _extract_bento_body(html: str, target_ids: Iterable[str] = _BENTO_TOOL_IDS) -> str:
    """Fallback: extract only divs with known IDs (uploader, modal, etc.)."""
    parser = _BentoFragmentParser(target_ids)
    parser.feed(html)
    chunks = []
    for target_id in target_ids:
        chunk = "".join(parser.fragments.get(target_id, []))
        if chunk:
            chunks.append(chunk)
    return "\n".join(chunks)


# ---- GET /bento/<filename> — serve tool pages through the wrapper --------
@app.get("/bento")
@app.get("/bento/")
@app.get("/bento/<path:filename>")
@require_login
def bento_tools(filename: str = ""):
    bento_root = Path(app.static_folder) / "bento"
    if not filename or filename in {"index", "index.html"}:
        return redirect(url_for("bento_tools", filename="tools.html"))
    raw_html_prefixes = ("pdfjs-annotation-viewer/", "pdfjs-viewer/")
    if filename.endswith(".html") and filename.startswith(raw_html_prefixes):
        return send_from_directory(bento_root, filename)
    if filename.endswith(".html"):
        path = bento_root / filename
        if path.is_file():
            html = path.read_text(encoding="utf-8")
            body_class = _extract_bento_body_class(html)
            body_html = _extract_bento_body_inner(html)
            if body_html:
                body_html = _strip_bento_sections(body_html)
            if not body_html:
                body_html = _extract_bento_body(html)
            if body_html:
                title = _bento_title_from_filename(filename)
                # FIX (v4.2.1): Long title flash — bento tool HTML pages
                # contain full SEO <h1> titles (e.g. "Compress PDF Free
                # Online - Reduce File Size Fast").  The i18n JS that
                # shortens them loads asynchronously after DOMContentLoaded,
                # causing a visible flash of the long title.  We replace
                # the <h1> content server-side with the short `bento_title`
                # we already derive from the filename, AND strip the
                # data-i18n attribute so the bento i18n JS does not
                # re-process the heading (which would cause a second flash
                # as it clears and re-sets the text content).
                def _replace_h1(m):
                    return m.group(1) + m.group(2) + m.group(3) + title + m.group(4)

                body_html = re.sub(
                    r"(<h1\b)([^>]*)\s*data-i18n=\"[^\"]*\"([^>]*>)[^<]*(</h1>)",
                    _replace_h1,
                    body_html,
                    count=1,
                    flags=re.IGNORECASE,
                )
                return render_template(
                    "bento_tool.html",
                    bento_title=title,
                    bento_head_tags=_extract_bento_head_tags(html),
                    bento_body=Markup(body_html),
                    bento_body_class=body_class,
                    bento_back_url=url_for("bento_tools", filename="tools.html"),
                )
    return send_from_directory(bento_root, filename)


# ════════════════════════════════════════════════════════════════════
# SETTINGS & ADMIN
# ════════════════════════════════════════════════════════════════════
#
# Admin-only settings page: SMTP configuration, user management
# (activate/deactivate, role changes), and Postfix auto-detection
# for Debian packaged installs.
# ════════════════════════════════════════════════════════════════════

# ---- Postfix auto-config (Debian packaging) ------------------------------
def load_installed_postfix_defaults() -> Dict[str, Any]:
    """Read /etc/case-organizer/postfix.json written by the .deb postinst script."""
    try:
        data = json.loads(POSTFIX_PREFILL_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    # Restore password from encrypted store — postfix.json no longer carries it
    pw = data.get("smtp_password", "")
    if not pw or pw == "<encrypted>":
        try:
            pw = settings_manager.get_secret("smtp_password", None) or ""
        except RuntimeError:
            pw = ""
        data["smtp_password"] = pw
    return data


def write_postfix_prefill_files(host: str, port: int | str, username: str, password: str, use_tls: bool, from_email: str) -> None:
    """Persist SMTP settings to the postfix prefill JSON for future installs."""
    # Password is stored ONLY in the encrypted secrets store — never in postfix.json
    if password:
        with suppress(RuntimeError):
            settings_manager.set_secret("smtp_password", password)

    payload = {
        "smtp_host": host,
        "smtp_port": str(port),
        "smtp_username": username,
        "smtp_password": "<encrypted>",
        "smtp_use_tls": use_tls,
        "smtp_from_email": from_email,
    }
    try:
        POSTFIX_PREFILL_FILE.parent.mkdir(parents=True, exist_ok=True)
        POSTFIX_PREFILL_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        POSTFIX_PREFILL_FILE.chmod(0o600)
    except Exception:
        pass

    script_path = POSTFIX_PREFILL_FILE.with_name("setup-postfix.sh")
    tls_value = "yes" if use_tls else "no"
    script = f"""#!/bin/sh
set -e
# SMTP password is stored encrypted. Retrieve it with:
#   python3 -c "from services.settings import settings_manager; print(settings_manager.get_secret('smtp_password'))"
# Then export it before running this script:
#   export SMTP_PASSWORD="your-password-here"
SMTP_PASSWORD="${{SMTP_PASSWORD:?Set SMTP_PASSWORD before running this script}}"

MAIN_CF=/etc/postfix/main.cf
SASL=/etc/postfix/sasl_passwd

cat <<EOF | sudo tee "$MAIN_CF" >/dev/null
relayhost = [{host}]:{port}
smtp_use_tls = {tls_value}
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
smtp_sasl_security_options = noanonymous
EOF

printf '[{host}]:{port} {username}:%s\\n' "$SMTP_PASSWORD" | sudo tee "$SASL" >/dev/null
sudo chmod 600 "$SASL"
if command -v postmap >/dev/null 2>&1; then
    sudo postmap "$SASL"
fi
if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable postfix.service || true
    sudo systemctl restart postfix.service || true
fi
echo "Postfix relay updated."
"""
    try:
        script_path.write_text(script, encoding="utf-8")
        script_path.chmod(0o700)
    except Exception:
        pass


# ---- GET|POST /settings — admin settings page (SMTP, users, etc.) --------
@app.route("/settings", methods=["GET", "POST"])
@require_admin
def admin_settings():
    global FS_ROOT

    if request.method == "POST":
        form_name = request.form.get("form_name") or ""

        if form_name == "fs_root":
            path_input = (request.form.get("fs_root") or "").strip()
            if not path_input:
                flash("Storage path is required.", "error")
            else:
                try:
                    new_path = Path(path_input).expanduser().resolve()
                    new_path.mkdir(parents=True, exist_ok=True)
                    config.save_fs_root(str(new_path))
                    FS_ROOT = new_path
                    flash("Storage location updated.", "success")
                except Exception as exc:
                    flash(f"Failed to update storage path: {exc}", "error")

        elif form_name == "smtp":
            host = (request.form.get("smtp_host") or "").strip()
            port_raw = request.form.get("smtp_port") or ""
            username = (request.form.get("smtp_username") or "").strip()
            password = request.form.get("smtp_password") or ""
            use_tls = request.form.get("smtp_use_tls") in {"1", "true", "on"}
            from_email = (request.form.get("smtp_from_email") or "").strip()

            errors = []
            if not host:
                errors.append("SMTP host is required.")
            try:
                port = int(port_raw) if port_raw else 0
                if port <= 0:
                    raise ValueError
            except ValueError:
                errors.append("SMTP port must be a positive number.")
                port = None
            if not from_email:
                errors.append("From-address is required.")

            if errors:
                for err in errors:
                    flash(err, "error")
            else:
                settings_manager.set("smtp_host", host)
                settings_manager.set("smtp_port", port)
                settings_manager.set("smtp_username", username)
                settings_manager.set("smtp_use_tls", use_tls)
                settings_manager.set("smtp_from_email", from_email)
                if password:
                    try:
                        settings_manager.set_secret("smtp_password", password)
                    except RuntimeError:
                        flash(
                            "Unable to encrypt SMTP password. Ensure the encryption key is available.",
                            "error",
                        )
                clear_email_cache()
                flash("SMTP configuration updated.", "success")

        elif form_name == "create_user":
            email = normalize_ws(request.form.get("user_email") or "")
            role = (request.form.get("user_role") or "user").lower()
            password = request.form.get("user_password") or ""

            if role not in {"admin", "user"}:
                flash("Invalid role specified.", "error")
            elif len(password) < 8:
                flash("User password must be at least 8 characters long.", "error")
            else:
                try:
                    create_user(email, password, role=role)
                    flash(f"User {email} created.", "success")
                except UserExistsError:
                    flash("A user with that email already exists.", "error")
                except Exception as exc:
                    flash(f"Failed to create user: {exc}", "error")

        elif form_name == "toggle_user":
            try:
                target_id = int(request.form.get("user_id", "0"))
            except ValueError:
                target_id = 0
            new_state = request.form.get("new_state") == "1"
            target_user = get_user_by_id(target_id)
            if not target_user:
                flash("User not found.", "error")
            elif target_user['id'] == g.current_user['id'] and not new_state:
                flash("You cannot deactivate your own account.", "error")
            elif target_user['role'] == 'admin' and not new_state and count_admins(active_only=True) <= 1:
                flash("At least one active administrator must remain.", "error")
            else:
                try:
                    set_user_active(target_id, new_state)
                    if not new_state:
                        invalidate_user_sessions(target_id)
                    flash("User status updated.", "success")
                except Exception as exc:
                    flash(f"Failed to update user status: {exc}", "error")

        elif form_name == "update_user":
            try:
                target_id = int(request.form.get("user_id", "0"))
            except ValueError:
                target_id = 0
            target_user = get_user_by_id(target_id)
            if not target_user:
                flash("User not found.", "error")
            else:
                new_email = normalize_ws(request.form.get("new_email") or "").lower()
                new_role = (request.form.get("new_role") or target_user['role']).lower()
                if new_role not in {"admin", "user"}:
                    flash("Invalid role selected.", "error")
                else:
                    changes_made = False
                    try:
                        if new_email and new_email != target_user['email']:
                            update_user_email(target_id, new_email)
                            changes_made = True
                        if new_role != target_user['role']:
                            if target_user['role'] == 'admin' and new_role != 'admin' and count_admins(active_only=True) <= 1:
                                flash("At least one administrator must remain.", "error")
                            else:
                                update_user_role(target_id, new_role)
                                changes_made = True
                        if changes_made:
                            flash("User details updated.", "success")
                        else:
                            flash("No changes detected.", "info")
                    except EmailInUseError:
                        flash("That email is already in use.", "error")
                    except Exception as exc:
                        flash(f"Failed to update user: {exc}", "error")

        elif form_name == "reset_password_user":
            try:
                target_id = int(request.form.get("user_id", "0"))
            except ValueError:
                target_id = 0
            target_user = get_user_by_id(target_id)
            if not target_user or not target_user['is_active']:
                flash("Only active users can receive reset emails.", "error")
            else:
                try:
                    token = create_password_reset_token(target_user['id'])
                    reset_link = url_for("reset_password", token=token, _external=True)
                    body = (
                        "Hello,\n\n"
                        "An administrator initiated a password reset for your Case Organizer account.\n"
                        f"Use the link below to set a new password: {reset_link}\n\n"
                        "If you were not expecting this, please contact the administrator immediately."
                    )
                    future = send_email_async(target_user['email'], "Case Organizer password reset", body)
                except EmailConfigError:
                    flash("SMTP settings are incomplete. Configure email before sending resets.", "error")
                except Exception as exc:
                    flash(f"Failed to queue reset email: {exc}", "error")
                else:
                    try:
                        future.result(timeout=1.0)
                    except FutureTimeout:
                        app.logger.info("Admin-triggered reset email queued for %s", target_user['email'])
                        flash("Password reset email queued.", "success")
                    except Exception as exc:
                        app.logger.exception("Failed to send reset email: %s", exc)
                        flash(f"Failed to send reset email: {exc}", "error")
                    else:
                        flash("Password reset email sent.", "success")

        else:
            flash("Unknown action submitted.", "error")

    fs_value = str(FS_ROOT) if FS_ROOT else (config.FS_ROOT or "")

    smtp_config = {
        "host": settings_manager.get("smtp_host", ""),
        "port": settings_manager.get("smtp_port", 587),
        "username": settings_manager.get("smtp_username", ""),
        "use_tls": bool(settings_manager.get("smtp_use_tls", True)),
        "from_email": settings_manager.get("smtp_from_email", ""),
    }

    try:
        smtp_password_configured = bool(settings_manager.get_secret("smtp_password"))
    except RuntimeError:
        smtp_password_configured = bool(settings_manager.get("smtp_password"))

    users = list_users()
    active_admins = [u for u in users if u['role'] == 'admin' and u['is_active']]
    last_active_admin_id = active_admins[0]['id'] if len(active_admins) == 1 else None

    try:
        return render_template(
            "settings.html",
            fs_root=fs_value,
            smtp=smtp_config,
            smtp_password_configured=smtp_password_configured,
            users=users,
            last_active_admin_id=last_active_admin_id,
        )
    except Exception:
        return render_template_string("""
            <!doctype html><title>Settings</title>
            <h1>Admin Settings (fallback)</h1>
            <p>Storage root: {{ fs_root }}</p>
            <p>SMTP host: {{ smtp.host }}</p>
        """, fs_root=fs_value, smtp=smtp_config)


# ════════════════════════════════════════════════════════════════════
# API UTILITIES
# ════════════════════════════════════════════════════════════════════
#
# Lightweight endpoints for health-checks, debugging, and session
# keep-alive.  /ping is unauthenticated; the rest require login.
# ════════════════════════════════════════════════════════════════════

# ---- GET /ping — unauthenticated health check ----------------------------
@app.get("/ping")
def ping():
    return "pong"

# ---- GET /__routes — admin-only route map dump ---------------------------
@app.get("/__routes")
@require_login
@require_admin
def __routes():
    lines = [
        f"{r.rule}  [{','.join(sorted(m for m in r.methods if m not in {'HEAD','OPTIONS'}))}]"
        for r in app.url_map.iter_rules()
    ]
    return "<pre>" + "\n".join(sorted(lines)) + "</pre>"


# ---- POST /api/session/keepalive — prevent idle session expiry -----------
@app.post("/api/session/keepalive")
@require_login_api
def api_session_keepalive():
    return jsonify({"ok": True})


# ════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ════════════════════════════════════════════════════════════════════
#
# Direct execution: `python3 app.py`
# - Debug mode (FLASK_DEBUG=1): uses Flask's dev server with hot-reload
# - Production mode: uses waitress WSGI server with 16 worker threads
# ════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    ensure_root()
    _host = os.environ.get("CASEORG_HOST", os.environ.get("FLASK_HOST", "0.0.0.0"))
    _port = int(os.environ.get("CASEORG_PORT", os.environ.get("FLASK_PORT", "5000")))
    _debug = os.environ.get("FLASK_DEBUG", "0") == "1"

    if _debug:
        log.debug("URL map:")
        for r in app.url_map.iter_rules():
            methods = ",".join(sorted(m for m in r.methods if m not in {"HEAD", "OPTIONS"}))
            log.debug("  %-22s [%s]", r.rule, methods)
        app.run(host=_host, port=_port, debug=True)
    else:
        from waitress import serve
        print(f"Case Organizer serving on http://{_host}:{_port}")
        serve(app, host=_host, port=_port, threads=16)

