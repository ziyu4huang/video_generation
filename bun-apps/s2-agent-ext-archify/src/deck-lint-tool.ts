/**
 * deck-lint-tool.ts — the `archify_deck_lint` tool.
 *
 * The cheap door (spec §4.8): everything a deck build would tell you LAST,
 * told FIRST, with zero rendering. Two input shapes:
 *
 *   - no `manifest` → the layout catalog: every code layout and every
 *     discovered template with its `description`, `slots` and source path,
 *     plus the deck skeletons and the copy-adapt IR library.
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DeckError, loadManifestFile, parseManifest, type DeckManifest } from "./deck-build.ts";
import { formatLintNotes, lintDeck, storyline } from "./deck-lint.ts";
import { loadRegistry, pkgRoot, type CatalogEntry } from "./layout-registry.ts";
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
  if (entry.requiresIr && (typeof slide.ir !== "string" || slide.ir === "")) {
    out.push(
      `slide ${index + 1}: layout "${entry.name}" (${entry.description}) needs an \`ir\` — this layout draws the slide's IR`
    );
  }
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

/** A ready-to-fill deck skeleton: the file stem plus its first `#` title. */
export interface DeckSkeleton {
  name: string;
  description: string;
  source: string;
}

export interface DeckSkeletonOpts {
  /**
   * Base dir. `<root>/templates/decks` is the user tier's second stop, after
   * the `$ARCHIFY_TEMPLATES` env dirs. Omit to skip the file-backed user tier.
   */
  root?: string;
  /** Overrides `$ARCHIFY_TEMPLATES` resolution — tests must not drop files into the package. */
  env?: NodeJS.ProcessEnv;
  /**
   * Overrides the shipped `<pkg>/templates` tier (its `decks` subdir is
   * searched) — for tests, which must not drop files into the package to prove
   * precedence. Same seam as `loadRegistry`'s `shippedDir` (layout-registry.ts).
   */
  shippedDir?: string;
}

/**
 * Outlines from `templates/decks/` — user tier first, then the shipped tier;
 * first hit wins and shadowed names are dropped, the same precedence as the
 * layout tiers. The user tier is each `$ARCHIFY_TEMPLATES` dir's `decks/`
 * (in env order), then `<root>/templates/decks/`; the shipped tier is
 * `<shippedDir>/decks/` or `<pkgRoot()>/templates/decks/` when not overridden.
 */
export function discoverDeckSkeletons(opts: DeckSkeletonOpts = {}): DeckSkeleton[] {
  const env = opts.env ?? process.env;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(p));
  const userDirs = [
    ...(env.ARCHIFY_TEMPLATES ?? "")
      .split(":")
      .filter(Boolean)
      .map((d) => join(abs(d), "decks")),
    ...(opts.root ? [join(opts.root, "templates", "decks")] : []),
  ];
  const shippedRoot = pkgRoot();
  const shippedDirs = opts.shippedDir
    ? [join(opts.shippedDir, "decks")]
    : shippedRoot
      ? [join(shippedRoot, "templates", "decks")]
      : [];
  const dirs = [...userDirs, ...shippedDirs];
  const out: DeckSkeleton[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".outline.md")).sort()) {
      const name = f.replace(/\.outline\.md$/, "");
      if (seen.has(name)) continue;
      seen.add(name);
      // The description is the first `#` H1 AFTER the frontmatter block — a
      // frontmatter `# comment` (legal in the outline dialect) must not hijack it.
      const text = readFileSync(join(dir, f), "utf8");
      const body = text.startsWith("---") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
      const h1 = /^#\s+(.+)$/m.exec(body);
      out.push({ name, description: h1 ? h1[1]!.trim() : "", source: join(dir, f) });
    }
  }
  return out;
}

/**
 * One entry of the shipped copy-adapt IR library
 * (`examples/ir-library/library.catalog.json`) — the same typed index the
 * `ir-library` gate test pins. The library is package data: there is no user
 * tier, and a missing file (deploy omitted examples/) silently yields [].
 */
export interface IrLibraryEntry {
  path: string;
  diagram_type: string;
  title: string;
  description: string;
  archetype: string;
  pairing: string[];
  tier: string;
}

/**
 * Load the shipped IR library catalog. `shippedRoot` overrides the package root
 * (mirroring the skeleton-discovery `shippedDir` seam) so tests never have to
 * drop files into the package to prove discovery.
 */
export function loadIrLibrary(shippedRoot?: string): IrLibraryEntry[] {
  const root = shippedRoot ?? pkgRoot();
  if (!root) return [];
  try {
    const text = readFileSync(join(root, "examples", "ir-library", "library.catalog.json"), "utf8");
    const parsed = JSON.parse(text) as { entries: IrLibraryEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
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
      const decks = discoverDeckSkeletons({ root, env: ctx.env });
      const irLibrary = loadIrLibrary();
      const text =
        `Available layouts (${catalog.length}) — six code layouts first, then templates ` +
        `from $ARCHIFY_TEMPLATES, <baseDir>/templates/ and the shipped tier:\n` +
        catalog
          .map((c) => `${c.name} — ${c.description}\n  slots: ${formatSlots(c.slots)}\n  source: ${c.source}`)
          .join("\n") +
        (decks.length > 0
          ? `\n\nDeck skeletons (${decks.length}) — ready-to-fill outlines in the outline dialect:\n` +
            decks.map((d) => `${d.name} — ${d.description}\n  source: ${d.source}`).join("\n")
          : "") +
        (irLibrary.length > 0
          ? `\n\nIR library (${irLibrary.length}) — validated, render-ready diagrams to copy-adapt (see the ` +
            `flagship deck at examples/ir-library/decks/library.config.json):\n` +
            irLibrary
              .map(
                (e) =>
                  `${e.diagram_type} · ${e.title}\n  pair with: ${e.pairing.join(", ")}\n  source: examples/ir-library/${e.path}`
              )
              .join("\n")
          : "");
      return {
        content: [{ type: "text", text }],
        details: {
          count: catalog.length,
          layouts: catalog,
          ...(decks.length ? { decks } : {}),
          ...(irLibrary.length ? { irLibrary } : {}),
        },
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

    const notes = lintDeck({
      slides: manifest.slides,
      suppressedTitle: new Set(reg.titleSuppressedLayouts()),
    });
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
    "catalog: every code layout and discovered template (plus the deck skeletons under templates/decks/ and the " +
    "copy-adapt IR library under examples/ir-library/) with its description, slots and source path; ask this " +
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
