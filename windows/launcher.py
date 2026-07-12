"""Case Organizer — Windows launcher.

Frozen by PyInstaller (windows/caseorg.spec) into CaseOrganizer.exe.
Three modes:

  (no args)    Tray mode: run Waitress in a background thread, show a
               pystray icon (Open / Open data folder / Quit), open the
               browser once the server answers /ping.  This process IS the
               server — quitting the tray stops Case Organizer.
  --headless   Service mode (run under WinSW): no tray, no browser; data
               under %ProgramData%\\CaseOrganizer; Waitress blocks on the
               main thread.  WinSW handles start/stop/restart.
  --open       Do not start anything.  Find a running instance via
               runtime.json + /ping, open the browser at it, exit.  Used by
               the service-mode Start Menu shortcut.

Environment is prepared BEFORE ``import app`` — app.py reads
XDG_CONFIG_HOME (settings dir), CASEORG_COOKIE_SECURE and
CASEORG_UPLOAD_TMP_DIR at import time.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

HEADLESS = "--headless" in sys.argv
OPEN_ONLY = "--open" in sys.argv

PORT_RANGE = range(5000, 5011)

# ---------------------------------------------------------------------------
# Paths: frozen (PyInstaller onedir) vs plain `python windows/launcher.py`
# ---------------------------------------------------------------------------
if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).parent           # ...\CaseOrganizer\
    INTERNAL = Path(getattr(sys, "_MEIPASS", APP_DIR / "_internal"))
else:  # running from a source checkout (dev only)
    APP_DIR = Path(__file__).resolve().parent.parent
    INTERNAL = APP_DIR
    sys.path.insert(0, str(APP_DIR))    # frozen builds have app in the PYZ

def _data_dir() -> Path:
    if HEADLESS:
        base = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
    else:
        base = os.environ.get("APPDATA", str(Path.home()))
    return Path(base) / "CaseOrganizer"

DATA_DIR = _data_dir()
RUNTIME_FILE = DATA_DIR / "runtime.json"


def _prepare_environment() -> None:
    """Set every env var app.py reads at import time.  Must run pre-import."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("XDG_CONFIG_HOME", str(DATA_DIR))
    os.environ["CASEORG_HOST"] = "127.0.0.1"          # localhost only
    os.environ.setdefault("CASEORG_COOKIE_SECURE", "0")  # plain-HTTP localhost
    if HEADLESS:
        os.environ["CASEORG_HEADLESS"] = "1"          # setup prefill hint

    # Bundled PDF tool binaries → PATH (tesseract, pdftoppm, qpdf, gswin64c)
    vendor = INTERNAL / "vendor"
    if vendor.is_dir():
        bins = [str(vendor / tool / "bin")
                for tool in ("tesseract", "poppler", "qpdf", "ghostscript")]
        os.environ["PATH"] = os.pathsep.join(bins + [os.environ.get("PATH", "")])
        tessdata = vendor / "tesseract" / "tessdata"
        if tessdata.is_dir():
            os.environ["TESSDATA_PREFIX"] = str(tessdata)

    # Flask resolves templates/static relative to the frozen app module.
    os.chdir(INTERNAL)


def _setup_logging() -> logging.Logger:
    log_dir = DATA_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_dir / "server.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    return logging.getLogger("launcher")


# ---------------------------------------------------------------------------
# Port / instance discovery
# ---------------------------------------------------------------------------
def _ping(port: int, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/ping", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _running_port() -> int | None:
    """Port of an already-running instance, per runtime.json + live /ping."""
    for base in ("APPDATA", "PROGRAMDATA"):
        root = os.environ.get(base)
        if not root:
            continue
        rt = Path(root) / "CaseOrganizer" / "runtime.json"
        try:
            port = int(json.loads(rt.read_text(encoding="utf-8"))["port"])
        except Exception:
            continue
        if _ping(port):
            return port
    return None


def _pick_port() -> int:
    for port in PORT_RANGE:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise SystemExit(
        f"No free port in {PORT_RANGE.start}-{PORT_RANGE.stop - 1}; "
        "close the application using them and relaunch.")


def _write_runtime(port: int) -> None:
    RUNTIME_FILE.write_text(
        json.dumps({"port": port, "pid": os.getpid()}), encoding="utf-8")


def _open_browser(port: int) -> None:
    webbrowser.open(f"http://127.0.0.1:{port}/")


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
def _mode_open() -> None:
    port = _running_port()
    if port:
        _open_browser(port)
        return
    # --open shortcuts are only installed in service mode; starting a tray
    # server here would split data between %APPDATA% and %ProgramData%.
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            None,
            "Case Organizer is not running.\n\n"
            "Start the 'Case Organizer' Windows service (services.msc) "
            "or reinstall the application.",
            "Case Organizer", 0x30)  # MB_ICONWARNING
    except Exception:
        print("Case Organizer is not running.", file=sys.stderr)


def _start_server(log: logging.Logger, port: int) -> None:
    """Import app (env must be final!) and start serving. Mirrors app.__main__."""
    os.environ["CASEORG_PORT"] = str(port)
    import app as caseorg  # noqa: PLC0415 — deliberate late import

    caseorg.ensure_root()
    caseorg._init_case_law_db()

    from services.scheduler import start_digest_scheduler
    start_digest_scheduler()

    from waitress import serve

    def _serve() -> None:
        serve(caseorg.app, host="127.0.0.1", port=port, threads=16)

    if HEADLESS:
        _write_runtime(port)
        log.info("Case Organizer (service) on http://127.0.0.1:%s", port)
        _serve()                      # blocks; WinSW owns the lifecycle
        raise SystemExit(0)

    threading.Thread(target=_serve, daemon=True, name="waitress").start()
    _write_runtime(port)
    log.info("Case Organizer (tray) on http://127.0.0.1:%s", port)


def _wait_ready(port: int, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _ping(port):
            return True
        time.sleep(0.25)
    return False


def _mode_tray() -> None:
    log = _setup_logging()

    existing = _running_port()
    if existing:
        log.info("Instance already running on port %s — opening browser.", existing)
        _open_browser(existing)
        return

    port = _pick_port()
    _start_server(log, port)

    if _wait_ready(port):
        _open_browser(port)
    else:
        log.error("Server did not answer /ping within 15s")

    # ---- tray icon (main thread — Windows message loop) ----
    try:
        import pystray
        from PIL import Image
    except ImportError:
        log.warning("pystray/Pillow unavailable — running headless-style loop.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return

    icon_path = INTERNAL / "static" / "img" / "Case_Organizer_logo.png"
    image = Image.open(icon_path)

    def on_open(icon, item) -> None:  # noqa: ARG001
        _open_browser(port)

    def on_data_dir(icon, item) -> None:  # noqa: ARG001
        if hasattr(os, "startfile"):
            os.startfile(DATA_DIR)  # noqa: S606

    def on_quit(icon, item) -> None:  # noqa: ARG001
        log.info("Quit from tray.")
        icon.stop()

    tray = pystray.Icon(
        "case-organizer", image, "Case Organizer",
        menu=pystray.Menu(
            pystray.MenuItem("Open Case Organizer", on_open, default=True),
            pystray.MenuItem("Open data folder", on_data_dir),
            pystray.MenuItem("Quit", on_quit),
        ),
    )
    tray.run()
    # Tray closed → stop the whole process (waitress thread is daemonic).
    os._exit(0)


def _mode_headless() -> None:
    log = _setup_logging()
    port = _pick_port()
    _start_server(log, port)   # blocks


def main() -> None:
    _prepare_environment()
    if OPEN_ONLY:
        _mode_open()
    elif HEADLESS:
        _mode_headless()
    else:
        _mode_tray()


if __name__ == "__main__":
    main()
