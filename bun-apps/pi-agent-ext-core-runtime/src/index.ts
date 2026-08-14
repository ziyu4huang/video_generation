// Shared agent-execution runtime for pi-agent-ext-subagent and pi-agent-ext-workflow.
// Public surface mirrors the former subagent barrel (behavior-preserving sourcing)
// plus internal-consumer symbols. WorkflowAgent is the back-compat alias for CoreAgent.

export type {
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  BudgetExhaustion,
  BudgetGuard,
  BudgetSeam,
  BudgetSessionSurface,
  BudgetWarning,
  FallbackDecision,
  StructuredSession,
  TurnExhaustion,
  TurnGuard,
  TurnSessionSurface,
  WorkflowAgentOptions,
} from "./agent.js";
export {
  BUDGET_WARNING_RATIO,
  BUDGET_WRAP_UP_MESSAGE,
  CoreAgent,
  CoreAgent as WorkflowAgent,
  checkBudgetExhaustion,
  checkBudgetWarning,
  createBudgetGuard,
  createTurnGuard,
  extractValidated,
  isTurnEndObservation,
  isTurnStartObservation,
  lastAssistantError,
  listAvailableModelSpecs,
  resolveAgentModelSpec,
  resolveFallbackModel,
  resolveStructuredOutput,
  throwIfProviderLimit,
  turnExhaustionError,
} from "./agent.js";

export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryOptions, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory, summarizeLatestAction } from "./agent-history.js";

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
export { AGENTS_DIR, DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_TASKS, MAX_CONCURRENCY, MODEL_TIERS_FILE } from "./config.js";
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
export type { RateLimitCapResolver, RateLimiter } from "./rate-limiter.js";
export {
  __resetRateLimitStateForTests,
  getGlobalRateLimiter,
  getRateLimitCapResolver,
  providerFromModelSpec,
  setRateLimitCapResolver,
} from "./rate-limiter.js";
export type { RunView } from "./run-view.js";
export { buildRunView, isTerminalStatus } from "./run-view.js";

export type { SddReport, SddReportStatus } from "./sdd-report.js";
export { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "./sdd-report.js";

export type { StructuredOutputCapture, StructuredOutputToolOptions } from "./structured-output.js";
export { createStructuredOutputTool } from "./structured-output.js";
/** @deprecated Dispatch B removes — use RunView via registry.view(s)(). */
export type { InFlightSubagent, TerminalStatus } from "./subagent-in-flight.js";
export {
  getSubagentInFlightRegistry,
  SubagentInFlightRegistry,
} from "./subagent-in-flight.js";

export type { ToolActionContext } from "./tool-action-label.js";
export { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";

export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
