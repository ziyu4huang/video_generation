/**
 * Extension-entry typecheck-coverage guard.
 *
 * THE PATTERN THIS EXISTS TO BREAK
 *   An extension package's registration entry lives at `extensions/<X>.ts`
 *   (CLAUDE.md: one registered entry per folder). Its SOURCE lives in `src/`.
 *   Most of these packages then wrote `"include": ["src/**\/*.ts"]` in their
 *   tsconfig — so `bun run typecheck` inside the package compiles everything
 *   EXCEPT the file that is the package's whole reason to exist.
 *
 *   The entry still got compiled, but by the HOST: pi-agent imports it through
 *   run-dir/manifest.json and typechecks it under pi-agent's tsconfig. So the
 *   file has an executor, just not the one whose gate the author runs before
 *   pushing. `bun run typecheck` in the package says nothing about the entry,
 *   `bun test` in the package says nothing about it, and the failure surfaces
 *   one package away — on main, in pi-agent's job, after merge.
 *
 *   That is the shared structural cause of two main-red incidents. Both were
 *   diagnosed as one-off mistakes in the entry file; neither was, because
 *   nothing in the owning package could have caught either one.
 *
 * WHY A COVERAGE GUARD AND NOT A LINT
 *   The state is not "everyone forgot" — it is SPLIT. Thirteen packages get
 *   this right (`archify`, `btw`, `file2md`, `flux2`, `knowledge-card`,
 *   `krea2`, `movie-director`, `obsidian`, `prompt-history`, `research-tool`,
 *   `task`, `tool-gate`, `devops`) and the rest do not, with nothing marking
 *   which half a package is in. A new extension package is copied from
 *   whichever neighbour the author happened to open. A guard is what makes the
 *   correct half the only half.
 *
 * WHAT IS ASSERTED, per package that has an `extensions/` directory
 *   1. It has a tsconfig.json at all. (`ltx` and `zai-mcp` have none — for
 *      them the gap is not just `extensions/`, it is the whole package.)
 *   2. Every `extensions/*.ts` entry is matched by that tsconfig's `include`.
 *      Literal file lists are accepted when they cover today's files, but they
 *      are the `devops` shape: correct now, silently wrong the day a second
 *      entry lands. A glob is what makes the coverage durable, so a literal
 *      list is only accepted while it happens to be complete.
 *   3. The package declares a script that actually runs `tsc`. A tsconfig with
 *      no executor is the `package-scripts-runnable` lesson in another costume:
 *      including the file changes nothing if nothing ever compiles it. Whether
 *      CI *runs* that script is a different claim, owned by
 *      `ci-workflow-references.test.ts`.
 *
 * STATIC ONLY: reads tsconfig.json / package.json as data and lists
 * `extensions/`. No tsc invocation, no node_modules probe.
 *
 * Run: bun run test:ext-entry   (from bun-apps/)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonc } from "./read-jsonc.ts";

const BUN_APPS = resolve(import.meta.dir, "..");

/** Packages that ship a registration entry under `extensions/`. */
interface ExtPackage {
  name: string;
  dir: string;
  /** `extensions/*.ts` basenames, excluding test files. */
  entries: string[];
}

/**
 * Test files under `extensions/` are covered by the package's test runner, not
 * by the registration contract — they are excluded so a package is never asked
 * to typecheck a fixture it deliberately keeps out of its build.
 */
const isEntryFile = (f: string): boolean => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts");

function extPackages(): ExtPackage[] {
  const out: ExtPackage[] = [];
  for (const name of readdirSync(BUN_APPS).sort()) {
    const dir = join(BUN_APPS, name);
    const extDir = join(dir, "extensions");
    if (!existsSync(join(dir, "package.json"))) continue;
    if (!existsSync(extDir) || !statSync(extDir).isDirectory()) continue;
    const entries = readdirSync(extDir).filter(isEntryFile).sort();
    if (entries.length > 0) out.push({ name, dir, entries });
  }
  return out;
}

/**
 * Does a tsconfig `include` pattern match `relPath`?
 *
 * Only the three constructs tsconfig `include` actually uses here: `**` (any
 * number of path segments), `*` (within one segment), and literal text. Written
 * out rather than pulled from a glob library so the gate has no dependency of
 * its own to declare — see package-scripts-runnable.test.ts on what an
 * undeclared binary costs a gate.
 */
function includeMatches(pattern: string, relPath: string): boolean {
  const rx = pattern
    .split("/")
    .map((seg) => {
      if (seg === "**") return "(?:.*)";
      return seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    })
    .join("/")
    // `a/**/b` must also match `a/b` — tsconfig treats `**` as "zero or more".
    .replace(/\/\(\?:\.\*\)\//g, "(?:/|/.*/)");
  return new RegExp(`^${rx}$`).test(relPath);
}

/**
 * A tsconfig with no `include` compiles every .ts under its own directory, so
 * absence is COVERAGE, not a gap. `exclude` can still carve the entry back out.
 */
function coversEntry(tsconfig: Record<string, unknown>, relPath: string): boolean {
  const exclude = Array.isArray(tsconfig.exclude) ? (tsconfig.exclude as string[]) : [];
  if (exclude.some((p) => includeMatches(p, relPath) || relPath.startsWith(`${p.replace(/\/$/, "")}/`))) return false;
  const include = tsconfig.include;
  if (!Array.isArray(include)) return true;
  return (include as string[]).some((p) => includeMatches(p, relPath));
}

/** Scripts whose command line invokes tsc, bare or via bunx/npx. */
function tscScripts(pkg: Record<string, unknown>): string[] {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  return Object.entries(scripts)
    .filter(([, cmd]) => /(^|[\s&|;(])(?:bunx\s+|npx\s+)?tsc(\s|$)/.test(cmd))
    .map(([name]) => name);
}

const PACKAGES = extPackages();

describe("extension-entry typecheck coverage", () => {
  test("the survey found extension packages at all (guards against a silent empty sweep)", () => {
    // A rename of `extensions/` or of the bun-apps layout would otherwise turn
    // this whole file into a green no-op.
    expect(PACKAGES.length).toBeGreaterThan(10);
  });

  test("every package with an extensions/ entry has a tsconfig.json", () => {
    const missing = PACKAGES.filter((p) => !existsSync(join(p.dir, "tsconfig.json"))).map((p) => p.name);
    expect(
      missing,
      `NO TSCONFIG: ${missing.join(", ")} — these packages ship a registration entry that no ` +
        "tsc invocation in the package can reach, because there is no tsconfig for one to use.",
    ).toEqual([]);
  });

  test("every extensions/ entry is compiled by its OWN package's tsconfig", () => {
    const uncovered: string[] = [];
    for (const p of PACKAGES) {
      const tsconfigPath = join(p.dir, "tsconfig.json");
      if (!existsSync(tsconfigPath)) continue; // reported by the test above
      const tsconfig = readJsonc(tsconfigPath);
      for (const entry of p.entries) {
        const rel = `extensions/${entry}`;
        if (!coversEntry(tsconfig, rel)) uncovered.push(`${p.name}/${rel}`);
      }
    }
    expect(
      uncovered,
      `NOT TYPECHECKED BY ITS OWN PACKAGE:\n  ${uncovered.join("\n  ")}\n\n` +
        "Each of these is the package's registration entry, compiled only by the host pi-agent. " +
        'Add "extensions/**/*.ts" to the package tsconfig\'s `include`. A type error here currently ' +
        "surfaces one package away, on main, after merge — which is how two main-red incidents happened.",
    ).toEqual([]);
  });

  test("every package with an extensions/ entry declares a script that runs tsc", () => {
    const noExecutor = PACKAGES.filter((p) => {
      const pkgPath = join(p.dir, "package.json");
      return tscScripts(JSON.parse(readFileSync(pkgPath, "utf8"))).length === 0;
    }).map((p) => p.name);
    expect(
      noExecutor,
      `NO TSC EXECUTOR: ${noExecutor.join(", ")} — widening the tsconfig's \`include\` changes ` +
        "nothing for these, because no script in the package ever invokes tsc. Coverage without an " +
        "executor reads as fixed and is not.",
    ).toEqual([]);
  });
});
