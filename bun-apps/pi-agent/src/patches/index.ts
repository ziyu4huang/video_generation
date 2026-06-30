/**
 * Patch registry — every monkey-patch lives behind an env gate so behavior is
 * reversible and debuggable. Add a new patch = add one entry here.
 *
 * Patches are applied via DYNAMIC import inside their gate, so a disabled
 * patch never runs (its side-effect module is not loaded).
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

interface PatchDef {
  name: string;
  env: string;
  defaultValue: boolean;
  /** Dynamic import path; importing the module applies the patch as a side effect. */
  module: string;
}

const PATCHES: PatchDef[] = [
  {
    name: "only-models-json",
    env: "BUN_PI_ONLY_MODELS_JSON",
    defaultValue: true,
    module: "./only-models-json.ts",
  },
];

/**
 * Apply all enabled patches. Must run *before* `main()` is called, because
 * `main()` constructs the `ModelRegistry` instance whose prototype we patch.
 */
export async function applyPatches(): Promise<AppliedPatch[]> {
  const applied: AppliedPatch[] = [];
  const debug = envFlag("BUN_PI_DEBUG_PATCHES", false);

  for (const def of PATCHES) {
    const enabled = envFlag(def.env, def.defaultValue);
    if (enabled) {
      await import(def.module); // side-effect: patches the prototype
      applied.push({ ...def, applied: true });
    } else {
      applied.push({ ...def, applied: false });
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
