# inspect_hooks (phase-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `inspect_hooks` tool to power-tool that lists every loaded extension's registered `pi.on(...)` lifecycle hooks and flags any handler registered against an unknown event name (likely a typo / dead handler).

**Architecture:** Mirror `inspect_extensions`'s contract — a deterministic fact-layer (`analyzeHooks` over a pure input) + a formatter + a `defineTool` that derives the input from a runtime polyfill. The polyfill extends the existing `sdk-patch.ts` `createContext` wrapper to expose `getHooks()` on the tool context, reading the already-aggregated `runner.extensions[].handlers` (`Map<event, handler[]>`). Zero handler-wrapping, zero runtime behavior change (phase-2 concern).

**Tech Stack:** TypeScript + Bun (`bun:test`), TypeBox (`typebox`) schemas, `@earendil-works/pi-coding-agent` SDK (0.82.0).

## Global Constraints

- Run tests from the package dir: `( cd bun-apps/pi-agent-ext-power-tool && bun test )`. NEVER top-level `cd` (repo `no-cd-drift.sh`).
- Platform: Apple Silicon, Bun only. No Node-specific APIs.
- **Do NOT inline the tool body into `src/index.ts`** (it is already 1,240 lines). The tool lives in its own `src/tools/inspect-hooks.ts`; index.ts gets only an `import` + one `registerTool` line.
- **`tools/inspect-hooks.ts` is fully self-contained** — it defines its own `Severity`/`Finding`/`summarizeFindings`/`shortPath` and imports ONLY from the SDK. This avoids a module-init cycle (index → tools/inspect-hooks → index). The `Finding` shape is structurally identical to index's (so JSON output is consistent across inspect tools).
- Dependency graph MUST stay acyclic: `index.ts → sdk-patch.ts → tools/inspect-hooks.ts → SDK`; `index.ts → tools/inspect-hooks.ts`. `tools/inspect-hooks.ts` imports nothing from this package.
- All written artifacts (code, comments, commit messages) in English.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tools/inspect-hooks.ts` (NEW) | Self-contained: types, `KNOWN_EVENTS`, `collectHooks`, `analyzeHooks`, `formatHooksReport`, `makeInspectHooksTool`. Pure logic + the tool factory. |
| `src/tools/__tests__/inspect-hooks.test.ts` (NEW) | Unit tests for collectHooks / analyzeHooks / formatHooksReport / the tool's execute (fake ctx). |
| `src/sdk-patch.ts` (MODIFY) | Extract `applyContextPolyfills(ctx, runner)`; add `getHooks()` to the polyfill + the module augmentation. |
| `src/__tests__/sdk-patch.test.ts` (NEW) | Unit test for `applyContextPolyfills` (getHooks + getSystemPromptOptions) against a fake runner. |
| `src/index.ts` (MODIFY, 2 lines) | `import { makeInspectHooksTool }` + `pi.registerTool(makeInspectHooksTool())`. |
| `README.md`, `PRD.md` (MODIFY) | Document the new tool + the known-events reference set. |

---

## Task 1: Pure hook-analysis logic (`tools/inspect-hooks.ts` core)

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts`

**Interfaces:**
- Consumes: SDK `defineTool`, `Type` (typebox), `ExtensionContext` type.
- Produces (exported, used by later tasks): `KNOWN_EVENTS`, `HooksSnapshot`, `collectHooks(raw): HooksSnapshot`, `analyzeHooks(snapshot): Finding[]`, `formatHooksReport(snapshot, findings, byEvent): string`, `makeInspectHooksTool` (Task 3 fills its body), `Finding`/`Severity` types.

- [ ] **Step 1: Write the failing tests**

Create `src/tools/__tests__/inspect-hooks.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import {
  KNOWN_EVENTS,
  collectHooks,
  analyzeHooks,
  formatHooksReport,
  type HooksSnapshot,
} from "../inspect-hooks.js";

const snap = (extensions: HooksSnapshot["extensions"], available = true): HooksSnapshot =>
  ({ extensions, available });

describe("collectHooks", () => {
  test("maps runner.extensions[] (Map<event,handler[]>) into ExtensionHooks[]", () => {
    const raw = [
      {
        path: "bun-apps/pi-agent-ext-foo/ext.ts",
        handlers: new Map([["turn_end", [() => {}, () => {}]], ["before_agent_start", [() => {}]]]),
      },
    ];
    expect(collectHooks(raw)).toEqual(
      snap([
        {
          path: "bun-apps/pi-agent-ext-foo/ext.ts",
          hooks: [
            { event: "turn_end", count: 2 },
            { event: "before_agent_start", count: 1 },
          ],
        },
      ]),
    );
  });

  test("returns available:false when input is not an array (SDK shape changed)", () => {
    expect(collectHooks(undefined)).toEqual(snap([], false));
    expect(collectHooks({})).toEqual(snap([], false));
  });

  test("tolerates a missing handlers map / missing path", () => {
    const raw = [{ path: "p" }, { handlers: new Map([["turn_end", [() => {}]]]) }];
    const out = collectHooks(raw);
    expect(out.available).toBe(true);
    expect(out.extensions[0]).toEqual({ path: "p", hooks: [] });
    expect(out.extensions[1]).toEqual({ path: "(unknown)", hooks: [{ event: "turn_end", count: 1 }] });
  });
});

describe("analyzeHooks", () => {
  test("flags handler on an UNKNOWN event as medium unknown-event-name", () => {
    const findings = analyzeHooks(snap([
      { path: "ext.ts", hooks: [{ event: "before_agent_starts", count: 1 }] }, // stray 's'
    ]));
    const f = findings.find((f) => f.check === "unknown-event-name")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("medium");
    expect(f.detail).toMatchObject({ event: "before_agent_starts", count: 1 });
  });

  test("does NOT flag a real event", () => {
    const findings = analyzeHooks(snap([
      { path: "ext.ts", hooks: [{ event: "turn_end", count: 1 }] },
    ]));
    expect(findings.some((f) => f.check === "unknown-event-name")).toBe(false);
  });

  test("emits per-extension inventory (info) + stats (info)", () => {
    const findings = analyzeHooks(snap([
      { path: "a.ts", hooks: [{ event: "turn_end", count: 2 }, { event: "context", count: 1 }] },
      { path: "b.ts", hooks: [{ event: "turn_end", count: 1 }] },
    ]));
    expect(findings.filter((f) => f.check === "extension-hook-inventory")).toHaveLength(2);
    const stats = findings.find((f) => f.check === "hook-stats")!;
    expect(stats.detail).toMatchObject({ extensions: 2, handlers: 4, unknown: 0 });
  });

  test("available:false → only a hooks-unavailable info finding", () => {
    const findings = analyzeHooks(snap([], false));
    expect(findings.map((f) => f.check)).toEqual(["hooks-unavailable"]);
  });
});

describe("formatHooksReport", () => {
  const snapshot = snap([
    { path: "bun-apps/ext-a/a.ts", hooks: [{ event: "turn_end", count: 2 }, { event: "nope", count: 1 }] },
  ]);
  test("text report includes the unknown-event message + inventory line", () => {
    const out = formatHooksReport(snapshot, analyzeHooks(snapshot), false);
    expect(out).toContain("Inspect Hooks");
    expect(out).toContain('unknown event "nope"');
    expect(out).toContain("ext-a/a.ts");
  });
  test("byEvent=true groups the inventory by event", () => {
    const out = formatHooksReport(snapshot, analyzeHooks(snapshot), true);
    expect(out).toContain("turn_end");
  });
});

describe("KNOWN_EVENTS", () => {
  test("includes the high-frequency events (sanity vs SDK drift)", () => {
    for (const e of ["session_start", "before_agent_start", "turn_end", "tool_execution_start", "context", "tool_call", "input"]) {
      expect(KNOWN_EVENTS.has(e)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```
Expected: FAIL — `Cannot find module "../inspect-hooks.js"` (file does not exist yet).

- [ ] **Step 3: Implement the pure module**

Create `src/tools/inspect-hooks.ts`:

```ts
/**
 * inspect_hooks — hook observability for extension development.
 *
 * Lists every loaded extension's registered lifecycle hooks (pi.on handlers):
 * which events each extension listens on, handler counts, and any handler
 * registered against an UNKNOWN event name (almost certainly a typo / dead
 * handler — it can never match the dispatch loop's real eventType).
 *
 * This module is SELF-CONTAINED (imports only from the SDK) to avoid a
 * module-init cycle with ../index.js. The Finding/Severity types are
 * duplicated here but structurally identical to index's, so JSON output stays
 * consistent across inspect_* tools.
 */
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Shared with inspect_extensions (structurally identical) ────────────────

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  /** machine id, e.g. "unknown-event-name" */
  check: string;
  /** one human-readable line */
  message: string;
  /** structured payload (for JSON mode / assertions) */
  detail?: Record<string, unknown>;
}

export function summarizeFindings(findings: Finding[]): {
  total: number;
  high: number;
  medium: number;
  low: number;
} {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === "info") continue;
    counts[f.severity as "high" | "medium" | "low"] += 1;
  }
  return { total: counts.high + counts.medium + counts.low, ...counts };
}

/** Compact a source path: prefer the bun-apps/... tail, else last 2 segments. */
function shortPath(p: string): string {
  const i = p.indexOf("bun-apps/");
  if (i >= 0) return p.slice(i);
  return p.split("/").slice(-2).join("/");
}

// ─── Known events (pi 0.82.0) ───────────────────────────────────────────────
// The on() overload string literals. A handler registered on an event NOT in
// this set can never fire → likely a typo. Keep in sync with the SDK's
// ExtensionEvent.type union if the SDK adds events.

export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "project_trust", "resources_discover",
  "session_start", "session_info_changed", "session_before_switch",
  "session_before_fork", "session_before_compact", "session_compact",
  "session_shutdown", "session_before_tree", "session_tree",
  "context", "before_provider_request", "before_provider_headers",
  "after_provider_response", "before_agent_start", "agent_start",
  "agent_end", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "model_select", "thinking_level_select", "tool_call", "tool_result",
  "user_bash", "input",
]);

// ─── Snapshot types (also the analyzeHooks input) ───────────────────────────

export interface HookRegistration {
  event: string;
  /** handler-array length for this event */
  count: number;
}
export interface ExtensionHooks {
  path: string;
  hooks: HookRegistration[];
}
export interface HooksSnapshot {
  extensions: ExtensionHooks[];
  /** false when the polyfill couldn't reach runner.extensions */
  available: boolean;
}

/**
 * PURE: map the raw runner.extensions[] (each `{ path, handlers: Map<event,Fn[]> }`)
 * into a typed HooksSnapshot. Tolerates shape drift → available:false.
 */
export function collectHooks(rawExtensions: unknown): HooksSnapshot {
  if (!Array.isArray(rawExtensions)) return { extensions: [], available: false };
  const extensions: ExtensionHooks[] = rawExtensions.map((ext: any) => {
    const handlers: Map<string, unknown[]> | undefined = ext?.handlers;
    const path: string = ext?.path ?? ext?.resolvedPath ?? "(unknown)";
    const hooks: HookRegistration[] =
      handlers && typeof handlers.entries === "function"
        ? [...(handlers as Map<string, unknown[]>).entries()].map(([event, hs]) => ({
            event: String(event),
            count: Array.isArray(hs) ? hs.length : 0,
          }))
        : [];
    return { path, hooks };
  });
  return { extensions, available: true };
}

/**
 * PURE: analyze a HooksSnapshot. No SDK, no fs. Order: unknown-event-name
 * (medium), then per-extension inventory (info), then stats (info). If
 * available:false, only a single hooks-unavailable info finding is returned.
 */
export function analyzeHooks(snapshot: HooksSnapshot): Finding[] {
  const findings: Finding[] = [];
  if (!snapshot.available) {
    findings.push({
      severity: "info",
      check: "hooks-unavailable",
      message:
        "Hooks unavailable — SDK context shape changed (getHooks polyfill couldn't reach runner.extensions)",
    });
    return findings;
  }

  // 🟡 unknown-event-name — handler on an event NOT in KNOWN_EVENTS → dead (typo)
  for (const ext of snapshot.extensions) {
    for (const h of ext.hooks) {
      if (!KNOWN_EVENTS.has(h.event)) {
        findings.push({
          severity: "medium",
          check: "unknown-event-name",
          message: `${shortPath(ext.path)} registers handler on unknown event "${h.event}" — likely a typo / dead handler`,
          detail: { path: ext.path, event: h.event, count: h.count },
        });
      }
    }
  }

  // ℹ️ per-extension inventory
  let totalHandlers = 0;
  let totalUnknown = 0;
  for (const ext of snapshot.extensions) {
    const handlers = ext.hooks.reduce((s, h) => s + h.count, 0);
    const unknown = ext.hooks.filter((h) => !KNOWN_EVENTS.has(h.event)).length;
    totalHandlers += handlers;
    totalUnknown += unknown;
    findings.push({
      severity: "info",
      check: "extension-hook-inventory",
      message: `${shortPath(ext.path)}: ${ext.hooks.length} event(s), ${handlers} handler(s)`,
      detail: { path: ext.path, events: ext.hooks.length, handlers, unknown },
    });
  }

  findings.push({
    severity: "info",
    check: "hook-stats",
    message: `${snapshot.extensions.length} extension(s), ${totalHandlers} handler(s); ${totalUnknown} unknown-event finding(s)`,
    detail: { extensions: snapshot.extensions.length, handlers: totalHandlers, unknown: totalUnknown },
  });

  return findings;
}

/** Render a HooksSnapshot + its findings as a severity-ranked text report. PURE. */
export function formatHooksReport(
  snapshot: HooksSnapshot,
  findings: Finding[],
  byEvent: boolean,
): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════╗");
  lines.push("║          Inspect Hooks               ║");
  lines.push("╚══════════════════════════════════════╝");
  lines.push("");

  if (!snapshot.available) {
    for (const f of findings) lines.push(`  • ${f.message}`);
    lines.push("");
    return lines.join("\n");
  }

  const summary = summarizeFindings(findings);
  lines.push(
    `▶ ${summary.total} issue(s): 🔴 ${summary.high} high · 🟡 ${summary.medium} medium · 🟢 ${summary.low} low`,
  );
  lines.push("");

  // Medium: unknown-event-name
  const unknown = findings.filter((f) => f.check === "unknown-event-name");
  if (unknown.length > 0) {
    lines.push(`▶ 🟡 Medium — unknown event name (${unknown.length}):`);
    for (const f of unknown) lines.push(`  • ${f.message}`);
    lines.push("");
  } else if (summary.total === 0) {
    lines.push("✓ No unknown-event findings — hook registrations look healthy.");
    lines.push("");
  }

  // Inventory
  if (byEvent) {
    const byEvt = new Map<string, { exts: string[]; handlers: number }>();
    for (const ext of snapshot.extensions) {
      for (const h of ext.hooks) {
        const e = byEvt.get(h.event) ?? { exts: [], handlers: 0 };
        e.exts.push(shortPath(ext.path));
        e.handlers += h.count;
        byEvt.set(h.event, e);
      }
    }
    lines.push("▶ Hooks by event:");
    for (const [event, e] of [...byEvt].sort((a, b) => b[1].handlers - a[1].handlers)) {
      const flag = KNOWN_EVENTS.has(event) ? "" : "  ⚠ unknown";
      lines.push(`  ${event.padEnd(28)} ${e.exts.length} ext(s)  ${e.handlers} handler(s)${flag}`);
    }
  } else {
    lines.push("▶ Hooks by extension:");
    for (const ext of snapshot.extensions) {
      const handlers = ext.hooks.reduce((s, h) => s + h.count, 0);
      lines.push(`  ${shortPath(ext.path).padEnd(42)} ${String(ext.hooks.length).padStart(3)} event(s)  ${String(handlers).padStart(3)} handler(s)`);
    }
  }
  lines.push("");

  const stats = findings.find((f) => f.check === "hook-stats");
  if (stats) lines.push(`▶ ${stats.message}`);
  return lines.join("\n");
}

// ─── Tool factory (body added in Task 3) ────────────────────────────────────
// Declared here so Task 1 compiles; execute() is filled in Task 3.
// (Placeholder return kept minimal — Task 3 replaces it.)

export function makeInspectHooksTool() {
  return defineTool({
    name: "inspect_hooks",
    label: "Inspect Hooks",
    description: "List every loaded extension's registered lifecycle hooks (pi.on handlers) — which events each extension listens on, handler counts, and any handler registered against an unknown event name (likely a typo / dead handler). Fact-finder companion to inspect_extensions.",
    parameters: Type.Object({
      by_event: Type.Optional(Type.Boolean({ description: "Group inventory by event instead of by extension (who listens on X?)" })),
      return_json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON instead of a text report" })),
      self_test: Type.Optional(Type.Boolean({ description: "When true, run against deterministic test data instead of live ctx" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Filled in Task 3 — returns the real report. Placeholder so Task 1
      // type-checks and tests for the pure logic land first.
      const snapshot: HooksSnapshot = { extensions: [], available: false };
      const findings = analyzeHooks(snapshot);
      return { content: [{ type: "text" as const, text: formatHooksReport(snapshot, findings, Boolean(params.by_event)) }], details: null };
    },
  });
}

// Used by Task 3 to read the snapshot off the (polyfilled) context.
export { };
// `ctx as ExtensionContext).getHooks()` is typed via sdk-patch's module
// augmentation (added in Task 2). This module does NOT import that type itself.
export type { ExtensionContext } from "@earendil-works/pi-coding-agent";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts \
        bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts
git commit -m "feat(power-tool): add inspect_hooks pure analysis logic (collectHooks/analyzeHooks/formatHooksReport)"
```

---

## Task 2: `getHooks()` polyfill in `sdk-patch.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/__tests__/sdk-patch.test.ts`

**Interfaces:**
- Consumes: `collectHooks`, `HooksSnapshot` (from `./tools/inspect-hooks.js`).
- Produces: `applyContextPolyfills(ctx, runner)` (exported), `PolyfillRunner` (type), and the `getHooks()` method on `ExtensionContext` (via module augmentation). `ensureGetSystemPromptOptions()` now installs all three polyfills through `applyContextPolyfills`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sdk-patch.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { applyContextPolyfills, type PolyfillRunner } from "../sdk-patch.js";

const fakeRunner = (extensions: unknown[]): PolyfillRunner => ({
  assertActive() {},
  getSystemPromptOptionsFn: () => ({}) as never,
  getSystemPromptFn: () => "",
  extensions,
});

describe("applyContextPolyfills", () => {
  test("installs getHooks that reads runner.extensions via collectHooks", () => {
    const ctx: Record<string, unknown> = {};
    const runner = fakeRunner([
      { path: "ext.ts", handlers: new Map([["turn_end", [() => {}, () => {}]]]) },
    ]);
    applyContextPolyfills(ctx, runner);
    expect(typeof ctx.getHooks).toBe("function");
    const snap = (ctx.getHooks as () => unknown)();
    expect(snap).toEqual({
      extensions: [{ path: "ext.ts", hooks: [{ event: "turn_end", count: 2 }] }],
      available: true,
    });
  });

  test("getHooks returns available:false if it throws (independent of getSystemPromptOptions)", () => {
    const ctx: Record<string, unknown> = {};
    const runner: PolyfillRunner = {
      assertActive() { throw new Error("stale"); },
      getSystemPromptOptionsFn: () => ({}) as never,
      getSystemPromptFn: () => "",
      extensions: [],
    };
    applyContextPolyfills(ctx, runner);
    const snap = (ctx.getHooks as () => { available: boolean })();
    expect(snap.available).toBe(false);
    // getSystemPromptOptions is still installed (independent degradation)
    expect(typeof ctx.getSystemPromptOptions).toBe("function");
  });

  test("installs getSystemPromptOptions + getSystemPrompt (unchanged behavior)", () => {
    const ctx: Record<string, unknown> = {};
    applyContextPolyfills(ctx, fakeRunner([]));
    expect(typeof ctx.getSystemPromptOptions).toBe("function");
    expect(typeof ctx.getSystemPrompt).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/__tests__/sdk-patch.test.ts )
```
Expected: FAIL — `applyContextPolyfills` is not exported (does not exist yet).

- [ ] **Step 3: Refactor sdk-patch.ts — extract `applyContextPolyfills`, add `getHooks`**

Edit `src/sdk-patch.ts`. Replace the existing module-augmentation block AND the inline polyfill-additions inside `proto.createContext` with the refactored version below.

**3a.** Replace the `declare module { ... }` block (currently augments only `getSystemPromptOptions`) with:

```ts
import { collectHooks, type HooksSnapshot } from "./tools/inspect-hooks.js";

// Runtime: ensureGetSystemPromptOptions() polyfills getSystemPromptOptions() AND
// getHooks() onto the tool execution context (ExtensionContext) — the SDK only
// declares them on ExtensionCommandContext / not at all. This module augmentation
// mirrors the runtime polyfill at the TYPE level. (Keep in sync with the runtime
// patch below.)
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionContext {
    getSystemPromptOptions(): import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions;
    getHooks(): HooksSnapshot;
  }
}

/** The slice of the runner instance the polyfills read. */
export interface PolyfillRunner {
  assertActive(): void;
  getSystemPromptOptionsFn(): import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions;
  getSystemPromptFn(): string;
  /** runner.extensions — the aggregate all hook handlers are stored on. */
  extensions?: unknown[];
}

/**
 * Install all context polyfills onto a ctx object. PURE w.r.t. ctx (mutates it).
 * Exported so it is unit-testable without resolving the real Runner prototype.
 * Each polyfill is independently guarded: a getHooks failure (caught) does NOT
 * affect getSystemPromptOptions, and vice-versa.
 */
export function applyContextPolyfills(
  ctx: Record<string, unknown>,
  runner: PolyfillRunner,
): void {
  if (typeof ctx.getSystemPromptOptions !== "function") {
    ctx.getSystemPromptOptions = () => {
      runner.assertActive();
      return runner.getSystemPromptOptionsFn();
    };
  }
  if (typeof ctx.getSystemPrompt !== "function") {
    ctx.getSystemPrompt = () => {
      runner.assertActive();
      return runner.getSystemPromptFn();
    };
  }
  if (typeof ctx.getHooks !== "function") {
    ctx.getHooks = (): HooksSnapshot => {
      try {
        runner.assertActive();
        return collectHooks(runner.extensions);
      } catch {
        return { extensions: [], available: false };
      }
    };
  }
}
```

> Remove the now-duplicate top-of-file `import { createRequire }...`? NO — keep it; the `sdkRequire` is still used below. The new `import { collectHooks, type HooksSnapshot }` is an ADDITIONAL import line at the top (merge into the existing import group).

**3b.** Inside `ensureGetSystemPromptOptions`, replace the inline polyfill-addition block:

```ts
      proto.createContext = function (this: unknown, ...args: unknown[]) {
        const ctx = origCreateContext.apply(this, args);
        applyContextPolyfills(ctx as Record<string, unknown>, this as PolyfillRunner);
        return ctx;
      };
```

(This replaces the previous block that set `ctx.getSystemPromptOptions` / `ctx.getSystemPrompt` inline. Delete the `runnerThis` const and the two `if (typeof ctx.… !== "function")` blocks — they now live in `applyContextPolyfills`.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/__tests__/sdk-patch.test.ts )
```
Expected: PASS.

- [ ] **Step 5: Run the FULL existing suite to confirm the refactor didn't break getSystemPromptOptions consumers**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test )
```
Expected: PASS — all pre-existing tests still green (the refactor is behavior-preserving for getSystemPromptOptions/getSystemPrompt).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts \
        bun-apps/pi-agent-ext-power-tool/src/__tests__/sdk-patch.test.ts
git commit -m "feat(power-tool): add getHooks() to sdk-patch createContext polyfill (reads runner.extensions[].handlers)"
```

---

## Task 3: Wire the tool's `execute()` (real + self_test + JSON)

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts` (the `makeInspectHooksTool` body)
- Test (append): `bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts`

**Interfaces:**
- Consumes: `analyzeHooks`, `formatHooksReport` (Task 1), `ctx.getHooks()` (Task 2 polyfill), `summarizeFindings`.
- Produces: a complete `inspect_hooks` tool ready for registration.

- [ ] **Step 1: Append the tool end-to-end test**

Append to `src/tools/__tests__/inspect-hooks.test.ts`:

```ts
import { makeInspectHooksTool } from "../inspect-hooks.js";

describe("inspect_hooks (tool end-to-end, fake ctx)", () => {
  const fakeCtx = (snapshot: HooksSnapshot) =>
    ({ getHooks: () => snapshot } as unknown as Parameters<
      ReturnType<typeof makeInspectHooksTool>["execute"]
    >[4]);

  test("text report surfaces unknown-event finding", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute(
      "id",
      {},
      undefined,
      undefined,
      fakeCtx(snap([{ path: "ext.ts", hooks: [{ event: "turn_starts", count: 1 }] }])),
    );
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('unknown event "turn_starts"');
  });

  test("return_json=true returns {findings, summary, snapshot}", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute(
      "id",
      { return_json: true },
      undefined,
      undefined,
      fakeCtx(snap([{ path: "ext.ts", hooks: [{ event: "turn_end", count: 2 }] }])),
    );
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.summary).toEqual({ total: 0, high: 0, medium: 0, low: 0 });
    expect(parsed.snapshot.extensions[0]).toEqual({
      path: "ext.ts",
      hooks: [{ event: "turn_end", count: 2 }],
    });
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  test("self_test=true returns deterministic mock (no live ctx)", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute("id", { self_test: true }, undefined, undefined, {} as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("self_test");
    expect(text).toContain("Inspect Hooks");
  });

  test("hooks-unavailable (available:false) degrades gracefully", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute("id", {}, undefined, undefined, fakeCtx(snap([], false)));
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Hooks unavailable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```
Expected: FAIL — the placeholder `execute` (from Task 1) always returns `available:false`, so the unknown-event / JSON assertions fail.

- [ ] **Step 3: Replace the `makeInspectHooksTool` `execute` body**

In `src/tools/inspect-hooks.ts`, replace the entire `makeInspectHooksTool` function with:

```ts
export function makeInspectHooksTool() {
  return defineTool({
    name: "inspect_hooks",
    label: "Inspect Hooks",
    description:
      "List every loaded extension's registered lifecycle hooks (pi.on handlers) — which events each extension listens on, handler counts, and any handler registered against an unknown event name (likely a typo / dead handler). Fact-finder companion to inspect_extensions.",
    parameters: Type.Object({
      by_event: Type.Optional(Type.Boolean({ description: "Group inventory by event instead of by extension (who listens on X?)" })),
      return_json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON instead of a text report" })),
      self_test: Type.Optional(Type.Boolean({ description: "When true, run against deterministic test data instead of live ctx" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      // self_test: deterministic mock, no live session.
      if (params.self_test) {
        const mock: HooksSnapshot = {
          extensions: [
            { path: "bun-apps/example/ext.ts", hooks: [{ event: "turn_end", count: 1 }, { event: "turn_starts", count: 1 }] },
          ],
          available: true,
        };
        const findings = analyzeHooks(mock);
        return {
          content: [{ type: "text" as const, text: "self_test: true\n\n" + formatHooksReport(mock, findings, Boolean(params.by_event)) }],
          details: null,
        };
      }

      const snapshot = (ctx as ExtensionContext).getHooks();
      const findings = analyzeHooks(snapshot);

      if (params.return_json) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { findings, summary: summarizeFindings(findings), snapshot },
                null,
                2,
              ),
            },
          ],
          details: null,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatHooksReport(snapshot, findings, Boolean(params.by_event)) }],
        details: null,
      };
    },
  });
}
```

Also DELETE the trailing placeholder export block from Task 1 (the `export { };` + `export type { ExtensionContext }` lines) — `ExtensionContext` is already imported at the top via the `defineTool` import line; ensure the top import reads:

```ts
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```
Expected: PASS — all tool end-to-end tests green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts \
        bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts
git commit -m "feat(power-tool): wire inspect_hooks execute (live snapshot + self_test + JSON)"
```

---

## Task 4: Register the tool + full build/test gate

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/index.ts` (2 lines)

**Interfaces:**
- Consumes: `makeInspectHooksTool` (Task 3). The factory already calls `ensureGetSystemPromptOptions()` at line 1212 (installs the getHooks polyfill).

- [ ] **Step 1: Add the import + registration**

In `src/index.ts`:

- In the import group near the other local imports (after the `import { ensureGetSystemPromptOptions } from "./sdk-patch.js";` line, ~line 39), add:

```ts
import { makeInspectHooksTool } from "./tools/inspect-hooks.js";
```

- In the factory, next to the other `pi.registerTool(...)` calls (after line 1219 `pi.registerTool(makeInspectExtensionsTool(getAllTools));`), add:

```ts
  pi.registerTool(makeInspectHooksTool());
```

- [ ] **Step 2: Run the FULL test suite**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test )
```
Expected: PASS — all pre-existing tests + the new inspect-hooks/sdk-patch tests green. (Previously 119 tests; now +N for the new files.)

- [ ] **Step 3: Type-check / build**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun run build 2>/dev/null && echo BUILD_OK || (bunx tsc --noEmit && echo TYPECHECK_OK) )
```
Expected: `BUILD_OK` (or `TYPECHECK_OK`) with no errors. If `bun run build` does not exist, the `tsc --noEmit` fallback must pass.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/index.ts
git commit -m "feat(power-tool): register inspect_hooks tool in the factory"
```

---

## Task 5: Docs (README + PRD)

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/README.md`
- Modify: `bun-apps/pi-agent-ext-power-tool/PRD.md`

- [ ] **Step 1: README — add inspect_hooks to the Tools list**

In the README's tools listing (alongside `inspect_extensions`), add an entry:

```markdown
- `inspect_hooks` — list every loaded extension's registered `pi.on(...)` lifecycle
  hooks (which events each extension listens on, handler counts) and flag any handler
  registered against an unknown event name (likely a typo / dead handler). Fact-finder
  companion to `inspect_extensions`. Params: `by_event` (group by event), `return_json`,
  `self_test`.
```

- [ ] **Step 2: PRD — note the new tool + the phase-2 (firing counts) follow-up**

In `PRD.md`, under the inspect-* section, add a short subsection:

```markdown
### inspect_hooks

Hook observability for extension development — the last blind spot of the
inspect surface. Phase 1 (this work): registration listing + `unknown-event-name`
typo detection, reading the aggregated `runner.extensions[].handlers` via a
`getHooks()` polyfill on `sdk-patch.ts`'s `createContext` wrapper.

Phase 2 (follow-up plan, same effort): firing counts — wrap each handler with a
counter at the same patch point, add the `never-fired` (registered-but-dead)
finding. The patch point is shared, so the scaffolding lands once in phase 1.
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/README.md bun-apps/pi-agent-ext-power-tool/PRD.md
git commit -m "docs(power-tool): document inspect_hooks tool + phase-2 follow-up"
```

---

## Self-Review

**1. Spec coverage** — every D-decision and phase-1 requirement maps to a task:
- D1 fact-finder → Task 1 (analyzeHooks = pure facts + conservative severities). ✓
- D2 all-events surface + by_event + KNOWN_EVENTS reference → Task 1 (KNOWN_EVENTS, analyzeHooks inventories all, formatHooksReport `byEvent`). ✓
- D3 text + JSON → Task 3 (return_json branch). ✓
- D4 unknown-event-name (medium) + hook-stats (info) → Task 1 analyzeHooks. (never-fired is phase-2, explicitly out of scope.) ✓
- D5 phase-1 only (no handler-wrapping) → Tasks 1–4 read the aggregate only; no runtime behavior change. ✓
- D6 independent graceful fail → Task 2 (getHooks own try/catch; getSystemPromptOptions unaffected; test asserts independence). ✓
- Files table (sdk-patch / new tools file / index +1 line / tests / README+PRD) → Tasks 1–5. ✓
- Verification (typo detected, graceful degradation, self_test deterministic) → Tasks 1 & 3 tests + Task 4 gate. ✓

**2. Placeholder scan** — no TBD/TODO/"add error handling"/"similar to Task N". The Task 1 `makeInspectHooksTool` placeholder is explicitly labeled and fully replaced in Task 3 (Step 3). ✓

**3. Type consistency** — `HooksSnapshot`/`ExtensionHooks`/`HookRegistration`/`Finding`/`Severity` defined once (Task 1) and used identically in Tasks 2–3. `collectHooks` signature `unknown → HooksSnapshot` matches both the Task 2 polyfill call and Task 1 tests. `applyContextPolyfills(ctx, PolyfillRunner)` matches the Task 2 test. `ctx.getHooks(): HooksSnapshot` (augmentation) matches the Task 3 `(ctx as ExtensionContext).getHooks()` call. ✓

No issues found — plan is complete and internally consistent.
