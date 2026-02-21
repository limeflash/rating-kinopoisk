# KinoPoisk Rating Addon for Stremio

[Русская версия](README.md)

![KinoPoisk Rating Addon preview](docs/images/screen.png)

A Stremio addon that shows KinoPoisk ratings on movie and series title pages.

The addon works in title-page mode:
- when you open a movie/series, it requests data from the KinoPoisk API,
- displays a block in the stream providers list (as a separate source),
- opens the KinoPoisk title page on click.

## Features

- Shows KinoPoisk ratings on movie/series pages.
- Output format:
  - `Kinopoisk rating`
  - `⭐ KinoPoisk: 8.1/10`
  - `(45,123 votes)`
- In-memory response caching.
- Data source:
  - [KinoPoisk Unofficial API](https://kinopoiskapiunofficial.tech/)
  - [API Documentation](https://kinopoiskapiunofficial.tech/documentation/api/)
- Used endpoints:
  - `/api/v2.2/films?imdbId=<tt...>`
  - `/api/v2.2/films?keyword=<title>`
- API limit handling: request throttling and cooldown after `HTTP 429` for `/api/v2.2/films`.
- Built-in config page: `/configure` (generates a personalized manifest URL with display options and optional API key).

## Requirements

- Node.js 18+
- KinoPoisk Unofficial API key (`X-API-KEY`)
- Current source for API key and API docs: [kinopoiskapiunofficial.tech](https://kinopoiskapiunofficial.tech/)

## Quick Start

```bash
npm install
cp .env.template .env
```

Open `.env` and set `KINOPOISK_API_KEY`.

## Local Run

```bash
npm start
```

By default, the addon is available at `http://localhost:3000`.

Configuration page:
- `http://localhost:3000/configure`

What you can configure on `/configure`:
- KinoPoisk API key directly in the manifest URL (personalized install),
- stream name,
- rating format (`8.1/10` or `8.1`),
- votes format (`45,123` or `45.1K`),
- show/hide votes,
- multi-line/single-line output format,
- show ratings only for movies or only for series,
- live preview of how the block will look in Stremio.

Important:
- if you set an API key on `/configure`, it is included in the encoded manifest URL;
- avoid sharing that URL publicly.

## Deploy on VPS (Traefik + Cloudflare)

This section is for setups where Traefik already runs on your VPS and you want to host the addon on your subdomain.

Example domain used in this guide:
- `https://addon.example.com`

### 1. Server Preparation

```bash
sudo apt update
sudo apt install -y git curl docker.io
sudo systemctl enable --now docker
```

### 2. Clone Project and Install Dependencies

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

### 3. Detect Traefik Docker Network and cert resolver

```bash
TRAEFIK_NET=$(docker inspect traefik --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | head -n1)
RESOLVER=$(docker inspect traefik --format '{{range .Config.Cmd}}{{println .}}{{end}}' | sed -nE 's/.*--certificatesresolvers\.([^.]+)\.acme.*/\1/p' | head -n1)
echo "TRAEFIK_NET=$TRAEFIK_NET"
echo "RESOLVER=$RESOLVER"
```

If one of these values is empty, set your network/resolver manually from your Traefik config.

### 4. Run Addon Container Behind Traefik

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

### 5. Cloudflare DNS Record

In your Cloudflare zone:
1. Add an `A` record for your subdomain:
   - Name: `addon` (or any other name)
   - IPv4: `<your VPS IP>`
   - Proxy status: `Proxied`
2. SSL/TLS mode:
   - `Full (strict)` (if ACME/cert resolver is configured in Traefik).

### 6. Verification

```bash
curl -sS https://addon.example.com/health
curl -sS https://addon.example.com/manifest.json | head
docker logs -n 100 kinopoisk-rating
```

Stremio install URL:
- `https://addon.example.com/manifest.json`

## VPS Deploy without Traefik (simple: systemd + Nginx + Cloudflare)

If you do not use Traefik, this is the simplest setup:
- run Node.js as a systemd service,
- let Nginx proxy requests to the local addon port,
- use Cloudflare for public HTTPS.

Example domain:
- `https://addon.example.com`

### 1. Server Preparation

```bash
sudo apt update
sudo apt install -y git curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Clone Project and Configure `.env`

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone <your-repo-url> kinopoisk-rating-addon
cd /opt/kinopoisk-rating-addon
sudo npm ci --omit=dev
sudo cp deploy/env.production.example .env
```

Edit `/opt/kinopoisk-rating-addon/.env` and set:
- `KINOPOISK_API_KEY=...`
- `PUBLIC_URL=https://addon.example.com`
- `HOST=127.0.0.1`
- `PORT=38117` (or any free port)

### 3. Run with systemd

```bash
cd /opt/kinopoisk-rating-addon
sudo chown -R www-data:www-data /opt/kinopoisk-rating-addon
sudo cp deploy/systemd/kinopoisk-rating.service /etc/systemd/system/kinopoisk-rating.service
sudo systemctl daemon-reload
sudo systemctl enable --now kinopoisk-rating
sudo systemctl status kinopoisk-rating --no-pager
```

### 4. Nginx reverse proxy

```bash
sudo tee /etc/nginx/sites-available/kinopoisk-rating.conf > /dev/null <<'EOF2'
server {
    listen 80;
    listen [::]:80;
    server_name addon.example.com;

    location / {
        proxy_pass http://127.0.0.1:38117;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF2

sudo ln -sf /etc/nginx/sites-available/kinopoisk-rating.conf /etc/nginx/sites-enabled/kinopoisk-rating.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

A ready-to-use config example is also included in the repo:
- `deploy/nginx/addon.example.com.conf`

If you use a different `PORT` in `.env`, update it in `proxy_pass` too.

### 5. Cloudflare DNS

For your Cloudflare zone:
1. Create an `A` record:
   - Name: `addon` (or any subdomain name)
   - IPv4: `<your VPS IP>`
   - Proxy status: `Proxied`
2. For quick start, set SSL/TLS mode to `Flexible`.

### 6. Verification

```bash
curl -sS http://127.0.0.1:38117/health
curl -sS https://addon.example.com/health
curl -sS https://addon.example.com/manifest.json | head
```

If something does not work:
```bash
sudo systemctl status kinopoisk-rating --no-pager
sudo journalctl -u kinopoisk-rating -n 100 --no-pager
sudo nginx -t
```

## One-Command Update

The project includes a universal update script:
- `/opt/kinopoisk-rating-addon/scripts/update.sh`

What the script does:
- pulls latest git changes (`git pull --ff-only`),
- if Docker container `kinopoisk-rating` exists -> restarts container,
- if systemd service `kinopoisk-rating` exists -> installs deps and restarts service.

One-time setup on VPS:
```bash
cd /opt/kinopoisk-rating-addon
chmod +x scripts/update.sh
```

Update to latest `main`:
```bash
sudo /opt/kinopoisk-rating-addon/scripts/update.sh
```

Update to a specific branch (for example test branch):
```bash
sudo /opt/kinopoisk-rating-addon/scripts/update.sh codex/test
```

Run from your local machine via SSH in one command:
```bash
ssh root@YOUR_VPS_IP "sudo /opt/kinopoisk-rating-addon/scripts/update.sh"
```

## Install in Stremio

1. Open Stremio.
2. Go to `Addons`.
3. Remove old addon version (if installed).
4. Click `Add Addon`.
5. Paste the manifest URL:
   - `http://localhost:3000/manifest.json` for local run,
   - or your public URL after deploy.
   - for custom settings, open `/configure`, set options, and copy generated URL.
6. On the movie/series page, choose provider filter `Kinopoisk rating` (or `All`).

Addon updates in Stremio:
- if manifest URL stays the same, reinstall is usually not required;
- after deploy, Stremio generally pulls updates automatically;
- if update is not visible immediately, refresh/restart Stremio client;
- keep the exact same URL (especially for custom `/configure` URLs).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Addon HTTP server port |
| `HOST` | `0.0.0.0` | Bind host |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public addon URL (used in links) |
| `CINEMETA_BASE_URL` | `https://v3-cinemeta.strem.io` | Upstream metadata provider |
| `KINOPOISK_API_KEY` | empty | API key for `kinopoiskapiunofficial.tech` |
| `CACHE_TTL_MINUTES` | `720` | In-memory cache TTL |
| `FETCH_TIMEOUT_MS` | `10000` | HTTP request timeout |
| `MAX_ENRICH_CONCURRENCY` | `2` | Compatibility tuning option |
| `MAX_ENRICH_ITEMS` | `12` | Compatibility tuning option |
| `SEARCH_FALLBACK_ENABLED` | `true` | If `false`, disables title search fallback |
| `MAX_SEARCH_FALLBACK_ITEMS` | `3` | Max extra items checked via fallback |
| `RATE_LIMIT_COOLDOWN_SECONDS` | `300` | Cooldown after `HTTP 429` (if API does not provide Retry-After) |
| `KINOPOISK_MIN_INTERVAL_MS` | `250` | Minimum interval between KinoPoisk requests |
| `POSTER_OVERLAY_ENABLED` | `false` | Compatibility tuning option |
| `TITLE_RATING_ENABLED` | `true` | Compatibility tuning option |
| `STREAM_FETCH_CINEMETA_META` | `false` | If `true`, stream handler additionally fetches Cinemeta meta |
| `DEFAULT_STREAM_NAME` | `Kinopoisk рейтинг` | Default stream name on `/configure` |
| `DEFAULT_RATING_FORMAT` | `withMax` | Default rating format: `withMax` or `plain` |
| `DEFAULT_VOTES_FORMAT` | `commas` | Default votes format: `commas` or `compact` |
| `DEFAULT_DISPLAY_FORMAT` | `multiLine` | Default line format: `multiLine` or `singleLine` |
| `DEFAULT_SHOW_VOTES` | `true` | Show vote count by default |
| `DEFAULT_SHOW_MOVIES` | `true` | Show ratings for movies by default |
| `DEFAULT_SHOW_SERIES` | `true` | Show ratings for series by default |

## Notes

- Alias `KINOPOISK_UNOFFICIAL_API_KEY` is supported for backward compatibility.
- The addon uses fixed API host `https://kinopoiskapiunofficial.tech` (custom host/direct IP is not supported without code changes).
- Because data sources differ, fields/matching may vary for some titles.
- For remote access (mobile/TV clients), always set correct HTTPS `PUBLIC_URL`.
- For Traefik Docker deploy, use `.env` with `HOST=0.0.0.0` and `PORT=3000`.
- If your API plan has strict limits, use:
  - `SEARCH_FALLBACK_ENABLED=false`
  - `MAX_ENRICH_ITEMS=8`
  - `MAX_ENRICH_CONCURRENCY=2`
  - `KINOPOISK_MIN_INTERVAL_MS=300`
- On `HTTP 402` (quota exceeded), addon pauses rating enrichment until restart or key change.

## Disclaimer

- This project is not affiliated with KinoPoisk, Yandex, or Stremio.
- Names and trademarks (`KinoPoisk`, `Stremio`) belong to their respective owners.
- The addon uses third-party data source [kinopoiskapiunofficial.tech](https://kinopoiskapiunofficial.tech/). Check current API terms and limits before production use.
- This project does not provide video content and does not bypass DRM or paid subscriptions. It only displays ratings and a link to the title page.

## License

This project is licensed under MIT.
See `LICENSE`.
