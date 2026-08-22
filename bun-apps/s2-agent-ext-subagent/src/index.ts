/**
 * Peer-facing barrel for `@repo/s2-agent-ext-subagent`.
 *
 * The rule this file follows — enforced by `tests/barrel-surface.test.ts`:
 *
 *   1. Everything this package OWNS is exported here (the tools, spawn, the
 *      persistence store, the watchdog types).
 *   2. A symbol that belongs to `@repo/s2-agent-core-runtime` is re-exported
 *      here ONLY when a peer package actually imports it through this barrel.
 *
 * Rule 2 is not politeness — it is load-bearing. `s2-agent`, `s2-agent-ext-obsidian`,
 * `s2-agent-ext-file2md` and `s2-agent-ext-knowledge-card` do NOT declare
 * `@repo/s2-agent-core-runtime` in their package.json, so this barrel is their
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
} from "@repo/s2-agent-core-runtime";
export {
  getGlobalRateLimiter,
  loadModelTierConfig,
  logModelDecision,
  resolveModelRole,
  roleAwareDirectCall,
  saveModelTierConfig,
  setRateLimitCapResolver,
  spawnSubagent,
  WorkflowAgent,
} from "@repo/s2-agent-core-runtime";
// ── owned: background dispatch roster + task-notification delivery ───────────
export {
  BackgroundRunManager,
  type BackgroundRunOutcome,
  type BackgroundRunSpec,
  type BackgroundRunStatus,
  backgroundCap,
  formatTaskNotification,
  getBackgroundRunManager,
  wireBackgroundDeliverer,
} from "./background-run-manager.js";
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
// ── owned: child→parent message bus (send_message to:'main', ticket 02) ────
export type { ParentMessageFrom } from "./parent-message-bus.js";
export {
  formatAgentMessage,
  getParentMessageBus,
  ParentMessageBus,
  wireParentMessageDeliverer,
} from "./parent-message-bus.js";
// ── owned: send_message tool (named-agent follow-ups, ticket 02) ───────────
export type { SendMessageToolOptions } from "./send-message-tool.js";
export { createSendMessageTool, formatReplyNotification, sendMessageToolSchema } from "./send-message-tool.js";
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
