import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "./config";
import { DiscordIpc, uploadApplicationAsset } from "./discord";
import {
  buildAppIdMap,
  findShortcutIconPath,
  findSteamIconUrl,
  getLibraryPaths,
  getRunningGame,
  loadShortcuts,
} from "./steam";

const libraryPaths = await getLibraryPaths();
const [appIdMap, shortcuts] = await Promise.all([buildAppIdMap(libraryPaths), loadShortcuts()]);
console.log(
  `Loaded ${appIdMap.size} games + ${shortcuts.size} shortcuts from ${libraryPaths.length} library path(s)`,
);

// ── Asset cache ───────────────────────────────────────────────────────────────
// Stores resolved image strings (CDN URLs for Steam, Discord asset names for shortcuts)
// so we don't re-upload non-Steam icons across restarts.
const ASSET_CACHE_PATH = join(process.env.HOME!, ".local/share/steam-discord/asset-cache.json");
const assetCache = new Map<string, string>();

async function loadAssetCache(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(ASSET_CACHE_PATH, "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(data)) assetCache.set(k, v);
  } catch {}
}

async function saveAssetCache(): Promise<void> {
  try {
    await mkdir(join(process.env.HOME!, ".local/share/steam-discord"), { recursive: true });
    await writeFile(ASSET_CACHE_PATH, JSON.stringify(Object.fromEntries(assetCache)));
  } catch {}
}

async function resolveGameImage(appId: string, isShortcut: boolean): Promise<string | undefined> {
  if (assetCache.has(appId)) return assetCache.get(appId);

  if (!isShortcut) {
    const url = await findSteamIconUrl(appId);
    if (url) {
      assetCache.set(appId, url);
      return url;
    }
    return undefined;
  }

  const iconPath = findShortcutIconPath(appId);
  if (!iconPath) return undefined;

  const assetName = await uploadApplicationAsset(appId, iconPath);
  if (assetName) {
    assetCache.set(appId, assetName);
    await saveAssetCache();
    return assetName;
  }
  return undefined;
}

await loadAssetCache();

// ── Main loop ─────────────────────────────────────────────────────────────────
const ipc = new DiscordIpc();
let currentGame: { name: string; appId: string } | null = undefined!;
let gameStartTime = 0;
let polling = false;

async function handleGameChange(game: { name: string; appId: string } | null): Promise<void> {
  if (game) {
    console.log(`[${new Date().toISOString()}] Now playing: ${game.name}`);
    if (!ipc.connected) {
      const ok = await ipc.connect();
      if (!ok) {
        console.warn("[Discord] IPC connection failed — is Discord running?");
        return;
      }
    }
    const isShortcut = shortcuts.has(game.appId);
    const largeImage = await resolveGameImage(game.appId, isShortcut);
    gameStartTime = Date.now();
    ipc.setActivity(game.name, gameStartTime, largeImage);
  } else {
    console.log(`[${new Date().toISOString()}] Not playing anything`);
    ipc.clearActivity();
    ipc.disconnect();
  }
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const game = await getRunningGame(appIdMap, shortcuts);
    if (game?.appId !== currentGame?.appId) {
      currentGame = game;
      await handleGameChange(game);
    }
  } catch (err) {
    console.error(`[poll] ${err}`);
  } finally {
    polling = false;
  }
}

await poll();
setInterval(poll, Config.POLL_MS);
