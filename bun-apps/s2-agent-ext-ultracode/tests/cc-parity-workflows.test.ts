/**
 * CC-parity workflow samples — the REAL WorkflowManager executing the REAL
 * committed scripts under samples/cc-parity/, each shaped like an example
 * prompt from Claude Code's official workflows doc
 * (code.claude.com/docs/en/workflows):
 *
 *   B1 audit-many-files.js   — "Audit many files for the same issue"
 *   B2 verify-fix-loop.js    — "Keep fixing until a check passes"
 *   B4 review-per-file.js    — "Review every changed file and write one summary"
 *   B5 research-fanout.js    — "Research a topic across many sources"
 *                             (+ the doc's null-for-stopped filtering)
 *
 * No LLM in these gates: the injected agent runner is deterministic and
 * content-keyed (it decides from the PROMPT, exactly the seam a real agent
 * would consume). The live LLM behavior rides the tui-drive receipts
 * (self-arc-12 t04) and the kcard convergence sample covers the doc's
 * "find issues until the list stops growing" (loopUntilDry).
 *
 * B3 migrate-in-parallel.js — "Migrate many files in parallel" — lives in its
 * own gate (tests/cc-parity-migrate.test.ts): it needs WRITABLE fan-out
 * children, which the batch tool forbids by design (shared tree); the workflow
 * layer provides per-child worktree isolation, which is the pattern's actual
 * requirement. (Self-arc-13 completed this former descope.)
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentUsage } from "@repo/s2-agent-core-runtime";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const SAMPLES = join(import.meta.dir, "..", "samples", "cc-parity");
const script = (name: string) => readFileSync(join(SAMPLES, name), "utf8");

/** Deterministic, content-keyed agent runner; records every prompt. */
function scriptedAgent(handlers: { onPrompt?: (prompt: string) => void; answer: (prompt: string) => string }) {
  return {
    async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      handlers.onPrompt?.(prompt);
      options?.onUsage?.({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 });
      return handlers.answer(prompt);
    },
  };
}

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ccp-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-ccp-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test("all four CC-parity sample scripts carry the documented meta block", () => {
  for (const name of [
    "audit-many-files.js",
    "verify-fix-loop.js",
    "review-per-file.js",
    "research-fanout.js",
    "migrate-in-parallel.js",
  ]) {
    const src = script(name);
    assert.match(src, /export const meta = \{/, `${name}: meta block present`);
    assert.match(src, /name: "cc-parity-/, `${name}: meta.name namespaced`);
  }
});

// ── B1: "Audit many files for the same issue" ───────────────────────────────
test(
  "B1 audit many files: one agent per file, collected issues are exactly the planted set",
  withTempCwd(async (cwd) => {
    const files = [
      join(SAMPLES, "audit-corpus", "notes.ts"),
      join(SAMPLES, "audit-corpus", "planted-todo.ts"),
      join(SAMPLES, "audit-corpus", "util.ts"),
    ];
    const prompts: string[] = [];
    const manager = new WorkflowManager({
      cwd,
      // Deterministic stub verdicts, keyed off the audited path: the planted
      // fixture reports the issue, clean fixtures report CLEAN. (A real run
      // reads the files; this seam is the agent, not the fs.)
      agent: scriptedAgent({
        onPrompt: (p) => prompts.push(p),
        answer: (p) =>
          p.includes("planted-todo.ts") ? "ISSUE: 5 TODO: cancel the pending timer on re-invoke" : "CLEAN",
      }),
    });
    const result = await manager.runSync(script("audit-many-files.js"), { filenames: files });
    const r = result.result as { files: number; audited: number; issues: Array<{ file: string; issue: string }> };
    assert.equal(r.files, 3);
    assert.equal(r.audited, 3, "every file got exactly one audit agent");
    assert.equal(prompts.filter((p) => p.startsWith("AUDIT ")).length, 3, "fan-out = one agent per file");
    assert.equal(r.issues.length, 1, "exactly the planted issue collected");
    assert.match(r.issues[0]?.file ?? "", /planted-todo\.ts/);
    assert.match(r.issues[0]?.issue ?? "", /TODO/);
    assert.equal(result.agentCount, 3);
  }),
);

// ── B2: "Keep fixing until a check passes" ──────────────────────────────────
test(
  "B2 bounded verify/fix loop: early exit on PASS, bound stop with the failure surface intact",
  withTempCwd(async (cwd) => {
    const mk = (passAfterFixes: number) => {
      let fixes = 0;
      return scriptedAgent({
        onPrompt: (p) => {
          if (p.startsWith("FIX ")) fixes++;
        },
        answer: (p) => {
          if (p.startsWith("FIX ")) return "FIXED";
          // CHECK: PASS only once the fixer has run passAfterFixes rounds.
          return fixes >= passAfterFixes ? "PASS" : "FAIL";
        },
      });
    };

    // (a) checker flips to PASS after 2 fixer rounds → loop exits early.
    const early = new WorkflowManager({ cwd, agent: mk(2) });
    const r1 = (await early.runSync(script("verify-fix-loop.js"), { maxAttempts: 3 })).result as {
      passed: boolean;
      rounds: number;
      bounded: boolean;
    };
    assert.equal(r1.passed, true);
    assert.equal(r1.rounds, 2, "exits the round the checker first passes");
    assert.equal(r1.bounded, false);

    // (b) never-PASS variant → stops AT maxAttempts with bounded:true.
    const never = new WorkflowManager({ cwd, agent: mk(99) });
    const r2 = (await never.runSync(script("verify-fix-loop.js"), { maxAttempts: 3 })).result as {
      passed: boolean;
      rounds: number;
      bounded: boolean;
      maxAttempts: number;
    };
    assert.equal(r2.passed, false);
    assert.equal(r2.rounds, 3, "stops at the bound, not beyond");
    assert.equal(r2.bounded, true);
    assert.equal(r2.maxAttempts, 3);
  }),
);

// ── B4: "Review every changed file and write one summary" ───────────────────
test(
  "B4 review per file + one synthesizer: the synthesis prompt carries every per-file finding",
  withTempCwd(async (cwd) => {
    const files = ["a/auth.ts", "b/limits.ts", "c/hooks.ts"];
    const prompts: string[] = [];
    const manager = new WorkflowManager({
      cwd,
      agent: scriptedAgent({
        onPrompt: (p) => prompts.push(p),
        answer: (p) => {
          if (p.startsWith("REVIEW "))
            return (
              p
                .split("\n")[0]
                .replace(/^REVIEW the file /, `REVIEW `)
                .replace(/\.$/, "") + ": clean"
            );
          return "SUMMARY-PARAGRAPH";
        },
      }),
    });
    const result = await manager.runSync(script("review-per-file.js"), { filenames: files });
    const r = result.result as { reviewed: number; summary: string };
    assert.equal(r.reviewed, 3);
    assert.equal(r.summary, "SUMMARY-PARAGRAPH", "the run's final result is the synthesis");
    const synth = prompts.find((p) => p.startsWith("SYNTHESIZE")) ?? "";
    for (const f of files) {
      assert.match(synth, new RegExp(`REVIEW ${f.replace(/\//g, "\\/")}:`), `finding for ${f} reached the synthesizer`);
    }
    assert.equal(result.agentCount, 4, "3 reviewers + 1 synthesizer");
  }),
);

// ── B5: "Research a topic across many sources" (+ null-for-stopped) ─────────
test(
  "B5 research fan-out: a stopped reader drops to null and synthesis runs on the survivors",
  withTempCwd(async (cwd) => {
    const sources = ["docs/auth.md", "docs/stalled.md", "docs/webhooks.md"];
    const prompts: string[] = [];
    const manager = new WorkflowManager({
      cwd,
      agent: scriptedAgent({
        onPrompt: (p) => prompts.push(p),
        answer: (p) => {
          if (!p.startsWith("RESEARCH ")) return "BRIEF";
          // The "stopped" reader produces empty output — the runtime's
          // recoverable-empty semantics turn the slot into null, exercising
          // the doc's .filter(Boolean) idiom.
          if (p.includes("stalled.md")) return "";
          return `NOTE ${p.split(" ")[2]}: key-fact`;
        },
      }),
    });
    const result = await manager.runSync(script("research-fanout.js"), { sources });
    const r = result.result as { sources: number; survivors: number; brief: string };
    assert.equal(r.sources, 3);
    assert.equal(r.survivors, 2, "the stopped reader is filtered, not fatal");
    assert.equal(r.brief, "BRIEF");
    const synth = prompts.find((p) => p.startsWith("SYNTHESIZE")) ?? "";
    assert.doesNotMatch(synth, /stalled\.md/, "no note from the stopped reader reaches the synthesizer");
    assert.match(synth, /docs\/auth\.md: key-fact/);
    assert.match(synth, /docs\/webhooks\.md: key-fact/);
  }),
);
