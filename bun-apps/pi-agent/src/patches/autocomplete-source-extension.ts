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
 * from sourceInfo.path OR source and REPLACE the leading scope marker with a
 * dedicated extension marker:
 *   `[t] desc` → `[e:wayfind] desc`;
 *   `[u:npm:@x/pi-agent-ext-hyperframes] desc` → `[e:hyperframes] desc`.
 * Extension-provided skills are misclassified by the framework as `[t]`
 * (temporary); rather than appending the ext to a WRONG scope letter we REPLACE
 * the tag outright. Entries whose path/source/baseDir contains no
 * `pi-agent-ext-<name>` keep their original marker (user/project/temporary).
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
 * Derive the owning `pi-agent-ext-<name>` from a suggestion's sourceInfo —
 * matched against path OR source OR baseDir. Returns undefined when the resource
 * is NOT from a pi-agent-ext package (user/project skills, etc.), in which case
 * the caller keeps the original marker.
 *
 * Pure — given the sourceInfo object only.
 */
export function owningExtension(
  sourceInfo: { path?: string; baseDir?: string; source?: string } | undefined,
): string | undefined {
  if (!sourceInfo) return undefined;
  const hay = `${sourceInfo.path ?? ""} ${sourceInfo.source ?? ""} ${sourceInfo.baseDir ?? ""}`;
  const m = hay.match(/pi-agent-ext-([a-z0-9-]+)/i);
  return m ? m[1] : undefined;
}

/** Replace the leading [tag] marker with a dedicated [e:<ext>] marker.
 *  "[t] desc" → "[e:wayfind] desc"; "[u:npm:@x/pi-agent-ext-hyperframes] desc"
 *  → "[e:hyperframes] desc"; "[t]" → "[e:wayfind]"; no marker → "[e:wayfind] desc". */
export function replaceMarker(rendered: string, ext: string): string {
  const end = rendered.indexOf("]");
  if (end >= 0) return `[e:${ext}]${rendered.slice(end + 1)}`;
  return `[e:${ext}] ${rendered}`;
}

// ── Module-scoped flag: apply once ──────────────────────────────────────────
let applied = false;

/**
 * Patch InteractiveMode.prototype.prefixAutocompleteDescription so the owning
 * extension (when derivable) REPLACES the leading scope marker with [e:<ext>].
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
    return ext ? replaceMarker(base, ext) : base;
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
