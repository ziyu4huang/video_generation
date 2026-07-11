/**
 * Coordination E2E — Plan A goal ⇄ planning-with-files globalThis bridge.
 *
 * Tests the ONE thing unit tests cannot: that when BOTH extensions are loaded
 * by pi's REAL loader (jiti, via `-e`) in the same process, each factory
 * publishes its globalThis seam AND the published functions are the LIVE
 * singleton-bound readers (not stale copies from a divergent module instance).
 *
 * A throwaway probe extension (coord-probe.ts) is loaded THIRD; its
 * session_start handler (which fires after both peers' factories have run at
 * load time) inspects globalThis and dumps a JSON line to stderr. The test
 * parses that line — fully deterministic, independent of the model response.
 *
 * Gated on RUN_E2E=1 + a reachable provider, like the sibling e2e suite.
 *   RUN_E2E=1 bun test tests/e2e/coordination.test.ts
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.RUN_E2E === "1";

function detectProvider(): { provider: string; model: string } | null {
  if (process.env.PI_E2E_PROVIDER && process.env.PI_E2E_MODEL) {
    return { provider: process.env.PI_E2E_PROVIDER, model: process.env.PI_E2E_MODEL };
  }
  const lm = spawnSync("curl", ["-sS", "-m", "2", "http://127.0.0.1:1234/v1/models"], { encoding: "utf-8" });
  if (lm.status === 0 && /gemma/i.test(lm.stdout)) {
    return { provider: "lm-studio", model: "google/gemma-4-26b-a4b-qat" };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return { provider: "deepseek", model: "deepseek-v4-flash" };
  }
  return null;
}

const PROVIDER = ENABLED ? detectProvider() : null;

const PKG_ROOT = join(import.meta.dir, "..", "..");
const PI_BIN = join(PKG_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const PWF_EXT = join(PKG_ROOT, "extensions", "index.ts");
// power-tool lives one level up in the monorepo.
const POWER_TOOL_EXT = join(PKG_ROOT, "..", "pi-agent-ext-power-tool", "src", "index.ts");
const PROBE = join(import.meta.dir, "coord-probe.ts");

const tempRoots: string[] = [];

function makeProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pwf-coord-e2e-"));
  tempRoots.push(cwd);
  return cwd;
}

function writePartialPlan(cwd: string): void {
  const dir = join(cwd, ".planning", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "task_plan.md"),
    ["# Plan", "### Phase 1", "**Status:** complete", "### Phase 2", "**Status:** in_progress"].join("\n"),
  );
}

/**
 * Write a minimal session JSONL whose `goal-state` custom entry restores an
 * ACTIVE goal via power-tool's loadGoalFromSession at session_start — the
 * deterministic way to seed an active goal in a `-p` run (the /goal command is
 * interactive). tokenBudget=1 bounds the run: the planning-gate rejection
 * happens during turn 1 (before agent_end), then the budget check at agent_end
 * transitions the goal to budget_limited and stops the auto-continue loop.
 */
function writeGoalSeedSession(cwd: string): string {
  const seedPath = join(cwd, "seed-session.jsonl");
  const goal = {
    id: "g-seed-1",
    text: "E2E goal_complete gate test",
    status: "active",
    startedAt: 1_752_192_000_000,
    updatedAt: 1_752_192_000_000,
    iteration: 0,
    tokenBudget: 1,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
  };
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "seed1", timestamp: "2026-07-11T00:00:00.000Z", cwd }),
    JSON.stringify({
      type: "custom",
      customType: "goal-state",
      data: { goal },
      id: "g1",
      parentId: "seed1",
      timestamp: "2026-07-11T00:00:01.000Z",
    }),
  ];
  writeFileSync(seedPath, `${lines.join("\n")}\n`);
  return seedPath;
}

interface ProbeResult {
  marker: string;
  goalType: string;
  planType: string;
  goalResult: boolean | null;
  planResult: boolean | null;
}

function parseProbe(stderr: string): ProbeResult | null {
  const m = stderr.match(/COORD-PROBE-RESULT (\{.*\})/);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as ProbeResult;
  } catch {
    return null;
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!PROVIDER)("coordination e2e: globalThis bridge across two jiti-loaded extensions", () => {
  it("both peers publish live globalThis seams; goal reads false, plan reads true (open phases)", () => {
    const provider = PROVIDER as { provider: string; model: string };
    const cwd = makeProject();
    writePartialPlan(cwd);

    // Load order matters: power-tool + planning-with-files first (they publish
    // their globals at factory time), probe last (reads them at session_start).
    const args = [
      PI_BIN,
      "-e",
      POWER_TOOL_EXT,
      "-e",
      PWF_EXT,
      "-e",
      PROBE,
      "--provider",
      provider.provider,
      "--model",
      provider.model,
      "--no-session",
      "--no-tools",
      "--thinking",
      "off",
      "--mode",
      "json",
      "-p",
      "Say OK.",
    ];
    const r = spawnSync("bun", args, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, PWF_AUTO_APPROVE: "1" },
      timeout: 120_000,
    });

    const probe = parseProbe(r.stderr);
    // Diagnostic on failure: show stderr tail so the next run is debuggable.
    if (!probe) {
      console.error("probe not found; stderr tail:", r.stderr.slice(-800));
    }
    expect(probe).not.toBeNull();
    const result = probe as ProbeResult;

    // power-tool published __piGoalActive (factory ran under jiti).
    expect(result.goalType).toBe("function");
    // planning-with-files published __piPlanIncomplete (factory ran under jiti).
    expect(result.planType).toBe("function");

    // The published functions are LIVE readers of the real singleton state,
    // not stale copies — the core jiti<->native identity risk. No goal was
    // started → __piGoalActive() must be false.
    expect(result.goalResult).toBe(false);
    // The probe's cwd has a partial plan on disk → __piPlanIncomplete(cwd)
    // must be true. This proves the full bridge: power-tool side calls the
    // planning-published function, which reads real disk state, correctly.
    expect(result.planResult).toBe(true);
  }, 180_000);

  it("goal_complete is blocked while a plan has open phases (seeded active goal + partial plan)", () => {
    // Manually verified: with a seeded active goal (budget=1) + an open plan,
    // the model calls goal_complete → the planning gate rejects it with
    // 'incomplete phases' + a pointer to /plan-done. Retried because gemma
    // occasionally doesn't call the tool on the first attempt.
    const provider = PROVIDER as { provider: string; model: string };
    let lastStream = "";
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const cwd = makeProject();
      writePartialPlan(cwd);
      const seed = writeGoalSeedSession(cwd);
      const args = [
        PI_BIN,
        "-e",
        POWER_TOOL_EXT,
        "-e",
        PWF_EXT,
        "--provider",
        provider.provider,
        "--model",
        provider.model,
        "--session",
        seed,
        "-t",
        "goal_complete",
        "--thinking",
        "off",
        "--mode",
        "json",
        "-p",
        "Call the goal_complete tool now with summary: All work is done and verified.",
      ];
      const r = spawnSync("bun", args, {
        cwd,
        encoding: "utf-8",
        env: { ...process.env },
        timeout: 120_000,
      });
      lastStream = `${r.stdout}\n${r.stderr}`;
      if (lastStream.includes("incomplete phases") && lastStream.includes("/plan-done")) {
        ok = true;
      }
    }
    if (!ok) {
      console.error("goal_complete gate not triggered; stream tail:", lastStream.slice(-1000));
    }
    expect(ok).toBe(true);
    // The rejection text is specific to the planning gate (not 'no active goal'
    // or 'contradictory summary') — its presence proves the full path:
    // goal_complete → planningGateBlocking → __piPlanIncomplete → block.
    expect(lastStream).toContain("incomplete phases");
    expect(lastStream).toContain("/plan-done");
  }, 300_000);
});
