import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * PII encryption at rest (DPDP): AES-256-GCM for contact details, plus an
 * HMAC-SHA256 blind index so we can enforce uniqueness and dedupe without
 * storing plaintext.
 */
function key(): Buffer {
  const hex = process.env.PII_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error("PII_ENCRYPTION_KEY must be 32 bytes hex");
  return Buffer.from(hex, "hex");
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [v, ivB, tagB, encB] = payload.split(":");
  if (v !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64")), decipher.final()]).toString("utf8");
}

export function blindIndex(value: string): string {
  return createHmac("sha256", key()).update(value.trim().toLowerCase()).digest("hex");
}
