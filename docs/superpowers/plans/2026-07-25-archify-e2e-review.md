# Archify Integration-Layer E2E + Defect Hunt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in (`PI_AGENT_E2E=1`) integration e2e that drives the registered archify tools through `execute()` over the full IR → vendored CLI → on-disk artifact path, then produce a findings receipt.

**Architecture:** One new test file, `__tests__/e2e.test.ts`, built incrementally across five tasks. A recorder-pi captures the registered tool objects (Layer 1); later layers call `.execute()` on those captured objects (Layers 2–4) so the test exercises the real `defineTool` boundary + `ctx` wiring, not the lib functions directly. A final task runs the gated suite and writes a findings receipt.

**Tech Stack:** Bun test runner (`bun:test`), Node `fs`/`os`/`path`, typebox, `@earendil-works/pi-coding-agent` `defineTool`.

## Global Constraints

- Gate every test behind `PI_AGENT_E2E === "1"` via `describe.skip` default (matches `bun-apps/pi-agent-ext-deploy/__tests__/e2e.test.ts`).
- Never top-level `cd`; use absolute paths or subshells.
- Call vendored CLI only through the package-local `runArchify` (via the tool's `execute()`); never shell out to `../archify`.
- No edits to `lib/` or `vendored/` — this plan adds tests + a receipt only. Defect fixes are a follow-up.
- Run the package's tests from repo root: `( cd bun-apps/pi-agent-ext-archify && bun test )`. Gated suite: prefix `PI_AGENT_E2E=1`.
- The `defineTool` `.execute()` call signature (established repo pattern) is: `tool.execute(toolCallId, params, signal, onUpdate, ctx)` where `ctx = { cwd }`. Coerce with `as never` to satisfy the union type.

---

### Task 1: Harness + Layer 1 (registration contract)

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts`

**Interfaces:**
- Consumes: default export of `../extensions/archify.ts` (an `ExtensionFactory`).
- Produces: `makeRecorderPi()` (returns `{ pi, tools }`) and `withTempCwd()` helper used by all later tasks.

- [ ] **Step 1: Write the harness + Layer 1 test**

Create `bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/archify.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Create a fresh temp cwd, tracked for afterAll cleanup. */
function withTempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "archify-e2e-"));
  tempDirs.push(d);
  return d;
}

/**
 * Recorder pi: captures every tool object passed to registerTool so later
 * layers can call .execute() on the actually-registered tools.
 */
function makeRecorderPi() {
  const tools: { name: string; execute: (id: string, p: unknown, s: unknown, u: unknown, ctx: { cwd: string }) => Promise<unknown> }[] = [];
  const pi = {
    registerTool: (t: unknown) => {
      const tool = t as { name: string; execute: (id: string, p: unknown, s: unknown, u: unknown, ctx: { cwd: string }) => Promise<unknown> };
      tools.push(tool);
    },
  };
  return { pi, tools };
}

/** ctx arg for execute(), coerced to satisfy the ToolExecuteContext union. */
const ctxFor = (cwd: string) => ({ cwd } as never);

describeMaybe("archify e2e — Layer 1: registration contract", () => {
  test("registers exactly {archify_render, archify_validate, archify_delta}", () => {
    const { pi, tools } = makeRecorderPi();
    factory(pi as never);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["archify_delta", "archify_render", "archify_validate"].sort(),
    );
  });
});
```

- [ ] **Step 2: Run the gated suite — verify pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts )
```
Expected: 1 pass, 0 fail.

- [ ] **Step 3: Teeth check — confirm the test catches a missing tool**

Temporarily edit `extensions/archify.ts` to comment out `pi.registerTool(deltaTool);`, re-run Step 2, confirm FAIL, then revert. (Do not commit the comment-out.)

- [ ] **Step 4: Confirm the gate skips by default**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && bun test __tests__/e2e.test.ts )
```
Expected: 0 pass, 0 fail (suite skipped — `describe.skip`).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts
git commit -m "test(archify): e2e harness + registration contract (Layer 1)"
```

---

### Task 2: Layer 2 — dispatch integration (happy paths)

**Files:**
- Modify: `bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `makeRecorderPi`, `withTempCwd`, `ctxFor` from Task 1; fixture `__tests__/fixtures/mini.architecture.json`; vendored examples `checkout-platform.{base,head}.architecture.json`.
- Produces: `registeredTool(name)` lookup helper used by Tasks 3–4.

- [ ] **Step 1: Add the helper + Layer 2 test**

Append to `__tests__/e2e.test.ts` (inside the file, after the Layer 1 block). Add a module-scope helper and a new `describeMaybe`:

```ts
const VENDORED_EXAMPLES = join(import.meta.dir, "..", "vendored", "examples");
const FIXTURE = join(import.meta.dir, "fixtures", "mini.architecture.json");

/** Load the factory once and look up a registered tool by name. */
function registeredTool(name: string) {
  const { pi, tools } = makeRecorderPi();
  factory(pi as never);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

describeMaybe("archify e2e — Layer 2: dispatch integration", () => {
  test("render.execute() produces a self-contained HTML + receipt on disk", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_render");
    const res = (await tool.execute("e2e-id", { ir: JSON.parse(readFileSync(FIXTURE, "utf8")), type: "architecture" }, new AbortController().signal, undefined, ctxFor(cwd))) as {
      content: { type: string; text: string }[]; details: { path: string; artifact?: unknown; validation?: unknown };
    };
    expect(res.content[0]!.text).toContain("Rendered architecture diagram");
    const htmlPath = res.details.path;
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/<html|<svg/i);
    expect(res.details.artifact).toBeDefined();
    expect(res.details.validation).toBeDefined();
  }, 30_000);

  test("validate.execute() returns a structured valid report", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_validate");
    const res = (await tool.execute("e2e-id", { ir: JSON.parse(readFileSync(FIXTURE, "utf8")) }, new AbortController().signal, undefined, ctxFor(cwd))) as {
      content: { type: string; text: string }[]; isError?: boolean; details: { type?: string; report?: { composition?: unknown } };
    };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("valid");
    expect(res.details.type).toBe("architecture");
    expect(res.details.report?.composition).toBeDefined();
  }, 30_000);

  test("delta.execute() produces HTML + receipt sidecar from two IR files", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_delta");
    const base = join(VENDORED_EXAMPLES, "checkout-platform.base.architecture.json");
    const head = join(VENDORED_EXAMPLES, "checkout-platform.head.architecture.json");
    const res = (await tool.execute("e2e-id", { basePath: base, headPath: head }, new AbortController().signal, undefined, ctxFor(cwd))) as {
      content: { type: string; text: string }[]; details: { path: string; receipt: string };
    };
    expect(res.content[0]!.text).toContain("Rendered architecture delta");
    expect(existsSync(res.details.path)).toBe(true);
    expect(existsSync(res.details.receipt)).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run the gated suite — verify pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts )
```
Expected: 4 pass (1 from Layer 1 + 3 from Layer 2), 0 fail. **If a Layer 2 case fails, that is a finding — record the failure verbatim for Task 5, do not silently weaken the assertion.**

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts
git commit -m "test(archify): e2e dispatch integration happy paths (Layer 2)"
```

---

### Task 3: Layer 3 — cross diagram-type matrix

**Files:**
- Modify: `bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `registeredTool`, `withTempCwd`, `ctxFor`, `VENDORED_EXAMPLES` from Tasks 1–2.
- Produces: nothing (final coverage layer).

- [ ] **Step 1: Append the matrix describe**

Append to `__tests__/e2e.test.ts`:

```ts
const MATRIX = [
  { type: "architecture", file: "production-deployment.architecture.json" },
  { type: "sequence", file: "async-job-roundtrip.sequence.json" },
  { type: "workflow", file: "agent-tool-call.workflow.json" },
  { type: "dataflow", file: "event-stream.dataflow.json" },
  { type: "lifecycle", file: "agent-run.lifecycle.json" },
] as const;

describeMaybe("archify e2e — Layer 3: cross diagram-type matrix", () => {
  for (const { type, file } of MATRIX) {
    test(`render+validate ${type} via execute()`, async () => {
      const cwd = withTempCwd();
      const irPath = join(VENDORED_EXAMPLES, file);
      const ir = JSON.parse(readFileSync(irPath, "utf8"));

      const validate = registeredTool("archify_validate");
      const vRes = (await validate.execute("e2e-id", { ir, type }, new AbortController().signal, undefined, ctxFor(cwd))) as { isError?: boolean };
      expect(vRes.isError).toBeFalsy();

      const render = registeredTool("archify_render");
      const rRes = (await render.execute("e2e-id", { ir, type }, new AbortController().signal, undefined, ctxFor(cwd))) as { content: { text: string }[]; details: { path: string } };
      expect(rRes.content[0]!.text).toContain(`Rendered ${type} diagram`);
      expect(existsSync(rRes.details.path)).toBe(true);
    }, 30_000);
  }
});
```

- [ ] **Step 2: Run the gated suite — verify pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts )
```
Expected: 9 pass (4 + 5 matrix), 0 fail. **Any matrix type that fails is a finding for Task 5 — capture the type + error verbatim. Do not weaken assertions to force green.**

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts
git commit -m "test(archify): e2e cross diagram-type matrix (Layer 3)"
```

---

### Task 4: Negative cases through execute()

**Files:**
- Modify: `bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `registeredTool`, `withTempCwd`, `ctxFor`, `FIXTURE` from Tasks 1–2.
- Produces: nothing.

- [ ] **Step 1: Append the negative-cases describe**

Append to `__tests__/e2e.test.ts`:

```ts
describeMaybe("archify e2e — negative cases across the defineTool wrapper", () => {
  test("delta with non-architecture type returns isError, no throw", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_delta");
    const res = (await tool.execute("e2e-id", { basePath: FIXTURE, headPath: FIXTURE, type: "sequence" }, new AbortController().signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain("architecture");
  }, 30_000);

  test("render with malformed IR surfaces an honest error (no uncaught throw)", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_render");
    const res = (await tool.execute("e2e-id", { ir: { diagram_type: "architecture", components: "not-an-array" }, type: "architecture" }, new AbortController().signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
  }, 30_000);

  test("an already-aborted signal never reports a successful render", async () => {
    const cwd = withTempCwd();
    const tool = registeredTool("archify_render");
    const ac = new AbortController();
    ac.abort();
    const res = (await tool.execute("e2e-id", { ir: JSON.parse(readFileSync(FIXTURE, "utf8")), type: "architecture" }, ac.signal, undefined, ctxFor(cwd))) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run the gated suite — verify pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts )
```
Expected: 12 pass (9 + 3), 0 fail.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts
git commit -m "test(archify): e2e negative cases across defineTool wrapper"
```

---

### Task 5: Run full suite + write findings receipt

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/receipts/archify-e2e-2026-07-25.md`

**Interfaces:**
- Consumes: the completed `__tests__/e2e.test.ts`; the verbatim output of the gated run.
- Produces: the findings receipt (the "review results" deliverable).

- [ ] **Step 1: Run the full gated suite and capture output**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts 2>&1 ) | tee /tmp/archify-e2e-out.txt
```
Capture the pass/fail count and any failure text.

- [ ] **Step 2: Write the findings receipt**

Create `bun-apps/pi-agent-ext-archify/receipts/archify-e2e-2026-07-25.md`. Fill in the actual pass/fail from Step 1; the template below assumes all-green — if any case failed, move it into the Findings section with the verbatim error.

```markdown
# Archify Integration-Layer E2E — Findings (2026-07-25)

Suite: `PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts`
Spec: `docs/superpowers/specs/2026-07-25-archify-e2e-review-design.md`

## Result

- 12 cases run, 12 pass, 0 fail.

## Matrix (tool × diagram-type)

| Tool | architecture | sequence | workflow | dataflow | lifecycle |
|------|--------------|----------|----------|----------|-----------|
| validate | pass | pass | pass | pass | pass |
| render  | pass | pass | pass | pass | pass |
| delta   | pass (architecture-only) | n/a | n/a | n/a | n/a |

## Findings

None. The integration layer (registration → `defineTool` `execute()` → `ctx` wiring → vendored CLI → on-disk artifact + receipt) is trustworthy end-to-end across all five diagram types. Negative cases confirm errors survive the wrapper without uncaught throws.

## Verdict

No defects surfaced at the integration layer. Recommend keeping the gated suite as an opt-in regression check (run before any change to `extensions/archify.ts`, `lib/run.ts`, or on vendored re-sync). No follow-up fix work required from this review.
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/receipts/archify-e2e-2026-07-25.md
git commit -m "docs(archify): e2e integration findings receipt"
```

- [ ] **Step 4: Sanity — confirm default (ungated) run still skips and full package test stays green**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && bun test )
```
Expected: all pre-existing unit tests pass; e2e suite skipped (no new failures, no slowdown).
