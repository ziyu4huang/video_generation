import { test } from "bun:test";
import assert from "node:assert/strict";
import type { GitScopeOps, SubagentScopeCheck } from "../src/git-scope.js";
import {
  augmentOutputWithScopeViolation,
  captureCommitBaseline,
  captureWatchdogBaseline,
  resolveDisplayModel,
  runScopeCheck,
  runWatchdogReview,
} from "../src/subagent-tool-run.js";
import type { RepoBaseline } from "../src/watchdog/repo-diff.js";
import type { WatchdogResult } from "../src/watchdog/types.js";

const fakeGitOps = (head: string | (() => Promise<string>) = "abc"): GitScopeOps =>
  ({ headCommit: typeof head === "string" ? async () => head : head }) as unknown as GitScopeOps;

test("resolveDisplayModel: requestedModel wins; then capability > tier > mainModel > default", () => {
  assert.equal(resolveDisplayModel("gpt-4", "vision", "big", "m"), "gpt-4");
  assert.equal(resolveDisplayModel(undefined, "vision", "big", "m"), "capability:vision");
  assert.equal(resolveDisplayModel(undefined, undefined, "big", "m"), "tier:big");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, "m"), "m");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, undefined), "default");
});

test("captureCommitBaseline: #02 default-on — captures baseline even when scope UNSET (real tree)", async () => {
  // #02 B1: scope unset is now treated as scope=[] (flag any commit). The
  // baseline MUST be captured so the post-run check can diff base..HEAD.
  assert.equal(await captureCommitBaseline(undefined, "/r", "/r", fakeGitOps("deadbeef")), "deadbeef");
  // worktree-isolated runs are STILL skipped (the worktree is discarded at teardown).
  assert.equal(await captureCommitBaseline(["src/"], "/wt", "/r", fakeGitOps()), undefined);
});

test("captureCommitBaseline: returns headCommit on the real tree", async () => {
  assert.equal(await captureCommitBaseline(["src/"], "/r", "/r", fakeGitOps("deadbeef")), "deadbeef");
});

test("captureCommitBaseline: swallows headCommit throw → undefined", async () => {
  const ops = fakeGitOps(async () => {
    throw new Error("no git");
  });
  assert.equal(await captureCommitBaseline(undefined, "/r", "/r", ops), undefined);
});

test("runScopeCheck: #02 default-on — unset scope still runs the check (scope=[] flags every touched path)", async () => {
  // compute receives scope=[] for an unset scope → outOfScopePaths flags every path.
  let receivedScope: readonly string[] | undefined;
  const compute = async (_ops: never, _cwd: string, _base: string, scope: readonly string[]) => {
    receivedScope = scope;
    return { baseCommit: "abc", touchedPaths: ["x.ts"], outOfScope: ["x.ts"] } as unknown as SubagentScopeCheck;
  };
  const out = await runScopeCheck(undefined, "/r", "/r", "abc", fakeGitOps(), compute as never);
  assert.deepEqual(receivedScope, [], "unset scope is passed to compute as []");
  assert.deepEqual(out?.outOfScope, ["x.ts"], "a touched path is flagged even with no explicit scope");
  // worktree-isolated + missing baseCommit are STILL skipped.
  assert.equal(await runScopeCheck(undefined, "/wt", "/r", "abc", fakeGitOps(), compute as never), undefined);
  assert.equal(await runScopeCheck(undefined, "/r", "/r", undefined, fakeGitOps(), compute as never), undefined);
});

test("captureWatchdogBaseline: undefined when normalizeWatchdogParam rejects; {opts,baseline} otherwise", () => {
  // undefined param → normalizeWatchdogParam returns a falsy opts → undefined
  assert.equal(
    captureWatchdogBaseline("/r", undefined, () => ({}) as RepoBaseline),
    undefined,
  );
  // a truthy param (boolean true) → opts truthy, baseline computed
  const got = captureWatchdogBaseline("/r", true, () => ({ marker: "x" }) as unknown as RepoBaseline);
  assert.ok(got && "opts" in got && got.baseline);
});

test("runWatchdogReview: summary line when ran/editGated; empty otherwise; error line on throw", async () => {
  const ran: WatchdogResult = { ran: true, editGated: false, summary: "ok" } as unknown as WatchdogResult;
  const gated: WatchdogResult = { ran: false, editGated: true, summary: "no-diff" } as unknown as WatchdogResult;
  const idle: WatchdogResult = { ran: false, editGated: false, summary: "" } as unknown as WatchdogResult;
  const fakeRun = async (_input: {
    cwd: string;
    before: RepoBaseline;
    opts: { l1: boolean; l2: boolean };
    taskLabel: string;
  }) => ran;
  assert.ok(
    (await runWatchdogReview(fakeRun, { l1: true, l2: false }, {} as RepoBaseline, "/r", "t")).outputAppend.includes(
      "ok",
    ),
  );
  assert.ok(
    (
      await runWatchdogReview(async () => gated, { l1: true, l2: false }, {} as RepoBaseline, "/r", "t")
    ).outputAppend.includes("no-diff"),
  );
  assert.equal(
    (await runWatchdogReview(async () => idle, { l1: true, l2: false }, {} as RepoBaseline, "/r", "t")).outputAppend,
    "",
  );
  const err = await runWatchdogReview(
    async () => {
      throw new Error("boom");
    },
    { l1: true, l2: false },
    {} as RepoBaseline,
    "/r",
    "t",
  );
  assert.ok(err.outputAppend.includes("watchdog-error: boom"));
  assert.equal(err.result, undefined);
});

test("augmentOutputWithScopeViolation: passthrough when none; appends block when out-of-scope", () => {
  assert.equal(augmentOutputWithScopeViolation("done", undefined), "done");
  const out = augmentOutputWithScopeViolation("done", {
    outOfScope: ["evil.txt"],
    inScope: [],
  } as unknown as SubagentScopeCheck);
  assert.ok(out.startsWith("done\n\n--- ⚠ commit-scope violation (1) ---"));
  assert.ok(out.includes("- evil.txt"));
});

import { buildDetails, buildRunRecord, buildSpawnOptions, type RunProgress } from "../src/subagent-tool-run.js";

test("buildRunRecord: aborted path JSON-matches the original literal", () => {
  const rec = buildRunRecord(
    {
      toolCallId: "call-1",
      agent: "impl",
      task: "do thing",
      model: "tier:big",
      requestedModel: undefined,
      fellBack: false,
      tier: "big",
      runCwd: "/r",
      t0: 1_700_000_000_000,
      elapsedMs: 5000,
    },
    {
      status: "aborted",
      output: "Subagent aborted by user.",
      usage: { input: 1, output: 2 } as never,
    },
  );
  // The aborted literal has exactly these keys (no error/budget/history/report/scopeCheck/watchdog).
  assert.equal(rec.status, "aborted");
  assert.equal(rec.output, "Subagent aborted by user.");
  assert.equal(rec.requestedModel, undefined);
  assert.equal(rec.fellBack, undefined);
  // JSON-equivalent to the aborted literal (no error/budget/history/report/scopeCheck/watchdog).
  assert.deepEqual(
    JSON.parse(JSON.stringify(rec)),
    JSON.parse(
      JSON.stringify({
        id: rec.id,
        toolCallId: "call-1",
        agent: "impl",
        task: "do thing",
        model: "tier:big",
        requestedModel: undefined,
        fellBack: undefined,
        tier: "big",
        cwd: "/r",
        status: "aborted",
        startedAt: new Date(1_700_000_000_000).toISOString(),
        elapsedMs: 5000,
        usage: { input: 1, output: 2 },
        output: "Subagent aborted by user.",
      }),
    ),
  );
});

test("buildRunRecord: normal path includes the extra fields", () => {
  const rec = buildRunRecord(
    {
      toolCallId: "call-1",
      agent: "impl",
      task: "do thing",
      model: "m1",
      requestedModel: "req",
      fellBack: true,
      tier: "big",
      runCwd: "/r",
      t0: 1_700_000_000_000,
      elapsedMs: 9000,
    },
    {
      status: "done",
      usage: { input: 3 } as never,
      output: "ok",
      error: undefined,
      budget: undefined,
      history: [],
      report: undefined,
      scopeCheck: undefined,
      watchdog: { ran: true } as never,
    },
  );
  assert.equal(rec.requestedModel, "req"); // fellBack ⇒ requestedModel surfaces
  assert.equal(rec.fellBack, true);
  assert.equal(rec.status, "done");
  assert.equal(rec.output, "ok");
});

test("buildDetails: matches the original normal details shape", () => {
  const result = {
    usage: { input: 1 },
    output: "**Status:** DONE",
  } as never;
  const d = buildDetails(
    result,
    { model: "m1", requestedModel: "req", fellBack: true },
    {
      task: "do thing",
      agent: "impl",
      elapsedMs: 5000,
      startedAt: 1_700_000_000_000,
      scopeCheck: undefined,
      watchdog: { ran: true } as never,
    },
  );
  assert.equal(d.status, "done");
  assert.equal(d.model, "m1");
  assert.equal(d.requestedModel, "req");
  assert.equal(d.fellBack, true);
  assert.equal(d.report?.status, "DONE"); // parseSddReport parsed the **Status:** block
});

test("buildSpawnOptions: forwards params + wires callbacks that mutate progress", async () => {
  const progress: RunProgress = {
    resolvedModel: undefined,
    fellBack: false,
    lastHistory: undefined,
    maxToolCallsSeen: 0,
  };
  const updatedModel: string[] = [];
  const inFlight = {
    updateModel: (_id: string, m: string) => updatedModel.push(m),
    markFallback: () => {},
    update: () => {},
  } as never;
  const opts = buildSpawnOptions(
    {
      toolCallId: "call-1",
      t0: 1_700_000_000_000,
      params: { task: "t", timeoutMs: 1000 },
      agentDef: { tools: ["read"] },
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
      inFlight,
      persistence: undefined,
      onUpdate: undefined,
    },
  );
  assert.equal(opts.task, "t");
  assert.equal(opts.timeoutMs, 1000);
  assert.deepEqual(opts.tools, ["read"]);
  assert.equal(opts.model, "req");
  // callbacks mutate the shared progress box
  opts.onModelResolved?.("real-model");
  assert.equal(progress.resolvedModel, "real-model");
  assert.deepEqual(updatedModel, ["real-model"]);
  opts.onModelFallback?.("req");
  assert.equal(progress.fellBack, true);
});

test("buildSpawnOptions: forwards params.maxTurns; omitted → undefined (no default injected)", async () => {
  const mk = (params: Record<string, unknown>) =>
    buildSpawnOptions(
      {
        toolCallId: "call-1",
        t0: 1_700_000_000_000,
        params: { task: "t", ...params },
        agentDef: { tools: ["read"] },
        modelCtx: {
          requestedModel: undefined,
          tier: undefined,
          capability: undefined,
          mainModel: undefined,
          displayModelBeforeResolve: "m",
        },
        spawnCwd: "/r",
        childSignal: new AbortController().signal,
      } as never,
      { resolvedModel: undefined, fellBack: false, lastHistory: undefined, maxToolCallsSeen: 0 },
      {
        getActiveTools: () => undefined,
        getExtensionTools: () => undefined,
        inFlight: undefined,
        persistence: undefined,
        onUpdate: undefined,
      },
    );
  // explicit value forwarded verbatim
  assert.equal(mk({ maxTurns: 7 }).maxTurns, 7);
  // omitted → undefined (unlike tokenBudget, NO tier-calibrated default — omit = unlimited turns)
  assert.equal(mk({}).maxTurns, undefined);
});
