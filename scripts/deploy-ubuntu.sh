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
  apt-get install -y ca-certificates curl gnupg git sudo
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
    npm ci
  else
    npm install
  fi

  npm run build
  npm prune --omit=dev
  mkdir -p "${APP_DIR}/data"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
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
  install_systemd_service
  install_restart_sudoers
  install_nginx
  install_ssl
  configure_ufw
  print_summary
}

main "$@"
