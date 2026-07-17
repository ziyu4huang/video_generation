/**
 * PLI v2 — Plan Lifecycle Intelligence.
 *
 * Multi-plan enumeration, diagnostics, and active-plan switching. Builds ON the
 * single-plan resolver in plan.ts (reusing readPlanStatusFromPaths / makeScopedPaths
 * / makeRootPaths) so every row/diagnosis uses the EXACT same parser as the active
 * plan — no divergent classification logic.
 *
 * All functions are pure-ish (only side effect is reading/writing files); none
 * import the Pi runtime, so they unit-test in isolation. switchActivePlan is the
 * sole writer and its only write is <cwd>/.planning/.active_plan.
 */

import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { checkPlanAttestation } from "./attestation.js";
import {
  isCloseMarker,
  makeRootPaths,
  makeScopedPaths,
  type PlanStatus,
  readPlanStatusFromPaths,
  resolvePlanPaths,
} from "./plan.js";

/** Read a directory's entries, returning [] on any error (missing dir, perms).
 * Wraps readdirSync({withFileTypes}) so callers get a typed Dirent[] without
 * fighting @types/node's overloaded return-type inference. */
function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared row type + attestation derivation
// ---------------------------------------------------------------------------

export type AttestationState = "none" | "locked" | "tampered";

export interface PlanRow {
  /** Plan dir basename, or "<root>" for the legacy root plan. */
  id: string;
  scope: "scoped" | "root";
  /** True when this is the plan resolvePlanPaths() would pick as active. */
  active: boolean;
  exists: boolean;
  totalPhases: number;
  completePhases: number;
  closed: boolean;
  hasParseableStatus: boolean;
  attestation: AttestationState;
  /** Dir (scoped) or file (root) mtime, for "last touched" sorting. 0 if unreadable. */
  mtimeMs: number;
  planPath?: string;
}

function deriveAttestation(status: PlanStatus): AttestationState {
  const check = checkPlanAttestation(status);
  if (!check.enabled) return "none";
  return check.tampered ? "tampered" : "locked";
}

function rowFromStatus(status: PlanStatus, active: boolean, mtimeMs: number): PlanRow {
  return {
    id: status.scope === "root" ? "<root>" : (status.planId ?? basename(status.planDir ?? "<root>")),
    scope: status.scope === "root" ? "root" : "scoped",
    active,
    exists: status.exists,
    totalPhases: status.totalPhases,
    completePhases: status.completePhases,
    closed: status.closed,
    hasParseableStatus: status.hasParseableStatus,
    attestation: deriveAttestation(status),
    mtimeMs,
    planPath: status.planPath,
  };
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — enumeratePlans + renderPlanList  (/plan-list)
// ---------------------------------------------------------------------------

/**
 * Enumerate EVERY plan under <cwd>/.planning/<dir>/ that has a task_plan.md, plus
 * the legacy root <cwd>/task_plan.md if it exists. Read-only — never mutates
 * .active_plan or any file. Returns rows sorted: active first, then by mtime
 * desc. An empty repo (no plans) returns []. NEVER throws: per-dir reads are
 * guarded, mirroring readPlanStatus's safeRead discipline.
 */
export function enumeratePlans(cwd: string): PlanRow[] {
  const activePaths = resolvePlanPaths(cwd);
  const activeKey = activePaths.planPath ?? "__none__";
  const rows: PlanRow[] = [];

  // Scoped plans under <cwd>/.planning/<dir>/ with a task_plan.md.
  const planRoot = join(cwd, ".planning");
  if (existsSync(planRoot)) {
    for (const entry of readDirEntries(planRoot)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const planDir = join(planRoot, entry.name);
      if (!existsSync(join(planDir, "task_plan.md"))) continue;
      try {
        const status = readPlanStatusFromPaths(makeScopedPaths(cwd, planDir));
        rows.push(rowFromStatus(status, status.planPath === activeKey, safeMtimeMs(planDir)));
      } catch {
        // A half-written / unreadable plan dir is skipped, not fatal.
      }
    }
  }

  // Legacy root plan.
  const rootPaths = makeRootPaths(cwd);
  if (rootPaths.planPath && existsSync(rootPaths.planPath)) {
    const status = readPlanStatusFromPaths(rootPaths);
    rows.push(rowFromStatus(status, status.planPath === activeKey, safeMtimeMs(rootPaths.planPath)));
  }

  // Sort: active first, then newest mtime first. Stable for equal mtimes.
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });
  return rows;
}

/**
 * Render PlanRow[] as a compact markdown table. Empty input → a one-line
 * "No plans found" message (NOT an empty table — /plan-list must always say
 * something useful).
 */
export function renderPlanList(rows: PlanRow[]): string {
  if (rows.length === 0) {
    return "[planning-with-files] No plans found. Create .planning/<slug>/task_plan.md or a root task_plan.md.";
  }

  const header = "| Plan | Status | Phases | Attestation | Active |";
  const divider = "|------|--------|--------|-------------|--------|";
  const body = rows.map((r) => {
    const statusCell = r.closed ? "closed" : r.hasParseableStatus ? "open" : "unparsed";
    const phasesCell = r.closed ? "—" : `${r.completePhases}/${r.totalPhases}`;
    const activeCell = r.active ? "✓" : "";
    return `| ${r.id} | ${statusCell} | ${phasesCell} | ${r.attestation} | ${activeCell} |`;
  });
  return [header, divider, ...body].join("\n");
}

// ---------------------------------------------------------------------------
// Phase 4 — lintPlan + lintAllPlans  (/plan-lint)
// ---------------------------------------------------------------------------

export type LintLevel = "info" | "warn" | "error";

export interface LintFinding {
  level: LintLevel;
  /** Machine-readable code, e.g. "NO_PHASE_HEADERS". */
  code: string;
  /** Human-readable, actionable message. */
  message: string;
}

export interface LintReport {
  planPath: string;
  findings: LintFinding[];
  /** True iff no error-level findings. */
  ok: boolean;
}

function report(planPath: string, findings: LintFinding[]): LintReport {
  return { planPath, findings, ok: !findings.some((f) => f.level === "error") };
}

/**
 * Diagnose a single plan (the active one by default). Reuses readPlanStatus +
 * checkPlanAttestation + existsSync checks on companion files. Pure — no side
 * effects. When the active plan doesn't exist, returns a single error finding.
 */
export function lintPlan(cwd: string): LintReport {
  const status = readPlanStatusFromPaths(resolvePlanPaths(cwd));
  const planPath = status.planPath ?? join(cwd, "task_plan.md");

  if (!status.exists) {
    return report(planPath, [{ level: "error", code: "NO_PLAN", message: `No task_plan.md found at ${planPath}` }]);
  }

  const findings: LintFinding[] = [];

  if (status.closed) {
    findings.push({
      level: "info",
      code: "CLOSED",
      message: "Plan is closed (via /plan done) — hooks are inert by design. Remove the close marker to reactivate.",
    });
  }

  if (status.totalPhases === 0) {
    findings.push({
      level: "warn",
      code: "NO_PHASE_HEADERS",
      message:
        "No `### Phase N` headers found — phase tracking cannot work. Add phase headers with `**Status:** complete|in_progress|pending`.",
    });
  } else if (!status.hasParseableStatus) {
    findings.push({
      level: "warn",
      code: "UNPARSEABLE_STATUS",
      message:
        "Phase headers present but no recognized status tokens. Use `**Status:** complete|in_progress|pending`, `[status]`, or emoji (✅/🔄/⏸). Auto-continue is disabled until parseable.",
    });
  }

  if (status.progressPath && !existsSync(status.progressPath)) {
    findings.push({
      level: "warn",
      code: "MISSING_PROGRESS",
      message:
        "progress.md missing — session logs have nowhere to land. Create it (see skills/.../templates/progress.md).",
    });
  }

  if (status.findingsPath && !existsSync(status.findingsPath)) {
    findings.push({
      level: "info",
      code: "MISSING_FINDINGS",
      message: "findings.md missing (optional, but recommended for research capture).",
    });
  }

  const attestation = checkPlanAttestation(status);
  if (attestation.enabled && attestation.tampered) {
    findings.push({
      level: "error",
      code: "TAMPERED",
      message:
        "Attestation hash mismatch — plan was edited after /plan attest. Run /plan attest to re-lock, or restore the file from git.",
    });
  } else if (!attestation.enabled) {
    findings.push({
      level: "info",
      code: "NOT_ATTESTED",
      message: "Plan not attested — run /plan attest to enable tamper detection.",
    });
  }

  // Healthy summary only when nothing actionable is wrong.
  const hasError = findings.some((f) => f.level === "error");
  const hasWarn = findings.some((f) => f.level === "warn");
  if (!hasError && !hasWarn && status.totalPhases > 0) {
    findings.push({
      level: "info",
      code: "HEALTHY",
      message: `Plan looks healthy: ${status.completePhases}/${status.totalPhases} phases, parseable status${
        attestation.enabled ? ", attested" : ""
      }.`,
    });
  }

  return report(planPath, findings);
}

/**
 * Lint every plan enumeratePlans() finds. Returns one LintReport per plan,
 * active-first. Pure.
 */
export function lintAllPlans(cwd: string): LintReport[] {
  return enumeratePlans(cwd)
    .filter((r) => r.exists && r.planPath)
    .map((r) => {
      // Re-read the specific plan (not the active resolver) so each report is
      // bound to its own plan dir.
      const paths = r.scope === "root" ? makeRootPaths(cwd) : makeScopedPaths(cwd, join(cwd, ".planning", r.id));
      const status = readPlanStatusFromPaths(paths);
      return reportForStatus(status);
    });
}

function reportForStatus(status: PlanStatus): LintReport {
  const planPath = status.planPath ?? "<unknown>";
  if (!status.exists) {
    return report(planPath, [{ level: "error", code: "NO_PLAN", message: `No task_plan.md at ${planPath}` }]);
  }
  // Reuse lintPlan's logic by constructing a fresh report from the resolved
  // status. We can't call lintPlan(cwd) per-dir (it resolves the ACTIVE plan),
  // so replicate the finding catalog here — kept in sync with lintPlan.
  const findings: LintFinding[] = [];
  if (status.closed) {
    findings.push({ level: "info", code: "CLOSED", message: "Plan is closed — hooks inert by design." });
  }
  if (status.totalPhases === 0) {
    findings.push({
      level: "warn",
      code: "NO_PHASE_HEADERS",
      message: "No `### Phase N` headers — phase tracking cannot work.",
    });
  } else if (!status.hasParseableStatus) {
    findings.push({
      level: "warn",
      code: "UNPARSEABLE_STATUS",
      message: "Phase headers present but no recognized status tokens. Auto-continue disabled.",
    });
  }
  if (status.progressPath && !existsSync(status.progressPath)) {
    findings.push({ level: "warn", code: "MISSING_PROGRESS", message: "progress.md missing." });
  }
  if (status.findingsPath && !existsSync(status.findingsPath)) {
    findings.push({ level: "info", code: "MISSING_FINDINGS", message: "findings.md missing (optional)." });
  }
  const attestation = checkPlanAttestation(status);
  if (attestation.enabled && attestation.tampered) {
    findings.push({
      level: "error",
      code: "TAMPERED",
      message: "Attestation hash mismatch — run /plan attest to re-lock.",
    });
  } else if (!attestation.enabled) {
    findings.push({ level: "info", code: "NOT_ATTESTED", message: "Not attested — run /plan attest." });
  }
  const hasError = findings.some((f) => f.level === "error");
  const hasWarn = findings.some((f) => f.level === "warn");
  if (!hasError && !hasWarn && status.totalPhases > 0) {
    findings.push({
      level: "info",
      code: "HEALTHY",
      message: `Healthy: ${status.completePhases}/${status.totalPhases} phases.`,
    });
  }
  return report(planPath, findings);
}

// ---------------------------------------------------------------------------
// Phase 5 — switchActivePlan  (/plan-switch)
// ---------------------------------------------------------------------------

export interface SwitchResult {
  ok: boolean;
  message: string;
  activePlanId?: string;
}

/**
 * Pin the active plan by writing <cwd>/.planning/.active_plan = id. Validates:
 *   1. target dir <cwd>/.planning/<id>/task_plan.md must exist → else error
 *   2. target must NOT be closed (close marker) → else warn + abort
 * Creates <cwd>/.planning/ if missing (mkdir -p). The ONLY side effect is
 * writing (or, for "root"/"", removing) .active_plan. Returns ok=false on any
 * validation failure (no partial write).
 *
 * Special: id === "root" or "" clears the pin so the resolver falls back to the
 * newest-dir / root-plan rules.
 */
export function switchActivePlan(cwd: string, id: string): SwitchResult {
  const planRoot = join(cwd, ".planning");
  const activeFile = join(planRoot, ".active_plan");
  const normalized = id.trim();

  // "root" / "" → clear the pin (resolver then uses newest-dir / root fallback).
  if (normalized === "" || normalized.toLowerCase() === "root") {
    try {
      rmSync(activeFile, { force: true });
    } catch {
      // best-effort; a missing file is the desired end state
    }
    return {
      ok: true,
      message: "Active plan pin cleared — resolver now uses newest .planning/<dir>/ or root task_plan.md.",
    };
  }

  const targetDir = join(planRoot, normalized);
  const targetPlan = join(targetDir, "task_plan.md");
  if (!existsSync(targetPlan)) {
    return {
      ok: false,
      message: `No plan at .planning/${normalized}/task_plan.md — run /plan list to see available plans.`,
    };
  }

  // Closed target: refuse — switching to an inert plan would confuse the user.
  let raw = "";
  try {
    raw = readFileSync(targetPlan, "utf-8");
  } catch {
    raw = "";
  }
  if (isCloseMarker(raw)) {
    return {
      ok: false,
      message: `Plan "${normalized}" is closed. Reopen it (delete the \`<!-- pwf: closed -->\` marker from its task_plan.md) before switching to it.`,
    };
  }

  try {
    mkdirSync(planRoot, { recursive: true });
    writeFileSync(activeFile, `${normalized}\n`, "utf-8");
  } catch (err) {
    return { ok: false, message: `Could not write .active_plan: ${String(err)}` };
  }
  return {
    ok: true,
    activePlanId: normalized,
    message: `Active plan switched to "${normalized}". Planning-with-files hooks now target .planning/${normalized}/.`,
  };
}
