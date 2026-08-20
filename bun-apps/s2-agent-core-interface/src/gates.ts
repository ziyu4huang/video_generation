/**
 * First-class gate contract (wayfinder ticket 01) — a gate is a declared
 * object with a stable id, referenced by tools via `gating: { gate: "<id>" }`.
 *
 * This is the SHARED registry: each owning extension declares its gate family
 * ONCE here (by id); every tool in the family references the id instead of
 * inlining keywords per tool. That ends:
 *   - the Spec-B hazard — verbatim-duplicated `gating` across sibling tools
 *     (edit one side and the family silently splits), and
 *   - the fingerprint-JSON reconstruction in tool-gate
 *     (`gateGatingKey` / `gatesWithSameGating` — deleted in phase 01c):
 *     sibling identity is now "same id", not "byte-equal keywords".
 *
 * Precedent: power-tool's `DIAGNOSTIC_GATING` (one shared object for all six
 * inspect_* tools) — this generalizes that pattern with an id + registry.
 *
 * `GATE_DEFS` is populated at import time by owning extensions. tool-gate reads
 * it in `buildEffectiveGates` (reference form); the drift-guard asserts every
 * referenced id is known and every declared id is referenced (phase 01c).
 */

/** A gate family — declared once, referenced by id from any tool's `gating`. */
export interface Gate {
  /** Stable family id — the single name for a co-firing sibling group. */
  id: string;
  /** Bare-word/phrase triggers (tool-gate matchesKeyword). Fires if any matches
   *  OR `requires` is met. Optional: a `core:true` tool never references a gate. */
  keywords?: string[];
  /** Optional co-occurrence (noun ∧ verb) — see tool-gate CoOccurrence. */
  requires?: { nouns: string[]; verbs: string[] };
  /** One-line description — used for enable_tool intent matching + list output.
   *  Falls back to the referencing tool's description when absent. */
  description?: string;
}

/**
 * The tool-facing `gating` field on a `ToolDefinition` (replaces the former
 * ambient-global `Gating` — wayfinder ticket 01, phase 01c). Two forms only:
 *   - `{ core: true }` — always active (core/escape-hatch), never gated, and
 *   - `{ gate: "<id>" }` — reference to a family declared in `GATE_DEFS`.
 * The legacy inline form (`{ keywords, requires }` per tool) is DELETED — the
 * family spec lives in `GATE_DEFS` and tools only reference it by id.
 */
export interface Gating {
  /** If true, always active (core/escape-hatch); never gated. */
  core?: boolean;
  /** Reference to a shared gate family declared in `GATE_DEFS`. */
  gate?: string;
}

/**
 * Shared gate registry, keyed by id. Owning extensions populate it at module
 * load (`GATE_DEFS["flux2"] = { id: "flux2", keywords: [...], ... }`); tool-gate
 * resolves `gating: { gate: id }` references through it. One shared module
 * instance across the workspace — the same map every consumer sees.
 */
export const GATE_DEFS: Record<string, Gate> = {};
