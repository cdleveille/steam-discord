import { Config } from "./config";
import { DiscordIpc } from "./discord";
import { getLibraryPaths, buildAppIdMap, loadShortcuts, getRunningGame } from "./steam";

const libraryPaths = await getLibraryPaths();
const [appIdMap, shortcuts] = await Promise.all([buildAppIdMap(libraryPaths), loadShortcuts()]);
console.log(
  `Loaded ${appIdMap.size} games + ${shortcuts.size} shortcuts from ${libraryPaths.length} library path(s)`,
);

const ipc = new DiscordIpc();
let currentGame: string | null = undefined!;
let gameStartTime = 0;
let polling = false;

async function handleGameChange(game: string | null): Promise<void> {
  if (game) {
    console.log(`[${new Date().toISOString()}] Now playing: ${game}`);
    if (!ipc.connected) {
      const ok = await ipc.connect();
      if (!ok) {
        console.warn("[Discord] IPC connection failed — is Discord running?");
        return;
      }
    }
    gameStartTime = Date.now();
    ipc.setActivity(game, gameStartTime);
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
    if (game !== currentGame) {
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
