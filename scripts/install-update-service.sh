#!/usr/bin/env bash
# Install a separate update unit so stopping the app cannot kill its updater.
set -Eeuo pipefail
APP_DIR="${APP_DIR:-/opt/service-payment}"
APP_SERVICE_NAME="${APP_SERVICE_NAME:-service-payment}"
APP_BASE_NAME="${APP_SERVICE_NAME%.service}"
APP_ENV_FILE="${APP_ENV_FILE:-/etc/${APP_BASE_NAME}.env}"
app_user="$(systemctl show -p User --value "${APP_BASE_NAME}.service")"
[[ -n "${app_user}" ]] || { echo 'Application service user is missing' >&2; exit 1; }
systemctl_bin="$(command -v systemctl)"
cat >"/etc/systemd/system/${APP_BASE_NAME}-update.service" <<EOF
[Unit]
Description=Update ${APP_BASE_NAME}
[Service]
Type=oneshot
WorkingDirectory=${APP_DIR}
Environment="APP_DIR=${APP_DIR}"
Environment="APP_SERVICE_NAME=${APP_BASE_NAME}"
Environment="APP_ENV_FILE=${APP_ENV_FILE}"
EnvironmentFile=-${APP_ENV_FILE}
ExecStart=/bin/bash "${APP_DIR}/scripts/update-ubuntu.sh"
TimeoutStartSec=infinity
StandardOutput=append:${APP_DIR}/data/logs/update.log
StandardError=append:${APP_DIR}/data/logs/update.log
EOF
mkdir -p "${APP_DIR}/data/logs"
cat >"/etc/sudoers.d/${APP_BASE_NAME}-update" <<EOF
${app_user} ALL=(root) NOPASSWD: ${systemctl_bin} start --no-block ${APP_BASE_NAME}-update.service
EOF
chmod 440 "/etc/sudoers.d/${APP_BASE_NAME}-update"
visudo -cf "/etc/sudoers.d/${APP_BASE_NAME}-update"
systemctl daemon-reload
