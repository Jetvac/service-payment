#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "Echo server deploy failed on line ${LINENO}" >&2' ERR

ECHO_REPO_URL="${ECHO_REPO_URL:-https://github.com/LazyDoomSlayer/rust-websocket-server.git}"
ECHO_BRANCH="${ECHO_BRANCH:-main}"
ECHO_APP_DIR="${ECHO_APP_DIR:-/opt/rust-websocket-server}"
ECHO_SERVICE_NAME="${ECHO_SERVICE_NAME:-rust-websocket-echo-server}"
ECHO_PORT="${ECHO_PORT:-8765}"
ECHO_WS_PATH="${ECHO_WS_PATH:-/echo}"

log() {
  printf '\n==> %s\n' "$*"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    exec sudo -E bash "$0" "$@"
  fi
}

install_dependencies() {
  log "Installing system dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl git build-essential pkg-config libssl-dev
}

ensure_rust() {
  if command -v cargo >/dev/null 2>&1; then
    log "Rust toolchain is already installed"
    return
  fi

  log "Installing Rust toolchain"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
}

load_cargo_env() {
  if [[ -f "${HOME}/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    . "${HOME}/.cargo/env"
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not found after Rust installation" >&2
    exit 1
  fi
}

fetch_source() {
  log "Fetching ${ECHO_REPO_URL}@${ECHO_BRANCH}"
  if [[ -d "${ECHO_APP_DIR}/.git" ]]; then
    git -C "${ECHO_APP_DIR}" fetch --depth 1 origin "${ECHO_BRANCH}"
    git -C "${ECHO_APP_DIR}" reset --hard FETCH_HEAD
    return
  fi

  rm -rf "${ECHO_APP_DIR}"
  mkdir -p "$(dirname "${ECHO_APP_DIR}")"
  git clone --depth 1 --branch "${ECHO_BRANCH}" "${ECHO_REPO_URL}" "${ECHO_APP_DIR}"
}

build_binary() {
  log "Building release binary"
  cd "${ECHO_APP_DIR}"
  cargo build --release

  local binary
  binary="$(find target/release -maxdepth 1 -type f -perm /111 \( -name 'rust-websocket-server' -o -name 'rust-websocket-echo-server' \) | head -n 1)"
  if [[ -z "${binary}" ]]; then
    echo "Release binary not found" >&2
    find target/release -maxdepth 1 -type f -print >&2
    exit 1
  fi

  log "Installing binary to /usr/local/bin/${ECHO_SERVICE_NAME}"
  install -m 755 "${binary}" "/usr/local/bin/${ECHO_SERVICE_NAME}"
}

install_systemd_service() {
  log "Installing systemd service ${ECHO_SERVICE_NAME}.service"
  cat >"/etc/systemd/system/${ECHO_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Rust WebSocket Echo Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/${ECHO_SERVICE_NAME}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${ECHO_SERVICE_NAME}.service"
  systemctl restart "${ECHO_SERVICE_NAME}.service"
}

configure_ufw() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi active; then
    log "Allowing ${ECHO_PORT}/tcp in UFW"
    ufw allow "${ECHO_PORT}/tcp" || true
  fi
}

print_summary() {
  log "Echo server deployment complete"
  systemctl --no-pager --full status "${ECHO_SERVICE_NAME}.service" | sed -n '1,18p' || true

  cat <<EOF

Service: ${ECHO_SERVICE_NAME}.service
Binary:  /usr/local/bin/${ECHO_SERVICE_NAME}
URL:     ws://SERVER_IP:${ECHO_PORT}${ECHO_WS_PATH}

In the payment app service settings use:
  port: ${ECHO_PORT}
  path: ${ECHO_WS_PATH}

EOF
}

main() {
  require_root "$@"
  install_dependencies
  ensure_rust
  load_cargo_env
  fetch_source
  build_binary
  install_systemd_service
  configure_ufw
  print_summary
}

main "$@"
