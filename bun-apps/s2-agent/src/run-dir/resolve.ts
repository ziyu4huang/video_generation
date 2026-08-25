/**
 * resolve.ts — resolves this repo's fixed extension/skill set to ABSOLUTE paths,
 * independent of process.cwd(). This is what makes s2-agent "deploy to any path":
 * the vendored pi-coding-agent has no --cwd flag and threads process.cwd() into
 * every project-resource lookup (.pi/settings.json, .pi/extensions, etc.), so the
 * only cwd-independent hook it exposes is passing already-absolute paths via
 * -e/--skill CLI flags (resolvePath() returns absolute inputs unchanged, and
 * these paths are never trust-gated). See src/run-dir/manifest.json for the
 * source list and bun-apps/s2-agent/README.md for the full rationale.
 *
 * MODE DETECTION: the three-level ascent (src/run-dir/ → src/ → s2-agent/ →
 * bun-apps/) in run-context.ts computes the real bun-apps/ dir only when this
 * file is loaded from source — bun's bundler rewrites import.meta.dir to the
 * output location. That leaves two modes: the
 * compiled binary, which resolves nothing from the repo and ships its default
 * extensions as static factories instead, and source. `mode` and
 * resolveBunAppsDir() live in run-context.ts so the split-out siblings branch
 * identically.
 *
 * A third mode, "deploy-bundle", used to sit between them: a `s2-agent.js` next
 * to its own `ext-bundles/` and a `.deploy-bundle` marker. Its producer
 * (scripts/deploy.ts) was retired in #1740 and nothing writes those markers any
 * more — dead-deploy-markers.test.ts keeps it that way — so the layout
 * detector, its argv builder, and the baked run-dir-base.ts they read went with
 * it in Phase 1b.
 *
 * WHAT THIS FILE OWNS after the step-1c split: deploy-layout detection and argv
 * construction. One neighbouring concern moved out and is re-exported below,
 * so every existing import of this module still resolves:
 *   - deps-probe.ts — "will these extensions be able to import what they
 *                     need?", auto-install, the missing-deps guide
 * (lazy-extensions.ts, the `-e <alias>` rewriter, was deleted 2026-08-25
 * round-2 ticket 11: manifest.lazyExtensions had been `{}` since ultracode
 * went eager and the directory-fallback arm had zero live consumers —
 * `-e <file>` loading is the SDK's own and was never here.)
 * The re-exports are one-hop: every line below names the module that DEFINES the
 * symbol, the invariant s2-agent-core-runtime's barrel had to be repaired to
 * restore (see its CONTEXT.md "One-hop barrel").
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.json";
import { detectMode } from "../mode.ts";
import type { UserSuppressFlags } from "../cli-argv.ts";
import { resolveBunAppsDir, warn } from "./run-context.ts";
import {
  emitMissingDepsGuide,
  maybeAutoInstall,
  resolveNpmExtensionPaths,
} from "./deps-probe.ts";

// Re-export so callers (and tests) can import detectMode from the resolver
// surface; the implementation lives in the shared src/mode.ts.
export { detectMode };

// Exactly the symbols this module exported BEFORE the split — no more. `mode`,
// `resolveBunAppsDir`, `maybeAutoInstall`, `emitMissingDepsGuide` and
// `resolveNpmExtensionPaths` were module-private here and stay unexported from
// this surface; extraction is not a reason to widen the public API.
export {
  missingExtensionPackages,
  probeMissingExtensionDeps,
  runtimeDependencyNames,
} from "./deps-probe.ts";

const url = import.meta.url;

/**
 * Returns a flat argv fragment: ["-e", absPath, ..., "--skill", absPath, ...],
 * filtered by user-passed `-ne`/`-ns` (userFlags — computed by the caller from
 * the PRE-SPLICE argv, see src/patches/load-run-dir-resources.ts). The deploy
 * modes' own self-injected "-ne" is a bare token and survives the filter.
 */
export async function resolveRunDirArgv(
  userFlags: Partial<UserSuppressFlags> = {},
): Promise<string[]> {
  return suppressResolvedArgv(await resolveRunDirArgvUnfiltered(), userFlags);
}

async function resolveRunDirArgvUnfiltered(): Promise<string[]> {
  // A compiled-binary branch (emit NO -e flags; resolve manifest.binarySkills
  // against the extraction dir or the exe's own dir) used to live here — it
  // went with the compiled core and its embedded-assets extraction mechanism
  // (deploy-platform-neutral-core ticket 03, 2026-08-23). The bundle core
  // never runs this resolver at all: sh mode owns extension/skill resolution
  // and disables the run-dir patch (cli-sh.ts's BUN_PI_LOAD_RUN_DIR ??= "0").
  //
  // SOURCE mode: additive layering (no -ne) with <cwd>/.pi/ +
  // ~/.pi/. Safe because run-dir resolves to the same canonical bun-apps/ paths
  // a repo .pi/ would, so pi dedupes them.
  const bunAppsDir = await resolveBunAppsDir();
  // Opt-in: if a declared npm ext is missing and the user set
  // BUN_PI_AUTO_INSTALL=1, run `bun install` at the workspace root (bun-apps/) BEFORE building
  // argv (buildArgv re-probes via resolveNpmExtensionPaths and picks it up).
  maybeAutoInstall(bunAppsDir);
  const argv = await buildArgv(bunAppsDir);
  // Always-on (source mode only): if anything is STILL missing after any
  // auto-install attempt, emit one consolidated, actionable guide block.
  emitMissingDepsGuide(bunAppsDir);
  return argv;
}

/**
 * Build the -e/--skill argv from the manifest against a bun-apps-equivalent
 * base dir (undefined → skip workspace-local entries, warn). npm extensions
 * resolve from node_modules regardless of base.
 */
async function buildArgv(bunAppsDir: string | undefined): Promise<string[]> {
  return buildArgvFromManifest(
    manifest,
    bunAppsDir,
    await resolveNpmExtensionPaths(),
    existsSync,
    warn,
  );
}

/**
 * Pure argv builder — everything passed in, no fs/network. Exported so the
 * -e/--skill assembly + skip-on-missing logic is unit-testable without the
 * mode/env machinery of buildArgv.
 *
 *   - workspace extensions → `-e <base>/<rel>` (only when `exists` says so)
 *   - npm extensions       → appended after workspace, as `-e <absPath>`
 *   - skills               → `--skill <base>/<rel>`
 *   - missing paths        → skipped, reported via `warnFn`
 *   - undefined base       → workspace extensions AND skills skipped + warned
 */
export function buildArgvFromManifest(
  m: { extensions?: (string | { entry?: string })[]; skills?: string[] },
  bunAppsDir: string | undefined,
  npmPaths: string[],
  exists: (p: string) => boolean,
  warnFn: (msg: string) => void,
): string[] {
  const argv: string[] = [];
  const extensionPaths: string[] = [];
  if (bunAppsDir) {
    for (const entry of m.extensions ?? []) {
      const rel = typeof entry === "string" ? entry : entry.entry;
      if (!rel) {
        // A declared object missing `entry` (malformed manifest) would otherwise
        // throw an opaque TypeError inside path.join and crash launch. Skip +
        // warn so the runtime failure mode matches the contract test. (I-1)
        warnFn(`manifest extension missing 'entry', skipping: ${JSON.stringify(entry)}`);
        continue;
      }
      extensionPaths.push(join(bunAppsDir, rel));
    }
  } else {
    warnFn("could not determine bun-apps/ directory — skipping workspace-local extensions");
  }
  extensionPaths.push(...npmPaths);
  for (const p of extensionPaths) {
    if (exists(p)) {
      argv.push("-e", p);
    } else {
      warnFn(`extension path not found, skipping: ${p}`);
    }
  }
  if (bunAppsDir) {
    for (const rel of m.skills ?? []) {
      const p = join(bunAppsDir, rel);
      if (exists(p)) {
        argv.push("--skill", p);
      } else {
        warnFn(`skill path not found, skipping: ${p}`);
      }
    }
  }
  return argv;
}

/**
 * Drop `-e <path>` / `--skill <path>` pairs from a RUN-DIR-RESOLVED argv
 * fragment according to user-passed suppression flags (see
 * src/cli-argv.ts userSuppressFlags). Only ever applied to the argv THIS
 * module produced — the user's own `-e <path>` flags live elsewhere in
 * process.argv and are untouched, which matches upstream pi's `-ne`
 * semantics (explicit CLI extensions still load under -ne).
 * Bare tokens (the deploy modes' self-injected "-ne") pass through.
 */
export function suppressResolvedArgv(
  argv: string[],
  flags: Partial<UserSuppressFlags>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (flags.noExtensions && (tok === "-e" || tok === "--extension")) {
      i++; // skip payload
      continue;
    }
    if (flags.noSkills && tok === "--skill") {
      i++; // skip payload
      continue;
    }
    out.push(tok);
  }
  return out;
}