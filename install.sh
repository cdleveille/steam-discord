#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/steamd"
ENV_FILE="$CONFIG_DIR/env"
BIN_DIR="$HOME/.local/bin"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/steamd.service"
GITHUB_REPO="cdleveille/steamd"
RELEASE_BINARY_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/steamd"

cd "$SCRIPT_DIR"

# ── 1. Obtain binary ──────────────────────────────────────────────────────────
mkdir -p dist
echo "How would you like to install the steamd binary?"
echo "  1) Download the latest release binary from GitHub (default)"
echo "  2) Build from source"
read -r -p "Select an option [1]: " install_method
install_method="${install_method:-1}"

if [ "$install_method" = "2" ]; then
    if ! command -v go &>/dev/null; then
        echo "Error: go is required to build from source. Install go, or re-run and choose to download the release binary." >&2
		echo "https://go.dev" >&2
        exit 1
    fi

    echo "Compiling from source..."
    go build -C src -o "$SCRIPT_DIR/dist/steamd" .
else
    if ! command -v curl &>/dev/null; then
        echo "Error: curl is required to download the release binary. Install curl, or re-run and choose to build from source." >&2
        exit 1
    fi

    echo "Downloading latest release binary from $RELEASE_BINARY_URL..."
    curl -fsSL "$RELEASE_BINARY_URL" -o "$SCRIPT_DIR/dist/steamd"
    chmod +x "$SCRIPT_DIR/dist/steamd"
fi

# ── 2. Install binary ─────────────────────────────────────────────────────────
echo "Installing binary to $BIN_DIR..."
mkdir -p "$BIN_DIR"
install -m755 dist/steamd "$BIN_DIR/steamd"

# ── 3. Create config dir and env file (if not already present) ────────────────
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

# ── 4. Create systemd user service ──────────────────────────────────────────
echo "Creating systemd user service at $SERVICE_FILE..."
mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=steamd
After=graphical-session.target

[Service]
EnvironmentFile=%h/.config/steamd/env
ExecStart=%h/.local/bin/steamd
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

# ── 5. Enable and (re)start the service ─────────────────────────────────────
echo "Enabling and starting steamd.service..."
systemctl --user daemon-reload
systemctl --user enable steamd
systemctl --user restart steamd

echo ""
echo "Done. Check service status with:"
echo "  systemctl --user status steamd"
