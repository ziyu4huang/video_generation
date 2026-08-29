/** A raw memory entry from hermes-memory (the agent gathers these via memory list/search). */
export interface MemoryEntry {
	id: string;
	target: "memory" | "user" | "failure" | "project";
	category?: string;
	content: string;
	created: string;
	last?: string;
	project?: string;
}

/** An entry that survived the gate, ready for agent enrichment. */
export interface Survivor {
	entry: MemoryEntry;
	reason: string;
	/** Raw pi-memory card this survivor supersedes (set when upgrading a raw
	 *  card via the converge pipeline). Optional — absent for unique survivors. */
	supersedesCardId?: string;
}

export interface KilledEntry {
	entry: MemoryEntry;
	reason: "duplicate" | "stale" | "malformed";
	detail: string;
}

export interface GateResult {
	candidates: number;
	survivors: Survivor[];
	killed: KilledEntry[];
}

/** An agent-enriched note, ready for convergence into the knowledge graph. */
export interface EnrichedNote {
	id: string;
	type: string;
	title: string;
	detail: string;
	tags: string[];
	dimension?: string;
	confidence?: number;
	/** Carried from the gate's Survivor.supersedesCardId; converge uses it to
	 *  supersede the matching raw pi-memory card (mechanism B). */
	supersedesCardId?: string;
}

export interface ConvergeMetrics {
	candidates: number;
	killed: number;
	survivors: number;
}

export interface ConvergeResult {
	created: number;
	updated: number;
	unchanged: number;
	linked: number;
	passRate: number;
	newThreshold: number;
	thresholdDelta: number;
	thresholdReason: string;
	/** Ticket 14: the per-run audit diff (also persisted to
	 *  `.distill-diff.json`). Tool surfaces count it, not inline it. */
	diff?: DistillDiff;
}

export interface DistillState {
	threshold: number;
	history: Array<{
		ts: string;
		target: string;
		candidates: number;
		killed: number;
		survivors: number;
		converged: number;
		killRate: number;
		passRate: number;
	}>;
	lastRun: string | null;
}

// ---------------------------------------------------------------------------
// Per-run memory diff (ticket 14 — OpenViking memory_diff.json analog)
// ---------------------------------------------------------------------------

/** One field-level effect on a merged card, derived from the pre/post
 *  frontmatter (+body) diff — the applied view of the D4 merge-op table. */
export interface DistillDiffFieldOp {
	/** Frontmatter key, or "body" for the rendered card body. */
	field: string;
	op: "replace" | "union" | "add";
	/** Post-run value (for "union": the items the run ADDED). */
	value?: unknown;
}

/** A card the run merged into (status "updated"). */
export interface DistillDiffEntry {
	id: string;
	/** Vault-relative card path. */
	path: string;
	ops: DistillDiffFieldOp[];
}

/** A raw card the run superseded (mechanism B frontmatter flip). */
export interface DistillDiffSuperseded {
	from: string;
	to: string;
	found: boolean;
}

/** A gate-killed entry the run rejected (reason: duplicate|stale|malformed). */
export interface DistillDiffSkipped {
	id: string;
	reason: string;
	detail?: string;
}

/** The per-run audit trail written atomically to `.distill-diff.json` beside
 *  `.distill-state.json`. One file, overwritten per run — the LATEST run's
 *  diff (history lives in DistillState.history). */
export interface DistillDiff {
	runId: string;
	at: string;
	target: string;
	created: { id: string; path: string }[];
	merged: DistillDiffEntry[];
	superseded: DistillDiffSuperseded[];
	skipped: DistillDiffSkipped[];
}
