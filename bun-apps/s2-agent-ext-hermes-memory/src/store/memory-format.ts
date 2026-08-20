/**
 * Backend-neutral pure memory formatting / parsing helpers.
 *
 * This module is deliberately free of any DB coupling — no `bun:sqlite`, no
 * `SqliteBackend`, no driver calls. It exists so that upstream callers
 * (`index.ts`, `handlers/*`, `tools/*`) can format and parse memory entries
 * without importing a SQLite implementation module, preserving the
 * backend-abstraction seam established by the repository refactor.
 *
 * The SQLite repository (`store/sqlite/sqlite-memory-repo.ts`) imports these
 * same helpers back from here — they were originally defined inline in that
 * file and were moved out to keep the seam clean (DRY: single source of truth).
 */

import { stringify as stringifyYaml } from "yaml";
import type { FailureState, MemoryCategory, Provenance, MemorySource } from "../types.js";
import type { MemoryTarget } from "./repository.js";
import { splitFencedYaml } from "@repo/s2-agent-core-interface";

// ---------------------------------------------------------------------------
// Pure helpers (copied verbatim from the former sqlite-memory-store.ts).
// ---------------------------------------------------------------------------

export const FAILURE_CATEGORY_SET = new Set<MemoryCategory>([
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
]);

export function today(): string {
  return new Date().toISOString().split("T")[0];
}

export function normalizeNullable(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCategory(value?: MemoryCategory | null): MemoryCategory | null {
  return value ?? null;
}

// Failure-lifecycle helpers (state + severity live in frontmatter, mirrored to
// DB columns exactly like category/status/md_id).
const FAILURE_STATES: ReadonlySet<string> = new Set(["active", "resolved", "acquired"]);

/** Coerce an unknown frontmatter value to a valid `FailureState`; anything
 *  missing or unrecognized falls back to the safe default `active` (never
 *  silently hide a failure). */
export function normalizeFailureState(v: unknown): FailureState {
  return typeof v === "string" && FAILURE_STATES.has(v) ? (v as FailureState) : "active";
}

/** Coerce an unknown frontmatter value to a `pin` boolean. Pin is STRICT: only
 *  the literal boolean `true` counts (absent / false / any truthy-but-not-true
 *  value → unpinned). A pinned entry is never eligible for overflow-driven
 *  eviction (purge of superseded entries, vault-offload FIFO). */
export function normalizePin(v: unknown): boolean {
  return v === true;
}

/** Initial state inferred from category for stateless legacy entries:
 *  permanent facts (tool-quirk / convention) graduate straight to `acquired`;
 *  everything else starts `active` (candidate for injection). */
export function defaultStateForCategory(c: MemoryCategory | null): FailureState {
  return c === "tool-quirk" || c === "convention" ? "acquired" : "active";
}

export function parseMetadataComment(raw: string): {
  text: string;
  created: string;
  lastReferenced: string;
  provenance?: Provenance;
  sources?: MemorySource[];
  mwSuccess?: number;
  mwFail?: number;
} {
  let rest = raw;
  let provenance: Provenance | undefined;
  let sources: MemorySource[] | undefined;
  let mwSuccess: number | undefined;
  let mwFail: number | undefined;

  // Stage 1: optional trailing <!-- meta:{...} --> (always last).
  const metaMatch = rest.match(/<!--\s*meta:(\{.*\})\s*-->\s*$/);
  if (metaMatch && metaMatch.index !== undefined) {
    try {
      const parsed = JSON.parse(metaMatch[1]) as { provenance?: Provenance; sources?: MemorySource[]; mwSuccess?: number; mwFail?: number };
      provenance = parsed.provenance;
      sources = Array.isArray(parsed.sources) ? parsed.sources : undefined;
      mwSuccess = typeof parsed.mwSuccess === "number" ? parsed.mwSuccess : undefined;
      mwFail = typeof parsed.mwFail === "number" ? parsed.mwFail : undefined;
    } catch {
      // malformed meta — ignore, keep created/last below
    }
    rest = rest.slice(0, metaMatch.index).trimEnd();
  }

  // Stage 2: unchanged created/last regex on the remainder.
  const match = rest.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^>]+)\s*-->\s*$/);
  if (match) {
    return {
      text: match[1].trim(),
      created: match[2].trim(),
      lastReferenced: match[3].trim(),
      ...(provenance ? { provenance } : {}),
      ...(sources ? { sources } : {}),
      ...(typeof mwSuccess === "number" ? { mwSuccess } : {}),
      ...(typeof mwFail === "number" ? { mwFail } : {}),
    };
  }

  const fallback = today();
  return {
    text: rest.trim(),
    created: fallback,
    lastReferenced: fallback,
    ...(provenance ? { provenance } : {}),
    ...(sources ? { sources } : {}),
    ...(typeof mwSuccess === "number" ? { mwSuccess } : {}),
    ...(typeof mwFail === "number" ? { mwFail } : {}),
  };
}

export function serializeMetadataComment(input: {
  text: string;
  created: string;
  lastReferenced: string;
  provenance?: Provenance | null;
  sources?: MemorySource[] | null;
  mwSuccess?: number | null;
  mwFail?: number | null;
}): string {
  let out = `${input.text} <!-- created=${input.created}, last=${input.lastReferenced} -->`;
  const meta: { provenance?: Provenance; sources?: MemorySource[]; mwSuccess?: number; mwFail?: number } = {};
  if (input.provenance) meta.provenance = input.provenance;
  if (input.sources && input.sources.length > 0) meta.sources = input.sources;
  if (input.mwSuccess && input.mwSuccess > 0) meta.mwSuccess = input.mwSuccess;
  if (input.mwFail && input.mwFail > 0) meta.mwFail = input.mwFail;
  if (meta.provenance || meta.sources || meta.mwSuccess || meta.mwFail) {
    out += ` <!-- meta:${JSON.stringify(meta)} -->`;
  }
  return out;
}

export function formatFailureMemoryContent(
  content: string,
  options: {
    category: MemoryCategory;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    project?: string | null;
  },
): string {
  const categoryTag = `[${options.category}]`;
  const parts = [`${categoryTag} ${content.trim()}`.trim()];
  if (options.failureReason) parts.push(`Failed: ${options.failureReason}`);
  if (options.toolState) parts.push(`Tool state: ${options.toolState}`);
  if (options.correctedTo) parts.push(`Corrected to: ${options.correctedTo}`);
  if (options.project) parts.push(`Project: ${options.project}`);
  return parts.join(" — ");
}

export interface ParsedMarkdownMemoryEntry {
  content: string;
  target: MemoryTarget;
  /** Stable markdown-side id, surfaced from the frontmatter `id` so the startup
   *  mirror (`syncMarkdownMemories` → `syncMemoryEntry`) can stamp the SQLite
   *  `md_id` / Surreal `mdId` on an externally-edited frontmatter entry. Set
   *  only on the frontmatter branch; comment-shape entries have no id. */
  mdId?: string;
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
  provenance?: Provenance | null;
  sources?: MemorySource[] | null;
  mwSuccess?: number | null;
  mwFail?: number | null;
  state?: FailureState;
  severity?: number | null;
  /** Pin lock (ticket 02): a pinned entry is never eligible for overflow-
   *  driven eviction. Target-agnostic (applies to memory/user/failure, unlike
   *  `state`/`severity` which are failure-only). Absent / false → unpinned. */
  pin?: boolean;
}

/**
 * Derive the failure-specific fields (`[category]` prefix + ` — ` segments) from
 * a body string. Shared by BOTH parse shapes — the frontmatter branch and the
 * legacy comment branch — so the failure-field decoding lives in exactly one
 * place. The `[failure]` / `Failed:` / `Tool state:` / `Corrected to:` layout
 * lives in the body text regardless of which metadata envelope wraps it.
 */
function deriveFailureFields(text: string): {
  category: MemoryCategory | null;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
} {
  let category: MemoryCategory | null = null;
  let failureReason: string | null = null;
  let toolState: string | null = null;
  let correctedTo: string | null = null;

  const categoryMatch = text.match(/^\[([^\]]+)\]\s+/);
  if (categoryMatch && FAILURE_CATEGORY_SET.has(categoryMatch[1] as MemoryCategory)) {
    category = categoryMatch[1] as MemoryCategory;
  }

  const segments = text.split(" — ");
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("Failed: ") && !failureReason) {
      failureReason = segment.slice("Failed: ".length).trim() || null;
      continue;
    }
    if (segment.startsWith("Tool state: ") && !toolState) {
      toolState = segment.slice("Tool state: ".length).trim() || null;
      continue;
    }
    if (segment.startsWith("Corrected to: ") && !correctedTo) {
      correctedTo = segment.slice("Corrected to: ".length).trim() || null;
    }
  }

  return { category, failureReason, toolState, correctedTo };
}

export function parseMarkdownMemoryEntry(
  rawEntry: string,
  target: MemoryTarget,
  project: string | null = null,
): ParsedMarkdownMemoryEntry {
  // Unified decode (architecture-deepening C1 v2): both the frontmatter and
  // comment shapes flow through the single lenient `decodeMemoryEntry` (a
  // malformed frontmatter no longer throws — baked-in fix (a); it degrades to a
  // comment-shape minimal entry). The body is canonical `content`; the stable
  // frontmatter `id` surfaces as `mdId` (typeof-string read — an id-less
  // frontmatter yields `undefined`, never the literal "undefined" the legacy
  // String() coerce produced — baked-in fix (b)). For the failure target the
  // `[category]` prefix + ` — ` segments live in the body text, so re-derive
  // them via `deriveFailureFields`.
  const d = decodeMemoryEntry(rawEntry);
  const parsedProject = normalizeNullable(project);
  const base: ParsedMarkdownMemoryEntry = {
    content: d.text,
    target,
    project: parsedProject,
    created: d.created,
    lastReferenced: d.lastReferenced,
    ...(d.id ? { mdId: d.id } : {}),
    ...(d.provenance ? { provenance: d.provenance } : {}),
    ...(Array.isArray(d.sources) ? { sources: d.sources } : {}),
    ...(typeof d.mwSuccess === "number" ? { mwSuccess: d.mwSuccess } : {}),
    ...(typeof d.mwFail === "number" ? { mwFail: d.mwFail } : {}),
    ...(d.state ? { state: d.state } : {}),
    ...(typeof d.severity === "number" ? { severity: d.severity } : {}),
    ...(d.pin ? { pin: d.pin } : {}),
  };
  if (target !== "failure") return base;
  return { ...deriveFailureFields(d.text), ...base };
}

/**
 * Upgrade a legacy comment entry to the frontmatter envelope. The caller mints
 * the stable `id` (the backfill does) and passes it in — this function never
 * generates or overwrites an id. Field renames come for free via
 * `serializeMetadataFrontmatter` (`lastReferenced`→`last`,
 * `mwSuccess/mwFail`→`memworth`). The body text is preserved verbatim, so the
 * failure fields (`[category]` prefix + ` — ` segments) survive unchanged.
 *
 * `target` / `project` are kept in the signature for symmetry with
 * `parseMarkdownMemoryEntry` even though only `raw` + `id` affect the body.
 */
export function upgradeEntryToFrontmatter(
  raw: string,
  _target: MemoryTarget,
  _project: string | null,
  id: string,
): string {
  const { text, created, lastReferenced, provenance, sources, mwSuccess, mwFail } = parseMetadataComment(raw);
  return serializeMetadataFrontmatter({
    id,
    text,
    created,
    last: lastReferenced,
    provenance,
    sources,
    mwSuccess,
    mwFail,
  });
}

// ---------------------------------------------------------------------------
// YAML frontmatter format (ticket 05 stable-id schema).
//
// Field order is identity-first: id → created → last → state → severity →
// pin → provenance → sources → memworth. Absent or empty optional fields are
// omitted entirely (absence is the encoding for `none` provenance, empty
// sources, and zero memworth). `state`/`severity` are failure-target only
// (omitted for `memory`/`user`). `pin` is target-agnostic (ticket 02) and only
// emitted when `true` (a locked entry survives overflow-driven eviction).
// Renames from the legacy comment shape: lastReferenced→last,
// mwSuccess/mwFail→memworth.{success,fail}. Dates are bare `YYYY-MM-DD`
// plain scalars; the serializer is configured so values stay on a single line.
// ---------------------------------------------------------------------------

export const FRONTMATTER_FENCE = "---";

export function detectEntryShape(raw: string): "frontmatter" | "comment" {
  return raw.startsWith(FRONTMATTER_FENCE + "\n") ? "frontmatter" : "comment";
}

export function serializeMetadataFrontmatter(input: {
  id: string;
  text: string;
  created: string;
  last: string;
  state?: FailureState | null;
  severity?: number | null;
  /** Pin lock (ticket 02) — emitted as `pin: true` only when strictly true. */
  pin?: boolean | null;
  provenance?: Provenance | null;
  sources?: MemorySource[] | null;
  mwSuccess?: number | null;
  mwFail?: number | null;
}): string {
  const fm: Record<string, unknown> = {
    id: input.id,
    created: input.created,
    last: input.last,
  };
  if (input.state) fm.state = input.state;
  if (typeof input.severity === "number" && input.severity >= 1 && input.severity <= 3) fm.severity = input.severity;
  // Pin (ticket 02): strict boolean — only literal `true` is emitted (absent /
  //  false / invalid never write the key, so absence stays the unpinned default).
  if (input.pin) fm.pin = true;
  if (input.provenance && input.provenance !== "none") fm.provenance = input.provenance;
  if (input.sources && input.sources.length > 0) fm.sources = input.sources;
  if ((input.mwSuccess && input.mwSuccess > 0) || (input.mwFail && input.mwFail > 0)) {
    const mw: Record<string, number> = {};
    if (input.mwSuccess && input.mwSuccess > 0) mw.success = input.mwSuccess;
    if (input.mwFail && input.mwFail > 0) mw.fail = input.mwFail;
    fm.memworth = mw;
  }
  const yaml = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
  return `${FRONTMATTER_FENCE}\n${yaml}\n${FRONTMATTER_FENCE}\n${input.text}`;
}

export function parseMetadataFrontmatter(raw: string): ParsedMarkdownMemoryEntry & {
  id: string;
  text: string;
  /** Always coerced via `String()` below, so non-null `string` (not the
   *  interface's `string | null | undefined`) — narrowed here so `decodeEntry`
   *  (whose return requires `string`) type-checks without a call-site coerce. */
  created: string;
  lastReferenced: string;
} {
  // Fence-scan + YAML parse live in the one shared leaf (architecture-
  // deepening C1). The leaf returns null on a missing/malformed fence; this
  // codec keeps its historical strict contract (throw, not null) so every
  // caller's try/catch shape is preserved.
  const split = splitFencedYaml(raw);
  if (!split) throw new Error("malformed frontmatter: no closing fence");
  const fm = split.data;
  const text = split.body;
  const mw = (fm.memworth ?? {}) as { success?: number; fail?: number };
  return {
    content: text,
    text, // alias matching the serialize input field name
    target: "memory", // caller overrides; format is shape-only
    id: String(fm.id),
    created: String(fm.created),
    lastReferenced: String(fm.last),
    ...(fm.state ? { state: normalizeFailureState(fm.state) } : {}),
    ...(typeof fm.severity === "number" && fm.severity >= 1 && fm.severity <= 3 ? { severity: fm.severity } : {}),
    // Pin (ticket 02): strict — only literal YAML boolean `true` survives.
    ...(fm.pin === true ? { pin: true } : {}),
    ...(fm.provenance ? { provenance: fm.provenance as Provenance } : {}),
    ...(Array.isArray(fm.sources) ? { sources: fm.sources as MemorySource[] } : {}),
    ...(typeof mw.success === "number" ? { mwSuccess: mw.success } : {}),
    ...(typeof mw.fail === "number" ? { mwFail: mw.fail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Unified entry decode (architecture-deepening C1 v2).
//
// `decodeMemoryEntry` is the SINGLE shape-aware decoder that consolidates the
// five drifting decode sites (memory-store.decodeEntry/mdIdOf/isPinned,
// memory-format.parseMarkdownMemoryEntry, merge-plan.parseEntry,
// memory-serializer.deserialize). It dispatches on `detectEntryShape`:
// frontmatter → splitFencedYaml + field projection; comment → parseMetadata-
// Comment. Two latent fixes are BAKED INTO this decode (they take effect once
// Part 2 rewires callers; Part 1 ships this additive with no caller change):
//
//   (a) LENIENT — never throws on malformed frontmatter. `splitFencedYaml`
//       returns null (missing closing fence / unparseable YAML) → degrade to a
//       minimal comment-shape entry (body = trimmed raw, dates defaulted, no
//       id/pin/state/severity). The legacy `parseMetadataFrontmatter` THREW on
//       a missing fence, forcing every caller to wrap a try/catch; the unified
//       decode removes that footgun so a single corrupt entry can never break
//       purge / eviction / snapshot / deserialize.
//
//   (b) PROPER id READ — `typeof fm.id === "string" ? fm.id : undefined`, NOT
//       `String(fm.id)`. The legacy codec coerced a missing id to the literal
//       string `"undefined"`, which then flowed into md_id columns and dedup
//       keys. Reading via `typeof` makes an id-less frontmatter entry read as
//       `undefined` (→ `mdIdOf` returns `null`), the intended sentinel.
//
// PURE: no fs, no side effects, deterministic. `mdIdOf` / `isPinned` collapse
// to 1-liners over the decoded value — the single source of truth for the
// store's private helpers of the same name (Part 2 rewires those to delegate).
// ---------------------------------------------------------------------------

/** The shape-aware, backend-neutral result of decoding one raw memory entry.
 *  The UNION of fields the five legacy decode sites read. Frontmatter-only
 *  fields (`id`/`state`/`severity`/`pin`) are absent on comment-shape entries
 *  (comment entries carry no failure lifecycle and are never pinned). */
export interface DecodedMemoryEntry {
  /** Envelope shape: `frontmatter` (YAML `---` envelope) vs `comment` (legacy
   *  `<!-- created=…, last=… -->` trailer). Also `comment` for a MALFORMED
   *  frontmatter entry that fell back via the LENIENT path (a). */
  shape: "frontmatter" | "comment";
  /** Canonical body text — the entry content with its metadata envelope
   *  stripped. For frontmatter this is the post-fence body; for comment it is
   *  the text before the `<!-- … -->` trailer. */
  text: string;
  created: string;
  lastReferenced: string;
  /** Stable frontmatter `id` — frontmatter shape only. Read strictly via
   *  `typeof fm.id === "string"`; an id-less or non-string id yields
   *  `undefined` (baked-in fix (b)), NEVER the literal "undefined". */
  id?: string;
  provenance?: Provenance;
  sources?: MemorySource[];
  mwSuccess?: number;
  mwFail?: number;
  /** Failure lifecycle — frontmatter shape only (normalized via
   *  `normalizeFailureState`). A comment-shape entry has no state (reads as
   *  `active` — the safe default — at its call sites). */
  state?: FailureState;
  /** Failure severity (1–3) — frontmatter shape only. */
  severity?: number;
  /** Pin lock (ticket 02) — frontmatter shape only; `true` iff the front-
   *  matter `pin` is the literal boolean `true`. Comment-shape entries are
   *  never pinned. Target-agnostic (survives overflow-driven eviction). */
  pin?: boolean;
}

/** Decode a single raw memory entry (frontmatter OR comment shape) into a
 *  `DecodedMemoryEntry`. Shape-aware, pure, lenient (never throws). The ONE
 *  decode path the store / serializer / merge-plan / format layer delegate to.
 *
 *  Frontmatter branch: `splitFencedYaml` → null means malformed (LENIENT
 *  fallback to a comment-shape minimal entry, baked-in fix (a)); otherwise
 *  project every field, reading `id` via `typeof` (baked-in fix (b)). Comment
 *  branch: `parseMetadataComment` and map onto the same shape. */
export function decodeMemoryEntry(raw: string): DecodedMemoryEntry {
  if (detectEntryShape(raw) === "frontmatter") {
    const split = splitFencedYaml(raw);
    // LENIENT (baked-in fix (a)): malformed frontmatter (missing closing fence
    // / unparseable YAML) — NEVER throws. Degrade to a minimal comment-shape
    // entry whose body is the trimmed raw, dates defaulted, and id / pin /
    // state / severity / provenance / sources / memworth all absent (the safe
    // defaults every call site already tolerates for comment-shape entries).
    if (!split) {
      const fallback = today();
      return {
        shape: "comment",
        text: raw.trim(),
        created: fallback,
        lastReferenced: fallback,
      };
    }
    const fm = split.data;
    const mw = (fm.memworth ?? {}) as { success?: number; fail?: number };
    return {
      shape: "frontmatter",
      text: split.body,
      created: String(fm.created),
      lastReferenced: String(fm.last),
      // PROPER id READ (baked-in fix (b)): typeof-string only. Never coerce
      //  via String() — a missing id must stay `undefined`, not "undefined".
      ...(typeof fm.id === "string" ? { id: fm.id } : {}),
      ...(fm.state ? { state: normalizeFailureState(fm.state) } : {}),
      ...(typeof fm.severity === "number" && fm.severity >= 1 && fm.severity <= 3 ? { severity: fm.severity } : {}),
      ...(fm.pin === true ? { pin: true } : {}),
      ...(fm.provenance ? { provenance: fm.provenance as Provenance } : {}),
      ...(Array.isArray(fm.sources) ? { sources: fm.sources as MemorySource[] } : {}),
      ...(typeof mw.success === "number" ? { mwSuccess: mw.success } : {}),
      ...(typeof mw.fail === "number" ? { mwFail: mw.fail } : {}),
    };
  }

  // Comment shape (legacy `<!-- created=…, last=… -->` trailer, optional meta
  // provenance/sources/memworth block). No id / state / severity / pin.
  const { text, created, lastReferenced, provenance, sources, mwSuccess, mwFail } = parseMetadataComment(raw);
  return {
    shape: "comment",
    text,
    created,
    lastReferenced,
    ...(provenance ? { provenance } : {}),
    ...(sources ? { sources } : {}),
    ...(typeof mwSuccess === "number" ? { mwSuccess } : {}),
    ...(typeof mwFail === "number" ? { mwFail } : {}),
  };
}

/** Read an entry's stable frontmatter id, or `null` when it is comment-shape /
 *  id-less / malformed. The 1-liner over `decodeMemoryEntry` — the single
 *  source of truth the store's private `mdIdOf` delegates to (Part 2). Because
 *  the decode reads `id` via `typeof` (baked-in fix (b)), an id-less front-
 *  matter entry returns `null` here (NOT the literal "undefined"). */
export function mdIdOf(raw: string): string | null {
  return decodeMemoryEntry(raw).id ?? null;
}

/** Pin lock check (ticket 02): `true` iff the entry is a FRONTMATTER entry
 *  whose `pin` is the literal boolean `true`. Comment-shape entries are never
 *  pinned; malformed frontmatter falls back to comment-shape (→ `false`). The
 *  1-liner over `decodeMemoryEntry` — the single source of truth the store's
 *  private `isPinned` delegates to (Part 2). */
export function isPinned(raw: string): boolean {
  return decodeMemoryEntry(raw).pin ?? false;
}
