import { homedir } from "node:os";
import { join } from "node:path";

const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
if (!DISCORD_APP_ID) {
  console.error("Missing DISCORD_APP_ID env var");
  process.exit(1);
}

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN env var");
  process.exit(1);
}

const HOME = process.env.HOME ?? homedir();

export const Config = {
  DISCORD_APP_ID,
  DISCORD_BOT_TOKEN,
  HOME,
  STEAM_ROOT: join(HOME, ".local/share/Steam"),
  STEAM_USER_ID: process.env.STEAM_USER_ID,
  POLL_MS: 5_000,
};
