/**
 * image-presentation.ts — pure helpers turning pipeline output paths into the
 * `/output/0/<rel>` markdown presentation convention (spec Component 5).
 *
 * The URL form matches the serving route (output-routes.ts): leading dir-index
 * "0/" (ignored there, canonical here) + the path RELATIVE to the output dir
 * with subpaths preserved (profile_TS/front.png). Videos are deliberately
 * EXCLUDED (.mp4/.mov/... — deferred fog): the v1 convention is image
 * presentation; the route still serves videos for manual browsing.
 *
 * Pure: node:path only — no Bun, no fs, no cross-package imports.
 */
import * as path from "node:path";

/** Image extensions eligible for the ![image] presentation convention. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Markdown for one output image: `![image](/output/0/<rel>)` where <rel> is
 * `absPath` relative to `outputDir` (separators normalized to "/"). Null when
 * the path is not an image, escapes the dir, or IS the dir itself.
 */
export function imageMd(absPath: string, outputDir: string): string | null {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  const rel = path.relative(path.resolve(outputDir), path.resolve(absPath));
  // Escape check: reject exactly ".." or anything under a leading "../"
  // component — NOT a bare startsWith(".."), which would wrongly reject a
  // legitimate in-dir file literally named "..foo.png".
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  // Percent-encode AFTER separator normalization: marked rejects raw spaces in
  // link destinations (ledger [P4-final]); encodeURI keeps "/" and balanced
  // parens intact, and the /output route decodeURIComponent round-trips it.
  return `![image](/output/0/${encodeURI(rel.split(path.sep).join("/"))})`;
}

/** Narrow shape an outputs[] entry may take (the flux2/ltx `{path}` form). */
interface PathCarrier {
  path?: unknown;
}

/**
 * All presentable image markdown from a tool-result `details` payload:
 * `details.output` (string, optional) first, then every `details.outputs[]`
 * entry (a string OR an object with a string `.path` — the shape that rendered
 * "[object Object]" when naively interpolated). Deduped, image-filtered,
 * order-preserving. `[]` when nothing presentable.
 */
export function imageMdFromDetails(details: unknown, outputDir: string): string[] {
  if (typeof details !== "object" || details === null) return [];
  const d = details as { output?: unknown; outputs?: unknown };
  const candidates: string[] = [];
  if (typeof d.output === "string") candidates.push(d.output);
  if (Array.isArray(d.outputs)) {
    for (const entry of d.outputs) {
      if (typeof entry === "string") candidates.push(entry);
      else if (typeof entry === "object" && entry !== null) {
        const p = (entry as PathCarrier).path;
        if (typeof p === "string") candidates.push(p);
      }
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const md = imageMd(candidate, outputDir);
    if (md === null || seen.has(md)) continue;
    seen.add(md);
    out.push(md);
  }
  return out;
}
