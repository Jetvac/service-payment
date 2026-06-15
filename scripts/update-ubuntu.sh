#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "Update failed on line ${LINENO}" >&2' ERR

REPO_SLUG="${REPO_SLUG:-Jetvac/service-payment}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$(pwd)}"
APP_SERVICE_NAME="${APP_SERVICE_NAME:-service-payment}"
APP_USER="${APP_USER:-}"
RESTART_SERVICE="${RESTART_SERVICE:-true}"
ARCHIVE_URL="${ARCHIVE_URL:-https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}}"

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

  rm -rf server src scripts dist
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

  sync_source
  build_app
  fix_permissions
  install_restart_sudoers
  restart_service

  log "Update complete"
}

main "$@"
