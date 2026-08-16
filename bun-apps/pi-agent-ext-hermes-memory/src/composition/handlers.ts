/**
 * composition/handlers.ts — slice 08b3-2 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L506-534 + L625-649:
 * - setupHandlers ← L506-534 (background review §5, session flush §6,
 *   project-memory autocommit §6b) + L625-649 (recall-set singleton + §8
 *   correction / §8b error / §8c worth / §8d used detectors).
 *
 * Mechanical adjustments (closure locals → ctx): `memoryToolDef` becomes a
 * param (slice 08b3-1 returns it) and `activeSessionId` reads via
 * `ctx.activeSession.get()` (the 08b2 holder). Returns the shared RecallSet
 * so the rewire slice can thread the SAME instance into registerTools.
 *
 * index.ts still holds its own copies until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setupBackgroundReview } from "../handlers/background-review.js";
import { setupSessionFlush } from "../handlers/session-flush.js";
import { setupCommitProjectMemory } from "../handlers/commit-project-memory.js";
import { setupCorrectionDetector } from "../handlers/correction-detector.js";
import { setupErrorDetector } from "../handlers/error-detector.js";
import { RecallSet, setupWorthScoring } from "../handlers/worth-scoring.js";
import { setupUsedDetection } from "../handlers/used-detection.js";
import type { HermesCtx } from "./stores.js";

export function setupHandlers(pi: ExtensionAPI, ctx: HermesCtx, memoryToolDef: ToolDefinition): RecallSet {
	const {
		config,
		store,
		projectStore,
		projectName,
		cardStore,
		inRepoProjectFile,
		memoryRepo,
		sessionRepo,
		surfacedSignatures,
		activeSession,
	} = ctx;

	// ── 5. Setup background learning loop (with tool-call-aware nudge) ──
	setupBackgroundReview(pi, store, projectStore, config, {
		cardStore,
		projectName: projectName || null,
		deps: { memoryToolDef },
	});

	// ── 6. Setup session-end flush ──
	setupSessionFlush(pi, store, projectStore, config, memoryToolDef);

	// ── 6b. Project-memory autocommit (opt-in; a complete no-op unless the repo
	//      sets autoCommitProjectMemory in <cwd>/.agents/memory/config.json) ──
	// Commits agent-written .agents/memory/MEMORY.md to the current (non-protected)
	// branch, batched per session via a ~20s trailing debounce on message_end.
	// Only wired when an in-repo project memory file exists (projectMemoryDir !== null
	// + a detected project); the handler self-no-ops when the repo hasn't opted in.
	if (inRepoProjectFile) {
		setupCommitProjectMemory(pi, config, {
			cwd: process.cwd(),
			memoryFilePath: inRepoProjectFile,
			logger: (message, level) => {
				// info = a commit landed; debug = skip/suppress/defer (quiet by default
				// to avoid noise — PI_HERMES_DEBUG surfaces them).
				if (level === "info" || process.env.PI_HERMES_DEBUG) {
					console.info(`[hermes-memory] ${message}`);
				}
			},
		});
	}

	// ── 8. Setup correction detection ──
	// The shared recall-set is instantiated ONCE, before both
	// setupCorrectionDetector and registerSearchTool, so the same instance
	// flows to the producer (the search tool's memory mode records recalled ids) and the consumer
	// (setupWorthScoring drains + bumps mw_success/mw_fail at turn_end).
	const recallSet = new RecallSet();
	setupCorrectionDetector(pi, store, projectStore, config, memoryRepo, projectName, memoryToolDef, undefined, undefined, cardStore);

	// ── 8b. Setup lesson-worthy error capture (auto-trigger on tool failures) ──
	setupErrorDetector(pi, store, projectStore, config, memoryRepo, projectName, cardStore);

	// ── 8c. Setup worth-scoring (drains recall-set at turn_end, bumps mw_success/mw_fail) ──
	setupWorthScoring(pi, memoryRepo, recallSet, config);

	// ── 8d. Setup used-detection (UPSP §9 / ticket #06) ──
	// `surfacedSignatures` is populated at session_start (captureAssembly's
	// onReceipt callback, see the session_start handler) from the SAME
	// prompt-assembly receipt #05 recorded — the §5↔§9 join. This buffers the
	// turn's assistant output and, at turn_end, scans it against the set +
	// markUsed the matched rows. Wired unconditionally (mirrors setupWorthScoring
	// — the populate gate above + the handler's own `enabled` flag together make
	// it a clean no-op when usedDetection===false). DISTINCT from worth-scoring:
	// that tracks *recalled* memory + turn outcome; this tracks *surfaced*
	// (prompt-injected) memory the agent's output actually referenced.
	setupUsedDetection(pi, sessionRepo, surfacedSignatures, config, () => activeSession.get() ?? null);

	return recallSet;
}
