/**
 * read-zip.ts — a minimal, pure-Bun ZIP reader for `.pptx` output.
 *
 * Lives in `lib/` rather than `__tests__/helpers/` because `ooxml-lint.ts` is a
 * shipped module and needs it: the acceptance tests and the validity gate must
 * read a deck through exactly one reader, or they can disagree about what the
 * file contains.
 *
 * `Bun.Archive` cannot do this: probed 2026-08-21 with raw bytes, a `Bun.file`,
 * and a path — all three answer `Unrecognized archive format` for a zip, while a
 * `.tgz` is accepted. Since OOXML IS a zip, the acceptance test walks local file
 * headers itself and inflates through `DecompressionStream("deflate-raw")`.
 * Roughly 25 lines, no dependency, and it keeps the test suite browser-free and
 * shell-free (no `unzip` subprocess to be missing on some CI image).
 */

const LOCAL_FILE_HEADER = 0x04034b50;

/** One archive member, in the order the archive lists it. */
export interface ZipEntry {
  name: string;
  /** Inflated bytes. `method` is not exposed: consumers want content. */
  data: Uint8Array;
  /** True for a trailing-slash directory marker, which carries no content. */
  directory: boolean;
}

/**
 * Every entry, **in archive order**, inflated.
 *
 * Order is part of the contract, not an accident: OOXML consumers expect
 * `[Content_Types].xml` first, so anything that rebuilds an archive
 * (`write-zip.ts`) must be able to preserve the order it read.
 */
export async function readZipEntries(bytes: Uint8Array): Promise<ZipEntry[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ZipEntry[] = [];
  const decoder = new TextDecoder();
  let i = 0;
  while (i + 30 <= bytes.length && dv.getUint32(i, true) === LOCAL_FILE_HEADER) {
    const method = dv.getUint16(i + 8, true);
    const compressedSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = decoder.decode(bytes.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, start + compressedSize);
    const data =
      method === 0
        ? new Uint8Array(raw)
        : new Uint8Array(
            await new Response(
              // Copy into a fresh ArrayBuffer-backed view: a subarray of a
              // possibly-SharedArrayBuffer is not a valid BlobPart to TS.
              new Blob([new Uint8Array(raw)]).stream().pipeThrough(
                new DecompressionStream("deflate-raw")
              )
            ).arrayBuffer()
          );
    out.push({ name, data, directory: name.endsWith("/") });
    i = start + compressedSize;
  }
  return out;
}

/** Read every entry of a ZIP archive as text, keyed by entry name. */
export async function readZipText(bytes: Uint8Array): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (const entry of await readZipEntries(bytes)) {
    // A trailing "/" marks a DIRECTORY entry, not a part. It carries no bytes
    // and is not listed in [Content_Types].xml, so skipping it here spares
    // every consumer the filter — including the validity gate, which would
    // otherwise report each directory as an uninventoried part.
    if (entry.directory) continue;
    out[entry.name] = decoder.decode(entry.data);
  }
  return out;
}

/** Count non-overlapping matches — the assertion primitive for slide XML. */
export function count(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}
