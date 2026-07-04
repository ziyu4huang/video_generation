/**
 * Patch registry — every monkey-patch lives behind an env gate so behavior is
 * reversible and debuggable. Add a new patch = add one entry here.
 *
 * IMPORTANT (bundling): dynamic imports must use static string literals so bun
 * can trace and include the modules at bundle time. Do NOT use a variable path
 * like `import(def.module)` — bun cannot statically analyze that and the module
 * will be missing from the bundle.
 */

/** Literal union of registered patch names. Keep in sync with PATCH_TABLE + the
 *  `switch` in applyPatches() — the `default: never` guard catches a missing case. */
export type PatchName =
	| "set-package-dir"
	| "skip-update-check"
	| "pre-load-providers"
	| "load-run-dir-resources"
	| "default-model-env"
	| "ensure-extension-deps";

export interface AppliedPatch {
  name: PatchName;
  env: string;
  defaultValue: boolean;
  applied: boolean;
}

/** Metadata for each patch: its env gate + the default when the env is unset. */
export interface PatchEntry {
  name: PatchName;
  env: string;
  defaultValue: boolean;
}

/**
 * The patch registry as data. Order = execution order (set-package-dir must run
 * first). The module to import per entry is resolved by name in applyPatches()
 * via a static-literal switch (bun needs literal import paths to bundle — see
 * the file header). Adding a patch = add a PatchName literal, an entry here,
 * AND a `case` below (the `default: never` guard enforces the third).
 */
export const PATCH_TABLE: readonly PatchEntry[] = [
  // set-package-dir runs first: it sets PI_PACKAGE_DIR before any other patch
  // might trigger pi module initialization.
  { name: "set-package-dir", env: "BUN_PI_SET_PACKAGE_DIR", defaultValue: true },
  { name: "skip-update-check", env: "BUN_PI_SKIP_UPDATE_CHECK", defaultValue: true },
  { name: "pre-load-providers", env: "BUN_PI_PRE_LOAD_PROVIDERS", defaultValue: true },
  { name: "load-run-dir-resources", env: "BUN_PI_LOAD_RUN_DIR", defaultValue: true },
  { name: "default-model-env", env: "BUN_PI_DEFAULT_MODEL_ENV", defaultValue: true },
  // ensure-extension-deps runs LAST among setup patches: it materializes the
  // repo-root node_modules symlinks that let Bun native-import every extension
  // graph (so try-native succeeds and jiti never transforms — see the patch
  // file for the >4 KB tempfile bug this sidesteps). Still before main().
  { name: "ensure-extension-deps", env: "BUN_PI_ENSURE_EXT_DEPS", defaultValue: true },
];

/**
 * Read a boolean env flag. Accepts "1" / "true" / "yes" (case-insensitive) as
 * truthy; any other set value is false; undefined → fallback. Pure given `env`.
 * Exported because it is the decision primitive for every patch + the debug
 * flag — exactly the logic that silently breaks.
 */
export function envFlag(
  name: string,
  fallback: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/**
 * Pure: which patches WOULD apply for a given env, without executing any.
 * Returns the AppliedPatch[] (decision only). Separating decision from
 * execution makes the gating unit-testable without triggering real patch
 * side effects (monkey-patching, argv splicing, env mutation).
 */
export function resolvePatchPlan(
  table: readonly PatchEntry[] = PATCH_TABLE,
  env: Record<string, string | undefined> = process.env,
): AppliedPatch[] {
  return table.map((e) => ({ ...e, applied: envFlag(e.env, e.defaultValue, env) }));
}

/**
 * Apply all enabled patches. Must run *before* `main()` is called, because
 * `main()` constructs the `ModelRegistry` instance whose prototype we patch.
 *
 * Each patch is gated on an env flag (resolvePatchPlan); a disabled patch is
 * never executed. The per-patch import is a static string literal inside a
 * switch case so bun can trace + bundle it — do NOT replace with a variable
 * `import(entry.module)` (see file header).
 */
export async function applyPatches(): Promise<AppliedPatch[]> {
  const debug = envFlag("BUN_PI_DEBUG_PATCHES", false);
  const applied = resolvePatchPlan();

  for (const p of applied) {
    if (!p.applied) continue;
    switch (p.name) {
      case "set-package-dir":
        await import("./set-package-dir.ts");
        break;
      case "skip-update-check":
        await import("./skip-update-check.ts");
        break;
      case "pre-load-providers":
        await import("../pre-load-providers.ts");
        break;
      case "load-run-dir-resources":
        await import("./load-run-dir-resources.ts");
        break;
      case "default-model-env":
        await import("./default-model-env.ts");
        break;
      case "ensure-extension-deps":
        await import("./ensure-extension-deps.ts");
        break;
      default: {
        // Exhaustiveness guard — a PATCH_TABLE entry with no matching case.
        const _exhaustive: never = p.name;
        throw new Error(`unhandled patch: ${_exhaustive}`);
      }
    }
  }

  if (debug) {
    console.error("[bun-pi] patches:");
    for (const p of applied) {
      console.error(
        `  ${p.applied ? "✓" : "·"} ${p.name}  (env ${p.env}, default ${p.defaultValue})`,
      );
    }
  }

  return applied;
}
