# steam-discord

Reliable Discord rich presense for Steam games on Linux.

Discord rich presence for Steam games on Linux can be a bit buggy. Sometimes the game you're running will show the wrong title, or won't show up at all. This project aims to fix that.

Sets your Discord status to the game you're currently running in Steam — including non-Steam shortcuts — using local process detection rather than the Steam Web API, so it works even when your Steam status is set to Invisible or Offline.

Icons are sourced from your Steam grid artwork folder first (so [SGDBoop](https://www.steamgriddb.com/boop) and other custom artwork tools are always used when available), falling back to the Steam CDN for games without custom icons.

## Prerequisites

- Linux (tested on CachyOS/Arch, but _should_ work on most distros)
- Steam (system package or Flatpak — auto-detected)
- Discord (system package or Flatpak — auto-detected)
- [Bun](https://bun.sh)

## Setup

**1. Clone the repo and run the install script**

```sh
git clone https://github.com/cdleveille/steam-discord
cd steam-discord
./install.sh
```

This installs dependencies, compiles the binary, installs it to `~/.local/bin`, and sets up a systemd user service that starts automatically on login.

If no config file is found at `~/.config/steam-discord/env`, the script will interactively prompt you to enter your credentials before starting the service. See below for info on how to obtain the required values.

**2. Find your `DISCORD_APP_ID` and `DISCORD_BOT_TOKEN`**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application named "Steam Rich Presence". Copy the **Application ID** from the General Information tab, and copy the **Token** from the Bot tab.

**3. Find your `STEAM_USER_ID`**

Go to [steamid.io](https://steamid.io) and enter your Steam profile URL. Copy the **steamID64** value from the results. It is required to locate your Steam grid artwork folder, which is used for icon resolution for both Steam games and non-Steam shortcuts.

Check status or follow logs:

```sh
systemctl --user status steam-discord
journalctl --user -u steam-discord -f
```

## Uninstall

```sh
./uninstall.sh
```

## Development

```sh
bun dev
```

## How it works

- Scans `/proc/*/environ` every 5 seconds for the `SteamAppId` variable that Steam injects into every game process
- Resolves the app ID to a name via `appmanifest_*.acf` files (Steam games) or `shortcuts.vdf` (non-Steam shortcuts)
- Communicates with Discord over its local IPC socket (`$XDG_RUNTIME_DIR/discord-ipc-0`) to set rich presence
- For icons: your Steam grid artwork folder is checked first for every game (so custom icons set via SGDBoop or similar tools always take priority); Steam games without custom artwork fall back to Steam's public CDN; all uploaded emoji assets are cached in `~/.local/share/steam-discord/asset-cache.json` and automatically refreshed when the source file changes
