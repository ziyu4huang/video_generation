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
