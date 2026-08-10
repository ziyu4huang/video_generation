/**
 * autocomplete-source-extension — show the OWNING extension next to each
 * autocomplete entry's scope marker.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The `/<cmd>` and `/skill:` picker prefixes every entry's description with a
 * SCOPE marker via InteractiveMode.prototype.prefixAutocompleteDescription:
 *   - `[u]` / `[p]` / `[t]` (user / project / temporary) for local sources
 *   - `[u:npm:...]` / `[u:git:...]` for npm / git sources (which already
 *     self-attribute their package).
 * For THIS repo's locally-loaded extension skills (loaded via `resources_discover`
 * from `.../bun-apps/pi-agent-ext-<name>/...`), the source is "local"/"auto" so
 * the marker renders BARE (e.g. `[t]`) with no package — you can't tell whether
 * a skill comes from `wayfind` vs `superpowers`.
 *
 * FIX
 * ---
 * Wrap InteractiveMode.prototype.prefixAutocompleteDescription so that AFTER the
 * SDK renders the base `[tag] desc`, we derive the owning `pi-agent-ext-<name>`
 * from sourceInfo.path and inject it inside the leading `[...]`:
 *   `[t] desc` → `[t · wayfind] desc`.
 * npm / git / http / git@ sources are left UNCHANGED (they already render their
 * package in the marker — see getAutocompleteSourceTag in the SDK dist).
 *
 * CHOKEPOINT (PATH A): prefixAutocompleteDescription is the single prefixer used
 * by ALL autocomplete suggestion builders — prompt templates, extension slash
 * commands, AND skills all call it (verified in interactive-mode.js lines
 * 462/472/484). So wrapping the one method covers every suggestion type.
 *
 * Env gate: BUN_PI_AUTOCOMPLETE_SOURCE_EXTENSION (default on). Reversible.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent";

/**
 * Derive the owning `pi-agent-ext-<name>` from a suggestion's sourceInfo path.
 *
 * Returns undefined when the resource is NOT from a local pi-agent-ext package
 * (user/project skills, or npm/git/http sources that already self-attribute).
 *
 * Pure — given the sourceInfo object only.
 */
export function owningExtension(
  sourceInfo: { path?: string; baseDir?: string; source?: string } | undefined,
): string | undefined {
  if (!sourceInfo) return undefined;
  const src = sourceInfo.source ?? "";
  // npm:/git/http sources already render their package in the marker — don't duplicate.
  if (
    src.startsWith("npm:") ||
    /^https?:\/\//.test(src) ||
    src.startsWith("git@") ||
    src.startsWith("git:")
  ) {
    return undefined;
  }
  const path = sourceInfo.path ?? sourceInfo.baseDir ?? "";
  // Match `pi-agent-ext-<name>` as a path SEGMENT: a separator (or start of
  // string) before it, and a separator OR end-of-string after it (baseDir may
  // be the package root with no trailing slash).
  const m = path.match(/(?:^|[\\/])pi-agent-ext-([^\\/]+?)(?:[\\/]|$)/);
  return m ? m[1] : undefined;
}

/**
 * Inject ` · <ext>` inside the leading [tag] of an already-rendered description.
 *
 *   "[u] desc"            → "[u · wayfind] desc"
 *   "[u:npm:x] desc"      → "[u:npm:x · wayfind] desc"
 *   "desc only" (no tag)  → "[· wayfind] desc only"
 *
 * Pure — given two strings.
 */
export function injectExtension(rendered: string, ext: string): string {
  const close = rendered.indexOf("]");
  if (close >= 0) return `${rendered.slice(0, close)} · ${ext}${rendered.slice(close)}`;
  return `[· ${ext}] ${rendered}`;
}

// ── Module-scoped flag: apply once ──────────────────────────────────────────
let applied = false;

/**
 * Patch InteractiveMode.prototype.prefixAutocompleteDescription so the owning
 * extension (when derivable) is injected into the leading scope marker.
 *
 * Returns true if applied, false if already applied or the target method is
 * missing (e.g. an SDK upgrade changed the shape).
 */
export function applyAutocompleteSourceExtensionPatch(): boolean {
  if (applied) return false;
  const proto = InteractiveMode.prototype as unknown as {
    prefixAutocompleteDescription?: (description: string | undefined, sourceInfo: unknown) => string;
  };
  const original = proto.prefixAutocompleteDescription;
  if (typeof original !== "function") return false;

  proto.prefixAutocompleteDescription = function (
    this: unknown,
    description: string | undefined,
    sourceInfo: unknown,
  ): string {
    const base = original.call(this, description, sourceInfo);
    const ext = owningExtension(sourceInfo as Parameters<typeof owningExtension>[0]);
    return ext ? injectExtension(base, ext) : base;
  };
  applied = true;
  return true;
}

// ── Import-time side effect ──────────────────────────────────────────────────
const debug =
  process.env.BUN_PI_DEBUG_PATCHES === "1" || process.env.BUN_PI_DEBUG_PATCHES === "true";
const enabled = process.env.BUN_PI_AUTOCOMPLETE_SOURCE_EXTENSION !== "0";
if (enabled) {
  const ok = applyAutocompleteSourceExtensionPatch();
  if (debug) {
    console.error(
      `[bun-pi] autocomplete-source-extension: ${ok ? "applied" : "already applied or failed"}`,
    );
  }
}

export const autocompleteSourceExtensionPatchApplied = true;
