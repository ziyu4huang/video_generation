import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentHistoryEntry } from "@repo/pi-agent-core-runtime";
import type { GitScopeOps, SubagentScopeCheck } from "../src/git-scope.js";
import type { SubagentFailure } from "../src/spawn-subagent.js";
import {
  abortSafetyFooter,
  abortSafetyLogPath,
  augmentOutputWithSalvage,
  augmentOutputWithScopeViolation,
  captureCommitBaseline,
  captureWatchdogBaseline,
  extractSalvage,
  resolveDisplayModel,
  runScopeCheck,
  runWatchdogReview,
  shouldInjectFooter,
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
  // Hermetic vs the host's real ~/.pi/subagents/hints.md (presence = footer):
  const savedHints = process.env.PI_SUBAGENT_HINTS_FILE;
  process.env.PI_SUBAGENT_HINTS_FILE = "/nonexistent/pi-subagent-hints-absent.fixture.md";
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
  if (savedHints === undefined) delete process.env.PI_SUBAGENT_HINTS_FILE;
  else process.env.PI_SUBAGENT_HINTS_FILE = savedHints;
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

test("buildSpawnOptions: onUsage accrues mapped AgentUsage into the registry", () => {
  const accrued: Array<[string, Record<string, number>]> = [];
  const inFlight = {
    updateModel: () => {},
    markFallback: () => {},
    update: () => {},
    accrueUsage: (id: string, delta: Record<string, number>) => accrued.push([id, delta]),
  } as never;
  const opts = buildSpawnOptions(
    {
      toolCallId: "call-u",
      t0: 1_700_000_000_000,
      params: { task: "t" },
      agentDef: undefined,
      modelCtx: { requestedModel: undefined, tier: undefined, capability: undefined, mainModel: undefined },
      spawnCwd: "/r",
      childSignal: new AbortController().signal,
    },
    { resolvedModel: undefined, fellBack: false, lastHistory: undefined, maxToolCallsSeen: 0 },
    { inFlight },
  );
  opts.onUsage?.({ input: 100, output: 200, cost: 0.04 } as never);
  assert.equal(accrued.length, 1);
  assert.equal(accrued[0][0], "call-u");
  assert.deepEqual(accrued[0][1], { costUsd: 0.04, tokensIn: 100, tokensOut: 200 });
});

// ── H2 (2026-08-15 hardening): abort salvage from the compact transcript ──

const he = (e: Partial<AgentHistoryEntry>): AgentHistoryEntry => e as AgentHistoryEntry;

test("extractSalvage: last assistant text captured, trimmed, capped at 1500", () => {
  const salvage = extractSalvage([
    he({ role: "assistant", kind: "text", text: "  earlier note  " }),
    he({ role: "assistant", kind: "text", text: `  ${"x".repeat(1600)}  ` }),
  ]);
  assert.equal(salvage?.lastText, "x".repeat(1500));
  assert.equal(salvage?.files, undefined);
});

test("extractSalvage: write-tool call paths parsed from JSON args + deduped; reads ignored", () => {
  const salvage = extractSalvage([
    he({ role: "assistant", kind: "toolCall", toolName: "edit", text: '{"path":"a.ts"}' }),
    he({ role: "assistant", kind: "toolCall", toolName: "write", text: '{"file_path":"b.ts"}' }),
    he({ role: "assistant", kind: "toolCall", toolName: "multiedit", text: '{"path":"a.ts"}' }),
    he({ role: "assistant", kind: "toolCall", toolName: "apply_patch", text: '{"path":"c.ts"}' }),
    he({ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"ignored.ts"}' }),
  ]);
  assert.deepEqual(salvage?.files, ["a.ts", "b.ts", "c.ts"]);
  assert.equal(salvage?.lastText, undefined);
});

test("extractSalvage: malformed toolCall JSON swallowed; file list capped at 40", () => {
  const many = Array.from({ length: 45 }, (_, i) =>
    he({ role: "assistant", kind: "toolCall", toolName: "write", text: `{"path":"f${i}.ts"}` }),
  );
  const salvage = extractSalvage([
    he({ role: "assistant", kind: "toolCall", toolName: "edit", text: "not json" }),
    ...many,
  ]);
  assert.equal(salvage?.files?.length, 40);
  assert.equal(salvage?.files?.[0], "f0.ts");
});

test("extractSalvage: empty/undefined history, or nothing salvageable → undefined", () => {
  assert.equal(extractSalvage(undefined), undefined);
  assert.equal(extractSalvage([]), undefined);
  assert.equal(extractSalvage([he({ role: "user", kind: "text", text: "go" })]), undefined);
  assert.equal(extractSalvage([he({ role: "tool", kind: "toolResult", toolName: "read", text: "ok" })]), undefined);
});

const budgetFailure: SubagentFailure = {
  kind: "budget",
  message: "budget exhausted",
  budget: { kind: "tokens", limit: 1000, actual: 1234 },
};

test("augmentOutputWithSalvage: terminal abort appends the salvage section (files, then last words)", () => {
  const out = augmentOutputWithSalvage("Subagent aborted: budget", budgetFailure, false, {
    lastText: "final words",
    files: ["a.ts"],
  });
  assert.equal(
    out,
    "Subagent aborted: budget\n\n--- salvage (terminal abort) ---\nfiles touched: a.ts\nlast words:\nfinal words",
  );
});

test("augmentOutputWithSalvage: user abort counts as terminal even without a failure", () => {
  const out = augmentOutputWithSalvage("Subagent aborted by user.", undefined, true, { lastText: "wip" });
  assert.match(out, /--- salvage \(terminal abort\) ---\nlast words:\nwip/);
});

test("augmentOutputWithSalvage: non-terminal (done / plain failure) and salvage-less runs are untouched", () => {
  const salvage = { lastText: "wip", files: ["a.ts"] };
  assert.equal(augmentOutputWithSalvage("plain", undefined, false, salvage), "plain");
  assert.equal(augmentOutputWithSalvage("plain", { kind: "failed", message: "boom" }, false, salvage), "plain");
  assert.equal(augmentOutputWithSalvage("plain", budgetFailure, false, undefined), "plain");
});

// ── H4 (2026-08-15 hardening): abort-safety prompt footer ──

test("shouldInjectFooter: write-capable toolset OR maxTurns>10", () => {
  // write tools
  assert.equal(shouldInjectFooter({ tools: ["edit"] }), true);
  assert.equal(shouldInjectFooter({ tools: ["write", "multiedit", "apply_patch", "bash"] }), true);
  assert.equal(shouldInjectFooter({ tools: undefined }), true, "unrestricted child reads as write-capable");
  // read-only short
  assert.equal(shouldInjectFooter({ tools: ["read", "grep"] }), false);
  assert.equal(shouldInjectFooter({ tools: ["read", "grep"], maxTurns: 10 }), false, "10 is not >10");
  // exclusions deny the write tool
  assert.equal(shouldInjectFooter({ tools: ["edit", "read"], excludeTools: ["edit"] }), false);
  // long runs
  assert.equal(shouldInjectFooter({ tools: ["read"], maxTurns: 11 }), true);
  assert.equal(shouldInjectFooter({ maxTurns: 12 }), true);
});

test("abortSafetyFooter: ≤6 lines citing the log path, shell timeout, report-first", () => {
  const footer = abortSafetyFooter("/tmp/subagent-runs/x.md");
  const lines = footer.split("\n");
  assert.ok(lines.length <= 6, `footer stays ≤6 lines (${lines.length})`);
  assert.match(footer, /abort-safety/);
  assert.match(footer, /\/tmp\/subagent-runs\/x\.md/);
  assert.match(footer, /timeout <seconds>/);
  assert.match(footer, /FIRST write your final report to that log file/);
});

test("abortSafetyLogPath: run-scoped under /tmp/subagent-runs", () => {
  assert.equal(abortSafetyLogPath("id-1"), "/tmp/subagent-runs/id-1.md");
});

// ── tools precedence (register-tool-surface #1603 guard) ────────────────────
// Live-proven chain: model -> subagent(tools=[webui_report]) -> preflight
// pass -> child sees and calls the tool. This pins the seam so a refactor
// cannot silently drop the explicit allowlist: params.tools > agentDef.tools
// > defaultActiveTools, and registerTool names flow through VERBATIM.
test("buildSpawnOptions: tools precedence — params.tools beats agentDef.tools; registerTool names verbatim; getActiveTools fallback", async () => {
  const progress: RunProgress = {
    resolvedModel: undefined,
    fellBack: false,
    lastHistory: undefined,
    maxToolCallsSeen: 0,
  };
  const mkDeps = (active: string[]) =>
    ({
      getActiveTools: () => active,
      getExtensionTools: () => [],
      inFlight: { updateModel: () => {}, markFallback: () => {}, update: () => {} },
      persistence: undefined,
      onUpdate: () => {},
    }) as never;
  const base = (params: Record<string, unknown>, agentDef?: { tools?: string[] }) => ({
    toolCallId: "call-p",
    t0: 1_700_000_000_000,
    params: { task: "t", timeoutMs: 1000, ...params },
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
  });
  // 1) explicit params.tools WINS over agentDef.tools — the live-proven path.
  const a = buildSpawnOptions(
    base({ tools: ["webui_report"] }, { tools: ["read"] }) as never,
    progress,
    mkDeps(["read", "bash"]),
  );
  assert.deepEqual(a.tools, ["webui_report"]);
  // 2) a registerTool name flows through verbatim (never filtered/renamed).
  const b = buildSpawnOptions(base({ tools: ["webui_report", "webui_present"] }) as never, progress, mkDeps(["read"]));
  assert.deepEqual(b.tools, ["webui_report", "webui_present"]);
  // 3) neither params nor agentDef: falls back to the session's active tools.
  const c = buildSpawnOptions(base({}) as never, progress, mkDeps(["read", "bash", "edit", "write"]));
  assert.deepEqual(c.tools, ["read", "bash", "edit", "write"]);
});
