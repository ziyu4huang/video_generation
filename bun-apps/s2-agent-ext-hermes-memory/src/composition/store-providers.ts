import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	produceMergePlan,
	registerConsolidateCommand,
	resolveConsolidatorModelLabel,
} from "../handlers/auto-consolidate.js";
import { makeHeatProvider, shouldWireHeat } from "../handlers/heat-provider.js";
import type { HermesCtx } from "./stores.js";

/**
 * §7/7b/7c/7d store-provider wiring, extracted verbatim from index.ts
 * (closure locals rewritten to HermesCtx fields).
 */
export function injectStoreProviders(
	pi: ExtensionAPI,
	ctx: HermesCtx,
	memoryToolDef: ToolDefinition,
): void {
	// ── 7. Setup auto-consolidation (inject consolidator into stores) ──
	// 2-phase: the injected fn only PLANS (lock-free, no writes). The store's
	// consolidateTwoPhase takes the returned MergePlan and applies it in a brief
	// locked reconcile-write. triggerConsolidation stays wired only for the
	// manual /memory-consolidate command (registerConsolidateCommand below).
	ctx.store.setConsolidator(async (snapshot, signal) =>
		produceMergePlan(snapshot, {
			timeoutMs: ctx.config.consolidationTimeoutMs,
			signal,
			modelOverride: ctx.config.llmModelOverride,
		}), resolveConsolidatorModelLabel(ctx.config));
	if (ctx.projectStore) {
		ctx.projectStore.setConsolidator(async (snapshot, signal) =>
			produceMergePlan(snapshot, {
				timeoutMs: ctx.config.consolidationTimeoutMs,
				signal,
				modelOverride: ctx.config.llmModelOverride,
			}), resolveConsolidatorModelLabel(ctx.config));
	}

	// ── 7b. Inject the superseded-md_id provider (D2 offload-superseded-first) ──
	// Mirrors setConsolidator's injection pattern — keeps MemoryStore free of a
	// direct MemoryRepository reference. On overflow the store purges superseded
	// `.md` entries by MD_ID (frontmatter id match); the caller (review-memory-ops /
	// memory-tool) then syncs the DB rows via removeByMdId (D4 destructive). Ticket
	// 04: full replace — steady-state purge/sync keys on md_id, NOT content.
	// Project scoping matches sqliteProjectFor: global store → project IS NULL,
	// projectStore → project = projectName.
	ctx.store.setSupersededContentProvider(async (target) => {
		const list = await ctx.memoryRepo.getMemories({ target, project: null, status: "superseded" });
		return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
	});
	if (ctx.projectStore) {
		ctx.projectStore.setSupersededContentProvider(async (target) => {
			const list = await ctx.memoryRepo.getMemories({ target, project: ctx.projectName, status: "superseded" });
			return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
		});
	}

	// ── 7c. Inject the stable-id backfill provider (Task 4 5d migration) ──
	// Mirrors setSupersededContentProvider — keeps MemoryStore free of a direct
	// MemoryRepository reference. The provider's `project` arg is always `null`
	// from the store (it doesn't know its own scope), so the real project is
	// BOUND at these closures: global store → project:null, projectStore →
	// projectName. `MemoryRemoveOptions.project` null vs undefined is significant
	// (null → `project IS NULL`; undefined → no filter), so pass it explicitly to
	// match each store's row scope exactly. The backfill itself runs in the
	// `ready` handler AFTER loadFromDisk() (it needs the in-memory entries).
	ctx.store.setStableIdBackfillProvider({
		getMdIdByContent: (target, content) => ctx.memoryRepo.getMdIdByContent(content, { target, project: null }),
		setMdIdByContent: (target, content, mdId) => ctx.memoryRepo.setMdIdByContent(content, mdId, { target, project: null }),
	});
	if (ctx.projectStore) {
		ctx.projectStore.setStableIdBackfillProvider({
			getMdIdByContent: (target, content) => ctx.memoryRepo.getMdIdByContent(content, { target, project: ctx.projectName }),
			setMdIdByContent: (target, content, mdId) => ctx.memoryRepo.setMdIdByContent(content, mdId, { target, project: ctx.projectName }),
		});
	}

	// ── 7d. Inject the heat provider (UPSP §1 decay, ticket #1b) ──
	// Mirrors the providers above — keeps MemoryStore free of a direct
	// MemoryRepository/SessionRepository reference. The provider batches
	// `mw_success`/`mw_fail` (memoryRepo.getMemories, one scoped SELECT for the
	// whole target) + the global `used_at` boolean (sessionRepo.getUsedMdIds),
	// then calls `computeHeat` per entry. Best-effort: it never throws (returns an
	// empty Map on any repo failure → the store's computeHeats normalizes to null
	// → T4/T5 fall back to current FIFO).
	//
	// GATE on `shouldWireHeat(config)` (== `config.decayEnabled !== false`):
	// when disabled the provider is NOT attached → the store sees null → eviction
	// reverts to pre-#1b FIFO (the disable path is a first-class invariant, not
	// an afterthought). Both stores use the SAME global repos; the per-store
	// `project` arg scopes ONLY the mw_* lookup (projectStore → projectName) — the
	// `used_at` signal is global ever-used per D4 (session_assembly is a global,
	// non-project-scoped ledger, so getUsedMdIds ignores project).
	if (shouldWireHeat(ctx.config)) {
		ctx.store.setHeatForEntriesProvider(makeHeatProvider(ctx.config, { memoryRepo: ctx.memoryRepo, sessionRepo: ctx.sessionRepo }, null));
		if (ctx.projectStore) {
			ctx.projectStore.setHeatForEntriesProvider(makeHeatProvider(ctx.config, { memoryRepo: ctx.memoryRepo, sessionRepo: ctx.sessionRepo }, ctx.projectName));
		}
	}
	// Inject the perf recorder into both stores — lock-hold breach timing (T2) +
	// consolidation always-logged event (T3).
	ctx.store.setPerfTimed(ctx.perf.timed);
	ctx.projectStore?.setPerfTimed(ctx.perf.timed);
	ctx.store.setPerfAlways(ctx.perf.timedAlways);
	ctx.projectStore?.setPerfAlways(ctx.perf.timedAlways);
	registerConsolidateCommand(pi, ctx.store, memoryToolDef, ctx.config.consolidationTimeoutMs, ctx.projectStore, ctx.projectName, ctx.config);
}
