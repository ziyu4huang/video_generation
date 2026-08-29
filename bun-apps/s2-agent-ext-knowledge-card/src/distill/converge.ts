import type { EnrichedNote, ConvergeMetrics, ConvergeResult, DistillDiff, DistillDiffEntry, DistillDiffFieldOp, DistillDiffSkipped, DistillDiffSuperseded } from "./types.ts";
import type { KnowledgeRecord, IngestSummary } from "../types.ts";
import { ingestRecords } from "../ingest.ts";
import { markSuperseded } from "../supersede.ts";
import { readState, writeState, writeDiff } from "./state.ts";
import { adjustThreshold } from "./threshold.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../card-format.ts";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";

const GRAPH_FOLDER = "Zettelkasten/knowledge-graph";

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

/** Diff one merged card's post-run frontmatter (+body) against its pre-run
 *  raw content, emitting field ops — the applied view of the D4 merge-op
 *  table. Array-vs-array changes become "union" with the ADDED items when the
 *  post array grows append-only (the table's only array semantics: sources/
 *  tags are unions); reorder/removal/disjoint is "replace"; a key the pre-run
 *  card lacked is "add". Exported for unit tests (pure). */
export function diffCardOps(preRaw: string | null, postRaw: string): DistillDiffFieldOp[] {
	const ops: DistillDiffFieldOp[] = [];
	if (preRaw === null) return ops; // caller handles the not-comparable case
	const pre = parseFrontmatter(preRaw).data ?? {};
	const post = parseFrontmatter(postRaw).data ?? {};
	const keys = new Set([...Object.keys(pre), ...Object.keys(post)]);
	for (const k of keys) {
		const a = pre[k];
		const b = post[k];
		if (JSON.stringify(a) === JSON.stringify(b)) continue;
		if (Array.isArray(a) && Array.isArray(b)) {
			const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
			const added = b.filter((x) => !a.some((y) => eq(y, x)));
			// Union only when the post array GROWS append-only over the pre
			// array (superset + |added| == growth, the merge-op table's array
			// semantics); a removal, swap, reorder (growth 0, added 0, but
			// differing — reviewer #2163 finding 2), or disjoint change is a
			// plain replace of the whole array.
			const superset = a.every((y) => b.some((x) => eq(x, y)));
			const growth = b.length - a.length;
			if (superset && added.length === growth && growth > 0) ops.push({ field: k, op: "union", value: added });
			else ops.push({ field: k, op: "replace", value: b });
		} else if (a === undefined) {
			ops.push({ field: k, op: "add", value: b });
		} else {
			ops.push({ field: k, op: "replace", value: b });
		}
	}
	if (stripFrontmatter(preRaw) !== stripFrontmatter(postRaw)) {
		ops.push({ field: "body", op: "replace" });
	}
	return ops;
}

function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

export async function runConverge(
	notes: EnrichedNote[],
	vaultPath: string,
	metrics: ConvergeMetrics,
	target = "failure",
	/** Gate-killed entries (id + reason) — the diff's skipped[]. The driving
	 *  agent passes what the gate action reported; default [] when the run
	 *  has no gate context (ticket 14). */
	killed: DistillDiffSkipped[] = [],
): Promise<ConvergeResult> {
	const records = notes.map(toRecord);

	// Pre-run snapshot of the cards this batch is expected to touch (the
	// canonical path of each note's id) — the "before" side of the diff.
	const folderAbs = join(vaultPath, GRAPH_FOLDER);
	const preRaws = new Map<string, string | null>();
	for (const note of notes) {
		const p = join(folderAbs, `${slugify(note.id)}.md`);
		preRaws.set(note.id, existsSync(p) ? readFileSync(p, "utf8") : null);
	}

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
	const superseded: DistillDiffSuperseded[] = [];
	for (const note of notes) {
		if (!note.supersedesCardId) continue;
		const res = markSuperseded(note.supersedesCardId, note.id, vaultPath);
		superseded.push({ from: note.supersedesCardId, to: note.id, found: res.found });
	}

	// Memory diff (ticket 14): created/merged from the ingest summary,
	// merged ops from the pre/post card diff. Cards whose actual write path
	// differs from the canonical pre-snapshot guess (slug collision) carry a
	// coarse whole-card replace op — never a fabricated field list.
	const created: DistillDiff["created"] = [];
	const merged: DistillDiffEntry[] = [];
	for (const c of summary.cards) {
		if (c.status === "created") {
			created.push({ id: c.id, path: c.path });
		} else if (c.status === "updated") {
			const abs = join(vaultPath, c.path);
			let ops: DistillDiffFieldOp[] = [{ field: "*", op: "replace" }];
			const preGuess = join(folderAbs, `${slugify(c.id)}.md`);
			if (abs === preGuess) {
				let postRaw: string | null = null;
				try {
					postRaw = readFileSync(abs, "utf8");
				} catch { /* keep the coarse op */ }
				if (postRaw !== null) ops = diffCardOps(preRaws.get(c.id) ?? null, postRaw);
			}
			merged.push({ id: c.id, path: c.path, ops });
		}
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

	// Persist the memory diff AFTER the state write (atomic tmp+rename): the
	// diff names the run by state.lastRun, so a crash between the two writes
	// leaves a state entry without a diff — auditable, never torn.
	const diff: DistillDiff = {
		runId: state.lastRun,
		at: state.lastRun,
		target,
		created,
		merged,
		superseded,
		skipped: killed,
	};
	writeDiff(vaultPath, diff);

	return {
		created: summary.created,
		updated: summary.updated,
		unchanged: summary.unchanged,
		linked: summary.linked,
		passRate,
		newThreshold: adj.newN,
		thresholdDelta: adj.delta,
		thresholdReason: adj.reason,
		diff,
	};
}
