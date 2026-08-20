/**
 * Lint-executor coverage guard — the biome twin of the typecheck-executor guard
 * in `extension-entry-typechecked.test.ts`.
 *
 * THE FAILURE THIS EXISTS TO BREAK
 *   Six packages carry a `biome.json` and the identical `"check": "biome check ."`
 *   script. Four of them (subagent, superpowers, wayfind, workflow) also chain
 *   `bun run check` inside their own `test` script, AND their CI matrix row is
 *   `bun run test` — so their biome ran on every local_ci. The other two
 *   (core-runtime, file2md) have matrix rows of bare `bun test` / `bun test
 *   --isolate`, which bypass the package's `test` script entirely. Their biome
 *   therefore ran NOWHERE.
 *
 *   The result was not hypothetical: `s2-agent-core-runtime` sat with a red
 *   `bun run check` on origin/main for days while local_ci, main_health and
 *   await_pr_merge all reported green, because the drift lived in the one tool
 *   no gate invoked. Nothing about the two halves marks which is which — the
 *   difference is a punctuation-level detail of a matrix row in another file.
 *
 * WHY A COVERAGE GUARD AND NOT JUST FIXING THE TWO ROWS
 *   Fixing the rows closes these two cases and leaves the seventh package to
 *   rediscover the same hole. `ci-recipe.ts` now runs biome as a per-package
 *   PHASE, resolved by script NAME (scripts.check if it runs biome, then
 *   scripts.lint if it runs biome). That executor can only reach a package that
 *   declares such a script — so this file asserts the other half: a package with
 *   a biome config MUST declare one. Executor + coverage, the same split the
 *   typecheck side already uses.
 *
 * STATIC ONLY: reads package.json and lists config files. No biome invocation.
 *
 * Run: bun run test:lint-coverage   (from bun-apps/)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUN_APPS = resolve(import.meta.dir, "..");

/** Biome reads the first of these it finds in the package directory. */
const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];

interface Pkg {
  name: string;
  dir: string;
  scripts: Record<string, string>;
  /** The biome config filename found in the package root, if any. */
  config?: string;
}

function workspacePackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const name of readdirSync(BUN_APPS).sort()) {
    const dir = join(BUN_APPS, name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest) || !statSync(dir).isDirectory()) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> };
    out.push({ name, dir, scripts: pkg.scripts ?? {}, config: BIOME_CONFIGS.find((c) => existsSync(join(dir, c))) });
  }
  return out;
}

/**
 * The script `local_ci` would actually run for this package, by ITS precedence
 * (ci-recipe.ts phase 3a): `check` first if it invokes biome, then `lint` if it
 * does. Returns undefined when local_ci would report `skipped: "no biome key"`.
 */
function lintExecutor(scripts: Record<string, string>): string | undefined {
  if (typeof scripts.check === "string" && /biome/.test(scripts.check)) return "check";
  if (typeof scripts.lint === "string" && /biome/.test(scripts.lint)) return "lint";
  return undefined;
}

/** Every script whose command line invokes biome, bare or via bunx/npx. */
function biomeScripts(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([, cmd]) => /(^|[\s&|;(])(?:bunx\s+|npx\s+)?(?:\.\/node_modules\/\.bin\/)?biome(\s|$)/.test(cmd))
    .map(([name]) => name);
}

const PACKAGES = workspacePackages();
const CONFIGURED = PACKAGES.filter((p) => p.config);

describe("lint-executor coverage", () => {
  test("the survey found the workspace and its biome packages (guards a silent empty sweep)", () => {
    // A rename of bun-apps/ or of biome.json would otherwise make every
    // assertion below vacuously true — the exact shape of green this guard
    // exists to deny.
    expect(PACKAGES.length).toBeGreaterThan(20);
    expect(CONFIGURED.length).toBeGreaterThanOrEqual(6);
  });

  test("every package with a biome config declares an executor local_ci can find", () => {
    const unlinted = CONFIGURED.filter((p) => !lintExecutor(p.scripts)).map((p) => `${p.name} (${p.config})`);
    expect(
      unlinted,
      `NO LINT EXECUTOR: ${unlinted.join(", ")} — these packages configure biome, so someone means ` +
        "them to be linted, but local_ci resolves the executor by NAME (scripts.check-if-it-runs-biome, " +
        'then scripts.lint-if-it-runs-biome) and finds nothing. Add `"check": "biome check ."`.',
    ).toEqual([]);
  });

  test("a biome script under any other name does NOT count — local_ci would not run it", () => {
    // Subtler than "nobody wrote a biome script": the package CAN have one, it
    // CAN pass when a human runs it, and the gate still skips it.
    const stranded = CONFIGURED.filter((p) => !lintExecutor(p.scripts) && biomeScripts(p.scripts).length > 0).map(
      (p) => `${p.name} (biome lives in: ${biomeScripts(p.scripts).join(", ")})`,
    );
    expect(
      stranded,
      `BIOME PRESENT BUT UNREACHABLE: ${stranded.join("; ")} — rename it to \`check\`, or have \`check\` ` +
        "call it.",
    ).toEqual([]);
  });

  test("`check` is not allowed to be the WEAKER `biome lint` when a `check` script exists", () => {
    // `biome lint .` reports neither format nor organizeImports. Every drift
    // found so far has been exactly those two, so a package resolving to a
    // lint-only executor would give a green gate over a red `biome check`.
    const weak = CONFIGURED.filter((p) => {
      const cmd = p.scripts.check;
      return typeof cmd === "string" && /biome/.test(cmd) && /biome\s+lint\b/.test(cmd);
    }).map((p) => p.name);
    expect(
      weak,
      `CHECK IS LINT-ONLY: ${weak.join(", ")} — \`biome lint\` skips format and organizeImports, which is ` +
        "what the drift has always been. Use `biome check .`.",
    ).toEqual([]);
  });

  test("every biome package pins the SAME biome version", () => {
    // Biome's formatter changes between minors. Two packages on different
    // versions format the same file differently, so `bun run check` becomes a
    // function of which package you happen to be standing in — and the gate
    // stops meaning one thing. Declared version, not the resolved one: the
    // lockfile is a separate claim, owned by the lockfile guards.
    const versions = new Map<string, string[]>();
    for (const p of CONFIGURED) {
      const manifest = JSON.parse(readFileSync(join(p.dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const v = manifest.devDependencies?.["@biomejs/biome"] ?? manifest.dependencies?.["@biomejs/biome"] ?? "UNDECLARED";
      versions.set(v, [...(versions.get(v) ?? []), p.name]);
    }
    const spread = [...versions.entries()].map(([v, names]) => `${v}: ${names.join(", ")}`);
    expect(spread.length, `BIOME VERSION SKEW —\n  ${spread.join("\n  ")}`).toBe(1);
    expect([...versions.keys()][0], "a package configures biome but does not declare it as a dependency").not.toBe(
      "UNDECLARED",
    );
  });

  test("a package with a biome script but no config is a config the guard cannot see", () => {
    // The inverse gap: a script pointing at a shared/parent config would run
    // under rules this file cannot enumerate, so `CONFIGURED` would understate
    // the covered set and the sweep-floor above would drift silently.
    const configless = PACKAGES.filter((p) => !p.config && biomeScripts(p.scripts).length > 0).map(
      (p) => `${p.name} (${biomeScripts(p.scripts).join(", ")})`,
    );
    expect(
      configless,
      `BIOME SCRIPT WITHOUT A CONFIG: ${configless.join("; ")} — biome would fall back to built-in ` +
        "defaults, and this guard's package survey (which keys off the config file) would not count them. " +
        "Add a biome.json to the package.",
    ).toEqual([]);
  });
});
