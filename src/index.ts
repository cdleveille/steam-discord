import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "./config";
import { DiscordIpc, uploadApplicationAsset } from "./discord";
import {
  buildAppIdMap,
  findDiscordGame,
  findShortcutIconPath,
  findSteamIconPath,
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
const ASSET_CACHE_PATH = join(Config.HOME, ".local/share/steam-discord/asset-cache.json");
const assetCache = new Map<string, string>();

async function loadAssetCache(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(ASSET_CACHE_PATH, "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(data)) assetCache.set(k, v);
  } catch {}
}

async function saveAssetCache(): Promise<void> {
  try {
    await mkdir(join(Config.HOME, ".local/share/steam-discord"), { recursive: true });
    await writeFile(ASSET_CACHE_PATH, JSON.stringify(Object.fromEntries(assetCache)));
  } catch {}
}

async function uploadWithCache(appId: string, filePath: string): Promise<string | undefined> {
  const fileData = await readFile(filePath);
  const versionSuffix = createHash("sha1").update(fileData).digest("hex").slice(0, 8);
  const cacheKey = `${appId}:${versionSuffix}`;
  if (assetCache.has(cacheKey)) return assetCache.get(cacheKey);
  const url = await uploadApplicationAsset(appId, filePath, versionSuffix);
  if (url) {
    for (const key of [...assetCache.keys()]) {
      if (key === appId || key.startsWith(`${appId}:`)) assetCache.delete(key);
    }
    assetCache.set(cacheKey, url);
    await saveAssetCache();
  }
  return url ?? undefined;
}

async function resolveGameImage(
  appId: string,
  isShortcut: boolean,
  discordIconUrl?: string,
): Promise<string | undefined> {
  // ── 1. Grid folder — SGDBoop / user-provided icons for any game ───────────
  const gridPath = findShortcutIconPath(appId);
  if (gridPath) {
    try {
      const url = await uploadWithCache(appId, gridPath);
      if (url) return url;
    } catch {}
  }

  // ── 2. Steam librarycache — always upload locally so SGDBoop replacements  ─
  //       take effect (CDN would serve the original file regardless of local   ─
  //       changes to the hash-named file).                                     ─
  if (!isShortcut) {
    const libPath = await findSteamIconPath(appId);
    if (libPath) {
      try {
        const url = await uploadWithCache(appId, libPath);
        if (url) return url;
      } catch {}
    }
    return discordIconUrl ?? undefined;
  }

  // ── 3. Fallback for shortcuts with no icon anywhere ───────────────────────
  return discordIconUrl ?? assetCache.get(appId);
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
    // Use the game's own Discord application ID if it's in the detectable-games
    // registry — this is what makes the correct icon appear in the voice channel.
    // Fall back to the configured custom app ID for unrecognised games.
    const discordGame = await findDiscordGame(game.name);
    const discordAppId = discordGame?.appId ?? Config.DISCORD_APP_ID;

    // Reconnect if we're already connected under a different application ID.
    if (ipc.connected && ipc.appId !== discordAppId) {
      ipc.disconnect();
    }

    if (!ipc.connected) {
      const ok = await ipc.connect(discordAppId);
      if (!ok) {
        console.warn("[Discord] IPC connection failed — is Discord running?");
        return;
      }
    }
    const isShortcut = shortcuts.has(game.appId);
    const largeImage = await resolveGameImage(
      game.appId,
      isShortcut,
      discordGame?.iconUrl ?? undefined,
    );
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
    } else if (currentGame && !ipc.connected) {
      await handleGameChange(currentGame);
    }
  } catch (err) {
    console.error(`[poll] ${err}`);
  } finally {
    polling = false;
  }
}

await poll();
setInterval(poll, Config.POLL_MS);
