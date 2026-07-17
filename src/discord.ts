import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Socket } from "bun";
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
    this.send(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity: {
          name: gameName,
          type: 0,
          timestamps: { start: Math.floor(startTimestamp / 1000) },
          ...(largeImage ? { assets: { large_image: largeImage, large_text: gameName } } : {}),
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

export async function uploadApplicationAsset(
  appId: string,
  filePath: string,
): Promise<string | null> {
  if (!Config.DISCORD_BOT_TOKEN) return null;

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
  if (ext === "ico") return null;

  let imageBuffer: Buffer;
  try {
    imageBuffer = await readFile(filePath);
  } catch {
    return null;
  }

  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  const dataUrl = `data:${mime};base64,${imageBuffer.toString("base64")}`;
  // Emoji names: alphanumeric + underscores, 2-32 chars
  const emojiName = `app${appId}`;

  const resp = await fetch(
    `https://discord.com/api/v10/applications/${Config.DISCORD_APP_ID}/emojis`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${Config.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
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
