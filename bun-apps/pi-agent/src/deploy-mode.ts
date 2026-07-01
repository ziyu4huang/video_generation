/**
 * Extension injection for pi-agent — ONE enable-list, no `<cwd>/.pi/` dependency.
 *
 * WHY THIS EXISTS
 *   pi's resource discovery is **cwd-based**: it loads extensions and settings
 *   from whatever dir you invoke it in (`resource-loader.js` does
 *   `join(this.cwd, CONFIG_DIR_NAME, …)`). A portable, self-contained pi-agent
 *   bakes its OWN enable-list and injects the extensions as explicit `-e`
 *   flags so they load anywhere, regardless of cwd — while pi still operates on
 *   the user's real cwd (their project). It does NOT chdir.
 *
 * ONE ENABLE-LIST: `run-dir/settings.json` (`extensions` array) — the single
 * source of truth that replaced the old `<repo>/.pi/settings.json` `packages`
 * list and `deploy.config.json`. Both modes read it; only its LOCATION, the
 * packages base dir, and whether `-ne` is used differ:
 *
 *   • DEPLOY  — `<pkg>/run-dir/settings.json`, resolved against `<pkg>/packages/`.
 *     Uses `-ne` (self-contained): pi loads ONLY these `-e` paths and ignores
 *     `<cwd>/.pi/`. Why -ne is mandatory here: the package resolves extensions
 *     from `packages/<name>/…`, which are DIFFERENT canonical paths than a repo
 *     declaring the same extensions from `bun-apps/<name>/…`. Without -ne both
 *     sets load → tool-name conflicts (the original bug).
 *
 *   • SOURCE  — `pi-agent/run-dir/settings.json`, resolved against the workspace
 *     `bun-apps/<name>/`. NO `-ne` → ADDITIVE layering: project `<cwd>/.pi/`
 *     and personal `~/.pi/agent/` extensions load alongside the defaults.
 *     Safe because run-dir defaults and a repo `.pi/` declaring the same
 *     packages resolve to the SAME canonical paths → deduped (no conflict).
 *
 * LAYERING (source mode), highest → lowest:
 *     ~/.pi/agent/        (user, personal)      ← pi loads natively
 *     <cwd>/.pi/          (project, modifiable) ← pi loads natively
 *     run-dir/ defaults   (baked, read-only)    ← injected via -e
 *   Layers are strictly ADDITIVE — pi rejects duplicate tool names across
 *   *different* paths, so override = remove from the lower layer. "Priority"
 *   for settings *values* (model etc.) is pi's native user>project ordering.
 *
 * WHY `-e`: it is `temporary` scope = trust-free, so baked extensions load
 *   everywhere without project trust (critical for non-interactive / fresh dirs).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findWorkspaceRoot } from "./preflight.ts";

export interface InjectionModeResult {
  /** Which injection path matched. */
  mode: "deploy" | "run-dir";
  /** Package root (deploy) or workspace root (run-dir). */
  selfDir: string;
  /** Flattened argv to prepend: e.g. ["-ne", "-e", "/a/ext.ts", …] (deploy) or ["-e", …] (source). */
  extensionArgs: string[];
  /** Skip the cwd preflight? (deploy: yes; run-dir: no.) */
  skipPreflight: boolean;
}

const RUN_DIR_NAME = "run-dir";
const SETTINGS_FILE = "settings.json";

/**
 * Detect an injection mode. Tries deploy first, then source run-dir.
 * Returns null only when run-dir/settings.json is absent in both locations.
 */
export function detectInjectionMode(): InjectionModeResult | null {
  const selfDir = dirname(fileURLToPath(import.meta.url));

  // DEPLOY: the bundle sits at a package root that has both packages/ and its
  // own run-dir/settings.json (both written by scripts/deploy.ts).
  const deployRunDir = join(selfDir, RUN_DIR_NAME);
  if (
    existsSync(join(selfDir, "packages")) &&
    existsSync(join(deployRunDir, SETTINGS_FILE))
  ) {
    return {
      mode: "deploy",
      selfDir,
      extensionArgs: buildExtensionArgs(
        join(selfDir, "packages"),
        readEnableList(deployRunDir),
        true, // -ne: self-contained, ignore <cwd>/.pi/ (cross-path conflict safe)
      ),
      skipPreflight: true,
    };
  }

  // SOURCE: module lives at pi-agent/src/ → run-dir at pi-agent/run-dir/.
  const sourceRunDir = join(dirname(selfDir), RUN_DIR_NAME);
  if (existsSync(join(sourceRunDir, SETTINGS_FILE))) {
    const wsRoot = findWorkspaceRoot(selfDir);
    if (!wsRoot) return null; // not in a workspace → can't resolve packages
    return {
      mode: "run-dir",
      selfDir: wsRoot,
      extensionArgs: buildExtensionArgs(
        join(wsRoot, "bun-apps"),
        readEnableList(sourceRunDir),
        false, // NO -ne: additive layering with <cwd>/.pi/ + ~/.pi/
      ),
      skipPreflight: false,
    };
  }

  return null;
}

/** Read the `extensions` enable-list from a run-dir. */
function readEnableList(runDir: string): string[] {
  return (
    safeJson<{ extensions?: string[] }>(join(runDir, SETTINGS_FILE))?.extensions ??
    []
  );
}

/** Build the argv for a packages base + names. `noExt` prepends `-ne`. */
function buildExtensionArgs(baseDir: string, names: string[], noExt: boolean): string[] {
  const args: string[] = noExt ? ["-ne"] : [];
  for (const name of names) {
    for (const extTs of resolveExtensionEntries(join(baseDir, name))) {
      args.push("-e", extTs);
    }
  }
  return args;
}

/**
 * Resolve the `.ts` extension entry files a package exposes.
 * Reads the package's `pi.extensions` field (array of dirs; default
 * `["./extensions"]`), lists non-test `.ts` files in each, absolute.
 */
function resolveExtensionEntries(pkgDir: string): string[] {
  if (!existsSync(pkgDir)) return [];
  const pkg = safeJson<{ pi?: { extensions?: string[] } }>(join(pkgDir, "package.json"));
  const extDirs = pkg?.pi?.extensions?.length ? pkg.pi.extensions : ["./extensions"];
  const out: string[] = [];
  for (const rel of extDirs) {
    const dir = join(pkgDir, rel);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) continue;
      if (name.startsWith("__")) continue;
      out.push(join(dir, name));
    }
  }
  return out;
}

function safeJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
