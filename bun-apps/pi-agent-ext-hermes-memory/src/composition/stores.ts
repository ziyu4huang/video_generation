/**
 * composition/stores.ts — slice 08b1 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L172-353:
 * - createBackendRuntime  ← L172-199 (dir resolution, backend label/holder, perf,
 *   extension-root migration flag)
 * - createStores          ← L201-261 + L349-353 (MemoryStore, project detection,
 *   SkillStore, backend bundle + fallback, swappable proxies, session holders,
 *   project-scoped store)
 * - initStores            ← L274-292 (legacy-dir migration + guarded startup
 *   markdown→db sync)
 * - setupBackendSwitching ← L294-347 (persistDbBackend + live switchTo +
 *   /memory-switch-backend registration)
 *
 * index.ts still holds its own copies until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { SkillStore } from "../store/skill-store.js";
import { createBackendBundle, createBackendBundleWithFallback } from "../store/backend-factory.js";
import { asSwappable } from "../store/swappable.js";
import { derivePerUserNamespace, DEFAULT_SURREAL_DATABASE } from "../store/surreal/per-user-db.js";
import type { MemoryRepository, SessionRepository, BackendBundle } from "../store/repository.js";
import type { CardStore } from "../store/card-store.js";
import type { DbBackend, MemoryConfig } from "../types.js";
import { createPerfRecorder, type PerfRecorder } from "../perf.js";
import { SurfacedSignatureSet } from "../handlers/used-detection.js";
import { registerSwitchBackendCommand } from "../handlers/switch-backend.js";
import { syncMarkdownMemories } from "../handlers/sync-markdown-memories.js";
import { SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS } from "../handlers/session-backfill.js";
import { SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS } from "../handlers/session-live-index.js";
import { shouldRunStartupSync } from "../config.js";
import { detectProject, resolveProjectStoreDir } from "../project.js";
import { MEMORY_FILE } from "../constants.js";
import { migrateLegacyProjectMemoryDirs } from "../project-memory-migration.js";
import { AGENT_ROOT } from "../paths.js";

// ── Holder for the live backend bundle (the old `let currentBundle`) ──
export interface BackendBundleHolder {
	get(): BackendBundle;
	set(bundle: BackendBundle): void;
}

// ── Holder for the per-session id (the old `let activeSessionId`) ──
export interface ActiveSessionHolder {
	get(): string | undefined;
	set(id: string | undefined): void;
}

/**
 * Runtime-scoped backend state (the old index.ts function-locals:
 * currentDbBackend / backendLabel / backendFellBack / extensionRootMigrated).
 * `backend.get/set` are the holder for db+label so every closure reads the
 * CURRENT pair by reference; `fellBack` is a plain mutable flag set once by
 * createStores on a startup fallback and read by the session_start handler.
 */
export interface BackendRuntime {
	agentRoot: string;
	globalDir: string;
	legacyGlobalDir: string;
	backend: {
		get(): { db: DbBackend; label: string };
		set(db: DbBackend, label: string): void;
		fellBack: boolean;
	};
	labelFor(target: DbBackend): string;
	perf: PerfRecorder;
	shouldMigrateExtensionRoot: boolean;
	/** True once the extension-root migration has run (session_start guard). */
	migrationDone(): boolean;
	markMigrationDone(): void;
}

/** ← L172-199. Pure setup: no I/O, no await. */
export function createBackendRuntime(config: MemoryConfig): BackendRuntime {
	const agentRoot = AGENT_ROOT;
	const legacyGlobalDir = path.join(agentRoot, "memory");
	const defaultGlobalDir = path.join(agentRoot, "pi-hermes-memory");

	const configuredMemoryDir = config.memoryDir?.trim();
	const pointsToLegacyMemoryDir = configuredMemoryDir
		? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
		: false;

	const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
		? defaultGlobalDir
		: configuredMemoryDir;

	// Human-readable label for the active memory/search backend, surfaced once
	// per session via a session_start TUI notify. dbBackend comes from
	// hermes-memory-config.json. loadConfig resolves the per-user surreal
	// namespace (user_<user>) + database (memory) when unset, so a shared local
	// SurrealDB server isolates each OS-user's data in its own namespace.
	// Switching backends IS runtime-hot since #772: /memory-switch-backend.
	const surrealCfg = config.surreal;
	const labelFor = (db: DbBackend): string =>
		db === "surrealdb"
			? `surrealdb · ns=${surrealCfg?.namespace ?? derivePerUserNamespace()} db=${surrealCfg?.database ?? DEFAULT_SURREAL_DATABASE} @ ${surrealCfg?.endpoint ?? "http://127.0.0.1:8000"}`
			: `sqlite · ${path.join(globalDir, "sessions.db")}`;
	let currentDbBackend: DbBackend = config.dbBackend ?? "sqlite";
	let backendLabel = labelFor(currentDbBackend);
	// Lightweight perf tracker: breach-only (per-op ms / HTTP-round-trip
	// thresholds) → appends to perf.jsonl + fires a UI notify. PI_HERMES_PERF=1
	// traces every op. Handlers receive `perf.timed` so the lifecycle ops are
	// instrumented.
	const perf = createPerfRecorder({ getBackend: () => currentDbBackend });

	const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;
	let extensionRootMigrated = false;

	return {
		agentRoot,
		globalDir,
		legacyGlobalDir,
		backend: {
			get: () => ({ db: currentDbBackend, label: backendLabel }),
			set: (db: DbBackend, label: string) => {
				currentDbBackend = db;
				backendLabel = label;
			},
			fellBack: false,
		},
		labelFor,
		perf,
		shouldMigrateExtensionRoot,
		migrationDone: () => extensionRootMigrated,
		markMigrationDone: () => {
			extensionRootMigrated = true;
		},
	};
}

/** Everything createStores produces (L201-261 + L349-353). */
export interface Stores {
	store: MemoryStore;
	projectStore: MemoryStore | null;
	projectConfig: MemoryConfig;
	projectName: string;
	projectStoreDir: string | null;
	inRepoProjectFile: string | null;
	inRepoProjectName: string | null;
	skillStore: SkillStore;
	memoryRepo: MemoryRepository;
	sessionRepo: SessionRepository;
	cardStore: CardStore;
	sessionsDir: string;
	activeSession: ActiveSessionHolder;
	surfacedSignatures: SurfacedSignatureSet;
	bundle: BackendBundleHolder;
}

/** ← L201-261 + L349-353 (projectConfig/projectStore hoisted in, verbatim). */
export async function createStores(runtime: BackendRuntime, config: MemoryConfig): Promise<Stores> {
	const { agentRoot, globalDir, legacyGlobalDir } = runtime;

	const store = new MemoryStore({ ...config, memoryDir: globalDir });
	const project = detectProject(config.projectsMemoryDir, undefined, config.projectName);
	const projectName = project.name ?? "";
	// Project-scoped store location (ticket 04, decision 01): default in-repo
	// <cwd>/.agents/memory/ (git-trackable); null → opt-out (legacy global);
	// explicit string → that path. resolveProjectStoreDir is the pure resolver.
	const projectStoreDir = resolveProjectStoreDir(config.projectMemoryDir, project, process.cwd());
	// In-repo/explicit project memory file to backfill into the search index
	// (ticket 02 merge). Skipped when projectMemoryDir===null (opt-out): that
	// case resolves to the legacy global location scanProjectDirs already covers.
	const inRepoProjectFile = config.projectMemoryDir !== null && projectStoreDir
		? path.join(projectStoreDir, MEMORY_FILE)
		: null;
	const inRepoProjectName = project.name;
	const skillStore = new SkillStore({
		globalSkillsDir: path.join(globalDir, "skills"),
		projectSkillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
		projectName: project.name,
		legacySkillsDir: path.join(legacyGlobalDir, "skills"),
		legacyPiGlobalSkillsDir: path.join(agentRoot, "skills"),
		migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
	});

	// Resilient startup: if the configured backend (e.g. surrealdb) cannot
	// initialize — the local SurrealDB server is down/unreachable — fall back
	// to sqlite so a missing external service never blocks agent startup.
	// `backend.fellBack` drives the session_start warning.
	const initialBackend = await createBackendBundleWithFallback(config, globalDir);
	let currentBundle: BackendBundle = initialBackend.bundle;
	const bundle: BackendBundleHolder = {
		get: () => currentBundle,
		set: (next: BackendBundle) => {
			currentBundle = next;
		},
	};
	if (initialBackend.fellBackTo) {
		runtime.backend.set(initialBackend.fellBackTo, runtime.labelFor(initialBackend.fellBackTo));
		runtime.backend.fellBack = true;
		console.warn(`[hermes-memory] configured backend "${config.dbBackend}" failed to initialize — fell back to sqlite for this session. Start the server and /memory-switch-backend ${config.dbBackend} to restore.`);
	}

	// Swappable proxies: every tool/handler captured `memoryRepo`/`sessionRepo`
	// at registration time. The proxy always delegates to the CURRENT bundle, so
	// a live /memory-switch-backend swap is transparent downstream (zero
	// signature changes) and in-flight background indexing follows the swap.
	const memoryRepo: MemoryRepository = asSwappable<MemoryRepository>(() => bundle.get().memoryRepo);
	const sessionRepo: SessionRepository = asSwappable<SessionRepository>(() => bundle.get().sessionRepo);
	// kp13 Wave B: the memory-kind mirror target rides the SAME swappable
	// pattern — every writer captured `cardStore` at registration follows a live
	// backend switch transparently (bundle cardStore is backend-matched).
	const cardStore: CardStore = asSwappable<CardStore>(() => bundle.get().cardStore);
	const sessionsDir = path.join(agentRoot, "sessions");

	// UPSP §9 / ticket #06 (Task 6): per-session shared holders consumed across
	// lifecycle boundaries. `activeSessionId` is set by the session_start
	// handler and read by setupUsedDetection's turn_end closure (which is bound
	// at extension setup, before a ctx exists — hence the indirection).
	// `surfacedSignatures` is populated at session_start from the SAME
	// prompt-assembly receipt #05 records (the §5↔§9 join) and scanned at
	// turn_end. Both are instance-scoped: there is exactly one extension
	// instance per process, and the holders keep the binding by reference so the
	// turn_end read sees the value session_start wrote.
	let activeSessionId: string | undefined;
	const activeSession: ActiveSessionHolder = {
		get: () => activeSessionId,
		set: (id: string | undefined) => {
			activeSessionId = id;
		},
	};
	const surfacedSignatures = new SurfacedSignatureSet();

	// Project-scoped store (ticket 04): projectStoreDir resolved above.
	const projectConfig = projectStoreDir
		? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: projectStoreDir }
		: { ...config, memoryDir: undefined };
	const projectStore = projectStoreDir ? new MemoryStore(projectConfig) : null;

	return {
		store,
		projectStore,
		projectConfig,
		projectName,
		projectStoreDir,
		inRepoProjectFile,
		inRepoProjectName,
		skillStore,
		memoryRepo,
		sessionRepo,
		cardStore,
		sessionsDir,
		activeSession,
		surfacedSignatures,
		bundle,
	};
}

/** ← L274-292: legacy-dir migration + guarded startup .md→db re-index. */
export async function initStores(
	runtime: BackendRuntime,
	config: MemoryConfig,
	stores: Stores,
): Promise<void> {
	// Keep project memory available for users upgrading from the old
	// ~/.pi/agent/<project>/ layout. This is non-destructive: legacy folders
	// remain in place while entries are copied/merged into projects-memory/.
	migrateLegacyProjectMemoryDirs(runtime.agentRoot, config.projectsMemoryDir);
	// The startup .md→db re-index is expensive on the surrealdb path (~6.6s of
	// sequential HTTP round-trips per spawn) and the consolidation CHILD does
	// not need it — the child only reads .md + writes the result via saveToDisk,
	// never searching the index. Skipping it in the child is the surrealdb-path
	// freeze fix (wayfinder ticket 07). runConsolidator sets PI_HERMES_CONSOLIDATING=1.
	if (shouldRunStartupSync()) {
		try {
			await runtime.perf.timed("startup.syncMarkdownMemories", () =>
				syncMarkdownMemories(
					stores.memoryRepo,
					runtime.globalDir,
					config.projectsMemoryDir,
					runtime.agentRoot,
					stores.inRepoProjectFile,
					stores.inRepoProjectName,
					stores.cardStore,
				),
			);
		} catch {
			// Best-effort only: failed markdown backfill should not block extension startup.
		}
	}
}

/**
 * ctx for setupBackendSwitching. The quiesce waits are passed in (not
 * imported) so the caller owns the background-indexing lifecycle wiring.
 * Timeout constants stay module-local (pure static values, as in index.ts).
 */
export interface BackendSwitchingCtx {
	config: MemoryConfig;
	agentRoot: string;
	globalDir: string;
	runtime: BackendRuntime;
	stores: Stores;
	waitForSessionBackfill(timeoutMs: number): Promise<unknown>;
	waitForLiveSessionIndex(timeoutMs: number): Promise<unknown>;
}

/** ← L294-347: persistDbBackend + live switchTo + /memory-switch-backend. */
export function setupBackendSwitching(pi: ExtensionAPI, ctx: BackendSwitchingCtx): void {
	const { config, agentRoot, globalDir, runtime, stores } = ctx;

	// ── Live backend switching (sqlite <-> surrealdb) ──
	// /memory-switch-backend swaps the active store in-process. The swappable
	// proxies above make the swap transparent to every captured repo ref.
	// Memory re-syncs from the .md source of truth; session history needs a
	// manual /memory-index-sessions. The choice is persisted so the next session
	// keeps it. Switching is NOT free: the new backend starts with only the
	// re-synced memories (session index is backend-local).
	const configPath = path.join(agentRoot, "hermes-memory-config.json");
	const persistDbBackend = (target: DbBackend): void => {
		try {
			const fs = require("node:fs");
			let existing: Record<string, unknown> = {};
			if (fs.existsSync(configPath)) {
				try {
					existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
				} catch {
					existing = {};
				}
			}
			existing.dbBackend = target;
			fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
		} catch {
			// best effort — the live switch already took effect for this session
		}
	};
	const switchTo = async (target: DbBackend): Promise<{ ok: boolean; message: string }> => {
		if (target === runtime.backend.get().db) return { ok: true, message: `already on ${target}` };
		let nextBundle: BackendBundle;
		try {
			nextBundle = await createBackendBundle({ ...config, dbBackend: target }, globalDir);
		} catch (err) {
			return { ok: false, message: `failed to initialize ${target}: ${err instanceof Error ? err.message : String(err)}` };
		}
		// Quiesce in-flight background indexing (it captured the PROXY, which still
		// points at the old bundle until we swap) so nothing writes to a backend
		// we're about to close.
		try {
			await Promise.all([
				ctx.waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
				ctx.waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
			]);
		} catch {
			// best effort
		}
		const oldBundle = stores.bundle.get();
		stores.bundle.set(nextBundle); // proxies now delegate to the new repos
		runtime.backend.set(target, runtime.labelFor(target));
		try {
			await syncMarkdownMemories(
				stores.bundle.get().memoryRepo,
				globalDir,
				config.projectsMemoryDir,
				agentRoot,
				stores.inRepoProjectFile,
				stores.inRepoProjectName,
				stores.bundle.get().cardStore,
			);
		} catch {
			// best effort; next session_start re-syncs
		}
		try {
			await oldBundle.backend.close();
		} catch {
			/* best effort */
		}
		try {
			persistDbBackend(target);
		} catch {
			/* best effort */
		}
		return { ok: true, message: `switched to ${target}` };
	};
	registerSwitchBackendCommand(pi, {
		getCurrent: () => runtime.backend.get().db,
		switchTo,
		labelFor: runtime.labelFor,
	});
}

/**
 * Pragmatic cross-slice context — the flat surface the other slices of the
 * index.ts decomposition need. Assembled by the rewire slice from
 * createBackendRuntime + createStores outputs (plus per-slice wiring).
 * Index-signature-free on purpose: fields listed explicitly.
 */
export interface HermesCtx {
	config: MemoryConfig;
	agentRoot: string;
	globalDir: string;
	legacyGlobalDir: string;
	shouldMigrateExtensionRoot: boolean;
	/** Holder for the `extensionRootMigrated` de-closured local (08b2-2). */
	migrationDone: () => boolean;
	markMigrationDone: () => void;
	runtime: BackendRuntime;
	perf: PerfRecorder;
	backend: BackendRuntime["backend"];
	labelFor: (target: DbBackend) => string;
	store: MemoryStore;
	projectStore: MemoryStore | null;
	projectName: string;
	inRepoProjectFile: string | null;
	inRepoProjectName: string | null;
	skillStore: SkillStore;
	memoryRepo: MemoryRepository;
	sessionRepo: SessionRepository;
	cardStore: CardStore;
	sessionsDir: string;
	activeSession: ActiveSessionHolder;
	surfacedSignatures: SurfacedSignatureSet;
	bundle: BackendBundleHolder;
}
