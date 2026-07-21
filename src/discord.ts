import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Socket } from "bun";
import { encode as encodePng } from "fast-png";
import { Config } from "./config";

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_PING = 3;
const OP_PONG = 4;

function ipcEncode(op: number, payload: object): Buffer {
  const json = JSON.stringify(payload);
  const buf = Buffer.allocUnsafe(8 + Buffer.byteLength(json));
  buf.writeUInt32LE(op, 0);
  buf.writeUInt32LE(Buffer.byteLength(json), 4);
  buf.write(json, 8);
  return buf;
}

function findIpcSocket(): string | null {
  const dirs = [
    process.env.XDG_RUNTIME_DIR,
    `/run/user/${process.getuid?.() ?? 1000}`,
    process.env.TMPDIR,
    "/tmp",
  ].filter(Boolean) as string[];
  for (const dir of dirs) {
    for (let i = 0; i < 10; i++) {
      const p = `${dir}/discord-ipc-${i}`;
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export class DiscordIpc {
  private socket: Socket<undefined> | null = null;
  private buf = Buffer.alloc(0);
  private onReady: (() => void) | null = null;
  private _appId: string | null = null;

  async connect(appId = Config.DISCORD_APP_ID): Promise<boolean> {
    const path = findIpcSocket();
    if (!path) return false;

    const ready = new Promise<void>(r => {
      this.onReady = r;
    });
    this.buf = Buffer.alloc(0);
    this._appId = appId;

    try {
      this.socket = await Bun.connect({
        unix: path,
        socket: {
          open: sock => {
            sock.write(ipcEncode(OP_HANDSHAKE, { v: 1, client_id: appId }));
          },
          data: (sock, data) => this.handleData(sock, data),
          close: () => {
            this.socket = null;
          },
          error: (_, e) => console.error(`[Discord IPC] ${e.message}`),
        },
      });
    } catch {
      return false;
    }

    try {
      await Promise.race([
        ready,
        (async () => {
          await Bun.sleep(5_000);
          throw new Error("READY timeout");
        })(),
      ]);
      return true;
    } catch {
      this.disconnect();
      return false;
    }
  }

  private handleData(sock: Socket<undefined>, data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);

    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) break;

      const json = this.buf.subarray(8, 8 + len).toString("utf8");
      this.buf = Buffer.from(this.buf.subarray(8 + len));

      if (op === OP_PING) {
        sock.write(ipcEncode(OP_PONG, JSON.parse(json)));
        continue;
      }

      if (op === OP_FRAME) {
        const msg = JSON.parse(json) as { evt?: string };
        if (msg.evt === "READY") {
          this.onReady?.();
          this.onReady = null;
        }
      }
    }
  }

  private send(op: number, payload: object): void {
    this.socket?.write(ipcEncode(op, payload));
  }

  setActivity(gameName: string, startTimestamp: number, largeImage?: string): void {
    const cleanName = gameName.replace(/[®™©℠]/g, "").trim();
    this.send(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity: {
          name: cleanName,
          type: 0,
          timestamps: { start: Math.floor(startTimestamp / 1000) },
          ...(largeImage ? { assets: { large_image: largeImage, large_text: cleanName } } : {}),
        },
      },
      nonce: crypto.randomUUID(),
    });
  }

  clearActivity(): void {
    this.send(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: null },
      nonce: crypto.randomUUID(),
    });
  }

  disconnect(): void {
    this.socket?.end();
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.onReady = null;
    this._appId = null;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  get appId(): string | null {
    return this._appId;
  }
}

// ICO format: 6-byte ICONDIR header, then N×16-byte ICONDIRENTRY records.
// Each entry's image data is either a raw PNG or a BMP DIB blob.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Convert a 32-bit BGRA BMP DIB (as stored inside ICO files) to a PNG buffer.
 * BMP rows are stored bottom-up in BGRA order; convert to top-down RGBA for PNG.
 */
function icoFrameBmpToPng(bmpData: Buffer, width: number, height: number): Buffer | null {
  if (bmpData.length < 40) return null;
  const headerSize = bmpData.readUInt32LE(0);
  const bitCount = bmpData.readUInt16LE(14);
  if (bitCount !== 32) return null; // only 32-bit BGRA carries a per-pixel alpha channel

  const rowSize = width * 4;
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const srcOffset = headerSize + (height - 1 - y) * rowSize; // BMP rows are bottom-up
    const dstOffset = y * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcOffset + x * 4;
      const d = dstOffset + x * 4;
      data[d] = bmpData[s + 2]!; // R  (BGRA → RGBA)
      data[d + 1] = bmpData[s + 1]!; // G
      data[d + 2] = bmpData[s]!; // B
      data[d + 3] = bmpData[s + 3]!; // A
    }
  }

  return Buffer.from(encodePng({ width, height, data, channels: 4 }));
}

function extractBestIcoFrame(data: Buffer): Buffer | null {
  if (data.length < 6) return null;
  const count = data.readUInt16LE(4);
  if (count === 0) return null;

  // Find the entry with the largest pixel area (width/height 0 means 256 in ICO).
  let bestIndex = 0;
  let bestArea = -1;
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    if (base + 16 > data.length) break;
    const w = (data[base] ?? 0) === 0 ? 256 : (data[base] as number);
    const h = (data[base + 1] ?? 0) === 0 ? 256 : (data[base + 1] as number);
    if (w * h > bestArea) {
      bestArea = w * h;
      bestIndex = i;
    }
  }

  const base = 6 + bestIndex * 16;
  const w = (data[base] ?? 0) === 0 ? 256 : (data[base] as number);
  const h = (data[base + 1] ?? 0) === 0 ? 256 : (data[base + 1] as number);
  const imgSize = data.readUInt32LE(base + 8);
  const imgOffset = data.readUInt32LE(base + 12);
  const imgData = data.subarray(imgOffset, imgOffset + imgSize);

  // Case 1: embedded PNG (Windows Vista+ large ICO entries — most common)
  if (imgData.length >= 8 && imgData.subarray(0, 8).equals(PNG_MAGIC)) return imgData;

  // Case 2: 32-bit BMP DIB — convert to PNG, preserving the BGRA alpha channel
  const converted = icoFrameBmpToPng(imgData, w, h);
  if (converted) return converted;

  // Case 3: older / low-bit-depth BMP — scan all entries for any embedded PNG frame
  for (let i = 0; i < count; i++) {
    const b = 6 + i * 16;
    if (b + 16 > data.length) break;
    const sz = data.readUInt32LE(b + 8);
    const off = data.readUInt32LE(b + 12);
    const candidate = data.subarray(off, off + sz);
    if (candidate.length >= 8 && candidate.subarray(0, 8).equals(PNG_MAGIC)) return candidate;
  }

  return null;
}

export async function uploadApplicationAsset(
  appId: string,
  filePath: string,
  versionSuffix?: string,
): Promise<string | null> {
  if (!Config.DISCORD_BOT_TOKEN) return null;

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";

  // Emoji names: alphanumeric + underscores, 2-32 chars.
  // Including the version suffix ensures a changed icon file gets a new emoji
  // rather than reusing the stale one (max length: 3 + 10 + 1 + 8 = 22 chars).
  const emojiName = versionSuffix ? `app${appId}_${versionSuffix}` : `app${appId}`;
  const authHeader = { Authorization: `Bot ${Config.DISCORD_BOT_TOKEN}` };

  // Check whether the emoji was already uploaded (e.g. after an asset-cache clear).
  // If it exists, reuse it rather than attempting a duplicate upload that would fail.
  const listResp = await fetch(
    `https://discord.com/api/v10/applications/${Config.DISCORD_APP_ID}/emojis`,
    { headers: authHeader },
  );
  if (listResp.ok) {
    const { items } = (await listResp.json()) as { items: Array<{ id: string; name: string }> };
    const existing = items.find(e => e.name === emojiName);
    if (existing) return `https://cdn.discordapp.com/emojis/${existing.id}.png`;
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = await readFile(filePath);
  } catch {
    return null;
  }

  // For ICO files, extract the largest PNG frame rather than uploading the raw
  // container — Discord only accepts PNG/JPEG, and the biggest frame gives the
  // best quality for the large image slot.
  let uploadBuffer: Buffer;
  let mime: string;
  if (ext === "ico") {
    const frame = extractBestIcoFrame(imageBuffer);
    if (!frame) return null;
    uploadBuffer = frame;
    mime = "image/png";
  } else {
    uploadBuffer = imageBuffer;
    mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  }

  const dataUrl = `data:${mime};base64,${uploadBuffer.toString("base64")}`;

  const resp = await fetch(
    `https://discord.com/api/v10/applications/${Config.DISCORD_APP_ID}/emojis`,
    {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: emojiName, image: dataUrl }),
    },
  );
  if (!resp.ok) {
    console.warn(`[Discord] Emoji upload failed (${resp.status}): ${await resp.text()}`);
    return null;
  }
  const data = (await resp.json()) as { id: string };
  return `https://cdn.discordapp.com/emojis/${data.id}.png`;
}
