import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "./config";

function parseVdfPairs(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of content.matchAll(/^\s+"(\w+)"\s+"([^"]*?)"/gm)) {
    result[match[1]!.toLowerCase()] = match[2]!;
  }
  return result;
}

export async function getLibraryPaths(): Promise<string[]> {
  const content = await Bun.file(join(Config.STEAM_ROOT, "steamapps/libraryfolders.vdf")).text();
  const paths = [join(Config.STEAM_ROOT, "steamapps")];
  for (const match of content.matchAll(/"path"\s+"([^"]+)"/g)) {
    paths.push(join(match[1]!, "steamapps"));
  }
  return [...new Set(paths)];
}

export async function buildAppIdMap(libraryPaths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const libPath of libraryPaths) {
    let entries: string[];
    try {
      entries = await readdir(libPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("appmanifest_") || !entry.endsWith(".acf")) continue;
      try {
        const values = parseVdfPairs(await Bun.file(join(libPath, entry)).text());
        if (values.appid && values.name) map.set(values.appid, values.name);
      } catch {
        // skip unreadable manifests
      }
    }
  }
  return map;
}

function parseShortcutsVdf(buf: Uint8Array): Map<string, string> {
  let pos = 0;
  const dec = new TextDecoder();

  function readCStr(): string {
    const s = pos;
    while (pos < buf.length && buf[pos] !== 0) pos++;
    const str = dec.decode(buf.slice(s, pos));
    pos++;
    return str;
  }

  function readU32(): number {
    const v =
      (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) >>> 0;
    pos += 4;
    return v;
  }

  function skip(type: number): void {
    if (type === 0x01) readCStr();
    else if (type === 0x02) pos += 4;
    else if (type === 0x00) {
      while (pos < buf.length && buf[pos] !== 0x08) {
        const t = buf[pos++]!;
        readCStr();
        skip(t);
      }
      pos++;
    }
  }

  const map = new Map<string, string>();
  if (buf[pos] !== 0x00) return map;
  pos++;
  readCStr(); // "shortcuts"

  while (pos < buf.length && buf[pos] !== 0x08) {
    const type = buf[pos++]!;
    readCStr(); // index "0", "1", …

    if (type !== 0x00) {
      skip(type);
      continue;
    }

    let appId: number | null = null;
    let appName: string | null = null;

    while (pos < buf.length && buf[pos] !== 0x08) {
      const t = buf[pos++]!;
      const field = readCStr();
      if (t === 0x02 && field.toLowerCase() === "appid") appId = readU32();
      else if (t === 0x01 && field.toLowerCase() === "appname") appName = readCStr();
      else skip(t);
    }
    pos++;

    if (appId !== null && appName) map.set(String(appId), appName);
  }
  return map;
}

export async function loadShortcuts(): Promise<Map<string, string>> {
  if (!Config.STEAM_USER_ID) return new Map();
  const accountId = Number(BigInt(Config.STEAM_USER_ID) & 0xffffffffn);
  try {
    const buf = await Bun.file(
      join(Config.STEAM_ROOT, `userdata/${accountId}/config/shortcuts.vdf`),
    ).arrayBuffer();
    return parseShortcutsVdf(new Uint8Array(buf));
  } catch {
    return new Map();
  }
}

export async function getRunningGame(
  appIdMap: Map<string, string>,
  shortcuts: Map<string, string>,
): Promise<{ name: string; appId: string } | null> {
  let pids: string[];
  try {
    pids = await readdir("/proc");
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const buf = await readFile(`/proc/${pid}/environ`).catch(() => null);
      if (!buf) continue;
      const vars = new TextDecoder().decode(buf).split("\0");
      const entry = vars.find(v => v.startsWith("SteamAppId="));
      if (!entry) continue;
      const appId = entry.slice("SteamAppId=".length);
      if (appId && appId !== "0") {
        const name = appIdMap.get(appId) ?? shortcuts.get(appId) ?? `Unknown game (appid ${appId})`;
        return { name, appId };
      }
    } catch {
      // process exited or not readable
    }
  }
  return null;
}

export async function findSteamIconUrl(appId: string): Promise<string | null> {
  const dir = join(Config.STEAM_ROOT, `appcache/librarycache/${appId}`);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  // 1. Prefer the 600×900 portrait capsule — the full library artwork Steam caches locally.
  if (entries.includes("library_600x900.jpg")) {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
  }

  // 2. Fall back to the 616×353 landscape capsule from the store CDN.
  if (entries.length > 0) {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`;
  }

  // 3. Last resort: small community icon hash file.
  const iconFile = entries.find(e => /^[0-9a-f]{40}\.jpg$/.test(e));
  if (iconFile) {
    return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appId}/${iconFile.slice(0, -4)}.jpg`;
  }

  return null;
}

export function findShortcutIconPath(appId: string): string | null {
  if (!Config.STEAM_USER_ID) return null;
  const accountId = Number(BigInt(Config.STEAM_USER_ID) & 0xffffffffn);
  const base = join(Config.STEAM_ROOT, `userdata/${accountId}/config/grid`);
  for (const ext of ["png", "jpg", "ico"]) {
    const p = join(base, `${appId}_icon.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Discord detectable games ──────────────────────────────────────────────────
// Maps lowercase game name / alias → { appId, iconUrl }.
// appId: used as IPC client_id so Discord shows the correct voice-channel icon.
// iconUrl: Discord's official CDN icon for use as large_image in rich presence.

export interface DetectableGameInfo {
  appId: string;
  iconUrl: string | null;
}

const DETECTABLE_CACHE_PATH = join(
  process.env.HOME!,
  ".local/share/steam-discord/detectable-cache.json",
);
const DETECTABLE_CACHE_VERSION = 2;
const DETECTABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

let detectableNameMap: Map<string, DetectableGameInfo> | null = null;

async function loadDetectableMap(): Promise<Map<string, DetectableGameInfo>> {
  if (detectableNameMap) return detectableNameMap;

  // Try the on-disk cache first to avoid a network round-trip.
  try {
    const cached = JSON.parse(await readFile(DETECTABLE_CACHE_PATH, "utf8")) as {
      version: number;
      timestamp: number;
      entries: [string, DetectableGameInfo][];
    };
    if (
      cached.version === DETECTABLE_CACHE_VERSION &&
      Date.now() - cached.timestamp < DETECTABLE_TTL_MS
    ) {
      detectableNameMap = new Map(cached.entries);
      return detectableNameMap;
    }
  } catch {}

  // Fetch a fresh copy from Discord's public endpoint.
  try {
    const resp = await fetch("https://discord.com/api/v10/applications/detectable");
    if (resp.ok) {
      const list = (await resp.json()) as Array<{
        id: string;
        name: string;
        icon_hash?: string | null;
        cover_image_hash?: string | null;
        aliases?: string[];
      }>;
      detectableNameMap = new Map();
      for (const g of list) {
        // Prefer cover_image_hash (the game directory artwork, ~512px square)
        // over icon_hash (the small app icon, typically 32–64px).
        const imageHash = g.cover_image_hash ?? g.icon_hash ?? null;
        const info: DetectableGameInfo = {
          appId: g.id,
          iconUrl: imageHash
            ? `https://cdn.discordapp.com/app-icons/${g.id}/${imageHash}.png?size=512`
            : null,
        };
        detectableNameMap.set(g.name.toLowerCase(), info);
        for (const alias of g.aliases ?? []) {
          detectableNameMap.set(alias.toLowerCase(), info);
        }
      }
      try {
        await mkdir(join(process.env.HOME!, ".local/share/steam-discord"), { recursive: true });
        await writeFile(
          DETECTABLE_CACHE_PATH,
          JSON.stringify({
            version: DETECTABLE_CACHE_VERSION,
            timestamp: Date.now(),
            entries: [...detectableNameMap],
          }),
        );
      } catch {}
      return detectableNameMap;
    }
  } catch {
    console.warn("[Discord] Could not fetch detectable games list — voice icon may show '?'");
  }

  detectableNameMap ??= new Map();
  return detectableNameMap;
}

/**
 * Returns the Discord application ID and official icon URL for a game by name
 * (from Discord's detectable-games registry), or null if unrecognised.
 */
export async function findDiscordGame(gameName: string): Promise<DetectableGameInfo | null> {
  const map = await loadDetectableMap();
  return map.get(gameName.toLowerCase()) ?? null;
}
