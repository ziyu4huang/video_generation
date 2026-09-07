/**
 * pptx-canonical — normalize a built .pptx so two builds of the SAME deck
 * hash identically.
 *
 * Measured 2026-09-07 (see .planning/plans/2026-09-07-archify-eval-track3-pptx.md):
 * every pptx part is already byte-determined by the input — the ONLY
 * nondeterminism is container-level and comes from upstream:
 *   1. pptxgenjs writes `dcterms:created/modified = new Date().toISOString()`
 *      into docProps/core.xml,
 *   2. jszip stamps each zip entry with the current DOS date/time.
 * Canonicalization pins the two core.xml timestamps to a fixed epoch and
 * zeroes the DOS fields on rewrite (STORED re-emit via deck-render's zip
 * writer), so `sha256(canonicalize(a)) === sha256(canonicalize(b))` becomes
 * the testable statement of "the translation is deterministic".
 */
import { rewriteZipEntries } from "./deck-render.ts";
import { readZipText } from "./read-zip.ts";

const EPOCH = "2020-01-01T00:00:00.000Z";
const CORE = "docProps/core.xml";

/**
 * Return the canonical bytes of a pptx: same content parts, container
 * timestamps pinned. Throws when the archive is not a readable zip or has no
 * core.xml (nothing canonical to do — a caller feeding a non-pptx made a
 * mistake worth surfacing).
 */
export async function canonicalizePptx(bytes: Uint8Array): Promise<Uint8Array> {
  const parts = await readZipText(bytes);
  const core = parts[CORE];
  if (core === undefined) {
    throw new Error(`pptx-canonical: ${CORE} missing — not a pptxgenjs-built archive`);
  }
  // pptxgenjs writes both `dcterms:created` and `dcterms:modified` as ISO
  // strings; pin whatever their attribute shape is to one fixed epoch.
  const pinned = core.replace(
    /(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(<\/dcterms:)/g,
    `$1${EPOCH}$2`
  );
  if (pinned === core) {
    throw new Error(`pptx-canonical: no dcterms timestamps found in ${CORE} — unexpected shape`);
  }
  return rewriteZipEntries(bytes, { zeroDosDates: true, replace: { [CORE]: pinned } });
}
