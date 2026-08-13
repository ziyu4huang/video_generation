import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryConfig, MemoryOverflowStrategy, ReviewTransport, SessionSearchVariant, ThinkingLevel, DbBackend } from "./types.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_PROJECT_CHAR_LIMIT,
  DEFAULT_PROJECTS_MEMORY_DIR,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_FLUSH_MIN_TURNS,
  DEFAULT_NUDGE_TOOL_CALLS,
  DEFAULT_REVIEW_RECENT_MESSAGES,
  DEFAULT_FLUSH_RECENT_MESSAGES,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  DEFAULT_USED_SIGNATURE_MIN_CHARS,
  DEFAULT_DECAY_HALFLIFE_DAYS,
  DEFAULT_DECAY_WORTH_WEIGHT,
  DEFAULT_DECAY_USED_BONUS,
  DEFAULT_PROACTIVE_ENABLED,
  DEFAULT_PROACTIVE_HEAT_FLOOR,
  DEFAULT_PROACTIVE_MAX_CANDIDATES,
  DEFAULT_PROACTIVE_PRESSURE_THRESHOLD,
  DEFAULT_PROACTIVE_COOLDOWN_MINUTES,
  DEFAULT_FAILURE_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_MODEL_VERSION,
  DEFAULT_LMSTUDIO_BASE_URL,
  DEFAULT_VECTOR_TOP_K,
  DEFAULT_VECTOR_EF,
  DEFAULT_SURVIVING_K,
  DEFAULT_KG_LLM,
} from "./constants.js";
import { AGENT_ROOT, normalizeConfiguredMemoryDir, normalizeProjectsMemoryDir } from "./paths.js";
import { derivePerUserNamespace, DEFAULT_SURREAL_DATABASE } from "./store/surreal/per-user-db.js";
import { detectProject, resolveProjectStoreDir } from "./project.js";

const MEMORY_OVERFLOW_STRATEGIES: readonly MemoryOverflowStrategy[] = ["auto-consolidate", "reject", "fifo-evict", "vault-offload"];
const SESSION_SEARCH_VARIANTS: readonly SessionSearchVariant[] = ["legacy", "anchors"];
// "subprocess" removed in the spawnSubagent migration — the fallback is now spawnSubagent, not a pi -p subprocess.
const REVIEW_TRANSPORTS: readonly ReviewTransport[] = ["direct"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isReviewTransport(value: unknown): value is ReviewTransport {
  return typeof value === "string" && REVIEW_TRANSPORTS.includes(value as ReviewTransport);
}

function isMemoryOverflowStrategy(value: unknown): value is MemoryOverflowStrategy {
  return typeof value === "string" && MEMORY_OVERFLOW_STRATEGIES.includes(value as MemoryOverflowStrategy);
}

function isSessionSearchVariant(value: unknown): value is SessionSearchVariant {
  return typeof value === "string" && SESSION_SEARCH_VARIANTS.includes(value as SessionSearchVariant);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

const DB_BACKENDS: readonly DbBackend[] = ["sqlite", "surrealdb"];

function isDbBackend(value: unknown): value is DbBackend {
  return typeof value === "string" && DB_BACKENDS.includes(value as DbBackend);
}

const DEFAULT_CONFIG: MemoryConfig = {
  memoryMode: "policy-only",
  memoryPolicyStyle: "full",
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  userCharLimit: DEFAULT_USER_CHAR_LIMIT,
  projectCharLimit: DEFAULT_PROJECT_CHAR_LIMIT,
  nudgeInterval: DEFAULT_NUDGE_INTERVAL,
  reviewRecentMessages: DEFAULT_REVIEW_RECENT_MESSAGES,
  reviewEnabled: true,
  reviewTransport: "direct",
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
  flushRecentMessages: DEFAULT_FLUSH_RECENT_MESSAGES,
  memoryOverflowStrategy: "auto-consolidate",
  autoConsolidate: true,
  correctionDetection: true,
  errorCapture: true,
  worthScoring: true,
  usedDetection: true,
  usedSignatureMinChars: DEFAULT_USED_SIGNATURE_MIN_CHARS,
  decayEnabled: true,
  decayHalflifeDays: DEFAULT_DECAY_HALFLIFE_DAYS,
  decayWorthWeight: DEFAULT_DECAY_WORTH_WEIGHT,
  decayUsedBonus: DEFAULT_DECAY_USED_BONUS,
  // Proactive consolidation (UPSP §1 / Task 1) — all five knobs registered in
  // DEFAULT_CONFIG AND the parse allowlist below (#06 config-gap lesson).
  proactiveConsolidateEnabled: DEFAULT_PROACTIVE_ENABLED,
  proactiveHeatFloor: DEFAULT_PROACTIVE_HEAT_FLOOR,
  proactiveMaxCandidates: DEFAULT_PROACTIVE_MAX_CANDIDATES,
  proactivePressureThreshold: DEFAULT_PROACTIVE_PRESSURE_THRESHOLD,
  proactiveCooldownMinutes: DEFAULT_PROACTIVE_COOLDOWN_MINUTES,
  autoSupersede: false,
  autoCommitProjectMemory: false,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  failureInjectionMaxEntries: DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  consolidationTimeoutMs: DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  nudgeToolCalls: DEFAULT_NUDGE_TOOL_CALLS,
  projectsMemoryDir: DEFAULT_PROJECTS_MEMORY_DIR,
  sessionSearch: { variant: "legacy" },
  dbBackend: "sqlite",
  failureModel: DEFAULT_FAILURE_MODEL,
  // Vector / semantic search (ticket 14 phase A). The card_vectors HNSW side-
  // table is independent of the CRUD backend (#06 lesson: registered here AND
  // in the parse allowlist below from day one).
  embedModel: DEFAULT_EMBED_MODEL,
  embedModelVersion: DEFAULT_EMBED_MODEL_VERSION,
  lmStudioBaseUrl: DEFAULT_LMSTUDIO_BASE_URL,
  vectorTopK: DEFAULT_VECTOR_TOP_K,
  vectorEf: DEFAULT_VECTOR_EF,
  // survivingK (ticket 19 T3): caps the post-dedup returned list. Registered
  // in DEFAULT_CONFIG AND the parse allowlist below (#06 config-gap lesson).
  survivingK: DEFAULT_SURVIVING_K,
  // kgLlm (ticket 03 T3 / D4): opt-in LLM typed-relation extraction. Default
  // OFF (deterministic-by-design, ADR-0001). Registered in DEFAULT_CONFIG AND
  // the parse allowlist below (#06 config-gap lesson).
  kgLlm: DEFAULT_KG_LLM,
};

export const DEFAULT_CONFIG_PATH = path.join(
  AGENT_ROOT,
  "hermes-memory-config.json",
);

/**
 * Populate the per-user default SurrealDB `namespace` and `database` when the
 * config file didn't set them, so the resolved config carries both for the
 * backend, the TUI label, and #772's live backend switching alike (single
 * source of truth). The per-user discriminator lives at the NAMESPACE level
 * (`user_<user>`); the database name is the clean constant `memory`. An
 * explicit `surreal.namespace` / `surreal.database` always wins. Deriving
 * here (not in the backend) means even a sqlite→surrealdb live switch
 * inherits the per-user namespace without re-deriving at bundle-build time.
 */
function resolveSurrealDbDefault(config: MemoryConfig): MemoryConfig {
  if (!config.surreal) config.surreal = {};
  if (!config.surreal.namespace) config.surreal.namespace = derivePerUserNamespace();
  if (!config.surreal.database) config.surreal.database = DEFAULT_SURREAL_DATABASE;
  return config;
}

/** True when this process is a consolidation CHILD — i.e. runConsolidator set
 *  PI_HERMES_CONSOLIDATING=1 before spawning it. Such a child:
 *   - must not spawn its OWN consolidator (nested-loop freeze — ticket 05), and
 *   - must not run the startup .md→db re-index (surrealdb-path freeze — ticket 07):
 *     it only reads the .md + writes the consolidated result via saveToDisk, so the
 *     ~540-round-trip re-index is pure waste. See shouldRunStartupSync(). */
export function isConsolidatingChild(): boolean {
  return process.env.PI_HERMES_CONSOLIDATING === "1";
}

/** Whether the extension should run the startup markdown→db re-index
 *  (syncMarkdownMemories). Skipped in the consolidation child, which
 *  never searches the index and would otherwise pay ~6.6s of surrealdb HTTP
 *  overhead per spawn (×4 targets on /memory-consolidate). */
export function shouldRunStartupSync(): boolean {
  return !isConsolidatingChild();
}

/**
 * A consolidation CHILD process inherits `PI_HERMES_CONSOLIDATING=1` (set by
 * `MemoryStore.runConsolidator`). Such a child must NEVER spawn its own
 * consolidator — that recursion is the consolidation freeze: nested children
 * chain/overlap/race on the `.md` (wayfinder ticket 05, diagnosed in 01). Force
 * the vault-offload floor so the child still WRITES (never hard-rejects on
 * overflow) but does not recurse into another consolidation. (The 2-phase
 * refactor dropped the old `PI_MEMORY_FILE_LOCK=bypass`: the plan-only child
 * has `tools: []` and never writes, so there is no held lock to bypass and no
 * `.md` to race on.)
 */
function applyConsolidatingChildGuard(config: MemoryConfig): MemoryConfig {
  if (isConsolidatingChild()) {
    config.autoConsolidate = false;
    config.memoryOverflowStrategy = "vault-offload";
  }
  return config;
}

/** Filename of the repo-local project-memory overlay, co-located with the
 *  MEMORY.md source-of-truth it governs (ticket 01). */
const PROJECT_MEMORY_CONFIG_FILENAME = "config.json";

/**
 * Apply the repo-local project-memory overlay ON TOP of the (already global-
 * loaded) config (autocommit-hook effort, ticket 01).
 *
 * The overlay lives at `<cwd>/.agents/memory/config.json` — discovered by the
 * SAME cwd-relative resolver as the MEMORY.md SoT (`resolveProjectStoreDir`),
 * so each worktree's checkout sees its own opt-in. It is NARROW: only
 * `autoCommitProjectMemory`, `projectMemoryDir`, and `projectName` may ride it. dbBackend /
 * surreal.* / llm* are IGNORED — a repo must never silently repoint its DB or
 * backend. When the global config opts out of in-repo project memory
 * (`projectMemoryDir === null`), there is no in-repo config.json to consult,
 * so the overlay is skipped entirely.
 *
 * Mutates and returns `config`. Best-effort: a missing or malformed overlay is
 * a silent no-op (never throws).
 */
function applyRepoLocalProjectMemoryOverlay(config: MemoryConfig, cwd: string): MemoryConfig {
  // Global opt-out → memory lives in the global store; nothing in-repo to read.
  if (config.projectMemoryDir === null) return config;
  const detected = detectProject(config.projectsMemoryDir, cwd);
  const storeDir = resolveProjectStoreDir(config.projectMemoryDir, detected, cwd);
  if (!storeDir) return config;
  const overlayPath = path.join(storeDir, PROJECT_MEMORY_CONFIG_FILENAME);
  let parsed: unknown;
  try {
    if (!fs.existsSync(overlayPath)) return config;
    parsed = JSON.parse(fs.readFileSync(overlayPath, "utf-8"));
  } catch {
    return config; // missing/unreadable/malformed overlay → silent no-op
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return config;
  const overlay = parsed as Record<string, unknown>;
  // Allowlisted project-memory keys ONLY.
  if (typeof overlay.autoCommitProjectMemory === "boolean") {
    config.autoCommitProjectMemory = overlay.autoCommitProjectMemory;
  }
  if (typeof overlay.projectName === "string") {
    const trimmed = overlay.projectName.trim();
    if (trimmed) config.projectName = trimmed;
  }
  if (overlay.projectMemoryDir === null) config.projectMemoryDir = null;
  else if (typeof overlay.projectMemoryDir === "string") {
    const trimmed = overlay.projectMemoryDir.trim();
    if (trimmed) config.projectMemoryDir = trimmed;
  }
  return config;
}

export function loadConfig(configPath?: string, cwd: string = process.cwd()): MemoryConfig {
  // Resolve the default path LAZILY from the live AGENT_ROOT binding so the
  // test seam __setAgentRootForTest (paths.ts) is honored. A module-load-time
  // default param would freeze the real root and silently read the production
  // config under tests — the regression this fixes (extension-contract
  // connected to the live SurrealDB namespace instead of an isolated tmpdir).
  // NOTE: DEFAULT_CONFIG_PATH (above) is frozen at load and kept only as the
  // production reference path; loadConfig must not depend on it for the default.
  const resolvedPath = configPath ?? path.join(AGENT_ROOT, "hermes-memory-config.json");
  // Declared outside the try so the repo-local overlay (below) can read it on
  // every path — file-missing / parse-error leaves it as DEFAULT_CONFIG.
  let config: MemoryConfig = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(resolvedPath)) {
      const raw = fs.readFileSync(resolvedPath, "utf-8");
      const parsed = JSON.parse(raw);
      // Merge: override defaults with user config
      config = { ...DEFAULT_CONFIG };
      const isNonNegativeNumber = (value: unknown): value is number => (
        typeof value === "number" && Number.isFinite(value) && value >= 0
      );
      const isStringArray = (value: unknown): value is string[] => (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
      let hasLegacyAutoConsolidate = false;
      let hasMemoryOverflowStrategy = false;
      if (parsed.memoryMode === "policy-only" || parsed.memoryMode === "legacy-inject") config.memoryMode = parsed.memoryMode;
      if (parsed.failureModel === "legacy" || parsed.failureModel === "v1") config.failureModel = parsed.failureModel;
      if (
        parsed.memoryPolicyStyle === "full" ||
        parsed.memoryPolicyStyle === "compact" ||
        parsed.memoryPolicyStyle === "custom" ||
        parsed.memoryPolicyStyle === "none"
      ) config.memoryPolicyStyle = parsed.memoryPolicyStyle;
      if (typeof parsed.memoryPolicyCustomText === "string") config.memoryPolicyCustomText = parsed.memoryPolicyCustomText;
      if (typeof parsed.memoryCharLimit === "number") config.memoryCharLimit = parsed.memoryCharLimit;
      if (typeof parsed.userCharLimit === "number") config.userCharLimit = parsed.userCharLimit;
      if (typeof parsed.nudgeInterval === "number") config.nudgeInterval = parsed.nudgeInterval;
      if (isNonNegativeNumber(parsed.reviewRecentMessages)) config.reviewRecentMessages = parsed.reviewRecentMessages;
      if (typeof parsed.reviewEnabled === "boolean") config.reviewEnabled = parsed.reviewEnabled;
      if (isReviewTransport(parsed.reviewTransport)) config.reviewTransport = parsed.reviewTransport;
      if (typeof parsed.flushOnCompact === "boolean") config.flushOnCompact = parsed.flushOnCompact;
      if (typeof parsed.flushOnShutdown === "boolean") config.flushOnShutdown = parsed.flushOnShutdown;
      if (typeof parsed.flushMinTurns === "number") config.flushMinTurns = parsed.flushMinTurns;
      if (isNonNegativeNumber(parsed.flushRecentMessages)) config.flushRecentMessages = parsed.flushRecentMessages;
      if (typeof parsed.autoConsolidate === "boolean") {
        config.autoConsolidate = parsed.autoConsolidate;
        hasLegacyAutoConsolidate = true;
      }
      if (isMemoryOverflowStrategy(parsed.memoryOverflowStrategy)) {
        config.memoryOverflowStrategy = parsed.memoryOverflowStrategy;
        hasMemoryOverflowStrategy = true;
      }
      if (typeof parsed.correctionDetection === "boolean") config.correctionDetection = parsed.correctionDetection;
      if (typeof parsed.errorCapture === "boolean") config.errorCapture = parsed.errorCapture;
      if (typeof parsed.worthScoring === "boolean") config.worthScoring = parsed.worthScoring;
      if (typeof parsed.usedDetection === "boolean") config.usedDetection = parsed.usedDetection;
      if (isNonNegativeNumber(parsed.usedSignatureMinChars)) config.usedSignatureMinChars = parsed.usedSignatureMinChars;
      // Decay (ticket #1b / UPSP §1): the #06 config-gap lesson — every
      // consumer-facing config key is registered here so a config-file value
      // reaches the consumer object (decayEnabled boolean guard; the three
      // numeric knobs via isNonNegativeNumber, mirroring the usedDetection
      // siblings just above).
      if (typeof parsed.decayEnabled === "boolean") config.decayEnabled = parsed.decayEnabled;
      // halflife must be > 0: halflife 0 ⇒ exp(-age/0) = NaN ⇒ clamp(NaN) = NaN,
      // corrupting heat ordering (D5 determinism). Reject 0 → default.
      if (typeof parsed.decayHalflifeDays === "number" && Number.isFinite(parsed.decayHalflifeDays) && parsed.decayHalflifeDays > 0) config.decayHalflifeDays = parsed.decayHalflifeDays;
      if (isNonNegativeNumber(parsed.decayWorthWeight)) config.decayWorthWeight = parsed.decayWorthWeight;
      if (isNonNegativeNumber(parsed.decayUsedBonus)) config.decayUsedBonus = parsed.decayUsedBonus;
      // Proactive consolidation (UPSP §1 / Task 1): the #06 config-gap lesson —
      // every knob is allowlisted here so a config-file value reaches the
      // consumer object. Type-safe guards: boolean → finite-in-range [0,1] →
      // positive int → non-negative; invalid input silently keeps the default.
      if (typeof parsed.proactiveConsolidateEnabled === "boolean") config.proactiveConsolidateEnabled = parsed.proactiveConsolidateEnabled;
      if (typeof parsed.proactiveHeatFloor === "number" && Number.isFinite(parsed.proactiveHeatFloor) && parsed.proactiveHeatFloor >= 0 && parsed.proactiveHeatFloor <= 1) config.proactiveHeatFloor = parsed.proactiveHeatFloor;
      if (Number.isInteger(parsed.proactiveMaxCandidates) && (parsed.proactiveMaxCandidates as number) > 0) config.proactiveMaxCandidates = parsed.proactiveMaxCandidates;
      if (typeof parsed.proactivePressureThreshold === "number" && Number.isFinite(parsed.proactivePressureThreshold) && parsed.proactivePressureThreshold >= 0) config.proactivePressureThreshold = parsed.proactivePressureThreshold;
      if (isNonNegativeNumber(parsed.proactiveCooldownMinutes)) config.proactiveCooldownMinutes = parsed.proactiveCooldownMinutes;
      if (typeof parsed.autoSupersede === "boolean") config.autoSupersede = parsed.autoSupersede;
      if (isNonNegativeNumber(parsed.errorCaptureRateLimit)) config.errorCaptureRateLimit = parsed.errorCaptureRateLimit;
      if (isNonNegativeNumber(parsed.errorCaptureRateWindowMs)) config.errorCaptureRateWindowMs = parsed.errorCaptureRateWindowMs;
      if (isNonNegativeNumber(parsed.errorCaptureDedupCacheSize)) config.errorCaptureDedupCacheSize = parsed.errorCaptureDedupCacheSize;
      if (isStringArray(parsed.correctionStrongPatterns)) config.correctionStrongPatterns = parsed.correctionStrongPatterns;
      if (isStringArray(parsed.correctionWeakPatterns)) config.correctionWeakPatterns = parsed.correctionWeakPatterns;
      if (isStringArray(parsed.correctionNegativePatterns)) config.correctionNegativePatterns = parsed.correctionNegativePatterns;
      if (isStringArray(parsed.correctionDirectiveWords)) config.correctionDirectiveWords = parsed.correctionDirectiveWords;
      if (typeof parsed.consolidationTimeoutMs === "number") config.consolidationTimeoutMs = parsed.consolidationTimeoutMs;
      if (typeof parsed.failureInjectionEnabled === "boolean") config.failureInjectionEnabled = parsed.failureInjectionEnabled;
      if (typeof parsed.failureInjectionMaxAgeDays === "number") config.failureInjectionMaxAgeDays = parsed.failureInjectionMaxAgeDays;
      if (typeof parsed.failureInjectionMaxEntries === "number") config.failureInjectionMaxEntries = parsed.failureInjectionMaxEntries;
      if (typeof parsed.nudgeToolCalls === "number") config.nudgeToolCalls = parsed.nudgeToolCalls;
      if (typeof parsed.projectCharLimit === "number") config.projectCharLimit = parsed.projectCharLimit;
      if (typeof parsed.failureCharLimit === "number") config.failureCharLimit = parsed.failureCharLimit;
      if (typeof parsed.memoryDir === "string") {
        const normalizedMemoryDir = normalizeConfiguredMemoryDir(parsed.memoryDir);
        if (normalizedMemoryDir) config.memoryDir = normalizedMemoryDir;
      }
      if (typeof parsed.projectsMemoryDir === "string") {
        const normalizedProjectsMemoryDir = normalizeProjectsMemoryDir(parsed.projectsMemoryDir);
        if (normalizedProjectsMemoryDir) config.projectsMemoryDir = normalizedProjectsMemoryDir;
      }
      // ticket 04 (decision 01): project memory source-of-truth location.
      // null → opt-out (legacy global); string → that path (resolved cwd-relative
      // later by resolveProjectStoreDir); absent → default <cwd>/.agents/memory/.
      if (parsed.projectMemoryDir === null) config.projectMemoryDir = null;
      else if (typeof parsed.projectMemoryDir === "string") {
        const trimmed = parsed.projectMemoryDir.trim();
        if (trimmed) config.projectMemoryDir = trimmed;
      }
      if (
        typeof parsed.sessionSearch === "object" &&
        parsed.sessionSearch !== null &&
        isSessionSearchVariant(parsed.sessionSearch.variant)
      ) {
        config.sessionSearch = { variant: parsed.sessionSearch.variant };
      }
      if (isDbBackend(parsed.dbBackend)) config.dbBackend = parsed.dbBackend;
      if (typeof parsed.lockAcquireRetries === "number") config.lockAcquireRetries = parsed.lockAcquireRetries;
      if (typeof parsed.lockOpRetries === "number") config.lockOpRetries = parsed.lockOpRetries;
      if (typeof parsed.lockOpBackoffMs === "number") config.lockOpBackoffMs = parsed.lockOpBackoffMs;
      if (typeof parsed.surreal === "object" && parsed.surreal !== null) {
        const s = parsed.surreal as Record<string, unknown>;
        const surreal: Record<string, string> = {};
        for (const key of ["endpoint", "namespace", "database", "username", "password"] as const) {
          if (typeof s[key] === "string") surreal[key] = s[key] as string;
        }
        config.surreal = surreal;
      }
      if (typeof parsed.llmModelOverride === "string") {
        const trimmed = parsed.llmModelOverride.trim();
        if (trimmed.length > 0) config.llmModelOverride = trimmed;
      }
      if (isThinkingLevel(parsed.llmThinkingOverride)) config.llmThinkingOverride = parsed.llmThinkingOverride;
      // Vector / semantic search (ticket 14 phase A): the #06 config-gap lesson —
      // every knob is allowlisted here so a config-file value reaches the
      // consumer. String knobs get a trim guard; numeric knobs via finite checks.
      if (typeof parsed.embedModel === "string" && parsed.embedModel.trim()) config.embedModel = parsed.embedModel.trim();
      if (typeof parsed.embedModelVersion === "string" && parsed.embedModelVersion.trim()) config.embedModelVersion = parsed.embedModelVersion.trim();
      if (typeof parsed.lmStudioBaseUrl === "string" && parsed.lmStudioBaseUrl.trim()) config.lmStudioBaseUrl = parsed.lmStudioBaseUrl.trim();
      if (typeof parsed.vectorTopK === "number" && Number.isFinite(parsed.vectorTopK) && parsed.vectorTopK > 0) config.vectorTopK = Math.floor(parsed.vectorTopK);
      if (typeof parsed.vectorEf === "number" && Number.isFinite(parsed.vectorEf) && parsed.vectorEf > 0) config.vectorEf = Math.floor(parsed.vectorEf);
      // survivingK (ticket 19 T3): same >0 floor guard as vectorTopK. Invalid
      // values (≤0 / non-number / null) silently keep the default.
      if (typeof parsed.survivingK === "number" && Number.isFinite(parsed.survivingK) && parsed.survivingK > 0) config.survivingK = Math.floor(parsed.survivingK);
      // kgLlm (ticket 03 T3 / D4): boolean opt-in. Only a strict boolean value
      // flows through; any other JSON type (string/number/null) is ignored →
      // the flag stays at its default (OFF). Deterministic-by-design (ADR-0001).
      if (typeof parsed.kgLlm === "boolean") config.kgLlm = parsed.kgLlm;
      if (hasMemoryOverflowStrategy) {
        config.autoConsolidate = config.memoryOverflowStrategy === "auto-consolidate";
      } else if (hasLegacyAutoConsolidate) {
        config.memoryOverflowStrategy = config.autoConsolidate ? "auto-consolidate" : "reject";
      }
    }
  } catch {
    // Fall back to defaults on parse error or access issues
  }
  // Apply the repo-local project-memory overlay (ticket 01) — narrow allowlist,
  // merged on top of the global config. A missing/malformed overlay is a no-op.
  applyRepoLocalProjectMemoryOverlay(config, cwd);
  return applyConsolidatingChildGuard(resolveSurrealDbDefault(config));
}
