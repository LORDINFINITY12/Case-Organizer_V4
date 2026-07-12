# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Case Organizer Windows build.

Run from the repository root:  pyinstaller --noconfirm windows/caseorg.spec

Produces an onedir bundle at dist/CaseOrganizer/:
  CaseOrganizer.exe        windowed tray launcher (also --headless / --open)
  _internal/               frozen python + templates/ + static/ + vendor/

Onedir (not onefile) deliberately: faster start, no self-extraction temp
dir, and far fewer antivirus false positives.  UPX stays off for the same
reason.  Flask(app.py's `Flask(__name__)`) resolves its root path to
_internal/, which is exactly where the templates/ and static/ datas land —
no app.py changes needed.
"""

from pathlib import Path

REPO = Path.cwd()  # invoked from the repo root

datas = [
    (str(REPO / "templates"), "templates"),
    (str(REPO / "static"), "static"),
    (str(REPO / "windows" / "vendor"), "vendor"),
    (str(REPO / "LICENSE.txt"), "."),
]

a = Analysis(
    [str(REPO / "windows" / "launcher.py")],
    pathex=[str(REPO)],                 # lets `import app` / `services.*` freeze
    binaries=[],
    datas=datas,
    hiddenimports=[
        "waitress",
        "pystray._win32",
        "PIL.Image",
        "services.scheduler",           # imported lazily by the launcher
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tests", "pytest", "tkinter"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="CaseOrganizer",
    icon=str(REPO / "windows" / "caseorg.ico"),
    console=False,                      # windowed: no flashing cmd box
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="CaseOrganizer",
    upx=False,
)
