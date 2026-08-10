### Task 6: background backfill (session-backfill house-style)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` (wire `schedulePlanningBackfill` into `pi.on("session_start", …)` alongside `scheduleSessionBackfill`)

**Interfaces:**
- Produces: `schedulePlanningBackfill(repoRoot, memoryDir, options)`, `planningBackfillState`, `PLANNING_BACKFILL_MAX_FILES`, `waitForPlanningBackfill` — mirroring `session-backfill.ts` shape.

- [ ] **Step 1: Write the failing test**

Create `src/handlers/planning-backfill.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulePlanningBackfill, planningBackfillState, PLANNING_BACKFILL_MAX_FILES } from "./planning-backfill.js";
import { createCardStore } from "../src/store/card-store.js";

function flushedState() {
  return { inProgress: false, promise: null as Promise<void> | null };
}

describe("schedulePlanningBackfill", () => {
  it("re-mirrors a changed planning md within bounds (fake timers via injected setTimeout)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pbf-"));
    const mem = mkdtempSync(join(tmpdir(), "pbf-mem-"));
    const state = flushedState();
    let fired = false;
    const flush = (cb: () => void) => { fired = true; cb(); }; // run inline
    try {
      const effort = "backfill-eff";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nBackfilled.\n");
      schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
      // The injected setTimeout ran inline; await the (already-resolved) promise.
      await state.promise;
      assert.ok(fired);
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /Backfilled\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("skips when a backfill is already in progress (run-state guard)", () => {
    const state = { inProgress: true, promise: Promise.resolve() };
    let called = false;
    const scheduled = schedulePlanningBackfill("/nonexistent", "/nonexistent", {
      state,
      setTimeoutFn: () => { called = true; } as never,
    });
    assert.equal(scheduled, false);
    assert.equal(called, false);
  });

  it("exports a MAX_FILES bound (parity with session backfill)", () => {
    assert.ok(PLANNING_BACKFILL_MAX_FILES > 0);
    assert.ok(planningBackfillState !== undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/handlers/planning-backfill.test.ts )`
Expected: FAIL — `Cannot find module "./planning-backfill.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/handlers/planning-backfill.ts` (mirror `session-backfill.ts` structure: deferred `setTimeout(0)`, run-state guard, MAX_FILES bound, best-effort notify):
```ts
// src/handlers/planning-backfill.ts — background backfill of the .planning card
// mirror (Phase-2 / 09-impl). Mirrors session-backfill.ts house-style: deferred
// via setTimeout(0) so session_start resolves first; run-state guard so two
// backfills never overlap in-process; MAX_FILES bound so a huge corpus can't
// stall startup. Idempotency = the mirror's hash-skip (re-mirroring unchanged
// files is a cheap hash-compare no-op — there is NO separate run-state file; a
// re-run resumes because unchanged cards hash-match-skip).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkAndIngest } from "../walk-and-ingest.js";

export const PLANNING_BACKFILL_MAX_FILES = 50;

type NotifyLevel = "info" | "warning" | "error";
type NotifyFn = (message: string, level: NotifyLevel) => void;
type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

export interface PlanningBackfillState {
  inProgress: boolean;
  promise: Promise<void> | null;
}

export const planningBackfillState: PlanningBackfillState = {
  inProgress: false,
  promise: null,
};

export interface SchedulePlanningBackfillOptions {
  notify?: NotifyFn;
  state?: PlanningBackfillState;
  setTimeoutFn?: SetTimeoutFn;
  maxFiles?: number;
}

/** Collect up to `maxFiles` planning-card md files under <repoRoot>/.planning.
 *  A cheap .planning-scoped recursive scan (NOT the full-repo walk) so startup
 *  cost stays bounded. Reuses planningCardKindFromPath to classify — same
 *  contract as walkKnowledgeSources, scoped to .planning/. */
function collectPlanningMdFiles(repoRoot: string, maxFiles: number): string[] {
  const out: string[] = [];
  const planningDir = join(repoRoot, ".planning");
  const recurse = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) recurse(abs);
      else if (name.endsWith(".md")) out.push(abs);
    }
  };
  recurse(planningDir);
  return out;
}

function notifyBestEffort(notify: NotifyFn | undefined, message: string, level: NotifyLevel): void {
  try {
    notify?.(message, level);
  } catch {
    /* Notification failures must never affect backfill. */
  }
}

/** Schedule a best-effort, bounded background re-mirror of .planning/. Mirrors
 *  scheduleSessionBackfill: deferred setTimeout(0); run-state guard; MAX_FILES
 *  bound; best-effort notify. The actual mirror reuses walkAndIngest's planning
 *  path (hash-compare INSERT/UPDATE/skip + delete reconciliation). Returns true
 *  when a backfill was scheduled; false when skipped (already in progress). */
export function schedulePlanningBackfill(
  repoRoot: string,
  memoryDir: string,
  options: SchedulePlanningBackfillOptions = {},
): boolean {
  const state = options.state ?? planningBackfillState;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const maxFiles = options.maxFiles ?? PLANNING_BACKFILL_MAX_FILES;

  if (state.inProgress) return false;

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(async () => {
      try {
        const files = collectPlanningMdFiles(repoRoot, maxFiles);
        if (files.length === 0) return;
        // walkAndIngest runs the hash-compare mirror + delete reconciliation
        // against these files (the hash-skip makes unchanged files cheap).
        await walkAndIngest(files, { memoryDir });
        notifyBestEffort(options.notify, `🧠 Planning backfill complete: scanned ${files.length} .planning file(s).`, "info");
      } catch (err) {
        notifyBestEffort(
          options.notify,
          `⚠️ Planning backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      } finally {
        state.inProgress = false;
        state.promise = null;
        resolve();
      }
    }, 0);
  });
  return true;
}

/** Wait briefly for an in-progress planning backfill before shutdown (mirrors
 *  waitForSessionBackfill). */
export async function waitForPlanningBackfill(
  timeoutMs = 5000,
  state: PlanningBackfillState = planningBackfillState,
): Promise<boolean> {
  const promise = state.promise;
  if (!state.inProgress || !promise) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```
> NOTE: `walkAndIngest` accepts `input: string | string[]` — passing the collected `files[]` scopes the mirror to exactly those files (the planning classifier keys off the `.planning` segment in each abs path, which the collected paths retain). This avoids re-walking the whole repo on every startup.

- [ ] **Step 4: Wire into index.ts**

In `src/index.ts`, add the import (next to the `session-backfill` import at the top):
```ts
import { schedulePlanningBackfill } from "./handlers/planning-backfill.js";
```
In the `pi.on("session_start", …)` handler, immediately AFTER the existing `scheduleSessionBackfill(…)` block (best-effort — wrap in try/catch like the stable-id backfill guard so a failure NEVER aborts startup):
```ts
    // Phase-2 (knowledge-pipeline / ticket 09): background re-mirror of .planning/.
    // Best-effort, bounded, run-state-guarded — mirrors scheduleSessionBackfill.
    // A failure must NEVER abort agent startup.
    try {
      schedulePlanningBackfill(ctx.cwd, memoryDir, {
        notify: (message, level) => {
          const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
          if (ui?.notify) ui.notify(message, level);
          else if (level === "error" || level === "warning") console.warn(message);
          else console.info(message);
        },
      });
    } catch {
      /* never block startup */
    }
```
> `memoryDir` is the hermes memory DB dir already resolved in `index.ts` (the same dir `createCardStore` / `scheduleSessionBackfill` use — confirm the exact local var name in `index.ts` at implementation time and use it). `ctx.cwd` is the repo root (the dir containing `.planning/`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/handlers/planning-backfill.test.ts )`
Expected: PASS.

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green (the index.ts wiring is additive; no existing handler test regresses).
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.ts bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.test.ts bun-apps/pi-agent-ext-hermes-memory/src/index.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning background backfill — session_start sweep (09-impl T6)"
```

**DoD:** a changed planning md is re-mirrored on `session_start` within `MAX_FILES`; run-state prevents an overlapping backfill; index.ts startup is non-blocking; full suite green.

---

