/**
 * `dispatchChild` — the shared per-child dispatch pipeline.
 *
 * These tests pin the policy that the `subagent` (singular) and `subagents`
 * (plural) tools previously each implemented by hand: abort fan-in, the
 * user-abort-vs-turn-abort distinction, resolved-model capture, in-flight
 * lifecycle, the commit-scope audit, and status derivation.
 */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { type AgentHistoryEntry, SubagentInFlightRegistry } from "@repo/pi-agent-core-runtime";
import { type ChildDispatchDeps, dispatchChild } from "../src/child-dispatch.js";
import { convertToBackground } from "../src/detach-run.js";
import type { GitScopeOps } from "../src/git-scope.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";
import { budgetAbort, failed, ok, timedout, turnsAbort } from "./_spawn-result.js";

const OK: SpawnSubagentResult = ok("out");

/** Minimal in-flight registry double recording the lifecycle calls. */
function fakeRegistry() {
  const calls: string[] = [];
  let entry: Record<string, unknown> | undefined;
  return {
    calls,
    get entry() {
      return entry;
    },
    start(e: Record<string, unknown>) {
      entry = e;
      calls.push(`start:${e.id}`);
    },
    end(id: string) {
      calls.push(`end:${id}`);
    },
    markCompleted(id: string) {
      calls.push(`markCompleted:${id}`);
    },
    update(id: string, _h: AgentHistoryEntry[]) {
      calls.push(`update:${id}`);
    },
    updateModel(id: string, m: string) {
      calls.push(`updateModel:${id}:${m}`);
    },
    markFallback(id: string, s: string) {
      calls.push(`markFallback:${id}:${s}`);
    },
  };
}

function req(over: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    startedAt: Date.now(),
    spawn: { task: "t" } as SpawnSubagentOptions,
    entry: { model: "m", taskPreview: "t", workIntent: "t" },
    ...over,
  } as Parameters<typeof dispatchChild>[0];
}

function deps(over: Partial<ChildDispatchDeps> = {}): ChildDispatchDeps {
  return { spawn: async () => OK, ...over } as ChildDispatchDeps;
}

describe("dispatchChild — in-flight lifecycle", () => {
  it("registers on start and releases with end() by default", async () => {
    const reg = fakeRegistry();
    await dispatchChild(req(), deps({ inFlight: reg as never }));
    assert.deepEqual(reg.calls, ["start:call-1", "end:call-1"]);
  });

  it("releases with markCompleted() when the caller keeps the entry (batch k/N)", async () => {
    const reg = fakeRegistry();
    await dispatchChild(req(), deps({ inFlight: reg as never, release: "markCompleted" }));
    assert.deepEqual(reg.calls, ["start:call-1", "markCompleted:call-1"]);
  });

  it("releases the entry even when spawn throws, and rethrows", async () => {
    const reg = fakeRegistry();
    await assert.rejects(
      dispatchChild(
        req(),
        deps({
          inFlight: reg as never,
          spawn: async () => {
            throw new Error("boom");
          },
        }),
      ),
      /boom/,
    );
    assert.deepEqual(reg.calls, ["start:call-1", "end:call-1"]);
  });

  it("passes the caller's display fields through to the registry entry", async () => {
    const reg = fakeRegistry();
    await dispatchChild(
      req({ entry: { agent: "reviewer", model: "m", taskPreview: "p", workIntent: "w", batchId: "b" } }),
      deps({ inFlight: reg as never }),
    );
    assert.equal(reg.entry?.agent, "reviewer");
    assert.equal(reg.entry?.batchId, "b");
    assert.equal(reg.entry?.foreground, true);
  });
});

describe("dispatchChild — abort fan-in", () => {
  it("an already-aborted parent signal aborts the child before spawn runs", async () => {
    const ac = new AbortController();
    ac.abort();
    let seen: AbortSignal | undefined;
    await dispatchChild(
      req({ parentSignal: ac.signal }),
      deps({
        spawn: async (o: SpawnSubagentOptions) => {
          seen = o.externalSignal;
          return OK;
        },
      }),
    );
    assert.equal(seen?.aborted, true);
  });

  it("a turn-level abort (parent signal) is NOT reported as a user abort", async () => {
    const ac = new AbortController();
    const out = await dispatchChild(
      req({ parentSignal: ac.signal }),
      deps({
        spawn: async () => {
          ac.abort();
          return OK;
        },
      }),
    );
    assert.equal(out.userAborted, false, "whole-turn Esc is not a per-child user abort");
    assert.notEqual(out.status, "aborted");
  });

  it("aborting the registry entry IS reported as a user abort", async () => {
    const reg = fakeRegistry();
    const out = await dispatchChild(
      req(),
      deps({
        inFlight: reg as never,
        spawn: async () => {
          (reg.entry?.abort as () => void)();
          return OK;
        },
      }),
    );
    assert.equal(out.userAborted, true);
    assert.equal(out.status, "aborted");
  });

  it("removes its parent-signal listener once the run settles", async () => {
    const ac = new AbortController();
    let removed = 0;
    const orig = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = ((...a: Parameters<typeof orig>) => {
      removed++;
      return orig(...a);
    }) as typeof orig;
    await dispatchChild(req({ parentSignal: ac.signal }), deps());
    assert.ok(removed > 0, "a long batch must not accumulate one listener per child");
  });
});

describe("dispatchChild — model resolution capture", () => {
  it("reports the ACTUAL resolved model, not the requested display string", async () => {
    const reg = fakeRegistry();
    const out = await dispatchChild(
      req({ entry: { model: "tier:big", taskPreview: "t", workIntent: "t" } }),
      deps({
        inFlight: reg as never,
        spawn: async (o: SpawnSubagentOptions) => {
          o.onModelResolved?.("zai/glm-5.2");
          return OK;
        },
      }),
    );
    assert.equal(out.model, "zai/glm-5.2");
    assert.ok(reg.calls.includes("updateModel:call-1:zai/glm-5.2"));
  });

  it("falls back to the display model when resolution never fires", async () => {
    const out = await dispatchChild(req({ entry: { model: "tier:big", taskPreview: "t", workIntent: "t" } }), deps());
    assert.equal(out.model, "tier:big");
  });

  it("records a fallback with the originally-requested spec", async () => {
    const reg = fakeRegistry();
    const out = await dispatchChild(
      req(),
      deps({
        inFlight: reg as never,
        spawn: async (o: SpawnSubagentOptions) => {
          o.onModelFallback?.("openai/gpt-nope");
          return OK;
        },
      }),
    );
    assert.equal(out.fellBack, true);
    assert.equal(out.requestedModel, "openai/gpt-nope");
    assert.ok(reg.calls.includes("markFallback:call-1:openai/gpt-nope"));
  });
});

describe("dispatchChild — status derivation", () => {
  const cases: Array<[string, SpawnSubagentResult, string]> = [
    ["done", OK, "done"],
    ["timedout", timedout("slow", "out"), "timedout"],
    ["failed", failed("nope"), "failed"],
    ["budget", budgetAbort({ kind: "tokens", limit: 10, actual: 11 }), "budget"],
    ["turns", turnsAbort({ maxTurns: 3, turnsUsed: 3 }), "turns"],
  ];
  for (const [name, result, expected] of cases) {
    it(`maps a ${name} spawn result to status "${expected}"`, async () => {
      const out = await dispatchChild(req(), deps({ spawn: async () => result }));
      assert.equal(out.status, expected);
    });
  }
});

describe("dispatchChild — commit-scope audit", () => {
  /** HEAD advances between the pre-dispatch capture and the post-run check, so
   *  computeScopeCheck actually diffs `base..head`. */
  const gitOps = (committed: string[]): GitScopeOps => {
    let n = 0;
    return {
      headCommit: async () => (n++ === 0 ? "base-sha" : "head-sha"),
      changedPaths: async () => committed,
    };
  };

  it("audits by DEFAULT when no commitScope is declared (unset means flag any commit)", async () => {
    const out = await dispatchChild(
      req({ scope: { runCwd: "/repo", spawnCwd: "/repo" } }),
      deps({ gitOps: gitOps(["src/stray.ts"]) }),
    );
    assert.ok(out.scopeCheck, "an unset scope must still audit — this is the git add -A sweep signal");
    assert.deepEqual(out.scopeCheck?.outOfScope, ["src/stray.ts"]);
  });

  it("honours a declared allowlist", async () => {
    const out = await dispatchChild(
      req({ scope: { declared: ["src/"], runCwd: "/repo", spawnCwd: "/repo" } }),
      deps({ gitOps: gitOps(["src/ok.ts"]) }),
    );
    assert.deepEqual(out.scopeCheck?.outOfScope, []);
  });

  it("skips the audit for a worktree-isolated run (its commits are discarded)", async () => {
    const out = await dispatchChild(
      req({ scope: { runCwd: "/repo", spawnCwd: "/repo/.worktrees/x" } }),
      deps({ gitOps: gitOps(["anything.ts"]) }),
    );
    assert.equal(out.scopeCheck, undefined);
  });

  it("never fails the run when git throws", async () => {
    const out = await dispatchChild(
      req({ scope: { runCwd: "/repo", spawnCwd: "/repo" } }),
      deps({
        gitOps: {
          headCommit: async () => {
            throw new Error("not a repo");
          },
        } as never,
      }),
    );
    assert.equal(out.status, "done");
    assert.equal(out.scopeCheck, undefined);
  });
});

describe("dispatchChild — dispatch gate", () => {
  it("routes the spawn through the caller's gate (the shared rate limiter)", async () => {
    const order: string[] = [];
    await dispatchChild(
      req(),
      deps({
        gate: async (fn) => {
          order.push("gate-in");
          const r = await fn();
          order.push("gate-out");
          return r;
        },
        spawn: async () => {
          order.push("spawn");
          return OK;
        },
      }),
    );
    assert.deepEqual(order, ["gate-in", "spawn", "gate-out"]);
  });
});

describe("dispatchChild — detach to background (Task 05)", () => {
  /** Spawn that resolves `aborted` when its external signal fires — mirrors
   *  spawnSubagent's contract once dispatchChild aborts the in-process run. */
  const hangUntilAborted = (o: SpawnSubagentOptions): Promise<SpawnSubagentResult> =>
    new Promise((resolve) => {
      o.externalSignal?.addEventListener(
        "abort",
        () => resolve({ output: "", failure: { kind: "aborted", message: "detached" } }),
        { once: true },
      );
    });

  it("resolves the awaited call with status 'detached' and keeps the registry entry live", async () => {
    const registry = new SubagentInFlightRegistry();
    const pending = dispatchChild(
      req({ entry: { model: "m", taskPreview: "t", workIntent: "t", task: "full task" } }),
      deps({ inFlight: registry, spawn: hangUntilAborted }),
    );
    // Wait until dispatchChild has registered the run (synchronous prefix done).
    for (let i = 0; i < 100 && !registry.view("call-1"); i++) await Promise.resolve();
    assert.ok(registry.view("call-1"), "run registered before detach");

    const outcome = await (async () => {
      const detach = convertToBackground("call-1", {
        registry,
        spawnDetached: () => ({ pid: 1, kill: () => void 0 }),
        persistRun: () => "/tmp/m.json",
      });
      assert.deepEqual(detach, { ok: true, runId: "call-1" });
      return pending;
    })();

    assert.equal(outcome.status, "detached");
    assert.equal(outcome.userAborted, false);
    // The entry stays LIVE (foreground flipped, detached stamped) — it was not
    // ended or markCompleted'd by the release path.
    const v = registry.view("call-1");
    assert.ok(v, "registry entry survives detach");
    assert.equal(v.foreground, false);
    assert.equal(v.detached, true);
  });

  it("stores the full raw task on the registry entry (manifest source)", async () => {
    const registry = new SubagentInFlightRegistry();
    const pending = dispatchChild(
      req({ entry: { model: "m", taskPreview: "t", workIntent: "t", task: "the full raw task" } }),
      deps({ inFlight: registry, spawn: hangUntilAborted }),
    );
    for (let i = 0; i < 100 && !registry.view("call-1"); i++) await Promise.resolve();
    assert.equal(registry.view("call-1")?.task, "the full raw task");
    convertToBackground("call-1", {
      registry,
      spawnDetached: () => ({ pid: 1, kill: () => void 0 }),
      persistRun: () => "/tmp/m.json",
    });
    await pending;
  });
});
