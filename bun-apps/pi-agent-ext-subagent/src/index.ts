// agent
// agent-history
// agent-registry
// agent-row-display (shared TUI row rendering — consumed by the /subagents viewer,
// the below-editor progress widget, and re-imported by pi-agent-ext-workflow)
// model-tier-config
// rate-limiter (shared per-provider concurrency cap — wayfinder tickets 02+03).
// Process-global via globalThis so BOTH this package (subagents/subagent) and
// pi-agent-ext-workflow resolve ONE limiter instance per provider and bound
// their COMBINED provider dispatch. Pass-through until rateLimits is configured.
// sdd-report
// structured-output
// subagent-in-flight
// tool-action-label (shared verb-led phrase helper — see ticket 02)
// worktree
export type {
  ActivityRow,
  ActivityStatus,
  AgentDefinition,
  AgentHistoryEntry,
  AgentHistoryKind,
  AgentHistoryRole,
  AgentRegistry,
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  FallbackDecision,
  InFlightSubagent,
  ModelTierConfig,
  RateLimitCapResolver,
  RateLimiter,
  SddReport,
  SddReportStatus,
  StructuredOutputCapture,
  StructuredOutputToolOptions,
  StructuredSession,
  ThemeLike,
  ToolActionContext,
  WorkflowAgentOptions,
  Worktree,
} from "@repo/pi-agent-ext-core-runtime";
// Canonical class name (WorkflowAgent above is the back-compat alias).
// config (split) + home
// errors
// resolveModelRole + the tier fns now live in core-runtime (sourced from the
// model-role-config leaf there). Back-compat: the symbol names are unchanged.
export {
  AGENTS_DIR,
  activityGlyph,
  agentDefinitionKey,
  applyToolPolicy,
  buildDefaultTierConfig,
  CoreAgent,
  checkBudgetExhaustion,
  compactAgentHistory,
  createStructuredOutputTool,
  createWorktree,
  extractValidated,
  fmtCost,
  fmtTokensShort,
  formatToolAction,
  getGlobalRateLimiter,
  getModelTierConfigPath,
  getRateLimitCapResolver,
  getSubagentInFlightRegistry,
  homeDir,
  isAbortError,
  isSddReportActionable,
  isTimeoutError,
  isWorkflowError,
  lastAssistantError,
  listAgentTypes,
  listAvailableModelSpecs,
  loadAgentRegistry,
  loadModelTierConfig,
  MODEL_TIERS_FILE,
  matchedCallArgsFor,
  NO_THEME,
  parseAgentDefinition,
  parseSddReport,
  preview,
  providerFromModelSpec,
  removeWorktree,
  renderActivityRow,
  resolveAgentModelSpec,
  resolveAgentType,
  resolveFallbackModel,
  resolveModelRole,
  resolveStructuredOutput,
  resolveTierModel,
  SDD_REPORT_STATUSES,
  SubagentInFlightRegistry,
  saveModelTierConfig,
  setRateLimitCapResolver,
  shorten,
  shortModel,
  sortedTierNames,
  summarizeLatestAction,
  throwIfProviderLimit,
  WorkflowAgent,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "@repo/pi-agent-ext-core-runtime";
// spawn-subagent
export type { SpawnSubagentOptions, SpawnSubagentResult } from "./spawn-subagent.js";
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
export { createSubagentTool } from "./subagent-tool.js";
export { formatHistoryLine } from "./subagent-tool-render.js";
// subagent-tool
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool-schema.js";
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
