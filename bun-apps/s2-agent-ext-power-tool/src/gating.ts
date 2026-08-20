/**
 * gating.ts — UN-GATED (wayfinder ticket 06, HITL decision 2026-08-16).
 *
 * The six inspect_* diagnostics are now owner-declared CORE (always-on), not
 * keyword-gated: they are the exact tools the agent needs WHEN SOMETHING IS
 * WRONG, and keyword-gating ("schema cost" / "pathology") made them unreachable
 * unless the prompt happened to use those words. The ticket-06 introspection
 * surface (tool-gate's __piToolGateStatus seam rendered by inspect_context)
 * makes them MORE valuable, so keeping them dormant was counterproductive.
 *
 * This file is retained as the shared-predicate HISTORY + the auditable record
 * of the former DIAGNOSTIC_GATING / GATE_DEFS["inspect"] family. Nothing here
 * is referenced at runtime anymore (the six tools declare `gating: { core: true
 * }` directly); reverting the decision is a one-file flip — re-register
 * GATE_DEFS["inspect"] with this predicate and set the tools' gating back to
 * `{ gate: "inspect" }`.
 */
