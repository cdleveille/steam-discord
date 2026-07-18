#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION_REQUIRED=""
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
    cat <<'EOF' >> "$ENV_FILE"
DISCORD_APP_ID=your_application_id
DISCORD_BOT_TOKEN=your_bot_token
# Optional — enables icons for non-Steam shortcuts
# STEAM_USER_ID=your_steamid64
EOF
    ACTION_REQUIRED="  !! Action required: edit $ENV_FILE and fill in your Discord credentials,\n     then run: systemctl --user restart steam-discord"
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

if [ -n "$ACTION_REQUIRED" ]; then
    echo ""
    echo -e "$ACTION_REQUIRED"
fi

echo ""
echo "Done. Check service status with:"
echo "  systemctl --user status steam-discord"
