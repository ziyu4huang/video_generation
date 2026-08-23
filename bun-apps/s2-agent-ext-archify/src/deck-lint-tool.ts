/**
 * deck-lint-tool.ts — the `archify_deck_lint` tool.
 *
 * The cheap door (spec §4.8): everything a deck build would tell you LAST,
 * told FIRST, with zero rendering. Two input shapes:
 *
 *   - no `manifest` → the layout catalog: every code layout and every
 *     discovered template with its `description`, `slots` and source path.
 *     This is the discovery surface (D9) — the agent asks, never guesses.
 *   - with `manifest` (path or inline object) → parse, validate each slide's
 *     fields against its layout's slots, check every `ir` exists, then the
 *     content lint (`deck-lint.ts`) and the storyline.
 *
 * **Renderless by construction**: no `deliver`, no `parseSvg`, no `.pptx`.
 * The only filesystem access is reading the manifest and stat-ing each `ir`.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DeckError, loadManifestFile, parseManifest, type DeckManifest } from "./deck-build.ts";
import { formatLintNotes, lintDeck, storyline } from "./deck-lint.ts";
import { loadRegistry, type CatalogEntry } from "./layout-registry.ts";
import type { SlotSpec } from "./layout-template.ts";

export interface DeckLintParams {
  /** Path to a deck.config.json, or the manifest object itself. Omit → catalog. */
  manifest?: string | Record<string, unknown>;
  /**
   * Anchor dir: a relative manifest path resolves here; for an inline manifest
   * this is the dir its `ir` paths resolve against (and where `<dir>/templates`
   * joins the search path).
   */
  baseDir?: string;
}

export interface DeckLintCtx {
  cwd: string;
  /** Overrides $ARCHIFY_TEMPLATES resolution — tests must not drop files into the package. */
  env?: NodeJS.ProcessEnv;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
}

function err(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details: { error: text, ...details }, isError: true };
}

/** One human-readable line per declared slot, for the catalog text. */
function formatSlots(slots: Record<string, SlotSpec>): string {
  const names = Object.keys(slots);
  if (names.length === 0) return "none";
  return names
    .map((name) => {
      const s = slots[name]!;
      const parts: string[] = [s.kind];
      if (s.of?.length) parts.push(`of ${s.of.join(", ")}`);
      if (s.min !== undefined || s.max !== undefined) {
        parts.push(`${s.min ?? 0}..${s.max ?? "∞"}`);
      }
      if (s.required === false) parts.push("optional");
      return `${name} (${parts.join("; ")})`;
    })
    .join(", ");
}

/**
 * Fields-vs-slots validation. A missing slot renders SILENTLY EMPTY today —
 * `resolveString` fills "" and an empty repeat draws nothing — which is exactly
 * why the renderless check must catch what the renderer forgives. The template's
 * own description rides along: it is the author's sentence about what the
 * layout is FOR, which is what turns "add `kpis`" into a fixable instruction.
 */
function slotProblems(
  slide: Record<string, unknown>,
  index: number,
  entry: CatalogEntry
): string[] {
  const out: string[] = [];
  for (const [name, spec] of Object.entries(entry.slots)) {
    const where = `slide ${index + 1}: layout "${entry.name}" (${entry.description})`;
    const value = slide[name];
    const absent = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
    if (absent) {
      if (spec.required !== false) out.push(`${where}: missing slot \`${name}\` (${spec.kind})`);
      continue;
    }
    if (spec.kind !== "array" || !Array.isArray(value)) continue;
    if (spec.min !== undefined && value.length < spec.min) {
      out.push(
        `${where}: slot \`${name}\` has ${value.length} item(s), wants at least ${spec.min}`
      );
    }
    if (spec.max !== undefined && value.length > spec.max) {
      out.push(
        `${where}: slot \`${name}\` has ${value.length} item(s), the layout draws at most ${spec.max}`
      );
    }
  }
  return out;
}

/** Pure entry point (tested directly; the tool wrapper only adapts the SDK shape). */
export async function archifyDeckLint(params: DeckLintParams, ctx: DeckLintCtx): Promise<ToolResult> {
  try {
    const root = params.baseDir
      ? isAbsolute(params.baseDir)
        ? params.baseDir
        : resolve(ctx.cwd, params.baseDir)
      : ctx.cwd;

    // ── discovery surface (D9): no manifest → the catalog ────────────────────
    if (params.manifest === undefined) {
      const catalog = loadRegistry({ manifestDir: root, env: ctx.env }).catalog();
      const text =
        `Available layouts (${catalog.length}) — six code layouts first, then templates ` +
        `from $ARCHIFY_TEMPLATES, <baseDir>/templates/ and the shipped tier:\n` +
        catalog
          .map((c) => `${c.name} — ${c.description}\n  slots: ${formatSlots(c.slots)}\n  source: ${c.source}`)
          .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { count: catalog.length, layouts: catalog },
      };
    }

    // ── renderless deck check ────────────────────────────────────────────────
    let manifest: DeckManifest;
    let manifestDir: string;
    let reg: ReturnType<typeof loadRegistry>;
    if (typeof params.manifest === "string") {
      const manifestPath = isAbsolute(params.manifest) ? params.manifest : resolve(root, params.manifest);
      const loaded = await loadManifestFile(manifestPath, ctx.cwd);
      manifest = loaded.manifest;
      manifestDir = loaded.manifestDir;
      reg = loadRegistry({ manifestDir, env: ctx.env });
    } else {
      manifestDir = root;
      reg = loadRegistry({ manifestDir, env: ctx.env });
      manifest = parseManifest(JSON.stringify(params.manifest), `${manifestDir} (inline)`, reg);
    }
    const entries = new Map(reg.catalog().map((c) => [c.name, c]));

    const problems: string[] = [];
    manifest.slides.forEach((slide, i) => {
      const record = slide as unknown as Record<string, unknown>;
      // The ONLY filesystem touch besides the manifest itself: stat each `ir`.
      if (typeof record.ir === "string" && record.ir !== "") {
        const abs = isAbsolute(record.ir) ? record.ir : resolve(manifestDir, record.ir);
        if (!existsSync(abs)) problems.push(`slide ${i + 1}: IR not found: ${abs}`);
      }
      const entry = entries.get(record.layout as string);
      if (!entry) return; // code layouts carry no slots; parseManifest vetted the name
      problems.push(...slotProblems(record, i, entry));
    });

    const notes = lintDeck(manifest);
    const story = storyline(manifest);
    if (problems.length > 0) {
      const text =
        `Deck fails the renderless check:\n${problems.join("\n")}` +
        (notes.length > 0 ? `\n\nContent notes:\n${formatLintNotes(notes)}` : "");
      return err(text, {
        problems,
        storyline: story,
        ...(notes.length > 0 ? { lint: notes } : {}),
      });
    }

    const text =
      `Checked ${manifest.slides.length} slide(s) against their layouts — nothing was rendered.\n` +
      `storyline — read these alone; they are the deck's argument:\n${story}` +
      (notes.length > 0 ? `\n\nContent notes:\n${formatLintNotes(notes)}` : "");
    return {
      content: [{ type: "text", text }],
      details: {
        slides: manifest.slides.length,
        storyline: story,
        ...(notes.length > 0 ? { lint: notes } : {}),
      },
    };
  } catch (e) {
    if (e instanceof DeckError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const deckLintTool = defineTool({
  name: "archify_deck_lint",
  label: "Archify Deck Lint",
  description:
    "Lint an archify deck WITHOUT building it — no rendering, no .pptx. With no arguments, returns the layout " +
    "catalog: every code layout and discovered template with its description, slots and source path; ask this " +
    "before guessing a layout name. With `manifest` (a deck.config.json path, or the manifest object itself for " +
    "an unwritten draft, anchored at `baseDir`), validates every slide's fields against its layout's slots, " +
    "checks each `ir` exists, applies the content lint (action titles, bullet budget, inline colour) and returns " +
    "the storyline. Run this before archify_export_pptx.",
  parameters: Type.Object({
    manifest: Type.Optional(
      Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], {
        description:
          "Path to a deck manifest JSON, or the manifest object itself. OMIT to list available layouts instead of linting.",
      })
    ),
    baseDir: Type.Optional(
      Type.String({
        description:
          "Anchor dir: a relative manifest path resolves here; an inline manifest's `ir` paths resolve against it (default: cwd).",
      })
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyDeckLint(params as DeckLintParams, { cwd: ctx.cwd });
  },
});
