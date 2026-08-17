/**
 * composition/tools.ts — slice 08b3-1 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L475-515 + L667-668:
 * - registerTools ← L475-515 (memory tool §3, knowledge tools §3b +
 *   publishStaleCheck, skill tool §4).
 * - registerSearchAndIndexSessions ← the tail L667-668 (search tool +
 *   /memory-index-sessions command), split out of registerTools because the
 *   recallSet is created later (setupHandlers) in the original wiring order;
 *   compose.ts threads the SAME instance here as producer.
 *
 * index.ts no longer holds copies — compose.ts drives both functions.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerMemoryTool } from "../tools/memory-tool.js";
import { registerSkillTool } from "../tools/skill-tool.js";
import { registerSearchTool } from "../tools/search-tool.js";
import { registerKnowledgeSearchTool } from "../tools/knowledge-search-tool.js";
import { registerKnowledgeIngestTool } from "../tools/knowledge-ingest-tool.js";
import { publishStaleCheck } from "../stale-seam.js";
import { resolveKnowledgeVaultPath } from "../knowledge-vault-path.js";
import { registerIndexSessionsCommand } from "../handlers/index-sessions.js";
import { buildKnowledgeSemanticOpts } from "./knowledge-semantic.js";
import type { HermesCtx } from "./stores.js";
import type { RecallSet } from "../handlers/worth-scoring.js";
import { defaultEmbedder } from "../store/surreal/embedder.js";

export function registerTools(
	pi: ExtensionAPI,
	ctx: HermesCtx,
): { memoryToolDef: ToolDefinition } {
	const { config, globalDir, store, projectStore, projectName, cardStore, skillStore, memoryRepo } = ctx;

	// ── 3. Register the memory tool (with project store + SQLite sync) ──
	// Capture the returned ToolDefinition so consolidation can bridge it into
	// the in-process child subagent via spawnSubagent's `extensionTools`: the
	// def's execute closure already binds this parent `store`, so the child's
	// memory writes land in the parent store (same effect as the old -e subprocess).
	const memoryToolDef = registerMemoryTool(pi, store, projectStore, projectName, cardStore, memoryRepo);

	// ── 3b. Register the knowledge tools (06b). knowledge_search wraps zk's
	// retrieveRecords (vault-md graph); knowledge_ingest wraps walkAndIngest
	// (walk → zk ingest → heal → DB-mirror). Both degrade gracefully when the zk
	// seam is absent or the vault env is unset — registration never calls the
	// resolver, so a missing vault env does NOT crash session init (the resolver
	// throws at call time and the tool surfaces a clear message). The mirror
	// reuses the SAME SQLite DB the memory-cards use (the global memory dir). ──
	registerKnowledgeSearchTool(
		pi,
		resolveKnowledgeVaultPath,
		buildKnowledgeSemanticOpts(config, globalDir),
	);
	registerKnowledgeIngestTool(pi, {
		memoryDir: globalDir,
		// LeanRAG ① (ticket 04b-2): fire-and-forget hierarchy build post-ingest.
		// embedFn fails fast when LM Studio is down — the handler's catch-all
		// warns and skips (same degradation class as the vector cold path).
		hierarchy: {
			enabled: process.env.PI_HIERARCHY_DISABLED !== "1" && config.hierarchyEnabled !== false,
			embedFn: async (texts: string[]) =>
				defaultEmbedder({ baseUrl: config.lmStudioBaseUrl ?? "http://127.0.0.1:1234" })(
					texts,
					"text-embedding-nomic-embed-text-v1.5",
				),
		},
	});
	// Phase-2 (knowledge-pipeline / 10-impl T6): the stale: query + revalidate
	// Phase-2 (knowledge-pipeline / 10-impl T7): publish the staleness reverse
	// seam for wayfind's graduation gate (T8) + read-side surfacing (T9). The
	// closure lazily opens an ephemeral CardStore per call; null-safe (degrades
	// to {stale:[]} on any failure so a wayfind graduation never false-blocks).
	// Mirrors the grill seam, reversed (hermes publishes, wayfind reads).
	publishStaleCheck(globalDir);

	// ── 4. Register the skill tool ──
	registerSkillTool(pi, skillStore);

	return { memoryToolDef };
}

/** ← L667-668: search tool + /memory-index-sessions (§11 tail). Consumes the
 *  shared RecallSet created by setupHandlers so the producer (the search
 *  tool's memory mode records recalled ids) and the consumer (setupWorthScoring
 *  drains + bumps mw_success/mw_fail at turn_end) stay paired. */
export function registerSearchAndIndexSessions(
	pi: ExtensionAPI,
	ctx: HermesCtx,
	recallSet: RecallSet,
): void {
	const { config, globalDir, memoryRepo, sessionRepo } = ctx;
	registerSearchTool(pi, memoryRepo, sessionRepo, config.sessionSearch ?? { variant: "legacy" }, recallSet);
	registerIndexSessionsCommand(pi, globalDir, config);
}
