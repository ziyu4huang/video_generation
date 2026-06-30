/**
 * Patch registry — every monkey-patch lives behind an env gate so behavior is
 * reversible and debuggable. Add a new patch = add one entry here.
 *
 * IMPORTANT (bundling): dynamic imports must use static string literals so bun
 * can trace and include the modules at bundle time. Do NOT use a variable path
 * like `import(def.module)` — bun cannot statically analyze that and the module
 * will be missing from the bundle.
 */

export interface AppliedPatch {
  name: string;
  env: string;
  defaultValue: boolean;
  applied: boolean;
}

function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/**
 * Apply all enabled patches. Must run *before* `main()` is called, because
 * `main()` constructs the `ModelRegistry` instance whose prototype we patch.
 *
 * Each patch is gated on an env flag; a disabled patch is never executed.
 * Adding a new patch: add a block below, wired to a static import literal.
 */
export async function applyPatches(): Promise<AppliedPatch[]> {
  const debug = envFlag("BUN_PI_DEBUG_PATCHES", false);
  const applied: AppliedPatch[] = [];

  // ── patch: set-package-dir ────────────────────────────────────────────────
  // Sets PI_PACKAGE_DIR so pi's asset paths (themes, templates) resolve
  // correctly when running as a bundled .js. Must run first, before any other
  // patch that might trigger pi module initialization.
  {
    const name = "set-package-dir";
    const env = "BUN_PI_SET_PACKAGE_DIR";
    const defaultValue = true;
    const enabled = envFlag(env, defaultValue);
    if (enabled) {
      await import("./set-package-dir.ts");
    }
    applied.push({ name, env, defaultValue, applied: enabled });
  }

  // ── patch: skip-update-check ──────────────────────────────────────────────
  // Silence pi's "Update Available" banner for shipped artifacts (bundle .js +
  // binary), where `pi update` is meaningless. No-op in source mode.
  {
    const name = "skip-update-check";
    const env = "BUN_PI_SKIP_UPDATE_CHECK";
    const defaultValue = true;
    const enabled = envFlag(env, defaultValue);
    if (enabled) {
      await import("./skip-update-check.ts");
    }
    applied.push({ name, env, defaultValue, applied: enabled });
  }

  // ── patch: pre-load-providers ─────────────────────────────────────────────
  // Injects custom LLM providers into pi's ModelRegistry before main() starts.
  {
    const name = "pre-load-providers";
    const env = "BUN_PI_PRE_LOAD_PROVIDERS";
    const defaultValue = true;
    const enabled = envFlag(env, defaultValue);
    if (enabled) {
      // Static string literal — bun can trace and bundle this module.
      await import("../pre-load-providers.ts");
    }
    applied.push({ name, env, defaultValue, applied: enabled });
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
