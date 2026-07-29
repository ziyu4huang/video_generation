# `/subagents` Viewer List-View Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/subagents` viewer's completed-runs list scannable, searchable, and bounded — add wall-clock timestamps, richer rows, an inline fzf-style filter, and a 20-most-recent cap with show-all.

**Architecture:** All behavior lives behind the existing `SubagentViewer` injection seam (identity-theme unit tests — no live TUI). A new pure `time-format` module supplies relative + absolute formatters. A backward-compatible `startedAt` field flows from the tool executor through the reconstructed run record to the row/detail renderers. Filter + cap compose inside `entries()`; an active filter suspends the cap.

**Tech Stack:** TypeScript, `bun:test`, the shared activity-row renderer (`agent-row-display.ts`), pi TUI `Key`/`truncateToWidth` primitives.

## Global Constraints

- Backward-compatible schema change only: `startedAt?: number` is **optional** everywhere; absence degrades to "no timestamp" (no crash, no `undefined` leak).
- Tests use the existing identity-theme injection harness — **no host-TUI, no live subagent, no real `Date.now()` in assertions** (relative-time tests inject `nowMs`).
- No model ids are hardcoded (resolve from config; the viewer only displays model strings it is given).
- Follow-view and output-view **body** are untouched; only the output-view **header** gains an absolute time.
- Running-first ordering is unchanged (top `Running` section stays).

---

## File Structure

**Create:**
- `bun-apps/pi-agent-ext-subagent/src/time-format.ts` — pure relative + absolute time formatters (single source of truth).
- `bun-apps/pi-agent-ext-subagent/tests/time-format.test.ts` — formatter unit tests.

**Modify:**
- `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` — add `startedAt?: number` to `SubagentToolDetails` (L35) and populate it from `t0` in the details object (L634). Also the early-return details (L454) — add `startedAt: t0` there for consistency.
- `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` — `SubagentRun` gains `startedAt?: number`; `reconstructSubagentRuns` reads `d?.startedAt`; `renderList` richer completed rows + relative time + cap footer + filter status line; `renderOutput` absolute-time header; `handleInput` filter routing + show-all key; `entries()` filter + cap.
- `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts` — new tests for startedAt propagation, richer rows, filter, cap.

**Re-export:** `bun-apps/pi-agent-ext-subagent/src/index.ts` already re-exports `SubagentToolDetails` from `subagent-tool.js` (L115) — no change needed; `startedAt` rides along.

---

## Task 1: Time formatters (relative + absolute)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/time-format.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/time-format.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `formatRelativeTime(startedAtMs: number, nowMs?: number): string` — delta buckets: `<60s`→`"just now"`, `<60m`→`"Nm ago"`, `<24h`→`"Nh ago"`, else→`"Nd ago"`. `nowMs` defaults to `Date.now()`; tests inject it for determinism.
  - `formatAbsoluteTime(epochMs: number): string` — local `"HH:MM"` via `toLocaleTimeString`.

- [ ] **Step 1: Write the failing test**

Create `tests/time-format.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatAbsoluteTime, formatRelativeTime } from "../src/time-format.js";

const NOW = 1_700_000_000_000; // fixed reference "now"

test("formatRelativeTime buckets", () => {
  assert.equal(formatRelativeTime(NOW - 5_000, NOW), "just now");        // <60s
  assert.equal(formatRelativeTime(NOW - 120_000, NOW), "2m ago");        // <60m
  assert.equal(formatRelativeTime(NOW - 3 * 3_600_000, NOW), "3h ago");  // <24h
  assert.equal(formatRelativeTime(NOW - 2 * 86_400_000, NOW), "2d ago"); // >=24h
});

test("formatAbsoluteTime looks like HH:MM", () => {
  assert.match(formatAbsoluteTime(NOW), /^\d{1,2}:\d{2}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/time-format.test.ts`
Expected: FAIL — "Cannot find module '../src/time-format.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/time-format.ts`:

```ts
/**
 * Glanceable relative + absolute time formatters for the /subagents viewer.
 * `formatRelativeTime` takes an injectable `nowMs` so tests are deterministic.
 */
export function formatRelativeTime(startedAtMs: number, nowMs: number = Date.now()): string {
  const delta = Math.max(0, nowMs - startedAtMs);
  const sec = 1000;
  const min = 60 * sec;
  const hr = 60 * min;
  const day = 24 * hr;
  if (delta < min) return "just now";
  if (delta < hr) return `${Math.floor(delta / min)}m ago`;
  if (delta < day) return `${Math.floor(delta / hr)}h ago`;
  return `${Math.floor(delta / day)}d ago`;
}

export function formatAbsoluteTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/time-format.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/time-format.ts bun-apps/pi-agent-ext-subagent/tests/time-format.test.ts
git commit -m "feat(subagent): add relative + absolute time formatters for /subagents"
```

---

## Task 2: `startedAt` schema + run-record propagation

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts:35` (type), `:454` and `:634` (populate from `t0`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (`SubagentRun` type + `reconstructSubagentRuns`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: Task 1 (not yet — this task only carries the value; rendering is Task 3).
- Produces:
  - `SubagentToolDetails.startedAt?: number` (epoch ms).
  - `SubagentRun.startedAt?: number` — set by `reconstructSubagentRuns` from `details?.startedAt`; absent when details omit it.

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent-viewer.test.ts`:

```ts
test("reconstructSubagentRuns carries startedAt through from details", () => {
  const branch = [
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
      startedAt: 1_700_000_000_000,
    } as Partial<SubagentToolDetails>),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs[0].startedAt, 1_700_000_000_000);
});

test("reconstructSubagentRuns leaves startedAt undefined when details omit it (legacy)", () => {
  const branch = [
    toolResultEntry("subagent", "legacy", { exitCode: 0, timedOut: false } as Partial<SubagentToolDetails>),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs[0].startedAt, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: FAIL — `runs[0].startedAt` is `undefined` in both (property does not exist on the type / value not copied).

- [ ] **Step 3: Write minimal implementation**

In `src/subagent-tool.ts`, add the field to the interface (after `elapsedMs`):

```ts
  /** Wall-clock of the run, ms. */
  elapsedMs: number;
  /** Wall-clock dispatch start, epoch ms — for /subagents timestamp display. */
  startedAt?: number;
  status: "done" | "failed" | "timedout" | "budget";
```

Populate it in BOTH details-assembly sites (the early-return details object ~L454 and the main details object ~L634). Find each object literal that sets `elapsedMs` and add `startedAt: t0,` next to it, e.g.:

```ts
        details: {
          // …existing fields…
          taskPreview: taskPreview(params.task),
          elapsedMs: Date.now() - t0,
          startedAt: t0,
          // …
```
and the main `const details: SubagentToolDetails = { … }` (~L634): add `startedAt: t0,`.

(`t0` is the dispatch-start timestamp already captured at the top of `execute()` and in scope at both sites — see `elapsedMs: Date.now() - t0` already present.)

In `src/subagent-viewer.ts`, add the field to `SubagentRun` (after `elapsedMs`):

```ts
  elapsedMs: number;
  /** Wall-clock dispatch start, epoch ms (for timestamp display); absent on legacy branch entries. */
  startedAt?: number;
  /** Real token/cost usage, when reported. */
  usage?: AgentUsage;
```

and read it in `reconstructSubagentRuns` (the `runs.push({ … })` block):

```ts
    runs.push({
      index: i,
      toolCallId: msg.toolCallId,
      agent: d?.agent,
      model: d?.model ?? "default",
      taskPreview: d?.taskPreview ?? "",
      status,
      elapsedMs: d?.elapsedMs ?? 0,
      startedAt: d?.startedAt,
      usage: d?.usage,
      output: msg.content?.find((c) => c.type === "text")?.text ?? "",
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: PASS — both new tests green; existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagent): record startedAt on subagent tool details + run record"
```

---

## Task 3: Richer completed rows (relative time + meta) + absolute detail header

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` — `renderList` completed-row builder; `renderOutput` header.
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: Task 1 (`formatRelativeTime`, `formatAbsoluteTime`); Task 2 (`SubagentRun.startedAt`).
- Produces: completed rows render `relative-time · short-model · elapsed · cost` in the meta line (via the existing shared `renderActivityRow`); the output-view header renders an absolute `HH:MM`.

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent-viewer.test.ts`:

```ts
test("viewer list completed row shows relative time + model + elapsed + cost", () => {
  const startedAt = Date.now() - 5 * 60_000; // 5m ago
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 2100,
      status: "done",
      startedAt,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0.03 },
    } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("5m ago"), "row shows relative start time");
  assert.ok(out.includes("flash"), "row shows short model");
  assert.ok(out.includes("2.1s"), "row shows elapsed");
  assert.ok(out.includes("$0.03"), "row shows cost");
});

test("viewer output header shows absolute HH:MM start time", () => {
  const startedAt = new Date(2024, 0, 1, 14, 32).getTime();
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
      startedAt,
    } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("\r"); // enter → output view
  const out = viewer.render(80).join("\n");
  assert.match(out, /\b14:32\b/, "output header shows absolute start time");
});

test("viewer completed row degrades gracefully when startedAt/model/cost are absent", () => {
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", { exitCode: 0, timedOut: false, status: "done" } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(!out.includes("undefined"), "no undefined leaks");
  assert.ok(out.includes("default"), "falls back to the default model label");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: FAIL — completed rows currently render no time/model/cost meta (the `renderList` completed-row builder passes only `{ status, actor, badge, detail }`).

- [ ] **Step 3: Write minimal implementation**

In `src/subagent-viewer.ts`, import the formatters:

```ts
import { formatAbsoluteTime, formatRelativeTime } from "./time-format.js";
```

In `renderList`, replace the completed-row builder so it passes the meta the shared renderer already supports. The existing block is:

```ts
      for (const e of completed) {
        const r = e.ref;
        const cur = entries.indexOf(e) === this.selected;
        const row: ActivityRow = {
          status: r.status,
          actor: r.agent ?? "general-purpose",
          badge: `#${r.index}`,
          detail: r.taskPreview,
        };
        const head = renderActivityRow(row, th, 50);
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
      }
```

Change the `row` object to carry the new meta (the shared `renderActivityRow` already joins model/tokens/cost/elapsed into the meta line):

```ts
        const row: ActivityRow = {
          status: r.status,
          actor: r.agent ?? "general-purpose",
          badge: `#${r.index}`,
          model: shortModel(r.model),
          elapsedMs: r.elapsedMs,
          cost: r.usage?.cost,
          // latestAction is absent for completed → detail (taskPreview) shows as the tail
          detail: r.taskPreview
            ? `${r.startedAt ? `${formatRelativeTime(r.startedAt)} — ` : ""}${r.taskPreview}`
            : r.startedAt
              ? formatRelativeTime(r.startedAt)
              : undefined,
        };
```

(Add `shortModel` to the existing `import { … } from "./agent-row-display.js"` line — it is already exported there.)

> Why fold relative-time into `detail` rather than a new field: the shared renderer prints `detail` as the row tail, and `model/elapsed/cost` as the meta group — this yields the row shape `#3 ✓ actor · flash · 2.1s · $0.03 — 5m ago — task A` in one line without touching the shared renderer.

In `renderOutput`, add the absolute time to the header. Find the header line (it builds `#index agent ▸ model • status • elapsed • usage`) and prepend the absolute start when present:

```ts
    const absTime = r.startedAt ? ` • ${formatAbsoluteTime(r.startedAt)}` : "";
    lines.push(
      truncateToWidth(
        `  ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${r.model} • ${r.status} • ${(r.elapsedMs / 1000).toFixed(1)}s${absTime}${usageStr}`,
        width,
      ),
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: PASS — all three new tests green; the existing "viewer list shows all runs" test still passes (its `#1`/`#2`/`task A` assertions are unaffected).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagent): richer /subagents completed rows + absolute time in output header"
```

---

## Task 4: Inline fzf-style filter (taskPreview + agent)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` — new `filter` field; `handleInput` routing; `entries()` filtering; filter status line in `renderList`.
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: nothing new (operates on existing entry fields).
- Produces: typing narrows the list to entries whose `taskPreview` OR `agent` contains the query (case-insensitive); non-matches hidden; `esc` clears the filter (a second `esc` closes); `backspace` pops.

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent-viewer.test.ts`:

```ts
function completedRuns(n: number, agent = "implementer", preview = "task") {
  return reconstructSubagentRuns(
    Array.from({ length: n }, (_, i) =>
      toolResultEntry("subagent", `report ${i}`, {
        exitCode: 0,
        timedOut: false,
        agent,
        model: "x/flash",
        taskPreview: `${preview} ${i}`,
        elapsedMs: 1000,
        status: "done",
      } as Partial<SubagentToolDetails>),
    ) as never,
  );
}

test("filter: typing narrows the list to matches; non-matches hidden", () => {
  const runs = [
    ...completedRuns(1, "implementer", "auth"),
    ...completedRuns(1, "reviewer", "search"),
  ];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a"); viewer.handleInput("u"); viewer.handleInput("t"); viewer.handleInput("h");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("auth 0"), "auth run matches");
  assert.ok(!out.includes("search"), "non-match hidden");
});

test("filter: matches the agent label too (case-insensitive)", () => {
  const runs = [
    ...completedRuns(1, "implementer", "auth"),
    ...completedRuns(1, "Reviewer", "search"),
  ];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("r"); viewer.handleInput("e"); viewer.handleInput("v");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("search"), "matched via agent label Reviewer");
  assert.ok(!out.includes("auth 0"), "non-match hidden");
});

test("filter: backspace widens the list", () => {
  const runs = [...completedRuns(1, "implementer", "auth"), ...completedRuns(1, "reviewer", "search")];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a"); viewer.handleInput("u");
  viewer.handleInput("\x7f"); // backspace
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("search"), "back to full list after backspace");
});

test("filter: esc clears the filter (first esc) then closes (second esc)", () => {
  let closed = false;
  const runs = [...completedRuns(1, "implementer", "auth")];
  const viewer = new SubagentViewer({ runs, onClose: () => { closed = true; } }, T);
  viewer.handleInput("a");
  viewer.handleInput("\x1b"); // first esc → clear filter, NOT close
  assert.equal(closed, false);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("auth 0"), "filter cleared, run visible again");
  viewer.handleInput("\x1b"); // second esc (filter empty) → close
  assert.equal(closed, true);
});

test("filter: renders a status line with the query and match count", () => {
  const runs = [...completedRuns(1, "implementer", "auth")];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a"); viewer.handleInput("u");
  const out = viewer.render(80).join("\n");
  assert.match(out, /filter/i);
  assert.ok(out.includes("au"), "status line shows the query");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: FAIL — typing currently does nothing (no `filter` field, no input routing); lists stay full; `closed` flips on first esc.

- [ ] **Step 3: Write minimal implementation**

In `src/subagent-viewer.ts`, add a `filter` field to the class:

```ts
  private filter = "";
```

Rewrite `handleInput` so the list-view branch routes printable/backspace/esc-with-filter before nav. Replace the existing `handleInput` body with:

```ts
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "list") {
        if (this.filter) {
          this.filter = ""; // first esc clears the filter, stays in list
          this.selected = 0;
          this.invalidate();
        } else {
          this.onClose();
        }
      } else {
        this.view = "list";
        this.clearFollow();
        this.invalidate();
      }
      return;
    }
    if (this.view !== "list") return; // follow/output: no nav/filter keys in v1
    // filter input
    if ((data === "\x7f" || data === "\x08") && this.filter) {
      this.filter = this.filter.slice(0, -1);
      this.selected = 0;
      this.invalidate();
      return;
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      this.filter += data;
      this.selected = 0;
      this.invalidate();
      return;
    }
    // nav (operates on the filtered entries)
    const entries = this.entries();
    if (this.selected > entries.length - 1) this.selected = Math.max(0, entries.length - 1);
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < entries.length - 1) {
      this.selected += 1;
      this.invalidate();
    } else if (matchesKey(data, Key.enter) && entries.length > 0) {
      const e = entries[this.selected];
      if (!e) return;
      if (e.kind === "running") {
        this.enterFollow(e.ref.id);
      } else {
        this.outputRun = e.ref;
        this.view = "output";
        this.invalidate();
      }
    }
  }
```

Update `entries()` to filter both running and completed by the query (case-insensitive substring over `agent` + `taskPreview`):

```ts
  private entries(): Array<{ kind: "running"; ref: InFlightSubagent } | { kind: "completed"; ref: SubagentRun }> {
    const q = this.filter.trim().toLowerCase();
    const matches = (agent: string | undefined, preview: string): boolean =>
      !q || (agent ?? "").toLowerCase().includes(q) || preview.toLowerCase().includes(q);
    const running = (this.getRunning?.() ?? []).filter((r) => matches(r.agent, r.taskPreview));
    const completed = this.runs.filter((r) => matches(r.agent, r.taskPreview));
    return [
      ...running.map((ref) => ({ kind: "running" as const, ref })),
      ...completed.map((ref) => ({ kind: "completed" as const, ref })),
    ];
  }
```

In `renderList`, after building the completed section, render a filter status line when the filter is active (replacing/augmenting the nav hint). Find the nav-hint line:

```ts
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view/follow • esc close")}`, width));
```

Replace with a conditional:

```ts
    if (this.filter) {
      const n = entries.length;
      lines.push(truncateToWidth(`  ${th.fg("accent", `filter:`)} "${this.filter}" — ${n} match${n === 1 ? "" : "es"} • esc clear`, width));
    } else {
      lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view/follow • esc close")}`, width));
    }
```

(Also: `clearFollow()` already resets follow state; on `esc` from follow back to list, clear the filter too so re-entering the list is unfiltered — add `this.filter = ""` inside `clearFollow()`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: PASS — all five filter tests green; existing list/output/follow tests unchanged (no filter active → full list).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagent): inline fzf-style filter in /subagents list view"
```

---

## Task 5: Cap 20 most-recent + show-all (cap suspended when filtering)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` — `entries()` cap; `showAll` field + `a`-key toggle; `renderList` footer.
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: Task 4 (`entries()` filtering).
- Produces: with an empty filter, completed entries are limited to the 20 most-recent (last 20 by dispatch order); a `showing 20 of N` footer + `a` key to reveal all. With a non-empty filter the cap is suspended (all matches shown).

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent-viewer.test.ts`:

```ts
const CAP = 20;

test("cap: empty filter limits completed to the 20 most-recent; footer shows the count", () => {
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes(`showing ${CAP} of 25`), "footer reports the cap");
  assert.ok(out.includes("task 24"), "most-recent run (#25 → 'task 24') visible");
  assert.ok(!out.includes("task 0"), "oldest run beyond the cap is hidden");
});

test("cap: 'a' reveals all completed runs", () => {
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("task 0"), "oldest run visible after show-all");
  assert.ok(!out.includes("showing"), "no cap footer when showing all");
});

test("cap: a non-empty filter suspends the cap — all matches shown", () => {
  // 25 runs all matching "task"
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("t"); viewer.handleInput("a"); viewer.handleInput("s"); viewer.handleInput("k");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("task 0"), "oldest match visible (cap suspended by filter)");
  assert.ok(!out.includes("showing"), "no cap footer while filtering");
});

test("cap: cursor clamps to the visible (capped) set", () => {
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  // spam down past the end of the capped list
  for (let i = 0; i < 40; i++) viewer.handleInput("\x1b[B");
  viewer.invalidate();
  assert.doesNotThrow(() => viewer.render(80)); // selected never exceeds entries
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: FAIL — no cap (all 25 runs render; no footer); `a` does nothing; filter does not suspend a cap (no cap exists).

- [ ] **Step 3: Write minimal implementation**

In `src/subagent-viewer.ts`, add a `showAll` field and a `CAP` constant:

```ts
/** Completed-run cap shown by default (most-recent). Suspended by filter or show-all. */
const COMPLETED_CAP = 20;
```
```ts
  private showAll = false;
```

In `handleInput`, before the printable-char branch (so `a` is a command, not filter text), add the show-all toggle. Insert right after the backspace branch:

```ts
    if (data === "a" && !this.filter) {
      this.showAll = !this.showAll;
      this.selected = 0;
      this.invalidate();
      return;
    }
```

In `entries()`, apply the cap to the completed slice — only when the filter is empty AND showAll is false. Update the completed line:

```ts
    const allCompleted = this.runs.filter((r) => matches(r.agent, r.taskPreview));
    const capped = !q && !this.showAll ? allCompleted.slice(-COMPLETED_CAP) : allCompleted;
    return [
      ...running.map((ref) => ({ kind: "running" as const, ref })),
      ...capped.map((ref) => ({ kind: "completed" as const, ref })),
    ];
```

In `renderList`, render the cap footer when truncating. After the completed rows loop (and before the filter/nav-hint line), add:

```ts
    const totalCompleted = this.runs.length;
    const showing = completed.length;
    if (!this.filter && !this.showAll && totalCompleted > COMPLETED_CAP) {
      lines.push(truncateToWidth(`  ${th.fg("dim", `showing ${showing} of ${totalCompleted} • press 'a' to show all`)}`, width));
    }
```

(Reset `showAll` alongside the filter on `esc`/`clearFollow` so re-entering the list starts capped: add `this.showAll = false;` to the filter-clear branch and to `clearFollow()`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts`
Expected: PASS — all four cap tests green; existing tests unaffected (they use ≤2 runs, below the cap).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "feat(subagent): cap /subagents completed list to 20 most-recent + show-all"
```

---

## Self-Review

**1. Spec coverage:**
- *Timestamps (relative row + absolute detail)* → Task 1 (formatters) + Task 2 (`startedAt`) + Task 3 (render both). ✓
- *Richer rows (model/elapsed/cost)* → Task 3. ✓
- *Inline search (taskPreview + agent, hide non-matches, esc-clears-then-closes)* → Task 4. ✓
- *Cap 20 + show-all + cap-suspended-when-filtering* → Task 5. ✓
- *Running-first unchanged* → no task (explicitly out of scope; Task 4/5 leave the Running section's construction intact). ✓
- *Output header absolute time* → Task 3. ✓
- *Filter status line* → Task 4. ✓
- No spec requirement is without a task.

**2. Placeholder scan:** No TBD/TODO/"add error handling". Every code step shows the actual code. The two details-assembly sites in Task 2 are referenced by line (~L454, ~L634) with the exact `elapsedMs: Date.now() - t0` anchor the implementer searches for. ✓

**3. Type consistency:** `startedAt?: number` is used identically on `SubagentToolDetails` (Task 2) and `SubagentRun` (Task 2) and read as `r.startedAt` in Tasks 3/5. `formatRelativeTime`/`formatAbsoluteTime` signatures (Task 1) match their call sites (Task 3). `entries()` return shape is unchanged by Tasks 4/5 (still the running|completed union). `COMPLETED_CAP`/`CAP` — the test aliases `const CAP = 20` to match `COMPLETED_CAP`. ✓

---

## Execution Handoff

Plan complete and saved to `.planning/2026-07-30-subagents-viewer-redesign/plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.
