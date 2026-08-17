/**
 * src/handlers/hierarchy-build.ts — fire-and-forget hierarchy build hook
 * (LeanRAG ① / ticket 04b-2).
 *
 * Mirrors walk-and-ingest's fireVectorBackfillBestEffort: a void async IIFE,
 * catch-all console.warn, NEVER blocks ingest. Skips silently when:
 *   - kbDir is unset (no zk seam / no vault → nothing to build on);
 *   - enabled === false (the `hierarchyEnabled` config knob);
 *   - embedFn is absent (embeds unavailable = the same degradation class as
 *     the vector cold path — hierarchy REQUIRES embeddings for clustering).
 *
 * D4 seams: embedFn + summarizeFn are injected callables. When summarizeFn
 * is NOT injected, zk's buildHierarchy uses its OWN internal default
 * summarizer (llm-chat, same package) — hermes never imports zk directly
 * (dep-guard: hermes→zk via seam only).
 */

import { getKnowledgePipeline } from "../knowledge-pipeline-seam.js";

/** Injected deps (D4): hermes supplies the callables; zk never imports a
 *  store or LLM client for the hierarchy build. */
export interface HierarchyDeps {
	/** Texts → vectors. Absent ⇒ skip (embeds unavailable). */
	embedFn?: (texts: string[]) => Promise<number[][]>;
	/** Cluster text → summary. Optional pass-through; undefined ⇒ zk-side
	 *  default. Inject only to override (tests / custom LLM). */
	summarizeFn?: (clusterText: string, budget: number) => Promise<string>;
	/** Master switch (config `hierarchyEnabled`; default true). */
	enabled?: boolean;
	/** Passed through to kp.buildHierarchy (clustering cosine threshold). */
	threshold?: number;
	/** Passed through to kp.buildHierarchy (max recursion depth). */
	maxDepth?: number;
	/** Passed through to kp.buildHierarchy (LLM token budget per summary). */
	tokenBudget?: number;
}

/** Deterministic truncation: collapse whitespace, hard-cap at budget
 *  chars (no LLM involved). Exported for unit tests. */
export function truncateSummary(clusterText: string, budget: number): string {
	const norm = clusterText.replace(/\s+/g, " ").trim();
	return norm.length > budget ? `${norm.slice(0, Math.max(0, budget - 1))}…` : norm;
}

/** Pure builder (exported for unit tests): resolve the kp.buildHierarchy
 *  argument. Returns null when the call must be SKIPPED (no kbDir / disabled /
 *  no embedFn / no seam). */
export function buildHierarchyCall(
	kbDir: string | undefined,
	deps: HierarchyDeps,
): {
	kbDir: string;
	embedFn: (texts: string[]) => Promise<number[][]>;
	summarizeFn?: (clusterText: string, budget: number) => Promise<string>;
	threshold?: number;
	maxDepth?: number;
	tokenBudget?: number;
} | null {
	if (!kbDir) return null;
	if (deps.enabled === false) return null;
	if (!deps.embedFn) return null;
	const kp = getKnowledgePipeline();
	if (!kp) return null;
	void kp; // seam presence check only; the caller re-reads it fire-and-forget
	return {
		kbDir,
		embedFn: deps.embedFn,
		summarizeFn: deps.summarizeFn,
		...(deps.threshold !== undefined ? { threshold: deps.threshold } : {}),
		...(deps.maxDepth !== undefined ? { maxDepth: deps.maxDepth } : {}),
		...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
	};
}

/** Fire-and-forget hierarchy build (mirrors fireVectorBackfillBestEffort):
 *  void async IIFE, catch-all console.warn, never throws to the caller. */
export function fireHierarchyBuildBestEffort(kbDir: string | undefined, deps: HierarchyDeps): void {
	void (async () => {
		try {
			const call = buildHierarchyCall(kbDir, deps);
			if (!call) return;
			const kp = getKnowledgePipeline();
			if (!kp) return;
			await kp.buildHierarchy(call);
		} catch (err) {
			console.warn(
				`[hermes] hierarchy build skipped/failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	})();
}
