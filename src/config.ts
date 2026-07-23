import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
if (!DISCORD_APP_ID) {
  console.error("Missing required DISCORD_APP_ID env var");
  process.exit(1);
}

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
  console.error("Missing required DISCORD_BOT_TOKEN env var");
  process.exit(1);
}

const STEAM_USER_ID = process.env.STEAM_USER_ID;
if (!STEAM_USER_ID) {
  console.error("Missing required STEAM_USER_ID env var");
  process.exit(1);
}

const HOME = process.env.HOME ?? homedir();

// Steam's data root differs by packaging. The internal layout under each root
// (steamapps/, userdata/, appcache/, …) is identical, so only the base path
// varies. Probe known locations and use the first that exists; fall back to the
// native path so a not-yet-installed Steam still yields a sensible error later.
function detectSteamRoot(): string {
  const candidates = [
    join(HOME, ".local/share/Steam"), // native (Arch/Debian/etc.)
    join(HOME, ".steam/steam"), // older native symlink layout
    join(HOME, ".var/app/com.valvesoftware.Steam/.local/share/Steam"), // flatpak
  ];
  return candidates.find(p => existsSync(join(p, "steamapps"))) ?? candidates[0]!;
}

export const Config = {
  DISCORD_APP_ID,
  DISCORD_BOT_TOKEN,
  HOME,
  STEAM_ROOT: detectSteamRoot(),
  STEAM_USER_ID,
  POLL_MS: 5_000,
};
