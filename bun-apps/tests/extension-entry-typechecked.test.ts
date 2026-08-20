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
 *   The entry still got compiled, but by the HOST: s2-agent imports it through
 *   run-dir/manifest.json and typechecks it under s2-agent's tsconfig. So the
 *   file has an executor, just not the one whose gate the author runs before
 *   pushing. `bun run typecheck` in the package says nothing about the entry,
 *   `bun test` in the package says nothing about it, and the failure surfaces
 *   one package away — on main, in s2-agent's job, after merge.
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
 * THE SAME GAP, ONE SCOPE WIDER (second describe block below)
 *   Everything above is scoped to packages that HAVE an `extensions/`
 *   directory — which is why it said nothing about `gui-movie-director`, a
 *   package with ~200 TypeScript files, no `extensions/` dir, and no script
 *   that runs `tsc` at all. `run_local_ci` reported it as
 *   `typecheck: { skipped: true, note: "no tsc key" }`, which reads exactly
 *   like a package that does not need type checking. It hid 133 real errors
 *   until 2026-08-18 (PR #1646), including a `Bun.serve().port` that could
 *   publish `http://host:undefined` to the port registry.
 *
 *   So the second block asks the wider question of EVERY package: if it has
 *   TypeScript sources, is there an executor that the gate which actually runs
 *   will find? "Find" is the operative word — `run_local_ci` looks for
 *   `scripts.typecheck`, then `scripts.check` if that one invokes tsc, and
 *   nothing else (see `ci-recipe.ts`, "Precedence: scripts.typecheck >
 *   scripts.check (only if it runs tsc) > skipped"). A package whose tsc lives
 *   under any other script name is type-checked by a human and by no gate.
 *
 * STATIC ONLY: reads tsconfig.json / package.json as data and lists
 * `extensions/` + source trees. No tsc invocation, no node_modules probe.
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
        "Each of these is the package's registration entry, compiled only by the host s2-agent. " +
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

/**
 * Directories that never hold checkable sources. Skipped while walking so the
 * survey stays a source survey — `node_modules` alone would make it a survey
 * of the dependency tree.
 */
const NON_SOURCE_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out", ".git"]);

/** Does this package tree contain TypeScript a `tsc --noEmit` would compile? */
function hasTypeScriptSources(dir: string, depth = 0): boolean {
  if (depth > 8) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || NON_SOURCE_DIRS.has(e.name)) continue;
    if (e.isDirectory()) {
      if (hasTypeScriptSources(join(dir, e.name), depth + 1)) return true;
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      return true;
    }
  }
  return false;
}

/**
 * The script `run_local_ci` would actually run for this package, by ITS precedence
 * (ci-recipe.ts): `typecheck` first, then `check` only if it invokes tsc.
 * Returns undefined when run_local_ci would report `skipped: "no tsc key"`.
 */
function localCiTypecheckExecutor(pkg: Record<string, unknown>): string | undefined {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  if (typeof scripts.typecheck === "string") return "typecheck";
  if (typeof scripts.check === "string" && /tsc/.test(scripts.check)) return "check";
  return undefined;
}

interface SurveyedPackage {
  name: string;
  dir: string;
  pkg: Record<string, unknown>;
}

function allPackages(): SurveyedPackage[] {
  const out: SurveyedPackage[] = [];
  for (const name of readdirSync(BUN_APPS).sort()) {
    const dir = join(BUN_APPS, name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest) || !statSync(dir).isDirectory()) continue;
    out.push({ name, dir, pkg: JSON.parse(readFileSync(manifest, "utf8")) });
  }
  return out;
}

const ALL_PACKAGES = allPackages();

describe("package typecheck executor coverage (every package, not just extension ones)", () => {
  test("the survey found the workspace (guards against a silent empty sweep)", () => {
    expect(ALL_PACKAGES.length).toBeGreaterThan(20);
    // And it must be finding sources, not just manifests — a `hasTypeScriptSources`
    // that always returned false would make every assertion below vacuous.
    expect(ALL_PACKAGES.filter((p) => hasTypeScriptSources(p.dir)).length).toBeGreaterThan(20);
  });

  test("every package with TypeScript sources has an executor run_local_ci can find", () => {
    const unchecked = ALL_PACKAGES.filter((p) => hasTypeScriptSources(p.dir) && !localCiTypecheckExecutor(p.pkg)).map(
      (p) => p.name,
    );
    expect(
      unchecked,
      `NO TYPECHECK EXECUTOR: ${unchecked.join(", ")} — these packages ship TypeScript that no gate ` +
        'compiles. run_local_ci reports them as `typecheck: { skipped: true, note: "no tsc key" }`, which ' +
        'reads like "does not need type checking" and is why gui-movie-director hid 133 errors. ' +
        'Add `"typecheck": "tsc --noEmit"` to the package\'s scripts.',
    ).toEqual([]);
  });

  test("a tsc script under any other name does NOT count — run_local_ci would not run it", () => {
    // The failure this pins is subtler than "nobody wrote a tsc script": a
    // package CAN have one, have it pass locally, and still be skipped by the
    // gate, because ci-recipe only ever looks at two script names.
    const strandedTsc = ALL_PACKAGES.filter((p) => {
      if (!hasTypeScriptSources(p.dir)) return false;
      if (localCiTypecheckExecutor(p.pkg)) return false;
      return tscScripts(p.pkg).length > 0;
    }).map((p) => `${p.name} (tsc lives in: ${tscScripts(p.pkg).join(", ")})`);
    expect(
      strandedTsc,
      `TSC PRESENT BUT UNREACHABLE: ${strandedTsc.join("; ")} — the script exists and passes when a ` +
        "human runs it, but run_local_ci resolves the executor by NAME (scripts.typecheck, then " +
        "scripts.check-if-it-runs-tsc). Rename it, or add a `typecheck` script that calls it.",
    ).toEqual([]);
  });
});
