#!/usr/bin/env bash
# Case Organizer - one-command Docker setup for Linux / macOS.
#
#   ./docker-setup.sh
#
# Loads the release image tarball if one sits next to this script
# (case-organizer_*_docker.tar.gz); otherwise builds from the Dockerfile.
# Then starts the container with persistent storage under ~/CaseOrganizer.
set -euo pipefail

IMAGE_NAME="case-organizer:4.5.2"
CONTAINER_NAME="case-organizer"
HOST_PORT="${HOST_PORT:-5000}"
DATA_DIR="${DATA_DIR:-$HOME/CaseOrganizer}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v docker >/dev/null 2>&1 || { echo "[ERROR] Docker is not installed."; exit 1; }
docker info >/dev/null 2>&1 || { echo "[ERROR] Docker daemon is not running."; exit 1; }
echo "[OK] Docker is available."

tarball="$(ls "$HERE"/case-organizer_*_docker.tar.gz 2>/dev/null | head -n1 || true)"
if [[ -n "$tarball" ]]; then
    echo "[..] Loading image from $tarball ..."
    docker load -i "$tarball"
else
    echo "[..] No image tarball found - building from the Dockerfile ..."
    docker build -t "$IMAGE_NAME" "$HERE"
fi

mkdir -p "$DATA_DIR/config" "$DATA_DIR/files"
echo "[OK] Data folder: $DATA_DIR"

if docker ps -aq -f "name=^${CONTAINER_NAME}$" | grep -q .; then
    echo "[..] Removing existing container..."
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

echo "[..] Starting Case Organizer..."
docker run -d \
    --name "$CONTAINER_NAME" \
    -p "${HOST_PORT}:5000" \
    -e CASEORG_COOKIE_SECURE=0 \
    -v "$DATA_DIR/config:/data/config" \
    -v "$DATA_DIR/files:/data/files" \
    --restart unless-stopped \
    "$IMAGE_NAME"

echo
echo "Case Organizer is running:  http://localhost:${HOST_PORT}"
echo "On first-run /setup, set the storage location to:  /data/files"
