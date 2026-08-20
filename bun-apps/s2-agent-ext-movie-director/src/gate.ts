/**
 * gate.ts — shared shape for movie-director's gate-enforced checks.
 *
 * Two conventions coexist by design, not oversight:
 *
 *   - Deep-write-path gates (checkpoint.ts's human-approval, required_artifacts_in,
 *     and artifact-schema checks) THROW `GateViolationError`. `writeCheckpoint`
 *     has many callers beyond `extensions/movie-director.ts`'s `dispatch()`
 *     (tests, future non-tool callers), so the gate must be impossible to
 *     silently ignore — a thrown error forces every caller to handle it.
 *   - Tool-dispatch-boundary gates (this file's `GateResult` — used by
 *     `enforcePreCompose` in precompose-gate.ts and `enforceStageCheckpointGate`
 *     in checkpoint.ts) return `GateResult` instead: `dispatch()`'s single
 *     top-level try/catch already normalizes both a thrown error and a
 *     returned `{ok:false}` into the same `{ok:false,error}` tool result, so
 *     these gates read more naturally as "did this check block? return the
 *     blocking response or null to proceed" inline in a switch-case body.
 *
 * Both conventions produce the same "GATE VIOLATION: ..." — prefixed message
 * shape and the same `overrideX:true` escape-hatch pattern; only the
 * propagation mechanism differs, matched to how many callers each gate has.
 */

/** `null` means the gate passed (proceed); otherwise the tool result to return directly. */
export type GateResult = { ok: false; error: string } | null;
