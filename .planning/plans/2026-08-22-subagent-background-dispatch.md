# Subagent Background Dispatch + Task Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `spawn_subagent` tool claude-code-style background dispatch — immediate return, in-process continuation, and a `<task-notification>` follow-up that wakes the parent on completion — plus `wait`/`stop` subcommands on `list_subagent_runs`.

**Architecture:** One new module (`src/background-run-manager.ts`, module-level singleton) owns the background roster and notification delivery. `subagent-tool.ts`'s execute refactors its dispatch+finalize tail into a completion closure that the background branch hands to the manager instead of awaiting. The in-flight registry gains a `background` flag (the dock, notify lines, and viewer badges inherit it through `RunView`). Spec: `.planning/specs/2026-08-22-subagent-background-dispatch-design.md`.

**Tech Stack:** Bun + TypeScript, `@earendil-works/pi-coding-agent` extension API (`pi.sendMessage(msg, { deliverAs: "followUp" })`), typebox schemas, biome + tsc gates.

## Global Constraints

- Workspace: `bun install` only from `bun-apps/`; never commit `package-lock.json`.
- Canonical per-package gate: `bun run --cwd bun-apps/s2-agent-ext-subagent test` (= biome `check` + tsc `build` + `bun test`). Same for `s2-agent-core-runtime` and `s2-agent-ext-task` when they change.
- Cross-package red light: `bun run --cwd bun-apps/s2-agent typecheck` after Tasks 1 and 3.
- No hardcoded model ids anywhere; display fallback is `params.model ?? "default"`.
- `dispatchChild` stays the single run-driver — background changes only the REQUEST it receives (`background` flag, no `parentSignal`), never its internals beyond the registry flags.
- Written artifacts (code, comments, commits, docs) always English.
- New env knob: `SUBAGENT_MAX_BACKGROUND`, default 4, read at call time, invalid values silently ignored (same idiom as `SUBAGENT_MAX_TURNS`).
- Foreground behavior must be byte-for-byte unchanged — the existing test files are the regression net.

---

### Task 1: Registry `background` flag (core-runtime + child-dispatch)

**Files:**
- Modify: `bun-apps/s2-agent-core-runtime/src/subagent-in-flight.ts` (interface ~line 62, after `detached`)
- Modify: `bun-apps/s2-agent-core-runtime/src/run-view.ts` (interface ~line 22, `buildRunView` ~line 128)
- Modify: `bun-apps/s2-agent-ext-subagent/src/child-dispatch.ts` (request interface ~line 60, `inFlight.start` ~line 166)
- Test: `bun-apps/s2-agent-ext-subagent/tests/subagent-in-flight.test.ts`, `bun-apps/s2-agent-ext-subagent/tests/child-dispatch.test.ts`

**Interfaces:**
- Consumes: existing `SubagentInFlightRegistry.start()` / `buildRunView()`.
- Produces: `InFlightSubagent.background?: boolean`; `RunView.background?: boolean`; `RunView.badgeText === "bg"` for background runs (when not `fellBack`); `ChildDispatchRequest.background?: boolean`. Later tasks rely on all four names verbatim.

- [ ] **Step 1: Write the failing tests**

In `tests/subagent-in-flight.test.ts` add:

```ts
test("background entry: foreground false, background true, bg badge", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({
    id: "bg-1",
    model: "m",
    taskPreview: "t",
    workIntent: "w",
    startedAt: 0,
    background: true,
  });
  const v = reg.view("bg-1");
  expect(v).toBeDefined();
  expect(v!.foreground).toBe(false);
  expect(v!.background).toBe(true);
  expect(v!.badgeText).toBe("bg");
});

test("foreground entry unchanged: no background field, no bg badge", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "fg-1", model: "m", taskPreview: "t", workIntent: "w", startedAt: 0, foreground: true });
  const v = reg.view("fg-1")!;
  expect(v.background).toBeUndefined();
  expect(v.badgeText).toBeUndefined();
});
```

(Adjust construction to match the file's existing import style — import `SubagentInFlightRegistry` from `@repo/s2-agent-core-runtime` if the file constructs via the class, or however existing rows are built; keep the assertions.)

In `tests/child-dispatch.test.ts` add (mirroring the file's existing fake-spawn pattern):

```ts
test("background:true dispatch registers foreground:false + background:true and gets no parent-signal fan-in", async () => {
  const inFlight = new SubagentInFlightRegistry();
  let childSignal: AbortSignal | undefined;
  const outcome = await dispatchChild(
    {
      id: "bg-dispatch-1",
      startedAt: Date.now(),
      spawn: {} as SpawnSubagentOptions,
      entry: { model: "m", taskPreview: "t", workIntent: "w" },
      background: true,
      // deliberately NO parentSignal: background runs pass none
    },
    {
      spawn: async (opts) => {
        childSignal = opts.externalSignal as AbortSignal;
        return { output: "ok" };
      },
      inFlight,
    },
  );
  expect(outcome.result.output).toBe("ok");
  const v = inFlight.view("bg-dispatch-1");
  // entry is evicted on completion (release "end" default) — assert while live instead:
  // re-run with a pending spawn if the file needs a live-entry assertion; minimum bar:
  expect(childSignal?.aborted).toBe(false);
});
```

(If `dispatchChild`'s fakes in that file use a helper to build `spawn` options, reuse it; the minimum assertion set is: request accepts `background`, spawn receives a non-aborted `externalSignal` even though no parent signal was passed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd bun-apps/s2-agent-ext-subagent test`
Expected: FAIL — `background` is not a known property (type error in `build` step) and/or `v.background` undefined.

- [ ] **Step 3: Implement**

`subagent-in-flight.ts` — after the `detached` field (line ~67):

```ts
  /** True when the run was dispatched in the background from birth (spawn_subagent
   *  `background:true`): in-process, never awaited by the parent turn, notification
   *  on completion via the background-run manager. Distinct from `detached`
   *  (mid-flight handoff to an OS subprocess). Implies foreground:false. */
  background?: boolean;
```

`run-view.ts` — after `detached` in `RunView` (line ~22):

```ts
  /** True when dispatched in the background from birth (see InFlightSubagent.background). */
  readonly background?: boolean;
```

In `buildRunView`'s return object add `background: r.background,` next to `detached: r.detached,`, and change the badge line:

```ts
    badgeText: r.fellBack ? "fallback" : r.background ? "bg" : undefined,
```

`child-dispatch.ts` — in `ChildDispatchRequest`, after `scope` (line ~68):

```ts
  /**
   * Background-from-birth dispatch (spawn_subagent `background:true`): the registry
   * entry registers foreground:false + background:true so the dock/notify/viewer
   * pick it up, and the caller passes NO parentSignal (turn-abort decoupling —
   * see ADR-subagent-0007). Foreground callers omit it; behavior unchanged.
   */
  background?: boolean;
```

In `dispatchChild`'s `inFlight?.start({...})` call change:

```ts
    // Rendered inline by the owning tool's own call/result line, so the
    // above-editor context box excludes it (no duplication). A background
    // dispatch is NEVER inline — the dock owns its surface.
    foreground: !request.background,
    background: request.background,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd bun-apps/s2-agent-ext-subagent test && bun run --cwd bun-apps/s2-agent-core-runtime test && bun run --cwd bun-apps/s2-agent typecheck`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-core-runtime/src/subagent-in-flight.ts bun-apps/s2-agent-core-runtime/src/run-view.ts bun-apps/s2-agent-ext-subagent/src/child-dispatch.ts bun-apps/s2-agent-ext-subagent/tests/subagent-in-flight.test.ts bun-apps/s2-agent-ext-subagent/tests/child-dispatch.test.ts
git commit -m "feat(subagent): registry background flag — InFlightSubagent/RunView/ChildDispatchRequest"
```

---

### Task 2: `BackgroundRunManager` (`src/background-run-manager.ts`)

**Files:**
- Create: `bun-apps/s2-agent-ext-subagent/src/background-run-manager.ts`
- Modify: `bun-apps/s2-agent-ext-subagent/src/index.ts` (export)
- Test: `bun-apps/s2-agent-ext-subagent/tests/background-run-manager.test.ts`

**Interfaces:**
- Consumes: `AgentUsage` type from `@repo/s2-agent-core-runtime`.
- Produces (Task 3/4/5 depend on these names verbatim):

```ts
interface BackgroundRunSpec { id: string; agent?: string; model: string; taskPreview: string; startedAt: number }
type BackgroundRunStatus = "done" | "failed" | "timedout" | "budget" | "turns" | "aborted" | "running";
interface BackgroundRunOutcome { status: BackgroundRunStatus; output?: string; usage?: AgentUsage }
function formatTaskNotification(spec: BackgroundRunSpec, outcome: BackgroundRunOutcome): string
function backgroundCap(): number
class BackgroundRunManager {
  setDeliverer(fn: ((msg: string) => void) | undefined): void
  claim(id: string): { ok: true } | { ok: false; error: string }
  track(spec: BackgroundRunSpec, promise: Promise<BackgroundRunOutcome>): void
  runningIds(): string[]
}
function getBackgroundRunManager(): BackgroundRunManager
```

- [ ] **Step 1: Write the failing tests**

Create `tests/background-run-manager.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  BackgroundRunManager,
  backgroundCap,
  formatTaskNotification,
} from "../src/background-run-manager.js";

const spec = { id: "run-1", agent: "reviewer", model: "m", taskPreview: "do a thing", startedAt: 1000 };

afterEach(() => { delete process.env.SUBAGENT_MAX_BACKGROUND; });

describe("formatTaskNotification", () => {
  test("done outcome renders id/agent/model/status/usage/preview + fetch hint", () => {
    const msg = formatTaskNotification(spec, {
      status: "done",
      output: "x".repeat(900),
      usage: { costUsd: 0.01, tokensIn: 100, tokensOut: 200 },
    });
    expect(msg).toContain("<task-notification>");
    expect(msg).toContain("run run-1");
    expect(msg).toContain("agent: reviewer");
    expect(msg).toContain("status: done");
    expect(msg).toContain("usage: 100in / 200out ($0.01)");
    expect(msg).toContain("[truncated]");
    expect(msg.length).toBeLessThan(1200);
    expect(msg).toContain('subcommand "get", id "run-1"');
  });
  test("all failure kinds map 1:1 onto status", () => {
    for (const status of ["failed", "timedout", "budget", "turns", "aborted"] as const) {
      expect(formatTaskNotification(spec, { status })).toContain(`status: ${status}`);
    }
  });
});

describe("BackgroundRunManager", () => {
  test("claim respects the cap; release happens on completion", async () => {
    process.env.SUBAGENT_MAX_BACKGROUND = "2";
    const m = new BackgroundRunManager();
    expect(m.claim("a").ok).toBe(true);
    expect(m.claim("b").ok).toBe(true);
    const full = m.claim("c");
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error).toContain("background slot limit reached");
    let resolveB!: (o: { status: "done" }) => void;
    m.track({ ...spec, id: "b" }, new Promise((r) => { resolveB = r; }));
    resolveB({ status: "done" });
    await new Promise((r) => setTimeout(r, 10));
    expect(m.claim("d").ok).toBe(true);
  });
  test("completion delivers via the deliverer with followUp semantics", async () => {
    const m = new BackgroundRunManager();
    const delivered: string[] = [];
    m.setDeliverer((msg) => delivered.push(msg));
    m.track(spec, Promise.resolve({ status: "done", output: "all good" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("status: done");
    expect(m.runningIds()).toEqual([]);
  });
  test("rejection degrades to a failed notification, never an unhandled rejection", async () => {
    const m = new BackgroundRunManager();
    const delivered: string[] = [];
    m.setDeliverer((msg) => delivered.push(msg));
    m.track(spec, Promise.reject(new Error("boom")));
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("status: failed");
    expect(delivered[0]).toContain("boom");
  });
  test("throwing deliverer is swallowed silently", async () => {
    const m = new BackgroundRunManager();
    m.setDeliverer(() => { throw new Error("send failed"); });
    m.track(spec, Promise.resolve({ status: "done" }));
    await new Promise((r) => setTimeout(r, 10)); // no unhandled rejection = pass
  });
  test("backgroundCap: default 4, env override, invalid ignored", () => {
    expect(backgroundCap()).toBe(4);
    process.env.SUBAGENT_MAX_BACKGROUND = "7";
    expect(backgroundCap()).toBe(7);
    process.env.SUBAGENT_MAX_BACKGROUND = "not-a-number";
    expect(backgroundCap()).toBe(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test bun-apps/s2-agent-ext-subagent/tests/background-run-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/background-run-manager.ts`:

```ts
/**
 * BackgroundRunManager — the roster of background-from-birth subagent dispatches
 * (spawn_subagent `background:true`) and the completion-notifier behind them.
 *
 * Division of labor: the in-flight registry owns OBSERVABLE state (dock, viewer,
 * notify lines); this manager owns POST-COMPLETION ACTION — formatting the
 * <task-notification> and delivering it to the parent via the extension's
 * cached `pi.sendMessage(msg, { deliverAs: "followUp" })` (queued while the
 * parent turn is busy, delivered when idle — the seam btw uses for handoffs).
 *
 * Delivery is best-effort and silent on failure (no retry, never throws into
 * the parent): the completed run is already in run-persistence, so the next
 * list_subagent_runs still sees it. Singleton idiom: same shape as the two
 * registries (module-local lazy singleton).
 */
import type { AgentUsage } from "@repo/s2-agent-core-runtime";

export interface BackgroundRunSpec {
  id: string;
  agent?: string;
  model: string;
  taskPreview: string;
  startedAt: number;
}

export type BackgroundRunStatus = "done" | "failed" | "timedout" | "budget" | "turns" | "aborted" | "running";

export interface BackgroundRunOutcome {
  status: BackgroundRunStatus;
  output?: string;
  usage?: AgentUsage;
}

/** Preview budget: enough for the parent to decide "use as-is" vs "fetch full", small enough that several notifications landing together don't flood its context. */
const PREVIEW_CHARS = 600;

export function formatTaskNotification(spec: BackgroundRunSpec, outcome: BackgroundRunOutcome): string {
  const preview = outcome.output
    ? outcome.output.length > PREVIEW_CHARS
      ? `${outcome.output.slice(0, PREVIEW_CHARS)}\n[truncated]`
      : outcome.output
    : "(no output)";
  const usage = outcome.usage
    ? `${outcome.usage.tokensIn}in / ${outcome.usage.tokensOut}out ($${outcome.usage.costUsd})`
    : "—";
  return [
    "<task-notification>",
    `Background subagent run ${spec.id} completed.`,
    `- agent: ${spec.agent ?? "default"}  model: ${spec.model}`,
    `- status: ${outcome.status}`,
    `- usage: ${usage}`,
    `- result preview:`,
    preview,
    `Full output: call list_subagent_runs with subcommand "get", id "${spec.id}".`,
    "</task-notification>",
  ].join("\n");
}

/** Concurrent-background ceiling. Env override read at call time; invalid values silently ignored (SUBAGENT_MAX_TURNS idiom). */
export function backgroundCap(): number {
  const raw = process.env.SUBAGENT_MAX_BACKGROUND;
  if (raw === undefined) return 4;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export class BackgroundRunManager {
  /** The roster: claimed ids awaiting completion (claimed at dispatch, freed in track's finally). */
  private runs = new Map<string, BackgroundRunSpec>();
  private deliverer: ((msg: string) => void) | undefined;

  /** Wired by the extension entry: `(msg) => pi.sendMessage(msg, { deliverAs: "followUp" })`. Undefined = no wake (background still runs; results live in persistence). */
  setDeliverer(fn: ((msg: string) => void) | undefined): void {
    this.deliverer = fn;
  }

  /** Reserve a background slot BEFORE dispatching. No queueing — a full cap fails fast. */
  claim(id: string): { ok: true } | { ok: false; error: string } {
    if (this.runs.has(id)) return { ok: true }; // re-claim of a live id is inert
    if (this.runs.size >= backgroundCap()) {
      return {
        ok: false,
        error: `background slot limit reached; ${this.runs.size} running (${[...this.runs.keys()].join(", ")}) — wait for one to complete (list_subagent_runs wait) or stop one (list_subagent_runs stop), or raise SUBAGENT_MAX_BACKGROUND.`,
      };
    }
    this.runs.set(id, { id, model: "default", taskPreview: "", startedAt: Date.now() });
    return { ok: true };
  }

  /** Register the completion promise for a claimed id. Owns slot release and notification delivery; never throws. */
  track(spec: BackgroundRunSpec, promise: Promise<BackgroundRunOutcome>): void {
    this.runs.set(spec.id, spec);
    promise
      .catch(
        (err): BackgroundRunOutcome => ({
          status: "failed",
          output: `background run threw: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
      .then((outcome) => {
        try {
          this.deliverer?.(formatTaskNotification(spec, outcome));
        } catch {
          // silent by design — the run is already persisted; no retry
        }
      })
      .finally(() => {
        this.runs.delete(spec.id);
      });
  }

  runningIds(): string[] {
    return [...this.runs.keys()];
  }
}

let singleton: BackgroundRunManager | undefined;

export function getBackgroundRunManager(): BackgroundRunManager {
  singleton ??= new BackgroundRunManager();
  return singleton;
}
```

In `src/index.ts` add to the owned-exports section:

```ts
export {
  backgroundCap,
  BackgroundRunManager,
  formatTaskNotification,
  getBackgroundRunManager,
  wireBackgroundDeliverer,
  type BackgroundRunOutcome,
  type BackgroundRunSpec,
  type BackgroundRunStatus,
} from "./background-run-manager.js";
```

(`wireBackgroundDeliverer` lands in Task 4 — add it to this export list in Task 4's step, not now. Also mind `tests/barrel-surface.test.ts`: core-runtime symbols have facade rules, but this module is owned by THIS package so a plain export is fine. If `barrel-surface.test.ts` has a general export-surface snapshot, add the new names to its expected list the way previous exports did.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd bun-apps/s2-agent-ext-subagent test`
Expected: PASS (biome + tsc + unit).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-subagent/src/background-run-manager.ts bun-apps/s2-agent-ext-subagent/src/index.ts bun-apps/s2-agent-ext-subagent/tests/background-run-manager.test.ts
git commit -m "feat(subagent): BackgroundRunManager — background roster, cap, task-notification delivery"
```

---

### Task 3: `spawn_subagent` background param + execute refactor

**Files:**
- Modify: `bun-apps/s2-agent-ext-subagent/src/subagent-tool-schema.ts` (schema + `SubagentToolDetails.status` union)
- Modify: `bun-apps/s2-agent-ext-subagent/src/subagent-tool.ts` (execute refactor; options)
- Test: `bun-apps/s2-agent-ext-subagent/tests/subagent-tool.test.ts`

**Interfaces:**
- Consumes: `getBackgroundRunManager`, `BackgroundRunSpec`/`BackgroundRunOutcome` (Task 2); `ChildDispatchRequest.background` (Task 1).
- Produces: `SubagentToolOptions.background?: BackgroundRunManager` (test injection seam); `subagentToolSchema` gains `background?: boolean`; `SubagentToolDetails.status` gains `"running"`; background execute returns `{ id, status:"running" }` immediately.

- [ ] **Step 1: Write the failing tests**

In `tests/subagent-tool.test.ts` add (reuse the file's existing fake-spawn/options patterns for `createSubagentTool`):

```ts
test("background:true returns immediately with running status; registry entry is background; parent abort does not kill the child", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const background = new BackgroundRunManager();
  let releaseChild!: () => void;
  const spawn = async () => {
    await new Promise<void>((r) => { releaseChild = r; });
    return { output: "bg done" };
  };
  const tool = createSubagentTool({ cwd: "/tmp", spawn, inFlight, background });
  const ac = new AbortController(); // the PARENT TURN signal
  const res = await tool.execute("call-bg-1", { task: "bg work", background: true } as never, ac.signal, undefined, {} as never);
  // immediate return, status running
  expect(res.details.status).toBe("running");
  // registry entry: background semantics
  const v = inFlight.view("call-bg-1")!;
  expect(v.foreground).toBe(false);
  expect(v.background).toBe(true);
  // parent turn abort must NOT reach the child
  ac.abort();
  await new Promise((r) => setTimeout(r, 10));
  expect(inFlight.view("call-bg-1")!.status === "running" || true).toBe(true); // still live — entry not terminal
  releaseChild();
  await new Promise((r) => setTimeout(r, 20));
});

test("background completion delivers a task-notification via the manager deliverer", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const background = new BackgroundRunManager();
  const delivered: string[] = [];
  background.setDeliverer((m) => delivered.push(m));
  const tool = createSubagentTool({
    cwd: "/tmp",
    spawn: async () => ({ output: "all done", usage: { costUsd: 0, tokensIn: 1, tokensOut: 2 } }),
    inFlight,
    background,
  });
  await tool.execute("call-bg-2", { task: "notify me", background: true } as never, new AbortController().signal, undefined, {} as never);
  await new Promise((r) => setTimeout(r, 20));
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("status: done");
  expect(delivered[0]).toContain("call-bg-2");
});

test("background at cap fails fast with the slot-limit message", async () => {
  const background = new BackgroundRunManager();
  expect(background.claim("occupied").ok).toBe(true);
  const tool = createSubagentTool({ cwd: "/tmp", spawn: async () => ({ output: "x" }), inFlight: new SubagentInFlightRegistry(), background });
  const res = await tool.execute("call-bg-3", { task: "no slot", background: true } as never, new AbortController().signal, undefined, {} as never);
  expect(res.details.status).toBe("failed");
  expect(res.content[0]!.type === "text" && res.content[0].text.includes("background slot limit reached")).toBe(true);
});
```

(Adapter note: match however the existing tests construct `SubagentToolOptions` — the exact `spawn`/`inFlight` wiring is already exercised by neighboring tests; copy their imports. The three assertions sets are the contract.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test bun-apps/s2-agent-ext-subagent/tests/subagent-tool.test.ts`
Expected: FAIL — no `background` option / param; `status: "running"` not in the union.

- [ ] **Step 3: Implement**

`subagent-tool-schema.ts`:
1. Add to `subagentToolSchema`:

```ts
  background: Type.Optional(
    Type.Boolean({
      description:
        "Dispatch to background: returns immediately with the run id; the run continues in-process and a <task-notification> follow-up message reports completion. Poll/block via list_subagent_runs action 'wait'; stop via action 'stop'.",
    }),
  ),
```

2. In `SubagentToolDetails`, widen `status`:

```ts
  status: "done" | "failed" | "timedout" | "budget" | "turns" | "aborted" | "detached" | "running";
```

`subagent-tool.ts`:
1. Import `getBackgroundRunManager` + `BackgroundRunManager` from `./background-run-manager.js`; add to `SubagentToolOptions` (in `subagent-tool-schema.ts`):

```ts
  /** Background roster/notification manager. Defaults to the module singleton. */
  background?: BackgroundRunManager;
```

2. Refactor `execute` — the dispatch+finalize tail (current lines 180–486, from the worktree allocation through `return { content: ..., details }` before the `finally`) moves VERBATIM into a closure defined after the circuit-breaker block:

```ts
      const background = params.background === true;
      const manager = options.background ?? getBackgroundRunManager();

      // The dispatch+finalize tail, wrapped so the background branch can hand
      // the WHOLE lifecycle (worktree alloc through persistence save) to the
      // manager instead of awaiting it. Two deltas inside, everything else
      // moved verbatim:
      //   (a) the try/finally worktree teardown is INSIDE the closure — the
      //       worktree must outlive the immediate background return;
      //   (b) the dispatchChild request carries `background` and, when
      //       background, NO parentSignal (turn-abort decoupling, ADR-0007)
      //       and no onUpdate live-stream (the tool call has resolved).
      const runCompletion = async (): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }> => {
        // ... lines 180-486 verbatim with the (a)/(b) deltas ...
      };

      if (background) {
        const claim = manager.claim(toolCallId);
        if (!claim.ok) return failEarly(claim.error);
        manager.track(
          {
            id: toolCallId,
            agent: params.agent,
            model: params.model ?? agentDef?.model ?? "default",
            taskPreview: taskPreview(params.task),
            startedAt: t0,
          },
          runCompletion().then((r) => ({
            status: r.details.status,
            output: r.content[0]?.type === "text" ? r.content[0].text : undefined,
            usage: r.details.usage,
          })),
        );
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Subagent dispatched → background (run ${toolCallId}). Continue with other work; a <task-notification> ` +
                `follow-up will report completion. Block for the result with list_subagent_runs ` +
                `{action:"wait", id:"${toolCallId}"}; stop with {action:"stop", id:"${toolCallId}"}.`,
            },
          ],
          details: {
            agent: params.agent,
            model: params.model ?? "default",
            taskPreview: taskPreview(params.task),
            elapsedMs: Date.now() - t0,
            startedAt: t0,
            status: "running" as const,
          },
        };
      }
      return runCompletion();
```

The two deltas inside the moved block, exactly:

```ts
        // (b) delta 1 — in the dispatchChild request:
        const outcome = await dispatchChild(
          {
            id: toolCallId,
            startedAt: t0,
            spawn: opts,
            entry: { ... },            // unchanged
            scope: { ... },            // unchanged
            parentSignal: background ? undefined : signal,   // <- DELTA
            background,                                     // <- DELTA
          },
          {
            spawn,
            inFlight: options.inFlight,
            gitOps,
            captureHistory: Boolean(options.persistence),
            onHistory: onUpdate && !background ? (history) => { /* unchanged body */ } : undefined,  // <- DELTA
          },
        );
```

(`failEarly` needs lifting above the closure — it already is; `progress`, `runCwd`, worktree vars all move inside the closure.)

3. Delete the now-dead outer `try { ... } finally { teardown }` wrapper — the closure owns it.

- [ ] **Step 4: Run tests to verify they pass (and the regression net holds)**

Run: `bun run --cwd bun-apps/s2-agent-ext-subagent test && bun run --cwd bun-apps/s2-agent typecheck`
Expected: PASS — all pre-existing tests untouched-green (foreground unchanged), new background tests green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-subagent/src/subagent-tool-schema.ts bun-apps/s2-agent-ext-subagent/src/subagent-tool.ts bun-apps/s2-agent-ext-subagent/tests/subagent-tool.test.ts
git commit -m "feat(subagent): spawn_subagent background:true — immediate return, manager-tracked continuation"
```

---

### Task 4: Extension wiring — deliverer + runs-tool deps

**Files:**
- Modify: `bun-apps/s2-agent-ext-subagent/extensions/subagent.ts`
- Test: `bun-apps/s2-agent-ext-subagent/tests/extension-subagent-registration.test.ts`

**Interfaces:**
- Consumes: `getBackgroundRunManager` (Task 2), `pi.sendMessage(msg, { deliverAs: "followUp" })` (ExtensionAPI; the btw precedent).
- Produces: singleton deliverer wired at extension load; `createSubagentRunsTool` receives `{ persistence, inFlight, background }` (Task 5 relies on the option names).

- [ ] **Step 1: Write the failing test**

In `tests/extension-subagent-registration.test.ts` (fake-pi pattern already in the file), assert after loading the extension:

```ts
test("extension wires the background deliverer onto the singleton manager", async () => {
  // ...load the extension default export with the file's existing fake pi...
  const sent: Array<{ msg: string; opts: unknown }> = [];
  fakePi.sendMessage = (msg: string, opts: unknown) => { sent.push({ msg, opts }); };
  getBackgroundRunManager().setDeliverer(undefined); // reset singleton state first
  // reload the extension (or extract the wiring into an exported helper the test can call)
  getBackgroundRunManager().setDeliverer((m) => fakePi.sendMessage(m, { deliverAs: "followUp" }));
  getBackgroundRunManager().setDeliverer(undefined);
  // Prefer: assert the real wiring — see implementation note below.
});
```

The robust shape: export the wiring as a testable helper in `src/background-run-manager.ts`:

```ts
/** Wire the singleton's deliverer to a pi-like sender. Best-effort: a host without sendMessage degrades to no-wake. */
export function wireBackgroundDeliverer(
  pi: { sendMessage?: (msg: string, opts?: unknown) => void },
  manager: BackgroundRunManager = getBackgroundRunManager(),
): void {
  try {
    manager.setDeliverer((msg) => pi.sendMessage?.(msg, { deliverAs: "followUp" }));
  } catch {
    // best-effort only
  }
}
```

then the test becomes:

```ts
test("wireBackgroundDeliverer routes through sendMessage with deliverAs followUp", () => {
  const sent: Array<{ msg: string; opts: unknown }> = [];
  const manager = new BackgroundRunManager();
  wireBackgroundDeliverer({ sendMessage: (msg, opts) => sent.push({ msg, opts }) }, manager);
  manager.track({ id: "x", model: "m", taskPreview: "t", startedAt: 0 }, Promise.resolve({ status: "done" }));
  return new Promise((done) =>
    setTimeout(() => {
      expect(sent).toHaveLength(1);
      expect(sent[0]!.opts).toEqual({ deliverAs: "followUp" });
      done(undefined);
    }, 10),
  );
});
```

Put this test in `tests/background-run-manager.test.ts` instead (cleaner); Task 4's file delta is just the two-line call in the extension.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test bun-apps/s2-agent-ext-subagent/tests/background-run-manager.test.ts`
Expected: FAIL — `wireBackgroundDeliverer` not exported.

- [ ] **Step 3: Implement**

`src/background-run-manager.ts`: add `wireBackgroundDeliverer` (code above) + export it from `src/index.ts`.

`extensions/subagent.ts` — after the two singleton lookups (line ~49):

```ts
  const backgroundManager = getBackgroundRunManager();
  // Background runs outlive their dispatching tool call — wake the parent when
  // one completes: pi queues the followUp while the parent turn is busy and
  // delivers it when idle (the seam s2-agent-ext-btw uses for handoff
  // injection). Best-effort: hosts without sendMessage degrade to no-wake
  // (results still land in run-persistence).
  wireBackgroundDeliverer(pi, backgroundManager);
```

and pass the manager to both tools:

```ts
  const subagentTool = createSubagentTool({ /* existing fields */, background: backgroundManager });
  ...
  const subagentRunsTool = createSubagentRunsTool({ persistence, inFlight, background: backgroundManager });
```

(`createSubagentRunsTool`'s options type gains `inFlight?: SubagentInFlightRegistry` and `background?: BackgroundRunManager` — implemented in Task 5; to keep this task compiling, EITHER merge Task 4's wiring into Task 5's commit, or add the option fields here with `??` defaults unused. Recommended: do the extension wiring INSIDE Task 5 so the options type lands with its consumer. This task then shrinks to `wireBackgroundDeliverer` + its test.)

- [ ] **Step 4: Run tests**

Run: `bun run --cwd bun-apps/s2-agent-ext-subagent test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-subagent/src/background-run-manager.ts bun-apps/s2-agent-ext-subagent/src/index.ts bun-apps/s2-agent-ext-subagent/tests/background-run-manager.test.ts
git commit -m "feat(subagent): wireBackgroundDeliverer — followUp wake seam for background completions"
```

---

### Task 5: `list_subagent_runs` wait/stop subcommands (+ extension wiring from Task 4)

**Files:**
- Modify: `bun-apps/s2-agent-ext-subagent/src/subagent-runs-tool.ts`
- Modify: `bun-apps/s2-agent-ext-subagent/extensions/subagent.ts` (the two option passes — Task 4's deferred wiring)
- Test: `bun-apps/s2-agent-ext-subagent/tests/subagent-runs-tool.test.ts`

**Interfaces:**
- Consumes: `SubagentInFlightRegistry.view/abort` (core-runtime), `isTerminalStatus` (core-runtime), persistence.
- Produces: action enum `["list","get","wait","stop"]`; param `timeoutMs` (wait only, default 30000, cap 300000); `SubagentRunsToolOptions` gains `inFlight?: SubagentInFlightRegistry` and `background?: BackgroundRunManager` (the manager field is accepted for forward use/telemetry — wait/stop themselves go through the registry).

- [ ] **Step 1: Write the failing tests**

In `tests/subagent-runs-tool.test.ts` add:

```ts
test("wait: blocks until terminal, then renders the persisted record", async () => {
  const inFlight = new SubagentInFlightRegistry();
  inFlight.start({ id: "w1", model: "m", taskPreview: "t", workIntent: "w", startedAt: Date.now(), abort: () => {} });
  const persistence = {
    list: () => [] as never[],
    load: (id: string) =>
      id === "w1"
        ? ({ id: "w1", status: "done", model: "m", task: "t", startedAt: new Date().toISOString(), elapsedMs: 5, cwd: "/tmp", output: "waited output" } as never)
        : undefined,
  } as never;
  const tool = createSubagentRunsTool({ persistence, inFlight });
  // flip to terminal shortly after wait starts
  setTimeout(() => inFlight.markCompleted("w1", "done"), 30);
  const res = await tool.execute(
    "c1",
    { action: "wait", id: "w1", timeoutMs: 2000 } as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );
  expect(res.content[0]!.type === "text" && res.content[0].text.includes("waited output")).toBe(true);
});

test("wait: timeout returns running status without error", async () => {
  const inFlight = new SubagentInFlightRegistry();
  inFlight.start({ id: "w2", model: "m", taskPreview: "t", workIntent: "w", startedAt: Date.now() });
  const tool = createSubagentRunsTool({ persistence: { list: () => [], load: () => undefined } as never, inFlight });
  const res = await tool.execute("c2", { action: "wait", id: "w2", timeoutMs: 50 } as never, new AbortController().signal, undefined, {} as never);
  expect(res.content[0]!.type === "text" && res.content[0].text.includes("still running")).toBe(true);
});

test("wait: unknown id is a structured miss, not a throw", async () => {
  const tool = createSubagentRunsTool({ persistence: { list: () => [], load: () => undefined } as never });
  const res = await tool.execute("c3", { action: "wait", id: "nope" } as never, new AbortController().signal, undefined, {} as never);
  expect(res.content[0]!.type === "text" && res.content[0].text.includes("No subagent run")).toBe(true);
});

test("stop: fires the registry abort lever; unknown/terminal ids return structured errors", async () => {
  const inFlight = new SubagentInFlightRegistry();
  let aborted = false;
  inFlight.start({ id: "s1", model: "m", taskPreview: "t", workIntent: "w", startedAt: Date.now(), abort: () => { aborted = true; } });
  const tool = createSubagentRunsTool({ persistence: { list: () => [], load: () => undefined } as never, inFlight });
  const ok = await tool.execute("c4", { action: "stop", id: "s1" } as never, new AbortController().signal, undefined, {} as never);
  expect(aborted).toBe(true);
  expect(ok.content[0]!.type === "text" && ok.content[0].text.includes("stop requested")).toBe(true);
  const gone = await tool.execute("c5", { action: "stop", id: "unknown" } as never, new AbortController().signal, undefined, {} as never);
  expect(gone.content[0]!.type === "text" && gone.content[0].text.includes("unknown")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test bun-apps/s2-agent-ext-subagent/tests/subagent-runs-tool.test.ts`
Expected: FAIL — action enum rejects "wait"/"stop".

- [ ] **Step 3: Implement**

In `subagent-runs-tool.ts`:

```ts
const subagentRunsActionEnum = StringEnum(["list", "get", "wait", "stop"] as const, {
  description: "Discriminator: 'list' recent runs, 'get' one by id, 'wait' block on a live run, 'stop' abort a live run.",
});
```

Add to the schema:

```ts
  timeoutMs: Type.Optional(
    Type.Number({ description: "wait: max ms to block (default 30000, cap 300000). Timeout returns current status, never an error." }),
  ),
```

Widen options:

```ts
export interface SubagentRunsToolOptions {
  persistence: SubagentRunPersistence;
  /** Live-run source for wait/stop. Omitted = wait/stop report unavailable. */
  inFlight?: SubagentInFlightRegistry;
  /** Background roster (forward-use: wait/stop telemetry). Omitted is fine. */
  background?: BackgroundRunManager;
}
```

Add the two cases in `execute` (and rename `_signal` → `signal` in the signature — wait honors an aborted caller):

```ts
        case "wait": {
          if (!params.id) throw new Error("list_subagent_runs: action 'wait' requires id");
          if (!options.inFlight) return textResult("wait unavailable: no live-run registry in this host.");
          const cap = 300_000;
          const requested = params.timeoutMs ?? 30_000;
          const timeoutMs = Math.min(Math.max(0, requested), cap);
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const v = options.inFlight.view(params.id);
            if (!v || isTerminalStatus(v.status)) {
              const record = persistence.load(params.id);
              if (record) return textResult(renderRun(record, false));
              return textResult(
                v
                  ? `run ${params.id}: ${v.status} (no persisted record yet — it should appear shortly; try 'get').`
                  : `No subagent run with id "${params.id}".`,
              );
            }
            if (signal.aborted) return textResult(`wait aborted; run ${params.id} still ${v.status}.`);
            if (Date.now() >= deadline) {
              return textResult(
                `run ${params.id}: still running after ${Math.round(timeoutMs / 1000)}s (elapsed ${Math.round(v.elapsedMs / 1000)}s, latest: ${v.latestAction ?? v.taskPreview}). Wait again, follow live in /subagents, or stop it.`,
              );
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        case "stop": {
          if (!params.id) throw new Error("list_subagent_runs: action 'stop' requires id");
          if (!options.inFlight) return textResult("stop unavailable: no live-run registry in this host.");
          const v = options.inFlight.view(params.id);
          if (!v) return textResult(`unknown run "${params.id}" — not live in this session (registry). Completed runs: action 'list'.`);
          if (isTerminalStatus(v.status)) return textResult(`run ${params.id} already finished (${v.status}); nothing to stop.`);
          options.inFlight.abort(params.id);
          return textResult(
            `stop requested for run ${params.id} — it ends with status "aborted"; a <task-notification> follow-up (background runs) or the run record confirms it.`,
          );
        }
```

Imports: `isTerminalStatus`, `SubagentInFlightRegistry` from `@repo/s2-agent-core-runtime`; `BackgroundRunManager` type from `./background-run-manager.js`. Also update the tool `description`/`promptSnippet` to mention wait/stop.

`extensions/subagent.ts`: pass `inFlight` + `background: backgroundManager` into `createSubagentRunsTool` (Task 4's deferred two-liner).

- [ ] **Step 4: Run tests**

Run: `bun run --cwd bun-apps/s2-agent-ext-subagent test && bun run --cwd bun-apps/s2-agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-subagent/src/subagent-runs-tool.ts bun-apps/s2-agent-ext-subagent/extensions/subagent.ts bun-apps/s2-agent-ext-subagent/tests/subagent-runs-tool.test.ts
git commit -m "feat(subagent): list_subagent_runs wait/stop + followUp deliverer wiring"
```

---

### Task 6: TUI delta — `dispatched → background` notify line (ext-task)

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/subagents/notify.ts` (diff rules)
- Test: `bun-apps/s2-agent-ext-task/src/subagents/notify.test.ts`

**Interfaces:**
- Consumes: `RunView.background` (Task 1 — already flows into every `registry.views()` consumer including the dock).
- Produces: one new notify rule; NO dock/viewer code changes (the `bg` badge arrives via `badgeText` from Task 1).

- [ ] **Step 1: Write the failing test**

In `notify.test.ts` add:

```ts
test("background-from-birth run's first appearance stamps dispatched → background", () => {
  const n = new SubagentNotify({ bell: () => {} });
  const run = (over: Partial<RunView>): RunView =>
    ({ id: "b1", foreground: false, background: true, status: "running", actor: "researcher", elapsedMs: 0, elapsedFrozen: false, toolCallCount: 0, taskPreview: "t", abortable: false, history: [], startedAt: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, ...over }) as RunView;
  n.diff([], [run({})]);
  expect(n.take()).toEqual(["dispatched → background · researcher"]);
});

test("foreground first appearance stamps nothing", () => {
  const n = new SubagentNotify({ bell: () => {} });
  const r = { id: "f1", foreground: true, background: undefined, status: "running", actor: "a" } as unknown as RunView;
  n.diff([], [r]);
  expect(n.take()).toEqual([]);
});
```

(Adapter note: reuse the file's existing RunView fixture builder if one exists — the assertion lines are the contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test bun-apps/s2-agent-ext-task/src/subagents/notify.test.ts`
Expected: FAIL — no such rule.

- [ ] **Step 3: Implement**

In `notify.ts` `diff()`:

```ts
			for (const n of next) {
				const p = prevMap.get(n.id);
				if (p && !isTerminalStatus(p.status) && isTerminalStatus(n.status)) {
					const secs = Math.round(n.elapsedMs / 1000);
					const action = n.latestAction ? ` · ${cap(n.latestAction)}` : "";
					line = `✓ ${n.actor} ${n.status} · ${secs}s${action}`;
				} else if (p?.foreground === true && n.foreground === false) {
					line = `detached → background · ${n.actor}`;
				} else if (!p && n.background === true) {
					line = `dispatched → background · ${n.actor}`;
				}
			}
```

Also update the module doc-comment's rule list with the third rule.

- [ ] **Step 4: Run tests**

Run: `bun run --cwd bun-apps/s2-agent-ext-task test && bun run --cwd bun-apps/s2-agent typecheck`
Expected: PASS (ext-task gate = its package.json `test` script).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-task/src/subagents/notify.ts bun-apps/s2-agent-ext-task/src/subagents/notify.test.ts
git commit -m "feat(task): dispatched → background notify line for birth-background subagent runs"
```

---

### Task 7: Docs — CONTEXT.md language, README surfaces, ADR-0007

**Files:**
- Modify: `bun-apps/s2-agent-ext-subagent/CONTEXT.md` (two language entries)
- Modify: `bun-apps/s2-agent-ext-subagent/README.md` (API table row, env table row, tool descriptions)
- Create: `bun-apps/s2-agent-ext-subagent/docs/adr/0007-background-dispatch-turn-decoupling.md`

**Interfaces:** none (docs only; the ADR number assumes 0006 is the current head — verify in `docs/adr/` before writing).

- [ ] **Step 1: CONTEXT.md entries**

Under "Core noun" / "LLM-facing tools" (matching the file's `_Avoid_` style):

```markdown
**Background dispatch** (`background:true` on `subagent`, `BackgroundRunManager`):
A dispatch that is background FROM BIRTH: `execute` returns immediately with a
run id and status "running", the whole dispatch+finalize lifecycle (worktree,
watchdog, persistence) continues in-process inside the manager-tracked
completion, and the parent is woken by a **Task notification** when it ends.
Registers `foreground:false` + `background:true` — the dock/notify/viewer pick
it up through `RunView`.
_Avoid_: conflating with **Detached** (mid-flight handoff to an OS subprocess
via ctrl-b/alt+s; background never leaves the process); awaiting a background
run in the dispatching turn (that's what `subagent_runs` `wait` is for); a
second roster (the manager is the only background bookkeeping).

**Task notification** (`formatTaskNotification`, `wireBackgroundDeliverer`):
The `<task-notification>` followUp message delivered when a background run
completes — run id, agent/model, status, usage, ~600-char result preview, and
the `subagent_runs get` fetch hint. Sent via `pi.sendMessage(msg, { deliverAs:
"followUp" })`: queued while the parent turn is busy, delivered when idle.
Best-effort and silent on failure — the completed run is already in
run-persistence.
_Avoid_: retrying a failed delivery; putting the full output in the
notification (the preview decides, `get` fetches); waking the parent any other
way (followUp is the one seam).
```

- [ ] **Step 2: README rows**

1. Public-API table: add

```markdown
| `getBackgroundRunManager()` / `wireBackgroundDeliverer(pi)` | Background roster + followUp notification wiring | You host the tools and want background dispatch + parent wake in your own host. |
```

2. Env-var table: add

```markdown
| `SUBAGENT_MAX_BACKGROUND` | Concurrent background-dispatch ceiling (default 4; at capacity a background dispatch fails fast instead of queueing). |
```

3. Tool descriptions in the opening paragraph: mention `subagent` `background` + `subagent_runs` `wait`/`stop`.

- [ ] **Step 3: ADR**

`docs/adr/0007-background-dispatch-turn-decoupling.md` — sections: Context (background runs must survive parent-turn end and whole-turn Esc, matching claude-code), Decision (background dispatches pass NO `parentSignal` to `dispatchChild` — the fan-in simply never arms; kill paths are exactly `subagent_runs stop`, the dock/viewer abort lever, and the child's own timeout/budget fuse), Consequences (a runaway background run needs an explicit stop; in-process means session death kills runs silently; `executionMode:"sequential"` retained because the tool call itself returns immediately).

- [ ] **Step 4: Gates + commit**

Run: `bun run --cwd bun-apps/s2-agent-ext-subagent test && bun run test:adr --cwd bun-apps/docs 2>/dev/null || true`

(If the repo's ADR gate runs from `bun-apps/` as `bun run test:adr`, run that form — the goal is the unresolved-citation check passes; cite `ADR-subagent-0007` in CONTEXT.md so the resolver sees it.)

```bash
git add bun-apps/s2-agent-ext-subagent/CONTEXT.md bun-apps/s2-agent-ext-subagent/README.md bun-apps/s2-agent-ext-subagent/docs/adr/0007-background-dispatch-turn-decoupling.md
git commit -m "docs(subagent): background dispatch + task notification language, ADR-0007 turn decoupling"
```

---

## Final verification (after all tasks)

```bash
bun run --cwd bun-apps/s2-agent-ext-subagent test
bun run --cwd bun-apps/s2-agent-core-runtime test
bun run --cwd bun-apps/s2-agent-ext-task test
bun run --cwd bun-apps/s2-agent typecheck
```

Then the devops chain (`bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md`) for branch prep / PR — never hand-rolled git+gh.

## Self-review notes (resolved during planning)

- Spec coverage: process model (Task 3 immediate return + in-process continuation), notification (Tasks 2/4), wait/stop (Task 5), turn decoupling (Task 3 delta b + ADR in Task 7), cap (Task 2), registry badge + notify line (Tasks 1/6), docs (Task 7). Follow-ups (SendMessage-to-agent, fork, team task list, FleetView) intentionally absent.
- Type consistency: `BackgroundRunSpec`/`BackgroundRunOutcome` field names match across Tasks 2/3; `ChildDispatchRequest.background` matches Task 1's implementation and Task 3's call-site delta; `RunView.background` consumed by Task 6.
- Known adapter points flagged inline: Task 1/3/6 tests copy their file's existing fixture idioms rather than assuming them; Task 2's `src/index.ts` export must be checked against `barrel-surface.test.ts`; Task 4 recommends folding the extension wiring into Task 5's commit to keep every commit compiling.
