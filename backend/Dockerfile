FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN --mount=type=secret,id=build_ca if [ -f /run/secrets/build_ca ]; then cp /run/secrets/build_ca /etc/ssl/certs/ca-certificates.crt; fi; sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements*.txt ./
RUN --mount=type=secret,id=build_ca if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; pip install --no-cache-dir -r requirements.txt
COPY backend/osc ./osc
