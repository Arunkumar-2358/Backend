import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { S3Storage } from "./s3";
import { assertValidKey, prepareUpload } from "./upload-guard";

/**
 * Object storage adapter: local disk (dev/test) or S3-compatible (AWS S3 / MinIO), chosen by
 * STORAGE_DRIVER. Every driver's put() runs the upload safety pipeline (magic-byte sniffing +
 * ClamAV) before writing anything, so callers are protected without extra code.
 */
export interface Storage {
  /** Validate, scan and store; resolves to the new object key only after all checks pass. */
  put(prefix: string, fileName: string, data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
  /** Remove an object (used by DPDP anonymisation). Missing keys are not an error. */
  delete(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  /** Resolve a key under the root, refusing anything that escapes it (path traversal guard). */
  private resolve(key: string) {
    assertValidKey(key);
    const full = path.resolve(this.root, key);
    const rel = path.relative(this.root, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Invalid key");
    return full;
  }
  async put(prefix: string, fileName: string, data: Buffer) {
    const { key } = await prepareUpload(prefix, fileName, data);
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    return key;
  }
  async get(key: string) {
    return readFile(this.resolve(key));
  }
  async delete(key: string) {
    try {
      await unlink(this.resolve(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/** Build the driver selected by STORAGE_DRIVER (reads process.env so importing stays side-effect free). */
export function createStorage(e: NodeJS.ProcessEnv = process.env): Storage {
  if (e.STORAGE_DRIVER === "s3") {
    if (!e.S3_BUCKET) throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET");
    const sse = e.S3_SERVER_SIDE_ENCRYPTION?.trim();
    return new S3Storage({
      bucket: e.S3_BUCKET,
      region: e.S3_REGION || "ap-south-1",
      endpoint: e.S3_ENDPOINT || undefined,
      forcePathStyle: e.S3_FORCE_PATH_STYLE === "true" || e.S3_FORCE_PATH_STYLE === "1",
      accessKeyId: e.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY || undefined,
      // Default SSE-S3. "none" is an escape hatch for MinIO without a KMS configured.
      serverSideEncryption: sse === "none" ? null : sse === "aws:kms" ? "aws:kms" : "AES256",
    });
  }
  return new LocalStorage(e.UPLOAD_DIR ?? "./storage");
}

let instance: Storage | null = null;
const current = () => (instance ??= createStorage());

/** Test hook: swap the backing driver (null → back to the env-selected one, re-read on next use). */
export function setStorage(s: Storage | null) {
  instance = s;
}

/** The app-wide storage. The driver is created lazily on first use, so importing needs no S3. */
export const storage: Storage = {
  put: (prefix, fileName, data) => current().put(prefix, fileName, data),
  get: (key) => current().get(key),
  delete: (key) => current().delete(key),
};

export { S3Storage } from "./s3";
export { sniffUpload, contentTypeFor, ALLOWED_UPLOAD_EXTENSIONS } from "./sniff";
export { scanBuffer, assertCleanUpload, ClamAvUnavailableError } from "./clamav";

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
