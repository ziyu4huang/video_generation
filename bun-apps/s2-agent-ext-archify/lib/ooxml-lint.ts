/**
 * ooxml-lint.ts — structural validity checks over a built `.pptx`.
 *
 * ## Why this exists
 *
 * Before this module the suite asserted exactly ONE structural property of the
 * generated OOXML: `<a:blip>` count is 0. Everything else — that the package
 * inventory is complete, that relationship ids resolve, that DrawingML child
 * elements are in their schema sequence — was true (measured 2026-08-21: all 36
 * parts well-formed, `custGeom` children correctly ordered) and gated by
 * nothing at all.
 *
 * ## Why not the real XSDs
 *
 * A full ECMA-376 validation means vendoring several MB of schema and depending
 * on a system `xmllint`. That was run once and kept as a receipt
 * (`receipts/archify-slide-composition-2026-08-21.md`); this module is the
 * permanent gate, covering the invariants a shape emitter actually breaks.
 *
 * That one-off run found exactly one real deviation, and it is deliberately NOT
 * a rule here: pptxgenjs emits `<p:notesMasterIdLst>` after `<p:sldIdLst>` in
 * `ppt/presentation.xml`, two positions later than CT_Presentation's sequence
 * allows. It is upstream's choice — their own source comments that the correct
 * position "causes warning in modern powerpoint!" — it predates this package's
 * composition work byte for byte, and every consumer tested accepts it. A gate
 * that fires on every build we produce is noise, and teaches people to stop
 * reading the linter.
 *
 * ## Which parser, and why it is split (measured on bun 1.4.0)
 *
 * `Bun.XML.parse` is 1.46x faster than `HTMLRewriter` here (0.229 ms vs
 * 0.335 ms on a 49 KB slide) and — unlike with SVG — OOXML gives it no
 * boolean-attribute trouble. Its one flaw is precise: children with DISTINCT tag
 * names keep document order (object key insertion order), children with
 * REPEATED tag names are collapsed into one array and their interleaving with
 * other tags is lost. A real path proves it:
 *
 *     in   moveTo, lnTo, quadBezTo, lnTo
 *     out  { "a:moveTo": {…}, "a:lnTo": [{…},{…}], "a:quadBezTo": {…} }
 *
 * So rules 1-6 use `Bun.XML` — including the two child-ORDER rules, whose
 * children are all distinct tags, making key order document order. Rule 7 is
 * about a repeated-tag sequence, so it uses `HTMLRewriter`, where streaming
 * makes document order structural. Four `preserveOrder`-style option spellings
 * were probed and are silently accepted no-ops; `__tests__/ooxml-lint.test.ts`
 * pins that finding so a future bun release that fixes it is noticed.
 */

export interface OoxmlDiagnostic {
  /** Zip entry the problem is in, e.g. `ppt/slides/slide2.xml`. */
  part: string;
  code:
    | "content-type-missing"
    | "rel-unresolved"
    | "emu-invalid"
    | "sppr-order"
    | "custgeom-order"
    | "font-size-range"
    | "shape-adjust-range"
    | "path-no-moveto";
  message: string;
}

type XNode = Record<string, unknown>;

/** The maximum EMU coordinate ECMA-376 allows (ST_Coordinate). */
const EMU_MAX = 27273042316900;

/** ST_TextFontSize, in hundredths of a point. */
const SZ_MIN = 100;
const SZ_MAX = 400000;

/**
 * A preset geometry's adjustment value is a percentage in hundred-thousandths.
 * ECMA-376 gives each preset its own range, but every shape archify emits takes
 * a 0..50000 corner/inset adjustment (`roundRect` caps at 50 % of the smaller
 * side), and NO preset accepts a negative one.
 *
 * This rule exists because an out-of-range adjustment is invisible to every
 * other check here — it is well-formed XML, in a correctly-ordered `spPr`, with
 * valid EMU — and yet it makes the preset's corner arcs self-intersect and
 * renders the shape as a star burst. That was P1 of
 * `.planning/2026-08-21-archify-deck-visual-fidelity`: 43 out-of-range values
 * across the two example decks, worst 317450, and a green suite throughout.
 */
const ADJ_MIN = 0;
const ADJ_MAX = 50000;

/** CT_ShapeProperties element sequence. Unlisted children are ignored. */
const SPPR_ORDER: Record<string, number> = {
  "a:xfrm": 0,
  "a:custGeom": 1,
  "a:prstGeom": 1,
  "a:noFill": 2,
  "a:solidFill": 2,
  "a:gradFill": 2,
  "a:blipFill": 2,
  "a:pattFill": 2,
  "a:grpFill": 2,
  "a:ln": 3,
  "a:effectLst": 4,
  "a:effectDag": 4,
  "a:scene3d": 5,
  "a:sp3d": 6,
  "a:extLst": 7,
};

/** CT_CustomGeometry2D element sequence. `pathLst` is required and last. */
const CUSTGEOM_ORDER: Record<string, number> = {
  "a:avLst": 0,
  "a:gdLst": 1,
  "a:ahLst": 2,
  "a:cxnLst": 3,
  "a:rect": 4,
  "a:pathLst": 5,
};

/** Child element tags of a Bun.XML node, in document order (distinct tags). */
function childTags(node: XNode): string[] {
  return Object.keys(node).filter((k) => !k.startsWith("@") && k !== "#text");
}

/**
 * Depth-first walk over a Bun.XML tree, calling back with (tag, node, parent).
 *
 * The parent tag is not a convenience: DrawingML reuses `<a:ext>` for two
 * unrelated types — `CT_PositiveSize2D` (cx/cy) under `<a:xfrm>`, and
 * `CT_OfficeArtExtension` (uri) under `<a:extLst>`. Checking for cx/cy without
 * looking at the parent reports every theme's extension list as broken.
 */
function visitElements(
  value: unknown,
  tag: string,
  parent: string | null,
  cb: (tag: string, node: XNode, parent: string | null) => void
): void {
  if (Array.isArray(value)) {
    for (const v of value) visitElements(v, tag, parent, cb);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as XNode;
  cb(tag, node, parent);
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@") || k === "#text") continue;
    visitElements(v, k, tag, cb);
  }
}

function parseXml(xml: string): XNode | null {
  try {
    return (Bun as unknown as { XML: { parse(s: string): XNode } }).XML.parse(xml) as XNode;
  } catch {
    return null;
  }
}

function forEachElement(
  xml: string,
  cb: (tag: string, node: XNode, parent: string | null) => void
): boolean {
  const doc = parseXml(xml);
  if (!doc) return false;
  for (const [tag, value] of Object.entries(doc)) visitElements(value, tag, null, cb);
  return true;
}

// ── rule 1: package inventory ────────────────────────────────────────────────

function lintContentTypes(parts: Record<string, string>, out: OoxmlDiagnostic[]): void {
  const ct = parts["[Content_Types].xml"];
  if (ct === undefined) {
    out.push({
      part: "[Content_Types].xml",
      code: "content-type-missing",
      message: "package has no [Content_Types].xml",
    });
    return;
  }
  const defaults = new Set<string>();
  const overrides = new Set<string>();
  forEachElement(ct, (tag, node) => {
    if (tag === "Default") {
      const ext = node["@Extension"];
      if (typeof ext === "string") defaults.add(ext.toLowerCase());
    } else if (tag === "Override") {
      const name = node["@PartName"];
      if (typeof name === "string") overrides.add(name);
    }
  });
  for (const name of Object.keys(parts)) {
    if (name === "[Content_Types].xml") continue;
    if (name.endsWith("/")) continue; // directory entry, not a part
    if (overrides.has(`/${name}`)) continue;
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (defaults.has(ext)) continue;
    out.push({
      part: name,
      code: "content-type-missing",
      message: `no Default for ".${ext}" and no Override for "/${name}" in [Content_Types].xml`,
    });
  }
}

// ── rule 2: relationship ids resolve ─────────────────────────────────────────

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
function relsPathFor(part: string): string {
  const i = part.lastIndexOf("/");
  const dir = i < 0 ? "" : part.slice(0, i + 1);
  const base = i < 0 ? part : part.slice(i + 1);
  return `${dir}_rels/${base}.rels`;
}

function relIdsIn(relsXml: string): Set<string> {
  const ids = new Set<string>();
  forEachElement(relsXml, (tag, node) => {
    if (tag !== "Relationship") return;
    const id = node["@Id"];
    if (typeof id === "string") ids.add(id);
  });
  return ids;
}

const REL_ATTRS = ["@r:id", "@r:embed", "@r:link", "@r:pict", "@r:dm", "@r:lo", "@r:qs", "@r:cs"];

function lintRelationships(parts: Record<string, string>, out: OoxmlDiagnostic[]): void {
  for (const [name, xml] of Object.entries(parts)) {
    if (!name.endsWith(".xml") || name === "[Content_Types].xml") continue;
    const referenced = new Set<string>();
    forEachElement(xml, (_tag, node) => {
      for (const attr of REL_ATTRS) {
        const v = node[attr];
        if (typeof v === "string" && v !== "") referenced.add(v);
      }
    });
    if (referenced.size === 0) continue;
    const relsXml = parts[relsPathFor(name)];
    const known = relsXml ? relIdsIn(relsXml) : new Set<string>();
    for (const id of referenced) {
      if (known.has(id)) continue;
      out.push({
        part: name,
        code: "rel-unresolved",
        message: `references relationship ${JSON.stringify(id)}, absent from ${relsPathFor(name)}`,
      });
    }
  }
}

// ── rules 3-6: per-element DrawingML checks ──────────────────────────────────

function checkOrder(
  tag: string,
  node: XNode,
  table: Record<string, number>,
  code: OoxmlDiagnostic["code"],
  part: string,
  out: OoxmlDiagnostic[]
): void {
  const seen = childTags(node)
    .filter((t) => t in table)
    .map((t) => ({ t, rank: table[t]! }));
  for (let i = 1; i < seen.length; i++) {
    if (seen[i]!.rank < seen[i - 1]!.rank) {
      out.push({
        part,
        code,
        message: `<${tag}> children out of schema sequence: ${seen.map((s) => s.t).join(", ")}`,
      });
      return;
    }
  }
}

function intAttr(node: XNode, name: string): { raw: string; value: number } | null {
  const raw = node[name];
  if (typeof raw !== "string") return null;
  return { raw, value: Number(raw) };
}

function lintDrawingML(part: string, xml: string, out: OoxmlDiagnostic[]): void {
  const ok = forEachElement(xml, (tag, node, parent) => {
    if (tag === "p:spPr" || tag === "a:spPr") {
      checkOrder(tag, node, SPPR_ORDER, "sppr-order", part, out);
      return;
    }
    if (tag === "a:custGeom") {
      checkOrder(tag, node, CUSTGEOM_ORDER, "custgeom-order", part, out);
      return;
    }
    // Only inside a transform: see `visitElements` on the two `<a:ext>` types.
    if (
      parent === "a:xfrm" &&
      (tag === "a:off" || tag === "a:ext" || tag === "a:chOff" || tag === "a:chExt")
    ) {
      const names = tag === "a:off" || tag === "a:chOff" ? ["@x", "@y"] : ["@cx", "@cy"];
      for (const n of names) {
        const got = intAttr(node, n);
        if (!got) {
          out.push({ part, code: "emu-invalid", message: `<${tag}> missing ${n}` });
          continue;
        }
        if (!Number.isInteger(got.value)) {
          out.push({
            part,
            code: "emu-invalid",
            message: `<${tag}> ${n}=${JSON.stringify(got.raw)} is not an integer EMU value`,
          });
          continue;
        }
        const negativeAllowed = tag === "a:off" || tag === "a:chOff";
        if (!negativeAllowed && got.value < 0) {
          out.push({
            part,
            code: "emu-invalid",
            message: `<${tag}> ${n}=${got.value} must not be negative`,
          });
          continue;
        }
        if (Math.abs(got.value) > EMU_MAX) {
          out.push({
            part,
            code: "emu-invalid",
            message: `<${tag}> ${n}=${got.value} exceeds the ST_Coordinate range`,
          });
        }
      }
      return;
    }
    if (tag === "a:gd" && parent === "a:avLst") {
      const value = /^val\s+(-?\d+)$/.exec(String(node["@fmla"] ?? ""))?.[1];
      if (value === undefined) return;
      const n = Number(value);
      if (!Number.isInteger(n) || n < ADJ_MIN || n > ADJ_MAX) {
        out.push({
          part,
          code: "shape-adjust-range",
          message:
            `<a:gd name=${JSON.stringify(String(node["@name"] ?? "?"))}> fmla="val ${n}" ` +
            `outside the [${ADJ_MIN}, ${ADJ_MAX}] adjustment range — a preset's ` +
            `corner arcs self-intersect past it and the shape renders as a burst`,
        });
      }
      return;
    }
    if (tag === "a:rPr" || tag === "a:defRPr" || tag === "a:endParaRPr") {
      const got = intAttr(node, "@sz");
      if (!got) return;
      if (!Number.isInteger(got.value) || got.value < SZ_MIN || got.value > SZ_MAX) {
        out.push({
          part,
          code: "font-size-range",
          message: `<${tag}> sz=${JSON.stringify(got.raw)} outside ST_TextFontSize [${SZ_MIN}, ${SZ_MAX}]`,
        });
      }
    }
  });
  if (!ok) {
    out.push({ part, code: "emu-invalid", message: "part is not parseable as XML" });
  }
}

// ── rule 7: a path starts where it is allowed to ─────────────────────────────

/**
 * `HTMLRewriter`, not `Bun.XML` — a path's children are REPEATED tags
 * (`lnTo` twice, interleaved with `quadBezTo`), which is exactly the case
 * `Bun.XML` collapses. Streaming makes document order structural, and document
 * order is all this check needs: an `<a:path>`'s first child element is the one
 * that immediately follows it.
 */
async function lintPathStarts(part: string, xml: string, out: OoxmlDiagnostic[]): Promise<void> {
  const stream: { tag: string; selfClosing: boolean }[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        stream.push({ tag: el.tagName.toLowerCase(), selfClosing: el.selfClosing });
      },
    })
    .transform(new Response(xml))
    .text();

  for (let i = 0; i < stream.length; i++) {
    const el = stream[i]!;
    if (el.tag !== "a:path" || el.selfClosing) continue;
    const next = stream[i + 1];
    if (!next || next.tag !== "a:moveto") {
      out.push({
        part,
        code: "path-no-moveto",
        message: `<a:path> #${i} starts with <${next?.tag ?? "nothing"}>; a path must open with <a:moveTo>`,
      });
    }
  }
}

/**
 * Lint an unzipped `.pptx` (entry name → text). Returns every diagnostic found;
 * an empty array means the package passed all seven rules.
 */
export async function lintPptx(parts: Record<string, string>): Promise<OoxmlDiagnostic[]> {
  const out: OoxmlDiagnostic[] = [];
  lintContentTypes(parts, out);
  lintRelationships(parts, out);
  for (const [name, xml] of Object.entries(parts)) {
    if (!name.endsWith(".xml")) continue;
    if (name === "[Content_Types].xml") continue;
    lintDrawingML(name, xml, out);
    await lintPathStarts(name, xml, out);
  }
  return out;
}

/** One line per diagnostic, for a CLI or a tool result. */
export function formatDiagnostics(diags: OoxmlDiagnostic[]): string {
  return diags.map((d) => `[${d.code}] ${d.part}: ${d.message}`).join("\n");
}
