#!/usr/bin/env bash
# 把离线包安装成 systemd 服务（需要 sudo）。
#
#   sudo bash deploy/install-service.sh                 # 安装到 /opt/qbridge-aichat
#   sudo INSTALL_DIR=/srv/aichat bash deploy/install-service.sh
#
# 安装前请先在包内填好 config/config.json 与 .env。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/qbridge-aichat}"
APP_USER="${APP_USER:-qbridge}"
SERVICE_NAME="qbridge-aichat"
UNIT_SRC="$DIR/deploy/$SERVICE_NAME.service"
UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"

if [ "$(id -u)" -ne 0 ]; then
    echo "[x] 请用 sudo 运行：sudo bash deploy/install-service.sh" >&2
    exit 1
fi

if [ ! -f "$DIR/config/config.json" ] || [ ! -f "$DIR/.env" ]; then
    echo "[x] 还没有 config/config.json 或 .env，先按 README 填好再安装服务。" >&2
    exit 1
fi

if ! id -u "$APP_USER" >/dev/null 2>&1; then
    echo "[*] 创建系统用户 $APP_USER"
    useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null ||
        useradd --system --home-dir "$INSTALL_DIR" --shell /sbin/nologin "$APP_USER"
fi

if [ "$DIR" != "$INSTALL_DIR" ]; then
    echo "[*] 复制到 $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cp -a "$DIR"/. "$INSTALL_DIR"/
fi

mkdir -p "$INSTALL_DIR/logs"
chown -R "$APP_USER":"$APP_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true
chmod +x "$INSTALL_DIR/start.sh" "$INSTALL_DIR/runtime/node/bin/node" 2>/dev/null || true

echo "[*] 安装 systemd 单元"
sed "s#/opt/qbridge-aichat#$INSTALL_DIR#g; s#^User=.*#User=$APP_USER#; s#^Group=.*#Group=$APP_USER#" \
    "$UNIT_SRC" >"$UNIT_DST"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

sleep 2
systemctl --no-pager --lines=20 status "$SERVICE_NAME" || true

echo
echo "[ok] 已安装并启动。看日志：journalctl -u $SERVICE_NAME -f"
echo "     预检：sudo -u $APP_USER bash $INSTALL_DIR/start.sh --check"
