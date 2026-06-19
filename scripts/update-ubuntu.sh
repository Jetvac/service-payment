#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "Update failed on line ${LINENO}" >&2' ERR

REPO_SLUG="${REPO_SLUG:-Jetvac/service-payment}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$(pwd)}"
APP_SERVICE_NAME="${APP_SERVICE_NAME:-service-payment}"
APP_BASE_NAME="${APP_SERVICE_NAME%.service}"
APP_USER="${APP_USER:-}"
RESTART_SERVICE="${RESTART_SERVICE:-true}"
ARCHIVE_URL="${ARCHIVE_URL:-https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}}"
SETUP_TIMESCALE="${SETUP_TIMESCALE:-true}"
TIMESCALE_IMAGE="${TIMESCALE_IMAGE:-timescale/timescaledb-ha:pg17-all}"
TIMESCALE_CONTAINER_NAME="${TIMESCALE_CONTAINER_NAME:-${APP_BASE_NAME}-timescaledb}"
TIMESCALE_VOLUME="${TIMESCALE_VOLUME:-${APP_BASE_NAME}-timescaledb-data}"
TIMESCALE_DB="${TIMESCALE_DB:-${APP_BASE_NAME//-/_}}"
TIMESCALE_USER="${TIMESCALE_USER:-${APP_BASE_NAME//-/_}}"
TIMESCALE_PASSWORD="${TIMESCALE_PASSWORD:-}"
TIMESCALE_PORT="${TIMESCALE_PORT:-15432}"
APP_ENV_FILE="${APP_ENV_FILE:-/etc/${APP_BASE_NAME}.env}"

log() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is missing: $1" >&2
    exit 1
  fi
}

service_unit_name() {
  local service_unit
  service_unit="${APP_SERVICE_NAME}"
  if [[ "${service_unit}" != *.service ]]; then
    service_unit="${service_unit}.service"
  fi
  printf '%s' "${service_unit}"
}

detect_app_user() {
  if [[ -n "${APP_USER}" ]]; then
    printf '%s' "${APP_USER}"
    return
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl show -p User --value "$(service_unit_name)" 2>/dev/null || true
  fi
}

load_app_env() {
  if [[ -f "${APP_ENV_FILE}" ]]; then
    log "Loading app environment ${APP_ENV_FILE}"
    set -a
    # shellcheck disable=SC1090
    source "${APP_ENV_FILE}"
    set +a
  fi
}

sync_source() {
  local tmp_dir source_dir
  tmp_dir="$(mktemp -d)"
  source_dir="${tmp_dir}/source"
  trap 'rm -rf "${tmp_dir}"' EXIT

  log "Downloading ${REPO_SLUG}@${BRANCH}"
  curl -fsSL "${ARCHIVE_URL}" -o "${tmp_dir}/source.tar.gz"
  mkdir -p "${source_dir}"
  tar -xzf "${tmp_dir}/source.tar.gz" -C "${source_dir}" --strip-components=1

  log "Updating source files in ${APP_DIR}"
  mkdir -p "${APP_DIR}"
  cd "${APP_DIR}"

  rm -rf server src scripts dist db
  rm -f .gitignore README.md index.html package.json package-lock.json tsconfig.json vite.config.ts

  cp -a "${source_dir}/." "${APP_DIR}/"
}

build_app() {
  log "Installing dependencies and building app"
  cd "${APP_DIR}"

  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi

  npm run build
  npm prune --omit=dev
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

shell_escape_env_value() {
  local value
  value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

url_encode() {
  node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"
}

timescale_database_url() {
  local encoded_password
  encoded_password="$(url_encode "${TIMESCALE_PASSWORD}")"
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s' "${TIMESCALE_USER}" "${encoded_password}" "${TIMESCALE_PORT}" "${TIMESCALE_DB}"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now docker >/dev/null 2>&1 || true
    fi
    return
  fi

  if [[ "${EUID}" -ne 0 ]] || ! command -v apt-get >/dev/null 2>&1; then
    echo "Docker is required for automatic local TimescaleDB setup. Re-run update with sudo or set SETUP_TIMESCALE=false and provide TIMESCALE_DATABASE_URL." >&2
    return 1
  fi

  log "Installing Docker"
  apt-get update
  apt-get install -y docker.io
  systemctl enable --now docker
}

timescale_container_exists() {
  docker inspect "${TIMESCALE_CONTAINER_NAME}" >/dev/null 2>&1
}

timescale_container_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "${TIMESCALE_CONTAINER_NAME}" 2>/dev/null || true)" == "true" ]]
}

wait_for_timescale() {
  log "Waiting for TimescaleDB to accept connections"
  for _ in $(seq 1 90); do
    if docker exec -e PGPASSWORD="${TIMESCALE_PASSWORD}" "${TIMESCALE_CONTAINER_NAME}" \
      pg_isready -U "${TIMESCALE_USER}" -d "${TIMESCALE_DB}" >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  docker logs --tail 120 "${TIMESCALE_CONTAINER_NAME}" >&2 || true
  echo "TimescaleDB did not become ready in time" >&2
  exit 1
}

setup_timescale_db() {
  if [[ "${SETUP_TIMESCALE}" != "true" ]]; then
    log "Skipping TimescaleDB container setup"
    return
  fi

  if [[ "${EUID}" -ne 0 ]]; then
    log "Skipping TimescaleDB container setup: root privileges are required"
    return
  fi

  install_docker || return
  if [[ -z "${TIMESCALE_PASSWORD}" ]]; then
    TIMESCALE_PASSWORD="$(random_password)"
  fi

  docker volume create "${TIMESCALE_VOLUME}" >/dev/null
  docker run --rm -v "${TIMESCALE_VOLUME}:/data" alpine sh -c "chown -R 1000:1000 /data && chmod 700 /data"
  if [[ "${TIMESCALE_PULL_IMAGE:-false}" == "true" ]] || ! docker image inspect "${TIMESCALE_IMAGE}" >/dev/null 2>&1; then
    docker pull "${TIMESCALE_IMAGE}"
  fi

  if timescale_container_exists; then
    log "TimescaleDB container ${TIMESCALE_CONTAINER_NAME} already exists"
    if ! timescale_container_running; then
      docker start "${TIMESCALE_CONTAINER_NAME}" >/dev/null
    fi
  else
    log "Creating TimescaleDB container ${TIMESCALE_CONTAINER_NAME}"
    docker run -d \
      --name "${TIMESCALE_CONTAINER_NAME}" \
      --restart unless-stopped \
      -p "127.0.0.1:${TIMESCALE_PORT}:5432" \
      -e POSTGRES_DB="${TIMESCALE_DB}" \
      -e POSTGRES_USER="${TIMESCALE_USER}" \
      -e POSTGRES_PASSWORD="${TIMESCALE_PASSWORD}" \
      -e TIMESCALEDB_TELEMETRY=off \
      -e PGDATA=/home/postgres/pgdata/data \
      -v "${TIMESCALE_VOLUME}:/home/postgres/pgdata/data" \
      "${TIMESCALE_IMAGE}" >/dev/null
  fi

  wait_for_timescale
  TIMESCALE_DATABASE_URL="$(timescale_database_url)"
  DATABASE_URL="${DATABASE_URL:-${TIMESCALE_DATABASE_URL}}"
}

write_app_env() {
  if [[ "${EUID}" -ne 0 ]]; then
    return
  fi

  log "Writing app environment ${APP_ENV_FILE}"
  mkdir -p "$(dirname "${APP_ENV_FILE}")"
  {
    echo "# Generated by service-payment update script"
    echo "NODE_ENV=production"
    echo "APP_SERVICE_NAME=$(shell_escape_env_value "${APP_BASE_NAME}")"
    if [[ -n "${TIMESCALE_DATABASE_URL:-}" ]]; then
      echo "TIMESCALE_DATABASE_URL=$(shell_escape_env_value "${TIMESCALE_DATABASE_URL}")"
      echo "DATABASE_URL=$(shell_escape_env_value "${DATABASE_URL:-${TIMESCALE_DATABASE_URL}}")"
      echo "TIMESCALE_CONTAINER_NAME=$(shell_escape_env_value "${TIMESCALE_CONTAINER_NAME}")"
      echo "TIMESCALE_DB=$(shell_escape_env_value "${TIMESCALE_DB}")"
      echo "TIMESCALE_USER=$(shell_escape_env_value "${TIMESCALE_USER}")"
      echo "TIMESCALE_PASSWORD=$(shell_escape_env_value "${TIMESCALE_PASSWORD}")"
      echo "TIMESCALE_PORT=$(shell_escape_env_value "${TIMESCALE_PORT}")"
      echo "TIMESCALE_VOLUME=$(shell_escape_env_value "${TIMESCALE_VOLUME}")"
      echo "TIMESCALE_IMAGE=$(shell_escape_env_value "${TIMESCALE_IMAGE}")"
    fi
  } >"${APP_ENV_FILE}"
  chmod 640 "${APP_ENV_FILE}"
}

install_service_env_override() {
  if [[ "${EUID}" -ne 0 ]] || ! command -v systemctl >/dev/null 2>&1; then
    return
  fi

  local service_unit dropin_dir
  service_unit="$(service_unit_name)"
  dropin_dir="/etc/systemd/system/${service_unit}.d"
  mkdir -p "${dropin_dir}"
  cat >"${dropin_dir}/10-env.conf" <<EOF
[Service]
EnvironmentFile=-${APP_ENV_FILE}
EOF
  systemctl daemon-reload
}

ensure_psql() {
  if command -v psql >/dev/null 2>&1; then
    return 0
  fi

  if [[ "${EUID}" -eq 0 ]] && command -v apt-get >/dev/null 2>&1; then
    log "Installing PostgreSQL client for TimescaleDB migrations"
    apt-get update
    apt-get install -y postgresql-client
    return 0
  fi

  echo "psql is required to apply the TimescaleDB schema. Install postgresql-client or run update as root." >&2
  return 1
}

apply_timescale_schema() {
  local database_url schema_file
  database_url="${TIMESCALE_DATABASE_URL:-${DATABASE_URL:-}}"
  schema_file="${APP_DIR}/db/timescale_latency.sql"

  if [[ -z "${database_url}" ]]; then
    log "Skipping TimescaleDB schema: TIMESCALE_DATABASE_URL/DATABASE_URL is not set"
    return
  fi

  if [[ ! -f "${schema_file}" ]]; then
    echo "TimescaleDB schema file not found: ${schema_file}" >&2
    exit 1
  fi

  if ! ensure_psql; then
    log "Skipping TimescaleDB schema: psql is unavailable"
    return
  fi
  log "Applying TimescaleDB latency schema"
  psql "${database_url}" -v ON_ERROR_STOP=1 -f "${schema_file}"
}

fix_permissions() {
  if [[ "${EUID}" -ne 0 ]]; then
    return
  fi

  local app_user
  app_user="$(detect_app_user)"
  if [[ -z "${app_user}" ]]; then
    return
  fi

  log "Setting ownership to ${app_user}"
  chown -R "${app_user}:${app_user}" "${APP_DIR}"
}

install_restart_sudoers() {
  if [[ "${EUID}" -ne 0 ]]; then
    return
  fi

  local app_user systemctl_bin service_unit sudoers_file sudoers_name
  app_user="$(detect_app_user)"
  if [[ -z "${app_user}" ]] || ! command -v systemctl >/dev/null 2>&1 || ! command -v visudo >/dev/null 2>&1; then
    return
  fi

  systemctl_bin="$(command -v systemctl)"
  service_unit="$(service_unit_name)"
  sudoers_name="${service_unit%.service}"
  sudoers_file="/etc/sudoers.d/${sudoers_name}-restart"

  log "Allowing ${app_user} to restart ${service_unit}"
  cat >"${sudoers_file}" <<EOF
${app_user} ALL=(root) NOPASSWD: ${systemctl_bin} restart ${service_unit}
EOF
  chmod 440 "${sudoers_file}"
  visudo -cf "${sudoers_file}"
}

restart_service() {
  if [[ "${RESTART_SERVICE}" != "true" ]]; then
    return
  fi

  local service_unit
  service_unit="$(service_unit_name)"

  log "Restarting ${service_unit}"
  sudo -n systemctl restart "${service_unit}"
}

main() {
  require_command curl
  require_command tar
  require_command npm

  load_app_env
  sync_source
  build_app
  setup_timescale_db
  write_app_env
  install_service_env_override
  apply_timescale_schema
  fix_permissions
  install_restart_sudoers
  restart_service

  log "Update complete"
}

main "$@"
