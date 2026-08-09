/**
 * Gate-Recall Guard — probe-set collector (Task 2) + `GateProbeSet` type.
 *
 * Each gated extension exports a QA-only `__GATE_PROBES__` PLAIN object from
 * its entry file. This module statically imports every one into `ALL_PROBE_SETS`
 * + a `Map<string, GateProbeSet>` keyed by canonical gate name. tool-gate
 * already statically depends on every gated extension (it builds CORPUS_GATES
 * by driving their registrars), so adding a gate's probes = one import line —
 * no new coupling class.
 *
 * Until Tasks 5–7 author the per-extension `__GATE_PROBES__` exports, the
 * collections stay empty and every gate is reported UNCOVERED by the harness
 * (qa/gate-recall.ts). That is correct, not a failure: there is simply nothing
 * to score yet. The drift-guard test (qa/collect-probes.test.ts) passes
 * trivially on an empty collection and becomes meaningful once probes land.
 *
 * `GateProbeSet` lives HERE (tool-gate), per the spec's lean (Open Question #2:
 * tool-gate, a QA concern, not the shared `pi-tool-gating-contract`). Extensions
 * export their probes as a PLAIN object (no type import) to avoid a circular
 * dependency on tool-gate; shape is enforced by the drift-guard test.
 */
export interface GateProbeSet {
	/** Canonical gate name — must equal names[0] of some CORPUS_GATES member. */
	gate: string;
	/** Min adversarial-recall fraction to PASS. Default 0.9 (see DEFAULT_FLOOR).
	 *  0 = controls-only (deliberate-dispatch gates). */
	recallFloor?: number;
	/** Realistic "I need this tool" phrasings using NO current keyword — should fire. */
	adversarial: string[];
	/** Phrasings carrying a current keyword / satisfying requires — MUST fire (100%). */
	controls: string[];
}

// Populated in Tasks 5–7 once each gated extension exports `__GATE_PROBES__`.
// Until then both collections are empty and the harness reports every gate as
// UNCOVERED (degrade gracefully, never crash).
export const ALL_PROBE_SETS: GateProbeSet[] = [];
export const PROBES_BY_GATE: Map<string, GateProbeSet> = new Map();
