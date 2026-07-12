# Building the Windows installer

Everything below is automated by `windows/build.ps1`; CI
(`.github/workflows/windows-installer.yml`) runs the exact same script on
`windows-latest` whenever a release is published, and uploads the resulting
`CaseOrganizer-Setup-<version>.exe` to that release.

## Local build (maintainer PC)

Prerequisites — install once:

| Tool | Notes |
|---|---|
| Windows 10/11 x64 | |
| Python 3.12+ | `python` on PATH |
| [Inno Setup 6](https://jrsoftware.org/isinfo.php) | `ISCC.exe` auto-detected in the default install dir |
| [7-Zip](https://www.7-zip.org/) | extracts the Tesseract/Ghostscript installers |
| git | |

Build:

```powershell
git clone git@github.com:LORDINFINITY12/Case-Organizer_V4.git
cd Case-Organizer_V4
pwsh windows/build.ps1
```

Output: `dist/CaseOrganizer-Setup-<version>.exe` (version parsed from the top
line of `debian/changelog`). The script prints the installer's SHA256.

What it does:

1. Downloads the pinned vendor binaries into `windows/.cache/` (kept between
   builds) and verifies each SHA256, then extracts the runtime subset into
   `windows/vendor/`:
   Tesseract OCR (+ `eng`/`osd` traineddata), Poppler (`pdftoppm`), qpdf,
   Ghostscript (`gswin64c`), and WinSW (service wrapper).
2. Creates `.venv-build`, installs `requirements.txt` +
   `windows/requirements-build.txt` (PyInstaller, pystray, Pillow).
3. Generates `windows/caseorg.ico` from `static/img/Case_Organizer_logo.png`.
4. PyInstaller onedir bundle (`windows/caseorg.spec`) →
   `dist/CaseOrganizer/` with `CaseOrganizer.exe` and `_internal/`.
5. Inno Setup (`windows/installer.iss`) → the final setup exe.

## Bumping a vendor pin

Edit the matching `$VendorSpecs` entry in `build.ps1`: change `Url`, set
`Sha256` to the new file's hash (`Get-FileHash <file> -Algorithm SHA256`),
delete `windows/vendor/<tool>/`, rebuild. If the archive layout changed,
adjust the `Extract` scriptblock too.

More OCR languages: drop extra `<lang>.traineddata` files (from
[tessdata](https://github.com/tesseract-ocr/tessdata)) into
`windows/vendor/tesseract/tessdata/` before building — or end users can add
them under `_internal\vendor\tesseract\tessdata\` of an existing install.

## Install modes (what the installer offers)

* **Userspace (default)** — the Windows privilege dialog's *"only for me"*:
  no admin, installs under `%LocalAppData%\Programs\CaseOrganizer`, tray app
  (`CaseOrganizer.exe`), optional Start-with-Windows shortcut. Data:
  `%APPDATA%\CaseOrganizer` + the storage folder chosen in setup.
* **Service** — choose *"for all users"* and tick *Install as a Windows
  service*: registers the `CaseOrganizer` service (WinSW wrapper,
  auto-restart on failure, runs before login). Data:
  `%ProgramData%\CaseOrganizer`. Shortcuts run `CaseOrganizer.exe --open`,
  which just opens the browser at the running server.

Uninstalling never deletes data directories or case files.

## Known caveats

* The exe is unsigned — SmartScreen shows "unknown publisher" on first run
  (*More info → Run anyway*). An Authenticode certificate would remove this;
  revisit if distribution widens.
* Antivirus heuristics occasionally flag PyInstaller apps. The build already
  uses the low-risk options (onedir, no UPX). If a specific AV flags a
  build, submit it as a false positive to the vendor.
* In service mode the app runs as LocalSystem — pick a storage folder the
  service can write (the setup default under `%ProgramData%` is safe), not a
  network drive mapped for one user.
