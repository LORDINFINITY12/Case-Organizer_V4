# Case Organizer — Windows installer build script.
#
# Run from anywhere; operates on the repository containing this script.
# Used identically by maintainers (local Windows PC) and CI (windows-latest).
#
# Prerequisites: Python 3.12+, Inno Setup 6 (iscc on PATH or default install
# dir), 7-Zip (7z on PATH or default install dir), git.
#
# Steps:
#   1. Version <- top line of debian/changelog        (single source of truth)
#   2. Fetch + SHA256-verify + extract vendor tools   (cached in windows/.cache)
#   3. venv + pip install runtime & build deps
#   4. Generate windows/caseorg.ico from the app logo
#   5. PyInstaller onedir bundle (windows/caseorg.spec)
#   6. Inno Setup -> dist/CaseOrganizer-Setup-<ver>.exe

$ErrorActionPreference = "Stop"
$Repo   = Split-Path -Parent $PSScriptRoot
$Win    = $PSScriptRoot
$Cache  = Join-Path $Win ".cache"
$Vendor = Join-Path $Win "vendor"
New-Item -ItemType Directory -Force -Path $Cache | Out-Null

# ---------------------------------------------------------------------------
# 1. Version from debian/changelog:  case-organizer (4.7) stable; ...
# ---------------------------------------------------------------------------
$firstLine = Get-Content (Join-Path $Repo "debian/changelog") -First 1
if ($firstLine -notmatch 'case-organizer \(([^)]+)\)') {
    throw "Cannot parse version from debian/changelog: $firstLine"
}
$Version = $Matches[1]
Write-Host "== Case Organizer $Version (Windows build) ==" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 2. Vendor binaries (pinned URL + SHA256; extraction scriptblocks copy only
#    the runtime subset).  Bump pins deliberately and re-fill the hashes.
# ---------------------------------------------------------------------------
function Find-7z {
    foreach ($c in @("7z", "$env:ProgramFiles\7-Zip\7z.exe")) {
        if (Get-Command $c -ErrorAction SilentlyContinue) { return $c }
    }
    throw "7-Zip not found (needed to extract Tesseract/Ghostscript installers)"
}
$SevenZip = Find-7z

$VendorSpecs = @(
    @{
        Name    = "tesseract"
        Url     = "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe"
        Sha256  = "C885FFF6998E0608BA4BB8AB51436E1C6775C2BAFC2559A19B423E18678B60C9"
        Extract = {
            param($archive, $dest)
            $tmp = Join-Path $dest "_x"
            & $SevenZip x $archive "-o$tmp" -y | Out-Null
            New-Item -ItemType Directory -Force -Path "$dest\bin", "$dest\tessdata" | Out-Null
            Copy-Item "$tmp\tesseract.exe" "$dest\bin\"
            Copy-Item "$tmp\*.dll" "$dest\bin\" -ErrorAction SilentlyContinue
            foreach ($td in @("eng.traineddata", "osd.traineddata")) {
                Copy-Item "$tmp\tessdata\$td" "$dest\tessdata\" -ErrorAction SilentlyContinue
            }
            Remove-Item $tmp -Recurse -Force
        }
    },
    @{
        Name    = "poppler"
        Url     = "https://github.com/oschwartz10612/poppler-windows/releases/download/v24.08.0-0/Release-24.08.0-0.zip"
        Sha256  = "58A6F9AE269756231D2F9AA6CBA39D75FEC6DEACAF3C4A50683383B5F3D5A527"
        Extract = {
            param($archive, $dest)
            $tmp = Join-Path $dest "_x"
            Expand-Archive $archive -DestinationPath $tmp -Force
            New-Item -ItemType Directory -Force -Path "$dest\bin" | Out-Null
            $bin = Get-ChildItem $tmp -Recurse -Filter "pdftoppm.exe" | Select-Object -First 1
            Copy-Item "$($bin.DirectoryName)\pdftoppm.exe" "$dest\bin\"
            Copy-Item "$($bin.DirectoryName)\*.dll" "$dest\bin\"
            Remove-Item $tmp -Recurse -Force
        }
    },
    @{
        Name    = "qpdf"
        Url     = "https://github.com/qpdf/qpdf/releases/download/v11.9.1/qpdf-11.9.1-msvc64.zip"
        Sha256  = "B5061E09AA45B63A36200C130B4CCE15DC322338EA91F698760C3B8732FC41EF"
        Extract = {
            param($archive, $dest)
            $tmp = Join-Path $dest "_x"
            Expand-Archive $archive -DestinationPath $tmp -Force
            New-Item -ItemType Directory -Force -Path "$dest\bin" | Out-Null
            $bin = Get-ChildItem $tmp -Recurse -Filter "qpdf.exe" | Select-Object -First 1
            Copy-Item "$($bin.DirectoryName)\*" "$dest\bin\" -Recurse
            Remove-Item $tmp -Recurse -Force
        }
    },
    @{
        Name    = "ghostscript"
        Url     = "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10051/gs10051w64.exe"
        Sha256  = "A0E49D912D21D8193FF0CB89EF741A47B21286FBB0A0E35DD0192B0097D35766"
        Extract = {
            param($archive, $dest)
            $tmp = Join-Path $dest "_x"
            & $SevenZip x $archive "-o$tmp" -y | Out-Null
            New-Item -ItemType Directory -Force -Path "$dest\bin" | Out-Null
            Copy-Item "$tmp\bin\gswin64c.exe" "$dest\bin\"
            Copy-Item "$tmp\bin\gsdll64.dll" "$dest\bin\"
            # Official builds embed Resource/ in the DLL; keep lib/ for the
            # PDF-write configuration files some devices consult.
            if (Test-Path "$tmp\lib") { Copy-Item "$tmp\lib" "$dest\lib" -Recurse }
            Remove-Item $tmp -Recurse -Force
        }
    },
    @{
        Name    = "winsw"
        Url     = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
        Sha256  = "05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA"
        Extract = {
            param($archive, $dest)
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
            # WinSW pairs with the XML sharing its basename.
            Copy-Item $archive "$dest\CaseOrganizerService.exe"
        }
    }
)

foreach ($spec in $VendorSpecs) {
    $dest  = Join-Path $Vendor $spec.Name
    $stamp = Join-Path $dest ".sha256"
    if ((Test-Path $stamp) -and ((Get-Content $stamp) -eq $spec.Sha256)) {
        Write-Host "vendor/$($spec.Name): up to date"
        continue
    }
    $file = Join-Path $Cache ($spec.Sha256.Substring(0, 12) + "-" + (Split-Path $spec.Url -Leaf))
    if (-not (Test-Path $file)) {
        Write-Host "vendor/$($spec.Name): downloading $($spec.Url)"
        Invoke-WebRequest -Uri $spec.Url -OutFile $file -UseBasicParsing
    }
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash
    if ($actual -ne $spec.Sha256) {
        Remove-Item $file
        throw "SHA256 mismatch for $($spec.Name): expected $($spec.Sha256), got $actual. Verify the pin in build.ps1."
    }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    & $spec.Extract $file $dest
    Set-Content -Path $stamp -Value $spec.Sha256
    Write-Host "vendor/$($spec.Name): extracted"
}

# ---------------------------------------------------------------------------
# 3. Python env
# ---------------------------------------------------------------------------
$Venv = Join-Path $Repo ".venv-build"
if (-not (Test-Path $Venv)) { python -m venv $Venv }
$Py = Join-Path $Venv "Scripts\python.exe"
& $Py -m pip install --quiet --upgrade pip
& $Py -m pip install --quiet -r (Join-Path $Repo "requirements.txt") `
                              -r (Join-Path $Win "requirements-build.txt")

# ---------------------------------------------------------------------------
# 4. Icon from the app logo (16..256 px)
# ---------------------------------------------------------------------------
& $Py -c @"
from PIL import Image
img = Image.open(r'$Repo\static\img\Case_Organizer_logo.png').convert('RGBA')
img.save(r'$Win\caseorg.ico',
         sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('caseorg.ico written')
"@

# ---------------------------------------------------------------------------
# 5. PyInstaller (run from repo root so `import app` resolves)
# ---------------------------------------------------------------------------
Push-Location $Repo
try {
    & $Py -m PyInstaller --noconfirm (Join-Path $Win "caseorg.spec")
} finally { Pop-Location }

# ---------------------------------------------------------------------------
# 6. Inno Setup
# ---------------------------------------------------------------------------
function Find-Iscc {
    foreach ($c in @("iscc",
                     "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
                     "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
        if (Get-Command $c -ErrorAction SilentlyContinue) { return $c }
    }
    throw "Inno Setup 6 (ISCC.exe) not found"
}
$Iscc = Find-Iscc
& $Iscc "/DAppVersion=$Version" (Join-Path $Win "installer.iss")

$Setup = Join-Path $Repo "dist\CaseOrganizer-Setup-$Version.exe"
if (-not (Test-Path $Setup)) { throw "Installer not produced: $Setup" }
Write-Host "`n== Built $Setup ==" -ForegroundColor Green
Write-Host ("SHA256: " + (Get-FileHash $Setup -Algorithm SHA256).Hash)
