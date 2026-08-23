/**
 * lazy-extensions.ts — bare-name `-e <alias>` resolution.
 *
 * Extracted from resolve.ts (spec step 1c). Nothing here participates in
 * run-dir argv construction: this runs BEFORE main() reads argv and rewrites
 * the USER's own `-e` values, where resolve.ts only ever produces argv of its
 * own. The two shared a file, not a job.
 *
 * Bare-name aliases (`-e workflow`) rewrite to absolute extension paths before
 * main() reads argv. This sidesteps the long-path mis-type problem and the
 * `src/workflow.ts` "valid factory function" trap — the alias always points at
 * the real factory file.
 *
 * HISTORY: this mechanism was originally created so heavy extensions could stay
 * OUT of manifest.json (zero cost on default sessions). s2-agent-ext-ultracode
 * was promoted to eager (default-enabled) on 2026-07-10 — it now lives in BOTH
 * manifest.extensions AND lazyExtensions. That is intentional and safe: the SDK
 * loader (core/extensions/loader.ts discoverAndLoadExtensions) dedups by resolved
 * path, so `-e workflow` from a user's old script + the eager splice resolve to
 * the same canonical path and the duplicate is skipped (no double registration).
 * The aliases are kept purely for backwards-compat (20+ scripts/docs/samples pass
 * `-e workflow`).
 *
 * resolve.ts re-exports everything public here, so no consumer or test import
 * changed.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import manifest from "./manifest.json";
import { mode, resolveBunAppsDir, warn } from "./run-context.ts";

/** Re-export the lazy registry (typed) for tests/inspectors. */
export interface LazySettings {
  lazyExtensions?: Record<string, string>;
}
const lazySettings: LazySettings = manifest;

/**
 * Bare-alias guard. Only fuzzy-resolve plain names like `workflow`,
 * `dynamic-workflows`. Anything that looks like a path (contains `/` or `\`,
 * or starts with `.`) or a URL scheme (`npm:`, `git:`, `http(s):`, `file:`) is
 * left for the SDK's own resolver — we never hijack real paths.
 */
export function looksLikeAlias(input: string): boolean {
  if (!input) return false;
  if (/[\\/]/.test(input)) return false; // path separator → real path
  if (input.startsWith(".")) return false; // ./… or ~/… → leave alone
  // scheme prefix (npm:pkg, git:…, http(s):…, file:…) → leave to SDK
  if (/^(npm|git|https?|file):/i.test(input)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input);
}

/**
 * Resolve a bare alias to an absolute extension path, or `undefined` to defer
 * to the SDK. Pure: all fs access is via the injected `exists`. Resolution order
 * (first hit wins):
 *   1. not a bare alias → undefined
 *   2. non-empty alias registry → warn (retired resolver) + fall through
 *   3. directory fallback: <bunAppsDir>/<alias>/extensions/ has exactly one .ts
 *   4. else undefined
 *
 * The exact-key / substring match arms were removed (2026-08-22
 * simplification): manifest.lazyExtensions has been `{}` since ultracode went
 * eager, so they were dead. The registry (registry.ts) still PARSES alias maps,
 * so a future re-add would silently strand without the warn below.
 */
export function resolveLazyExtension(
  input: string,
  s: LazySettings,
  bunAppsDir: string | undefined,
  exists: (p: string) => boolean,
  warnFn?: (m: string) => void,
): string | undefined {
  if (!looksLikeAlias(input)) return undefined;

  const lazy = s.lazyExtensions ?? {};
  if (Object.keys(lazy).length > 0) {
    warnFn?.(
      `lazyExtensions registry is non-empty (${Object.keys(lazy).join(", ")}) but ` +
        `alias resolution was retired — register the extension eagerly instead`,
    );
  }

  // Directory fallback: <bunAppsDir>/<alias>/extensions/*.ts (exactly one)
  if (bunAppsDir) {
    const dir = join(bunAppsDir, input, "extensions");
    if (exists(dir)) {
      // `exists` (existsSync) is true for files too: if <alias>/extensions is a
      // file, readdirSync throws ENOTDIR. Treat that as "fallback doesn't apply"
      // (return undefined below) rather than crashing argv resolution.
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        entries = [];
      }
      const ts = entries.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      if (ts.length === 1) return join(dir, ts[0]!);
      if (ts.length > 1) {
        warnFn?.(`lazy alias "${input}" → ${dir} has ${ts.length} .ts files; can't pick; leaving for SDK`);
      }
    }
  }

  return undefined;
}

/**
 * Return a NEW argv where every `-e`/`--extension` value that resolves via
 * `resolve` is replaced by its absolute path. Non-alias values, unresolved
 * aliases, and the rest of argv are passed through untouched.
 */
export function rewriteExtensionArgs(
  argv: string[],
  resolve: (input: string) => string | undefined,
  warnFn?: (m: string) => void,
): string[] {
  const out = argv.slice();
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === "-e" || out[i] === "--extension") {
      const val = out[i + 1]!;
      const resolved = resolve(val);
      if (resolved && resolved !== val) {
        out[i + 1] = resolved;
        warnFn?.(`-e ${val} → ${resolved}`);
      }
    }
  }
  return out;
}

/**
 * Orchestrator: resolve bunAppsDir (source/bundle) and rewrite `-e <alias>`
 * values in `argv` in place. No-op outside source mode (no repo bun-apps/ to resolve
 * against) — mirrors resolveRunDirArgv's guard.
 */
export async function rewriteArgvLazyExtensions(argv: string[]): Promise<void> {
  if (mode !== "source") return;
  const bunAppsDir = await resolveBunAppsDir();
  const before = argv.slice();
  const debug = process.env.BUN_PI_DEBUG_RUN_DIR === "1";
  const next = rewriteExtensionArgs(
    argv,
    (v) => resolveLazyExtension(v, lazySettings, bunAppsDir, existsSync, warn),
    debug ? (m) => console.error(`[bun-pi] run-dir: ${m}`) : undefined,
  );
  // mutate in place
  argv.length = 0;
  argv.push(...next);
  if (debug && JSON.stringify(before) !== JSON.stringify(next)) {
    console.error("[bun-pi] run-dir: rewrote lazy extension aliases");
  }
}
