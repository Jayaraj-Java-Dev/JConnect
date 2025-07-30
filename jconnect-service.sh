#!/bin/bash

SERVICE_NAME=jconnect
BIN_PATH="$(pwd)/jserv"
WORK_DIR="$(pwd)"
ASSETS_DIR="$WORK_DIR/assets"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
ARGS="$*"

install_service() {
    if [ ! -f "$BIN_PATH" ]; then
        echo "❌ Binary not found: $BIN_PATH"
        exit 1
    fi

    if [ ! -d "$ASSETS_DIR" ]; then
        echo "❌ Required folder missing: $ASSETS_DIR"
        exit 1
    fi

    echo "✅ Installing $SERVICE_NAME with args: ${ARGS:8}" # strip "install " from front

    sudo bash -c "cat > $SERVICE_FILE" <<EOF
[Unit]
Description=JConnect Service
After=network.target

[Service]
ExecStart=$BIN_PATH ${ARGS:8}
WorkingDirectory=$WORK_DIR
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    sudo chmod 644 "$SERVICE_FILE"
    sudo systemctl daemon-reexec
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    sudo systemctl start "$SERVICE_NAME"

    echo "✅ Service $SERVICE_NAME installed and started with args: ${ARGS:8}"
}

uninstall_service() {
    echo "⚠️ Uninstalling $SERVICE_NAME..."

    sudo systemctl stop "$SERVICE_NAME"
    sudo systemctl disable "$SERVICE_NAME"
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload

    echo "✅ Service $SERVICE_NAME uninstalled."
}

case "$1" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  *)
    echo "Usage: $0 install [args...]  |  $0 uninstall"
    exit 1
    ;;
esac
