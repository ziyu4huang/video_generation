/**
 * layout-registry.ts — name → layout resolution across the code and template
 * tiers.
 *
 * Search order, first hit wins (effort decision D3):
 *
 *   1. the six code layouts — they win OUTRIGHT. A template named after one is
 *      a load error, not an override: `diagram`'s XML is byte-locked against a
 *      pre-composition capture, and a file on a search path must not be able
 *      to reach that.
 *   2. `$ARCHIFY_TEMPLATES` (`:`-separated dirs), then `<manifestDir>/templates/`
 *   3. `<pkg>/templates/*.layout.json` — what ships with the package
 *
 * Duplicate names inside ONE tier are an error too: silent shadowing within a
 * tier is how a user's edit stops taking effect for no visible reason.
 *
 * Same discipline as layouts.ts: no pptxgenjs, no colour literal, no emitter
 * import.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { builtinRoleOf, TYPE_SCALE, type TypeSpec } from "./deck-theme.ts";
import { TemplateError, loadTemplate, type LoadedTemplate, type SlotSpec } from "./layout-template.ts";
import { layoutFor } from "./layouts.ts";
import {
  SLIDE_LAYOUTS,
  type LayoutCtx,
  type PlacedBlock,
  type Slide,
  type SlideLayout,
} from "./slide-model.ts";

export interface CatalogEntry {
  name: string;
  description: string;
  /** Array slots a slide must fill; empty for the six code layouts. */
  slots: Record<string, SlotSpec>;
  /** Absolute path. Code layouts point at `layouts.ts`. */
  source: string;
}

export interface LayoutRegistry {
  has(name: string): boolean;
  render(name: string, slide: Slide, ctx: LayoutCtx): PlacedBlock[];
  /** `{ ...TYPE_SCALE, ...template.roles }` for templates; the scale itself for code. */
  roleOf(name: string): (role: string) => TypeSpec;
  catalog(): CatalogEntry[];
  names(): string[];
}

const CODE_DESCRIPTIONS: Record<SlideLayout, string> = {
  title: "Cover: eyebrow, title, rule, subtitle, date",
  section: "Full-bleed chapter divider with its number",
  bullets: "Action title plus one bullet column",
  split: "Diagram left, points right",
  diagram: "Full-width archify artifact (byte-locked, D3)",
  statement: "One large claim, no title band",
};

/** What an unknown role resolves to rather than crashing a build. */
const ROLE_FALLBACK: TypeSpec = { sizePt: 16, color: "body", lineSpacing: 1.3 };

/**
 * Package root via the `#pi/ext-dir` idiom (same ladder as lib/run.ts's
 * shExtDir). Deliberately NOT import.meta.url: bun's cjs bundler folds it into
 * a build-machine path literal, which the sh deploy's relocatability gate
 * (scanForeignPaths) rejects. Unresolvable (native ESM without the loader)
 * → undefined; callers skip the shipped tier instead of throwing — tests
 * always inject shippedDir explicitly.
 */
function pkgRoot(): string | undefined {
  try {
    if (typeof require === "function") {
      const mod = require("#pi/ext-dir") as { default?: unknown } | string;
      if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
      if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
        return mod.default; // imports entry: the package root
      }
    }
  } catch {
    // Not resolvable here — fall through.
  }
  return undefined;
}

export interface LoadRegistryOpts {
  manifestDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Overrides the shipped `<pkg>/templates` tier — for tests, which must not
   * drop files into the package to prove precedence.
   */
  shippedDir?: string;
}

export function loadRegistry(opts: LoadRegistryOpts = {}): LayoutRegistry {
  const env = opts.env ?? process.env;

  const abs = (p: string) => (isAbsolute(p) ? p : resolve(p));
  // Tier 2: user-provided template dirs, in order.
  const userDirs = [
    ...(env.ARCHIFY_TEMPLATES ?? "")
      .split(":")
      .filter(Boolean)
      .map(abs),
    ...(opts.manifestDir ? [join(opts.manifestDir, "templates")] : []),
  ];
  // Tier 3: what the package ships.
  const root = pkgRoot();
  const shippedDirs = [opts.shippedDir ?? (root !== undefined ? join(root, "templates") : "")].filter(Boolean);

  const templates = new Map<string, LoadedTemplate>();
  for (const dirs of [userDirs, shippedDirs]) {
    const seen = new Map<string, string>();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".layout.json"))
        .sort();
      for (const f of files) {
        const path = join(dir, f);
        let tpl: LoadedTemplate;
        try {
          tpl = loadTemplate(JSON.parse(readFileSync(path, "utf8")), path);
        } catch (e) {
          if (e instanceof TemplateError) throw e;
          throw new TemplateError(`${path}: not readable JSON — ${e instanceof Error ? e.message : String(e)}`);
        }
        const prev = seen.get(tpl.name);
        if (prev) {
          throw new TemplateError(
            `${tpl.name}: duplicate template name within one search tier — ${prev} and ${path}`
          );
        }
        seen.set(tpl.name, path);
        if (!templates.has(tpl.name)) templates.set(tpl.name, tpl);
      }
    }
  }

  const roleResolvers = new Map<string, (role: string) => TypeSpec>();
  function roleOf(name: string): (role: string) => TypeSpec {
    let fn = roleResolvers.get(name);
    if (!fn) {
      const tpl = templates.get(name);
      if (!tpl) return builtinRoleOf;
      const table = new Map<string, TypeSpec>(Object.entries(TYPE_SCALE));
      for (const [role, spec] of Object.entries(tpl.roles)) table.set(role, spec);
      fn = (role: string) => table.get(role) ?? ROLE_FALLBACK;
      roleResolvers.set(name, fn);
    }
    return fn;
  }

  // Provenance label for lint/diagnostic output; a package-relative path when
  // the root is unresolvable (native ESM) — display-only, never read from disk.
  const layoutsAbs = root !== undefined ? join(root, "lib", "layouts.ts") : "lib/layouts.ts";
  const codeCatalog: CatalogEntry[] = SLIDE_LAYOUTS.map((name) => ({
    name,
    description: CODE_DESCRIPTIONS[name],
    slots: {},
    source: layoutsAbs,
  }));

  return {
    has(name: string): boolean {
      return (SLIDE_LAYOUTS as readonly string[]).includes(name) || templates.has(name);
    },

    render(name: string, slide: Slide, ctx: LayoutCtx): PlacedBlock[] {
      const tpl = templates.get(name);
      if (tpl) return tpl.render(slide, ctx);
      return layoutFor(name as SlideLayout)(slide, ctx);
    },

    roleOf,

    catalog(): CatalogEntry[] {
      return [
        ...codeCatalog,
        ...[...templates.values()].map((t) => ({
          name: t.name,
          description: t.description,
          slots: t.slots,
          source: t.source,
        })),
      ];
    },

    names(): string[] {
      return [...SLIDE_LAYOUTS, ...templates.keys()];
    },
  };
}
