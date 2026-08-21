/**
 * write-zip.ts — a minimal, pure-Bun ZIP **writer**, the mirror of `read-zip.ts`.
 *
 * ## Why this module has to exist
 *
 * P1 of `.planning/2026-08-21-archify-deck-visual-fidelity`: stroke-only icons
 * render as star bursts because `<a:path>` defaults to `fill="norm"`, so every
 * open subpath is closed and filled. Fixing that needs `<a:path fill="none">`,
 * and **pptxgenjs@4.0.1 cannot emit it** — its path element is a hardcoded
 * template literal (`` `<a:path w="${cx}" h="${cy}">` ``) with no attribute
 * seam, and neither its dist nor its typings mention a path fill mode at all.
 * So the attribute has to be added after the fact, which means re-archiving.
 *
 * Three cheaper routes were probed on 2026-08-22 and all three are closed:
 *
 * - **`jszip`** (pptxgenjs's own zip layer) is bundled inside its dist rather
 *   than declared as a package edge, so it does not resolve from here.
 * - **`Bun.Archive.write`** exists but writes a **tar** even when the target is
 *   named `.zip` (probed: magic bytes are a tar name field, and `unzip` reports
 *   no end-of-central-directory). Consistent with `read-zip.ts`'s note that
 *   `Bun.Archive` cannot read a zip either.
 * - **Patching bytes in place** fails because `fill="none"` lengthens the part,
 *   which moves every subsequent local-header offset — i.e. it is this module
 *   with extra steps.
 *
 * ## Why it is small
 *
 * pptxgenjs writes with `compression: false` (its default, and archify does not
 * override it), so **all 59 entries of a built deck are STORE (method 0)** —
 * measured. A writer therefore needs no deflate: header, raw bytes, central
 * directory, EOCD, with CRC-32 the only computation. Deflate is deliberately
 * NOT implemented; `writeZip` would silently mis-declare a compressed entry, so
 * it only ever emits STORE and says so.
 *
 * Output is **deterministic** — fixed 1980-01-01 timestamps, entries in the
 * order given — so a rebuilt archive can be byte-compared in a test.
 */

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIR = 0x06054b50;

/** MS-DOS epoch (1980-01-01 00:00:00). A zero DOS date is not a valid date. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Bit 11 = the name and comment are UTF-8. OOXML part names can be non-ASCII. */
const FLAG_UTF8 = 0x0800;

const VERSION = 20; // 2.0 — the floor for a STORE entry with no zip64.

/** One member to write. `data` is stored verbatim; no compression is applied. */
export interface ZipInput {
  name: string;
  data: Uint8Array | string;
}

let CRC_TABLE: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry header carries. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a STORE-only ZIP archive from `entries`, in the order given.
 *
 * Throws rather than truncating if an entry exceeds the 4 GiB ZIP32 ceiling:
 * a silently corrupt `.pptx` is far worse than a loud failure, and no archify
 * output is anywhere near that size.
 */
export function writeZip(entries: ZipInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((e) => {
    const data = typeof e.data === "string" ? encoder.encode(e.data) : e.data;
    const name = encoder.encode(e.name);
    if (data.length > 0xffffffff || name.length > 0xffff) {
      throw new Error(`write-zip: entry ${JSON.stringify(e.name)} exceeds ZIP32 limits`);
    }
    return { name, data, crc: crc32(data) };
  });

  const localSize = prepared.reduce((n, p) => n + 30 + p.name.length + p.data.length, 0);
  const centralSize = prepared.reduce((n, p) => n + 46 + p.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(out.buffer);

  const offsets: number[] = [];
  let at = 0;
  for (const p of prepared) {
    offsets.push(at);
    dv.setUint32(at, LOCAL_FILE_HEADER, true);
    dv.setUint16(at + 4, VERSION, true);
    dv.setUint16(at + 6, FLAG_UTF8, true);
    dv.setUint16(at + 8, 0, true); // method: STORE
    dv.setUint16(at + 10, DOS_TIME, true);
    dv.setUint16(at + 12, DOS_DATE, true);
    dv.setUint32(at + 14, p.crc, true);
    dv.setUint32(at + 18, p.data.length, true); // compressed === uncompressed
    dv.setUint32(at + 22, p.data.length, true);
    dv.setUint16(at + 26, p.name.length, true);
    dv.setUint16(at + 28, 0, true); // extra field length
    out.set(p.name, at + 30);
    out.set(p.data, at + 30 + p.name.length);
    at += 30 + p.name.length + p.data.length;
  }

  const centralStart = at;
  for (const [i, p] of prepared.entries()) {
    dv.setUint32(at, CENTRAL_FILE_HEADER, true);
    dv.setUint16(at + 4, VERSION, true); // version made by
    dv.setUint16(at + 6, VERSION, true); // version needed
    dv.setUint16(at + 8, FLAG_UTF8, true);
    dv.setUint16(at + 10, 0, true); // method: STORE
    dv.setUint16(at + 12, DOS_TIME, true);
    dv.setUint16(at + 14, DOS_DATE, true);
    dv.setUint32(at + 16, p.crc, true);
    dv.setUint32(at + 20, p.data.length, true);
    dv.setUint32(at + 24, p.data.length, true);
    dv.setUint16(at + 28, p.name.length, true);
    dv.setUint16(at + 30, 0, true); // extra
    dv.setUint16(at + 32, 0, true); // comment
    dv.setUint16(at + 34, 0, true); // disk number start
    dv.setUint16(at + 36, 0, true); // internal attrs
    dv.setUint32(at + 38, 0, true); // external attrs
    dv.setUint32(at + 42, offsets[i]!, true);
    out.set(p.name, at + 46);
    at += 46 + p.name.length;
  }

  dv.setUint32(at, END_OF_CENTRAL_DIR, true);
  dv.setUint16(at + 4, 0, true); // this disk
  dv.setUint16(at + 6, 0, true); // disk with central directory
  dv.setUint16(at + 8, prepared.length, true);
  dv.setUint16(at + 10, prepared.length, true);
  dv.setUint32(at + 12, at - centralStart, true);
  dv.setUint32(at + 16, centralStart, true);
  dv.setUint16(at + 20, 0, true); // comment length

  return out;
}
