#!/usr/bin/env bash
set -Eeuo pipefail

REPO_SLUG="${REPO_SLUG:-Jetvac/service-payment}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$(pwd)}"
APP_SERVICE_NAME="${APP_SERVICE_NAME:-service-payment}"
APP_BASE_NAME="${APP_SERVICE_NAME%.service}"
APP_ENV_FILE="${APP_ENV_FILE:-/etc/${APP_BASE_NAME}.env}"
if [[ -f "${APP_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${APP_ENV_FILE}"
  set +a
fi
APP_DATA_DIR="${APP_DATA_DIR:-${APP_DIR}/data}"
APP_DATABASE_PATH="${APP_DATABASE_PATH:-${APP_DATA_DIR}/service-payment.sqlite}"
RESTART_SERVICE="${RESTART_SERVICE:-true}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-4077}/api/health}"
ARCHIVE_URL="${ARCHIVE_URL:-https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}}"
WORK_DIR=""

log() { printf '\n==> %s\n' "$*"; }

cleanup() {
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf -- "${WORK_DIR}"
  fi
}
trap cleanup EXIT
trap 'echo "Update failed on line ${LINENO}" >&2' ERR

if [[ -z "${APP_DIR}" || "${APP_DIR}" == "/" || ! -f "${APP_DIR}/package.json" ]]; then
  echo "APP_DIR must point to an existing service-payment installation" >&2
  exit 1
fi

for command in curl tar npm flock; do
  command -v "${command}" >/dev/null 2>&1 || { echo "Required command is missing: ${command}" >&2; exit 1; }
done

service_unit="${APP_SERVICE_NAME}"
[[ "${service_unit}" == *.service ]] || service_unit="${service_unit}.service"
lock_name="${service_unit//[^a-zA-Z0-9_.-]/_}"
exec 9>"/tmp/${lock_name}.update.lock"
flock -n 9 || { echo "Another update is already running" >&2; exit 1; }

WORK_DIR="$(mktemp -d)"
source_dir="${WORK_DIR}/source"
rollback_dir="${WORK_DIR}/rollback"
mkdir -p "${source_dir}" "${rollback_dir}"

log "Downloading ${REPO_SLUG}@${BRANCH}"
curl -fsSL "${ARCHIVE_URL}" -o "${WORK_DIR}/source.tar.gz"
tar -xzf "${WORK_DIR}/source.tar.gz" -C "${source_dir}" --strip-components=1
bash -n "${source_dir}/scripts/update-ubuntu.sh"
bash -n "${source_dir}/scripts/deploy-ubuntu.sh"

log "Building candidate release outside the live application"
cd "${source_dir}"
if [[ -f package-lock.json ]]; then npm ci --include=dev; else npm install --include=dev; fi
npm run build
npm prune --omit=dev

log "Creating a consistent pre-update database backup"
mkdir -p "${APP_DATA_DIR}/backups"
if [[ -f "${APP_DATABASE_PATH}" && -d "${APP_DIR}/node_modules/better-sqlite3" ]]; then
  backup_file="${APP_DATA_DIR}/backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  cd "${APP_DIR}"
  node -e 'const Database=require("better-sqlite3"); const db=new Database(process.argv[1]); db.backup(process.argv[2]).then(()=>db.close())' \
    "${APP_DATABASE_PATH}" "${backup_file}"
fi

log "Saving the current release for automatic rollback"
cd "${APP_DIR}"
for item in server src scripts db dist node_modules package.json package-lock.json tsconfig.json vite.config.ts index.html README.md; do
  [[ -e "${item}" ]] && cp -a -- "${item}" "${rollback_dir}/"
done

install_release() {
  cd "${APP_DIR}"
  rm -rf -- server src scripts db dist node_modules
  rm -f -- package.json package-lock.json tsconfig.json vite.config.ts index.html README.md
  for item in server src scripts db dist node_modules package.json package-lock.json tsconfig.json vite.config.ts index.html README.md; do
    [[ -e "${source_dir}/${item}" ]] && cp -a -- "${source_dir}/${item}" "${APP_DIR}/"
  done
}

restore_release() {
  log "Health check failed; restoring the previous release"
  cd "${APP_DIR}"
  rm -rf -- server src scripts db dist node_modules
  rm -f -- package.json package-lock.json tsconfig.json vite.config.ts index.html README.md
  cp -a -- "${rollback_dir}/." "${APP_DIR}/"
}

install_release

app_user=""
if command -v systemctl >/dev/null 2>&1; then
  app_user="$(systemctl show -p User --value "${service_unit}" 2>/dev/null || true)"
fi
if [[ "${EUID}" -eq 0 && -n "${app_user}" ]]; then
  chown -R "${app_user}:${app_user}" "${APP_DIR}"
fi

if [[ "${RESTART_SERVICE}" == "true" ]]; then
  log "Restarting ${service_unit}"
  sudo -n systemctl restart "${service_unit}"
  healthy=false
  for _ in $(seq 1 30); do
    if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then healthy=true; break; fi
    sleep 1
  done
  if [[ "${healthy}" != "true" ]]; then
    restore_release
    if [[ "${EUID}" -eq 0 && -n "${app_user}" ]]; then chown -R "${app_user}:${app_user}" "${APP_DIR}"; fi
    sudo -n systemctl restart "${service_unit}"
    exit 1
  fi
fi

log "Update complete; application data was preserved"
