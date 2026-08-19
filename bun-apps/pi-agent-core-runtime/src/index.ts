// Shared agent-execution runtime for pi-agent-ext-subagent and pi-agent-ext-workflow.
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

export type { TurnExhaustion, TurnGuard, TurnSessionSurface } from "./agent-turns.js";
export {
  createTurnGuard,
  isTurnEndObservation,
  isTurnStartObservation,
  turnExhaustionError,
} from "./agent-turns.js";

export { listAvailableModelSpecs } from "./available-models.js";
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
export type { RunView } from "./run-view.js";
export { buildRunView, isTerminalStatus } from "./run-view.js";

export type { SddReport, SddReportStatus } from "./sdd-report.js";
export { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "./sdd-report.js";

export type { StructuredOutputCapture, StructuredOutputToolOptions, StructuredSession } from "./structured-output.js";
export { createStructuredOutputTool, extractValidated, resolveStructuredOutput } from "./structured-output.js";
export type { TerminalStatus } from "./subagent-in-flight.js";
export {
  getSubagentInFlightRegistry,
  SubagentInFlightRegistry,
} from "./subagent-in-flight.js";

export type { ToolActionContext } from "./tool-action-label.js";
export { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";

export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
