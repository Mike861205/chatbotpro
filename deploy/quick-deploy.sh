#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/chatbotpro}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
PM2_APP="${PM2_APP:-chatbotpro}"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

echo "==> Fast deploy"
echo "    app:    ${APP_DIR}"
echo "    branch: ${REMOTE}/${BRANCH}"
echo "    pm2:    ${PM2_APP}"

cd "${APP_DIR}"

echo "==> Fetch latest"
git fetch "${REMOTE}" "${BRANCH}" --prune

if [[ ${FORCE} -eq 1 ]]; then
  echo "==> Force mode: resetting local changes"
  git reset --hard "${REMOTE}/${BRANCH}"
else
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: Working tree has local changes."
    echo "Run again with --force to discard local changes, or commit/stash manually first."
    git status --short
    exit 2
  fi
  echo "==> Fast-forward pull"
  git pull --ff-only "${REMOTE}" "${BRANCH}"
fi

echo "==> Install production dependencies"
npm ci --omit=dev

echo "==> Restart PM2 app"
pm2 restart "${PM2_APP}"
pm2 save >/dev/null 2>&1 || true

echo "==> Active commit"
git log -1 --oneline

echo "==> PM2 status"
pm2 status "${PM2_APP}"

echo "==> Done"
