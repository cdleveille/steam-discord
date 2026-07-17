# steam-discord

Sets your Discord "Playing" status to the game you're currently running in Steam — including non-Steam shortcuts — using local process detection rather than the Steam Web API, so it works even when your status is set to Invisible or Offline.

Icons are sourced directly from your Steam library cache (for Steam games) and your grid artwork (for non-Steam shortcuts), with no third-party image services required.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- Steam running on Linux
- Discord desktop app running

## Setup

**1. Clone and install dependencies**

```sh
git clone https://github.com/cdleveille/steam-discord
cd steam-discord
bun install
```

**2. Create a Discord application**

Go to the [Discord Developer Portal](https://discord.com/developers/applications), create a new application, and note the **Application ID**.

Under the application, create a **Bot** and copy its token.

**3. Configure environment variables**

For development, create a `.env` file in the project root (Bun loads it automatically):

```sh
DISCORD_APP_ID=your_application_id
DISCORD_BOT_TOKEN=your_bot_token

# Optional — enables icons for non-Steam shortcuts
STEAM_USER_ID=your_steamid64
```

For the installed binary or systemd service, create a dedicated config file instead:

```sh
mkdir -p ~/.config/steam-discord
chmod 700 ~/.config/steam-discord
touch ~/.config/steam-discord/env
chmod 600 ~/.config/steam-discord/env
```

Then populate `~/.config/steam-discord/env` (plain `KEY=VALUE` pairs, no `export`):

```sh
DISCORD_APP_ID=your_application_id
DISCORD_BOT_TOKEN=your_bot_token
STEAM_USER_ID=your_steamid64
```

`STEAM_USER_ID` is your 64-bit Steam ID (e.g. `76561198041506230`). It's used to locate your shortcuts and grid artwork. You can find it at [steamid.io](https://steamid.io).

> **Security:** `chmod 600` ensures the file is readable only by your user. Never commit secrets to version control — `.env` is already listed in `.gitignore`.

## Running

**Development (with hot reload)**

```sh
bun dev
```

**Production**

```sh
bun start
```

## Building a standalone binary

Compile a self-contained binary that doesn't require Bun to be installed:

```sh
bun compile
```

This produces `dist/steam-discord`. Install it to your local `PATH`:

```sh
install -m755 dist/steam-discord ~/.local/bin/steam-discord
```

Then run it from anywhere:

```sh
steam-discord
```

## Running as a systemd service

To start automatically on login, create `~/.config/systemd/user/steam-discord.service`:

```ini
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
```

`EnvironmentFile` points at the config file created in step 3, so secrets are never stored inside the unit file.

Enable and start it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now steam-discord
```

Check status or logs:

```sh
systemctl --user status steam-discord
journalctl --user -u steam-discord -f
```

## How it works

- Scans `/proc/*/environ` every 5 seconds for the `SteamAppId` variable that Steam injects into every game process
- Resolves the app ID to a name via `appmanifest_*.acf` files (Steam games) or `shortcuts.vdf` (non-Steam shortcuts)
- Communicates with Discord over its local IPC socket (`$XDG_RUNTIME_DIR/discord-ipc-0`) to set rich presence
- For icons: Steam game icons are fetched from Steam's public CDN; non-Steam shortcut icons are uploaded once to Discord Application Emojis and cached in `~/.local/share/steam-discord/asset-cache.json`
