# Case Organizer — container image
# Build (from this directory):  docker build -t case-organizer:4.5.2 .
# Run:                          docker compose up -d   (see docker-compose.yml)
FROM python:3.12-slim

LABEL maintainer="Izumi <swarajswarupaggarwal@gmail.com>"
LABEL org.opencontainers.image.title="Case Organizer"
LABEL org.opencontainers.image.description="Self-hosted legal case-management platform (Flask)."
LABEL org.opencontainers.image.version="4.5.2"
LABEL org.opencontainers.image.source="https://github.com/LORDINFINITY12/Case-Organizer_V4"

# Runtime system dependencies:
#   poppler-utils              — render PDF letterheads to thumbnails / measure margins
#   fontconfig + fonts-liberation — fc-match resolves "Times New Roman" to the
#                                metric-compatible Liberation Serif so certificate,
#                                letterhead and legal-notice PDFs render cleanly
#   curl                       — container HEALTHCHECK
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        poppler-utils \
        fontconfig \
        fonts-liberation \
        curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code (see .dockerignore for what's excluded).
COPY . .

# Config (settings.json, secrets.enc, master.key, organizer.db) lives on a volume.
ENV XDG_CONFIG_HOME=/data/config
ENV CASEORG_HOST=0.0.0.0
ENV CASEORG_PORT=5000
# Containers are reached over plain http://localhost — session cookies must NOT be
# Secure-only, otherwise the browser won't send them and login cannot work. Put a
# TLS-terminating reverse proxy in front and set this to 1 for HTTPS deployments.
ENV CASEORG_COOKIE_SECURE=0

EXPOSE 5000

# Persistent storage: app config + case files. Point FS_ROOT at /data/files on
# first-run /setup so all case data lands on the mounted volume.
VOLUME ["/data/config", "/data/files"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:5000/login >/dev/null || exit 1

CMD ["python", "app.py"]
