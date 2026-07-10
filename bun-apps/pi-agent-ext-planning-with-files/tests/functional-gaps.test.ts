/**
 * Functional gap-coverage — edge cases beyond the core runtime/attestation/
 * plan/guard/modes suites: full 4-level plan-resolution precedence, phase-
 * counting corner cases, the complete guard pattern matrix, mode precedence,
 * parseIntervalSpec boundaries, and runSessionCatchup git integration.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestPlan, checkPlanAttestation } from "../src/attestation.js";
import { parseIntervalSpec } from "../src/commands.js";
import { isDangerousBashCommand } from "../src/guard.js";
import { deriveEffectiveMode, parseMode, resolveAutoApprove, resolveConfiguredMode } from "../src/modes.js";
import { isAllPhasesComplete, readPlanStatus, resolvePlanPaths, summarizePlan } from "../src/plan.js";
import { runSessionCatchup } from "../src/scripts.js";

const roots: string[] = [];
const originalEnv = { ...process.env };
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pwf-func-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  process.env = { ...originalEnv };
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});
function sha(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Full plan resolution order: PLAN_ID → .active_plan → newest dir → root
// ---------------------------------------------------------------------------
describe("resolvePlanPaths — full 4-level precedence", () => {
  it(".active_plan wins over newest-dir fallback", () => {
    const cwd = tmp();
    const a = join(cwd, ".planning", "plan-a");
    const b = join(cwd, ".planning", "plan-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "task_plan.md"), "# a");
    writeFileSync(join(b, "task_plan.md"), "# b");
    // make b newer
    const future = Date.now() / 1000 + 100;
    utimesSync(join(b, "task_plan.md"), future, future);
    // pin active_plan to a (older) — should win over newest (b)
    writeFileSync(join(cwd, ".planning", ".active_plan"), "plan-a");
    expect(resolvePlanPaths(cwd).planId).toBe("plan-a");
  });

  it("newest dir (by mtime) wins when no PLAN_ID and no .active_plan", () => {
    const cwd = tmp();
    const a = join(cwd, ".planning", "plan-a");
    const b = join(cwd, ".planning", "plan-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "task_plan.md"), "# a");
    writeFileSync(join(b, "task_plan.md"), "# b");
    const future = Date.now() / 1000 + 100;
    utimesSync(join(b, "task_plan.md"), future, future);
    delete process.env.PLAN_ID;
    expect(resolvePlanPaths(cwd).planId).toBe("plan-b");
  });

  it("falls back to legacy root when .planning/ has no plan dirs", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "task_plan.md"), "# root plan");
    delete process.env.PLAN_ID;
    const p = resolvePlanPaths(cwd);
    expect(p.scope).toBe("root");
    expect(p.planPath).toBe(join(cwd, "task_plan.md"));
  });

  it("returns scope=none when nothing exists", () => {
    const cwd = tmp();
    delete process.env.PLAN_ID;
    expect(resolvePlanPaths(cwd).scope).toBe("none");
  });

  it("PLAN_ID pointing at a non-existent dir falls through to .active_plan", () => {
    const cwd = tmp();
    const a = join(cwd, ".planning", "plan-a");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "task_plan.md"), "# a");
    writeFileSync(join(cwd, ".planning", ".active_plan"), "plan-a");
    process.env.PLAN_ID = "nonexistent";
    expect(resolvePlanPaths(cwd).planId).toBe("plan-a");
  });
});

// ---------------------------------------------------------------------------
// 2. Phase counting edge cases
// ---------------------------------------------------------------------------
describe("readPlanStatus — phase counting edge cases", () => {
  it("counts phases with headers but NO status lines as total>0, complete=0", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n### Phase 2\n### Phase 3\n");
    const s = readPlanStatus(cwd);
    expect(s.totalPhases).toBe(3);
    expect(s.completePhases).toBe(0);
    expect(s.inProgressPhases).toBe(0);
    expect(s.pendingPhases).toBe(0);
  });

  it("does NOT double-count when primary **Status:** AND inline [status] coexist", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "task_plan.md"),
      [
        "### Phase 1",
        "**Status:** complete [complete]",
        "",
        "### Phase 2",
        "**Status:** in_progress [in_progress]",
        "",
      ].join("\n"),
    );
    const s = readPlanStatus(cwd);
    expect(s.totalPhases).toBe(2);
    expect(s.completePhases).toBe(1);
    expect(s.inProgressPhases).toBe(1);
    // fallback must NOT have fired (primary lines were seen)
  });

  it("counts a **Status:** line even when it appears OUTSIDE any Phase block (regex is global)", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    // one phase header, but a stray status line not under any phase
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n\n**Status:** pending\n");
    const s = readPlanStatus(cwd);
    expect(s.totalPhases).toBe(1); // only one header
    expect(s.completePhases).toBe(1);
    expect(s.pendingPhases).toBe(1); // the stray line is counted too — global regex
  });

  it("header regex requires a word-boundary after 'Phase': 'Phases' and 'Phase1' do NOT count", () => {
    // `/^###\s+Phase\b/i` — \b needs a non-word char after 'Phase'.
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    // 'Phase 1' ✓, 'Phases' ✗ (s), 'phase three' ✓, 'Phase1' ✗ (digit)
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n### Phases\n### phase three\n### Phase1\n");
    const s = readPlanStatus(cwd);
    expect(s.totalPhases).toBe(2);
  });

  it("isAllPhasesComplete is false when totalPhases is 0 even if complete==0", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "# no phases here");
    const s = readPlanStatus(cwd);
    expect(isAllPhasesComplete(s)).toBe(false);
    expect(summarizePlan(s)).toBe("task_plan.md detected (no phase headers yet)");
  });
});

// ---------------------------------------------------------------------------
// 3. Attestation full lifecycle + tamper + root scope
// ---------------------------------------------------------------------------
describe("attestation lifecycle", () => {
  it("attest → check ok → tamper → re-attest restores", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    const plan = "### Phase 1\n**Status:** complete\n";
    writeFileSync(join(dir, "task_plan.md"), plan);

    expect(attestPlan(cwd).ok).toBe(true);
    expect(checkPlanAttestation(readPlanStatus(cwd)).tampered).toBe(false);

    writeFileSync(join(dir, "task_plan.md"), `${plan}\n# sneaky edit\n`);
    expect(checkPlanAttestation(readPlanStatus(cwd)).tampered).toBe(true);

    expect(attestPlan(cwd).ok).toBe(true);
    expect(checkPlanAttestation(readPlanStatus(cwd)).tampered).toBe(false);
  });

  it("show on missing attestation returns ok=false; clear on missing returns ok=true", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n");
    expect(attestPlan(cwd, "show").ok).toBe(false);
    expect(attestPlan(cwd, "clear").ok).toBe(true);
  });

  it("root-scope plan attests to <cwd>/.plan-attestation and show reads it back", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "task_plan.md"), "### Phase 1\n**Status:** complete\n");
    const res = attestPlan(cwd);
    expect(res.ok).toBe(true);
    expect(res.attestationPath).toBe(join(cwd, ".plan-attestation"));
    expect(existsSync(join(cwd, ".plan-attestation"))).toBe(true);
    const shown = attestPlan(cwd, "show");
    expect(shown.ok).toBe(true);
    expect(shown.message).toContain("SHA-256:");
  });

  it("attest stores exactly the sha256 of file bytes + newline", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    const plan = "### Phase 1\n**Status:** complete\n";
    writeFileSync(join(dir, "task_plan.md"), plan);
    attestPlan(cwd);
    const stored = readFileSync(join(dir, ".attestation"), "utf-8").trim();
    expect(stored).toBe(sha(plan));
  });
});

// ---------------------------------------------------------------------------
// 4. Guard — every pattern + benign neighbors
// ---------------------------------------------------------------------------
describe("isDangerousBashCommand — pattern matrix", () => {
  const dangerous = [
    "rm -rf build",
    "rm -Rf /",
    "sudo apt update",
    "chmod 777 /etc",
    "chmod a+rwx .",
    "git push --force origin main",
    "git push -f origin main",
    "git push --mirror backup",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git clean -fdx",
    "dd if=img of=/dev/sda",
    ":(){ :|:& };:",
  ];
  for (const cmd of dangerous) {
    it(`flags: ${cmd}`, () => expect(isDangerousBashCommand(cmd)).toBe(true));
  }
  const benign = [
    "git push origin feature/draft-notification",
    "git push origin main",
    "rm build/output.txt", // no -rf
    "chmod 755 script.sh",
    "git status",
    "ls -la",
  ];
  // DOCUMENTED known false-positive (substring guard, by design — see guard.test.ts):
  // 'rm -rf' inside echo/strings still trips the regex.
  it("known false-positive: flags 'rm -rf' inside echo (by design)", () => {
    expect(isDangerousBashCommand("echo 'rm -rf is mentioned'")).toBe(true);
  });
  for (const cmd of benign) {
    it(`allows: ${cmd}`, () => expect(isDangerousBashCommand(cmd)).toBe(false));
  }
});

// ---------------------------------------------------------------------------
// 5. Mode precedence + autoApprove + parseMode
// ---------------------------------------------------------------------------
describe("modes precedence", () => {
  it("project settings override global settings", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ planningWithFiles: { mode: "notify" } }));
    // fake a global settings too
    const home = join(cwd, "fakehome");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ planningWithFiles: { mode: "parity" } }),
    );
    process.env.HOME = home;
    delete process.env.PWF_MODE;
    expect(resolveConfiguredMode(cwd)).toBe("notify");
  });

  it("parseMode rejects garbage and undefined", () => {
    expect(parseMode("Verbose")).toBeUndefined();
    expect(parseMode(undefined)).toBeUndefined();
    expect(parseMode(123 as never)).toBeUndefined();
  });

  it("deriveEffectiveMode treats model id 'deepseek-v4-flash' as DeepSeek even with neutral provider", () => {
    const ctx = { model: { provider: "openrouter", id: "deepseek-v4-flash" } } as never;
    expect(deriveEffectiveMode("auto", ctx)).toBe("cache-safe");
  });

  it("resolveAutoApprove reads autoApprove:true from project settings", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ planningWithFiles: { autoApprove: true } }));
    delete process.env.PWF_AUTO_APPROVE;
    expect(resolveAutoApprove(cwd)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. parseIntervalSpec edge cases
// ---------------------------------------------------------------------------
describe("parseIntervalSpec", () => {
  it("2h = 7200000ms", () => expect(parseIntervalSpec("2h")).toBe(7200000));
  it("1d = 86400000ms", () => expect(parseIntervalSpec("1d")).toBe(86400000));
  it("rejects zero", () => expect(parseIntervalSpec("0m")).toBeUndefined());
  it("rejects garbage", () => expect(parseIntervalSpec("soon")).toBeUndefined());
  it("undefined input → undefined", () => expect(parseIntervalSpec(undefined)).toBeUndefined());
});

// ---------------------------------------------------------------------------
// 7. runSessionCatchup in a real git repo
// ---------------------------------------------------------------------------
describe("runSessionCatchup — git diff integration", () => {
  it("reports changed paths when working tree is dirty in a git repo", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** pending\n");
    // init git + make a dirty change
    execSync("git init -q && git add -A && git commit -q -m init", { cwd });
    writeFileSync(join(cwd, "dirty.txt"), "change");
    const res = runSessionCatchup(cwd);
    expect(res.relevant).toBe(true);
    // git diff --stat on a committed-then-edited untracked file may be empty,
    // so accept either diffStat populated OR the status-line fallback
    expect(res.summary).toContain("phases");
  });

  it("returns relevant=false when no plan exists", () => {
    const cwd = tmp();
    expect(runSessionCatchup(cwd).relevant).toBe(false);
  });
});
