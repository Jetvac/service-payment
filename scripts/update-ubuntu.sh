#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO_SLUG="${REPO_SLUG:-Jetvac/service-payment}"
BRANCH="${UPDATE_BRANCH:-${BRANCH:-main}}"
APP_DIR="${APP_DIR:-$(pwd)}"
APP_SERVICE_NAME="${APP_SERVICE_NAME:-service-payment}"
APP_BASE_NAME="${APP_SERVICE_NAME%.service}"
APP_ENV_FILE="${APP_ENV_FILE:-/etc/${APP_BASE_NAME}.env}"
if [[ -f "${APP_ENV_FILE}" ]]; then
  set -a
  source "${APP_ENV_FILE}"
  set +a
fi
APP_DIR="$(realpath "${APP_DIR}")"
APP_DATA_DIR="${APP_DATA_DIR:-${APP_DIR}/data}"
APP_DATABASE_PATH="${APP_DATABASE_PATH:-${APP_DATA_DIR}/service-payment.sqlite}"
export APP_DATA_DIR APP_DATABASE_PATH
RESTART_SERVICE="${RESTART_SERVICE:-true}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-4077}/api/health}"
ARCHIVE_URL="${ARCHIVE_URL:-https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}}"
service_unit="${APP_SERVICE_NAME%.service}.service"
WORK_DIR=""
stopped=false
installed=false
committed=false
snapshot_ready=false
log() { printf '\n==> %s\n' "$*"; }

[[ "${EUID}" -eq 0 ]] || { echo 'Run this update as root (sudo), or use the installed update service.' >&2; exit 1; }
[[ "${APP_DIR}" != / && -f "${APP_DIR}/package.json" ]] || { echo 'Invalid APP_DIR' >&2; exit 1; }
for command in curl tar npm flock node systemctl; do
  command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }
done
exec 9>"/run/lock/${APP_BASE_NAME}.update.lock"
flock -n 9 || { echo 'Another update is already running' >&2; exit 1; }
WORK_DIR="$(mktemp -d)"
source_dir="${WORK_DIR}/source"
rollback_dir="${WORK_DIR}/rollback"
mkdir -p "${source_dir}" "${rollback_dir}"
app_user="$(systemctl show -p User --value "${service_unit}")"
fix_owner() {
  if [[ -n "${app_user}" ]]; then
    chown -R "${app_user}:$(id -gn "${app_user}")" "${APP_DIR}" "${APP_DATA_DIR}" || return 1
    [[ ! -f "${APP_DATABASE_PATH}" ]] || chown "${app_user}:$(id -gn "${app_user}")" "${APP_DATABASE_PATH}"
  fi
}
items=(server src scripts db dist node_modules package.json package-lock.json tsconfig.json vite.config.ts index.html README.md)
restore() {
  log 'Restoring the previous release and data'
  systemctl stop "${service_unit}" || return 1
  if [[ "${installed}" == true ]]; then
    for item in "${items[@]}"; do rm -rf -- "${APP_DIR:?}/${item}" || return 1; done
    cp -a "${rollback_dir}/." "${APP_DIR}/" || return 1
  fi
  if [[ "${snapshot_ready}" == true ]]; then
    rm -f -- "${APP_DATABASE_PATH}" "${APP_DATABASE_PATH}-wal" "${APP_DATABASE_PATH}-shm" || return 1
    if [[ -f "${backup_dir}/database.sqlite" ]]; then cp -a "${backup_dir}/database.sqlite" "${APP_DATABASE_PATH}" || return 1; fi
    # JSON and external files are never changed by migration.
  fi
  fix_owner || return 1
  systemctl start "${service_unit}"
}
cleanup() {
  status=$?
  trap - EXIT
  if [[ "${stopped}" == true && "${committed}" != true ]]; then
    restore || {
      echo "Rollback failed; data backup: ${backup_dir:-unknown}; previous release: ${rollback_dir}" >&2
      WORK_DIR="" # Keep the previous release for manual recovery.
      status=1
    }
  fi
  [[ -z "${WORK_DIR}" ]] || rm -rf -- "${WORK_DIR}"
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
trap 'echo "Update failed on line ${LINENO}" >&2' ERR

log "Downloading ${REPO_SLUG}@${BRANCH}"
curl -fsSL "${ARCHIVE_URL}" -o "${WORK_DIR}/source.tar.gz"
tar -xzf "${WORK_DIR}/source.tar.gz" -C "${source_dir}" --strip-components=1
for script in "${source_dir}"/scripts/*.sh; do bash -n "${script}"; done
log 'Building candidate release outside the live application'
cd "${source_dir}"
if [[ -f package-lock.json ]]; then npm ci --include=dev; else npm install --include=dev; fi
npm run build
npm prune --omit=dev

log 'Stopping writes and backing up all application data'
if [[ "${RESTART_SERVICE}" == false ]] && systemctl is-active --quiet "${service_unit}"; then
  echo 'RESTART_SERVICE=false requires an already stopped application' >&2; exit 1
fi
systemctl stop "${service_unit}"
stopped=true
if [[ ! -f "${APP_DATABASE_PATH}" && ! -f "${APP_DATA_DIR}/db.json" ]]; then
  echo 'Existing data was not found. Check APP_DATA_DIR and APP_DATABASE_PATH; refusing to create an empty database.' >&2
  exit 1
fi
backup_dir="${APP_DATA_DIR}/backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "${backup_dir}"
# Keep a consistent SQLite backup even when the old release used only JSON.
if [[ -f "${APP_DATABASE_PATH}" ]]; then
  node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1],{readonly:true,fileMustExist:true});if(d.pragma("integrity_check",{simple:true})!=="ok")throw Error("Database corruption");d.backup(process.argv[2]).then(()=>d.close()).catch(e=>{console.error(e);process.exitCode=1})' "${APP_DATABASE_PATH}" "${backup_dir}/database.sqlite"
fi
# Includes db.json, wall-files and any other application-owned files; avoids recursive backups.
if [[ -d "${APP_DATA_DIR}" ]]; then
  tar --exclude='./backups' --exclude='./logs' -czf "${backup_dir}/data.tar.gz" -C "${APP_DATA_DIR}" .
fi
[[ ! -f "${APP_ENV_FILE}" ]] || cp -a "${APP_ENV_FILE}" "${backup_dir}/app.env"
snapshot_ready=true
for item in "${items[@]}"; do
  if [[ -e "${APP_DIR}/${item}" ]]; then cp -a "${APP_DIR}/${item}" "${rollback_dir}/"; fi
done
installed=true
for item in "${items[@]}"; do
  rm -rf -- "${APP_DIR:?}/${item}"
  if [[ -e "${source_dir}/${item}" ]]; then cp -a "${source_dir}/${item}" "${APP_DIR}/"; fi
done
cd "${APP_DIR}"
log 'Migrating and verifying SQLite with all attachments'
node --import tsx scripts/verify-data.ts
fix_owner
if [[ "${RESTART_SERVICE}" == true ]]; then
  systemctl start "${service_unit}"
  healthy=false
  for _ in $(seq 1 30); do
    if curl -fsS "${HEALTH_URL}" >/dev/null && systemctl is-active --quiet "${service_unit}"; then healthy=true; break; fi
    sleep 1
  done
  [[ "${healthy}" == true ]] || { echo 'Health check failed' >&2; exit 1; }
fi
committed=true
APP_DIR="${APP_DIR}" APP_SERVICE_NAME="${APP_SERVICE_NAME}" APP_ENV_FILE="${APP_ENV_FILE}" bash scripts/install-update-service.sh

# Remove only this application's legacy Timescale container after verified migration.
legacy_container="${TIMESCALE_CONTAINER_NAME:-${APP_BASE_NAME}-timescaledb}"
legacy_volume="${TIMESCALE_VOLUME:-${APP_BASE_NAME}-timescaledb-data}"
if command -v docker >/dev/null; then
  docker info >/dev/null
  if docker container inspect "${legacy_container}" >/dev/null 2>&1; then
    legacy_image="$(docker inspect -f '{{.Config.Image}}' "${legacy_container}")"
    [[ "${legacy_image}" == timescale/* ]] || { echo "Refusing to remove unexpected container ${legacy_container}" >&2; exit 1; }
    # Preserve a logical dump in case an installation stored extra, non-ping tables here.
    log 'Archiving the legacy database before removing its container'
    docker start "${legacy_container}" >/dev/null
    for _ in $(seq 1 30); do
      if docker exec -e PGPASSWORD="${TIMESCALE_PASSWORD:-}" "${legacy_container}" pg_isready -U "${TIMESCALE_USER:-${APP_BASE_NAME//-/_}}" >/dev/null; then break; fi
      sleep 1
    done
    docker exec -e PGPASSWORD="${TIMESCALE_PASSWORD:-}" "${legacy_container}" pg_dumpall -U "${TIMESCALE_USER:-${APP_BASE_NAME//-/_}}" >"${backup_dir}/legacy-postgres.sql"
    test -s "${backup_dir}/legacy-postgres.sql"
    mounted_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/postgres/pgdata/data"}}{{.Name}}{{end}}{{end}}' "${legacy_container}")"
    docker rm -f "${legacy_container}"
    if [[ -n "${mounted_volume}" && "${mounted_volume}" == "${legacy_volume}" ]]; then docker volume rm "${legacy_volume}"; fi
    docker image rm "${legacy_image}" || log 'Image retained because another container uses it'
  fi
fi
if [[ -f "${APP_ENV_FILE}" ]]; then
  sed -i -E '/^(TIMESCALE_[A-Z_]+|SETUP_TIMESCALE|DATABASE_URL)=/d' "${APP_ENV_FILE}"
fi
fix_owner
log "Update complete. Pre-update backup: ${backup_dir}"
