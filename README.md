# steamd

Tiny daemon providing reliable Discord rich presense for Steam games on Linux.

Discord rich presence for Steam games on Linux can be a bit buggy. Sometimes the game you're running will show the wrong title, or won't show up at all. This project aims to fix that.

Sets your Discord status to the game you're currently running in Steam (including non-Steam shortcuts) using local process detection rather than the Steam Web API, so it works even when your Steam status is set to Invisible or Offline.

Icons are sourced from the icon set in your Steam game properties first, then your Steam grid artwork folder (so [SGDBoop](https://www.steamgriddb.com/boop) and similar tools are respected), falling back to the Steam CDN for games without custom icons.

## Prerequisites

- Linux (tested on CachyOS/Arch, but _should_ work on most distros)
- Steam (system package or Flatpak - auto-detected)
- Discord (system package or Flatpak - auto-detected)
- [Go](https://go.dev) (only required if building from source instead of using the release binary)

## Setup

**1. Clone the repo and run the install script**

```sh
git clone https://github.com/cdleveille/steamd
cd steamd
./install.sh
```

The install script will prompt you to either download the [latest release](https://github.com/cdleveille/steamd/releases/latest) binary from GitHub (default) or build from source via `go build`. It installs the binary to `~/.local/bin`, and sets up a systemd user service that starts automatically on login.

If no config file is found at `~/.config/steamd/env`, the script will interactively prompt you to enter your credentials before starting the service. See below for info on how to obtain the required values.

**2. Find your `DISCORD_APP_ID` and `DISCORD_BOT_TOKEN`**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application named "Steam Rich Presence". Copy the **Application ID** from the General Information tab, and copy the **Token** from the Bot tab.

**3. Find your `STEAM_USER_ID`**

Go to [steamid.io](https://steamid.io) and enter your Steam profile URL. Copy the **steamID64** value from the results. It is required to locate your Steam grid artwork folder, which is used for icon resolution for both Steam games and non-Steam shortcuts.

Once installed, check status or follow logs:

```sh
systemctl --user status steamd
journalctl --user -u steamd -f
```

## Uninstall

```sh
./uninstall.sh
```

## Development

```sh
go run ./src
```

## How it works

**Detection**

Every 5 seconds, the service checks whether a game is running. While a game is active it only reads a single `/proc/{pid}/environ` file to confirm the process is still alive. A full `/proc` scan (reading every process's environment to find `SteamAppId`) only happens when no game is currently tracked, or when the tracked process exits. If a running game's app ID isn't in the cached name maps (e.g. a non-Steam shortcut added while the service was already running), the maps are reloaded on the spot and the lookup is retried - no restart required.

**Name resolution**

- **Steam games** - matched against `appmanifest_*.acf` files across all configured library folders
- **Non-Steam shortcuts** - matched against `shortcuts.vdf` in your Steam userdata folder

**Discord application ID**

If the game appears in Discord's public detectable-games registry, its own Discord application ID is used for the IPC connection. This is what makes the correct artwork appear in voice channels automatically. Unrecognized games fall back to your configured `DISCORD_APP_ID`.

**Icon resolution** (first match wins)

1. `shortcuts.vdf` icon field - the path Steam stores when you set an icon via the game properties dialog; exactly what appears in the Steam sidebar (non-Steam shortcuts only)
2. `grid/{appId}_icon.*` - where [SGDBoop](https://www.steamgriddb.com/boop) and similar tools save custom icons (any game, Steam or non-Steam)
3. Local `appcache/librarycache/` file, uploaded to Discord - used for Steam games so locally-replaced artwork takes effect instead of the original CDN file
4. Discord's detectable-games CDN URL - fallback for Steam games with no local artwork

Icons uploaded to Discord are cached by content hash in `~/.local/share/steamd/asset-cache.json` and only re-uploaded when the source file changes.
