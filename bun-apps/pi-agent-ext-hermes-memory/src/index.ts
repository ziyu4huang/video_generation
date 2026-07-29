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
import { scheduleLiveSessionIndex, waitForLiveSessionIndex, SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-live-index.js";
import { parseSessionFile } from "./store/session-parser.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerGrillDecisionTool } from "./tools/grill-decision-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { registerSessionSearchTool } from "./tools/session-search-tool.js";
import { createPerfRecorder } from "./perf.js";
import { registerMemorySearchTool } from "./tools/memory-search-tool.js";
import { registerMemorySupersedeTool } from "./tools/memory-supersede-tool.js";
import { setupBackgroundReview } from "./handlers/background-review.js";
import { setupSessionFlush } from "./handlers/session-flush.js";
import { registerInsightsCommand } from "./handlers/insights.js";
import { triggerConsolidation, registerConsolidateCommand, resolveConsolidatorModelLabel } from "./handlers/auto-consolidate.js";
import { setupCorrectionDetector } from "./handlers/correction-detector.js";
import { setupErrorDetector } from "./handlers/error-detector.js";
import { RecallSet, setupWorthScoring } from "./handlers/worth-scoring.js";
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { registerInterviewCommand } from "./handlers/interview.js";
import { registerSwitchProjectCommand } from "./handlers/switch-project.js";
import { registerIndexSessionsCommand } from "./handlers/index-sessions.js";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.js";
import { registerSyncMarkdownMemoriesCommand, syncMarkdownMemories } from "./handlers/sync-markdown-memories.js";
import { registerSwitchBackendCommand } from "./handlers/switch-backend.js";
import { registerPreviewContextCommand } from "./handlers/preview-context.js";
import { loadConfig, shouldRunStartupSync } from "./config.js";
import { detectProject, detectProjectSkills } from "./project.js";
import { buildPromptContext } from "./prompt-context.js";
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
  const project = detectProject(config.projectsMemoryDir);
  const projectName = project.name ?? "";
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
      await perf.timed("startup.syncMarkdownMemories", () => syncMarkdownMemories(memoryRepo, globalDir, config.projectsMemoryDir, agentRoot));
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
      await syncMarkdownMemories(currentBundle.memoryRepo, globalDir, config.projectsMemoryDir, agentRoot);
    } catch {
      // best effort; next session_start re-syncs
    }
    try { await oldBundle.backend.close(); } catch { /* best effort */ }
    try { persistDbBackend(target); } catch { /* best effort */ }
    return { ok: true, message: `switched to ${target}` };
  };
  registerSwitchBackendCommand(pi, { getCurrent: () => currentDbBackend, switchTo, labelFor });

  // Detect project from cwd using shared helper
  // Project-scoped store: ~/.pi/agent/<projectsMemoryDir>/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;

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

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  store.setConsolidator(async (target, signal) => {
    return triggerConsolidation(store, target, memoryToolDef, signal, config.consolidationTimeoutMs, target, config);
  }, resolveConsolidatorModelLabel(config));
  if (projectStore) {
    projectStore.setConsolidator(async (target, signal) => {
      const toolTarget = target === "memory" ? "project" : target;
      return triggerConsolidation(projectStore, target, memoryToolDef, signal, config.consolidationTimeoutMs, toolTarget, config);
    }, resolveConsolidatorModelLabel(config));
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

  // ── 9. Register commands ──
  registerInsightsCommand(pi, store, projectStore, projectName);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(pi, store);
  registerSwitchProjectCommand(pi, config);
  registerLearnMemoryCommand(pi);
  registerSyncMarkdownMemoriesCommand(pi, memoryRepo, globalDir, config.projectsMemoryDir, agentRoot, () => backendLabel);
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
