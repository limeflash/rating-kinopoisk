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

## Deploy On VPS (Nginx + Cloudflare)

Target domain in this example: `kinopoiskrating.simg.pro`.

### 1. Prepare server

```bash
sudo apt update
sudo apt install -y git curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Upload project and install deps

```bash
sudo mkdir -p /opt/kinopoisk-rating-addon
sudo chown "$USER":"$USER" /opt/kinopoisk-rating-addon

# Option A: clone repo
git clone <your-repo-url> /opt/kinopoisk-rating-addon

# Option B: if folder already local, upload via rsync/scp
# rsync -av ./ /opt/kinopoisk-rating-addon/

cd /opt/kinopoisk-rating-addon
npm ci --omit=dev
cp deploy/env.production.example .env
```

Edit `.env` and set:
- `KINOPOISK_API_KEY=<your key>`
- `PUBLIC_URL=https://kinopoiskrating.simg.pro`

### 3. Run as systemd service

```bash
cd /opt/kinopoisk-rating-addon
sudo cp deploy/systemd/kinopoisk-rating.service /etc/systemd/system/kinopoisk-rating.service
sudo systemctl daemon-reload
sudo systemctl enable --now kinopoisk-rating
sudo systemctl status kinopoisk-rating --no-pager
```

If needed, edit service user/group before start:
`sudo nano /etc/systemd/system/kinopoisk-rating.service`

### 4. Nginx reverse proxy

```bash
cd /opt/kinopoisk-rating-addon
sudo cp deploy/nginx/kinopoiskrating.simg.pro.conf /etc/nginx/sites-available/kinopoiskrating.simg.pro.conf
sudo ln -s /etc/nginx/sites-available/kinopoiskrating.simg.pro.conf /etc/nginx/sites-enabled/kinopoiskrating.simg.pro.conf
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Cloudflare DNS

In Cloudflare dashboard for `simg.pro`:
1. Add `A` record:
   - `Name`: `kinopoiskrating`
   - `IPv4`: `<your VPS public IP>`
   - `Proxy status`: `Proxied` (orange cloud)
2. SSL/TLS mode:
   - quick start with this config: `Flexible`
   - recommended later: configure origin TLS and switch to `Full (strict)`

### 6. Check

- Health: `https://kinopoiskrating.simg.pro/health`
- Manifest: `https://kinopoiskrating.simg.pro/manifest.json`

Use manifest URL in Stremio:
`https://kinopoiskrating.simg.pro/manifest.json`

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
- For VPS behind nginx, recommended `.env`: `HOST=127.0.0.1` and `PORT=3000`.
- If your plan has strict limits, keep: `SEARCH_FALLBACK_ENABLED=false`, `MAX_ENRICH_ITEMS=8`, `MAX_ENRICH_CONCURRENCY=2`, `KINOPOISK_MIN_INTERVAL_MS=300`.
- On HTTP `402` (quota exceeded), addon pauses rating enrichment until restart or key change.
