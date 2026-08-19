/**
 * Env-hints dispatch footer (src/env-hints.ts + the two application seams):
 * file presence = on/off switch, PI_SUBAGENT_HINTS_FILE override, 2000-char
 * cap, and composition order task → env hints → abort-safety at both
 * buildSpawnOptions (tool seam) and roleAwareDirectCall (direct-call seam).
 */
import { afterAll, afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_HINTS_MARKER } from "../src/env-hints.js";
import { buildSpawnOptions, type RunProgress, roleAwareDirectCall } from "../src/subagent-tool-run.js";

const HINTS_ENV = "PI_SUBAGENT_HINTS_FILE";
const DISABLE_ENV = "SUBAGENT_TOKEN_BUDGET_DISABLE";
const ABORT_MARKER = "--- abort-safety (appended by the dispatch layer — obey; don't restate) ---";

const savedEnv: Record<string, string | undefined> = {};
const fixtureDir = mkdtempSync(join(tmpdir(), "env-hints-test-"));
const hintsPath = join(fixtureDir, "hints.md");
const missingPath = join(fixtureDir, "nope-does-not-exist.md");

beforeEach(() => {
  for (const k of [HINTS_ENV, DISABLE_ENV]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env[HINTS_ENV] = hintsPath;
});

afterEach(() => {
  for (const k of [HINTS_ENV, DISABLE_ENV]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

/** Minimal write-capable ctx for buildSpawnOptions (mirrors existing tests). */
function buildTask(
  paramsOverrides: Record<string, unknown> = {},
  agentDef: { tools?: string[] } = { tools: ["read"] },
) {
  const progress: RunProgress = {
    resolvedModel: undefined,
    fellBack: false,
    lastHistory: undefined,
    maxToolCallsSeen: 0,
  };
  const opts = buildSpawnOptions(
    {
      toolCallId: "call-env-hints",
      t0: 1_700_000_000_000,
      params: { task: "T", ...paramsOverrides },
      agentDef,
      modelCtx: {
        requestedModel: "req",
        tier: undefined,
        capability: undefined,
        mainModel: undefined,
        displayModelBeforeResolve: "req",
      },
      spawnCwd: "/r",
      childSignal: new AbortController().signal,
    },
    progress,
    {
      getActiveTools: () => undefined,
      getExtensionTools: () => undefined,
      inFlight: undefined,
      persistence: undefined,
      onUpdate: undefined,
    },
  );
  return opts.task;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("env-hints: missing hints file → spawned task unchanged (marker absent, abort-safety still gated)", () => {
  process.env[HINTS_ENV] = missingPath;
  // read-only short run: footer gate off → task is byte-identical
  assert.equal(buildTask(), "T");
  // write-capable run: gate on → abort-safety alone, no hints marker
  const task = buildTask({}, { tools: ["edit"] });
  assert.ok(!task.includes(ENV_HINTS_MARKER));
  assert.ok(task.includes(ABORT_MARKER));
});

test("env-hints: blank hints file → off (treated like missing)", () => {
  writeFileSync(hintsPath, "   \n\t\n");
  assert.equal(buildTask(), "T");
});

test("env-hints: hints file present → marker + content exactly once, hints BEFORE abort-safety", () => {
  writeFileSync(hintsPath, "- macOS host: GNU `timeout` does not exist.\n- Never `git add -A`.");
  const task = buildTask({}, { tools: ["edit"] });
  assert.equal(occurrences(task, ENV_HINTS_MARKER), 1);
  assert.ok(task.includes("GNU `timeout` does not exist"));
  assert.ok(task.includes("Never `git add -A`"));
  assert.ok(task.includes(ABORT_MARKER));
  assert.ok(task.indexOf(ENV_HINTS_MARKER) < task.indexOf(ABORT_MARKER), "env hints precede abort-safety");
  assert.ok(task.startsWith("T"), "task body stays first");
});

test("env-hints: >2000-char hints file → truncated marker, content capped", () => {
  writeFileSync(hintsPath, "x".repeat(2500));
  const task = buildTask();
  assert.ok(task.includes(ENV_HINTS_MARKER));
  assert.ok(task.includes("[hints truncated]"), "cap sentinel present");
  const content = task.slice(task.indexOf(ENV_HINTS_MARKER) + ENV_HINTS_MARKER.length + 1); // +1 skips the marker's trailing newline
  assert.ok(content.length <= 2000 + "\n[hints truncated]".length, "content never exceeds cap + sentinel");
  assert.ok(!content.slice(0, -"[hints truncated]".length).includes("x".repeat(2001)));
});

test("env-hints: roleAwareDirectCall applied branch → envelope + hints + abort-safety in order", () => {
  writeFileSync(hintsPath, "- hint-one");
  const r = roleAwareDirectCall("recon", "T", "id-env-hints");
  assert.ok(r.task.includes(ENV_HINTS_MARKER));
  assert.ok(r.task.includes("hint-one"));
  assert.ok(r.task.includes(ABORT_MARKER));
  assert.ok(r.task.indexOf(ENV_HINTS_MARKER) < r.task.indexOf(ABORT_MARKER));
  assert.equal(r.maxTurns, 12, "envelope intact");
});

test("env-hints: roleAwareDirectCall not-applied branch (SUBAGENT_TOKEN_BUDGET_DISABLE=1) → hints still present, no abort-safety", () => {
  writeFileSync(hintsPath, "- hint-two");
  process.env[DISABLE_ENV] = "1";
  const r = roleAwareDirectCall("recon", "T", "id-env-hints");
  assert.ok(r.task.includes(ENV_HINTS_MARKER), "hints are independent of the budget envelope");
  assert.ok(r.task.includes("hint-two"));
  assert.ok(!r.task.includes(ABORT_MARKER));
  assert.equal(r.tokenBudget, undefined);
});
