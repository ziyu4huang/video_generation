/**
 * deck-render.ts — `pptx → N images`, portably, as a tool and never as a gate.
 *
 * Effort `archify-deck-visual-fidelity` ticket 05, spec §2.5 + §3 D1–D3:
 *
 * - **D1** — the renderer sees, it never gates. Nothing here is imported by
 *   `buildDeck`, no test asserts on an image, and no CI step runs a backend.
 *   The seam exists so a human can LOOK at a deck on whatever machine they are
 *   on; the committed receipt (see `receipts/`) is the durable evidence.
 * - **D2** — the seam is `pptx → N images`. The two backends reach N images by
 *   genuinely different routes and callers never learn which ran: the return
 *   value is always `slide-N.png`, one per slide, in deck order.
 * - **D3** — no golden-pixel baselines. Rendered PNGs are renderer-version and
 *   font dependent and never belong in git; the receipt records what was seen,
 *   not what must be seen again.
 *
 * Shell-free zip handling on purpose: `read-zip.ts` already walks local file
 * headers in pure Bun because "no unzip subprocess that might be missing on
 * some CI image"; the writer here keeps the same posture. The only subprocess
 * each backend spawns is the renderer binary itself (`qlmanage` / `soffice` /
 * `pdftoppm`), which `available()` has already probed by name.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DeckError } from "./deck-build.ts";

/** Stable image naming contract: `slide-1.png` … `slide-N.png` (D2). */
export function slideImageName(n: number): string {
  return `slide-${n}.png`;
}

/** Default output directory for `deck render`, mirroring `defaultSlidesDir`. */
export function defaultRendersDir(outputPath: string): string {
  return outputPath.replace(/\.pptx$/i, "") + ".renders";
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer — enough to replace ONE entry of a `.pptx`
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (PKZIP). Pinned by a known vector in deck-render.test.ts. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  /** Decompressed bytes. The repack re-emits every entry STORED. */
  data: Uint8Array;
  /** DOS date/time fields, carried over so the copy still looks like the file. */
  dosTime: number;
  dosDate: number;
}

/**
 * Walk local file headers (same discipline as `readZipText`, byte-level).
 * Data-descriptor (flag bit 3) zips would have zeroed sizes here; pptxgenjs's
 * jszip output carries real sizes in the local header, which is why
 * `readZipText` already relies on exactly these fields today.
 */
function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let i = 0;
  while (i + 30 <= bytes.length && dv.getUint32(i, true) === 0x04034b50) {
    const flags = dv.getUint16(i + 6, true);
    const method = dv.getUint16(i + 8, true);
    const dosTime = dv.getUint16(i + 10, true);
    const dosDate = dv.getUint16(i + 12, true);
    const compressedSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = decoder.decode(bytes.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, start + compressedSize);
    if ((flags & 0x8) !== 0) {
      throw new DeckError(
        `deck render: zip entry ${name} uses a data descriptor — this repacker does not support streamed archives`
      );
    }
    if (!name.endsWith("/")) {
      entries.push({
        name,
        dosTime,
        dosDate,
        data:
          method === 0
            ? new Uint8Array(raw)
            : new Uint8Array(
                await0(
                  new Blob([new Uint8Array(raw)]).stream().pipeThrough(
                    new DecompressionStream("deflate-raw")
                  )
                )
              ),
      });
    }
    i = start + compressedSize;
  }
  if (entries.length === 0) throw new DeckError("deck render: not a readable zip (no local file headers)");
  return entries;
}

/** Drain a stream synchronously-ish — readZipText's blob trick, byte form. */
function await0(stream: ReadableStream<Uint8Array>): Uint8Array {
  // Bun supports sync file writes but not sync stream drains; the caller is
  // async-adjacent anyway, so use the Response text trick's sibling: read all
  // chunks via getReader in a microtask-free loop driven by Bun's sync
  // `Bun.readableStreamToArray` where available, else throw.
  if (typeof (Bun as { readableStreamToArray?: unknown }).readableStreamToArray === "function") {
    const chunks = (Bun as unknown as {
      readableStreamToArray: (s: ReadableStream<Uint8Array>) => Uint8Array[];
    }).readableStreamToArray(stream);
    const len = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
  throw new DeckError("deck render: no sync stream drain available");
}

/**
 * Replace (or add) one entry of a zip archive, re-emitting every entry STORED.
 * The archive grows (no deflate on the way out); the copies are throwaway
 * render inputs, and STORED keeps the writer small enough to audit.
 */
export function repackZipEntry(
  bytes: Uint8Array,
  name: string,
  content: Uint8Array | string
): Uint8Array {
  const replacement = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const entries = readZipEntries(bytes).map((e) =>
    e.name === name ? { ...e, data: replacement } : e
  );
  if (!entries.some((e) => e.name === name)) entries.push({ name, data: replacement, dosTime: 0, dosDate: 0 });

  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + nameBytes.length + e.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: STORED
    lv.setUint16(10, e.dosTime, true);
    lv.setUint16(12, e.dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);
    local.set(e.data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method: STORED
    cv.setUint16(12, e.dosTime, true);
    cv.setUint16(14, e.dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + eocd.length);
  let o = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quick Look route: promote slide N to the front, thumbnail the copy
// ---------------------------------------------------------------------------

/**
 * Rewrite `presentation.xml`'s `<p:sldIdLst>` so slide N is FIRST.
 *
 * Quick Look thumbnails only the first slide of a deck (measured, spec §2.5).
 * Rather than rebuilding N one-slide decks from a manifest — which needs the
 * manifest, re-runs the vendored renderer, and pictures a DIFFERENT file than
 * the one on disk — the deck is copied N times and each copy's slide order is
 * rotated. Every part stays exactly as built; the throwaway copy merely starts
 * somewhere else. Measured 2026-08-22: `qlmanage` renders the first entry of
 * `sldIdLst`, not the lowest id and not the first part name.
 */
export function promoteSlideFirst(
  presentationXml: string,
  presentationRelsXml: string,
  slideNumber: number
): string {
  const relMatch = presentationRelsXml.match(
    new RegExp(`<Relationship\\b[^>]*Target="slides/slide${slideNumber}\\.xml"[^>]*/>`)
  );
  if (!relMatch) {
    throw new DeckError(`deck render: slide ${slideNumber} not referenced in ppt/_rels/presentation.xml.rels`);
  }
  const idMatch = relMatch[0].match(/Id="([^"]+)"/);
  if (!idMatch) {
    throw new DeckError(`deck render: slide ${slideNumber} relationship carries no Id`);
  }
  const rid = idMatch[1];
  const listMatch = presentationXml.match(/<p:sldIdLst>(.*?)<\/p:sldIdLst>/);
  if (!listMatch) throw new DeckError("deck render: presentation.xml has no <p:sldIdLst>");
  const entries = listMatch[1]!.match(/<p:sldId\b[^>]*\/>/g);
  if (!entries) throw new DeckError("deck render: <p:sldIdLst> is empty");
  const target = entries.find((e) => e.includes(`r:id="${rid}"`));
  if (!target) {
    throw new DeckError(`deck render: r:id ${rid} (slide ${slideNumber}) missing from <p:sldIdLst>`);
  }
  const reordered = [target, ...entries.filter((e) => e !== target)].join("");
  return presentationXml.replace(/<p:sldIdLst>.*?<\/p:sldIdLst>/, `<p:sldIdLst>${reordered}</p:sldIdLst>`);
}

/** Count `ppt/slides/slideN.xml` parts the way `sldIdLst` orders them. */
export function countSlides(parts: Record<string, string>): number {
  const numbers = Object.keys(parts)
    .map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export type RendererId = "quicklook" | "libreoffice";

export interface RenderOptions {
  /** Longest image edge in px (quicklook) / scale-to px (libreoffice). */
  size?: number;
}

export interface DeckRenderer {
  readonly id: RendererId;
  /** Probe, never throw: `false` means "not on this machine", not an error. */
  available(): boolean;
  /** Render every slide of `pptx` into `outDir` as `slide-N.png`. */
  renderSlides(pptx: string, outDir: string, opts?: RenderOptions): Promise<string[]>;
}

/** One line per backend: what it is, whether it can run, what it looked for. */
export function rendererStatus(): { id: RendererId; available: boolean; looksFor: string[] }[] {
  return [
    { id: "quicklook", available: QUICKLOOK.available(), looksFor: ["darwin", "qlmanage"] },
    { id: "libreoffice", available: LIBREOFFICE.available(), looksFor: ["soffice", "pdftoppm"] },
  ];
}

/**
 * `Bun.which` with an explicit PATH: the optionless form snapshots the startup
 * PATH and ignores later `process.env.PATH` changes, which would make the
 * probe untestable and stale for a caller that manages PATH itself.
 */
function onPath(cmd: string): boolean {
  return Bun.which(cmd, { PATH: process.env.PATH ?? "" }) !== null;
}

/** Preference order: native first, cross-platform second, nothing last. */
export function pickRenderer(): DeckRenderer | null {
  if (QUICKLOOK.available()) return QUICKLOOK;
  if (LIBREOFFICE.available()) return LIBREOFFICE;
  return null;
}

/** `qlmanage -t` — darwin only, zero install. */
export const QUICKLOOK: DeckRenderer = {
  id: "quicklook",
  available() {
    return process.platform === "darwin" && onPath("qlmanage");
  },
  async renderSlides(pptx, outDir, opts) {
    const size = opts?.size ?? 1600;
    const bytes = new Uint8Array(await Bun.file(pptx).arrayBuffer());
    const parts = await readParts(bytes);
    const count = countSlides(parts);
    if (count === 0) throw new DeckError(`deck render: no slides found in ${pptx}`);
    if (!parts["ppt/presentation.xml"] || !parts["ppt/_rels/presentation.xml.rels"]) {
      throw new DeckError(`deck render: ${basename(pptx)} lacks the presentation parts this seam rewrites`);
    }
    mkdirSync(outDir, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), "archify-render-"));
    try {
      const written: string[] = [];
      for (let n = 1; n <= count; n++) {
        const promoted = promoteSlideFirst(
          parts["ppt/presentation.xml"]!,
          parts["ppt/_rels/presentation.xml.rels"]!,
          n
        );
        const copyPath = join(work, `slide-${n}.pptx`);
        await Bun.write(copyPath, repackZipEntry(bytes, "ppt/presentation.xml", promoted));
        await run(["qlmanage", "-t", "-s", String(size), "-o", work, copyPath]);
        const produced = join(work, `slide-${n}.pptx.png`);
        if (!(await Bun.file(produced).exists())) {
          throw new DeckError(`deck render: qlmanage produced no thumbnail for slide ${n}`);
        }
        const dest = join(outDir, slideImageName(n));
        renameSync(produced, dest);
        written.push(dest);
      }
      return written;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};

/** `soffice → pdf → pdftoppm` — any platform with both on PATH. Unmeasured here. */
export const LIBREOFFICE: DeckRenderer = {
  id: "libreoffice",
  available() {
    return onPath("soffice") && onPath("pdftoppm");
  },
  async renderSlides(pptx, outDir, opts) {
    const size = opts?.size ?? 1600;
    const work = mkdtempSync(join(tmpdir(), "archify-render-"));
    try {
      await run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", work, pptx]);
      const pdf = join(work, basename(pptx).replace(/\.pptx$/i, "") + ".pdf");
      if (!(await Bun.file(pdf).exists())) {
        throw new DeckError(`deck render: soffice wrote no pdf for ${basename(pptx)}`);
      }
      await run(["pdftoppm", "-png", "-scale-to", String(size), pdf, join(work, "page")]);
      mkdirSync(outDir, { recursive: true });
      const written: string[] = [];
      for (const f of Array.from(new Bun.Glob("page-*.png").scanSync({ cwd: work })).sort(byPageNumber)) {
        const n = Number(/^page-(\d+)\.png$/.exec(f)![1]);
        const dest = join(outDir, slideImageName(n));
        renameSync(join(work, f), dest);
        written.push(dest);
      }
      if (written.length === 0) throw new DeckError("deck render: pdftoppm produced no pages");
      return written;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};

function byPageNumber(a: string, b: string): number {
  return Number(/(\d+)\.png$/.exec(a)![1]) - Number(/(\d+)\.png$/.exec(b)![1]);
}

/** Read every part as text — the same single reader the lint gates use. */
async function readParts(bytes: Uint8Array): Promise<Record<string, string>> {
  const { readZipText } = await import("./read-zip.ts");
  return readZipText(bytes);
}

/** Run a renderer binary; a nonzero exit is a user-facing DeckError, never a stack. */
async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new DeckError(
      `deck render: ${cmd[0]} exited ${exitCode}${stderr ? `\n${stderr.trim()}` : stdout ? `\n${stdout.trim()}` : ""}`
    );
  }
}
