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

/** Read every entry of a ZIP archive as text, keyed by entry name. */
export async function readZipText(bytes: Uint8Array): Promise<Record<string, string>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, string> = {};
  const decoder = new TextDecoder();
  let i = 0;
  while (i + 30 <= bytes.length && dv.getUint32(i, true) === LOCAL_FILE_HEADER) {
    const method = dv.getUint16(i + 8, true);
    const compressedSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = decoder.decode(bytes.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    const data = bytes.subarray(start, start + compressedSize);
    // A trailing "/" marks a DIRECTORY entry, not a part. It carries no bytes
    // and is not listed in [Content_Types].xml, so returning it makes every
    // consumer filter it out — including the validity gate, which would
    // otherwise report each directory as an uninventoried part.
    if (name.endsWith("/")) {
      i = start + compressedSize;
      continue;
    }
    out[name] =
      method === 0
        ? decoder.decode(data)
        : await new Response(
            // Copy into a fresh ArrayBuffer-backed view: a subarray of a
            // possibly-SharedArrayBuffer is not a valid BlobPart to TS.
            new Blob([new Uint8Array(data)]).stream().pipeThrough(
              new DecompressionStream("deflate-raw")
            )
          ).text();
    i = start + compressedSize;
  }
  return out;
}

/** Count non-overlapping matches — the assertion primitive for slide XML. */
export function count(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}
