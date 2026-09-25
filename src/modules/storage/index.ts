import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Object storage adapter. Local disk in dev; swap for an S3-compatible adapter in production. */
export interface Storage {
  put(prefix: string, fileName: string, data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}

class LocalStorage implements Storage {
  constructor(private root: string) {}
  async put(prefix: string, fileName: string, data: Buffer) {
    const safe = fileName.replace(/[^\w.-]+/g, "_").slice(-80);
    const key = `${prefix}/${randomUUID()}-${safe}`;
    const full = path.join(this.root, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    return key;
  }
  async get(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root))) throw new Error("Invalid key");
    return readFile(full);
  }
}

export const storage: Storage = new LocalStorage(process.env.UPLOAD_DIR ?? "./storage");

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
