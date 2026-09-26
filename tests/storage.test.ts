import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { CreateBucketCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import ExcelJS from "exceljs";
import { ValidationError } from "@/lib/errors";
import { HttpError } from "@/lib/http-errors";
import { LocalStorage, S3Storage, createStorage, sniffUpload, scanBuffer, ClamAvUnavailableError } from "@/modules/storage";
import { resetClamAvWarning } from "@/modules/storage/clamav";

// ---------- realistic fixture bytes ----------
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "latin1");
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), Buffer.alloc(32)]);
const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)]);
const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(20)]);
const mov = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x14]), Buffer.from("ftypqt  ", "latin1"), Buffer.alloc(8)]);
const oldMov = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x08]), Buffer.from("wide", "latin1"), Buffer.alloc(8)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
const csv = Buffer.from("﻿Name,Mobile,City\nPriya S,9848011111,Hyderabad\nRāmesh,9848022222,Pune\n", "utf8");
const exe = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(60)]);
const html = Buffer.from("<html><script>alert(1)</script></html>");
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe("upload sniffing", () => {
  const accept: [string, Buffer][] = [
    ["cv.pdf", pdf],
    ["CV.PDF", pdf],
    ["cv.docx", zip],
    ["dump.xlsx", zip],
    ["cv.doc", ole],
    ["dump.csv", csv],
    // Windows-1252 "Rénu"-style export from older Excel (0xE9 = é): must still import.
    ["legacy.csv", Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0d, 0x0a, 0x52, 0xe9, 0x6e, 0x75])],
    ["notes.txt", Buffer.from("hello\n")],
    ["intro.mp4", mp4],
    ["intro.m4v", mp4],
    ["intro.3gp", mp4],
    ["intro.mov", mov],
    ["old.mov", oldMov],
    ["intro.webm", webm],
  ];
  it.each(accept)("accepts %s", (name, data) => {
    expect(() => sniffUpload(name, data)).not.toThrow();
  });

  it("accepts a real exceljs-generated workbook", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRow(["Name", "Mobile"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(sniffUpload("dump.xlsx", buf).contentType).toMatch(/spreadsheetml/);
  });

  const reject: [string, Buffer, RegExp][] = [
    ["cv.pdf", Buffer.from("pdf"), /doesn't look like a real PDF/],
    ["cv.pdf", exe, /doesn't look like a real PDF/],
    ["cv.docx", pdf, /real Word \(\.docx\)/],
    ["cv.doc", zip, /real Word \(\.doc\)/],
    ["dump.xlsx", csv, /real Excel/],
    ["dump.csv", zip, /real CSV/],
    ["dump.csv", Buffer.from([0x41, 0x00, 0x42]), /real CSV/],
    ["dump.csv", Buffer.from([0x41, 0x01, 0x02, 0x42]), /real CSV/],
    ["intro.mp4", webm, /real MP4/],
    ["intro.webm", mp4, /real WebM/],
    ["cv.pdf", Buffer.alloc(0), /empty/],
    ["cv.exe", exe, /\.exe files can't be uploaded/],
    ["page.html", html, /\.html files can't be uploaded/],
    ["dump.xls", ole, /\.xls files can't be uploaded/],
    ["noext", pdf, /no recognised extension/],
  ];
  it.each(reject)("rejects %s with mismatched/unsupported content", (name, data, msg) => {
    let err: unknown;
    try {
      sniffUpload(name, data);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(msg);
  });
});

// ---------- fake clamd ----------
type Mode = "ok" | "found" | "hang";
async function fakeClamd(mode: Mode) {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = "zINSTREAM\0";
      if (buf.length < cmd.length) return;
      if (buf.subarray(0, cmd.length).toString("latin1") !== cmd) return sock.end("UNKNOWN COMMAND\0");
      // Parse frames; stop at the zero-length terminator.
      let off = cmd.length;
      const chunks: Buffer[] = [];
      while (buf.length >= off + 4) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          const payload = Buffer.concat(chunks);
          received.push(payload);
          if (mode === "hang") return;
          const infected = mode === "found" || payload.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
          return sock.end(infected ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
        }
        if (buf.length < off + 4 + len) return;
        chunks.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port; // nothing listens here any more → ECONNREFUSED
}

describe("ClamAV scanning (fake clamd)", () => {
  let dir: string;
  const saved = { host: process.env.CLAMAV_HOST, port: process.env.CLAMAV_PORT, t: process.env.CLAMAV_TIMEOUT_MS };
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nt-storage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("CLAMAV_HOST", saved.host);
    restore("CLAMAV_PORT", saved.port);
    restore("CLAMAV_TIMEOUT_MS", saved.t);
    resetClamAvWarning();
  });

  it("frames the stream in chunks and reports OK", async () => {
    const clamd = await fakeClamd("ok");
    try {
      const big = Buffer.concat([pdf, Buffer.alloc(200_000, 0x61)]);
      expect(await scanBuffer(big, { host: "127.0.0.1", port: clamd.port, chunkSize: 4096 })).toEqual({ clean: true });
      expect(clamd.received[0].equals(big)).toBe(true);
    } finally {
      await clamd.close();
    }
  });

  it("reports the signature on FOUND", async () => {
    const clamd = await fakeClamd("ok");
    try {
      expect(await scanBuffer(Buffer.from(EICAR), { host: "127.0.0.1", port: clamd.port })).toEqual({ clean: false, signature: "Eicar-Test-Signature" });
    } finally {
      await clamd.close();
    }
  });

  it("put() stores a clean file only after sniff + scan pass", async () => {
    const clamd = await fakeClamd("ok");
    process.env.CLAMAV_HOST = "127.0.0.1";
    process.env.CLAMAV_PORT = String(clamd.port);
    try {
      const s = new LocalStorage(dir);
      const key = await s.put("resumes", "My CV (final).pdf", pdf);
      expect(key).toMatch(/^resumes\/[0-9a-f-]{36}-My_CV_final_.pdf$/);
      expect((await s.get(key)).equals(pdf)).toBe(true);
      expect(clamd.received).toHaveLength(1);
      await s.delete(key);
      await expect(s.get(key)).rejects.toThrow();
      await s.delete(key); // idempotent
    } finally {
      await clamd.close();
    }
  });

  it("put() rejects an infected file with a 422 and writes nothing", async () => {
    const clamd = await fakeClamd("found");
    process.env.CLAMAV_HOST = "127.0.0.1";
    process.env.CLAMAV_PORT = String(clamd.port);
    try {
      const err = await new LocalStorage(path.join(dir, "infected")).put("resumes", "cv.pdf", pdf).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe("File rejected: malware detected");
      await expect(stat(path.join(dir, "infected"))).rejects.toMatchObject({ code: "ENOENT" }); // directory never created
    } finally {
      await clamd.close();
    }
  });

  it("does not scan (or store) files that fail sniffing", async () => {
    const clamd = await fakeClamd("ok");
    process.env.CLAMAV_HOST = "127.0.0.1";
    process.env.CLAMAV_PORT = String(clamd.port);
    try {
      await expect(new LocalStorage(dir).put("resumes", "cv.pdf", exe)).rejects.toBeInstanceOf(ValidationError);
      expect(clamd.received).toHaveLength(0);
    } finally {
      await clamd.close();
    }
  });

  it("fails closed with 503 when clamd is unreachable", async () => {
    process.env.CLAMAV_HOST = "127.0.0.1";
    process.env.CLAMAV_PORT = String(await freePort());
    await expect(scanBuffer(pdf, { host: "127.0.0.1", port: Number(process.env.CLAMAV_PORT) })).rejects.toBeInstanceOf(ClamAvUnavailableError);
    const err = await new LocalStorage(dir).put("resumes", "cv.pdf", pdf).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(503);
    expect(err.message).toBe("Upload scanning is temporarily unavailable, please try again");
  });

  it("fails closed with 503 when clamd never answers (timeout)", async () => {
    const clamd = await fakeClamd("hang");
    process.env.CLAMAV_HOST = "127.0.0.1";
    process.env.CLAMAV_PORT = String(clamd.port);
    process.env.CLAMAV_TIMEOUT_MS = "300";
    try {
      const err = await new LocalStorage(dir).put("resumes", "cv.pdf", pdf).catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(503);
    } finally {
      await clamd.close();
    }
  });

  it("skips scanning when CLAMAV_HOST is unset", async () => {
    delete process.env.CLAMAV_HOST;
    const s = new LocalStorage(dir);
    const key = await s.put("imports", "dump.csv", csv);
    expect((await s.get(key)).equals(csv)).toBe(true);
  });
});

describe("LocalStorage keys", () => {
  it("refuses path traversal and odd keys", async () => {
    const s = new LocalStorage(path.join(os.tmpdir(), "nt-storage-keys"));
    for (const k of ["../etc/passwd", "resumes/../../x", "/etc/passwd", "a\\b", "", "a//b"]) await expect(s.get(k)).rejects.toThrow(/Invalid key/);
    await expect(s.delete("../x")).rejects.toThrow(/Invalid key/);
    await expect(s.put("../up", "cv.pdf", pdf)).rejects.toThrow(/Invalid storage prefix/);
  });

  it("selects the driver from STORAGE_DRIVER without touching the network", () => {
    expect(createStorage({ STORAGE_DRIVER: "local", UPLOAD_DIR: "/tmp/x" })).toBeInstanceOf(LocalStorage);
    expect(createStorage({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toBeInstanceOf(S3Storage);
    expect(() => createStorage({ STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
  });
});

// ---------- S3 / MinIO (opt-in: set S3_TEST_ENDPOINT, e.g. http://localhost:9010) ----------
const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT;
describe.skipIf(!S3_ENDPOINT)("S3Storage against MinIO", () => {
  const bucket = `nt-test-${Date.now()}`;
  const s3 = new S3Storage({
    bucket,
    region: "us-east-1",
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "minio",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "minio12345",
    // MinIO only honours SSE-S3 when a KMS is configured; S3_TEST_SSE=AES256 exercises it when it is.
    serverSideEncryption: process.env.S3_TEST_SSE === "AES256" ? "AES256" : null,
  });
  beforeAll(async () => {
    delete process.env.CLAMAV_HOST;
    await s3.client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  it("puts, gets and deletes an object with a safe Content-Type", async () => {
    const key = await s3.put("resumes", "cv.pdf", pdf);
    expect(key).toMatch(/^resumes\/[0-9a-f-]{36}-cv\.pdf$/);
    expect((await s3.get(key)).equals(pdf)).toBe(true);
    const head = await s3.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(head.ContentType).toBe("application/pdf");
    await s3.delete(key);
    await expect(s3.get(key)).rejects.toThrow();
    await s3.delete(key); // idempotent
  });

  it("applies sniffing before writing", async () => {
    await expect(s3.put("resumes", "cv.pdf", exe)).rejects.toBeInstanceOf(ValidationError);
    await expect(s3.get("../x")).rejects.toThrow(/Invalid key/);
  });
});
