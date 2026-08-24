import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  ROLE_AWARE_DISPATCH_BOUNDS,
  roleAwareDefaults,
  TIERED_TOKEN_BUDGET_DEFAULTS,
  tierDefaultToken,
} from "../src/budget-defaults.js";
import type { ModelTierConfig } from "../src/model-tier-config.js";
import { roleAwareDirectCall } from "../src/role-dispatch.js";

const ENV_KNOBS = [
  "SUBAGENT_TOKEN_BUDGET_DISABLE",
  "SUBAGENT_TOKEN_BUDGET_SMALL",
  "SUBAGENT_TOKEN_BUDGET_MEDIUM",
  "SUBAGENT_TOKEN_BUDGET_BIG",
  "SUBAGENT_TOKEN_BUDGET_MULTIPLIER",
  "SUBAGENT_TIME_BUDGET_DISABLE",
  "SUBAGENT_TIME_BUDGET_RECON",
  "SUBAGENT_TIME_BUDGET_WRITER",
  "SUBAGENT_TIME_BUDGET_MULTIPLIER",
  "SUBAGENT_MAX_TURNS",
  "PI_SUBAGENT_HINTS_FILE",
] as const;

// Save/restore every knob so tests are hermetic against the ambient env.
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KNOBS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Hermetic vs a real ~/.pi/subagents/hints.md on the host: the env-hints
  // footer's switch is FILE PRESENCE, so point its override at a path that
  // never exists (raw-task assertions stay byte-comparable).
  process.env.PI_SUBAGENT_HINTS_FILE = "/nonexistent/pi-subagent-hints-absent.fixture.md";
});
afterEach(() => {
  for (const k of ENV_KNOBS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const CFG: ModelTierConfig = {
  tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.2", big: "zai/glm-5.2-thinking" },
};

test("TIERED_TOKEN_BUDGET_DEFAULTS: p90-calibrated ceilings", () => {
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.small, 500_000);
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.medium, 1_200_000);
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.big, 1_500_000);
});

test("tierDefaultToken: explicit tier → that tier's ceiling", () => {
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  assert.equal(tierDefaultToken("medium", undefined, CFG), 1_200_000);
  assert.equal(tierDefaultToken("big", undefined, CFG), 1_500_000);
  // tier wins over model when both are given
  assert.equal(tierDefaultToken("small", "zai/glm-5.2", CFG), 500_000);
});

test("tierDefaultToken: unset tier → reverse-map model→tier via config", () => {
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7", CFG), 500_000); // glm-4.7 → small
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2", CFG), 1_200_000); // glm-5.2 → medium
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2-thinking", CFG), 1_500_000); // → big
  // strip a :thinking suffix before matching
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7:thinking", CFG), 500_000);
});

test("tierDefaultToken: unknown model + unset tier → medium ceiling (safe fallback)", () => {
  assert.equal(tierDefaultToken(undefined, "deepseek/unknown-model", CFG), 1_200_000);
});

test("tierDefaultToken: no config at all → medium ceiling (safe fallback)", () => {
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7", null), 1_200_000);
  assert.equal(tierDefaultToken(undefined, undefined, null), 1_200_000);
});

test("tierDefaultToken: unknown tier name → medium ceiling", () => {
  assert.equal(tierDefaultToken("humongous", undefined, CFG), 1_200_000);
});

test("env knobs: per-tier absolute override replaces the resolved tier's ceiling", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "700000";
  assert.equal(tierDefaultToken("small", undefined, CFG), 700_000);
  // override applies to the RESOLVED tier — here medium via model mapping
  process.env.SUBAGENT_TOKEN_BUDGET_MEDIUM = "999999";
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2", CFG), 999_999);
  // other tiers unaffected
  assert.equal(tierDefaultToken("big", undefined, CFG), 1_500_000);
});

test("env knobs: multiplier scales the table default", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "2";
  assert.equal(tierDefaultToken("small", undefined, CFG), 1_000_000);
  assert.equal(tierDefaultToken("medium", undefined, CFG), 2_400_000);
});

test("env knobs: multiplier applies AFTER the absolute override", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "300000";
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "1.5";
  assert.equal(tierDefaultToken("small", undefined, CFG), 450_000);
});

test("env knobs: multiplier floors fractional results (clamp)", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "1.000001";
  // 500_000 * 1.000001 = 500_000.5 → floor → 500_000
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
});

test(`env knobs: DISABLE="1" or "true" (case-insensitive) → undefined (no budget)`, () => {
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
  assert.equal(tierDefaultToken("small", undefined, CFG), undefined);
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "true";
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2", CFG), undefined);
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "TRUE";
  assert.equal(tierDefaultToken("big", undefined, CFG), undefined);
  // disable wins over overrides/multiplier too
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "700000";
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "2";
  assert.equal(tierDefaultToken("small", undefined, CFG), undefined);
});

test("env knobs: invalid per-tier values are silently ignored", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "abc";
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "0"; // not positive
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "-2";
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "1.5"; // not an integer
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
});

test("env knobs: invalid multiplier values are silently ignored", () => {
  for (const bad of ["abc", "0", "-2", ""]) {
    process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = bad;
    assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  }
});

test("env knobs: disable flag with an invalid value is ignored (still budgeted)", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "yes";
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
});

// ── #03 role-aware dispatch bounds (2026-08-15 hardening) ──

test("ROLE_AWARE_DISPATCH_BOUNDS: recon 120k/12/5min, writer 400k/28/20min", () => {
  assert.deepEqual(ROLE_AWARE_DISPATCH_BOUNDS.recon, { tokenBudget: 120_000, maxTurns: 12, timeoutMs: 300_000 });
  assert.deepEqual(ROLE_AWARE_DISPATCH_BOUNDS.writer, { tokenBudget: 400_000, maxTurns: 28, timeoutMs: 1_200_000 });
});

test("roleAwareDefaults: all-omitted recon → full envelope + notice", () => {
  const d = roleAwareDefaults({}, "recon");
  assert.equal(d.applied, true);
  assert.equal(d.tokenBudget, 120_000);
  assert.equal(d.maxTurns, 12);
  assert.equal(d.timeoutMs, 300_000);
  assert.match(d.notice ?? "", /defaults applied \(recon\)/);
});

test("roleAwareDefaults: all-omitted writer → full envelope + notice", () => {
  const d = roleAwareDefaults({}, "writer");
  assert.equal(d.applied, true);
  assert.deepEqual(
    { tokenBudget: d.tokenBudget, maxTurns: d.maxTurns, timeoutMs: d.timeoutMs },
    { tokenBudget: 400_000, maxTurns: 28, timeoutMs: 1_200_000 },
  );
  assert.match(d.notice ?? "", /defaults applied \(writer\)/);
});

test("roleAwareDefaults: ANY explicit bound (some- or all-passed) opts the whole envelope out", () => {
  assert.equal(roleAwareDefaults({ tokenBudget: 5 }, "recon").applied, false);
  assert.equal(roleAwareDefaults({ maxTurns: 3 }, "recon").applied, false);
  assert.equal(roleAwareDefaults({ timeoutMs: 1_000 }, "recon").applied, false);
  const all = roleAwareDefaults({ tokenBudget: 5, maxTurns: 3, timeoutMs: 1_000 }, "writer");
  assert.equal(all.applied, false);
  assert.equal(all.tokenBudget, undefined);
  assert.equal(all.maxTurns, undefined);
  assert.equal(all.timeoutMs, undefined);
});

test("roleAwareDefaults: SUBAGENT_TOKEN_BUDGET_DISABLE=1 escapes entirely", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
  assert.equal(roleAwareDefaults({}, "recon").applied, false);
  assert.equal(roleAwareDefaults({}, "writer").applied, false);
});

test("roleAwareDefaults: recon ceiling is min(120k, tierCeiling); writer ignores it", () => {
  assert.equal(roleAwareDefaults({}, "recon", 40_000).tokenBudget, 40_000);
  assert.equal(roleAwareDefaults({}, "recon", 2_000_000).tokenBudget, 120_000);
  assert.equal(roleAwareDefaults({}, "writer", 40_000).tokenBudget, 400_000);
});

test("roleAwareDirectCall: recon → 120k/12 caps + abort-safety footer with run log", () => {
  const r = roleAwareDirectCall("recon", "T", "id-x");
  assert.ok(r.task.startsWith("T"), "original task stays the prefix");
  assert.ok(r.task.includes("--- abort-safety"), "footer marker travels with the caps");
  assert.ok(r.task.includes("/tmp/subagent-runs/id-x.md"), "footer cites the run-scoped log");
  assert.equal(r.tokenBudget, 120_000);
  assert.equal(r.maxTurns, 12);
  assert.equal(r.timeoutMs, 300_000);
});

test("roleAwareDirectCall: writer → 400k/28 caps + footer (maxTurns>10 gate)", () => {
  const r = roleAwareDirectCall("writer", "T", "id-w");
  assert.ok(r.task.includes("--- abort-safety"));
  assert.ok(r.task.includes("/tmp/subagent-runs/id-w.md"));
  assert.equal(r.tokenBudget, 400_000);
  assert.equal(r.maxTurns, 28);
  assert.equal(r.timeoutMs, 1_200_000);
});

test("roleAwareDirectCall: SUBAGENT_TOKEN_BUDGET_DISABLE=1 → plain task, no caps, no footer", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1"; // restored by the ENV_KNOBS afterEach
  const r1 = roleAwareDirectCall("recon", "T", "id-x");
  const r2 = roleAwareDirectCall("writer", "T", "id-x");
  assert.deepEqual(r1, { task: "T" });
  assert.deepEqual(r2, { task: "T" });
  assert.equal(r1.timeoutMs, undefined);
  assert.equal(r2.timeoutMs, undefined);
});

test("roleAwareDefaults: SUBAGENT_MAX_TURNS replaces the role turn cap", () => {
  process.env.SUBAGENT_MAX_TURNS = "9";
  const d = roleAwareDefaults({}, "recon");
  assert.equal(d.applied, true);
  assert.equal(d.maxTurns, 9);
});

test("roleAwareDefaults: unset env keeps ledger-calibrated caps", () => {
  const d = roleAwareDefaults({}, "writer");
  assert.equal(d.maxTurns, ROLE_AWARE_DISPATCH_BOUNDS.writer.maxTurns);
});

test("roleAwareDefaults: explicit params opt out regardless of env", () => {
  process.env.SUBAGENT_MAX_TURNS = "9";
  const d = roleAwareDefaults({ maxTurns: 4 }, "recon");
  assert.equal(d.applied, false);
  assert.equal(d.maxTurns, undefined);
});

// ── time-budget env knobs (dynamic-budgets ticket 02) ──

test("time env knobs: per-role absolute override replaces that role's wall only", () => {
  process.env.SUBAGENT_TIME_BUDGET_RECON = "600000";
  const recon = roleAwareDefaults({}, "recon");
  assert.equal(recon.timeoutMs, 600_000);
  assert.equal(roleAwareDefaults({}, "writer").timeoutMs, 1_200_000, "writer wall untouched");
  process.env.SUBAGENT_TIME_BUDGET_WRITER = "180000";
  assert.equal(roleAwareDefaults({}, "writer").timeoutMs, 180_000);
  assert.equal(recon.tokenBudget, 120_000, "token cap untouched by the time family");
  assert.equal(recon.maxTurns, 12, "turn cap untouched by the time family");
});

test("time env knobs: multiplier scales the role wall (after any override)", () => {
  process.env.SUBAGENT_TIME_BUDGET_MULTIPLIER = "2";
  assert.equal(roleAwareDefaults({}, "recon").timeoutMs, 600_000);
  assert.equal(roleAwareDefaults({}, "writer").timeoutMs, 2_400_000);
  process.env.SUBAGENT_TIME_BUDGET_RECON = "450000";
  assert.equal(roleAwareDefaults({}, "recon").timeoutMs, 900_000, "override first, then multiply");
});

test("time env knobs: multiplier floors fractional results (clamp to ≥1ms)", () => {
  process.env.SUBAGENT_TIME_BUDGET_MULTIPLIER = "1.000001";
  // 300_000 * 1.000001 = 300_000.3 → floor → 300_000
  assert.equal(roleAwareDefaults({}, "recon").timeoutMs, 300_000);
  process.env.SUBAGENT_TIME_BUDGET_MULTIPLIER = "0.000001";
  assert.equal(roleAwareDefaults({}, "recon").timeoutMs, 1, "clamps at 1ms, never 0");
});

test(`time env knobs: DISABLE="1"/"true" strips ONLY the wall — token/turn caps + applied stay`, () => {
  process.env.SUBAGENT_TIME_BUDGET_DISABLE = "1";
  const d = roleAwareDefaults({}, "recon");
  assert.equal(d.applied, true, "envelope still applied (time-only strip)");
  assert.equal(d.timeoutMs, undefined);
  assert.equal(d.tokenBudget, 120_000);
  assert.equal(d.maxTurns, 12);
  process.env.SUBAGENT_TIME_BUDGET_DISABLE = "true";
  assert.equal(roleAwareDefaults({}, "writer").timeoutMs, undefined);
  assert.equal(roleAwareDefaults({}, "writer").tokenBudget, 400_000);
  // disable wins over overrides/multiplier too (token-family precedence)
  process.env.SUBAGENT_TIME_BUDGET_RECON = "600000";
  process.env.SUBAGENT_TIME_BUDGET_MULTIPLIER = "2";
  assert.equal(roleAwareDefaults({}, "recon").timeoutMs, undefined);
});

test("time env knobs: TIME disable is NOT the whole-envelope disable (token disable still strips all)", () => {
  process.env.SUBAGENT_TIME_BUDGET_DISABLE = "1";
  const timeOnly = roleAwareDefaults({}, "recon");
  assert.equal(timeOnly.applied, true);
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
  assert.equal(roleAwareDefaults({}, "recon").applied, false, "token disable still strips everything");
});

test("time env knobs: invalid values are silently ignored", () => {
  for (const bad of ["abc", "0", "-2", "1.5", ""]) {
    process.env.SUBAGENT_TIME_BUDGET_RECON = bad;
    assert.equal(roleAwareDefaults({}, "recon").timeoutMs, 300_000);
  }
  for (const bad of ["abc", "0", "-2", ""]) {
    process.env.SUBAGENT_TIME_BUDGET_MULTIPLIER = bad;
    assert.equal(roleAwareDefaults({}, "recon").timeoutMs, 300_000);
  }
  process.env.SUBAGENT_TIME_BUDGET_DISABLE = "yes";
  assert.equal(roleAwareDefaults({}, "recon").timeoutMs, 300_000);
});

test("time env knobs: explicit params still opt the whole envelope out regardless of env", () => {
  process.env.SUBAGENT_TIME_BUDGET_RECON = "600000";
  const d = roleAwareDefaults({ timeoutMs: 1_000 }, "recon");
  assert.equal(d.applied, false);
  assert.equal(d.timeoutMs, undefined);
  assert.equal(roleAwareDefaults({ maxTurns: 3 }, "recon").applied, false);
});

test("time env knobs: persistent dispatches stay inert (no time default by design)", () => {
  process.env.SUBAGENT_TIME_BUDGET_RECON = "600000";
  const d = roleAwareDefaults({}, "recon", 1_200_000, { persistent: true });
  assert.equal(d.timeoutMs, undefined, "live-agent lifetime default applies no turn/timeout cap");
});

test("roleAwareDirectCall: the env-shaped wall travels to the direct-call seam", () => {
  process.env.SUBAGENT_TIME_BUDGET_RECON = "600000";
  const r = roleAwareDirectCall("recon", "T", "id-t");
  assert.equal(r.timeoutMs, 600_000);
  assert.equal(r.budgetCohort?.timeoutMs, 600_000, "cohort tag carries the env-shaped wall");
  process.env.SUBAGENT_TIME_BUDGET_DISABLE = "1";
  const stripped = roleAwareDirectCall("writer", "T", "id-t");
  assert.equal(stripped.timeoutMs, undefined);
  assert.equal(stripped.tokenBudget, 400_000, "direct-call token cap survives the time-only strip");
});

// cc-parity-2 ticket 05 / F2 — persistent (named live-agent) dispatches: the
// per-dispatch role envelope is NOT a lifetime calibration, so the lifetime
// token default becomes the tier ceiling and no turn/timeout default applies.
test("roleAwareDefaults persistent: tier ceiling replaces the role envelope, no turn/timeout caps", () => {
  const d = roleAwareDefaults({}, "recon", 1_200_000, { persistent: true });
  assert.equal(d.applied, true);
  assert.equal(d.tokenBudget, 1_200_000, "lifetime token default = tier ceiling (not recon 120k)");
  assert.equal(d.maxTurns, undefined, "no default lifetime turn cap");
  assert.equal(d.timeoutMs, undefined, "no default lifetime timeout");
  assert.match(d.notice ?? "", /live-agent lifetime/);
});

test("roleAwareDefaults persistent: role is irrelevant (writer too) and undefined ceiling stays unset", () => {
  const writer = roleAwareDefaults({}, "writer", 500_000, { persistent: true });
  assert.equal(writer.tokenBudget, 500_000, "writer tier ceiling, not the 400k envelope");
  const noCeiling = roleAwareDefaults({}, "recon", undefined, { persistent: true });
  assert.equal(noCeiling.applied, true);
  assert.equal(noCeiling.tokenBudget, undefined, "no tier ceiling resolvable → no token default");
});

test("roleAwareDefaults persistent: explicit bounds and the disable knob still win", () => {
  assert.equal(roleAwareDefaults({ tokenBudget: 5 }, "recon", 1_200_000, { persistent: true }).applied, false);
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
  assert.equal(roleAwareDefaults({}, "recon", 1_200_000, { persistent: true }).applied, false);
});
