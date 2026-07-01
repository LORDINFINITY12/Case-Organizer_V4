@echo off
setlocal enabledelayedexpansion

:: ================================================================
::  Case Organizer - one-click Docker setup for Windows
::
::  Double-click this file. It will:
::    1. use the release image tarball if one sits next to it
::       (case-organizer_*_docker.tar.gz), otherwise build from the
::       Dockerfile in this folder;
::    2. create a persistent data folder under your user profile;
::    3. start the container and open it in your browser.
:: ================================================================

set IMAGE_NAME=case-organizer:4.5.2
set CONTAINER_NAME=case-organizer
set HOST_PORT=5000
set DATA_DIR=%USERPROFILE%\CaseOrganizer

echo.
echo  ============================================
echo    Case Organizer - Docker Setup (v4.5.2)
echo  ============================================
echo.

:: ------- Docker installed? -------
docker --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Docker is not installed or not in PATH.
    echo  Install Docker Desktop: https://www.docker.com/products/docker-desktop
    echo.
    pause
    exit /b 1
)

:: ------- Docker daemon running? -------
docker info >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Docker Desktop is not running. Start it and try again.
    echo.
    pause
    exit /b 1
)
echo  [OK] Docker is available.

:: ------- Obtain the image: load a release tarball, else build -------
set TARBALL=
for %%F in ("%~dp0case-organizer_*_docker.tar.gz") do set TARBALL=%%F

if defined TARBALL (
    echo  [..] Loading image from %TARBALL% ...
    docker load -i "%TARBALL%"
    if errorlevel 1 (
        echo  [ERROR] Failed to load the image tarball.
        pause
        exit /b 1
    )
    echo  [OK] Image loaded.
) else (
    echo  [..] No image tarball found - building from the Dockerfile ...
    docker build -t %IMAGE_NAME% "%~dp0."
    if errorlevel 1 (
        echo  [ERROR] Build failed.
        pause
        exit /b 1
    )
    echo  [OK] Image built.
)

:: ------- Persistent data folders -------
if not exist "%DATA_DIR%\config" mkdir "%DATA_DIR%\config"
if not exist "%DATA_DIR%\files"  mkdir "%DATA_DIR%\files"
echo  [OK] Data folder: %DATA_DIR%

:: ------- Replace any existing container -------
for /f "tokens=*" %%i in ('docker ps -aq -f name^=%CONTAINER_NAME%') do (
    echo  [..] Removing existing container...
    docker stop %CONTAINER_NAME% >nul 2>&1
    docker rm %CONTAINER_NAME% >nul 2>&1
)

:: ------- Run -------
echo  [..] Starting Case Organizer...
docker run -d ^
    --name %CONTAINER_NAME% ^
    -p %HOST_PORT%:5000 ^
    -e CASEORG_COOKIE_SECURE=0 ^
    -v "%DATA_DIR%\config":/data/config ^
    -v "%DATA_DIR%\files":/data/files ^
    --restart unless-stopped ^
    %IMAGE_NAME%
if errorlevel 1 (
    echo  [ERROR] Failed to start the container.
    pause
    exit /b 1
)

echo.
echo  ============================================
echo    Case Organizer is running.
echo    Open:  http://localhost:%HOST_PORT%
echo.
echo    On first-run /setup, set the storage location to:
echo        /data/files
echo    (your files appear under %DATA_DIR%\files)
echo  ============================================
echo.
timeout /t 3 >nul
start "" http://localhost:%HOST_PORT%
pause
