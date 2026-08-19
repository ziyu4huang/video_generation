/**
 * Peer-facing barrel for `@repo/pi-agent-ext-subagent`.
 *
 * The rule this file follows — enforced by `tests/barrel-surface.test.ts`:
 *
 *   1. Everything this package OWNS is exported here (the tools, spawn, the
 *      persistence store, the watchdog types).
 *   2. A symbol that belongs to `@repo/pi-agent-core-runtime` is re-exported
 *      here ONLY when a peer package actually imports it through this barrel.
 *
 * Rule 2 is not politeness — it is load-bearing. `pi-agent`, `pi-agent-ext-obsidian`,
 * `pi-agent-ext-file2md` and `pi-agent-ext-knowledge-card` do NOT declare
 * `@repo/pi-agent-core-runtime` in their package.json, so this barrel is their
 * only legal path to those symbols (the dep-guard's invariant 1 rejects an
 * undeclared @repo edge). Re-exporting MORE than that is what let this file grow
 * to 114 names of which 21 were ever imported: a wide interface with no leverage
 * behind it, and one that hides which peers depend on what.
 *
 * Adding a core-runtime re-export here therefore means one of two things, and you
 * should be explicit about which: either a peer genuinely needs the facade (add it
 * to FACADE_SYMBOLS in the guard test with the consuming package named), or the
 * peer should declare core-runtime and import it directly.
 */

// ── core-runtime facade (rule 2) ─────────────────────────────────────────────
// Which peer consumes which symbol is recorded in FACADE_SYMBOLS in
// tests/barrel-surface.test.ts, not in comments here — biome sorts export names,
// so per-line attribution would drift out of alignment on the next `--write`.
export type {
  AgentHistoryEntry,
  AgentUsage,
  SpawnSubagentOptions,
  SpawnSubagentResult,
  SubagentFailure,
} from "@repo/pi-agent-core-runtime";
export {
  getGlobalRateLimiter,
  getSubagentInFlightRegistry,
  loadModelTierConfig,
  logModelDecision,
  resolveModelRole,
  roleAwareDirectCall,
  saveModelTierConfig,
  setRateLimitCapResolver,
  spawnSubagent,
  WorkflowAgent,
} from "@repo/pi-agent-core-runtime";
// ── owned: detach dispatch (Task 06) — alt+s global + ctrl+b in-viewer ─────
export {
  DETACH_KEY_BYTE,
  dispatchCtrlB,
  foregroundRunIds,
  GLOBAL_DETACH_KEY,
  GLOBAL_DETACH_SEQUENCE,
} from "./ctrl-b.js";
// ── owned: detach pipeline (Task 05) — global detach (Task 06) ─────────────
export type {
  DetachDeps,
  DetachedChildHandle,
  DetachedSpawn,
  DetachedSpawnSpec,
  DetachOutcome,
} from "./detach-run.js";
export { convertToBackground, makeProdDetachDeps, spawnDetachedChild } from "./detach-run.js";
// The isolated-PROCESS analog (wayfind ticket 04). Consumers that need a clean
// child pi process (obsidian distill/garden, tool-gate L2 A/B) use this instead
// of the in-process spawnSubagent.
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
// ── owned: durable run records ───────────────────────────────────────────────
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
// ── owned: the LLM-facing tools ──────────────────────────────────────────────
export type { SubagentRunsToolOptions } from "./subagent-runs-tool.js";
export { createSubagentRunsTool } from "./subagent-runs-tool.js";
export { createSubagentTool } from "./subagent-tool.js";
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool-schema.js";
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
// ── owned: two-layer edit-gated reviewer (ticket 02) ─────────────────────────
export type {
  WatchdogFinding,
  WatchdogL1Result,
  WatchdogL2Result,
  WatchdogOptions,
  WatchdogResult,
} from "./watchdog/types.js";
export { normalizeWatchdogParam } from "./watchdog/types.js";
export type { RunWatchdogInput } from "./watchdog/watchdog.js";
export { runWatchdog } from "./watchdog/watchdog.js";
