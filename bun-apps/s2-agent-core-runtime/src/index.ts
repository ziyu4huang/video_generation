// Shared agent-execution runtime for s2-agent-ext-subagent and s2-agent-ext-workflow.
// Public surface mirrors the former subagent barrel (behavior-preserving sourcing)
// plus internal-consumer symbols. WorkflowAgent is the back-compat alias for CoreAgent.
//
// EVERY LINE SOURCES FROM THE MODULE THAT DEFINES THE SYMBOL. When agent.ts was
// split, the pieces kept being re-exported through agent.ts and this barrel kept
// naming agent.js as their origin — so the file that OWNS a symbol and the file
// this barrel credited for it drifted apart, and `resolveStructuredOutput` and
// `createStructuredOutputTool` (siblings in structured-output.ts) arrived here by
// two different routes. A one-hop barrel means "where does X live?" is answered
// by reading this file, and a moved definition breaks the build at its new home
// instead of silently continuing to work through a stale hop.

export type { AgentRunOptions, AgentRunResult, WorkflowAgentOptions } from "./agent.js";
export { CoreAgent, CoreAgent as WorkflowAgent } from "./agent.js";

export type {
  AgentUsage,
  BudgetExhaustion,
  BudgetGuard,
  BudgetSeam,
  BudgetSessionSurface,
  BudgetWarning,
} from "./agent-budget.js";
export {
  BUDGET_WARNING_RATIO,
  BUDGET_WRAP_UP_MESSAGE,
  checkBudgetExhaustion,
  checkBudgetWarning,
  createBudgetGuard,
} from "./agent-budget.js";

export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryOptions, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory, summarizeLatestAction } from "./agent-history.js";
export type { FallbackDecision } from "./agent-model.js";
export {
  clampModelToScope,
  resolveAgentModelSpec,
  resolveFallbackModel,
  resolveScopedAgentModelSpec,
} from "./agent-model.js";
export type { AgentDefinition, AgentRegistry } from "./agent-registry.js";
export {
  agentDefinitionKey,
  applyToolPolicy,
  listAgentTypes,
  loadAgentRegistry,
  parseAgentDefinition,
  resolveAgentType,
} from "./agent-registry.js";
export type { ActivityRow, ActivityStatus, ThemeLike } from "./agent-row-display.js";
export {
  activityGlyph,
  fmtCost,
  fmtElapsed,
  fmtTokensShort,
  glyphFor,
  NO_THEME,
  preview,
  renderActivityRow,
  renderBadge,
  renderRunRow,
  runHeader,
  shorten,
  shortModel,
} from "./agent-row-display.js";
export {
  capTraceTail,
  formatHistoryLine,
  formatSubagentLive,
  formatSubagentProgress,
  formatSubagentTrace,
  latestMessageLine,
  STREAMING_EXPANDED_TAIL,
} from "./agent-trace-display.js";

export type { TurnExhaustion, TurnGuard, TurnSessionSurface } from "./agent-turns.js";
export {
  createTurnGuard,
  isTurnEndObservation,
  isTurnStartObservation,
  turnExhaustionError,
} from "./agent-turns.js";

export { listAvailableModelSpecs } from "./available-models.js";
export type { DispatchRole } from "./budget-defaults.js";
export { ROLE_AWARE_DISPATCH_BOUNDS, roleAwareDefaults, tierDefaultToken } from "./budget-defaults.js";

export { AGENTS_DIR, DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_TASKS, MAX_CONCURRENCY, MODEL_TIERS_FILE } from "./config.js";
export { debugModelsEnabled, logModelDecision } from "./debug-models.js";
export { appendEnvHints, ENV_HINTS_MARKER } from "./env-hints.js";
export {
  classifyProviderLimit,
  isAbortError,
  isProviderUsageLimit,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
export {
  findWorkspaceRoot,
  isBunVirtualPath,
  isDeployedExtDir,
  missingExtDeps,
  packageBaseName,
} from "./ext-deps.js";
export { homeDir } from "./home.js";
export { resolveModelRole } from "./model-role-config.js";
export type { ModelTierConfig } from "./model-tier-config.js";
export {
  buildDefaultTierConfig,
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveTierModel,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";
export { lastAssistantError, throwIfProviderLimit } from "./provider-limit.js";
export type { RateLimitCapResolver, RateLimiter } from "./rate-limiter.js";
export {
  __resetRateLimitStateForTests,
  getGlobalRateLimiter,
  getRateLimitCapResolver,
  providerFromModelSpec,
  setRateLimitCapResolver,
} from "./rate-limiter.js";
export { capWidth, ellipsizeMidToWidth, ellipsizeToWidth } from "./render-width.js";
export type { DispatchBudgetCohort } from "./role-dispatch.js";
export {
  abortSafetyFooter,
  abortSafetyLogPath,
  hasWriteTools,
  roleAwareDirectCall,
  shouldInjectFooter,
} from "./role-dispatch.js";
export type { RunView } from "./run-view.js";
export { buildRunView, isTerminalStatus } from "./run-view.js";
export type { SddReport, SddReportStatus } from "./sdd-report.js";
export { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "./sdd-report.js";
export type { SpawnSubagentOptions, SpawnSubagentResult, SubagentFailure } from "./spawn-subagent.js";
export { deriveTaskLabel, resolveSessionOverride, spawnSubagent } from "./spawn-subagent.js";
// Isolated-PROCESS dispatch (moved from s2-agent-ext-subagent as the
// #1733 continuation: base-set extensions — obsidian — consume it without an
// ext→ext edge). Consumers that need a clean child pi process (obsidian
// distill/garden, tool-gate L2 A/B) use this instead of in-process spawnSubagent.
export type {
  ChildProcessLike,
  SpawnFn,
  SpawnSubagentSubprocessOptions,
  SubprocessArgsOptions,
} from "./spawn-subagent-subprocess.js";
export {
  buildSubagentArgs,
  getPiInvocation,
  isTransientError,
  spawnSubagentSubprocess,
} from "./spawn-subagent-subprocess.js";
export type { StructuredOutputCapture, StructuredOutputToolOptions, StructuredSession } from "./structured-output.js";
export { createStructuredOutputTool, extractValidated, resolveStructuredOutput } from "./structured-output.js";
export type { TerminalStatus } from "./subagent-in-flight.js";
export {
  getSubagentInFlightRegistry,
  SubagentInFlightRegistry,
} from "./subagent-in-flight.js";
// Record-shape types shared by the dispatch layer and run records (moved with
// the persistence layer; subagent's git-scope / subagent-tool-schema /
// watchdog/types re-export from here to keep their public surface).
export type {
  SubagentBudgetDetails,
  SubagentSalvage,
  SubagentScopeCheck,
  WatchdogFinding,
  WatchdogL1Result,
  WatchdogL2Result,
  WatchdogResult,
  WatchdogSeverity,
  WatchdogSource,
} from "./subagent-record-types.js";
// Durable run records for completed subagent-tool dispatches (moved from
// s2-agent-ext-subagent with the isolated-process layer above).
export type {
  CreateSubagentRunPersistenceOptions,
  SubagentFsLayer,
  SubagentRunPersistence,
  SubagentRunRecord,
  SubagentRunStatus,
} from "./subagent-run-persistence.js";
export {
  createSubagentRunPersistence,
  generateSubagentRunId,
  getSubagentRunPersistence,
  SUBAGENT_HOME_RELATIVE_DIR,
  SUBAGENT_RUNS_SUBDIR,
  subagentHomeDir,
  subagentRunsDir,
} from "./subagent-run-persistence.js";

export type { ToolActionContext } from "./tool-action-label.js";
export { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";

export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
