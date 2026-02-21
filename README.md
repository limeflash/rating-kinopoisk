# KinoPoisk Rating Stremio Addon

Stremio addon that works like a rating-overlay addon, but focused on **KinoPoisk** ratings.

It works in detail-page mode:
- when opening a movie/series page, addon fetches KinoPoisk rating,
- renders a clean text block in the streams panel filter (like `IMDb Ratings`),
- does not alter catalog posters/cards by default.

## Features

- KinoPoisk rating shown on movie/series details page.
- Text output format:
  - `Kinopoisk рейтинг`
  - `⭐ Кинопоиск: 8.1/10`
  - `(45,123 голосов)`
- In-memory cache for rating lookups.
- Data source: official `kinopoiskapiunofficial.tech` OpenAPI endpoints:
  - `/api/v2.2/films?imdbId=<tt...>`
  - `/api/v2.2/films?keyword=<title>`
- Rate-limit aware behavior: endpoint limit is `5 req/sec` for `/api/v2.2/films`; addon throttles requests and enters cooldown on `HTTP 429`.

## Requirements

- Node.js 18+
- KinoPoisk Unofficial API key (`X-API-KEY`)

## Setup

```bash
npm install
cp .env.template .env
```

Edit `.env` and set your API key in `KINOPOISK_API_KEY`.

## Run

```bash
npm start
```

By default it runs on `http://localhost:3000`.

## Deploy On VPS (Traefik + Cloudflare)

This guide is for users who already run Traefik on their VPS and want to expose this addon on their own subdomain.

Example target URL in this guide:
- `https://addon.example.com`

### 1. Prepare server

```bash
sudo apt update
sudo apt install -y git curl docker.io
sudo systemctl enable --now docker
```

### 2. Clone project and install dependencies once

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone <your-repo-url> kinopoisk-rating-addon
cd /opt/kinopoisk-rating-addon
sudo npm ci --omit=dev
sudo cp deploy/env.production.example .env
```

Edit `/opt/kinopoisk-rating-addon/.env`:
- `KINOPOISK_API_KEY=...`
- `PUBLIC_URL=https://addon.example.com`

### 3. Find Traefik Docker network and certificate resolver

```bash
TRAEFIK_NET=$(docker inspect traefik --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | head -n1)
RESOLVER=$(docker inspect traefik --format '{{range .Config.Cmd}}{{println .}}{{end}}' | sed -nE 's/.*--certificatesresolvers\.([^.]+)\.acme.*/\1/p' | head -n1)
echo "TRAEFIK_NET=$TRAEFIK_NET"
echo "RESOLVER=$RESOLVER"
```

If either value is empty, inspect your Traefik setup and set them manually.

### 4. Run addon container behind Traefik

```bash
cd /opt/kinopoisk-rating-addon
TRAEFIK_NET=$(docker inspect traefik --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | head -n1)
RESOLVER=$(docker inspect traefik --format '{{range .Config.Cmd}}{{println .}}{{end}}' | sed -nE 's/.*--certificatesresolvers\.([^.]+)\.acme.*/\1/p' | head -n1)

docker rm -f kinopoisk-rating 2>/dev/null || true
docker run -d \
  --name kinopoisk-rating \
  --restart unless-stopped \
  --network "$TRAEFIK_NET" \
  --env-file /opt/kinopoisk-rating-addon/.env \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -v /opt/kinopoisk-rating-addon:/app \
  -w /app \
  -l traefik.enable=true \
  -l traefik.docker.network="$TRAEFIK_NET" \
  -l traefik.http.routers.kinopoiskrating.rule='Host(`addon.example.com`)' \
  -l traefik.http.routers.kinopoiskrating.entrypoints=websecure \
  -l traefik.http.routers.kinopoiskrating.tls=true \
  -l traefik.http.routers.kinopoiskrating.tls.certresolver="$RESOLVER" \
  -l traefik.http.services.kinopoiskrating.loadbalancer.server.port=3000 \
  node:20-alpine sh -lc 'npm ci --omit=dev && node src/index.js'
```

### 5. Add DNS record in Cloudflare

For your domain zone:
1. Add `A` record for your subdomain:
   - Name: `addon` (or any custom name)
   - IPv4: `<your VPS IP>`
   - Proxy status: `Proxied`
2. SSL/TLS mode in Cloudflare:
   - use `Full (strict)` when Traefik ACME/cert resolver is configured.

### 6. Verify deployment

```bash
curl -sS https://addon.example.com/health
curl -sS https://addon.example.com/manifest.json | head
docker logs -n 100 kinopoisk-rating
```

Use this URL in Stremio:
- `https://addon.example.com/manifest.json`

## Install In Stremio

1. Open Stremio.
2. Go to `Addons`.
3. Remove older version of this addon if installed.
4. Choose `Add Addon`.
5. Paste manifest URL:
   - `http://localhost:3000/manifest.json`
   - or your public URL if deployed remotely.
6. In movie/series page open streams list and select provider filter `Kinopoisk рейтинг` (or `All`).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind host |
| `PUBLIC_URL` | `http://localhost:<PORT>` | External URL used in poster links |
| `CINEMETA_BASE_URL` | `https://v3-cinemeta.strem.io` | Upstream metadata provider |
| `KINOPOISK_API_KEY` | empty | API key for `kinopoiskapiunofficial.tech` |
| `CACHE_TTL_MINUTES` | `720` | In-memory cache TTL |
| `FETCH_TIMEOUT_MS` | `10000` | HTTP timeout |
| `MAX_ENRICH_CONCURRENCY` | `2` | Reserved for compatibility |
| `MAX_ENRICH_ITEMS` | `12` | Reserved for compatibility |
| `SEARCH_FALLBACK_ENABLED` | `true` | If `false`, skip keyword fallback and use IMDb lookup only |
| `MAX_SEARCH_FALLBACK_ITEMS` | `3` | Max items per catalog request that can do keyword fallback |
| `RATE_LIMIT_COOLDOWN_SECONDS` | `300` | Cooldown duration after HTTP 429 (unless Retry-After is returned) |
| `KINOPOISK_MIN_INTERVAL_MS` | `250` | Minimum interval between KinoPoisk requests (throttle for 5 req/sec endpoint) |
| `POSTER_OVERLAY_ENABLED` | `false` | Reserved for compatibility |
| `TITLE_RATING_ENABLED` | `true` | Reserved for compatibility |
| `STREAM_FETCH_CINEMETA_META` | `false` | If `true`, stream handler additionally fetches Cinemeta meta (slower) |

## Notes

- Legacy alias `KINOPOISK_UNOFFICIAL_API_KEY` is still accepted by code for backward compatibility.
- Due to API/provider differences, exact field mapping may vary across titles.
- For remote usage (mobile/TV clients), set `PUBLIC_URL` to a reachable HTTPS endpoint.
- For Traefik deployment in Docker, use `.env` with `HOST=0.0.0.0` and `PORT=3000`.
- If your plan has strict limits, keep: `SEARCH_FALLBACK_ENABLED=false`, `MAX_ENRICH_ITEMS=8`, `MAX_ENRICH_CONCURRENCY=2`, `KINOPOISK_MIN_INTERVAL_MS=300`.
- On HTTP `402` (quota exceeded), addon pauses rating enrichment until restart or key change.
