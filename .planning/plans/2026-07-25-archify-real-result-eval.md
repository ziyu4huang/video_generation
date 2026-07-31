# Archify Real-Result Structural Evaluation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure `inspect-artifact` HTML parser and a gated (`PI_AGENT_E2E=1`) real-result test that generates real HTML for every diagram type and asserts structural fidelity + passage of the vendored `archify check`.

**Architecture:** One pure parser (`lib/inspect-artifact.ts`, unit-tested) extracts structural facts from a generated HTML string. A gated test (`__tests__/real-result.test.ts`) renders each diagram type via `lib/render.ts`'s `archifyRender`, inspects the on-disk HTML, and asserts round-trip integrity, functional self-containment, non-triviality, and `archify check` exit 0. A receipt records per-type facts.

**Tech Stack:** Bun test runner (`bun:test`), Node `fs`/`os`/`path`, regex-based HTML parsing (no DOM).

## Global Constraints

- Gate every test behind `PI_AGENT_E2E === "1"` via `describe.skip` default (matches the existing `__tests__/e2e.test.ts`).
- Never top-level `cd` (a hook blocks it). Run tests via `( cd bun-apps/pi-agent-ext-archify && <cmd> )`. Note: the Bash tool's cwd can drift if a prior command used a bare `cd`; if `git add`/`git commit` ever fails with a wrong-directory path, use `git -C <repo-root>`.
- No edits to `lib/render.ts` or `vendored/` — external refs are baked into `vendored/assets/template.html` and the snapshot policy forbids patching them. The eval documents them; it does not fix them.
- The only new `lib/` file is `inspect-artifact.ts` (pure, no side effects, no imports beyond Node builtins if any — ideally none).
- Optional-external-ref allowlist (exact hosts): `fonts.googleapis.com`, `fonts.gstatic.com`, `tt-a1i.github.io`. Any other external ref is `blocking` (required).

---

### Task 1: `inspect-artifact` parser + unit tests

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/lib/inspect-artifact.ts`
- Create: `bun-apps/pi-agent-ext-archify/__tests__/inspect-artifact.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export function inspectArtifact(html: string): ArtifactFacts` plus the `ArtifactFacts` and `ExternalRef` interfaces, used by Task 2.

- [ ] **Step 1: Write the failing unit tests**

Create `bun-apps/pi-agent-ext-archify/__tests__/inspect-artifact.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { inspectArtifact } from "../lib/inspect-artifact.ts";

describe("inspectArtifact", () => {
  const SAMPLE = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="generator" content="archify 2.12.0">
  <title>Production Deployment</title>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono" rel="stylesheet">
  <link href="https://tt-a1i.github.io/archify/start.html?type=architecture" rel="help">
</head>
<body>
  <script>console.log("inline");</script>
  <script src="https://evil.example.com/bundle.js"></script>
  <svg viewBox="0 0 1436 760" role="img">
    <g data-kind="frontend"><text>Customers</text></g>
    <g data-kind="backend"><text>API <tspan>Gateway</tspan></text></g>
    <g data-kind="database"><text>DB</text></g>
    <g data-kind="frontend"><text>Edge</text></g>
  </svg>
  <a href="https://tt-a1i.github.io/archify/start.html">Start</a>
  <img src="https://evil.example.com/logo.png">
</body>
</html>`;

  test("extracts document basics", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.hasDoctype).toBe(true);
    expect(f.hasSvg).toBe(true);
    expect(f.svgViewBox).toBe("0 0 1436 760");
    expect(f.title).toBe("Production Deployment");
    expect(f.generator).toBe("archify 2.12.0");
    expect(f.bytes).toBe(SAMPLE.length);
  });

  test("counts data-kind nodes and dedups kinds", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.nodeCount).toBe(4); // 4 groups carry data-kind (frontend x2)
    expect(f.nodeKinds.sort()).toEqual(["backend", "database", "frontend"]);
  });

  test("extracts text labels, stripping nested tags", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.textLabels).toContain("Customers");
    expect(f.textLabels).toContain("API Gateway"); // <tspan> stripped
    expect(f.textLabels).toContain("DB");
    expect(f.textLabels).toContain("Edge");
  });

  test("classifies external refs: optional allowlist vs required", () => {
    const f = inspectArtifact(SAMPLE);
    // optional (non-blocking): google fonts, gstatic, archify help
    const optionalUrls = f.externalRefs.filter((r) => !r.blocking).map((r) => r.url);
    expect(optionalUrls.some((u) => u.includes("fonts.googleapis.com"))).toBe(true);
    expect(optionalUrls.some((u) => u.includes("fonts.gstatic.com"))).toBe(true);
    expect(optionalUrls.some((u) => u.includes("tt-a1i.github.io"))).toBe(true);
    // required (blocking): external script + external img
    const requiredUrls = f.requiredExternalRefs.map((r) => r.url);
    expect(requiredUrls).toContain("https://evil.example.com/bundle.js");
    expect(requiredUrls.some((u) => u.endsWith("logo.png"))).toBe(true);
  });

  test("counts inline vs external scripts", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.inlineScripts).toBe(1);
    expect(f.externalScripts).toBe(1);
  });

  test("returns empty requiredExternalRefs for a clean offline artifact", () => {
    const clean = `<!doctype html><html><head><title>X</title></head>
      <body><svg viewBox="0 0 10 10"><g data-kind="a"><text>A</text></g></svg>
      <link rel="preconnect" href="https://fonts.gstatic.com"></body></html>`;
    const f = inspectArtifact(clean);
    expect(f.requiredExternalRefs).toEqual([]);
    expect(f.nodeCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && bun test __tests__/inspect-artifact.test.ts )
```
Expected: FAIL — `Cannot find module "../lib/inspect-artifact.ts"`.

- [ ] **Step 3: Implement the parser**

Create `bun-apps/pi-agent-ext-archify/lib/inspect-artifact.ts`:

```ts
/**
 * Pure HTML→structural-facts parser for generated archify artifacts.
 * No DOM/browser dependency — string + regex only. Used by the real-result
 * evaluation to assert generated-HTML quality (round-trip integrity,
 * functional self-containment, non-triviality).
 */

export interface ExternalRef {
  kind: "script" | "stylesheet" | "preconnect" | "image" | "anchor";
  url: string;
  /** true = absence breaks offline rendering (external script/img/non-allowlisted ref). */
  blocking: boolean;
}

export interface ArtifactFacts {
  bytes: number;
  hasDoctype: boolean;
  hasSvg: boolean;
  svgViewBox?: string;
  title?: string;
  generator?: string;
  /** distinct data-kind values on SVG groups. */
  nodeKinds: string[];
  /** count of groups carrying a data-kind attribute. */
  nodeCount: number;
  /** <text> contents, inner tags stripped, trimmed, de-duped. */
  textLabels: string[];
  inlineScripts: number;
  externalScripts: number;
  externalRefs: ExternalRef[];
  /** subset of externalRefs whose absence breaks offline rendering. */
  requiredExternalRefs: ExternalRef[];
}

/** External hosts that are cosmetic/help-only (system-font fallback exists). */
const OPTIONAL_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "tt-a1i.github.io"];

function isOptional(url: string): boolean {
  return OPTIONAL_HOSTS.some(
    (h) => url.startsWith(`https://${h}`) || url.startsWith(`http://${h}`) || url.startsWith(`//${h}`),
  );
}

export function inspectArtifact(html: string): ArtifactFacts {
  const bytes = html.length;
  const hasDoctype = /^\s*<!doctype html>/i.test(html);
  const hasSvg = /<svg\b/i.test(html);
  const svgViewBox = /<svg[^>]*\bviewBox="([^"]*)"/i.exec(html)?.[1];
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const generator = /<meta[^>]*name="generator"[^>]*content="([^"]*)"/i.exec(html)?.[1];

  const kindMatches = [...html.matchAll(/data-kind="([^"]*)"/g)];
  const nodeKinds = [...new Set(kindMatches.map((m) => m[1]!))];
  const nodeCount = kindMatches.length;

  const textMatches = [...html.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)];
  const textLabels = [
    ...new Set(
      textMatches
        .map((m) => m[1]!.replace(/<[^>]*>/g, "").trim())
        .filter((t) => t.length > 0),
    ),
  ];

  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]!);
  const externalScripts = scriptTags.filter((s) => /\bsrc=/i.test(s)).length;
  const inlineScripts = scriptTags.length - externalScripts;

  const externalRefs: ExternalRef[] = [];

  for (const m of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)]) {
    const url = m[1]!;
    externalRefs.push({ kind: "script", url, blocking: !isOptional(url) });
  }
  for (const m of [...html.matchAll(/<link\b[^>]*>/gi)]) {
    const tag = m[0];
    const href = /href="([^"]*)"/i.exec(tag)?.[1];
    if (!href || !/^https?:\/\//i.test(href)) continue;
    const rel = /rel="([^"]*)"/i.exec(tag)?.[1] ?? "";
    const kind: ExternalRef["kind"] = /preconnect|dns-prefetch/i.test(rel)
      ? "preconnect"
      : "stylesheet";
    externalRefs.push({ kind, url: href, blocking: !isOptional(href) });
  }
  for (const m of [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi)]) {
    const url = m[1]!;
    externalRefs.push({ kind: "image", url, blocking: !isOptional(url) });
  }
  for (const m of [...html.matchAll(/<a\b[^>]*\bhref="(https?:[^"]*)"/gi)]) {
    const url = m[1]!;
    externalRefs.push({ kind: "anchor", url, blocking: !isOptional(url) });
  }

  const requiredExternalRefs = externalRefs.filter((r) => r.blocking);

  return {
    bytes, hasDoctype, hasSvg, svgViewBox, title, generator,
    nodeKinds, nodeCount, textLabels, inlineScripts, externalScripts,
    externalRefs, requiredExternalRefs,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && bun test __tests__/inspect-artifact.test.ts )
```
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__archify add bun-apps/pi-agent-ext-archify/lib/inspect-artifact.ts bun-apps/pi-agent-ext-archify/__tests__/inspect-artifact.test.ts
git -C /Users/huangziyu/proj/video_generation__archify commit -m "feat(archify): inspect-artifact HTML facts parser + unit tests"
```

---

### Task 2: gated real-result test — uniform matrix + `archify check`

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/__tests__/real-result.test.ts`

**Interfaces:**
- Consumes: `inspectArtifact` from `lib/inspect-artifact.ts` (Task 1); `archifyRender` from `lib/render.ts` (`archifyRender(params: {ir?; irPath?; outputPath?; type?}, ctx: {cwd}, signal?) → {content, details: {path; type; artifact?; validation?}}`); `runArchify` from `lib/run.ts` (`runArchify(args: string[], cwd: string, signal?) → Promise<{stdout; stderr; status}>`).
- Produces: nothing (final coverage layer; Task 3 appends to this file).

- [ ] **Step 1: Write the gated matrix test**

Create `bun-apps/pi-agent-ext-archify/__tests__/real-result.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archifyRender } from "../lib/render.ts";
import { runArchify } from "../lib/run.ts";
import { inspectArtifact } from "../lib/inspect-artifact.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

const VENDORED_EXAMPLES = join(import.meta.dir, "..", "vendored", "examples");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
function withTempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "archify-real-"));
  tempDirs.push(d);
  return d;
}

const MATRIX = [
  { type: "architecture", file: "production-deployment.architecture.json" },
  { type: "sequence", file: "async-job-roundtrip.sequence.json" },
  { type: "workflow", file: "agent-tool-call.workflow.json" },
  { type: "dataflow", file: "event-stream.dataflow.json" },
  { type: "lifecycle", file: "agent-run.lifecycle.json" },
] as const;

describeMaybe("archify real-result — generated-HTML structural fidelity", () => {
  for (const { type, file } of MATRIX) {
    test(`${type}: round-trip integrity, self-containment, archify check`, async () => {
      const cwd = withTempCwd();
      const ir = JSON.parse(readFileSync(join(VENDORED_EXAMPLES, file), "utf8"));

      const res = await archifyRender({ ir, type }, { cwd });
      const htmlPath = (res.details as { path: string }).path;
      const html = readFileSync(htmlPath, "utf8");
      const f = inspectArtifact(html);

      // structural fidelity
      expect(f.hasDoctype).toBe(true);
      expect(f.hasSvg).toBe(true);
      expect(f.nodeCount).toBeGreaterThan(0);
      expect(f.textLabels.length).toBeGreaterThan(0);
      expect(typeof f.title).toBe("string");
      expect(f.title!.length).toBeGreaterThan(0);
      expect(f.bytes).toBeGreaterThan(10_000);

      // functional self-containment: no REQUIRED external refs (offline-capable)
      expect(f.requiredExternalRefs).toEqual([]);

      // vendored artifact validator
      const check = await runArchify(["check", htmlPath], cwd);
      expect(check.status).toBe(0);
    }, 60_000);
  }
});
```

- [ ] **Step 2: Run the gated suite — verify pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/real-result.test.ts )
```
Expected: 5 pass, 0 fail. **If a type fails `archify check` or a structural assertion, that is a finding — record it verbatim for Task 4; do not weaken assertions.**

- [ ] **Step 3: Confirm default (ungated) run skips**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && bun test __tests__/real-result.test.ts )
```
Expected: 0 pass, 0 fail (skipped).

- [ ] **Step 4: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__archify add bun-apps/pi-agent-ext-archify/__tests__/real-result.test.ts
git -C /Users/huangziyu/proj/video_generation__archify commit -m "test(archify): real-result structural fidelity matrix (5 types + archify check)"
```

---

### Task 3: architecture deep round-trip

**Files:**
- Modify: `bun-apps/pi-agent-ext-archify/__tests__/real-result.test.ts` (append a `test`)

**Interfaces:**
- Consumes: same as Task 2 (`archifyRender`, `inspectArtifact`, `VENDORED_EXAMPLES`, `withTempCwd`).

- [ ] **Step 1: Append the deep round-trip test**

Append to the `describeMaybe(...)` block in `__tests__/real-result.test.ts` (inside the same describe, after the `for` loop):

```ts
  test("architecture: every IR component label renders and node count covers components", async () => {
    const cwd = withTempCwd();
    const ir = JSON.parse(
      readFileSync(join(VENDORED_EXAMPLES, "production-deployment.architecture.json"), "utf8"),
    ) as { components?: { label?: string }[] };
    const components = (ir.components ?? []).filter((c) => typeof c.label === "string" && c.label!.length > 0);

    const res = await archifyRender({ ir, type: "architecture" }, { cwd });
    const htmlPath = (res.details as { path: string }).path;
    const f = inspectArtifact(readFileSync(htmlPath, "utf8"));

    expect(f.nodeCount).toBeGreaterThanOrEqual(components.length);
    for (const c of components) {
      expect(f.textLabels).toContain(c.label);
    }
  }, 60_000);
```

- [ ] **Step 2: Run the gated suite — verify pass**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/real-result.test.ts )
```
Expected: 6 pass (5 matrix + 1 deep), 0 fail.

- [ ] **Step 3: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__archify add bun-apps/pi-agent-ext-archify/__tests__/real-result.test.ts
git -C /Users/huangziyu/proj/video_generation__archify commit -m "test(archify): architecture deep round-trip (component labels → rendered text)"
```

---

### Task 4: Run full suite + write findings receipt

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/receipts/archify-real-result-eval-2026-07-25.md`

**Interfaces:**
- Consumes: the completed `real-result.test.ts`; the verbatim gated-run output.

- [ ] **Step 1: Run the full gated suite and capture output**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test __tests__/real-result.test.ts 2>&1 ) | tee /tmp/archify-real-result-out.txt
```
Capture pass/fail and any failure text.

- [ ] **Step 2: Write the findings receipt**

Create `bun-apps/pi-agent-ext-archify/receipts/archify-real-result-eval-2026-07-25.md`. Fill in actual results from Step 1; the template below assumes all-green (expected). If any case failed, move it into Findings with the verbatim error.

```markdown
# Archify Real-Result Structural Evaluation — Findings (2026-07-25)

Suite: `PI_AGENT_E2E=1 bun test __tests__/real-result.test.ts`
Spec: `docs/superpowers/specs/2026-07-25-archify-real-result-eval-design.md`

## Result

- 6 cases run, 6 pass, 0 fail.

## Per-type generated-HTML facts

| Type | nodeCount | label sample | external refs (classified) | archify check | bytes |
|------|-----------|--------------|----------------------------|---------------|-------|
| architecture | (from run) | e.g. Customers, API Gateway | optional: Google Fonts (googleapis/gstatic), archify help URL; required: none | pass | (from run) |
| sequence | (from run) | (sample) | optional: same; required: none | pass | (from run) |
| workflow | (from run) | (sample) | optional: same; required: none | pass | (from run) |
| dataflow | (from run) | (sample) | optional: same; required: none | pass | (from run) |
| lifecycle | (from run) | (sample) | optional: same; required: none | pass | (from run) |

Architecture deep round-trip: every IR component label renders in `<text>`; nodeCount ≥ components (12).

## Self-containment note

The generated artifacts are **functionally offline-capable**: no *required*
external refs (no external `<script src>`/`<img>`). Optional, non-blocking refs
are present and intentional in `vendored/assets/template.html`:
- `fonts.googleapis.com` / `fonts.gstatic.com` — JetBrains Mono, loaded async with a
  system-monospace fallback (the template comment: "a blackholed network must not
  block first paint").
- `tt-a1i.github.io/archify/start.html` — a help/getting-started link.

Per the vendored snapshot policy these cannot be patched in-tree. This corrects
spec #794's over-claim ("no external/network refs") → "no *required* external refs;
offline-capable."

## Verdict

Generated-HTML structural fidelity is trustworthy across all five diagram types:
IR→HTML round-trip integrity holds (architecture component labels render
verbatim), artifacts are offline-capable, and every type passes the vendored
`archify check`. Keep the gated suite as an opt-in regression gate (run on
vendored re-sync or any `lib/render.ts` change).
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__archify add bun-apps/pi-agent-ext-archify/receipts/archify-real-result-eval-2026-07-25.md
git -C /Users/huangziyu/proj/video_generation__archify commit -m "docs(archify): real-result structural evaluation findings receipt"
```

- [ ] **Step 4: Sanity — default suite green, package typecheck clean**

Run:
```bash
( cd bun-apps/pi-agent-ext-archify && bun test 2>&1 | tail -4 && bun run typecheck 2>&1 | tail -3 )
```
Expected: all unit tests pass (incl. the new `inspect-artifact.test.ts`); real-result suite skipped; `tsc --noEmit` clean.
