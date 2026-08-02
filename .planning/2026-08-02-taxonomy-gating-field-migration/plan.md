# Taxonomy → per-tool `gating` field migration (3 pilots) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 3 pilot extensions' tool-taxonomy from tool-gate's hardcoded `GATES`/`CORE_TOOLS` into owner-declared per-tool `gating` fields, discovered via the existing `getAllToolDefinitions()` patch — with zero extension↔extension runtime deps.

**Architecture:** Each owner attaches `gating: { keywords, requires?, core? }` to its `ToolDefinition` (typed via a local module-augmentation `.d.ts` per pilot). tool-gate reads `.gating` off `pi.getAllToolDefinitions()` (the *already-live* `ext-api-get-all-tool-definitions` patch — no new runtime patch), merges owner `gating` with its hardcoded `GATES`/`CORE_TOOLS` fallback (hybrid, zero regression for the ~9 unmigrated extensions), and feeds the result to its existing gate logic.

**Tech Stack:** TypeScript, Bun (`bun test`), TypeBox (`Type.Object`), `@earendil-works/pi-coding-agent` (`ToolDefinition`, `defineTool`, `ExtensionAPI`), the repo's runtime monkey-patch layer (`bun-apps/pi-agent/src/patches/`).

**Spec:** `.planning/2026-08-02-taxonomy-gating-field-migration/spec.md`

## Global Constraints

- **No extension↔extension runtime dependency** may be introduced. `grep`-verifiable: no new `import ... from "@repo/pi-agent-ext-*"` between `pi-agent-ext-tool-gate`, `-core-task`, `-power-tool`. (The existing host→extension `pi-agent-cli → power-tool/schema-cost` stays — ruled in-bounds by ticket 03.)
- **Owner-declared `gating` is authoritative** for a tool; tool-gate never overrides it. S2 noun∧verb tuning is lifted **verbatim** from the existing `GATES` entries (do not re-tune).
- **Built-in tools** (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`) are **exempt** from the drift-guard.
- **Hybrid fallback must not regress**: tools whose owners haven't migrated (flux2/krea2/ltx/file2md/workflow/…) keep working via the hardcoded `GATES`.
- Run all tests from the package dir: `( cd bun-apps/<pkg> && bun test )`. Never top-level `cd` (use subshells). Invocations from repo root use `bun run --cwd bun-apps/<pkg> test`.

---

## File Structure

**tool-gate** (`bun-apps/pi-agent-ext-tool-gate/`):
- Create `types/tool-gating.d.ts` — module augmentation: `ToolDefinition.gating?: Gating` + ambient `Gating` interface + `getAllToolDefinitions()` on the runtime type.
- Modify `extensions/tool-gate.ts` — add `Gating`/`EffectiveGates`/`buildEffectiveGates()`; parameterize `filterActive`/`updateSticky` (backward-compatible defaults); wire effective gates into `session_start`/`before_agent_start`/`enable_tool`; add `gating:{core:true}` to `enable_tool`.
- Modify `extensions/tool-gate.test.ts` — new tests; existing tests unchanged (defaults preserve current signatures).

**power-tool** (`bun-apps/pi-agent-ext-power-tool/`):
- Create `types/tool-gating.d.ts` — identical augmentation.
- Modify `src/index.ts` (inspect_context/agent/extensions/tui), `src/pathology/index.ts` (inspect_pathology), `src/tools/inspect-hooks.ts` (inspect_hooks) — add `gating` to each `defineTool({...})` literal.
- Modify `extensions/__tests__/` (or appropriate test dir) — add a test asserting all 6 `inspect_*` carry `gating` and `inspect_hooks` fires on keywords.

**core-task** (`bun-apps/pi-agent-ext-core-task/`):
- Create `types/tool-gating.d.ts` — identical augmentation.
- Modify `src/ask-user/ask-user-question.ts`, `src/todo/todo.ts`, `src/goal/goal.ts` — add `gating:{core:true}`.

**cross-cutting**:
- Create the **drift-guard** test (lives in tool-gate, iterates `getAllToolDefinitions()` across all loaded tools) + the **schema-cost agreement** test + remove the `@deprecated delegate` scaffolding in `pi-agent-cli/src/commands/schema-cost.ts`.

---

## Task 1: `Gating` type + `buildEffectiveGates()` + parameterize pure fns (tool-gate)

**Files:**
- Create: `bun-apps/pi-agent-ext-tool-gate/types/tool-gating.d.ts`
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add types + `buildEffectiveGates`; parameterize `filterActive` ~:222, `updateSticky` ~:359)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Produces: `interface Gating` (ambient, via `.d.ts`); `interface EffectiveGates { gates: ToolGate[]; core: Set<string>; tracked: Set<string> }`; `function buildEffectiveGates(defs, fallbackGates?, fallbackCore?): EffectiveGates`; `filterActive(allToolNames, sticky, tracked = TRACKED_TOOLS)`; `updateSticky(prompt, sticky, gates = GATES)`.

- [ ] **Step 1: Write the failing test for `buildEffectiveGates`**

Append to `extensions/tool-gate.test.ts`:

```ts
import { buildEffectiveGates } from "./tool-gate.ts";

describe("buildEffectiveGates", () => {
  test("owner-declared core:true → core set, removed from fallback need", () => {
    const defs = [{ name: "enable_tool", gating: { core: true } }] as Array<{
      name: string; description?: string; gating?: { keywords: string[]; requires?: { nouns: string[]; verbs: string[] }; core?: boolean };
    }>;
    const eff = buildEffectiveGates(defs);
    expect(eff.core.has("enable_tool")).toBe(true);
    expect(eff.gates.find((g) => g.names.includes("enable_tool"))).toBeUndefined();
  });

  test("owner-declared non-core gating becomes a single-name gate", () => {
    const defs = [{
      name: "inspect_hooks", description: "d",
      gating: { keywords: ["schema cost"], requires: { nouns: ["agent"], verbs: ["inspect"] } },
    }] as Array<{ name: string; description?: string; gating?: any }>;
    const eff = buildEffectiveGates(defs);
    const g = eff.gates.find((x) => x.names.includes("inspect_hooks"));
    expect(g).toBeDefined();
    expect(g!.keywords).toEqual(["schema cost"]);
    expect(g!.requires).toEqual({ nouns: ["agent"], verbs: ["inspect"] });
  });

  test("hybrid fallback: tools without gating keep their hardcoded gate", () => {
    const eff = buildEffectiveGates([]); // no owner declarations
    const flux = eff.gates.find((g) => g.names.includes("flux2"));
    expect(flux).toBeDefined(); // hardcoded GATES fallback intact
    expect(eff.core.has("read")).toBe(true); // CORE_TOOLS fallback intact
  });

  test("owner-declared tool supersedes a same-named hardcoded gate", () => {
    const defs = [{
      name: "flux2", description: "owner",
      gating: { keywords: ["owner-kw"] },
    }] as Array<{ name: string; description?: string; gating?: any }>;
    const eff = buildEffectiveGates(defs);
    const g = eff.gates.find((x) => x.names.includes("flux2"));
    expect(g!.keywords).toEqual(["owner-kw"]); // owner wins, not the hardcoded flux2 entry
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `buildEffectiveGates is not exported` (does not exist yet).

- [ ] **Step 3: Create the type augmentation `.d.ts`**

Create `bun-apps/pi-agent-ext-tool-gate/types/tool-gating.d.ts`:

```ts
/**
 * tool-gating augmentation — lets a tool's `ToolDefinition` carry an owner-declared
 * `gating` field. Duplicated (identically) in each pilot package so no cross-package
 * type dependency is introduced; a drift-guard test asserts structural agreement.
 *
 * `getAllToolDefinitions()` is added at runtime by the repo's
 * `ext-api-get-all-tool-definitions` monkey-patch (bun-apps/pi-agent/src/patches/);
 * declared here so TypeScript accepts the call.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
  interface ToolDefinition {
    gating?: Gating;
  }
}

interface Gating {
  /** Bare-word/phrase triggers (tool-gate matchesKeyword). Gate fires if any matches OR `requires` is met. */
  keywords: string[];
  /** Optional co-occurrence: fires only if prompt has ≥1 noun AND ≥1 verb. */
  requires?: { nouns: string[]; verbs: string[] };
  /** If true, always active (core/escape-hatch); never gated. */
  core?: boolean;
}

/** Runtime surface added by the ext-api-get-all-tool-definitions patch. */
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    getAllToolDefinitions?(): ToolDefinition[];
  }
}
```

> **Verify the import path:** confirm `ToolDefinition` and `ExtensionAPI` are exported from the package root `@earendil-works/pi-coding-agent` (check `bun-apps/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`). If they are re-exported from a subpath, adjust the `declare module` target to match what consumers actually import. If `ExtensionAPI` is not the correct interface name (could be `ExtensionRuntime`), grep `pi-agent-ext-tool-gate/extensions/tool-gate.ts` for the `pi: ExtensionAPI` parameter type and use that exact name.

- [ ] **Step 4: Add `buildEffectiveGates` + parameterize the pure functions**

In `extensions/tool-gate.ts`, first parameterize `filterActive` (currently ~line 222):

```ts
export function filterActive(
  allToolNames: string[],
  sticky: Set<string>,
  tracked: Set<string> = TRACKED_TOOLS,
): string[] {
  return allToolNames.filter((name) => !tracked.has(name) || sticky.has(name));
}
```

Parameterize `updateSticky` (currently ~line 359):

```ts
export function updateSticky(prompt: string, sticky: Set<string>, gates: ToolGate[] = GATES): void {
  const promptLower = prompt.toLowerCase();
  for (const gate of gates) {
    if (gateFires(gate, promptLower)) {
      for (const name of gate.names) sticky.add(name);
    }
  }
}
```

Then add `buildEffectiveGates` immediately after the `GATES` array (after the `TRACKED_TOOLS` declaration is fine, since it references `GATES`/`CORE_TOOLS` only as default params):

```ts
/** Result of merging owner-declared `gating` with the hardcoded fallback. */
export interface EffectiveGates {
  gates: ToolGate[];   // non-core gates: owner-declared (single-name) + unhandled hardcoded
  core: Set<string>;   // always-active names: owner core:true + unhandled CORE_TOOLS
  tracked: Set<string>; // core ∪ all gate names — the explicit-track set for filterActive
}

/**
 * Build the effective gate set for a session: owner-declared `gating` fields win
 * (authoritative); tools without `gating` fall back to the hardcoded GATES/CORE_TOOLS.
 * Pure: no pi dependency. Owner-declared non-core tools become single-name gates.
 */
export function buildEffectiveGates(
  defs: Array<{ name: string; description?: string; gating?: Gating }>,
  fallbackGates: ToolGate[] = GATES,
  fallbackCore: Set<string> = CORE_TOOLS,
): EffectiveGates {
  const gates: ToolGate[] = [];
  const core = new Set<string>();
  const handled = new Set<string>();
  for (const def of defs) {
    const g = def.gating;
    if (!g) continue;
    if (g.core === true) {
      core.add(def.name);
    } else {
      gates.push({
        names: [def.name],
        keywords: g.keywords,
        requires: g.requires,
        description: def.description ?? "",
      });
    }
    handled.add(def.name);
  }
  for (const fg of fallbackGates) {
    if (fg.names.some((n) => handled.has(n))) continue; // owner-declared wins
    gates.push(fg);
  }
  for (const c of fallbackCore) {
    if (!handled.has(c)) core.add(c);
  }
  const tracked = new Set<string>([...core, ...gates.flatMap((g) => g.names)]);
  return { gates, core, tracked };
}
```

- [ ] **Step 5: Run tests — new ones pass, existing ones stay green**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — the 4 new `buildEffectiveGates` tests pass; all pre-existing tests pass unchanged (the optional params default to the module constants).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/types/tool-gating.d.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): add Gating type + buildEffectiveGates; parameterize filterActive/updateSticky

Foundation for owner-declared gating. No runtime wiring yet (Task 2).
Backward-compatible: filterActive/updateSticky default to module constants."
```

---

## Task 2: Wire effective gates into tool-gate's runtime

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` — `session_start` (~:486), `before_agent_start` (~:517), `enable_tool` execute (~:591+); add closure-scoped effective-gate state.
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: `buildEffectiveGates`, `Gating` (Task 1); `pi.getAllToolDefinitions()` (existing patch).
- Produces: a tool-gate runtime that discovers owner-declared `gating` per session/turn.

- [ ] **Step 1: Write the failing integration test (stub pi)**

Append to `extensions/tool-gate.test.ts`:

```ts
describe("tool-gate runtime reads owner-declared gating", () => {
  test("a tool whose owner declared gating is gated; a core-declared tool is active", async () => {
    const activeCalls: string[][] = [];
    let sessionStartHandler: ((e: unknown, ctx: unknown) => Promise<void>) | null = null;
    const pi = {
      getAllToolDefinitions: () => [
        { name: "read", description: "r", gating: { core: true } },
        { name: "inspect_hooks", description: "d", gating: { keywords: ["schema cost"], requires: { nouns: ["agent"], verbs: ["inspect"] } } },
        { name: "flux2", description: "f" }, // no gating → hardcoded fallback (flux2 is in GATES)
      ],
      on: (_chan: string, h: (e: unknown, ctx: unknown) => Promise<void>) => { if (_chan === "session_start") sessionStartHandler = h; return () => {}; },
      setActiveTools: (names: string[]) => { activeCalls.push(names); },
      registerTool: () => {},
      // ctx passed to the handler:
    } as unknown as Parameters<typeof toolGateExtension>[0];
    toolGateExtension(pi);
    await sessionStartHandler!({}, { ui: { theme: { fg: (_k: string, s: string) => s } } });
    const active = activeCalls[0];
    expect(active).toContain("read");            // core-declared → active
    expect(active).not.toContain("inspect_hooks"); // owner-gated, no keyword in "" prompt → dormant
    expect(active).not.toContain("flux2");        // hardcoded fallback gate, dormant
  });
});
```

> **Note:** `TOOL_GATE_DISABLE` must be unset (it is, in tests). If `scheduleToolGateBanner` calls `ctx.ui.setWidget`, ensure the stub `ctx.ui` includes it (add `setWidget: () => {}` to the stub's `ui`). If the existing test file already has a stub-pi helper, reuse it instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — currently the runtime calls `pi.getAllTools()` (absent on the stub) or ignores `gating`, so `inspect_hooks`/`flux2` are not gated as expected / the stub lacks `getAllTools`.

- [ ] **Step 3: Add closure-scoped effective-gate state + a local type**

At the top of `toolGateExtension(pi)` (after the `TOOL_GATE_DISABLE` guard, before `let allToolNames`), add:

```ts
  type DiscoveredTool = { name: string; description?: string; parameters?: unknown; gating?: Gating };
  const getDiscovered = (): DiscoveredTool[] => {
    const fn = (pi as typeof pi & { getAllToolDefinitions?(): DiscoveredTool[] }).getAllToolDefinitions;
    return typeof fn === "function" ? fn() : [];
  };
  let effectiveGates: ToolGate[] = GATES;
  let effectiveCore: Set<string> = new Set(CORE_TOOLS);
  let effectiveTracked: Set<string> = TRACKED_TOOLS;
```

- [ ] **Step 4: Rewire `session_start` to discover + use effective gates**

Replace the body of the `session_start` handler (currently `const all = pi.getAllTools(); ...`) with:

```ts
  pi.on("session_start", async (_event, ctx) => {
    const all = getDiscovered();
    allToolNames = all.map((t) => t.name);
    const eff = buildEffectiveGates(all);
    effectiveGates = eff.gates; effectiveCore = eff.core; effectiveTracked = eff.tracked;
    sticky = new Set(effectiveCore);

    measuredTokens = new Map(all.map((t) => [t.name, measureToolTokens(t)]));

    const active = filterActive(allToolNames, sticky, effectiveTracked);
    pi.setActiveTools(active);

    const saved = computeBannerSaved(active, allToolNames, measuredTokens);
    const debug = process.env.TOOL_GATE_DEBUG_BANNER === "1";
    const theme = ctx.ui?.theme ?? ({ fg: (_k: string, s: string) => s } as NonNullable<typeof ctx.ui.theme>);
    scheduleToolGateBanner(
      ctx,
      [
        theme.fg("accent", `🔧 Tool gate: ${active.length}/${allToolNames.length} active`),
        theme.fg("dim", `saves ~${saved} tok/req`),
      ],
      debug ? { immediate: true, log: true } : undefined,
    );
  });
```

- [ ] **Step 5: Rewire `before_agent_start` (re-discover per turn + use effective gates)**

In the `before_agent_start` handler, replace `const all = pi.getAllTools();` and the gate usages:

```ts
  pi.on("before_agent_start", async (event, _ctx) => {
    const all = getDiscovered();
    allToolNames = all.map((t) => t.name);
    const eff = buildEffectiveGates(all);
    effectiveGates = eff.gates; effectiveCore = eff.core; effectiveTracked = eff.tracked;
    for (const t of all) {
      if (!measuredTokens.has(t.name)) measuredTokens.set(t.name, measureToolTokens(t));
    }
    const prompt = event.prompt ?? "";

    const before = new Set(sticky);
    updateSticky(prompt, sticky, effectiveGates);
    const active = filterActive(allToolNames, sticky, effectiveTracked);
    pi.setActiveTools(active);

    const gatesFired = effectiveGates
      .filter((g) => g.names.some((n) => sticky.has(n) && !before.has(n)))
      .map((g) => g.names[0]);
    const dormantGates = effectiveGates
      .filter((g) => !g.names.every((n) => sticky.has(n)))
      .map((g) => g.names[0]);

    emitToolGateLog({
      kind: "turn", ts: new Date().toISOString(),
      promptLen: prompt.length, gatesFired, dormantGates,
      activeCount: active.length, totalCount: allToolNames.length,
      savedTok: computeBannerSaved(active, allToolNames, measuredTokens),
    });
    if (isMissCandidate(prompt, gatesFired, dormantGates)) {
      emitToolGateLog({
        kind: "miss_candidate", ts: new Date().toISOString(),
        dormantGates, promptHead: prompt.slice(0, 80),
      });
    }
  });
```

- [ ] **Step 6: Rewire `enable_tool` to use `effectiveGates`**

In the `enable_tool` `execute`, replace the three `GATES` references with `effectiveGates`:
- `const dormant = GATES.filter(...)` → `const dormant = effectiveGates.filter(...)`
- `const gate = GATES.find((g) => g.names.includes(params.name as string));` → `const gate = effectiveGates.find((g) => g.names.includes(params.name as string));`
- `matched = matchIntent(params.intent, GATES, sticky);` → `matched = matchIntent(params.intent, effectiveGates, sticky);`

Also add `gating: { core: true }` to the `enable_tool` tool literal (immediately after the `name: "enable_tool",` line):

```ts
  pi.registerTool({
    name: "enable_tool",
    gating: { core: true },
    label: "Enable a gated tool",
    // ... rest unchanged
```

- [ ] **Step 7: Run all tests**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — the new stub-pi test passes (owner-gated `inspect_hooks` dormant; core `read` active); all pre-existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): discover owner-declared gating via getAllToolDefinitions

session_start/before_agent_start now read .gating from full tool defs (existing
patch), merge with hardcoded GATES/CORE_TOOLS fallback. enable_tool declared
core:true and uses effectiveGates. Hybrid fallback preserves unmigrated tools."
```

---

## Task 3: power-tool inspect_* migration (+ augmentation) — fixes the inspect_hooks orphan

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/types/tool-gating.d.ts`
- Modify: `bun-apps/pi-agent-ext-power-tool/src/index.ts` (`inspect_context` ~:168, `inspect_agent` ~:396, `inspect_extensions` ~:933, `inspect_tui` ~:1047), `src/pathology/index.ts` (`inspect_pathology` ~:39), `src/tools/inspect-hooks.ts` (`inspect_hooks` ~:235)
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` — **remove** the `inspect_*` entry from `GATES`
- Test: `bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.gating.test.ts` (new)

**Interfaces:**
- Consumes: `Gating` type (local `.d.ts`).
- Produces: 6 `inspect_*` tools each carrying `gating`; the `inspect_*` hardcoded gate removed (group fully owner-declared).

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.gating.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

// The verbatim gating every inspect_* tool must carry (lifted from tool-gate's
// former hardcoded inspect_* gate — do NOT re-tune).
const EXPECTED_GATING = {
  keywords: ["schema cost", "pathology", "extension health", "工具開銷", "context window", "token usage"],
  requires: { nouns: ["agent", "context", "extension", "pathology", "token", "schema", "tui", "工具"], verbs: ["inspect", "show", "check", "diagnose", "dump", "report"] },
};

describe("inspect_* tools carry owner-declared gating", () => {
  // Inspect each tool-definition factory and assert the gating field.
  // Import the factories that build the tools; each returns a defineTool({...}).
  test("inspect_hooks declares gating (orphan-fix: it was previously ungated)", async () => {
    const mod = await import("../inspect-hooks.ts");
    // The factory's exported shape: find the defineTool result. Adjust the
    // accessor to the actual export name (grep `export` in inspect-hooks.ts).
    const factory = mod.makeInspectHooksTool ?? mod.default ?? mod;
    const tool = typeof factory === "function" ? factory(() => []) : factory;
    expect(tool.gating).toBeDefined();
    expect(tool.gating.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(tool.gating.requires).toEqual(EXPECTED_GATING.requires);
  });
});
```

> **Adjust the accessor:** before writing, grep `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts` for `export` to find the exact factory name + whether it takes args (the inspect tools take a `getAllTools` callback — see `makeInspectContextTool(getAllTools)`). Mirror that signature when invoking the factory in the test. Do the same for the other 5 tools if you extend this test; the inspect_hooks case is the orphan-fix proof and is the minimum.

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.gating.test.ts )`
Expected: FAIL — `tool.gating` is `undefined` (not yet declared).

- [ ] **Step 3: Create power-tool's augmentation `.d.ts`**

Create `bun-apps/pi-agent-ext-power-tool/types/tool-gating.d.ts` — **byte-identical** to tool-gate's (Task 1, Step 3). Copy it verbatim.

- [ ] **Step 4: Add `gating` to all 6 inspect_* tool literals**

In each `defineTool({...})` (or `pi.registerTool({...})`) literal, insert `gating` immediately after `name:`. The value is identical for all 6 (the group's former gate):

```ts
    name: "inspect_context", // (or inspect_agent / inspect_extensions / inspect_tui / inspect_pathology / inspect_hooks)
    gating: {
      keywords: ["schema cost", "pathology", "extension health", "工具開銷", "context window", "token usage"],
      requires: {
        nouns: ["agent", "context", "extension", "pathology", "token", "schema", "tui", "工具"],
        verbs: ["inspect", "show", "check", "diagnose", "dump", "report"],
      },
    },
```

Apply at: `src/index.ts` (inspect_context ~:169, inspect_agent ~:397, inspect_extensions ~:934, inspect_tui ~:1048), `src/pathology/index.ts` (inspect_pathology ~:40), `src/tools/inspect-hooks.ts` (inspect_hooks ~:236).

- [ ] **Step 5: Remove the inspect_* entry from tool-gate's hardcoded `GATES`**

In `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts`, delete the entire `inspect_*` object from the `GATES` array (the block whose `names` is `["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology", "inspect_tui"]`, currently ~:125–135). The group is now fully owner-declared by power-tool (Task 2's `buildEffectiveGates` reads it from the defs).

- [ ] **Step 6: Run all tests across both packages**

Run: `( cd bun-apps/pi-agent-ext-power-tool && bun test ) && ( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — power-tool's gating test passes; tool-gate tests still pass (the removed entry's names are now owner-supplied via `buildEffectiveGates`).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/types/tool-gating.d.ts bun-apps/pi-agent-ext-power-tool/src bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts
git commit -m "feat(power-tool): owner-declare gating on inspect_* group; fix inspect_hooks orphan

All 6 inspect_* tools now carry gating (keywords+requires lifted verbatim from
tool-gate's former hardcoded gate). inspect_hooks was previously orphaned
(registered but in no gate) — now gated by construction. tool-gate's hardcoded
inspect_* entry removed (group fully owner-declared)."
```

---

## Task 4: core-task core declarations (+ augmentation)

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/types/tool-gating.d.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/ask-user/ask-user-question.ts` (~:72), `src/todo/todo.ts` (~:44), `src/goal/goal.ts` (~:184)
- Test: `bun-apps/pi-agent-ext-core-task/src/__tests__/core-gating.test.ts` (new)

**Interfaces:**
- Consumes: `Gating` type (local `.d.ts`).
- Produces: `ask_user_question`, `todo`, `goal_complete` each carrying `gating:{core:true}`.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-core-task/src/__tests__/core-gating.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

describe("core-task core tools declare gating:{core:true}", () => {
  // Each registerX tool registers via a stub pi; assert the registered def has gating.core===true.
  const makeStubPi = () => {
    let registered: Array<{ name: string; gating?: { core?: boolean } }> = [];
    return {
      pi: { registerTool: (t: { name: string; gating?: { core?: boolean } }) => { registered.push(t); }, on: () => () => {}, registerCommand: () => {} } as any,
      registered: () => registered,
    };
  };

  test("ask_user_question is core", async () => {
    const { pi, registered } = makeStubPi();
    const mod = await import("../ask-user/ask-user-question.ts");
    (mod.registerAskUserQuestionTool ?? mod.default)(pi);
    const t = registered().find((x) => x.name === "ask_user_question" || /ask/i.test(x.name));
    expect(t?.gating?.core).toBe(true);
  });
});
```

> **Adjust accessors:** grep each source file for its exported registration function name (`registerAskUserQuestionTool`, the `todo`/`goal_complete` registrars) and the exact registered `name`. The test must invoke the real registrar with the stub pi. Add cases for `todo` and `goal_complete` mirroring the `ask_user_question` case.

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/__tests__/core-gating.test.ts )`
Expected: FAIL — `t?.gating?.core` is `undefined`.

- [ ] **Step 3: Create core-task's augmentation `.d.ts`**

Create `bun-apps/pi-agent-ext-core-task/types/tool-gating.d.ts` — byte-identical to tool-gate's (Task 1, Step 3).

- [ ] **Step 4: Add `gating:{core:true}` to the 3 core-tool literals**

In `src/ask-user/ask-user-question.ts` (after `name: ASK_USER_QUESTION_TOOL_NAME,`), `src/todo/todo.ts` (after `name:` of the `todo` tool ~:44), `src/goal/goal.ts` (after `name: "goal_complete",` ~:184), insert:

```ts
    gating: { core: true },
```

- [ ] **Step 5: Run the test**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test )`
Expected: PASS — all 3 core tools declared `core:true`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/types/tool-gating.d.ts bun-apps/pi-agent-ext-core-task/src
git commit -m "feat(core-task): owner-declare gating:{core:true} on ask_user_question/todo/goal_complete

Moves these out of tool-gate's hardcoded CORE_TOOLS (they remain there as
fallback until the rollout completes, but are now authoritatively owner-declared)."
```

---

## Task 5: Drift-guard (scoped) + 03 fold-in (schema-cost guard + `@deprecated` cleanup)

**Files:**
- Create: `bun-apps/pi-agent-ext-tool-gate/extensions/drift-guard.test.ts` — the strict drift-guard.
- Create: `bun-apps/pi-agent-ext-tool-gate/extensions/schema-cost-agreement.test.ts` — the 03 guard.
- Modify: `bun-apps/pi-agent-cli/src/commands/schema-cost.ts` — remove `@deprecated delegate` scaffolding (~:48–52).

**Interfaces:**
- Consumes: pilot tool definitions (via direct import of the factories, since a unit test has no live `pi`); `measureToolTokens` (tool-gate), `estimateToolCost` (power-tool/schema-cost).

- [ ] **Step 1: Write the failing drift-guard test**

Create `bun-apps/pi-agent-ext-tool-gate/extensions/drift-guard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

/**
 * Drift-guard: every tool OWNED by the 3 pilot extensions must declare `gating`.
 * Built-ins (read/write/edit/bash/grep/find/ls) are exempt. Scoped to pilots so
 * the other ~9 unmigrated extensions don't fail the build (rollout migrates them).
 *
 * This test imports each pilot's tool factories directly (no live pi) and asserts
 * the produced definition carries a non-null `gating`. Strict: a missing `gating`
 * on a pilot tool is a test failure, not a warning.
 */
const BUILTINS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

describe("drift-guard — pilot tools declare gating", () => {
  test("power-tool inspect_* all carry gating", async () => {
    const pt = await import("@repo/pi-agent-ext-power-tool");
    // Collect the inspect_* definitions. Adjust to power-tool's actual export
    // surface (grep `export` in power-tool/src/index.ts). Each is a factory
    // taking a getAllTools callback; invoke with () => [].
    const names = ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology", "inspect_tui", "inspect_hooks"];
    // Build the list of defs power-tool registers; assert each inspect_* has gating.
    // (If power-tool exposes a registry/array of factories, iterate it; else import
    //  each factory by name.)
    for (const name of names) {
      // placeholder-free: resolve the def via the package's exported factory map.
      // See verification step — confirm the exact accessor before finalizing.
      const def = (pt as any).INSPECT_TOOL_FACTORIES?.[name]?.(() => []) ?? null;
      expect(def, `${name} must be reachable via power-tool's factory map`).not.toBeNull();
      expect(def.gating, `${name} must declare gating`).toBeDefined();
    }
  });

  test("core-task core tools carry gating:{core:true}", async () => {
    // Mirror Task 4's stub-pi approach for ask_user_question/todo/goal_complete.
    // Assert each registered def has gating.core === true.
    expect(true).toBe(true); // replace with real assertions per Task 4 accessors
  });

  test("tool-gate enable_tool carries gating:{core:true}", async () => {
    // enable_tool is registered inside toolGateExtension; extract via a stub pi
    // (as in Task 2) and assert gating.core === true.
    expect(true).toBe(true); // replace with real assertion
  });

  test("NEGATIVE: stripping gating from a pilot tool fails the guard", async () => {
    // Sanity that the guard bites: take a known pilot def, delete .gating,
    // re-assert → expect failure. (Use try/catch + expect().toThrow or invert.)
    // This proves the guard is not vacuously passing.
    expect(true).toBe(true); // replace with real negative-case
  });
});
```

> **Resolve accessors first (no placeholders in final):** before finalizing, grep each pilot for its exported factory/registry surface and replace the `expect(true).toBe(true)` shims + the `INSPECT_TOOL_FACTORIES` accessor with the real ones. The drift-guard's value is only real if it actually enumerates the pilot tools — a stub guard that passes vacuously is a plan failure. If a pilot has no single registry (tools are registered inside the extension entry), enumerate them via the stub-pi capture pattern from Task 4 and assert over the captured list.

- [ ] **Step 2: Run the drift-guard test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test extensions/drift-guard.test.ts )`
Expected: FAIL — until accessors are real and every pilot tool carries gating (after Tasks 3–4 land, the positive cases pass; the negative case must be constructed to throw).

- [ ] **Step 3: Finalize the drift-guard with real accessors + make it pass**

Resolve the accessors (per the note above) so all positive cases enumerate real pilot defs and the negative case proves the guard bites. Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test extensions/drift-guard.test.ts )` → PASS.

- [ ] **Step 4: Write the schema-cost agreement test (03 fold-in)**

Create `bun-apps/pi-agent-ext-tool-gate/extensions/schema-cost-agreement.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { measureToolTokens } from "./tool-gate.ts";
import { estimateToolCost } from "@repo/pi-agent-ext-power-tool/schema-cost";

const SAMPLE_DEFS = [
  { name: "read", description: "Read the contents of a file.", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "empty", description: "", parameters: {} },
  { name: "big", description: "x".repeat(200), parameters: { type: "object", properties: { a: { type: "string", description: "d".repeat(50) } } } },
];

describe("schema-cost heuristic agreement (tool-gate inline == power-tool canonical)", () => {
  test("measureToolTokens matches estimateToolCost().approxTokens across samples", () => {
    for (const def of SAMPLE_DEFS) {
      const inline = measureToolTokens(def);
      const canonical = estimateToolCost(def, "(test)").approxTokens;
      expect(inline, `def "${def.name}"`).toBe(canonical);
    }
  });
});
```

> **Verify:** `@repo/pi-agent-ext-power-tool/schema-cost` must re-export `estimateToolCost` (it does — `power-tool/src/schema-cost/index.ts:16`). This is a dev-time cross-package test import, consistent with tool-gate's existing QA imports (ticket 03 ruled test-time imports acceptable). Confirm `estimateToolCost(def, source).approxTokens` is the field (see `power-tool/src/schema-cost/estimate.ts:35`).

- [ ] **Step 5: Run the agreement test**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test extensions/schema-cost-agreement.test.ts )`
Expected: PASS — both use `(desc.length + JSON.stringify(params).length) / 4` (rounded); they agree. If it fails, the heuristics have drifted — fix the inline copy to match canonical (do not change canonical).

- [ ] **Step 6: Remove the `@deprecated delegate` scaffolding in pi-agent-cli**

In `bun-apps/pi-agent-cli/src/commands/schema-cost.ts`, remove the `@deprecated delegate` re-export block (~lines 48–52 — the `export type { ToolCost, SchemaCostReport }` alias + the deprecated comment block). Keep the actual `schema-cost` command logic (which delegates to power-tool's engine — host→extension, in-bounds). Confirm no other file imports those aliases from this module: `grep -rn "from.*pi-agent-cli.*schema-cost" bun-apps/ | grep -E "ToolCost|SchemaCostReport"`.

- [ ] **Step 7: Run the CLI's schema-cost self-check + full suites**

Run: `bun run --cwd bun-apps/pi-agent-cli schema-cost --self-test 2>/dev/null || ( cd bun-apps/pi-agent-cli && bun test )`
Expected: the schema-cost command still works (delegates to power-tool); all suites green.

> **If `schema-cost --self-test` is not a real flag**, run the CLI's test suite instead (`( cd bun-apps/pi-agent-cli && bun test )`) and optionally a manual `schema-cost` invocation per `pi-agent-cli`'s README.

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/drift-guard.test.ts bun-apps/pi-agent-ext-tool-gate/extensions/schema-cost-agreement.test.ts bun-apps/pi-agent-cli/src/commands/schema-cost.ts
git commit -m "test(tool-gate): scoped drift-guard + schema-cost agreement; drop @deprecated delegate

Drift-guard strict-fails on pilot tools missing gating (built-ins exempt; scoped
to 3 pilots). Schema-cost agreement test pins the inline heuristic to power-tool's
canonical estimateToolCost. Removes the @deprecated delegate re-export scaffolding
(consumers import from power-tool directly)."
```

---

## Self-Review (run after writing — results recorded here)

**1. Spec coverage:**
- §3 Gating contract → Task 1 (type) ✓
- §4 type augmentation per pilot → Tasks 1/3/4 (3 identical `.d.ts`) ✓
- §5.1 tool-gate consumer switch + hybrid merge → Tasks 1–2 ✓
- §5.2 power-tool inspect_* (incl. orphan fix) → Task 3 ✓
- §5.3 core-task core tools → Task 4 ✓
- §5.4 tool-gate enable_tool core → Task 2 Step 6 ✓
- §5.5 drift-guard scoped to pilots → Task 5 ✓
- §5.6 schema-cost guard + `@deprecated` cleanup → Task 5 ✓
- §8 acceptance criteria #8 (no ext↔ext dep) → Global Constraint + grep-verifiable; the only new cross-package imports are dev-time test imports (drift-guard, schema-cost agreement), allowed by ticket 03 ✓

**2. Placeholder scan:** Task 5's drift-guard has `expect(true).toBe(true)` shims + an `INSPECT_TOOL_FACTORIES` accessor marked "resolve first." These are flagged for the implementer to replace with real accessors before the test is considered passing — the plan explicitly states a vacuously-passing guard is a failure. **This is the one area the implementer must finalize against the real export surface; all other steps have concrete code.**

**3. Type consistency:** `Gating` (ambient, identical across 3 `.d.ts`); `EffectiveGates { gates, core, tracked }`; `buildEffectiveGates(defs, fallbackGates?, fallbackCore?)`; `filterActive(…, tracked = TRACKED_TOOLS)`; `updateSticky(…, gates = GATES)` — names match across Tasks 1–2. `getAllToolDefinitions()` declared on `ExtensionAPI` in the `.d.ts` and cast in `getDiscovered()`. ✓

## Execution Handoff

Plan complete and saved to `.planning/2026-08-02-taxonomy-gating-field-migration/plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
