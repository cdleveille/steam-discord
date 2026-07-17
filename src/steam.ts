import { readdir, readFile } from "node:fs/promises";
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
): Promise<string | null> {
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
        return appIdMap.get(appId) ?? shortcuts.get(appId) ?? `Unknown game (appid ${appId})`;
      }
    } catch {
      // process exited or not readable
    }
  }
  return null;
}
