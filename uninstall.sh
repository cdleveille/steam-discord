#!/usr/bin/env bash
set -euo pipefail

BIN_FILE="$HOME/.local/bin/steamd"
CONFIG_DIR="$HOME/.config/steamd"
SERVICE_FILE="$HOME/.config/systemd/user/steamd.service"

# ── 1. Stop and disable the systemd service ───────────────────────────────────
if systemctl --user is-active --quiet steamd 2>/dev/null; then
    echo "Stopping steamd service..."
    systemctl --user stop steamd
fi

if systemctl --user is-enabled --quiet steamd 2>/dev/null; then
    echo "Disabling steamd service..."
    systemctl --user disable steamd
fi

# ── 2. Remove the service unit file ───────────────────────────────────────────
if [ -f "$SERVICE_FILE" ]; then
    echo "Removing $SERVICE_FILE..."
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload
fi

# ── 3. Remove the binary ──────────────────────────────────────────────────────
if [ -f "$BIN_FILE" ]; then
    echo "Removing $BIN_FILE..."
    rm -f "$BIN_FILE"
fi

# ── 4. Remove the config directory (contains credentials) ─────────────────────
if [ -d "$CONFIG_DIR" ]; then
    read -r -p "Remove $CONFIG_DIR (contains your credentials)? [y/N] " confirm
    if [[ "${confirm,,}" == "y" ]]; then
        rm -rf "$CONFIG_DIR"
        echo "Removed $CONFIG_DIR."
    else
        echo "Skipping $CONFIG_DIR."
    fi
fi

echo ""
echo "Uninstall complete."
