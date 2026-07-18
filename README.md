# steam-discord

Reliable Discord rich presense for Steam games on Linux.

Sets your Discord status to the game you're currently running in Steam — including non-Steam shortcuts — using local process detection rather than the Steam Web API, so it works even when your Steam status is set to Invisible or Offline.

Icons are sourced from your Steam grid artwork folder first (so SGDBoop and other custom artwork tools are always used when available), falling back to the Steam CDN for games without custom icons.

## Prerequisites

- Linux (tested on CachyOS/Arch, but _should_ work on any distro)
- [Bun](https://bun.sh)
- Steam running
- Discord desktop app running

## Setup

**1. Clone the repo and run the install script**

```sh
git clone https://github.com/cdleveille/steam-discord
cd steam-discord
./install.sh
```

This installs dependencies, compiles the binary, installs it to `~/.local/bin`, and sets up a systemd user service that starts automatically on login.

**2. Create a Discord application**

Go to the [Discord Developer Portal](https://discord.com/developers/applications), create a new application, and note the **Application ID**. Under the application, create a **Bot** and copy its token.

**3. Fill in your credentials**

Edit `~/.config/steam-discord/env`:

```sh
DISCORD_APP_ID=your_application_id
DISCORD_BOT_TOKEN=your_bot_token
STEAM_USER_ID=your_steamid64
```

`STEAM_USER_ID` is your 64-bit Steam ID. You can find it at [steamid.io](https://steamid.io). It is required to locate your Steam grid artwork folder, which is used for both Steam games and non-Steam shortcuts.

Then restart the service:

```sh
systemctl --user restart steam-discord
```

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
