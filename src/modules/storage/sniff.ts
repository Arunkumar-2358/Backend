import { ValidationError } from "@/lib/errors";

/**
 * Magic-byte content sniffing for uploads. A file is accepted only when its extension is one we
 * support AND its leading bytes match that format, so a renamed executable/HTML/script can't be
 * stored as a "resume.pdf". This is a cheap structural check, not a parser — ClamAV runs after it.
 */

type Kind = { label: string; contentType: string; matches: (b: Buffer) => boolean };

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" — OOXML (.docx/.xlsx) containers
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy Office (.doc)
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // Matroska / WebM
const PDF = Buffer.from("%PDF-", "latin1");

const startsWith = (b: Buffer, sig: Buffer) => b.length >= sig.length && b.subarray(0, sig.length).equals(sig);
/** ISO base media (MP4 family): a box size then "ftyp" at offset 4. */
const isoBmff = (b: Buffer) => b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp";
/** Older QuickTime files may start with another top-level atom instead of ftyp. */
const QT_ATOMS = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);
const quickTime = (b: Buffer) => b.length >= 8 && QT_ATOMS.has(b.toString("latin1", 4, 8));
/** PDF readers tolerate a little junk before the header; the spec allows it within the first 1 KB. */
const pdf = (b: Buffer) => b.subarray(0, 1024).includes(PDF);

/**
 * Plain text: no NUL bytes and no other binary control characters. Deliberately not
 * "valid UTF-8": CSVs exported from older Excel are Windows-1252 and must still import.
 */
function isText(b: Buffer) {
  for (const byte of b.subarray(0, 64 * 1024)) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) return false;
  }
  return true;
}

const KINDS: Record<string, Kind> = {
  pdf: { label: "PDF", contentType: "application/pdf", matches: pdf },
  docx: { label: "Word (.docx) document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", matches: (b) => startsWith(b, ZIP) },
  xlsx: { label: "Excel (.xlsx) spreadsheet", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", matches: (b) => startsWith(b, ZIP) },
  doc: { label: "Word (.doc) document", contentType: "application/msword", matches: (b) => startsWith(b, OLE) },
  csv: { label: "CSV file", contentType: "text/csv; charset=utf-8", matches: isText },
  txt: { label: "text file", contentType: "text/plain; charset=utf-8", matches: isText },
  mp4: { label: "MP4 video", contentType: "video/mp4", matches: isoBmff },
  m4v: { label: "M4V video", contentType: "video/x-m4v", matches: isoBmff },
  "3gp": { label: "3GP video", contentType: "video/3gpp", matches: isoBmff },
  mov: { label: "MOV video", contentType: "video/quicktime", matches: quickTime },
  webm: { label: "WebM video", contentType: "video/webm", matches: (b) => startsWith(b, EBML) },
};

export const ALLOWED_UPLOAD_EXTENSIONS = Object.keys(KINDS);

export function extensionOf(fileName: string) {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Safe Content-Type for a stored object, from our own extension map (never from the client). */
export function contentTypeFor(fileName: string) {
  return KINDS[extensionOf(fileName)]?.contentType ?? "application/octet-stream";
}

/**
 * Throws ValidationError unless `data` really is the kind of file its name claims.
 * Returns the detected extension and Content-Type.
 */
export function sniffUpload(fileName: string, data: Buffer): { ext: string; contentType: string } {
  const ext = extensionOf(fileName);
  const kind = KINDS[ext];
  if (!kind) {
    const allowed = "PDF, DOC, DOCX, XLSX, CSV, TXT, MP4, MOV, M4V, 3GP or WebM";
    throw new ValidationError(ext ? `.${ext} files can't be uploaded — please use ${allowed}` : `That file has no recognised extension — please use ${allowed}`);
  }
  if (!data.length) throw new ValidationError("That file is empty");
  if (!kind.matches(data))
    throw new ValidationError(`That file doesn't look like a real ${kind.label} — it may be damaged or renamed from another format. Please upload the original file.`);
  return { ext, contentType: kind.contentType };
}
