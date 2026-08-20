import type { EnrichedNote, ConvergeMetrics, ConvergeResult } from "./types.ts";
import type { KnowledgeRecord, IngestSummary } from "../types.ts";
import { ingestRecords } from "../ingest.ts";
import { markSuperseded } from "../supersede.ts";
import { readState, writeState } from "./state.ts";
import { adjustThreshold } from "./threshold.ts";

/** Map an enriched note to a KnowledgeRecord (filling defaults). */
function toRecord(note: EnrichedNote): KnowledgeRecord {
	return {
		id: note.id,
		type: note.type,
		title: note.title,
		detail: note.detail,
		tags: note.tags,
		dimension: note.dimension ?? null,
		confidence: note.confidence ?? 0.7,
		status: "active",
		superseded_by: null,
	};
}

export async function runConverge(
	notes: EnrichedNote[],
	vaultPath: string,
	metrics: ConvergeMetrics,
	target = "failure",
): Promise<ConvergeResult> {
	const records = notes.map(toRecord);
	const summary: IngestSummary = await ingestRecords(records, {
		vaultPath,
		source: "workflow-jsonl",
		sourceLabel: "distill:pipeline",
	});

	// Supersede the raw cards these notes upgrade (mechanism B): raw ids are
	// `hermes:*` (the live hub auto-converge adapter) or legacy `pi-memory:*`.
	// After writing the curated card, flip the matching raw card to
	// status:superseded so retrieveRecords excludes it — leaving the curated
	// card as the single active card for that knowledge.
	for (const note of notes) {
		if (!note.supersedesCardId) continue;
		markSuperseded(note.supersedesCardId, note.id, vaultPath);
	}

	const converged = summary.created + summary.updated;
	const passRate = metrics.survivors > 0 ? converged / metrics.survivors : 1;

	// Adaptive threshold
	const state = readState(vaultPath);
	const adj = adjustThreshold(metrics, state.threshold, converged);

	// Record history + persist
	state.threshold = adj.newN;
	state.lastRun = new Date().toISOString();
	state.history.push({
		ts: state.lastRun,
		target,
		candidates: metrics.candidates,
		killed: metrics.killed,
		survivors: metrics.survivors,
		converged,
		killRate: metrics.candidates > 0 ? metrics.killed / metrics.candidates : 0,
		passRate,
	});
	writeState(vaultPath, state);

	return {
		created: summary.created,
		updated: summary.updated,
		unchanged: summary.unchanged,
		linked: summary.linked,
		passRate,
		newThreshold: adj.newN,
		thresholdDelta: adj.delta,
		thresholdReason: adj.reason,
	};
}
