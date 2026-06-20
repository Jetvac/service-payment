#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "Deploy failed on line ${LINENO}" >&2' ERR

REPO_URL="${REPO_URL:-https://github.com/Jetvac/service-payment.git}"
BRANCH="${BRANCH:-}"
APP_NAME="${APP_NAME:-service-payment}"
APP_USER="${APP_USER:-servicepay}"
APP_DIR="${APP_DIR:-/opt/service-payment}"
PORT="${PORT:-4077}"
NODE_MAJOR="${NODE_MAJOR:-22}"
DOMAIN="${DOMAIN:-}"
SETUP_NGINX="${SETUP_NGINX:-false}"
ENABLE_SSL="${ENABLE_SSL:-false}"
EMAIL="${EMAIL:-}"
ENABLE_UFW="${ENABLE_UFW:-false}"
SETUP_TIMESCALE="${SETUP_TIMESCALE:-true}"
TIMESCALE_IMAGE="${TIMESCALE_IMAGE:-timescale/timescaledb-ha:pg17-all}"
TIMESCALE_CONTAINER_NAME="${TIMESCALE_CONTAINER_NAME:-${APP_NAME}-timescaledb}"
TIMESCALE_VOLUME="${TIMESCALE_VOLUME:-${APP_NAME}-timescaledb-data}"
TIMESCALE_DB="${TIMESCALE_DB:-${APP_NAME//-/_}}"
TIMESCALE_USER="${TIMESCALE_USER:-${APP_NAME//-/_}}"
TIMESCALE_PASSWORD="${TIMESCALE_PASSWORD:-}"
TIMESCALE_PORT="${TIMESCALE_PORT:-29432}"
APP_ENV_FILE="${APP_ENV_FILE:-/etc/${APP_NAME}.env}"

log() {
  printf '\n==> %s\n' "$*"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    exec sudo -E bash "$0" "$@"
  fi
}

install_base_packages() {
  log "Installing base packages"
  apt-get update
  apt-get install -y ca-certificates curl gnupg git openssl sudo
}

node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1);
  '
}

install_node() {
  if node_is_supported; then
    log "Node.js $(node -v) is already installed"
    return
  fi

  log "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
}

ensure_app_user() {
  if id -u "${APP_USER}" >/dev/null 2>&1; then
    log "User ${APP_USER} already exists"
    return
  fi

  log "Creating system user ${APP_USER}"
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
}

checkout_repo() {
  log "Checking out ${REPO_URL}"

  if [[ -d "${APP_DIR}/.git" ]]; then
    git config --global --add safe.directory "${APP_DIR}" || true
    git -C "${APP_DIR}" remote set-url origin "${REPO_URL}"
    git -C "${APP_DIR}" fetch --all --prune
    if [[ -n "${BRANCH}" ]]; then
      git -C "${APP_DIR}" checkout "${BRANCH}"
      git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
    else
      git -C "${APP_DIR}" pull --ff-only
    fi
    return
  fi

  if [[ -e "${APP_DIR}" ]]; then
    echo "${APP_DIR} exists but is not a git repository" >&2
    exit 1
  fi

  mkdir -p "$(dirname "${APP_DIR}")"
  if [[ -n "${BRANCH}" ]]; then
    git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
  else
    git clone "${REPO_URL}" "${APP_DIR}"
  fi
}

build_app() {
  log "Installing dependencies and building app"
  cd "${APP_DIR}"

  if [[ -f package-lock.json ]]; then
    npm ci --include=dev
  else
    npm install --include=dev
  fi

  npm run build
  npm prune --omit=dev
  mkdir -p "${APP_DIR}/data"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
}

random_password() {
  openssl rand -hex 24
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
    log "Docker is already installed"
  else
    log "Installing Docker"
    apt-get update
    apt-get install -y docker.io
  fi

  systemctl enable --now docker
}

timescale_container_exists() {
  docker inspect "${TIMESCALE_CONTAINER_NAME}" >/dev/null 2>&1
}

timescale_container_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "${TIMESCALE_CONTAINER_NAME}" 2>/dev/null || true)" == "true" ]]
}

port_is_free() {
  local port
  port="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -H -ltn "sport = :${port}" | grep -q .
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  return 0
}

select_timescale_port() {
  local candidate
  for candidate in "${TIMESCALE_PORT}" 29432 39432 49432 59432 $(seq 25000 25150); do
    if port_is_free "${candidate}"; then
      TIMESCALE_PORT="${candidate}"
      return
    fi
  done

  echo "Could not find a free local port for TimescaleDB" >&2
  exit 1
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

  install_docker
  if [[ -z "${TIMESCALE_PASSWORD}" ]]; then
    TIMESCALE_PASSWORD="$(random_password)"
  fi

  docker volume create "${TIMESCALE_VOLUME}" >/dev/null
  docker run --rm -v "${TIMESCALE_VOLUME}:/data" alpine sh -c "chown -R 1000:1000 /data && chmod 700 /data"
  docker pull "${TIMESCALE_IMAGE}"

  if timescale_container_exists; then
    log "TimescaleDB container ${TIMESCALE_CONTAINER_NAME} already exists"
    if ! timescale_container_running; then
      docker start "${TIMESCALE_CONTAINER_NAME}" >/dev/null
    fi
  else
    select_timescale_port
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
  log "Writing app environment ${APP_ENV_FILE}"
  mkdir -p "$(dirname "${APP_ENV_FILE}")"
  {
    echo "# Generated by service-payment deploy script"
    echo "NODE_ENV=production"
    echo "PORT=$(shell_escape_env_value "${PORT}")"
    echo "APP_SERVICE_NAME=$(shell_escape_env_value "${APP_NAME}")"
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

ensure_psql() {
  if command -v psql >/dev/null 2>&1; then
    return 0
  fi

  echo "psql is not installed; will use Docker psql when the local TimescaleDB container is available." >&2
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

  if command -v docker >/dev/null 2>&1 && timescale_container_exists && timescale_container_running; then
    log "Applying TimescaleDB latency schema through Docker"
    docker exec -i -e PGPASSWORD="${TIMESCALE_PASSWORD}" "${TIMESCALE_CONTAINER_NAME}" \
      psql -U "${TIMESCALE_USER}" -d "${TIMESCALE_DB}" -v ON_ERROR_STOP=1 <"${schema_file}"
    return
  fi

  if ! ensure_psql; then
    log "Skipping TimescaleDB schema: psql is unavailable"
    return
  fi
  log "Applying TimescaleDB latency schema"
  psql "${database_url}" -v ON_ERROR_STOP=1 -f "${schema_file}"
}

install_systemd_service() {
  local npm_bin
  npm_bin="$(command -v npm)"

  log "Installing systemd service ${APP_NAME}.service"
  cat >"/etc/systemd/system/${APP_NAME}.service" <<EOF
[Unit]
Description=Service Payment web app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=APP_SERVICE_NAME=${APP_NAME}
EnvironmentFile=-${APP_ENV_FILE}
ExecStart=${npm_bin} start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${APP_NAME}.service"
  systemctl restart "${APP_NAME}.service"
}

install_restart_sudoers() {
  local systemctl_bin
  systemctl_bin="$(command -v systemctl)"

  log "Allowing ${APP_USER} to restart ${APP_NAME}.service"
  cat >"/etc/sudoers.d/${APP_NAME}-restart" <<EOF
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_bin} restart ${APP_NAME}.service
EOF
  chmod 440 "/etc/sudoers.d/${APP_NAME}-restart"
  visudo -cf "/etc/sudoers.d/${APP_NAME}-restart"
}

install_nginx() {
  if [[ -z "${DOMAIN}" && "${SETUP_NGINX}" != "true" ]]; then
    return
  fi

  log "Installing nginx reverse proxy"
  apt-get install -y nginx

  local server_name
  server_name="${DOMAIN:-_}"

  cat >"/etc/nginx/sites-available/${APP_NAME}.conf" <<EOF
server {
    listen 80;
    server_name ${server_name};

    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  ln -sfn "/etc/nginx/sites-available/${APP_NAME}.conf" "/etc/nginx/sites-enabled/${APP_NAME}.conf"
  nginx -t
  systemctl enable nginx
  systemctl reload nginx
}

install_ssl() {
  if [[ "${ENABLE_SSL}" != "true" ]]; then
    return
  fi

  if [[ -z "${DOMAIN}" || -z "${EMAIL}" ]]; then
    echo "ENABLE_SSL=true requires DOMAIN and EMAIL" >&2
    exit 1
  fi

  log "Requesting Let's Encrypt certificate for ${DOMAIN}"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx \
    --non-interactive \
    --agree-tos \
    --redirect \
    --email "${EMAIL}" \
    -d "${DOMAIN}"
}

configure_ufw() {
  if [[ "${ENABLE_UFW}" != "true" ]]; then
    return
  fi

  log "Configuring UFW"
  apt-get install -y ufw
  ufw allow OpenSSH
  if [[ -n "${DOMAIN}" || "${SETUP_NGINX}" == "true" ]]; then
    ufw allow "Nginx Full"
  else
    ufw allow "${PORT}/tcp"
  fi
  ufw --force enable
}

print_summary() {
  local public_url
  public_url="not configured"
  if [[ -n "${DOMAIN}" ]]; then
    public_url="http://${DOMAIN}"
    if [[ "${ENABLE_SSL}" == "true" ]]; then
      public_url="https://${DOMAIN}"
    fi
  fi

  log "Deployment complete"
  systemctl --no-pager --full status "${APP_NAME}.service" || true

  cat <<EOF

App directory: ${APP_DIR}
Systemd unit:  ${APP_NAME}.service
Env file:      ${APP_ENV_FILE}
Local URL:     http://127.0.0.1:${PORT}
Public URL:    ${public_url}

Useful commands:
  sudo systemctl status ${APP_NAME}
  sudo journalctl -u ${APP_NAME} -f
  sudo systemctl restart ${APP_NAME}

EOF
}

main() {
  require_root "$@"
  install_base_packages
  install_node
  ensure_app_user
  checkout_repo
  build_app
  setup_timescale_db
  write_app_env
  apply_timescale_schema
  install_systemd_service
  install_restart_sudoers
  install_nginx
  install_ssl
  configure_ufw
  print_summary
}

main "$@"
