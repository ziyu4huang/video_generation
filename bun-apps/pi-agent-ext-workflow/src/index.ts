// `prime?` on SpawnSubagentOptions is a forward-reference to sub-project ③
// (auto-primer) — accepted but currently a NO-OP. Exported for type completeness;
// treat as experimental until ③ lands.
export type {
  AgentDefinition,
  AgentHistoryEntry,
  AgentHistoryKind,
  AgentHistoryRole,
  AgentRegistry,
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  CreateSubagentRunPersistenceOptions,
  ModelTierConfig,
  SddReport,
  SddReportStatus,
  SpawnSubagentOptions,
  SpawnSubagentPrime,
  SpawnSubagentResult,
  StructuredOutputCapture,
  StructuredOutputToolOptions,
  SubagentFsLayer,
  SubagentRunPersistence,
  SubagentRunRecord,
  SubagentRunStatus,
  SubagentRunsToolOptions,
  WorkflowAgentOptions,
  Worktree,
} from "@repo/pi-agent-ext-subagent";
// ── Public SDD report parsing (stable) ────────────────────────────────
// Machine-readable view of a subagent-driven-development implementer's report
// block (ticket 04). Parsed from the `**Status:**` prose prefix the byte-identical
// SDD prompt emits; controller branches on `report.status`.
// ── Public subagent API (stable) ──────────────────────────────────────
// Programmatic single-subagent dispatch for peer extensions. The LLM-callable
// `subagent` tool (registered internally by extensions/workflow.ts) and the
// `workflow` tool's in-script `agent()` both run on the same WorkflowAgent
// runner; `spawnSubagent()` is the shared wrapper non-workflow callers use.
// Canonical use: peer extensions (pi-agent-ext-wayfind, -superpowers,
// -knowledge-card) invoking an isolated-context child from code rather than
// driving the LLM `subagent` tool. See CONTEXT.md "spawnSubagent".
// ── Public subagent run persistence (stable) ─────────────────────────
// Durable, inspection-only records of completed `subagent`-tool runs, for
// post-session replay (ticket 08). Deliberately separate from workflow
// RunPersistence (no resume/lease semantics — see subagent-run-persistence.ts).
export {
  AGENTS_DIR,
  applyToolPolicy,
  buildDefaultTierConfig,
  compactAgentHistory,
  createStructuredOutputTool,
  createSubagentRunPersistence,
  createSubagentRunsTool,
  createWorktree,
  generateSubagentRunId,
  getModelTierConfigPath,
  isAbortError,
  isSddReportActionable,
  isTimeoutError,
  isWorkflowError,
  listAgentTypes,
  listAvailableModelSpecs,
  loadAgentRegistry,
  loadModelTierConfig,
  MODEL_TIERS_FILE,
  parseSddReport,
  removeWorktree,
  resolveAgentType,
  resolveTierModel,
  SDD_REPORT_STATUSES,
  SUBAGENT_HOME_RELATIVE_DIR,
  SUBAGENT_RUNS_SUBDIR,
  saveModelTierConfig,
  sortedTierNames,
  spawnSubagent,
  subagentHomeDir,
  subagentRunsDir,
  WorkflowAgent,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "@repo/pi-agent-ext-subagent";
export type { AdversarialReviewConfig } from "./adversarial-review.js";
export { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
export { registerBuiltinWorkflows } from "./builtin-commands.js";
export * from "./config.js";
export type { DeepResearchConfig } from "./deep-research.js";
export { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
export type {
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowDisplay,
  WorkflowDisplayOptions,
  WorkflowSnapshot,
} from "./display.js";
export {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
} from "./display.js";
export {
  createEffortState,
  type EffortLevel,
  type EffortState,
  effortDirective,
  isSubstantive,
  registerEffortCommand,
} from "./effort-command.js";
export type { WorkflowLogger, WorkflowLoggerOptions } from "./logger.js";
export { createWorkflowLogger } from "./logger.js";
export type { ModelRoute, ModelRoutingConfig } from "./model-routing.js";
export { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
export type { PersistedRunState, RunPersistence, RunStatus } from "./run-persistence.js";
export { createRunPersistence, generateRunId } from "./run-persistence.js";
export {
  parseCommandArgs,
  registerAllSavedWorkflows,
  registerSavedWorkflow,
} from "./saved-commands.js";
export {
  deliverText,
  installResultDelivery,
  installTaskPanel,
  redeliverPendingResults,
  type TaskPanelOptions,
} from "./task-panel.js";
export { createWebFetchTool, createWebSearchTool, createWebTools } from "./web-tools.js";
export type {
  AgentOptions,
  JournalEntry,
  SharedRuntime,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./workflow.js";
export { parseWorkflowScript, runWorkflow } from "./workflow.js";
export { registerWorkflowCommands } from "./workflow-commands.js";
export type { WorkflowControlToolInput, WorkflowControlToolOptions } from "./workflow-control-tool.js";
export { createWorkflowControlTool } from "./workflow-control-tool.js";
export {
  buildForcedWorkflowPrompt,
  colorizeWorkflow,
  endsWithTrigger,
  hasTrigger,
  type InstallWorkflowEditorOptions,
  installWorkflowEditor,
  RAINBOW,
  registerWorkflowProgressCommands,
  registerWorkflowTriggerCommand,
  tokenizeAnsi,
  WorkflowEditor,
  type WorkflowModeState,
} from "./workflow-editor.js";
export type { ManagedRun, WorkflowManagerOptions } from "./workflow-manager.js";
export { WorkflowManager } from "./workflow-manager.js";
export type {
  ResolvedWorkflow,
  ResolvedWorkflowPack,
  RunWorkflowScriptOptions,
  WorkflowListResult,
  WorkflowListRow,
  WorkflowPackFs,
} from "./workflow-pack.js";
export {
  DEFAULT_RUNS_DIR,
  findRepoRoot,
  listWorkflows,
  mergeArgs,
  PI_WORKFLOWS_DIR,
  PKG_WORKFLOWS_GLOB,
  resolvePackOverrides,
  resolveRunsDir,
  resolveWorkflowPack,
  resolveWorkflowScript,
  runWorkflowScript,
} from "./workflow-pack.js";
export type { Manifest, ReadManifestOptions } from "./workflow-pack-manifest.js";
export { readManifest, validateManifest } from "./workflow-pack-manifest.js";
export type { WorkflowProjectPaths } from "./workflow-paths.js";
export {
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowHomeDir,
  workflowProjectKey,
  workflowProjectPaths,
  workflowUserSavedDir,
} from "./workflow-paths.js";
export type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
export { assertSafeSavedWorkflowName, createWorkflowStorage, isSafeSavedWorkflowName } from "./workflow-saved.js";
export type { WorkflowSettings, WorkflowSettingsOptions, WorkflowSettingsStore } from "./workflow-settings.js";
export {
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "./workflow-settings.js";
export type { WorkflowToolInput, WorkflowToolOptions } from "./workflow-tool.js";
export {
  backgroundStartedText,
  buildSimplifiedGuidelines,
  buildVerboseGuidelines,
  buildWorkflowGuidelinesForTurn,
  buildWorkflowPointerGuideline,
  createWorkflowHelpTool,
  createWorkflowTool,
  modelRoutingGuideline,
  shouldInjectFullWorkflowGuidelines,
} from "./workflow-tool.js";
export {
  keyToAction,
  type NavAction,
  NavigatorModel,
  NavigatorState,
  openWorkflowNavigator,
  renderNavigator,
  type ViewKind,
} from "./workflow-ui.js";
export { registerWorkflowModelsCommand } from "./workflows-models-command.js";
