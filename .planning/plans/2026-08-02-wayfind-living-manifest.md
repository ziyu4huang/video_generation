# Wayfind Layer 3 — Living Effort Manifest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the effort manifest self-tracking (`last:` auto-stamps) and self-describing (active effort's `status` shows in the status bar when idle), plus a `/wayfind validate` command — so any session sees a living picture of each effort.

**Architecture:** Pure data-layer helpers in `map.ts` (`readEffortMeta`, `touchEffortManifest`, `today()`, `writeMap` inline stamp) feed two surfaces: the `WayfindOverlay` (reads the manifest on idle render) and a new `/wayfind validate` command (wraps the existing `validateEffort`). Manifest stays opt-in (legacy byte-compat preserved); status transitions stay manual.

**Tech Stack:** TypeScript (strict), TypeBox, `@earendil-works/pi-coding-agent`, `bun:test`. Package: `bun-apps/pi-agent-ext-wayfind`.

## Global Constraints

- Work ONLY in worktree `/Users/huangziyu/proj/video_generation__wayfind-living` (branch `feature/wayfind-living-manifest`, based on `main` @ `c0e66965`). Never top-level `cd` — use `( cd <dir> && ... )` or `git -C`.
- Verify per task with `( cd bun-apps/pi-agent-ext-wayfind && bun run test:unit )`. Full gate before PR: `( cd bun-apps/pi-agent-ext-wayfind && bun run test )` (= biome check + tsc build + unit tests).
- Biome enforces import ordering; if a check fails, run `( cd bun-apps/pi-agent-ext-wayfind && bunx biome check --write . )` then re-verify.
- TDD: write the failing test, watch it fail, implement, watch it pass — every task.
- Manifest is opt-in: never emit front-matter for legacy (meta-less) maps. Status (`active`/`paused`/`complete`) is NEVER auto-flipped — only `last:` is auto-stamped.

## File Structure

- **`src/map.ts`** (modify) — add `today()`, `readEffortMeta`, `touchEffortManifest`; stamp `last:` inline in `writeMap`.
- **`src/overlay.ts`** (modify) — add `activeEffort`/`activeCwd` fields, `setActiveEffort()`, manifest-line branch in `render()`, clear in `dispose()`.
- **`src/commands.ts`** (modify) — add `validate` keyword + `handleWayfindValidate`; call `overlay.setActiveEffort()` from `handleWayfinderChart`.
- **`tests/map-frontmatter.test.ts`** (modify) — tests for `readEffortMeta`, `touchEffortManifest`, `writeMap` stamp; fix the existing `last:`-pinning assertion.
- **`src/__tests__/overlay.test.ts`** (modify) — tests for the persistent manifest line + precedence.
- **`tests/commands.test.ts`** (modify) — tests for `/wayfind validate` + the overlay wiring.

---

### Task 1: `map.ts` manifest helpers — `readEffortMeta` + `touchEffortManifest` + `today()`

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/map.ts` (add 3 exports near the front-matter parsers)
- Test: `bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts`

**Interfaces:**
- Produces: `readEffortMeta(cwd: string, effort: string): EffortMeta | null` (reads only `map.md` front-matter, no ticket scan); `touchEffortManifest(cwd: string, effort: string): void` (bumps `last:` in place, body verbatim, no-op on legacy/missing). Later tasks: Task 3's `writeMap` + Task 4's overlay consume these.

- [ ] **Step 1: Write the failing tests** — append to `tests/map-frontmatter.test.ts`. Add `readEffortMeta` and `touchEffortManifest` to the existing import from `"../src/map.js"`:

```typescript
describe("readEffortMeta", () => {
  it("reads only the manifest (no ticket scan)", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "x", destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [],
      meta: { effort: "x", status: "active" },
    });
    expect(readEffortMeta(cwd, "x")).toEqual<EffortMeta>({ effort: "x", status: "active" });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null for a legacy (no front-matter) map", () => {
    const cwd = fresh();
    writeMap(cwd, { effort: "legacy", destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [] });
    expect(readEffortMeta(cwd, "legacy")).toBeNull();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null when there is no map", () => {
    const cwd = fresh();
    expect(readEffortMeta(cwd, "ghost")).toBeNull();
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("touchEffortManifest", () => {
  const todayStr = () => new Date().toISOString().slice(0, 10);

  it("bumps last: on a manifest map and leaves the body verbatim", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "x", destination: "BODY LINE ONE", notes: "n", decisions: [], fog: [], outOfScope: [], tickets: [],
      meta: { effort: "x", created: "2020-01-01", status: "active" },
    });
    const path = join(cwd, ".planning", "x", "map.md");
    const before = readFileSync(path, "utf-8");
    const bodyBefore = before.split("---\n").pop();
    touchEffortManifest(cwd, "x");
    const after = readFileSync(path, "utf-8");
    expect(after).toContain(`last: ${todayStr()}`);
    expect(after.split("---\n").pop()).toBe(bodyBefore); // body byte-for-byte unchanged
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is a no-op on a legacy (no front-matter) map", () => {
    const cwd = fresh();
    writeMap(cwd, { effort: "legacy", destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [] });
    const path = join(cwd, ".planning", "legacy", "map.md");
    const before = readFileSync(path, "utf-8");
    touchEffortManifest(cwd, "legacy");
    expect(readFileSync(path, "utf-8")).toBe(before);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is a no-op when there is no map", () => {
    const cwd = fresh();
    expect(() => touchEffortManifest(cwd, "ghost")).not.toThrow();
    rmSync(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/map-frontmatter.test.ts )`
Expected: FAIL — `readEffortMeta` / `touchEffortManifest` are not exported (undefined).

- [ ] **Step 3: Implement** — add to `src/map.ts` (near `serializeMapFrontmatter`):

```typescript
/** Today's date as YYYY-MM-DD (the manifest `last` convention). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Read ONLY the effort manifest (`map.md` front-matter) — no `tickets/` scan.
 *  Returns null when there's no map or no front-matter. Cheap enough for the
 *  status overlay to call per-render. */
export function readEffortMeta(cwd: string, effort: string): EffortMeta | null {
  const mapPath = join(effortDir(cwd, effort), "map.md");
  if (!existsSync(mapPath)) return null;
  return parseMapFrontmatter(readFileSync(mapPath, "utf-8")).meta;
}

/** Bump the manifest's `last:` date in place. No-op when there's no map or no
 *  front-matter (legacy-safe). The body after the closing `---` is preserved
 *  byte-for-byte — only the leading front-matter block is rewritten. */
export function touchEffortManifest(cwd: string, effort: string): void {
  const mapPath = join(effortDir(cwd, effort), "map.md");
  if (!existsSync(mapPath)) return;
  const raw = readFileSync(mapPath, "utf-8");
  const { meta } = parseMapFrontmatter(raw);
  if (!meta) return; // legacy / no manifest → no-op
  const todayStr = today();
  const replaced = raw.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_full, fmBody: string) => {
    const lines = fmBody.split(/\r?\n/);
    const lastIdx = lines.findIndex((l) => /^last:\s*/.test(l));
    if (lastIdx >= 0) {
      lines[lastIdx] = `last: ${todayStr}`;
    } else {
      const effortIdx = lines.findIndex((l) => /^effort:\s*/.test(l));
      if (effortIdx >= 0) lines.splice(effortIdx + 1, 0, `last: ${todayStr}`);
      else lines.push(`last: ${todayStr}`);
    }
    return `---\n${lines.join("\n")}\n---`;
  });
  if (replaced === raw) return;
  writeFileSync(mapPath, replaced, "utf-8");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/map-frontmatter.test.ts )`
Expected: PASS (all `readEffortMeta` + `touchEffortManifest` cases).

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__wayfind-living add bun-apps/pi-agent-ext-wayfind/src/map.ts bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts
git -C /Users/huangziyu/proj/video_generation__wayfind-living commit -m "feat(wayfind): readEffortMeta + touchEffortManifest helpers (layer 3)"
```

---

### Task 2: `writeMap` inline `last:` stamp (and fix the existing pinned assertion)

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/map.ts` (`writeMap`)
- Test: `bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts`

**Interfaces:**
- Consumes: `today()` from Task 1.
- Produces: `writeMap` now sets `meta.last = today()` when `meta` is present (callers transparently get a fresh `last:`).

- [ ] **Step 1: Write/fix the tests** — in `tests/map-frontmatter.test.ts`:

First FIX the existing assertion that pins `last:` to a literal date (it will break once `writeMap` stamps). In the `"writeMap emits front-matter when meta is present and readMap parses it back"` test, change:

```typescript
// BEFORE:
expect(back?.meta).toEqual<EffortMeta>(META_FULL);
// AFTER (last: is now auto-stamped to today):
expect(back?.meta).toEqual<EffortMeta>({ ...META_FULL, last: new Date().toISOString().slice(0, 10) });
```

Then ADD a focused test in the same `describe("readMap / writeMap: front-matter integration ...")` block:

```typescript
it("writeMap stamps last: (today) inline when meta is present", () => {
  const cwd = fresh();
  writeMap(cwd, {
    effort: "x", destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [],
    meta: { effort: "x", created: "2020-01-01", status: "active" }, // no last: supplied
  });
  const onDisk = readFileSync(join(cwd, ".planning", "x", "map.md"), "utf-8");
  expect(onDisk).toContain(`last: ${new Date().toISOString().slice(0, 10)}`);
  rmSync(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/map-frontmatter.test.ts )`
Expected: FAIL — the new test fails (`last:` not emitted); the fixed assertion also fails until the stamp lands.

- [ ] **Step 3: Implement** — in `src/map.ts` `writeMap`, compute the front-matter from a stamped meta. Replace the `const front = ...` line:

```typescript
// BEFORE:
const front = map.meta ? serializeMapFrontmatter(map.meta) : "";
// AFTER:
const front = map.meta ? serializeMapFrontmatter({ ...map.meta, last: today() }) : "";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/map-frontmatter.test.ts )`
Expected: PASS (new stamp test + the fixed assertion + all existing).

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__wayfind-living add bun-apps/pi-agent-ext-wayfind/src/map.ts bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts
git -C /Users/huangziyu/proj/video_generation__wayfind-living commit -m "feat(wayfind): writeMap auto-stamps manifest last: (layer 3)"
```

---

### Task 3: `WayfindOverlay` persistent manifest line

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/overlay.ts`
- Test: `bun-apps/pi-agent-ext-wayfind/src/__tests__/overlay.test.ts`

**Interfaces:**
- Consumes: `readEffortMeta(cwd, effort)` from Task 1.
- Produces: `WayfindOverlay.setActiveEffort(effort: string | undefined, cwd: string | undefined): void`; `render()` gains a manifest-line branch (precedence: transient action > manifest > empty). Task 4 wires `setActiveEffort` from the command handler.

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/overlay.test.ts`. Add imports at the top (alongside the existing `WayfindOverlay` import):

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMap } from "../map.js";
```

Then append:

```typescript
describe("WayfindOverlay — persistent manifest line", () => {
  it("shows the active effort's manifest status when idle", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-ov-"));
    writeMap(cwd, {
      effort: "demo", destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [],
      meta: { effort: "demo", status: "active" },
    });
    const o = new WayfindOverlay();
    o.setActiveEffort("demo", cwd);
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 🗺️ demo · active"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shows (no manifest) for a legacy active effort", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-ov-"));
    writeMap(cwd, { effort: "legacy", destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [] });
    const o = new WayfindOverlay();
    o.setActiveEffort("legacy", cwd);
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 🗺️ legacy · (no manifest)"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("renders nothing when there is no active effort and no transient state", () => {
    const o = new WayfindOverlay();
    expect(o.render({} as Theme, 80)).toEqual([]);
  });

  it("a transient action line takes precedence over the manifest line", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-ov-"));
    writeMap(cwd, {
      effort: "demo", destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [],
      meta: { effort: "demo", status: "active" },
    });
    const o = new WayfindOverlay();
    o.setActiveEffort("demo", cwd);
    o.setLine("charting", "charting demo");
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 🗺️ charting demo"]);
    rmSync(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test src/__tests__/overlay.test.ts )`
Expected: FAIL — `setActiveEffort` is not a function.

- [ ] **Step 3: Implement** — in `src/overlay.ts`. Add the import and the fields/method/render branch:

```typescript
import { readEffortMeta } from "./map.js";
```

Add fields to the class (alongside `state`/`text`/`refresh`):

```typescript
  private activeEffort: string | undefined;
  private activeCwd: string | undefined;
```

Add the method (after `setLine`):

```typescript
  /** Set the active effort whose manifest status renders when idle (no transient action). */
  setActiveEffort(effort: string | undefined, cwd: string | undefined): void {
    this.activeEffort = effort;
    this.activeCwd = cwd;
    this.refresh?.();
  }
```

Extend `dispose()` to clear them:

```typescript
  dispose(): void {
    this.state = undefined;
    this.text = undefined;
    this.activeEffort = undefined;
    this.activeCwd = undefined;
  }
```

Replace `render()`:

```typescript
  render(_theme: Theme, _width: number): string[] {
    if (this.state !== undefined && this.text !== undefined) {
      return [`${BRAND_PREFIX}${STATE_EMOJI[this.state]} ${this.text}`];
    }
    if (this.activeEffort && this.activeCwd) {
      const meta = readEffortMeta(this.activeCwd, this.activeEffort);
      const status = meta?.status ?? "(no manifest)";
      return [`${BRAND_PREFIX}🗺️ ${this.activeEffort} · ${status}`];
    }
    return [];
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test src/__tests__/overlay.test.ts )`
Expected: PASS (all 4 new + existing overlay tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__wayfind-living add bun-apps/pi-agent-ext-wayfind/src/overlay.ts bun-apps/pi-agent-ext-wayfind/src/__tests__/overlay.test.ts
git -C /Users/huangziyu/proj/video_generation__wayfind-living commit -m "feat(wayfind): overlay shows active effort manifest status when idle (layer 3)"
```

---

### Task 4: Wire `overlay.setActiveEffort` into `/wayfind` charting

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts` (`handleWayfinderChart`)
- Test: `bun-apps/pi-agent-ext-wayfind/tests/commands.test.ts`

**Interfaces:**
- Consumes: `WayfindOverlay.setActiveEffort` from Task 3.
- Produces: charting a map (and claiming a ticket) sets the overlay's active effort so the manifest line shows when idle.

- [ ] **Step 1: Write the failing test** — append to `tests/commands.test.ts`. (`WayfindOverlay`, `createRuntimeState`, `registerCommands` are already imported; `createPi`/`makeCtx`/`makeCwd` helpers exist.)

```typescript
describe("/wayfind chart — overlay active-effort wiring", () => {
  it("charting a destination sets the overlay's active effort + cwd", async () => {
    const overlay = new WayfindOverlay();
    let spy: { effort?: string; cwd?: string } = {};
    overlay.setActiveEffort = (effort, cwd) => {
      spy = { effort, cwd };
    };
    const state = createRuntimeState();
    const pi = createPi();
    registerCommands(pi as unknown as Parameters<typeof registerCommands>[0], state, overlay);
    const cwd = makeCwd();
    await pi.commands.get("wayfind")?.("Redesign the checkout flow", makeCtx(cwd));
    expect(spy.effort).toBeTruthy();
    expect(spy.cwd).toBe(cwd);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: FAIL — `spy.effort` is undefined (setActiveEffort never called).

- [ ] **Step 3: Implement** — in `src/commands.ts` `handleWayfinderChart`, call `overlay.setActiveEffort(effort, ctx.cwd)` at each site that sets `state.activeEffortBySession`. There are two sites:

In the **chart path** (right after `state.activeEffortBySession.set(sessionId, effort);` following `chartMap(...)`):

```typescript
    state.activeEffortBySession.set(sessionId, effort);
    overlay.setActiveEffort(effort, ctx.cwd);
```

In the **claim-ticket path** (right after `state.activeEffortBySession.set(sessionId, effort);` following the `claimNextTicket` success block):

```typescript
      state.activeEffortBySession.set(sessionId, effort);
      overlay.setActiveEffort(effort, ctx.cwd);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: PASS (new wiring test + all existing command tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__wayfind-living add bun-apps/pi-agent-ext-wayfind/src/commands.ts bun-apps/pi-agent-ext-wayfind/tests/commands.test.ts
git -C /Users/huangziyu/proj/video_generation__wayfind-living commit -m "feat(wayfind): wire overlay active-effort into /wayfind chart (layer 3)"
```

---

### Task 5: `/wayfind validate [effort]` command

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts` (keyword set, dispatcher switch, new handler, command description)
- Test: `bun-apps/pi-agent-ext-wayfind/tests/commands.test.ts`

**Interfaces:**
- Consumes: `validateEffort(cwd, effort)` + `renderValidate(result)` from `src/effort-tool.ts` (already on `main`).
- Produces: `/wayfind validate [effort]` surfaces the conformance check via the command surface (parallel to the `wayfind_effort` tool's `validate` action).

- [ ] **Step 1: Write the failing tests** — append to `tests/commands.test.ts`. Add `createEffort` to the import from `"../src/effort-tool.js"` (new import line) — it is already exported.

```typescript
describe("/wayfind validate — conformance command", () => {
  function ctxCapturing(cwd: string): { ctx: any; notifications: string[] } {
    const notifications: string[] = [];
    return {
      notifications,
      ctx: {
        cwd,
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: (m: string) => notifications.push(m), setStatus: () => {} },
      },
    };
  }

  it("notifies 'valid' on a conforming manifest effort", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    createEffort(cwd, { effort: "demo", destination: "ship the tool" }); // manifest + Destination
    const { ctx, notifications } = ctxCapturing(cwd);
    await pi.commands.get("wayfind")?.("validate demo", ctx);
    expect(notifications.some((n) => /valid/i.test(n))).toBe(true);
  });

  it("notifies problems on a map missing ## Destination", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    mkdirSync(join(cwd, ".planning", "bad", "tickets"), { recursive: true });
    writeFileSync(
      join(cwd, ".planning", "bad", "map.md"),
      ["---", "effort: bad", "status: active", "---", "", "# Wayfinder map: bad", "", "## Notes", "", "no destination"].join("\n"),
      "utf-8",
    );
    const { ctx, notifications } = ctxCapturing(cwd);
    await pi.commands.get("wayfind")?.("validate bad", ctx);
    expect(notifications.some((n) => /destination|invalid/i.test(n))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: FAIL — `validate` keyword not routed (no "valid" notification).

- [ ] **Step 3: Implement** — in `src/commands.ts`:

Add the import:

```typescript
import { renderValidate, validateEffort } from "./effort-tool.js";
```

Add `"validate"` to the keyword set:

```typescript
const WAYFIND_KEYWORDS = new Set(["status", "spec", "tickets", "seed", "sync", "done", "validate"]);
```

Add the handler (alongside the other `handleWayfind*` functions):

```typescript
  async function handleWayfindValidate(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify(`Usage: /wayfind validate <effort>  (or run /wayfind <destination> first)`, "warning");
      return;
    }
    ctx.ui.notify(renderValidate(validateEffort(ctx.cwd, effort)), "info");
  }
```

Add the route in the `wayfind` dispatcher's `switch (first)`:

```typescript
          case "validate":
            return handleWayfindValidate(remainder, ctx);
```

Update the `wayfind` command `description` to mention `'validate'`:

```typescript
    description:
      "Wayfinder family: '<destination>' (chart a map) or no args (work next ticket); 'status'/'spec'/'tickets'/'seed'/'sync'/'validate'/'done' [effort]",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: PASS (both new validate tests + all existing).

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__wayfind-living add bun-apps/pi-agent-ext-wayfind/src/commands.ts bun-apps/pi-agent-ext-wayfind/tests/commands.test.ts
git -C /Users/huangziyu/proj/video_generation__wayfind-living commit -m "feat(wayfind): /wayfind validate command (layer 3)"
```

---

## Final verification (before PR)

- [ ] **Full gate:** `( cd bun-apps/pi-agent-ext-wayfind && bun run test )` — biome check + tsc build + all unit tests pass.
- [ ] **Self-review against spec:** every spec section maps to a task (readEffortMeta/touchEffortManifest→T1, writeMap stamp→T2, overlay→T3, wiring→T4, validate cmd→T5; manifest-in-widget + auto-stamp + /wayfind validate all covered; opt-in + manual-status YAGNI boundaries held).
