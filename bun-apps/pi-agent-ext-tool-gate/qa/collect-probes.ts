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
 * tool-gate, a QA concern, not the shared `@repo/pi-agent-core-interface`).
 * Extensions export their probes as a PLAIN object (no type import) to avoid a
 * circular dependency on tool-gate; shape is enforced by the drift-guard test.
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

// ── Per-extension probe sets ─────────────────────────────────────────────
// Import path mirrors qa/evaluate.ts exactly (@repo/<pkg>/extensions/<x>.ts)
// so module resolution matches the very path that builds CORPUS_GATES. Each
// gated extension exports a PLAIN `__GATE_PROBES__` (or named consts for
// multi-gate packages); re-typing them as GateProbeSet here is safe because
// they are plain objects with the same structural shape.
import { __GATE_PROBES__ as flux2Probes } from "@repo/pi-agent-ext-flux2/extensions/flux2.ts";
import { __GATE_PROBES__ as ltxProbes } from "@repo/pi-agent-ext-ltx/extensions/ltx.ts";
import { __GATE_PROBES__ as movieProbes } from "@repo/pi-agent-ext-movie-director/extensions/movie-director.ts";
import { __GATE_PROBES__ as krea2Probes } from "@repo/pi-agent-ext-krea2/extensions/krea2.ts";
import { __GATE_PROBES__ as file2mdProbes } from "@repo/pi-agent-ext-file2md/extensions/file2md.ts";
import { COLLECT_VIDEOS_PROBES, ARXIV_SEARCH_PROBES } from "@repo/pi-agent-ext-research-tool/extensions/research-tool.ts";
import { __GATE_PROBES__ as zaiProbes } from "@repo/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts";
import { __GATE_PROBES__ as workflowProbes } from "@repo/pi-agent-ext-workflow/extensions/workflow.ts";
import { __GATE_PROBES__ as inspectProbes } from "@repo/pi-agent-ext-power-tool/extensions/power-tool.ts";
import {
	PI_DEPLOY_PROBES,
	AWAIT_PR_MERGE_PROBES,
	SWEEP_BRANCHES_PROBES,
	LOCAL_CI_PROBES,
	SYNC_REPO_PROBES,
	DEVOPS_RETROSPECT_PROBES,
	PREPARE_BRANCH_PROBES,
	VERIFY_MERGE_PROBES,
	MAIN_HEALTH_PROBES,
} from "@repo/pi-agent-ext-devops/extensions/devops.ts";
import { __GATE_PROBES__ as memorySupersedeProbes } from "@repo/pi-agent-ext-hermes-memory/src/tools/memory-supersede-tool.ts";

/** Every authored probe set (drift-guard iterates this). */
export const ALL_PROBE_SETS: GateProbeSet[] = [
	flux2Probes,
	ltxProbes,
	movieProbes,
	krea2Probes,
	file2mdProbes,
	COLLECT_VIDEOS_PROBES,
	ARXIV_SEARCH_PROBES,
	zaiProbes,
	// Dispatch / utility gates — controls-only (recallFloor 0, adversarial []):
	workflowProbes,
	inspectProbes,
	memorySupersedeProbes,
	PI_DEPLOY_PROBES,
	AWAIT_PR_MERGE_PROBES,
	SWEEP_BRANCHES_PROBES,
	LOCAL_CI_PROBES,
	SYNC_REPO_PROBES,
	DEVOPS_RETROSPECT_PROBES,
	PREPARE_BRANCH_PROBES,
	VERIFY_MERGE_PROBES,
	MAIN_HEALTH_PROBES,
];

/** Probe set per canonical gate name (harness looks up by group-member name). */
export const PROBES_BY_GATE: Map<string, GateProbeSet> = new Map(ALL_PROBE_SETS.map((p) => [p.gate, p]));
