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
 * 8. /memory-insights — shows what's stored
 * 9. /memory-skills — lists procedural skills
 * 10. /memory-consolidate — manual consolidation trigger
 * 11. /memory-interview — onboarding interview to pre-fill user profile
 * 12. /memory-switch-project — list project memories
 * 13. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 14. Memory Aging — entry timestamps guide consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

// Cross-extension seam: re-export zk's KnowledgePipeline defensive reader
// so ticket 06's spine orchestration can consume it (graceful undefined when
// zk is absent).
export { getKnowledgePipeline } from "./knowledge-pipeline-seam.js";

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "./store/memory-store.js";
import { SkillStore } from "./store/skill-store.js";
import { createBackendBundle, createBackendBundleWithFallback } from "./store/backend-factory.js";
import { asSwappable } from "./store/swappable.js";
import { derivePerUserNamespace, DEFAULT_SURREAL_DATABASE } from "./store/surreal/per-user-db.js";
import type { MemoryRepository, SessionRepository, BackendBundle } from "./store/repository.js";
import type { DbBackend } from "./types.js";
import { scheduleSessionBackfill, waitForSessionBackfill, SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-backfill.js";
import { schedulePlanningBackfill, waitForPlanningBackfill } from "./handlers/planning-backfill.js";
import { scheduleLiveSessionIndex, waitForLiveSessionIndex, SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-live-index.js";
import { parseSessionFile } from "./store/session-parser.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerGrillDecisionTool } from "./tools/grill-decision-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { registerSessionSearchTool } from "./tools/session-search-tool.js";
import { createPerfRecorder } from "./perf.js";
import { registerMemorySearchTool } from "./tools/memory-search-tool.js";
import { registerMemorySupersedeTool } from "./tools/memory-supersede-tool.js";
import { registerKnowledgeSearchTool, buildGraphRelationsFetcher } from "./tools/knowledge-search-tool.js";
import { registerKnowledgeIngestTool } from "./tools/knowledge-ingest-tool.js";
import { registerPlanningStaleTool } from "./tools/planning-stale-tool.js";
import { publishStaleCheck, unpublishStaleCheck } from "./stale-seam.js";
import { resolveKnowledgeVaultPath } from "./knowledge-vault-path.js";
// Ticket 14 phase A — HNSW vector side-table + lazy semantic query.
import { SurrealClient } from "./store/surreal/surreal-client.js";
import { createVectorStore } from "./store/surreal/vector-store.js";
import { defaultEmbedder, SEMANTIC_MODEL_DEFAULT } from "./store/surreal/embedder.js";
import { captureAssembly } from "./handlers/session-assembly.js";
import { setupBackgroundReview } from "./handlers/background-review.js";
import { setupSessionFlush } from "./handlers/session-flush.js";
import { setupCommitProjectMemory } from "./handlers/commit-project-memory.js";
import { registerInsightsCommand } from "./handlers/insights.js";
import { triggerConsolidation, registerConsolidateCommand, resolveConsolidatorModelLabel, produceMergePlan } from "./handlers/auto-consolidate.js";
import { setupCorrectionDetector } from "./handlers/correction-detector.js";
import { setupErrorDetector } from "./handlers/error-detector.js";
import { RecallSet, setupWorthScoring } from "./handlers/worth-scoring.js";
import { SurfacedSignatureSet, setupUsedDetection } from "./handlers/used-detection.js";
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { registerInterviewCommand } from "./handlers/interview.js";
import { registerSwitchProjectCommand } from "./handlers/switch-project.js";
import { registerIndexSessionsCommand } from "./handlers/index-sessions.js";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.js";
import { registerSyncMarkdownMemoriesCommand, syncMarkdownMemories } from "./handlers/sync-markdown-memories.js";
import { registerSwitchBackendCommand } from "./handlers/switch-backend.js";
import { registerPreviewContextCommand } from "./handlers/preview-context.js";
import { makeHeatProvider, shouldWireHeat } from "./handlers/heat-provider.js";
import { loadConfig, shouldRunStartupSync } from "./config.js";
import { detectProject, detectProjectSkills, resolveProjectStoreDir } from "./project.js";
import { MEMORY_FILE } from "./constants.js";
import { buildPromptContext, buildPromptAssembly } from "./prompt-context.js";
import { migrateLegacyProjectMemoryDirs } from "./project-memory-migration.js";
import { migrateExtensionRoot } from "./extension-root-migration.js";
import { AGENT_ROOT } from "./paths.js";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);

  return { skillPaths };
}

/** Dedicated database for the card_vectors HNSW side-table. Lives in the
 *  per-user namespace (same as the CRUD store when dbBackend=surrealdb) but in
 *  its OWN database so the vector index is independent of the CRUD backend
 *  (sqlite-vec is not loadable under Bun — Decision 04 Fork C). */
const DEFAULT_VECTOR_DATABASE = "vectors";

/** Build the (optional) semantic-search wiring for knowledge_search (ticket 14
 *  phase A). Conservative: returns undefined providers unless `surreal.endpoint`
 *  is explicitly configured, so the DEFAULT (sqlite, no endpoint) path is
 *  byte-identical to the pre-semantic baseline (#default-behavior-unchanged).
 *  The providers are LAZY — they only construct a client/embedder when
 *  knowledge_search is called with `semantic:true`, so session init never
 *  touches SurrealDB / LM Studio. */
function buildKnowledgeSemanticOpts(
  config: import("./types.js").MemoryConfig,
  memoryDir: string,
): import("./tools/knowledge-search-tool.js").KnowledgeSemanticOpts | undefined {
  const endpoint = config.surreal?.endpoint;
  if (!endpoint) return undefined; // default config has no endpoint → unchanged behavior
  const ns = config.surreal?.namespace ?? derivePerUserNamespace();
  const db = DEFAULT_VECTOR_DATABASE;
  const username = config.surreal?.username ?? "root";
  const password = config.surreal?.password ?? "root";
  const model = config.embedModel ?? SEMANTIC_MODEL_DEFAULT;
  const ef = config.vectorEf ?? 100;
  // One client per wiring (cheap — HTTP/stateless). Constructed lazily on first
  // provider call, reused across calls via the closure-cached singleton.
  let client: SurrealClient | undefined;
  let store: import("./store/surreal/vector-store.js").VectorStore | undefined;
  return {
    model,
    ef,
    // ③ (fix-wave 2): wire the production batched graph-relations lookup so
    // dedupByRelation is live on the warm path. Rides the same gating as the
    // vector store above — the default (no surreal endpoint) path stays
    // byte-identical with the seam unwired.
    fetchRelations: buildGraphRelationsFetcher(memoryDir),
    vectorStore: () => {
      if (!client) client = new SurrealClient({ endpoint, namespace: ns, database: db, username, password });
      if (!store) store = createVectorStore(client, ns, db);
      return store;
    },
    embedder: () => {
      const base = config.lmStudioBaseUrl ?? "http://127.0.0.1:1234";
      // The embedder is constructed unconditionally (cheap); if LM Studio is
      // down, embedQuery swallows the error and searchSemantic falls through to
      // the T5(a) lexical fallback — so we don't gate on lmStudioAvailable here
      // (avoids a probe round-trip on every call; the embed call itself fails
      // fast). Tests inject their own embedder.
      return defaultEmbedder({ baseUrl: base });
    },
  };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", async (event, _ctx) => {
    return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
  });
}

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();

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
  // per session via a session_start TUI notify (see the handler below).
  // dbBackend comes from hermes-memory-config.json. loadConfig resolves the
  // per-user surreal namespace (user_<user>) + database (memory) when unset,
  // so a shared local SurrealDB server isolates each OS-user's data in its own
  // namespace. Switching backends IS runtime-hot since #772:
  // /memory-switch-backend.
  const surrealCfg = config.surreal;
  const labelFor = (db: DbBackend): string =>
    db === "surrealdb"
      ? `surrealdb · ns=${surrealCfg?.namespace ?? derivePerUserNamespace()} db=${surrealCfg?.database ?? DEFAULT_SURREAL_DATABASE} @ ${surrealCfg?.endpoint ?? "http://127.0.0.1:8000"}`
      : `sqlite · ${path.join(globalDir, "sessions.db")}`;
  let currentDbBackend: DbBackend = config.dbBackend ?? "sqlite";
  let backendLabel = labelFor(currentDbBackend);
  // Lightweight perf tracker: breach-only (per-op ms / HTTP-round-trip thresholds)
  // → appends to perf.jsonl + fires a UI notify. PI_HERMES_PERF=1 traces every
  // op. Handlers receive `perf.timed` so the lifecycle ops below are instrumented.
  const perf = createPerfRecorder({ getBackend: () => currentDbBackend });

  const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;
  let extensionRootMigrated = false;

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
  // `backendFellBack` drives the session_start warning below.
  let backendFellBack = false;
  const initialBackend = await createBackendBundleWithFallback(config, globalDir);
  let currentBundle: BackendBundle = initialBackend.bundle;
  if (initialBackend.fellBackTo) {
    currentDbBackend = initialBackend.fellBackTo;
    backendLabel = labelFor(initialBackend.fellBackTo);
    backendFellBack = true;
    console.warn(`[hermes-memory] configured backend "${config.dbBackend}" failed to initialize — fell back to sqlite for this session. Start the server and /memory-switch-backend ${config.dbBackend} to restore.`);
  }
  // Swappable proxies: every tool/handler captured `memoryRepo`/`sessionRepo`
  // at registration time. The proxy always delegates to the CURRENT bundle, so
  // a live /memory-switch-backend swap is transparent downstream (zero
  // signature changes) and in-flight background indexing follows the swap.
  const memoryRepo: MemoryRepository = asSwappable<MemoryRepository>(() => currentBundle.memoryRepo);
  const sessionRepo: SessionRepository = asSwappable<SessionRepository>(() => currentBundle.sessionRepo);
  const sessionsDir = path.join(agentRoot, "sessions");

  // UPSP §9 / ticket #06 (Task 6): per-session shared holders consumed across
  // lifecycle boundaries. `activeSessionId` is set by the session_start handler
  // below and read by setupUsedDetection's turn_end closure (which is bound at
  // extension setup, before a ctx exists — hence the indirection).
  // `surfacedSignatures` is populated at session_start from the SAME
  // prompt-assembly receipt #05 records (the §5↔§9 join) and scanned at
  // turn_end. Both are function-scoped: there is exactly one extension instance
  // per process, and closures capture the binding by reference so the turn_end
  // read sees the value session_start wrote.
  let activeSessionId: string | undefined;
  const surfacedSignatures = new SurfacedSignatureSet();

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Keep project memory available for users upgrading from the old
  // ~/.pi/agent/<project>/ layout. This is non-destructive: legacy folders
  // remain in place while entries are copied/merged into projects-memory/.
  migrateLegacyProjectMemoryDirs(agentRoot, config.projectsMemoryDir);
  // The startup .md→db re-index is expensive on the surrealdb path (~6.6s of
  // sequential HTTP round-trips per spawn) and the consolidation CHILD does
  // not need it — the child only reads .md + writes the result via saveToDisk,
  // never searching the index. Skipping it in the child is the surrealdb-path
  // freeze fix (wayfinder ticket 07). runConsolidator sets PI_HERMES_CONSOLIDATING=1.
  if (shouldRunStartupSync()) {
    try {
      await perf.timed("startup.syncMarkdownMemories", () => syncMarkdownMemories(memoryRepo, globalDir, config.projectsMemoryDir, agentRoot, inRepoProjectFile, inRepoProjectName));
    } catch {
      // Best-effort only: failed markdown backfill should not block extension startup.
    }
  }

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
        try { existing = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { existing = {}; }
      }
      existing.dbBackend = target;
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
    } catch {
      // best effort — the live switch already took effect for this session
    }
  };
  const switchTo = async (target: DbBackend): Promise<{ ok: boolean; message: string }> => {
    if (target === currentDbBackend) return { ok: true, message: `already on ${target}` };
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
        waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
        waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
      ]);
    } catch {
      // best effort
    }
    const oldBundle = currentBundle;
    currentBundle = nextBundle; // proxies now delegate to the new repos
    currentDbBackend = target;
    backendLabel = labelFor(target);
    try {
      await syncMarkdownMemories(currentBundle.memoryRepo, globalDir, config.projectsMemoryDir, agentRoot, inRepoProjectFile, inRepoProjectName);
    } catch {
      // best effort; next session_start re-syncs
    }
    try { await oldBundle.backend.close(); } catch { /* best effort */ }
    try { persistDbBackend(target); } catch { /* best effort */ }
    return { ok: true, message: `switched to ${target}` };
  };
  registerSwitchBackendCommand(pi, { getCurrent: () => currentDbBackend, switchTo, labelFor });

  // Project-scoped store (ticket 04): projectStoreDir resolved above (~line 130).
  const projectConfig = projectStoreDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: projectStoreDir }
    : { ...config, memoryDir: undefined };
  const projectStore = projectStoreDir ? new MemoryStore(projectConfig) : null;

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, ctx) => {
    // Surface the active memory/search backend once per session start so the
    // user can see at a glance whether hermes-memory is on sqlite or surrealdb
    // (and where). Transient info notify; no-op if the host provides no ui.
    {
      const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
      ui?.notify?.(`🧠 hermes-memory backend: ${backendLabel}`, "info");
      if (backendFellBack) {
        ui?.notify?.(`⚠️ SurrealDB was unreachable — hermes-memory fell back to sqlite for this session. Start SurrealDB then /memory-switch-backend surrealdb to restore.`, "warn");
      }
    }
    if (shouldMigrateExtensionRoot && !extensionRootMigrated) {
      try {
        await migrateExtensionRoot(legacyGlobalDir, globalDir);
      } catch {
        // best effort migration only
      }
      extensionRootMigrated = true;
    }

    // Wire perf breach alerts to the TUI for this session.
    perf.setNotifier((r) => {
      const why = r.reason === "roundTrips" ? `${r.roundTrips} HTTP round-trips` : `${r.ms}ms`;
      const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
      // Consolidation is an expected, always-logged event — surface at info, not
      // an alarming ⚠️ breach warn.
      if (r.kind === "consolidation") {
        ui?.notify?.(`hermes perf: ${r.op} ran ${why} (backend=${r.backend})`, "info");
      } else {
        ui?.notify?.(`⚠️ hermes perf: ${r.op} took ${why} (backend=${r.backend})`, "warn");
      }
    });

    refreshSkillProjectContext(ctx.cwd);
    await skillStore.migrateLegacySkills();
    await skillStore.ensureDiscoveredRoots();
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();

    // Task 4: one-shot idempotent backfill of the 5d stable-id migration. Runs
    // AFTER loadFromDisk() so the in-memory `.md` entries are populated. Wrapped
    // in try/catch so a backfill failure NEVER aborts agent startup or trips the
    // sqlite fallback — the per-entry DB mirror is already best-effort inside
    // backfillStableIds(); this outer guard covers load/parse/disk-write faults.
    try {
      await store.backfillStableIds();
      await projectStore?.backfillStableIds();
    } catch {
      /* never block startup */
    }

    scheduleSessionBackfill(sessionRepo, sessionsDir, {
      timed: perf.timed,
      notify: (message, level) => {
        const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
        if (ui?.notify) {
          ui.notify(message, level);
        } else if (level === "error" || level === "warning") {
          console.warn(message);
        } else {
          console.info(message);
        }
      },
    });

    // Phase-2 (knowledge-pipeline / ticket 09 T6): background re-mirror of
    // .planning/. Best-effort, bounded, run-state-guarded — mirrors
    // scheduleSessionBackfill. Deferred via setTimeout(0) so session_start
    // resolves first; heals .planning drift without blocking startup. A failure
    // must NEVER abort agent startup.
    try {
      schedulePlanningBackfill(ctx.cwd, globalDir, {
        notify: (message, level) => {
          const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
          if (ui?.notify) ui.notify(message, level);
          else if (level === "error" || level === "warning") console.warn(message);
          else console.info(message);
        },
      });
    } catch {
      /* never block startup */
    }

    // Per-session prompt-provenance (UPSP §5): capture the assembled md_id set
    // + block hash ONCE per session. Best-effort — never abort startup. Mirrors
    // the backfillStableIds guard: a missing sid / null assembly (policy-only or
    // empty store) skips the record; a throwing recordAssembly is swallowed.
    //
    // UPSP §9 / Task 6: bind the active session id (read by setupUsedDetection's
    // turn_end closure) and hand captureAssembly an `onReceipt` callback that
    // populates `surfacedSignatures` from the SAME receipt #05 just recorded —
    // the §5↔§9 join invariant (one build feeds both record + the matcher). The
    // populate is gated on `usedDetection !== false` (default on, INDEPENDENT of
    // worthScoring): disabled ⇒ onReceipt is undefined ⇒ the set stays empty ⇒
    // matchAndForget always returns [] ⇒ markUsed never fires.
    activeSessionId = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
    await captureAssembly({
      getSessionId: () => activeSessionId,
      build: () => buildPromptAssembly(config, store, projectStore, projectName),
      record: (sid, mdIds, hash) => sessionRepo.recordAssembly(sid, mdIds, hash),
      onReceipt: config.usedDetection !== false
        ? (r) => surfacedSignatures.populate(r.signatures)
        : undefined,
    });
  });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject memory policy by default; legacy mode keeps full frozen memory blocks ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptContext = await buildPromptContext(config, store, projectStore, projectName);

    if (promptContext) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + promptContext,
      };
    }
  });

  // ── 3. Register the memory tool (with project store + SQLite sync) ──
  // Capture the returned ToolDefinition so consolidation can bridge it into
  // the in-process child subagent via spawnSubagent's `extensionTools`: the
  // def's execute closure already binds this parent `store`, so the child's
  // memory writes land in the parent store (same effect as the old -e subprocess).
  const memoryToolDef = registerMemoryTool(pi, store, projectStore, memoryRepo, projectName);
  registerGrillDecisionTool(pi, store, memoryRepo);

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
  // kgLlm (FIX 1): thread MemoryConfig.kgLlm into the ingest tool's options so
  // the config-file flag reaches zk's ingest gate (env fallback PI_KG_LLM=1
  // stays available when the flag is unset/default).
  registerKnowledgeIngestTool(pi, { memoryDir: globalDir, kgLlm: config.kgLlm });
  // Phase-2 (knowledge-pipeline / 10-impl T6): the stale: query + revalidate
  // tool. Uses the SAME globalDir memory DB the planning mirror + knowledge
  // ingest use; fsRoot comes from ctx.cwd at call time. Additive — mirrors the
  // knowledge_* registration pattern.
  registerPlanningStaleTool(pi, { memoryDir: globalDir });
  // Phase-2 (knowledge-pipeline / 10-impl T7): publish the staleness reverse
  // seam for wayfind's graduation gate (T8) + read-side surfacing (T9). The
  // closure lazily opens an ephemeral CardStore per call; null-safe (degrades
  // to {stale:[]} on any failure so a wayfind graduation never false-blocks).
  // Mirrors the grill seam, reversed (hermes publishes, wayfind reads).
  publishStaleCheck(globalDir);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStore, config, {
    memoryRepo,
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

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  // 2-phase: the injected fn only PLANS (lock-free, no writes). The store's
  // consolidateTwoPhase takes the returned MergePlan and applies it in a brief
  // locked reconcile-write. triggerConsolidation stays wired only for the
  // manual /memory-consolidate command (registerConsolidateCommand below).
  store.setConsolidator(async (snapshot, signal) =>
    produceMergePlan(snapshot, {
      timeoutMs: config.consolidationTimeoutMs,
      signal,
      modelOverride: config.llmModelOverride,
    }), resolveConsolidatorModelLabel(config));
  if (projectStore) {
    projectStore.setConsolidator(async (snapshot, signal) =>
      produceMergePlan(snapshot, {
        timeoutMs: config.consolidationTimeoutMs,
        signal,
        modelOverride: config.llmModelOverride,
      }), resolveConsolidatorModelLabel(config));
  }

  // ── 7b. Inject the superseded-md_id provider (D2 offload-superseded-first) ──
  // Mirrors setConsolidator's injection pattern — keeps MemoryStore free of a
  // direct MemoryRepository reference. On overflow the store purges superseded
  // `.md` entries by MD_ID (frontmatter id match); the caller (review-memory-ops /
  // memory-tool) then syncs the DB rows via removeByMdId (D4 destructive). Ticket
  // 04: full replace — steady-state purge/sync keys on md_id, NOT content.
  // Project scoping matches sqliteProjectFor: global store → project IS NULL,
  // projectStore → project = projectName.
  store.setSupersededContentProvider(async (target) => {
    const list = await memoryRepo.getMemories({ target, project: null, status: "superseded" });
    return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
  });
  if (projectStore) {
    projectStore.setSupersededContentProvider(async (target) => {
      const list = await memoryRepo.getMemories({ target, project: projectName, status: "superseded" });
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
  store.setStableIdBackfillProvider({
    getMdIdByContent: (target, content) => memoryRepo.getMdIdByContent(content, { target, project: null }),
    setMdIdByContent: (target, content, mdId) => memoryRepo.setMdIdByContent(content, mdId, { target, project: null }),
  });
  if (projectStore) {
    projectStore.setStableIdBackfillProvider({
      getMdIdByContent: (target, content) => memoryRepo.getMdIdByContent(content, { target, project: projectName }),
      setMdIdByContent: (target, content, mdId) => memoryRepo.setMdIdByContent(content, mdId, { target, project: projectName }),
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
  if (shouldWireHeat(config)) {
    store.setHeatForEntriesProvider(makeHeatProvider(config, { memoryRepo, sessionRepo }, null));
    if (projectStore) {
      projectStore.setHeatForEntriesProvider(makeHeatProvider(config, { memoryRepo, sessionRepo }, projectName));
    }
  }
  // Inject the perf recorder into both stores — lock-hold breach timing (T2) +
  // consolidation always-logged event (T3).
  store.setPerfTimed(perf.timed);
  projectStore?.setPerfTimed(perf.timed);
  store.setPerfAlways(perf.timedAlways);
  projectStore?.setPerfAlways(perf.timedAlways);
  registerConsolidateCommand(pi, store, memoryToolDef, config.consolidationTimeoutMs, projectStore, projectName, config);

  // ── 8. Setup correction detection ──
  // The shared recall-set is instantiated ONCE, before both
  // setupCorrectionDetector and registerMemorySearchTool, so the same instance
  // flows to the producer (memory_search records recalled ids) and the consumer
  // (setupWorthScoring drains + bumps mw_success/mw_fail at turn_end).
  const recallSet = new RecallSet();
  setupCorrectionDetector(pi, store, projectStore, config, memoryRepo, projectName, memoryToolDef);

  // ── 8b. Setup lesson-worthy error capture (auto-trigger on tool failures) ──
  setupErrorDetector(pi, store, projectStore, config, memoryRepo, projectName);

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
  setupUsedDetection(pi, sessionRepo, surfacedSignatures, config, () => activeSessionId ?? null);

  // ── 9. Register commands ──
  registerInsightsCommand(pi, store, projectStore, projectName);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(pi, store);
  registerSwitchProjectCommand(pi, config);
  registerLearnMemoryCommand(pi);
  registerSyncMarkdownMemoriesCommand(pi, memoryRepo, globalDir, config.projectsMemoryDir, agentRoot, () => backendLabel, inRepoProjectFile, inRepoProjectName);
  registerPreviewContextCommand(pi, store, projectStore, projectName, config);

  // ── 10. Live session indexing ──
  pi.on("message_end", async (_event, ctx) => {
    scheduleLiveSessionIndex(sessionRepo, ctx.sessionManager, {
      timed: perf.timed,
      onError: (err) => console.warn(`⚠️ Live session indexing failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  });

  // ── 11. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, sessionRepo, config.sessionSearch ?? { variant: "legacy" });
  registerMemorySearchTool(pi, memoryRepo, recallSet);
  registerMemorySupersedeTool(pi, memoryRepo, store, projectName);
  registerIndexSessionsCommand(pi, globalDir, config);

  // (11b removed — convergence moved to the knowledge-card hub; ADR-0001.
  //  Hermes is now a pure TIER-0 foundation: store / search / flush only.)

  // ── 12. Auto-index session on shutdown ──
  // Registered last, so this runs after the session-flush shutdown handler and
  // is the final DB activity. Closing here truncates the WAL via
  // PRAGMA wal_checkpoint(TRUNCATE); without it the WAL only grows to its
  // high-water mark and is never reclaimed across sessions.
  //
  // Ordering is safe: Pi's ExtensionRunner.emit() runs same-extension handlers
  // sequentially in registration order and awaits each one, so the flush above
  // fully completes before close() runs. WARNING: do not register another
  // DB-writing session_shutdown handler after this block — it would run after
  // close() and silently no-op.
  pi.on("session_shutdown", async (_event, ctx) => {
    // 10-impl T7: clear the staleness reverse seam first (best-effort) so the
    // globalThis reader is gone even if the DB drain below throws. Mirrors
    // unpublishWayfindGrill's lifecycle.
    try {
      unpublishStaleCheck();
    } catch {
      /* best effort */
    }
    // DRAIN in-flight background writers (live-index + backfill) BEFORE
    // indexSession. These background tasks share the DB's write lock with
    // indexSession; running them concurrently made indexSession block under
    // transient retry and its contended commit failed to persist. Draining
    // first lets indexSession run uncontended and commit cleanly. Applies to
    // the SQLite fallback path (single write lock) and is a harmless ordering
    // guarantee on the active Surreal backend.
    try {
      await Promise.all([
        waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
        waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
        // T6(a): drain in-flight planning backfill too (graceful shutdown,
        //  consistency with session backfill, prevents orphaned timers).
        waitForPlanningBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
      ]);
    } catch { /* best-effort drain — never block shutdown */ }

    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile && require("node:fs").existsSync(sessionFile)) {
        const sessionData = parseSessionFile(sessionFile);
        if (sessionData) {
          // The repository methods already wrap recovery + transient retry, so
          // there is no need to wrap them in backend.withCorruptionRecovery here.
          await perf.timed("shutdown.indexSession", () => sessionRepo.indexSession(sessionData));
          // Keep session_files metadata in sync with the final on-disk state.
          // Pi appends the closing session entry on shutdown after the last
          // message_end, so without this upsert the stored size/mtime would be
          // stale and the next startup would re-parse this file unnecessarily.
          await sessionRepo.upsertSessionFileMeta(sessionFile, sessionData.id);
        }
      }
    } catch { /* Silent fail — don't block shutdown */ }
    finally {
      try {
        await currentBundle.backend.close();
      } catch { /* best effort — never block shutdown */ }
    }
  });
}
