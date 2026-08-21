# Glove tool sidecars (webtools / filetools).
#
# One image serves both roles; the ROLE env var (set in docker-compose.yml)
# selects which service runs and the default port (8377 / 8378).
FROM python:3.12-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Headless Chromium for the JS-heavy-page fallback (installs its own system deps).
RUN python -m playwright install --with-deps chromium

COPY server ./server

RUN useradd --create-home glove \
    && mkdir -p /workspace \
    && chown -R glove:glove /workspace /app

USER glove

EXPOSE 8377 8378
CMD ["python", "-m", "server.app"]
