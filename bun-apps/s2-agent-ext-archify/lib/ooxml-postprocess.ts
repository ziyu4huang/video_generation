/**
 * ooxml-postprocess.ts — the one thing pptxgenjs cannot say, said afterwards.
 *
 * P1 of `.planning/2026-08-21-archify-deck-visual-fidelity`. A stroke-only icon
 * needs BOTH halves of "do not paint me":
 *
 * 1. **Shape level** — `<a:noFill/>` in `<p:spPr>`. Reachable through the
 *    library, by OMITTING `fill` (see `pptx-shapes.ts` `fillOf`). Already fixed
 *    there, and **measured insufficient on its own**: with the shape-level fix
 *    alone the rendered icons were pixel-identical star bursts.
 * 2. **Path level** — `<a:path fill="none">`. `ST_PathFillMode` defaults to
 *    `norm`, so each subpath is closed and filled *even on a no-fill shape*,
 *    and two open chevrons filled that way IS the burst. Not reachable: the
 *    library's path element is a hardcoded template literal.
 *
 * This module supplies (2) by rewriting the emitted part. See `write-zip.ts`
 * for why re-archiving is the only route.
 *
 * ## The scoping rule, and why it is not "every path"
 *
 * `fill="none"` is applied **only inside a `<p:sp>` whose own `<p:spPr>` carries
 * `<a:noFill/>`**. A filled custGeom — a rounded node body, a legend chip with a
 * background — must keep `fill="norm"` or it would render as an outline. So the
 * shape-level fill is the authority and the path level merely stops contradicting
 * it; the two halves are one decision expressed twice, which is a DrawingML
 * quirk rather than a design of ours.
 *
 * `<a:noFill/>` also occurs inside `<a:ln>` (a stroke-less line), so the check
 * strips line properties before looking. The `<a:ln` prefix is matched with a
 * word boundary on purpose: `<a:lnTo>` is a path segment and appears dozens of
 * times inside the very geometry being inspected.
 */
import { readZipEntries } from "./read-zip.ts";
import { writeZip, type ZipInput } from "./write-zip.ts";

/** `<a:ln …>…</a:ln>` — NOT `<a:lnTo>`, hence the explicit word boundary. */
const LINE_PROPS = /<a:ln(?:\s[^>]*)?>[\s\S]*?<\/a:ln>|<a:ln(?:\s[^>]*)?\/>/g;
const SHAPE = /<p:sp>[\s\S]*?<\/p:sp>/g;
const SHAPE_PROPS = /<p:spPr>[\s\S]*?<\/p:spPr>/;
/** An `<a:path …>` that does not already declare a fill mode. */
const PATH_WITHOUT_FILL = /<a:path\b(?![^>]*\bfill=)/g;

export interface PatchResult {
  /** Slide parts whose XML changed. */
  parts: string[];
  /** How many `<a:path>` elements gained `fill="none"`. */
  paths: number;
}

/**
 * Add `fill="none"` to every `<a:path>` belonging to a no-fill shape.
 *
 * Pure string work on one part's XML; exported so the assertion can drive it
 * directly without building a deck.
 */
export function patchStrokeOnlyPaths(xml: string): { xml: string; paths: number } {
  let paths = 0;
  const out = xml.replace(SHAPE, (shape) => {
    const props = SHAPE_PROPS.exec(shape)?.[0];
    if (!props) return shape;
    // Line properties carry their own <a:noFill/>; only the SHAPE's counts.
    if (!/<a:noFill\s*\/>/.test(props.replace(LINE_PROPS, ""))) return shape;
    return shape.replace(PATH_WITHOUT_FILL, (m) => {
      paths++;
      return `${m} fill="none"`;
    });
  });
  return { xml: out, paths };
}

/**
 * Apply `patchStrokeOnlyPaths` to every slide part of a `.pptx` and re-archive.
 *
 * Returns the original bytes untouched when nothing matched, so a deck with no
 * stroke-only geometry is not needlessly rewritten — and so the rebuild path is
 * exercised only when it has something to do.
 */
export async function patchPptxStrokeOnlyPaths(
  bytes: Uint8Array
): Promise<{ bytes: Uint8Array; result: PatchResult }> {
  const entries = await readZipEntries(bytes);
  const decoder = new TextDecoder();
  const result: PatchResult = { parts: [], paths: 0 };
  const rebuilt: ZipInput[] = [];

  for (const entry of entries) {
    if (entry.directory) {
      rebuilt.push({ name: entry.name, data: entry.data });
      continue;
    }
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(entry.name)) {
      rebuilt.push({ name: entry.name, data: entry.data });
      continue;
    }
    const original = decoder.decode(entry.data);
    const { xml, paths } = patchStrokeOnlyPaths(original);
    if (paths > 0) {
      result.parts.push(entry.name);
      result.paths += paths;
    }
    rebuilt.push({ name: entry.name, data: xml === original ? entry.data : xml });
  }

  if (result.paths === 0) return { bytes, result };
  return { bytes: writeZip(rebuilt), result };
}
