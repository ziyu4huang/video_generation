/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. Auto-Consolidation — merges memory when full instead of erroring
 * 5. Correction Detection — immediate save on user corrections
 * 6. Procedural Skills — SKILL.md files for reusable procedures
 * 7. Tool-Call-Aware Nudge — review triggers on tool call count too
 * 8. /memory-skills — lists procedural skills
 * 9. /memory-consolidate — manual consolidation trigger
 * 10. /memory-switch-project — list project memories
 * 11. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 12. Memory Aging — entry timestamps guide consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

// Cross-extension seam: re-export zk's KnowledgePipeline defensive reader
// so ticket 06's spine orchestration can consume it (graceful undefined when
// zk is absent).
export { getKnowledgePipeline } from "./knowledge-pipeline-seam.js";

// Back-compat re-exports: tests + downstream importers reach these via the
// package root (the implementations live in the composition slices).
export { resolveProjectSkillDiscovery, registerProjectSkillDiscoveryHandler } from "./composition/project-skills.js";

// The extension body itself now lives in composition/compose.ts (slice 08b5);
// this file is the thin registration shim Pi loads.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { composeHermesMemory } from "./composition/compose.js";

export default async function hermesMemoryExtension(pi: ExtensionAPI): Promise<void> {
	// Self-gate: BUN_PI_HERMES_MEMORY=0 disables the entire extension — it registers
	// nothing and publishes no seam. Mirrors prompt-history's
	// BUN_PI_PROMPT_HISTORY=0 so every extension in the portable base set
	// (s2-agent.registry.yaml) shares one symmetric full-disable knob; enforced by
	// tests/extension-isolation-contract.test.ts. Safe: every cross-extension
	// consumer reads its seam defensively, so disabling degrades features,
	// never crashes.
	if (process.env.BUN_PI_HERMES_MEMORY === "0") return;
	await composeHermesMemory(pi);
}
