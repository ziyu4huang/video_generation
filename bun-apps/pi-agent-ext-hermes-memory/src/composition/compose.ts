/**
 * composition/compose.ts — slice 08b5 of the index.ts decomposition.
 *
 * The composition root: executes the original index.ts default-export body in
 * EXACTLY the original registration order (comments cite original line
 * numbers), delegating to the 08b1-08b4 slices. index.ts is now a thin shim.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../types.js";
import { loadConfig } from "../config.js";
import { waitForSessionBackfill } from "../handlers/session-backfill.js";
import { waitForLiveSessionIndex } from "../handlers/session-live-index.js";
import {
	createBackendRuntime,
	createStores,
	initStores,
	setupBackendSwitching,
	type BackendRuntime,
	type HermesCtx,
	type Stores,
} from "./stores.js";
import { registerSessionStart } from "./events/session-start.js";
import { registerBeforeAgentStart } from "./events/before-agent-start.js";
import { registerMessageEnd } from "./events/message-end.js";
import { registerSessionShutdown } from "./events/session-shutdown.js";
import { registerProjectSkillDiscoveryHandler } from "./project-skills.js";
import { registerTools, registerSearchAndIndexSessions } from "./tools.js";
import { setupHandlers } from "./handlers.js";
import { injectStoreProviders } from "./store-providers.js";
import { registerCommands } from "./commands.js";

/** Assemble the flat cross-slice ctx from the runtime + stores outputs. */
function buildHermesCtx(config: MemoryConfig, runtime: BackendRuntime, stores: Stores): HermesCtx {
	return {
		config,
		agentRoot: runtime.agentRoot,
		globalDir: runtime.globalDir,
		legacyGlobalDir: runtime.legacyGlobalDir,
		shouldMigrateExtensionRoot: runtime.shouldMigrateExtensionRoot,
		migrationDone: runtime.migrationDone,
		markMigrationDone: runtime.markMigrationDone,
		runtime,
		perf: runtime.perf,
		backend: runtime.backend,
		labelFor: runtime.labelFor,
		store: stores.store,
		projectStore: stores.projectStore,
		projectName: stores.projectName,
		inRepoProjectFile: stores.inRepoProjectFile,
		inRepoProjectName: stores.inRepoProjectName,
		skillStore: stores.skillStore,
		memoryRepo: stores.memoryRepo,
		sessionRepo: stores.sessionRepo,
		cardStore: stores.cardStore,
		sessionsDir: stores.sessionsDir,
		activeSession: stores.activeSession,
		surfacedSignatures: stores.surfacedSignatures,
		bundle: stores.bundle,
	};
}

/** The original index.ts default-export body, order-preserving. */
export async function composeHermesMemory(pi: ExtensionAPI): Promise<void> {
	// 1. ← L172-199: config + dir/backend runtime (labels, perf, migration flag).
	const config = loadConfig();
	const runtime = createBackendRuntime(config);

	// 2. ← L201-261 + L349-353: stores (MemoryStore, SkillStore, backend bundle
	//    with sqlite fallback, swappable proxies, session holders, project
	//    store); then ← L274-292: legacy-dir migration + guarded startup
	//    markdown→db sync.
	const stores = await createStores(runtime, config);
	await initStores(runtime, config, stores);
	const ctx = buildHermesCtx(config, runtime, stores);

	// 3. ← L294-347: live backend switching + /memory-switch-backend.
	setupBackendSwitching(pi, {
		config,
		agentRoot: runtime.agentRoot,
		globalDir: runtime.globalDir,
		runtime,
		stores,
		waitForSessionBackfill,
		waitForLiveSessionIndex,
	});

	// 4. ← L355-463: session_start lifecycle (backend notify, migration,
	//    disk loads, backfills, prompt-assembly capture).
	registerSessionStart(pi, ctx);

	// 5. ← L467-469: resources_discover project-skill discovery.
	registerProjectSkillDiscoveryHandler(pi, stores.skillStore, config.projectsMemoryDir);

	// 6. ← L469-476: before_agent_start prompt-context injection.
	registerBeforeAgentStart(pi, ctx);

	// 7. ← L475-515: memory / knowledge / skill tool registrations.
	const { memoryToolDef } = registerTools(pi, ctx);

	// Steps 8-9 swap vs original L536/L625 order — immaterial because all wiring completes synchronously before any event fires.
	// 8. ← L506-552 + L580-623: §5/§6/§6b handlers + §8-§8d detectors; returns
	//    the shared RecallSet (producer for step 12).
	const recallSet = setupHandlers(pi, ctx, memoryToolDef);

	// 9. ← L554-578: §7/§7b/§7c/§7d store providers + /memory-consolidate.
	injectStoreProviders(pi, ctx, memoryToolDef);

	// 10. ← L614-618: §9 commands (/memory-skills, /memory-switch-project,
	//     /memory-learn, /memory-sync, /memory-preview-context).
	registerCommands(pi, ctx);

	// 11. ← L620-626: §10 live session indexing on message_end.
	registerMessageEnd(pi, ctx);

	// 12. ← L667-668: §11 search tool + /memory-index-sessions (consumes the
	//     RecallSet from step 8).
	registerSearchAndIndexSessions(pi, ctx, recallSet);

	// 13. ← L672-732: §12 session_shutdown — ABSOLUTE LAST (WAL contract: the
	//     backend close() here truncates the WAL; any later DB-writing
	//     session_shutdown handler would run after close() and silently no-op).
	registerSessionShutdown(pi, ctx);
}
