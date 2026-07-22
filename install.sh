#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/steam-discord"
ENV_FILE="$CONFIG_DIR/env"
BIN_DIR="$HOME/.local/bin"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/steam-discord.service"

# ── 1. Install Bun dependencies ───────────────────────────────────────────────
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
bun install

# ── 2. Compile standalone binary ──────────────────────────────────────────────
echo "Compiling binary..."
bun run compile

# ── 3. Install binary ─────────────────────────────────────────────────────────
echo "Installing binary to $BIN_DIR..."
mkdir -p "$BIN_DIR"
install -m755 dist/steam-discord "$BIN_DIR/steam-discord"

# ── 4. Create config dir and env file (if not already present) ────────────────
if [ ! -f "$ENV_FILE" ]; then
    echo "Creating config directory and env file at $ENV_FILE..."
    mkdir -p "$CONFIG_DIR"
    chmod 700 "$CONFIG_DIR"
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"

    echo ""
    echo "Enter your Discord/Steam credentials (these will be saved to $ENV_FILE)."
    echo "See README.md for details on where to find each value."
    echo ""

    read -r -p "  DISCORD_APP_ID: " discord_app_id
    read -r -s -p "  DISCORD_BOT_TOKEN: " discord_bot_token
    echo ""
    read -r -p "  STEAM_USER_ID (your 64-bit Steam ID, see steamid.io): " steam_user_id

    {
        echo "DISCORD_APP_ID=${discord_app_id}"
        echo "DISCORD_BOT_TOKEN=${discord_bot_token}"
        echo "STEAM_USER_ID=${steam_user_id}"
    } >> "$ENV_FILE"
else
    echo "Config file $ENV_FILE already exists, skipping creation."
fi

# ── 5. Create systemd user service ────────────────────────────────────────────
echo "Creating systemd service at $SERVICE_FILE..."
mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Steam Discord Rich Presence
After=graphical-session.target

[Service]
EnvironmentFile=%h/.config/steam-discord/env
ExecStart=%h/.local/bin/steam-discord
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

# ── 6. Enable and (re)start the service ──────────────────────────────────────
echo "Enabling and starting steam-discord service..."
systemctl --user daemon-reload
systemctl --user enable steam-discord
systemctl --user restart steam-discord

echo ""
echo "Done. Check service status with:"
echo "  systemctl --user status steam-discord"
