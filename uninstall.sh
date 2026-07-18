#!/usr/bin/env bash
set -euo pipefail

BIN_FILE="$HOME/.local/bin/steam-discord"
CONFIG_DIR="$HOME/.config/steam-discord"
SERVICE_FILE="$HOME/.config/systemd/user/steam-discord.service"

# ── 1. Stop and disable the systemd service ───────────────────────────────────
if systemctl --user is-active --quiet steam-discord 2>/dev/null; then
    echo "Stopping steam-discord service..."
    systemctl --user stop steam-discord
fi

if systemctl --user is-enabled --quiet steam-discord 2>/dev/null; then
    echo "Disabling steam-discord service..."
    systemctl --user disable steam-discord
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
