export type { AdversarialReviewConfig } from "./adversarial-review.js";
export { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
export type { AgentRunOptions, AgentRunResult, AgentUsage, WorkflowAgentOptions } from "./agent.js";
export { listAvailableModelSpecs, WorkflowAgent } from "./agent.js";
export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory } from "./agent-history.js";
export type { AgentDefinition, AgentRegistry } from "./agent-registry.js";
export { applyToolPolicy, listAgentTypes, loadAgentRegistry, resolveAgentType } from "./agent-registry.js";
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
export {
  isAbortError,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
export type { WorkflowLogger, WorkflowLoggerOptions } from "./logger.js";
export { createWorkflowLogger } from "./logger.js";
export type { ModelRoute, ModelRoutingConfig } from "./model-routing.js";
export { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
export type { ModelTierConfig } from "./model-tier-config.js";
export {
  buildDefaultTierConfig,
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveTierModel,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";
export type { PersistedRunState, RunPersistence, RunStatus } from "./run-persistence.js";
export { createRunPersistence, generateRunId } from "./run-persistence.js";
export {
  parseCommandArgs,
  registerAllSavedWorkflows,
  registerSavedWorkflow,
} from "./saved-commands.js";
export type { SddReport, SddReportStatus } from "./sdd-report.js";
// ── Public SDD report parsing (stable) ────────────────────────────────
// Machine-readable view of a subagent-driven-development implementer's report
// block (ticket 04). Parsed from the `**Status:**` prose prefix the byte-identical
// SDD prompt emits; controller branches on `report.status`.
export { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "./sdd-report.js";
// `prime?` on SpawnSubagentOptions is a forward-reference to sub-project ③
// (auto-primer) — accepted but currently a NO-OP. Exported for type completeness;
// treat as experimental until ③ lands.
export type { SpawnSubagentOptions, SpawnSubagentPrime, SpawnSubagentResult } from "./spawn-subagent.js";
// ── Public subagent API (stable) ──────────────────────────────────────
// Programmatic single-subagent dispatch for peer extensions. The LLM-callable
// `subagent` tool (registered internally by extensions/workflow.ts) and the
// `workflow` tool's in-script `agent()` both run on the same WorkflowAgent
// runner; `spawnSubagent()` is the shared wrapper non-workflow callers use.
// Canonical use: peer extensions (pi-agent-ext-wayfind, -superpowers,
// -knowledge-card) invoking an isolated-context child from code rather than
// driving the LLM `subagent` tool. See CONTEXT.md "spawnSubagent".
export { spawnSubagent } from "./spawn-subagent.js";
export type { StructuredOutputCapture, StructuredOutputToolOptions } from "./structured-output.js";
export { createStructuredOutputTool } from "./structured-output.js";
export type {
  CreateSubagentRunPersistenceOptions,
  SubagentFsLayer,
  SubagentRunPersistence,
  SubagentRunRecord,
  SubagentRunStatus,
} from "./subagent-run-persistence.js";
// ── Public subagent run persistence (stable) ─────────────────────────
// Durable, inspection-only records of completed `subagent`-tool runs, for
// post-session replay (ticket 08). Deliberately separate from workflow
// RunPersistence (no resume/lease semantics — see subagent-run-persistence.ts).
export {
  createSubagentRunPersistence,
  generateSubagentRunId,
  SUBAGENT_HOME_RELATIVE_DIR,
  SUBAGENT_RUNS_SUBDIR,
  subagentHomeDir,
  subagentRunsDir,
} from "./subagent-run-persistence.js";
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
export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
