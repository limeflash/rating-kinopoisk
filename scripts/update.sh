#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"

cd "$REPO_DIR"
echo "[update] repo: $REPO_DIR"
echo "[update] branch: $BRANCH"

git fetch origin "$BRANCH"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  git checkout "$BRANCH"
fi

git pull --ff-only origin "$BRANCH"
echo "[update] git pull done"

if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -qx 'kinopoisk-rating'; then
  echo "[update] detected docker deployment (container: kinopoisk-rating)"
  docker restart kinopoisk-rating
  docker ps --filter "name=^kinopoisk-rating$" --format 'table {{.Names}}\t{{.Status}}'
  echo "[update] done"
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl status kinopoisk-rating >/dev/null 2>&1; then
  echo "[update] detected systemd deployment (service: kinopoisk-rating)"
  npm ci --omit=dev
  systemctl restart kinopoisk-rating
  systemctl --no-pager --full status kinopoisk-rating | sed -n '1,14p'
  echo "[update] done"
  exit 0
fi

echo "[update] code updated, but runtime was not restarted"
echo "[update] no known target found (docker container 'kinopoisk-rating' or systemd service 'kinopoisk-rating')"
