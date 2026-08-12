// agent
export type {
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  FallbackDecision,
  StructuredSession,
  WorkflowAgentOptions,
} from "@repo/pi-agent-ext-core-runtime";
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
} from "@repo/pi-agent-ext-core-runtime";
// Canonical class name (WorkflowAgent above is the back-compat alias).
export { CoreAgent } from "@repo/pi-agent-ext-core-runtime";
// agent-history
export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryRole } from "@repo/pi-agent-ext-core-runtime";
export { compactAgentHistory, summarizeLatestAction } from "@repo/pi-agent-ext-core-runtime";
// agent-registry
export type { AgentDefinition, AgentRegistry } from "@repo/pi-agent-ext-core-runtime";
export {
  agentDefinitionKey,
  applyToolPolicy,
  listAgentTypes,
  loadAgentRegistry,
  parseAgentDefinition,
  resolveAgentType,
} from "@repo/pi-agent-ext-core-runtime";
// agent-row-display (shared TUI row rendering — consumed by the /subagents viewer,
// the below-editor progress widget, and re-imported by pi-agent-ext-workflow)
export type { ActivityRow, ActivityStatus, ThemeLike } from "@repo/pi-agent-ext-core-runtime";
export {
  activityGlyph,
  fmtCost,
  fmtTokensShort,
  NO_THEME,
  preview,
  renderActivityRow,
  shorten,
  shortModel,
} from "@repo/pi-agent-ext-core-runtime";
// config (split) + home
export { AGENTS_DIR, MODEL_TIERS_FILE } from "@repo/pi-agent-ext-core-runtime";
// errors
export {
  isAbortError,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "@repo/pi-agent-ext-core-runtime";
export { homeDir } from "@repo/pi-agent-ext-core-runtime";
// resolveModelRole + the tier fns now live in core-runtime (sourced from the
// model-role-config leaf there). Back-compat: the symbol names are unchanged.
export { resolveModelRole } from "@repo/pi-agent-ext-core-runtime";
// model-tier-config
export type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
export {
  buildDefaultTierConfig,
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveTierModel,
  saveModelTierConfig,
  sortedTierNames,
} from "@repo/pi-agent-ext-core-runtime";
// rate-limiter (shared per-provider concurrency cap — wayfinder tickets 02+03).
// Process-global via globalThis so BOTH this package (subagents/subagent) and
// pi-agent-ext-workflow resolve ONE limiter instance per provider and bound
// their COMBINED provider dispatch. Pass-through until rateLimits is configured.
export type { RateLimitCapResolver, RateLimiter } from "@repo/pi-agent-ext-core-runtime";
export {
  getGlobalRateLimiter,
  getRateLimitCapResolver,
  providerFromModelSpec,
  setRateLimitCapResolver,
} from "@repo/pi-agent-ext-core-runtime";
// sdd-report
export type { SddReport, SddReportStatus } from "@repo/pi-agent-ext-core-runtime";
export { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "@repo/pi-agent-ext-core-runtime";
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
export type { StructuredOutputCapture, StructuredOutputToolOptions } from "@repo/pi-agent-ext-core-runtime";
export { createStructuredOutputTool } from "@repo/pi-agent-ext-core-runtime";
// subagent-in-flight
export type { InFlightSubagent } from "@repo/pi-agent-ext-core-runtime";
export { getSubagentInFlightRegistry, SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";
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
// tool-action-label (shared verb-led phrase helper — see ticket 02)
export type { ToolActionContext } from "@repo/pi-agent-ext-core-runtime";
export { formatToolAction, matchedCallArgsFor } from "@repo/pi-agent-ext-core-runtime";
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
export type { Worktree } from "@repo/pi-agent-ext-core-runtime";
export { createWorktree, removeWorktree } from "@repo/pi-agent-ext-core-runtime";
