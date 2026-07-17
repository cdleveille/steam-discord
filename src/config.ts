import { join } from "node:path";

const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
if (!DISCORD_APP_ID) {
  console.error("Missing DISCORD_APP_ID in .env");
  process.exit(1);
}

export const Config = {
  POLL_MS: 5_000,
  STEAM_ROOT: join(process.env.HOME!, ".local/share/Steam"),
  STEAM_USER_ID: process.env.STEAM_USER_ID,
  DISCORD_APP_ID,
};
