/**
 * layout-template.ts — a `*.layout.json` becomes a producer of `PlacedBlock[]`.
 *
 * A template is data; everything that could be got wrong lives here, once:
 * region geometry, stack/repeat division, inset application, binding
 * resolution. The template FILE contains no number that depends on a count and
 * no expression string — four primitives (`region` / `stack` / `repeat` /
 * `box`) and enumerated binding tokens only (effort decision D1), which is
 * what keeps it JSON-Schema-validatable.
 *
 * Blocks are built with the same shared constructors `layouts.ts` uses and
 * wear the same chrome, so a template's output is indistinguishable from a
 * code layout's and `formatBlocks()` prints both the same way. Every check is
 * a LOAD-time error naming the source file, the JSON path and what was
 * expected — render time is too late to learn about a typo.
 *
 * Same discipline as `layouts.ts`: no pptxgenjs import, no colour literal, no
 * emitter import. A template decides WHERE and WHAT; the theme and emitters
 * decide how it looks and how it is drawn.
 */
import { CONTENT, STAGE, TYPE_SCALE, PALETTES, type TypeSpec } from "./deck-theme.ts";
import { at, text } from "./blocks.ts";
import { chrome } from "./layouts.ts";
import {
  SLIDE_LAYOUTS,
  normalizeBullets,
  type BulletItem,
  type InchBox,
  type LayoutCtx,
  type PlacedBlock,
  type Slide,
} from "./slide-model.ts";

/** A template authoring failure with the file, JSON path and expectation. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** A named hole a template declares and a slide fills. */
export interface SlotSpec {
  kind: "text" | "array";
  /** Array slots: the item fields a `from` token may name; trailing `?` = optional. */
  of?: string[];
  min?: number;
  max?: number;
  required?: boolean;
  description?: string;
}

export interface LoadedTemplate {
  name: string;
  description: string;
  slots: Record<string, SlotSpec>;
  roles: Record<string, TypeSpec>;
  /** Absolute path this template was loaded from, for the catalog. */
  source: string;
  render(slide: Slide, ctx: LayoutCtx): PlacedBlock[];
}

// ── compiled node shapes ─────────────────────────────────────────────────────

type Align = "left" | "center" | "right";
type VAlign = "top" | "middle" | "bottom";
type BoxSpec = "fill" | { inset: [number, number, number, number] };
type RegionName = "content" | "full";

interface ContentSpec {
  kind: "text" | "bullets" | "diagram" | "rule" | "panel" | "table";
  role?: string;
  from?: string;
  /** `table` only: one binding each for the column names and the row arrays. */
  headerRole?: string;
  columns?: string;
  rows?: string;
  tone?: "tag" | "section";
}

/** A node bound to an already-resolved scope. */
type ScopeNode =
  | { op: "stack"; dir: "row" | "col"; weights: number[]; gap: number; children: Node[] }
  | { op: "repeat"; over: string; flow: "row" | "col"; gap: number; max?: number; cell: Node[] }
  | { op: "box"; box: BoxSpec; content: ContentSpec; align?: Align; valign?: VAlign };

/** A root node names its region; nested nodes inherit their scope. */
type Node = ScopeNode | { op: "region"; region: RegionName; child: ScopeNode };

const KNOWN_KINDS = ["text", "bullets", "diagram", "rule", "panel", "table"] as const;

const REGIONS: readonly RegionName[] = ["content", "full"];
const ALIGNMENTS = ["left", "center", "right"] as const;
const VALIGNMENTS = ["top", "middle", "bottom"] as const;

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const BINDING_TOKEN = /\{([^{}]+)\}/g;

const PALETTE_KEYS: ReadonlySet<string> = new Set(Object.keys(PALETTES.light));

function fail(source: string, path: string, expected: string): never {
  throw new TemplateError(`${source} ${path}: ${expected}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── load-time compilation ────────────────────────────────────────────────────

interface CompileCtx {
  source: string;
  /** Every field any array slot declares — the `{field}` vocabulary. */
  fields: ReadonlySet<string>;
  /** Every declared array slot name — what `repeat.over` may name. */
  arraySlots: ReadonlySet<string>;
}

function compileRoles(raw: unknown, source: string): Record<string, TypeSpec> {
  if (raw === undefined) return {};
  if (!isObject(raw)) fail(source, ".roles", "expected an object keyed by role name");
  const out: Record<string, TypeSpec> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const path = `.roles.${name}`;
    if (!isObject(entry)) fail(source, path, "expected an object");
    if (entry.color !== undefined && (typeof entry.color !== "string" || !PALETTE_KEYS.has(entry.color))) {
      fail(
        source,
        `${path}.color`,
        `expected a Palette key (one of ${[...PALETTE_KEYS].sort().join(", ")})`
      );
    }
    const builtin: TypeSpec | undefined = TYPE_SCALE[name as keyof typeof TYPE_SCALE];
    if (!builtin && (entry.sizePt === undefined || entry.color === undefined)) {
      fail(source, path, "a role not in the builtin type scale must carry `sizePt` and `color`");
    }
    const spec: TypeSpec = { ...(builtin ?? {}), ...pick(entry) } as TypeSpec;
    if (!finiteNumber(spec.sizePt) || spec.sizePt <= 0) {
      fail(source, `${path}.sizePt`, "expected a positive number of points");
    }
    out[name] = spec;
  }
  return out;
}

const ROLE_KEYS = ["sizePt", "bold", "color", "tracking", "lineSpacing", "autofit"] as const;

function pick(entry: Record<string, unknown>): Partial<TypeSpec> {
  const out: Record<string, unknown> = {};
  for (const k of ROLE_KEYS) if (entry[k] !== undefined) out[k] = entry[k];
  return out as Partial<TypeSpec>;
}

function compileSlots(raw: unknown, source: string): Record<string, SlotSpec> {
  if (raw === undefined) return {};
  if (!isObject(raw)) fail(source, ".slots", "expected an object keyed by slot name");
  const out: Record<string, SlotSpec> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const path = `.slots.${name}`;
    if (!isObject(entry)) fail(source, path, "expected an object");
    if (entry.kind !== "text" && entry.kind !== "array") {
      fail(source, `${path}.kind`, `expected "text" or "array", got ${JSON.stringify(entry.kind)}`);
    }
    const spec: SlotSpec = { kind: entry.kind };
    if (entry.of !== undefined) {
      if (spec.kind !== "array") fail(source, `${path}.of`, "`of` belongs to array slots only");
      if (!Array.isArray(entry.of) || entry.of.some((f) => typeof f !== "string")) {
        fail(source, `${path}.of`, "expected an array of field-name strings");
      }
      spec.of = entry.of as string[];
    }
    for (const k of ["min", "max"] as const) {
      if (entry[k] !== undefined) {
        if (!finiteNumber(entry[k]) || !Number.isInteger(entry[k]) || (entry[k] as number) < 1) {
          fail(source, `${path}.${k}`, "expected a positive integer");
        }
        spec[k] = entry[k] as number;
      }
    }
    if (entry.required !== undefined) {
      if (typeof entry.required !== "boolean") fail(source, `${path}.required`, "expected a boolean");
      spec.required = entry.required;
    }
    if (entry.description !== undefined) {
      if (typeof entry.description !== "string") fail(source, `${path}.description`, "expected a string");
      spec.description = entry.description;
    }
    out[name] = spec;
  }
  return out;
}

/**
 * The `{...}` vocabulary: `{field}` (declared by some array slot), `{slide.<key>}`,
 * `{index0}`, `{index1}`. A literal with no braces is used verbatim.
 */
function validateFrom(from: string, path: string, ctx: CompileCtx): void {
  for (const match of from.matchAll(BINDING_TOKEN)) {
    const tok = match[1]!;
    const ok =
      tok === "index0" ||
      tok === "index1" ||
      tok.startsWith("slide.") ||
      ctx.fields.has(tok);
    if (!ok) {
      fail(
        ctx.source,
        `${path}.from`,
        `unknown binding {${tok}} — expected a declared slot field, {slide.<key>}, {index0} or {index1}`
      );
    }
  }
  if (from.replace(BINDING_TOKEN, "").match(/[{}]/)) {
    fail(ctx.source, `${path}.from`, `malformed binding braces in ${JSON.stringify(from)}`);
  }
}

function compileContent(raw: unknown, path: string, ctx: CompileCtx): ContentSpec {
  if (!isObject(raw)) fail(ctx.source, `${path}.content`, "expected an object");
  const kind = raw.kind;
  if (typeof kind !== "string" || !KNOWN_KINDS.includes(kind as never)) {
    fail(
      ctx.source,
      `${path}.content.kind`,
      `unknown drawing primitive ${JSON.stringify(kind)} — no emitter knows it; expected one of ${KNOWN_KINDS.join(", ")}`
    );
  }
  const spec: ContentSpec = { kind: kind as ContentSpec["kind"] };
  switch (kind) {
    case "text":
    case "bullets":
      if (typeof raw.role !== "string" || raw.role === "") {
        fail(ctx.source, `${path}.content.role`, `a "${kind}" block needs a role name`);
      }
      spec.role = raw.role;
      if (typeof raw.from !== "string") {
        fail(ctx.source, `${path}.content.from`, `a "${kind}" block needs a \`from\` binding`);
      }
      validateFrom(raw.from, `${path}.content`, ctx);
      if (kind === "bullets" && !/^(\{[^{}]+\})$/.test(raw.from.trim())) {
        fail(
          ctx.source,
          `${path}.content.from`,
          `a "bullets" block's \`from\` must be exactly one binding (it resolves to an array)`
        );
      }
      spec.from = raw.from;
      break;
    case "diagram":
      if (typeof raw.from !== "string") {
        fail(ctx.source, `${path}.content.from`, `a "diagram" block needs a \`from\` binding for its IR path`);
      }
      validateFrom(raw.from, `${path}.content`, ctx);
      spec.from = raw.from;
      break;
    case "table":
      if (typeof raw.role !== "string" || raw.role === "") {
        fail(ctx.source, `${path}.content.role`, `a "table" block needs a body role name`);
      }
      spec.role = raw.role;
      if (typeof raw.headerRole !== "string" || raw.headerRole === "") {
        fail(ctx.source, `${path}.content.headerRole`, `a "table" block needs a headerRole name`);
      }
      spec.headerRole = raw.headerRole;
      // Each resolves to an array off the slide, so exactly one binding each —
      // the same discipline a "bullets" block already follows.
      for (const k of ["columns", "rows"] as const) {
        const v = raw[k];
        if (typeof v !== "string" || !/^(\{[^{}]+\})$/.test(v.trim())) {
          fail(
            ctx.source,
            `${path}.content.${k}`,
            `a "table" block's \`${k}\` must be exactly one binding (it resolves to an array)`
          );
        }
        validateFrom(v, `${path}.content`, ctx);
        spec[k] = v;
      }
      break;
    case "panel":
      if (raw.tone !== "tag" && raw.tone !== "section") {
        fail(ctx.source, `${path}.content.tone`, `expected "tag" or "section"`);
      }
      spec.tone = raw.tone;
      break;
    case "rule":
      break;
  }
  return spec;
}

function compileBoxSpec(raw: unknown, path: string, source: string): BoxSpec {
  if (raw === "fill") return "fill";
  if (!isObject(raw) || !Array.isArray(raw.inset)) {
    fail(source, `${path}.box`, `expected "fill" or {"inset": [left, top, right, bottom]}`);
  }
  const inset = raw.inset;
  if (inset.length !== 4 || !inset.every(finiteNumber)) {
    fail(source, `${path}.box.inset`, "expected four finite numbers [left, top, right, bottom]");
  }
  return { inset: inset as [number, number, number, number] };
}

function compileNode(raw: unknown, path: string, ctx: CompileCtx, isRoot: boolean): Node {
  if (!isObject(raw)) fail(ctx.source, path, "expected an object");

  // Region binding is root-only, validated BEFORE the primitive dispatch so a
  // `{region, box}` node can never silently drop its region.
  const regionRaw = raw.region;
  if (regionRaw !== undefined) {
    if (!isRoot) {
      fail(ctx.source, `${path}.region`, "`region` binds a root body node — nested scopes come from stack/repeat/box");
    }
    if (regionRaw !== "content" && regionRaw !== "full") {
      fail(
        ctx.source,
        `${path}.region`,
        `unknown region ${JSON.stringify(regionRaw)} — expected one of ${REGIONS.join(", ")}`
      );
    }
  }
  if (isRoot && regionRaw === undefined) {
    fail(ctx.source, `${path}.region`, "a root body node must bind a region — `content` or `full`");
  }

  const drivers = ["stack", "repeat", "box"].filter((k) => raw[k] !== undefined);
  if (drivers.length === 0) {
    fail(ctx.source, path, "expected one of `stack` / `repeat` / `box` (+ `region` at the top of body)");
  }
  if (drivers.length > 1) {
    fail(ctx.source, path, `exactly one primitive per node, found ${drivers.join(" + ")}`);
  }

  let child: ScopeNode;
  if (raw.stack !== undefined) {
    const s = raw.stack;
    if (!isObject(s)) fail(ctx.source, `${path}.stack`, "expected an object");
    if (s.dir !== "row" && s.dir !== "col") {
      fail(ctx.source, `${path}.stack.dir`, `expected "row" or "col", got ${JSON.stringify(s.dir)}`);
    }
    const weights = s.weights;
    if (!Array.isArray(weights) || weights.length < 2 || !weights.every((w) => finiteNumber(w) && w > 0)) {
      fail(ctx.source, `${path}.stack.weights`, "expected two or more positive numbers");
    }
    if (!finiteNumber(s.gap) || s.gap < 0) {
      fail(ctx.source, `${path}.stack.gap`, "expected a non-negative number of inches");
    }
    if (!Array.isArray(raw.children) || raw.children.length !== (weights as unknown[]).length) {
      fail(
        ctx.source,
        `${path}.children`,
        `expected one child per weight (${(weights as unknown[]).length})`
      );
    }
    child = {
      op: "stack",
      dir: s.dir,
      weights: weights as number[],
      gap: s.gap,
      children: (raw.children as unknown[]).map((c, i) =>
        compileNode(c, `${path}.children[${i}]`, ctx, false)
      ),
    };
  } else if (raw.repeat !== undefined) {
    const r = raw.repeat;
    if (!isObject(r)) fail(ctx.source, `${path}.repeat`, "expected an object");
    if (typeof r.over !== "string" || r.over === "") {
      fail(ctx.source, `${path}.repeat.over`, "expected a slot name");
    }
    if (!ctx.arraySlots.has(r.over)) {
      fail(
        ctx.source,
        `${path}.repeat.over`,
        `"${r.over}" is not a declared array slot — declare it in \`slots\` with kind "array"`
      );
    }
    if (r.flow !== "row" && r.flow !== "col") {
      fail(ctx.source, `${path}.repeat.flow`, `expected "row" or "col", got ${JSON.stringify(r.flow)}`);
    }
    if (!finiteNumber(r.gap) || r.gap < 0) {
      fail(ctx.source, `${path}.repeat.gap`, "expected a non-negative number of inches");
    }
    if (r.max !== undefined && (!finiteNumber(r.max) || !Number.isInteger(r.max) || r.max < 1)) {
      fail(ctx.source, `${path}.repeat.max`, "expected a positive integer");
    }
    if (!Array.isArray(raw.cell) || raw.cell.length === 0) {
      fail(ctx.source, `${path}.cell`, "expected a non-empty array of cell nodes");
    }
    child = {
      op: "repeat",
      over: r.over,
      flow: r.flow,
      gap: r.gap,
      ...(r.max !== undefined ? { max: r.max } : {}),
      cell: (raw.cell as unknown[]).map((c, i) => compileNode(c, `${path}.cell[${i}]`, ctx, false)),
    };
  } else if (raw.box !== undefined) {
    if (raw.content === undefined) {
      fail(ctx.source, `${path}.content`, "a box node needs content to place");
    }
    child = {
      op: "box",
      box: compileBoxSpec(raw.box, path, ctx.source),
      content: compileContent(raw.content, path, ctx),
      ...optAlign(raw, path, ctx.source),
    };
  } else {
    fail(ctx.source, path, "expected one of `stack` / `repeat` / `box`");
  }
  return regionRaw === undefined ? child : { op: "region", region: regionRaw as RegionName, child };
}

function optAlign(raw: Record<string, unknown>, path: string, source: string): { align?: Align; valign?: VAlign } {
  const out: { align?: Align; valign?: VAlign } = {};
  if (raw.align !== undefined) {
    if (!ALIGNMENTS.includes(raw.align as never)) {
      fail(source, `${path}.align`, `expected one of ${ALIGNMENTS.join(", ")}`);
    }
    out.align = raw.align as Align;
  }
  if (raw.valign !== undefined) {
    if (!VALIGNMENTS.includes(raw.valign as never)) {
      fail(source, `${path}.valign`, `expected one of ${VALIGNMENTS.join(", ")}`);
    }
    out.valign = raw.valign as VAlign;
  }
  return out;
}

// ── render-time resolution — all arithmetic lives here ──────────────────────

interface Bindings {
  slide: Slide;
  item?: unknown;
  index0?: number;
  index1?: number;
}

function resolveString(tpl: string, b: Bindings): string {
  if (!tpl.includes("{")) return tpl;
  return tpl.replace(BINDING_TOKEN, (_, tok: string) => {
    if (tok === "index0") return String(b.index0 ?? "");
    if (tok === "index1") return String(b.index1 ?? "");
    if (tok.startsWith("slide.")) {
      const v = (b.slide as unknown as Record<string, unknown>)[tok.slice("slide.".length)];
      return v === undefined || v === null ? "" : String(v);
    }
    if (b.item !== null && typeof b.item === "object") {
      const v = (b.item as Record<string, unknown>)[tok];
      return v === undefined || v === null ? "" : String(v);
    }
    return "";
  });
}

function resolveBullets(tpl: string, b: Bindings): BulletItem[] {
  const tok = /^(\{[^{}]+\})$/.exec(tpl.trim())?.[1];
  if (!tok) return [];
  const inner = tok.slice(1, -1);
  let v: unknown;
  if (inner.startsWith("slide.")) v = (b.slide as unknown as Record<string, unknown>)[inner.slice(6)];
  else if (b.item !== null && typeof b.item === "object") v = (b.item as Record<string, unknown>)[inner];
  if (!Array.isArray(v)) return [];
  return normalizeBullets(v as Slide["bullets"]);
}

/** One binding → the raw array it names off the slide or repeat item. */
function resolveArray(tpl: string, b: Bindings): unknown[] {
  const tok = /^(\{[^{}]+\})$/.exec(tpl.trim())?.[1];
  if (!tok) return [];
  const inner = tok.slice(1, -1);
  let v: unknown;
  if (inner.startsWith("slide.")) v = (b.slide as unknown as Record<string, unknown>)[inner.slice(6)];
  else if (b.item !== null && typeof b.item === "object") v = (b.item as Record<string, unknown>)[inner];
  return Array.isArray(v) ? v : [];
}

/** The takeaway-aware content well, or full bleed. */
function regionBox(name: RegionName, slide: Slide): InchBox {
  if (name === "full") return { x: 0, y: 0, w: STAGE.w, h: STAGE.h };
  const y = slide.takeaway ? 1.5 : 1.4;
  return { x: 0.5, y, w: CONTENT.w, h: 7.0 - y - 0.5 };
}

function applyInset(scope: InchBox, spec: BoxSpec): InchBox {
  if (spec === "fill") return { ...scope };
  const [l, t, r, b] = spec.inset;
  return { x: scope.x + l, y: scope.y + t, w: scope.w - l - r, h: scope.h - t - b };
}

function buildBlock(node: Extract<ScopeNode, { op: "box" }>, scope: InchBox, b: Bindings): PlacedBlock {
  const box = applyInset(scope, node.box);
  const c = node.content;
  switch (c.kind) {
    case "text":
      return text(box, c.role!, resolveString(c.from!, b), node.align, node.valign);
    case "bullets":
      return at(
        box,
        { kind: "bullets", role: c.role!, items: resolveBullets(c.from!, b) },
        node.align,
        node.valign
      );
    case "diagram":
      return at(box, { kind: "diagram", ir: resolveString(c.from!, b) }, node.align, node.valign);
    case "panel":
      return at(box, { kind: "panel", tone: c.tone! }, node.align, node.valign);
    case "table": {
      const columns = resolveArray(c.columns!, b).map((v) => String(v));
      const rows = resolveArray(c.rows!, b).map((row) =>
        Array.isArray(row) ? row.map((v) => String(v)) : [String(row)]
      );
      return at(
        box,
        { kind: "table", columns, rows, role: c.role!, headerRole: c.headerRole! },
        node.align,
        node.valign
      );
    }
    case "rule":
      return at(box, { kind: "rule" }, node.align, node.valign);
  }
}

function walkNode(node: Node, scope: InchBox, b: Bindings, out: PlacedBlock[]): void {
  const scoped: ScopeNode = node.op === "region" ? node.child : node;
  switch (scoped.op) {
    case "stack": {
      const n = scoped.children.length;
      const gapTotal = scoped.gap * (n - 1);
      const totalWeight = scoped.weights.reduce((a, w) => a + w, 0);
      const usable = (scoped.dir === "col" ? scope.w : scope.h) - gapTotal;
      let cursor = scoped.dir === "col" ? scope.x : scope.y;
      scoped.children.forEach((child, i) => {
        const size = (usable * scoped.weights[i]!) / totalWeight;
        const cellScope: InchBox =
          scoped.dir === "col"
            ? { x: cursor, y: scope.y, w: size, h: scope.h }
            : { x: scope.x, y: cursor, w: scope.w, h: size };
        walkNode(child, cellScope, b, out);
        cursor += size + scoped.gap;
      });
      return;
    }
    case "repeat": {
      const raw = (b.slide as unknown as Record<string, unknown>)[scoped.over];
      const items = Array.isArray(raw) ? raw : [];
      const n = Math.min(items.length, scoped.max ?? items.length);
      if (n === 0) return;
      const gapTotal = scoped.gap * (n - 1);
      const span = (scoped.flow === "row" ? scope.w : scope.h) - gapTotal;
      const cellSize = span / n;
      let cursor = scoped.flow === "row" ? scope.x : scope.y;
      for (let i = 0; i < n; i++) {
        const cellScope: InchBox =
          scoped.flow === "row"
            ? { x: cursor, y: scope.y, w: cellSize, h: scope.h }
            : { x: scope.x, y: cursor, w: scope.w, h: cellSize };
        const cellBindings: Bindings = {
          slide: b.slide,
          item: items[i],
          index0: i,
          index1: i + 1,
        };
        for (const cellNode of scoped.cell) walkNode(cellNode, cellScope, cellBindings, out);
        cursor += cellSize + scoped.gap;
      }
      return;
    }
    case "box":
      out.push(buildBlock(scoped, scope, b));
      return;
  }
}

// ── the one export ───────────────────────────────────────────────────────────

export function loadTemplate(json: unknown, source: string): LoadedTemplate {
  if (!isObject(json)) fail(source, "$", "expected a JSON object");

  if (typeof json.name !== "string" || !NAME_PATTERN.test(json.name)) {
    fail(source, ".name", `expected a string matching ${NAME_PATTERN.source}`);
  }
  const name: string = json.name;
  if ((SLIDE_LAYOUTS as readonly string[]).includes(name)) {
    fail(
      source,
      ".name",
      `"${name}" is a code layout — templates may not shadow code layouts (decision D3)`
    );
  }
  if (typeof json.description !== "string" || json.description === "") {
    fail(source, ".description", "expected a non-empty string — it is what the catalog shows the agent");
  }

  const chromeSpec = json.chrome ?? true;
  if (
    chromeSpec !== true &&
    chromeSpec !== false &&
    !(isObject(chromeSpec) && Object.keys(chromeSpec).length === 1 && chromeSpec.title === false)
  ) {
    fail(source, ".chrome", `expected true, false, or {"title": false}`);
  }

  const slots = compileSlots(json.slots, source);
  const roles = compileRoles(json.roles, source);

  const fields = new Set<string>();
  const arraySlots = new Set<string>();
  for (const [slotName, slot] of Object.entries(slots)) {
    if (slot.kind !== "array") continue;
    arraySlots.add(slotName);
    for (const f of slot.of ?? []) fields.add(f.replace(/\?$/, ""));
  }
  const ctx: CompileCtx = { source, fields, arraySlots };

  if (!Array.isArray(json.body) || json.body.length === 0) {
    fail(source, ".body", "expected a non-empty array of nodes");
  }
  const body: Node[] = (json.body as unknown[]).map((n, i) => compileNode(n, `.body[${i}]`, ctx, true));
  // compileNode guarantees every root node carries `op: "region"`.
  const roots = body as { op: "region"; region: RegionName; child: ScopeNode }[];

  function render(slide: Slide, layoutCtx: LayoutCtx): PlacedBlock[] {
    const blocks: PlacedBlock[] = [];
    if (chromeSpec === true) blocks.push(...chrome(slide, layoutCtx));
    else if (isObject(chromeSpec)) blocks.push(...chrome(slide, layoutCtx, { title: false }));
    const bindings: Bindings = { slide };
    for (const root of roots) {
      walkNode(root, regionBox(root.region, slide), bindings, blocks);
    }
    return blocks;
  }

  return { name, description: json.description, slots, roles, source, render };
}
