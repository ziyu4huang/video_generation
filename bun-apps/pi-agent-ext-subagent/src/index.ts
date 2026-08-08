// agent
export type {
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  FallbackDecision,
  StructuredSession,
  WorkflowAgentOptions,
} from "./agent.js";
export {
  checkBudgetExhaustion,
  extractValidated,
  lastAssistantError,
  listAvailableModelSpecs,
  resolveAgentModelSpec,
  resolveFallbackModel,
  resolveStructuredOutput,
  throwIfProviderLimit,
  WorkflowAgent,
} from "./agent.js";
// agent-history
export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory, summarizeLatestAction } from "./agent-history.js";
// agent-registry
export type { AgentDefinition, AgentRegistry } from "./agent-registry.js";
export {
  agentDefinitionKey,
  applyToolPolicy,
  listAgentTypes,
  loadAgentRegistry,
  parseAgentDefinition,
  resolveAgentType,
} from "./agent-registry.js";
// agent-row-display (shared TUI row rendering — consumed by the /subagents viewer,
// the below-editor progress widget, and re-imported by pi-agent-ext-workflow)
export type { ActivityRow, ActivityStatus, ThemeLike } from "./agent-row-display.js";
export {
  activityGlyph,
  fmtCost,
  fmtTokensShort,
  NO_THEME,
  preview,
  renderActivityRow,
  shorten,
  shortModel,
} from "./agent-row-display.js";
// config (split) + home
export { AGENTS_DIR, MODEL_TIERS_FILE } from "./config.js";
// errors
export {
  isAbortError,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
export { homeDir } from "./home.js";
// resolveModelRole re-exported directly from the leaf (model-role-config.ts)
// so lightweight consumers can import it via the package root WITHOUT pulling
// in agent.js — importing it through model-tier-config.ts would drag in the
// WorkflowAgent machinery (listAvailableModelSpecs). Same leaf the tier-config
// re-exports; no new graph edge.
export { resolveModelRole } from "./model-role-config.js";
// model-tier-config
export type { ModelTierConfig } from "./model-tier-config.js";
export {
  buildDefaultTierConfig,
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveTierModel,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";
// rate-limiter (shared per-provider concurrency cap — wayfinder tickets 02+03).
// Process-global via globalThis so BOTH this package (subagents/subagent) and
// pi-agent-ext-workflow resolve ONE limiter instance per provider and bound
// their COMBINED provider dispatch. Pass-through until rateLimits is configured.
export type { RateLimitCapResolver, RateLimiter } from "./rate-limiter.js";
export {
  getGlobalRateLimiter,
  getRateLimitCapResolver,
  providerFromModelSpec,
  setRateLimitCapResolver,
} from "./rate-limiter.js";
// sdd-report
export type { SddReport, SddReportStatus } from "./sdd-report.js";
export { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "./sdd-report.js";
// spawn-subagent
export type { SpawnSubagentOptions, SpawnSubagentPrime, SpawnSubagentResult } from "./spawn-subagent.js";
export { spawnSubagent } from "./spawn-subagent.js";
// spawn-subagent-subprocess (the isolated-process analog; wayfind ticket 04).
// Consumers that need a clean child pi process (obsidian distill/garden,
// tool-gate L2 A/B) use this instead of the in-process spawnSubagent.
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
// structured-output
export type { StructuredOutputCapture, StructuredOutputToolOptions } from "./structured-output.js";
export { createStructuredOutputTool } from "./structured-output.js";
// subagent-in-flight
export type { InFlightSubagent } from "./subagent-in-flight.js";
export { getSubagentInFlightRegistry, SubagentInFlightRegistry } from "./subagent-in-flight.js";
// subagent-run-persistence
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
// subagent-runs-tool
export type { SubagentRunsToolOptions } from "./subagent-runs-tool.js";
export { createSubagentRunsTool } from "./subagent-runs-tool.js";
// subagent-tool
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool.js";
export { createSubagentTool, formatHistoryLine } from "./subagent-tool.js";
// subagents batch tool (plural — wraps spawnSubagent for fan-out batches)
export type {
  BatchResultSlot,
  BatchTask,
  SubagentsToolDetails,
  SubagentsToolOptions,
} from "./subagents-tool.js";
export {
  createSubagentsTool,
  renderBatchResult,
  renderSubagentsCall,
  renderSubagentsResult,
  subagentsToolSchema,
} from "./subagents-tool.js";
// tool-action-label (shared verb-led phrase helper — see ticket 02)
export type { ToolActionContext } from "./tool-action-label.js";
export { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";
export type {
  WatchdogFinding,
  WatchdogL1Result,
  WatchdogL2Result,
  WatchdogOptions,
  WatchdogResult,
} from "./watchdog/types.js";
export { normalizeWatchdogParam } from "./watchdog/types.js";
export type { RunWatchdogInput } from "./watchdog/watchdog.js";
// watchdog (ticket 02 — two-layer edit-gated reviewer)
export { runWatchdog } from "./watchdog/watchdog.js";
// worktree
export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
