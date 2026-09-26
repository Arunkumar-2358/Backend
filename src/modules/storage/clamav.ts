import net from "node:net";
import { ValidationError } from "@/lib/errors";
import { HttpError } from "@/lib/http-errors";

/**
 * ClamAV (clamd) scanning over TCP using the zINSTREAM protocol:
 *   "zINSTREAM\0", then chunks framed as <uint32 big-endian length><bytes>, then a zero-length
 *   terminator. clamd replies "stream: OK\0" or "stream: <Signature> FOUND\0" (or "... ERROR").
 */

export type ScanResult = { clean: true } | { clean: false; signature: string };
export type ClamAvOptions = { host: string; port: number; timeoutMs?: number; chunkSize?: number };

/** clamd could not be reached, timed out, or answered with an error — callers must fail closed. */
export class ClamAvUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClamAvUnavailableError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK = 64 * 1024;

export function scanBuffer(data: Buffer, opts: ClamAvOptions): Promise<ScanResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  return new Promise<ScanResult>((resolve, reject) => {
    const replies: Buffer[] = [];
    let settled = false;
    const socket = net.createConnection({ host: opts.host, port: opts.port });

    const finish = (err: Error | null, result?: ScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };
    const parseReply = () => {
      const reply = Buffer.concat(replies).toString("utf8").replace(/\0/g, "").trim();
      if (!reply) return finish(new ClamAvUnavailableError("clamd closed the connection without a verdict"));
      if (/:\s*OK$/.test(reply)) return finish(null, { clean: true });
      const found = /:\s*(.+?)\s+FOUND$/.exec(reply);
      if (found) return finish(null, { clean: false, signature: found[1] });
      finish(new ClamAvUnavailableError(`clamd error: ${reply.slice(0, 200)}`));
    };

    // One overall deadline covers connect + upload + verdict.
    const timer = setTimeout(() => finish(new ClamAvUnavailableError(`clamd timed out after ${timeoutMs} ms`)), timeoutMs);

    socket.on("data", (d) => {
      replies.push(d);
      // A verdict is NUL-terminated in z-mode; parse as soon as it's complete.
      if (d.includes(0)) parseReply();
    });
    socket.on("end", parseReply);
    socket.on("close", () => {
      if (!settled) parseReply();
    });
    socket.on("error", (e: NodeJS.ErrnoException) => {
      // clamd may reset the socket after replying (e.g. size limit); prefer the reply if we have one.
      if (replies.length) return parseReply();
      finish(new ClamAvUnavailableError(`clamd unreachable (${e.code ?? e.message})`));
    });

    socket.once("connect", async () => {
      try {
        await write(socket, Buffer.from("zINSTREAM\0", "latin1"));
        for (let off = 0; off < data.length && !settled; off += chunkSize) {
          const chunk = data.subarray(off, Math.min(off + chunkSize, data.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length, 0);
          await write(socket, Buffer.concat([len, chunk]));
        }
        if (!settled) await write(socket, Buffer.alloc(4)); // zero-length terminator
      } catch (e) {
        if (!replies.length) finish(new ClamAvUnavailableError(`clamd write failed (${(e as NodeJS.ErrnoException).code ?? "error"})`));
      }
    });
  });
}

/** Backpressure-aware write. */
function write(socket: net.Socket, buf: Buffer) {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) return reject(new Error("socket closed"));
    socket.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

let warned = false;
/** Test hook: re-arm the one-time "scanning disabled" warning. */
export function resetClamAvWarning() {
  warned = false;
}

/**
 * Scan an upload with the clamd configured by CLAMAV_HOST / CLAMAV_PORT.
 * - infected → ValidationError (422)
 * - clamd unreachable / timeout / error → HttpError 503 (fail closed: never store an unscanned file)
 * - CLAMAV_HOST unset → skip, with a one-time warning (loud in production)
 */
export async function assertCleanUpload(data: Buffer): Promise<void> {
  const host = process.env.CLAMAV_HOST?.trim();
  if (!host) {
    if (!warned) {
      warned = true;
      if (process.env.NODE_ENV === "production")
        console.error("[storage] SECURITY WARNING: CLAMAV_HOST is not set — uploads are NOT being malware-scanned. Configure clamd before accepting candidate files.");
      else if (process.env.NODE_ENV !== "test") console.warn("[storage] CLAMAV_HOST not set — skipping malware scanning of uploads (dev only).");
    }
    return;
  }
  const port = Number(process.env.CLAMAV_PORT ?? 3310) || 3310;
  const timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  let result: ScanResult;
  try {
    result = await scanBuffer(data, { host, port, timeoutMs });
  } catch (e) {
    console.error(`[storage] malware scan unavailable: ${(e as Error).message}`);
    throw new HttpError(503, "INTERNAL", "Upload scanning is temporarily unavailable, please try again");
  }
  if (!result.clean) {
    console.warn(`[storage] upload rejected by ClamAV: ${result.signature}`);
    throw new ValidationError("File rejected: malware detected");
  }
}
