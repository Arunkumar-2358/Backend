import { randomUUID } from "node:crypto";
import { assertCleanUpload } from "./clamav";
import { sniffUpload } from "./sniff";

const PREFIX_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;

/** Normalise a client file name into something safe to embed in an object key. */
export function safeFileName(fileName: string) {
  return fileName.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
}

/**
 * The upload safety pipeline every driver runs inside put(): magic-byte sniffing, then ClamAV.
 * Only when both pass is a storage key minted — nothing is written for a rejected file.
 */
export async function prepareUpload(prefix: string, fileName: string, data: Buffer) {
  if (!PREFIX_RE.test(prefix)) throw new Error("Invalid storage prefix");
  const { contentType } = sniffUpload(fileName, data);
  await assertCleanUpload(data);
  return { key: `${prefix}/${randomUUID()}-${safeFileName(fileName)}`, contentType };
}

/** Keys we hand out are relative, slash-separated and never contain "..", "\\" or NUL. */
export function assertValidKey(key: string) {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0") || key.split("/").some((s) => s === ".." || s === "." || s === ""))
    throw new Error("Invalid key");
}
