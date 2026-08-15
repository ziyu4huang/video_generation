# CC-Style Subagent TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver CC-parity subagent TUI: a live subagents section (order 4) in the core-task composite status widget, a completion-notify line, RunView cost/tokens projection, Ctrl-B detach-to-background, and a focusable dock — with the subagent package exposing a typed public surface and `subagent-context-widget.ts` retired.

**Architecture:** The core-task composite widget (`status-widget.ts` sections) becomes the sole below-editor display home, consuming the subagent/core-runtime public lib surface via typed imports (never `globalThis` seams). The subagent package owns data + detach levers; core-runtime owns RunView projection + registry. Wave 1 (display foundation) → Wave 2 (Ctrl-B backgrounding) → Wave 3 (focus-claim ADR, then dock).

**Tech Stack:** TypeScript (Bun runtime), pi extension API (`ExtensionUIContext`, `setWidget`, `ui.onTerminalInput`, `pi.registerShortcut`), `@earendil-works/pi-tui` Theme, Bun test.

## Global Constraints

- **Zero pi-core upstream changes.** No edits under `pi-coding-agent` / `pi-tui` packages; the focus-claim protocol (Task 07/08) is deliberately upstream-free.
- **Typed public imports, not globalThis seams.** New cross-package access goes through package barrels (`@repo/pi-agent-ext-core-runtime`, `@repo/pi-agent-ext-subagent`). The existing `__pi*` globals are legacy — do not add new ones. The one sanctioned shared-object accessor is `getSharedStatusWidget()` (its globalThis backing is internal to `status-widget.ts`).
- **The workflow package (`pi-agent-ext-workflow`) is untouched.**
- **Import direction:** core-task → subagent/core-runtime public surface ONLY. subagent never imports core-task.
- **Foreground/background exclusion rule:** the section renders ONLY `registry.views({ foreground: false })`; foreground runs stay inline (Surface A). Never render a run on both surfaces.
- **Gates (canonical package scripts, run from repo root):**
  - core-task: `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`
  - subagent: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
  - core-runtime (when `core-runtime/src` is touched — Tasks 03, 05): `( cd bun-apps/pi-agent-ext-core-runtime && bun run typecheck && bun test )`
- **Ref corrections vs. the task brief/spec** (verified at plan time):
  - `subagent-in-flight.ts` + `run-view.ts` live in `bun-apps/pi-agent-ext-core-runtime/src/`, NOT `pi-agent-ext-subagent/src/`. Registry singleton importers MUST use the `@repo/pi-agent-ext-core-runtime` barrel.
  - Line refs to `agent-row-display.ts` (`renderActivityRow` ≈ :120, `fmtCost` ≈ :183) are outside this plan's evidence base — `// verify exact signature at implement time` where marked.
  - All other existing-code call signatures marked `// verify` are implementation-time lookups; the interfaces this plan DEFINES are exact.

## File Structure

```
bun-apps/pi-agent-ext-core-runtime/src/
  run-view.ts                     # MODIFY (Task 03): RunView +costUsd/tokensIn/tokensOut
  subagent-in-flight.ts           # MODIFY (Task 03/05): usage accrual, markDetached
bun-apps/pi-agent-ext-subagent/src/
  spawn-subagent.ts               # MODIFY (Task 03): onUsage → registry.accrueUsage
  subagent-context-widget.ts      # DELETE (Task 04)
  detach-run.ts                   # CREATE (Task 05): convertToBackground + spawnDetachedChild
  subagent-run-persistence.ts     # MODIFY (Task 05): detach-handoff manifest flush
  subagent-viewer.ts              # MODIFY (Task 06): in-viewer ctrl+b key
  index.ts                        # MODIFY (Task 01/05): barrel exports (formatSubagentTrace, detach surface)
  detach-run.test.ts              # CREATE (Task 05)
  subagent-tool-render.ts         # UNCHANGED (formatSubagentTrace/latestMessageLine consumed as-is)
bun-apps/pi-agent-ext-subagent/extensions/
  subagent.ts                     # MODIFY (Task 04: unwire widget; Task 06: register ctrl+b)
bun-apps/pi-agent-ext-core-task/src/subagents/
  subagents-section.ts            # CREATE (Task 01): section + refresh timer
  subagents-section.test.ts       # CREATE (Task 01): empty/1/N snapshots
  notify.ts                       # CREATE (Task 02): diff-driven notify lines + bell
  notify.test.ts                  # CREATE (Task 02)
  dock.ts                         # CREATE (Task 08): table-driven keymap dock
  dock.test.ts                    # CREATE (Task 08)
bun-apps/pi-agent-ext-core-task/extensions/
  core-task.ts                    # MODIFY (Task 01/08): addSection + dock wiring
bun-apps/pi-agent-ext-core-task/docs/adr/
  ADR-core-task-<NNNN>-subagent-dock-focus-claim.md   # CREATE (Task 07)
bun-apps/pi-agent-ext-core-task/docs/
  smoke-subagent-dock.md          # CREATE (Task 08): manual TUI smoke script
```

Each task is independently testable; wave order 01→04, 05→06, 07→08 (07 ADR lands BEFORE 08).

---

### Task 01: Subagents section in CoreTaskStatusWidget

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/subagents/subagents-section.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/subagents/subagents-section.test.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` (addSection wiring, near existing goal/todo/wayfind/coordinator section registrations ~:87–95)
- Modify: `bun-apps/pi-agent-ext-subagent/src/index.ts` (barrel: export `formatSubagentTrace`, `latestMessageLine` from `subagent-tool-render.js` — follows the existing barrel precedent ~index.ts:81)
- Modify: `bun-apps/pi-agent-ext-core-task/package.json` (add workspace dep `@repo/pi-agent-ext-subagent` if absent: `( cd bun-apps/pi-agent-ext-core-task && bun add @repo/pi-agent-ext-subagent@workspace )` — run inside `bun-apps/` workspace)

**Interfaces:**
- Consumes: `getSharedStatusWidget(): CoreTaskStatusWidget` + `StatusSection` from `@repo/pi-agent-ext-core-task/src/shared/status-widget.js`; `SubagentInFlightRegistry` (`.views({ foreground: false }): RunView[]`) from `@repo/pi-agent-ext-core-runtime`; `renderActivityRow(view: RunView, theme: Theme, opts?): string` from `@repo/pi-agent-ext-core-runtime` (// verify exact signature/opts at implement time).
- Produces (used by Tasks 02, 04, 06, 08):
  ```ts
  export interface SubagentsSectionDeps {
    getViews: () => RunView[];              // prod: () => registry.views({ foreground: false })
    requestRender: () => void;              // prod: () => getSharedStatusWidget().update()
    setInterval?: typeof setInterval;       // injectable for tests
    clearInterval?: typeof clearInterval;
  }
  export interface SubagentsSectionHandle {
    section: StatusSection;                 // { id: "subagents", order: 4 }
    setNotifyLine: (line: string | undefined) => void;  // Task 02 consumes
    dispose: () => void;                    // stops the refresh timer
  }
  export function createSubagentsSection(deps: SubagentsSectionDeps): SubagentsSectionHandle;
  ```

- [ ] **Step 1: Write failing tests** — `subagents-section.test.ts`:
  - `test("renders zero lines when view list is empty")` — section.render(fakeTheme, 100) returns `[]`.
  - `test("renders one row per background run")` — two RunViews → header line + 2 row lines (rows contain actor names; snapshot exact strings).
  - `test("section id is subagents, order is 4")`.
  - `test("notifyLine renders as top line when set, then clears is NOT this task")` — just `setNotifyLine("x")` → renders first; `setNotifyLine(undefined)` → gone (Task 02 fills the trigger).
  - `test("refresh timer requests render only when views are non-empty")` — fake `setInterval` captures the tick fn; tick with 0 views → requestRender NOT called; with 1 view → called (idle-churn guard, mirrors subagent-context-widget.ts P5).
  - Fake RunViews: hand-built object literals matching the `RunView` interface (id, foreground:false, status:"running", actor, modelSeg, elapsedMs, elapsedFrozen:false, toolCallCount, taskPreview, history:[], startedAt, costUsd:0, tokensIn:0, tokensOut:0 — cost fields added in Task 03; add them NOW as literal zeros so Task 03 needs no test churn, with `// Task 03` comment).
- [ ] **Step 2: Run, verify FAIL** — `( cd bun-apps/pi-agent-ext-core-task && bun test src/subagents/subagents-section.test.ts )` → module not found.
- [ ] **Step 3: Implement** `subagents-section.ts`:
  ```ts
  import type { StatusSection } from "../shared/status-widget.js";
  import type { RunView } from "@repo/pi-agent-ext-core-runtime";
  import { renderActivityRow } from "@repo/pi-agent-ext-core-runtime"; // verify export name at implement time
  import type { Theme } from "@earendil-works/pi-coding-agent";

  const REFRESH_MS = 1000;
  export function createSubagentsSection(deps: SubagentsSectionDeps): SubagentsSectionHandle {
    let notifyLine: string | undefined;
    const si = deps.setInterval ?? setInterval;
    const ci = deps.clearInterval ?? clearInterval;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => { if (deps.getViews().length > 0) deps.requestRender(); };
    const section: StatusSection = {
      id: "subagents",
      order: 4, // contract: goal=0, todo=1, wayfind=2, coordinator=3, subagents=4
      render: (theme: Theme, _width: number): string[] => {
        const views = deps.getViews();
        if (views.length === 0 && !notifyLine) return [];
        const lines: string[] = [];
        if (notifyLine) lines.push(notifyLine);
        if (views.length > 0) {
          lines.push(` ${views.length} background ${views.length === 1 ? "run" : "runs"}`);
          for (const v of views) lines.push(`  ${renderActivityRow(v, theme)}`); // verify opts at implement time
        }
        return lines;
      },
    };
    timer = si(tick, REFRESH_MS);
    return { section, setNotifyLine: (l) => { notifyLine = l; deps.requestRender(); }, dispose: () => { if (timer !== undefined) ci(timer); } };
  }
  ```
  Wire in `extensions/core-task.ts`: `const handle = createSubagentsSection({ getViews: () => getSubagentInFlightRegistry().views({ foreground: false }), requestRender: () => getSharedStatusWidget().update() }); getSharedStatusWidget().addSection(handle.section);` and dispose in `session_shutdown`. Add `formatSubagentTrace`/`latestMessageLine` to the subagent barrel (Task 04/08 consume; harmless now).
- [ ] **Step 4: Run, verify PASS** — core-task gate.
- [ ] **Step 5: Commit** — `feat(core-task): subagents section (order 4) rendering background RunViews via renderActivityRow`

**Gate:** `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )` + `( cd bun-apps/pi-agent-ext-subagent && bun run test )`

---

### Task 02: Completion notification line

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/subagents/notify.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/subagents/notify.test.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/subagents/subagents-section.ts` (drive notify from view diffs)

**Interfaces:**
- Consumes: `SubagentsSectionHandle.setNotifyLine` (Task 01); `RunView` + `isTerminalStatus(status): boolean` from `@repo/pi-agent-ext-core-runtime`.
- Produces (Task 06 reuses for "detached → background"):
  ```ts
  export class SubagentNotify {
    constructor(deps: { bell?: () => void });   // default: () => process.stdout.write("\x07")
    /** Diff consecutive per-tick snapshots. Stamps AT MOST ONE pending line:
     *  - prev non-terminal → next terminal  → "✓ <actor> done · <elapsed>s · <latestAction>"
     *  - prev foreground:true → next foreground:false → "detached → background · <actor>"
     *  Bell fires exactly once per stamped line. */
    diff(prev: RunView[], next: RunView[]): void;
    /** Return pending lines and CLEAR them (fade on next render tick). */
    take(): string[];
  }
  ```

- [ ] **Step 1: Write failing tests** — `notify.test.ts`:
  - `test("completion stamps line + rings bell once")` — prev: status "running"; next: status "done", endedAt frozen → diff → take() returns one line containing actor + elapsed; bell called once; second take() returns [].
  - `test("bell not re-rung for an already-terminal run across ticks")` — diff(running, done) then diff(done, done) → bell count still 1.
  - `test("foreground→background flip stamps detached line")` — same id, prev foreground:true running, next foreground:false running → line contains "detached → background".
  - `test("no line when nothing changed")`.
  - `test("take clears — line fades on next render tick")`.
- [ ] **Step 2: Run, verify FAIL** — module not found.
- [ ] **Step 3: Implement** — `diff` builds `Map<id, RunView>` from prev, iterates next: `const p = prevMap.get(n.id)`; completion = `p && !isTerminalStatus(p.status) && isTerminalStatus(n.status)`; detach = `p?.foreground === true && n.foreground === false`. Format elapsed via `Math.round(n.elapsedMs / 1000)` + "s" and cap `latestAction` to 80 chars. Store at most one pending line (latest wins). Section change: hold `let prevViews: RunView[] = []`; at the top of `render()` do `const views = deps.getViews(); notify.diff(prevViews, views); prevViews = views; const [line] = notify.take(); if (line) setNotifyLineInternally(line)` — i.e. the line shows THIS tick and is absent next tick (render reads `notify.take()` fresh each call; do NOT cache across ticks — RunView contract).
- [ ] **Step 4: Run, verify PASS** — core-task gate.
- [ ] **Step 5: Commit** — `feat(core-task): transient completion-notify line with single bell in subagents section`

**Gate:** `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`

---

### Task 03: RunView costUsd / tokensIn / tokensOut projection

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/run-view.ts` (RunView fields + buildRunView projection)
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/subagent-in-flight.ts` (usage field + `accrueUsage`)
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/agent-row-display.ts` (row tail `· $0.04` when costUsd > 0 — // verify where the tail composes)
- Modify: `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts` (~:115–119 onUsage callback → `registry.accrueUsage(id, delta)`)
- Test: `bun-apps/pi-agent-ext-core-runtime/src/run-view.test.ts` (extend) + `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.test.ts` (extend; // verify existing test file name at implement time)

**Interfaces:**
- Consumes: `AgentUsage` delivered by the existing `onUsage` callback in `spawn-subagent.ts` (fields: cost + tokens; // verify exact field names at implement time against `core-runtime/src/agent.ts` ~:312–319).
- Produces (Tasks 01 rows, viewer rows rely automatically):
  ```ts
  // run-view.ts — RunView additions:
  readonly costUsd: number;    // accrued child cost; frozen at terminal
  readonly tokensIn: number;
  readonly tokensOut: number;
  // subagent-in-flight.ts — InFlightSubagent addition:
  usageAccrued?: { costUsd: number; tokensIn: number; tokensOut: number }; // SUM, monotonically accrued
  // registry method:
  accrueUsage(id: string, delta: { costUsd: number; tokensIn: number; tokensOut: number }): void;
  //   — no-op when the run's status is terminal (freeze mirrors elapsedFrozen);
  //   — no-op for unknown id (must never throw, mirrors update()).
  ```

- [ ] **Step 1: Write failing tests**:
  - `run-view.test.ts`: `test("buildRunView projects accrued usage")` (record with usageAccrued {0.04, 100, 200} → fields match); `test("usage fields default to 0 when absent")`; `test("accrueUsage is ignored after terminal")` — registry: start, markCompleted, accrueUsage → view() costUsd still 0; `test("accrueUsage sums deltas on a live run")` — two deltas {0.01,…}+{0.03,…} → 0.04.
  - `agent-row-display` test: row tail contains `· $0.04` when costUsd = 0.04; tail ABSENT when costUsd = 0.
- [ ] **Step 2: Run, verify FAIL** — `( cd bun-apps/pi-agent-ext-core-runtime && bun test src/run-view.test.ts )` + agent-row-display test.
- [ ] **Step 3: Implement** — `buildRunView` adds `costUsd: r.usageAccrued?.costUsd ?? 0` (same for tokens). Registry `accrueUsage`: fetch record; if `isTerminalStatus(r.status)` or missing → return; else add deltas into `r.usageAccrued ??= { costUsd: 0, tokensIn: 0, tokensOut: 0 }` then `r.invalidate?.()`. Row tail: append `· ${fmtCost(v.costUsd)}` to the activity row when `v.costUsd > 0` (// verify fmtCost import + tail composition site at implement time). `spawn-subagent.ts`: inside the existing `onUsage` callback add `getSubagentInFlightRegistry().accrueUsage(id, { costUsd: u.costUsd ?? 0, tokensIn: u.tokensIn ?? 0, tokensOut: u.tokensOut ?? 0 })` (// verify AgentUsage field spellings at implement time).
- [ ] **Step 4: Run, verify PASS** — core-runtime + subagent gates.
- [ ] **Step 5: Commit** — `feat(core-runtime,subagent): RunView costUsd/tokensIn/tokensOut projection with terminal freeze`

**Gate:** `( cd bun-apps/pi-agent-ext-core-runtime && bun run typecheck && bun test )` + `( cd bun-apps/pi-agent-ext-subagent && bun run test )`

---

### Task 04: Context-widget retirement

**Files:**
- Delete: `bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts`
- Delete: `bun-apps/pi-agent-ext-subagent/src/install-subagent-context-widget.test.ts` (// verify exact test filename at implement time)
- Modify: `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts` (remove `installSubagentContextWidget` call + the Ctrl-O `\x0f` `onTerminalInput` hook)
- Modify: `bun-apps/pi-agent-ext-core-task/src/subagents/subagents-section.ts` (migrate collapsed latest-line)
- Test: extend `bun-apps/pi-agent-ext-core-task/src/subagents/subagents-section.test.ts`

**Interfaces:**
- Consumes: `latestMessageLine(history: readonly AgentHistoryEntry[]): string | undefined` from `subagent-tool-render.ts` (already exported; now barrel-exported by Task 01).
- Produces: section rows gain a second line per run: the `latestMessageLine` under each row when history is non-empty (the unique behavior migrated from the retired widget's collapsed view).

- [ ] **Step 1: Write failing test** (in core-task): `test("row for a run with history renders the latest message line indented beneath")` — RunView with history entries (one assistant-text entry "summarizing findings") → section output contains a line `    "summarizing findings"` (quoted prose, double indent) below that run's row. Also `test("no latest line when history is empty")`.
- [ ] **Step 2: Run, verify FAIL** — core-task test fails (no latest-line rendering).
- [ ] **Step 3: Implement** — in `subagents-section.ts` row loop: `const live = latestMessageLine(v.history); if (live) lines.push(`    ${live}`);`. Then delete `subagent-context-widget.ts` + its test; in `extensions/subagent.ts` remove the import, the `installSubagentContextWidget(...)` call, its handle/dispose, and the `isCtrlO`/`\x0f` `ui.onTerminalInput` hook. Confirm `subagent-tool-render.ts` itself is UNTOUCHED (`formatSubagentTrace`, `latestMessageLine`, `capTraceTail` keep their inline/viewer consumers). Run `( cd bun-apps && grep -rn $'\x0f' pi-agent-ext-subagent/src pi-agent-ext-subagent/extensions )` → no matches.
- [ ] **Step 4: Run, verify PASS** — subagent + core-task gates (viewer tests untouched and green).
- [ ] **Step 5: Commit** — `refactor(subagent,core-task): retire subagent-context-widget; migrate collapsed latest-line into subagents section`

**Gate:** `( cd bun-apps/pi-agent-ext-subagent && bun run test )` + `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`

---

### Task 05: Detach pipeline (foreground → background)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/detach-run.ts`
- Test: `bun-apps/pi-agent-ext-subagent/src/detach-run.test.ts`
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/subagent-in-flight.ts` (registry `markDetached`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-run-persistence.ts` (detach hand-off flush; // verify existing API at implement time)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts` (awaited tool call resolves with "detached" outcome when the registry entry is detached)
- Modify: `bun-apps/pi-agent-ext-subagent/src/index.ts` (export the detach surface)

**Interfaces (NEW public surface — exact):**
  ```ts
  // detach-run.ts
  export interface DetachedSpawnSpec {
    id: string; agent?: string; task: string; cwd: string; manifestPath: string;
  }
  export interface DetachedChildHandle { pid: number | undefined; kill(): void }
  export type DetachedSpawn = (spec: DetachedSpawnSpec) => DetachedChildHandle;
  export interface DetachOutcome { ok: true; runId: string } | { ok: false; error: string }
  export interface DetachDeps {
    registry: SubagentInFlightRegistry;
    spawnDetached: DetachedSpawn;       // prod: spawnDetachedChild below
    persistRun: (id: string) => string; // flushes the run's live history/task to a resume manifest; returns path
  }
  export function convertToBackground(id: string, deps: DetachDeps): DetachOutcome;
  export function spawnDetachedChild(spec: DetachedSpawnSpec): DetachedChildHandle;
  // registry (core-runtime):
  markDetached(id: string, opts?: { abort?: () => void }): boolean;
  //   — flips foreground=false, stamps detached=true (new optional InFlightSubagent field),
  //     rebinds `abort` to opts.abort when given; returns false for unknown id.
  // subagent-tool-run.ts awaited-outcome type gains: "detached"
  ```

**Design (explicit, per spec §3 / ticket 05):** on detach the child SURVIVES as a **new OS subprocess spawned `detached: true` + `unref()`** which resumes the run from a persistence manifest flushed at detach time; the **registry keeps the entry live** (foreground flips false → the run appears in the Task-01 section immediately); **persistence owns recovery** (resume-safe manifest is the source of truth; if the parent dies the subprocess finishes and the manifest records the result); the **parent releases WITHOUT killing** — the awaited tool call resolves with outcome `"detached"` and the parent turn resumes.

- [ ] **Step 1: Write failing tests** — `detach-run.test.ts`:
  - `test("child-alive-after-detach: spawned child is not killed when parent releases")` — fake registry + fake spawnDetached recording `kill` calls; convertToBackground → assert spawnDetached called once, `kill` NOT called, and the resolved tool outcome (captured via a stubbed release fn or by asserting registry state) is "detached".
  - `test("registry entry stays live and flips to background")` — real `SubagentInFlightRegistry`: start foreground run → convertToBackground → `registry.view(id)` exists, `foreground === false`, `detached === true`.
  - `test("abort rebinds to the detached child")` — after detach, `registry.abort(id)` calls the fake child's kill (exactly once).
  - `test("unknown id / already background / terminal → { ok: false, error }")` — three cases.
  - `test("detach persistence round-trip: manifest path handed to spawn and resumable")` — fake persistRun returns a path; assert spec.manifestPath === it; separately, a real-persistence test (// verify existing persistence test harness at implement time) that a detached manifest can be reconstructed.
  - Registry unit tests (core-runtime): `markDetached` unknown id → false; flips fields.
- [ ] **Step 2: Run, verify FAIL** — `( cd bun-apps/pi-agent-ext-subagent && bun test src/detach-run.test.ts )`.
- [ ] **Step 3: Implement** — the conversion function, verbatim shape:
  ```ts
  export function convertToBackground(id: string, deps: DetachDeps): DetachOutcome {
    const view = deps.registry.view(id);
    if (!view) return { ok: false, error: `unknown run: ${id}` };
    if (!view.foreground) return { ok: false, error: `run ${id} is already background` };
    if (isTerminalStatus(view.status)) return { ok: false, error: `run ${id} already terminal` };
    // 1) persistence owns recovery: flush live history/task to a resume manifest FIRST
    const manifestPath = deps.persistRun(id);
    // 2) child survives: detached OS subprocess resumes from the manifest
    const child = deps.spawnDetached({ id, agent: view.actor, task: view.taskPreview, cwd: process.cwd(), manifestPath });
    // 3) registry keeps the entry live; foreground flips false (→ Task-01 section); abort rebinds
    deps.registry.markDetached(id, { abort: () => child.kill() });
    // 4) parent releases WITHOUT kill: the awaited tool call resolves "detached"
    //    (subagent-tool-run.ts polls/observes `detached` on the registry entry)
    return { ok: true, runId: id };
    // verify at implement time: how subagent-tool-run's await observes the flag —
    // likely an onDetach callback registered alongside abort; wire it here.
  }

  export function spawnDetachedChild(spec: DetachedSpawnSpec): DetachedChildHandle {
    // verify at implement time: the resume CLI entry + args (subagent-run-persistence.ts owner)
    const proc = spawn(process.execPath, [RESUME_ENTRY, "resume", "--manifest", spec.manifestPath, "--id", spec.id], {
      detached: true,   // new process group — survives parent turn/session end
      stdio: "ignore",
      cwd: spec.cwd,
    });
    proc.unref();       // parent may exit; event loop is NOT held
    return { pid: proc.pid, kill: () => proc.kill("SIGTERM") };
  }
  ```
  Registry: add `detached?: boolean` to `InFlightSubagent` + `markDetached` per interface. `subagent-tool-run.ts`: when the registry entry's `detached` flag appears mid-await, resolve the tool result with outcome `"detached"` (text: `Subagent detached → background (run ${id}; still live in the status section / /subagents)`). Barrel-export `convertToBackground`, `spawnDetachedChild`, and the types.
- [ ] **Step 4: Run, verify PASS** — subagent + core-runtime gates.
- [ ] **Step 5: Commit** — `feat(subagent): detach pipeline — detached+unref child, registry stays live, persistence owns recovery, parent releases with "detached" outcome`

**Gate:** `( cd bun-apps/pi-agent-ext-subagent && bun run test )` + `( cd bun-apps/pi-agent-ext-core-runtime && bun run typecheck && bun test )`

---

### Task 06: Claimable ctrl+b shortcut (global + in-viewer)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts` (`pi.registerShortcut` for ctrl+b)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (in-viewer ctrl+b for the focused run)
- Test: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.test.ts` (extend) + new shortcut-dispatch unit test file `bun-apps/pi-agent-ext-subagent/src/ctrl-b-dispatch.test.ts`

**Interfaces:**
- Consumes: `convertToBackground(id, deps): DetachOutcome` (Task 05); the notify trigger = the registry `foreground:true → false` diff (Task 02's `SubagentNotify` rule — no new cross-package seam).
- Produces (Task 08 dock reuses): a shared selection helper in the subagent package:
  ```ts
  // exported from index.ts
  export function foregroundRunIds(registry: SubagentInFlightRegistry): string[];
  // ids of live foreground runs, oldest startedAt first (the ctrl+b default target)
  ```

- [ ] **Step 1: Write failing tests**:
  - `test("ctrl+b dispatch detaches the oldest foreground run")` — registry with two foreground runs; dispatch → convertToBackground called with the older id (inject a fake convert fn — define `dispatchCtrlB(registry, convert)` in `extensions/subagent.ts` scope or a tiny `src/ctrl-b.ts` module; test the dispatch logic table-driven, no real terminal).
  - `test("ctrl+b with no foreground run is a no-op (no throw)")`.
  - `test("in-viewer ctrl+b detaches the FOCUSED run, not the oldest")` — viewer key handler with focused id X while older run Y exists → convert called with X.
  - `test("post-detach notify fires once via the foreground-flip rule")` — Task-02 notify test shape: prev foreground true, next false → exactly one "detached → background" line (already covered in notify.test.ts; here assert the section's diff sees the flip after dispatch).
  - `test("no conflict with existing viewer keymap")` — existing viewer key tests green untouched.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — `extensions/subagent.ts`: `pi.registerShortcut({ key: "ctrl+b", description: "subagent: detach foreground run to background", handler: () => dispatchCtrlB(...) })` (// verify registerShortcut's exact option shape at implement time — claimable/when semantics). `subagent-viewer.ts`: add `"ctrl+b"` to its key dispatch (alongside the existing `x` abort path — // verify key-handling site at implement time) calling `convertToBackground(focusedId, deps)` with the same prod `DetachDeps` assembly as the global path (factor a `makeProdDetachDeps(): DetachDeps` helper exported from `detach-run.ts` so both sites share it).
- [ ] **Step 4: Run, verify PASS** — subagent gate.
- [ ] **Step 5: Commit** — `feat(subagent): claimable ctrl+b detach — global (oldest foreground) + in-viewer (focused run)`

**Gate:** `( cd bun-apps/pi-agent-ext-subagent && bun run test )`

---

### Task 07: Focus-claim ADR + protocol (BEFORE Task 08 — no implementation)

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/docs/adr/ADR-core-task-NNNN-subagent-dock-focus-claim.md` (NNNN = next number in that package's ADR dir — verify at implement time; ID declared on line 1)
- Modify: `bun-apps/pi-agent-ext-core-task/docs/adr/INDEX.md` (// verify index file name at implement time; `bun-apps/docs/adr/INDEX.md` lists all contexts)

**Interfaces:**
- Consumes: none (documentation).
- Produces: the ADR text below, verbatim skeleton — Task 08 implements exactly this protocol.

- [ ] **Step 1: Write the ADR** — full skeleton:

  ```markdown
  # ADR-core-task-NNNN: Subagent dock focus via onTerminalInput prefix-claim

  ## Status
  Accepted (2026-08-15) — implements `.planning/2026-08-15-cc-subagent-tui/` tickets 07–08.

  ## Context
  The TUI routes raw input only to the single `focusedComponent` (the editor); a
  `setWidget`-factory dock component's `handleInput?` is never invoked (REVIEW
  2026-08-15 subagent finding #1 — the retired subagent-context-widget was
  non-focusable and resorted to a `\x0f` byte-sniff). We need interactive keys on
  the subagents section WITHOUT any pi-core upstream change.

  ## Decision
  The dock claims focus by PREFIX-CLAIM on `ui.onTerminalInput` (raw-byte path —
  no focus required, per the key-path guidance previously recorded at
  subagent-context-widget.ts:24–25):
  - Entry: `Ctrl-G` (`\x07`) followed by `s` arms dock focus mode; the dock then
    CONSUMES subsequent keys until release.
  - Release: `Esc` (`\x1b`) returns the dock to passive and stops consuming.
  Keymap (table-driven, dock.ts owns it):
  | Key      | Action                                          |
  |----------|-------------------------------------------------|
  | j / k    | scroll selection down / up                      |
  | x        | abort selected run → y/n confirm (x arms, y fires, n cancels) |
  | e        | expand trace overlay (`formatSubagentTrace`)    |
  | ctrl+b   | detach selected run (`convertToBackground`)     |
  | Enter    | jump to `/subagents` viewer focused on the run  |
  | Esc      | release focus claim                             |
  Zero upstream pi-core changes. Esc-interrupt of the agent (native Esc) is
  untouched: the dock consumes Esc ONLY while it holds the claim.

  ## Consequences
  - While the claim is held, dock keys never reach the editor (consume: true);
    after release no key leaks (single Esc consumed, then passive).
  - A future upstream focus API (component-level focus routing) supersedes the
    prefix claim; the migration path is recorded in
    docs/research-tui-agent-webui-hybrids.md (#1384) — the dock's public
    interface (createSubagentDock) is designed so ONLY the input-claim wiring
    changes, not the keymap or render.
  - The byte-level claim is terminal-encoding dependent (raw C0 bytes); tested
    via the onTerminalInput unit seam, never against a real terminal.
  ```

- [ ] **Step 2: Verify** — `( cd bun-apps && bun run test:adr )` passes (ADR resolves to exactly one ID); core-task typecheck green (no code changed).
- [ ] **Step 3: Commit** — `docs(core-task): ADR — subagent dock focus-claim protocol (Ctrl-G s prefix claim, zero upstream)`

**Gate:** `( cd bun-apps && bun run test:adr )` + `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck )`

---

### Task 08: Dock mode implementation (core-task)

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/subagents/dock.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/subagents/dock.test.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` (wire `ui.onTerminalInput` claim + dock render line into the section)
- Create: `bun-apps/pi-agent-ext-core-task/docs/smoke-subagent-dock.md` (manual smoke script)

**Interfaces:**
- Consumes: ADR protocol (Task 07); `formatSubagentTrace(history, elapsedMs, toolCallCount): string` from `@repo/pi-agent-ext-subagent` (Task-01 barrel); `convertToBackground`, `makeProdDetachDeps` from `@repo/pi-agent-ext-subagent` (Task 05/06); registry `.views({ foreground: false })`, `.abort(id)` from `@repo/pi-agent-ext-core-runtime`.
- Produces (exact, the dock's whole public surface):
  ```ts
  export type DockActionName =
    | "enter" | "release" | "scrollDown" | "scrollUp" | "abortArm"
    | "abortConfirm" | "abortCancel" | "expand" | "detach" | "jump";
  export interface DockKeyBinding { key: string; action: DockActionName }
  export const DOCK_KEYMAP: readonly DockKeyBinding[];  // the ADR table, data
  export interface DockDeps {
    getViews(): RunView[];
    abort(id: string): void;
    detach(id: string): void;           // convertToBackground wrapper
    openViewer(id: string): void;       // Enter jump — // verify viewer-open lever at implement time
    requestRender(): void;
  }
  export interface SubagentDock {
    /** Returns true when the dock consumed the input (claim held). */
    handleInput(data: string): boolean;
    isFocused(): boolean;
    selectedId(): string | undefined;
    /** Header hint line when focused (rendered at the TOP of the section). */
    renderHint(theme: Theme): string;
    /** Trace overlay lines when expanded, else []. */
    renderOverlay(theme: Theme, width: number): string[];
    dispose(): void;
  }
  export function createSubagentDock(deps: DockDeps): SubagentDock;
  ```

- [ ] **Step 1: Write failing tests** — `dock.test.ts`, table-driven key routing (no real terminal — plain string inputs):
  - `test("Ctrl-G s enters focus; subsequent j is consumed")` — `handleInput("\x07")` then `handleInput("s")` → focused; `handleInput("j")` → true + selection moved.
  - `test("Esc releases; next key NOT consumed")` — `handleInput("\x1b")` → false; `handleInput("j")` → false (no leak after release).
  - `test("every DOCK_KEYMAP entry routes to its action")` — for each binding: focused dock, selected run present, spy deps → expected dep called / state changed (`j`→scrollDown selection index, `k`→up, `x`→armed-confirm state, `y` after `x`→abort(id), `n` after `x`→cancel, `e`→renderOverlay non-empty (RunView with history), `\x02`→detach(id), `\r`→openViewer(id)).
  - `test("x without y does not abort")`.
  - `test("selection clamps to view list bounds; empty views → keys are no-ops but still consumed")`.
  - `test("DOCK_KEYMAP matches the ADR table exactly")` — literal expected array.
  - `test("unfocused dock consumes nothing except the Ctrl-G prefix")`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — `DOCK_KEYMAP = [{key:"\x07"+"s",action:"enter"},{key:"\x1b",action:"release"},{key:"j",action:"scrollDown"},{key:"k",action:"scrollUp"},{key:"x",action:"abortArm"},{key:"y",action:"abortConfirm"},{key:"n",action:"abortCancel"},{key:"e",action:"expand"},{key:"\x02",action:"detach"},{key:"\r",action:"jump"}]`; `handleInput` = state machine: not focused → arm on `\x07`, enter on next `s` (anything else disarms, consume both); focused → look up binding, dispatch (abortArm sets `confirmAbort=true`; abortConfirm fires `deps.abort(selected)` only when armed), unknown keys consumed-but-ignored while focused; `renderHint` = ` ⎇ dock focused · j/k scroll · x abort · e trace · ctrl+b detach · ⏎ viewer · esc release ` (theme-dim); `renderOverlay` = `capTraceTail(formatSubagentTrace(v.history, v.elapsedMs, v.toolCallCount).split("\n"), STREAMING_EXPANDED_TAIL)` indented (`// verify capTraceTail/STREAMING_EXPANDED_TAIL export from subagent barrel at implement time — add to barrel in this task if Task 01 didn't`). Wiring in `extensions/core-task.ts`: `ui.onTerminalInput?.((data) => dock.handleInput(data))` (// verify consume-return convention at implement time — if the hook expects `{consume}` return, adapt the adapter, not the dock) + prepend `dock.renderHint(theme)` / append `dock.renderOverlay(...)` inside the section's render.
- [ ] **Step 4: Run, verify PASS** — core-task + subagent gates.
- [ ] **Step 5: Write + run the smoke script** — `docs/smoke-subagent-dock.md`: launch `bun run --cwd bun-apps/gui-movie-director dev`-style real session (per repo startup), dispatch a long foreground subagent, then step through: Ctrl-G s focus → j/k scroll → e trace → ctrl+b detach (row moves to section background + notify line) → Enter viewer jump → Esc release. Record pass/fail per step. Execute once.
- [ ] **Step 6: Commit** — `feat(core-task): subagent dock — Ctrl-G s prefix-claim focus, table-driven keymap, trace overlay, detach + viewer jump`

**Gate:** `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )` + `( cd bun-apps/pi-agent-ext-subagent && bun run test )` + smoke script executed

---

## Self-Review (completed)

- **Spec coverage:** §2 tickets 01–04 → Tasks 01–04 (notify bell/fade ✓, cost freeze ✓, retirement + latest-line migration ✓); §3 → Tasks 05–06 (detached+unref child, registry live, persistence recovery, parent release without kill ✓; global+in-viewer ctrl+b, notify reuse ✓); §4 → Tasks 07–08 (ADR first ✓, table-driven keymap ✓, zero upstream ✓, smoke script ✓); §5 non-goals encoded in Global Constraints; §6 gates quoted verbatim per task.
- **Placeholders:** none — every code step has real content; `// verify … at implement time` marks only pre-existing call-site details the plan does not define.
- **Type consistency:** `SubagentsSectionHandle.setNotifyLine` (01) consumed by 02; `SubagentNotify.diff` detach rule (02) reused by 06; `convertToBackground`/`DetachDeps`/`makeProdDetachDeps` (05) consumed by 06 + 08; `DOCK_KEYMAP` (08) matches ADR table (07); `RunView` cost fields (03) pre-stubbed as zeros in Task-01 fixtures.
- **Fixes applied during review:** barrel export of `capTraceTail`/`STREAMING_EXPANDED_TAIL` moved from "assume present" to an explicit Task-08 step; Task-01 test fixtures pre-declare Task-03 cost fields to avoid cross-task churn.
