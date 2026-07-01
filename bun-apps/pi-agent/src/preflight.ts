/**
 * Preflight workspace-dependency probe — shared by the cli.ts startup guard
 * and scripts/setup.ts so the two never drift.
 *
 * WHY THIS EXISTS
 *   pi loads extensions declared in `.pi/settings.json` `packages`. Those
 *   extension files are plain `.ts` loaded at runtime, and they import their
 *   dependencies as bare specifiers (e.g. pi-knowledge-card does
 *   `import ... from "pi-obsidian/extensions/obsidian.ts"`). For that to
 *   resolve, the monorepo workspace must be installed at the repo root
 *   (`bun install` at the root, NEVER inside pi-agent/). If it hasn't been
 *   run, pi dies with a cryptic
 *       Cannot find module 'pi-obsidian/extensions/obsidian.ts'
 *   before the TUI ever starts. This module detects that exact condition by
 *   reproducing real module resolution — not by checking for node_modules
 *   symlinks (bun can resolve workspace peers without any symlink existing).
 *
 * WHAT IT CHECKS
 *   For every local package listed in `.pi/settings.json`, for every
 *   dependency / peerDependency that is itself a workspace package, it asks
 *   bun "can this package resolve that workspace peer from its own location?"
 *   via `import.meta.resolve(dep/package.json, parentUrl)`. A throw is the
 *   same failure pi's extension loader will hit moments later.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ProbeFailure {
  from: string; // name of the local package doing the import
  dep: string; // workspace peer it tried to resolve
  error: string;
}

export interface ProbeResult {
  repoRoot: string | null;
  localPackages: string[]; // names checked
  checks: number;
  failures: ProbeFailure[];
  ok: boolean;
}

/**
 * Walk up from `start` (default cwd, then this module's dir) to find the
 * nearest directory that looks like the pi monorepo root: contains both
 * `.pi/settings.json` and a `package.json` declaring `workspaces`.
 * Returns null when not in such a layout (guard then skips — never blocks).
 */
export function findPiRepoRoot(start?: string): string | null {
  const starts = Array.from(
    new Set([start ?? process.cwd(), dirname(import.meta.dir)]),
  );
  for (const s of starts) {
    let cur = s;
    for (;;) {
      if (
        existsSync(join(cur, ".pi", "settings.json")) &&
        hasWorkspaces(join(cur, "package.json"))
      ) {
        return cur;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

function hasWorkspaces(pkgJsonPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0;
  } catch {
    return false;
  }
}

function readJson<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Build name → package.json path for every workspace package declared at the
 * monorepo root (expands `bun-apps/*` etc. via Bun.Glob).
 */
function workspaceNames(repoRoot: string): Map<string, string> {
  const rootPkg = readJson<{ workspaces?: string[] }>(
    join(repoRoot, "package.json"),
  );
  const globs = rootPkg?.workspaces ?? [];
  const map = new Map<string, string>();
  for (const g of globs) {
    // Support both "bun-apps/*" and bare "bun-apps" forms.
    const base = g.endsWith("/*") ? g.slice(0, -2) : g;
    const baseDir = join(repoRoot, base);
    let entries: string[];
    try {
      entries = readdirSync(baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(baseDir, d.name));
    } catch {
      continue;
    }
    for (const dir of entries) {
      const pkgPath = join(dir, "package.json");
      const pkg = readJson<{ name?: string }>(pkgPath);
      if (pkg?.name) map.set(pkg.name, pkgPath);
    }
  }
  return map;
}

interface LocalPkg {
  name: string;
  pkgPath: string;
  manifest: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
}

/** Local (non-npm) packages listed in `.pi/settings.json`. */
function loadLocalPiPackages(repoRoot: string): LocalPkg[] {
  const settings = readJson<{ packages?: string[] }>(
    join(repoRoot, ".pi", "settings.json"),
  );
  const entries = settings?.packages ?? [];
  const piDir = join(repoRoot, ".pi");
  const out: LocalPkg[] = [];
  for (const entry of entries) {
    if (entry.startsWith("npm:") || entry.startsWith("@")) continue; // registry pkg
    const dir = resolve(piDir, entry);
    const pkgPath = join(dir, "package.json");
    const manifest = readJson<LocalPkg["manifest"]>(pkgPath);
    if (!manifest) continue; // not a node package
    out.push({ name: manifest.name ?? entry, pkgPath, manifest });
  }
  return out;
}

/**
 * Resolve a `<dep>/package.json` bare specifier as seen from `parentPkgPath`.
 * Uses bun's real resolver — returns the resolved file:// URL or throws.
 */
function resolveFromPackage(dep: string, parentPkgPath: string): string {
  const parentUrl = pathToFileURL(parentPkgPath).href;
  // `import.meta.resolve` is bun's faithful runtime resolver; the parent
  // argument pins resolution to the importing package's location.
  return (import.meta.resolve as (
    spec: string,
    parent?: string,
  ) => string)(`${dep}/package.json`, parentUrl);
}

/**
 * Probe every local pi-package's ability to resolve its workspace peers.
 * `ok === false` means pi's extension loader will fail to start.
 */
export async function probeWorkspaceDeps(opts?: {
  repoRoot?: string;
}): Promise<ProbeResult> {
  const repoRoot = opts?.repoRoot ?? findPiRepoRoot();
  if (!repoRoot) {
    return { repoRoot: null, localPackages: [], checks: 0, failures: [], ok: true };
  }

  const wsNames = workspaceNames(repoRoot);
  const locals = loadLocalPiPackages(repoRoot);
  const failures: ProbeFailure[] = [];
  let checks = 0;

  for (const lp of locals) {
    const deps = {
      ...(lp.manifest.dependencies ?? {}),
      ...(lp.manifest.peerDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      // Only check workspace peers — those are the cross-package imports
      // (like pi-knowledge-card → pi-obsidian) that break without `bun install`.
      if (!wsNames.has(dep)) continue;
      if (dep === lp.name) continue;
      checks++;
      try {
        resolveFromPackage(dep, lp.pkgPath);
      } catch (e) {
        failures.push({
          from: lp.name,
          dep,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return {
    repoRoot,
    localPackages: locals.map((l) => l.name),
    checks,
    failures,
    ok: failures.length === 0,
  };
}
