/**
 * planning-with-files — public API surface.
 *
 * The compiled `dist/` is what npm consumers import (`exports` → ./dist). The
 * Pi extension entry point (`extensions/index.ts`) re-exports the default
 * factory from here. Pure helpers (plan parsing, attestation, modes) are
 * re-exported so downstream packages / tests can use them without importing
 * from internal paths.
 */

export type { AttestationCheck, AttestMode, AttestResult } from "./attestation.js";
export { attestPlan, buildTamperMessage, checkPlanAttestation } from "./attestation.js";
export { parseIntervalSpec } from "./commands.js";
export {
  AUTO_CONTINUE_LIMIT,
  CACHE_SAFE_REMINDER,
  CUSTOM_TYPE,
  DEFAULT_GOAL_CONDITION,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_LOOP_PROMPT,
  PKG_NAME,
  PLAN_DATA_BEGIN,
  PLAN_DATA_END,
  POST_WRITE_REMINDER,
  PRE_TOOL_CACHE_SAFE_REMINDER,
  TAMPERED_PREFIX,
} from "./constants.js";
export { DANGEROUS_BASH_PATTERNS, isDangerousBashCommand } from "./guard.js";
// PLI v2 — Plan Lifecycle Intelligence (multi-plan list/lint/switch + token cost)
export type {
  AttestationState,
  LintFinding,
  LintLevel,
  LintReport,
  PlanRow,
  SwitchResult,
} from "./lifecycle.js";
export { enumeratePlans, lintAllPlans, lintPlan, renderPlanList, switchActivePlan } from "./lifecycle.js";
export type { EffectiveMode, HookMode } from "./modes.js";
export { deriveEffectiveMode, parseMode, resolveAutoApprove, resolveConfiguredMode } from "./modes.js";
export type { PlanPaths, PlanScope, PlanStatus } from "./plan.js";
export {
  isAllPhasesComplete,
  isPlanIncomplete,
  isSessionAttached,
  makeRootPaths,
  makeScopedPaths,
  readPlanStatus,
  readPlanStatusFromPaths,
  resolvePlanPaths,
  summarizePlan,
} from "./plan.js";
export { default as planningWithFilesExtension } from "./runtime.js";
export type { CatchupResult, ExecResult } from "./scripts.js";
export { checkCompleteReport, runSessionCatchup } from "./scripts.js";
export type { RuntimeState } from "./state.js";
export { createRuntimeState } from "./state.js";
export type { InjectionCost } from "./tokens.js";
export { buildParityInjectionForCost, estimateTokens, injectionTokenCost } from "./tokens.js";
