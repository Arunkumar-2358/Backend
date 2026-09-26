import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, type ServerSideEncryption } from "@aws-sdk/client-s3";
import type { Storage } from "./index";
import { assertValidKey, prepareUpload } from "./upload-guard";

export type S3StorageOptions = {
  bucket: string;
  region?: string;
  /** Custom endpoint for MinIO / other S3-compatible stores. */
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Defaults to "AES256" (SSE-S3). `null` disables it (MinIO without KMS). */
  serverSideEncryption?: ServerSideEncryption | null;
};

/** S3-compatible object storage (AWS S3 or MinIO). The client is created on first use. */
export class S3Storage implements Storage {
  private _client: S3Client | null = null;
  constructor(private readonly opts: S3StorageOptions) {
    if (!opts.bucket) throw new Error("S3Storage requires a bucket");
  }

  get client() {
    if (!this._client) {
      const { region, endpoint, forcePathStyle, accessKeyId, secretAccessKey } = this.opts;
      this._client = new S3Client({
        region: region ?? "ap-south-1",
        ...(endpoint ? { endpoint } : {}),
        forcePathStyle: forcePathStyle ?? false,
        // Explicit keys only when both are given; otherwise the default provider chain (ECS task role, etc.).
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      });
    }
    return this._client;
  }

  async put(prefix: string, fileName: string, data: Buffer) {
    const { key, contentType } = await prepareUpload(prefix, fileName, data);
    const sse = this.opts.serverSideEncryption === undefined ? "AES256" : this.opts.serverSideEncryption;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
        ...(sse ? { ServerSideEncryption: sse } : {}),
      }),
    );
    return key;
  }

  async get(key: string) {
    assertValidKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    if (!res.Body) throw new Error("Empty object body");
    return Buffer.from(await res.Body.transformToByteArray());
  }

  /** Idempotent: S3 returns success for missing keys too. */
  async delete(key: string) {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}
