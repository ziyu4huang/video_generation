# pi-agent Extension Architecture Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a self-contained HTML architecture report of all 21 pi-agent extensions (registration topology + verified dependency edges) from a hand-authored archify IR.

**Architecture:** archify is an IR→HTML diagram renderer (vendored `archify@2.12.0` under `bun-apps/pi-agent-ext-archify/vendored/`). We author one `architecture`-type IR JSON describing the extension tree, validate it, render it to HTML, and add two guard tests so the IR cannot silently rot.

**Tech Stack:** Bun + `bun:test`, archify vendored CLI (`vendored/bin/archify.mjs`), TypeScript. Existing ext test idiom: `spawnSync(process.execPath, [BIN, ...])` and `archifyRender({ir,type},{cwd})` → `inspectArtifact(html).textLabels`.

## Global Constraints

- **Branch:** `archify/ext-architecture-report` (already created, off `origin/main`).
- **Files colocated with the archify ext:** `bun-apps/pi-agent-ext-archify/ir/`.
- **Test command (matches manifest testGate):** `cd bun-apps/pi-agent-ext-archify && bun test --isolate` (run from repo root as `( cd bun-apps/pi-agent-ext-archify && bun test --isolate )`). E2E tests need `PI_AGENT_E2E=1`.
- **No top-level `cd`** (no-cd-drift hook). Use `( cd <dir> && ... )`.
- **Verified dependency edges only.** The edge list in Task 1 was produced by grepping each ext's `*.ts` for `../../pi-agent-ext-<X>` / `@repo/pi-agent-ext-<X>` imports. Do not invent edges.
- **Written output in English** (file content, comments, commit messages); conversation in zh_TW.

### Verified cross-extension import edges (grep-produced)

```
flux2          -> file2md, workflow
hermes-memory  -> subagent
knowledge-card -> obsidian, subagent
movie-director -> flux2, krea2, ltx, workflow
research-tool  -> obsidian
wayfind        -> core-task
workflow       -> subagent
```

`tool-gate` has **no** cross-ext imports (keyword-gated at runtime → legend only). `subagent` is a leaf. `deploy` builds every bundle (build-time, not runtime) → captured in its sublabel, **no** per-ext edges.

### Registration partition

- **Static (12):** core-task, hermes-memory, superpowers, wayfind, web-access, obsidian, btw, file2md, subagent, workflow, knowledge-card, power-tool
- **Dynamic (9):** tool-gate, flux2, krea2, ltx, research-tool, zai-mcp, movie-director, deploy, archify

---

## File Structure

- **Create** `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.json` — the IR (single source of truth for the diagram).
- **Create** `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html` — rendered artifact (regenerated, committed).
- **Create** `bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-ir.test.ts` — guard: IR validates, has 21 components, 2 lane boundaries, and the verified edge set.
- **Create** `bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-roundtrip.test.ts` — E2E-gated: every component label + both lane labels render into the HTML.

---

## Task 1: Author IR + structural guard test (TDD)

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-ir.test.ts`
- Create: `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.json`

**Interfaces:**
- Produces: `ir/pi-agent-extensions.architecture.json` — an `architecture`-type IR consumed by Task 2 and Task 3.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-ir.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PKG = join(import.meta.dir, "..");
const IR_PATH = join(PKG, "ir", "pi-agent-extensions.architecture.json");
const BIN = join(PKG, "vendored", "bin", "archify.mjs");

const ir = JSON.parse(readFileSync(IR_PATH, "utf8")) as {
  diagram_type: string;
  components: { id: string; label: string }[];
  boundaries: { label: string; wraps: string[] }[];
  connections: { from: string; to: string }[];
};

const STATIC = [
  "core-task", "hermes-memory", "superpowers", "wayfind", "web-access",
  "obsidian", "btw", "file2md", "subagent", "workflow", "knowledge-card", "power-tool",
];
const DYNAMIC = [
  "tool-gate", "flux2", "krea2", "ltx", "research-tool",
  "zai-mcp", "movie-director", "deploy", "archify",
];
const EXPECTED_EDGES = [
  ["flux2", "file2md"], ["flux2", "workflow"],
  ["hermes-memory", "subagent"],
  ["knowledge-card", "obsidian"], ["knowledge-card", "subagent"],
  ["movie-director", "flux2"], ["movie-director", "krea2"],
  ["movie-director", "ltx"], ["movie-director", "workflow"],
  ["research-tool", "obsidian"],
  ["wayfind", "core-task"],
  ["workflow", "subagent"],
];

describe("pi-agent extension architecture IR", () => {
  test("is an architecture diagram", () => {
    expect(ir.diagram_type).toBe("architecture");
  });

  test("has exactly 21 components with stable ids", () => {
    const ids = ir.components.map((c) => c.id).sort();
    expect(ids).toEqual([...STATIC, ...DYNAMIC].sort());
  });

  test("has two lane boundaries (static + dynamic) partitioning all 21", () => {
    const byLabel = new Map(ir.boundaries.map((b) => [b.label, b.wraps]));
    const staticLane = byLabel.get("Static — native import · in --exe binary") ?? [];
    const dynamicLane = byLabel.get("Dynamic — jiti -e · source/bundle only") ?? [];
    expect(staticLane.sort()).toEqual(STATIC.slice().sort());
    expect(dynamicLane.sort()).toEqual(DYNAMIC.slice().sort());
  });

  test("connection set matches the grep-verified import edges", () => {
    const got = new Set(ir.connections.map((c) => `${c.from}->${c.to}`));
    for (const [from, to] of EXPECTED_EDGES) {
      expect(got.has(`${from}->${to}`)).toBe(true);
    }
  });

  test("archify validate accepts the IR", () => {
    const r = spawnSync(process.execPath, [BIN, "validate", "architecture", IR_PATH, "--json"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test --isolate ext-architecture-ir.test.ts )`
Expected: FAIL — `ir/pi-agent-extensions.architecture.json` does not exist (ENOENT).

- [ ] **Step 3: Author the IR**

Create `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.json` with exactly this content:

```json
{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": {
    "title": "pi-agent Extension Architecture",
    "subtitle": "21 extensions — registration topology (static vs dynamic) and verified runtime-import dependencies",
    "output": "ir/pi-agent-extensions.architecture.html",
    "visual_preset": "blueprint",
    "quality_profile": "showcase",
    "engineering_profile": "extension-registration",
    "views": [
      { "id": "registration-topology", "label": "Registration topology", "focus": ["core-task","hermes-memory","superpowers","wayfind","web-access","obsidian","btw","file2md","subagent","workflow","knowledge-card","power-tool","tool-gate","flux2","krea2","ltx","research-tool","zai-mcp","movie-director","deploy","archify"], "note": "Static extensions enter the --exe binary; dynamic ones are jiti -e, source/bundle only." },
      { "id": "memory-knowledge", "label": "Memory & knowledge", "focus": ["hermes-memory","knowledge-card","research-tool","obsidian"], "note": "Persistent memory, zettelkasten RAG, and the vault they share." },
      { "id": "media-gen", "label": "Media generation", "focus": ["flux2","krea2","ltx","movie-director","tool-gate"], "note": "Native director wrappers + orchestrator, gated by tool-gate." },
      { "id": "agent-infra", "label": "Agent infra", "focus": ["core-task","subagent","workflow","power-tool","btw","superpowers","wayfind"], "note": "Task cockpit, subagent dispatch, fan-out, diagnostics, skills." }
    ]
  },
  "components": [
    { "id": "core-task", "type": "backend", "label": "Core Task", "sublabel": "goal cockpit · todos · ask_user", "pos": [60, 140], "size": [160, 58], "tag": "static" },
    { "id": "hermes-memory", "type": "database", "label": "Hermes Memory", "sublabel": "persistent memory · FTS5", "pos": [250, 140], "size": [160, 58], "tag": "static" },
    { "id": "superpowers", "type": "backend", "label": "Superpowers", "sublabel": "14 composable skills", "pos": [440, 140], "size": [160, 58], "tag": "static" },
    { "id": "wayfind", "type": "backend", "label": "Wayfind", "sublabel": "decision-chain skills", "pos": [630, 140], "size": [160, 58], "tag": "static" },
    { "id": "web-access", "type": "external", "label": "Web Access", "sublabel": "search · fetch · video", "pos": [820, 140], "size": [160, 58], "tag": "static" },
    { "id": "obsidian", "type": "database", "label": "Obsidian", "sublabel": "project-local vault", "pos": [1010, 140], "size": [160, 58], "tag": "static" },
    { "id": "btw", "type": "backend", "label": "BTW", "sublabel": "side-conversation modal", "pos": [60, 300], "size": [160, 58], "tag": "static" },
    { "id": "file2md", "type": "backend", "label": "File2MD", "sublabel": "file → Markdown bridge", "pos": [250, 300], "size": [160, 58], "tag": "static" },
    { "id": "subagent", "type": "backend", "label": "Subagent", "sublabel": "isolated subagent dispatch · leaf", "pos": [440, 300], "size": [160, 58], "tag": "static" },
    { "id": "workflow", "type": "backend", "label": "Workflow", "sublabel": "dynamic multi-agent fan-out", "pos": [630, 300], "size": [160, 58], "tag": "static" },
    { "id": "knowledge-card", "type": "database", "label": "Knowledge Card", "sublabel": "zettelkasten · graph RAG", "pos": [820, 300], "size": [160, 58], "tag": "static" },
    { "id": "power-tool", "type": "backend", "label": "Power Tool", "sublabel": "diagnostics · schema-cost", "pos": [1010, 300], "size": [160, 58], "tag": "static" },

    { "id": "tool-gate", "type": "security", "label": "Tool Gate", "sublabel": "keyword-gated heavy tools", "pos": [60, 540], "size": [160, 58], "tag": "dynamic · thin" },
    { "id": "flux2", "type": "backend", "label": "Flux2", "sublabel": "swift flux2 director", "pos": [250, 540], "size": [160, 58], "tag": "dynamic" },
    { "id": "krea2", "type": "backend", "label": "Krea2", "sublabel": "swift krea2 director", "pos": [440, 540], "size": [160, 58], "tag": "dynamic" },
    { "id": "ltx", "type": "backend", "label": "LTX", "sublabel": "swift ltx-video director", "pos": [630, 540], "size": [160, 58], "tag": "dynamic" },
    { "id": "research-tool", "type": "backend", "label": "Research Tool", "sublabel": "video collect · vault", "pos": [820, 540], "size": [160, 58], "tag": "dynamic · thin" },
    { "id": "zai-mcp", "type": "external", "label": "ZAI MCP", "sublabel": "z.ai MCP as pi tools", "pos": [1010, 540], "size": [160, 58], "tag": "dynamic · thin" },
    { "id": "movie-director", "type": "backend", "label": "Movie Director", "sublabel": "video orchestration", "pos": [250, 700], "size": [160, 58], "tag": "dynamic · thin" },
    { "id": "deploy", "type": "cloud", "label": "Deploy", "sublabel": "builds ALL ext bundles (build-time)", "pos": [630, 700], "size": [160, 58], "tag": "dynamic · thin" },
    { "id": "archify", "type": "cloud", "label": "Archify", "sublabel": "IR → HTML diagrams", "pos": [820, 700], "size": [160, 58], "tag": "dynamic · thin · skills" }
  ],
  "boundaries": [
    { "kind": "region", "label": "Static — native import · in --exe binary", "wraps": ["core-task","hermes-memory","superpowers","wayfind","web-access","obsidian","btw","file2md","subagent","workflow","knowledge-card","power-tool"] },
    { "kind": "region", "label": "Dynamic — jiti -e · source/bundle only", "wraps": ["tool-gate","flux2","krea2","ltx","research-tool","zai-mcp","movie-director","deploy","archify"] }
  ],
  "connections": [
    { "from": "flux2", "to": "file2md", "label": "imports" },
    { "from": "flux2", "to": "workflow", "label": "imports" },
    { "from": "hermes-memory", "to": "subagent", "label": "imports" },
    { "from": "knowledge-card", "to": "obsidian", "label": "imports" },
    { "from": "knowledge-card", "to": "subagent", "label": "imports" },
    { "from": "movie-director", "to": "flux2", "label": "orchestrates" },
    { "from": "movie-director", "to": "krea2", "label": "orchestrates" },
    { "from": "movie-director", "to": "ltx", "label": "orchestrates" },
    { "from": "movie-director", "to": "workflow", "label": "imports" },
    { "from": "research-tool", "to": "obsidian", "label": "imports" },
    { "from": "wayfind", "to": "core-task", "label": "imports" },
    { "from": "workflow", "to": "subagent", "label": "imports" }
  ],
  "cards": [
    { "dot": "cyan", "title": "Static vs Dynamic", "items": ["Static extensions are native imports in static-extensions.ts, bundled into the --exe binary and present in every mode.", "Dynamic extensions load via jiti -e (manifest extensions[]) in source/bundle mode only; the -e flags are dropped in --exe mode, so they are absent from the compiled binary.", "btw was extracted from power-tool; subagent was extracted from workflow — provenance only, not runtime edges."] },
    { "dot": "rose", "title": "bundleMode", "items": ["thin bundles exclude dev/heavy deps to keep the registered footprint small.", "tool-gate, research-tool, zai-mcp, movie-director, deploy, and archify are thin."] },
    { "dot": "emerald", "title": "Surfaces & tool-gate", "items": ["Manifest arrays: extensions[] (dynamic), staticExtensions (static), skills[], and binarySkills[] (the subset carried into the binary).", "tool-gate keeps core tools always on and gates heavy media tools behind keyword matching — no cross-extension imports, so it appears in this legend, not as an edge."] }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test --isolate ext-architecture-ir.test.ts )`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.json \
        bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-ir.test.ts
git commit -m "feat(archify): pi-agent extension architecture IR + guard test"
```

---

## Task 2: Round-trip render test (TDD, E2E-gated)

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-roundtrip.test.ts`

**Interfaces:**
- Consumes: `ir/pi-agent-extensions.architecture.json` (Task 1), `archifyRender` from `../lib/render.ts`, `inspectArtifact` from `../lib/inspect-artifact.ts`.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-roundtrip.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archifyRender } from "../lib/render.ts";
import { inspectArtifact } from "../lib/inspect-artifact.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

const PKG = join(import.meta.dir, "..");
const IR_PATH = join(PKG, "ir", "pi-agent-extensions.architecture.json");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const COMPONENT_LABELS = [
  "Core Task", "Hermes Memory", "Superpowers", "Wayfind", "Web Access", "Obsidian",
  "BTW", "File2MD", "Subagent", "Workflow", "Knowledge Card", "Power Tool",
  "Tool Gate", "Flux2", "Krea2", "LTX", "Research Tool", "ZAI MCP",
  "Movie Director", "Deploy", "Archify",
];
const LANE_LABELS = [
  "Static — native import · in --exe binary",
  "Dynamic — jiti -e · source/bundle only",
];

describeMaybe("pi-agent extension architecture — render round-trip", () => {
  test("every component label and both lane labels render as <text>", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-extarch-"));
    tempDirs.push(cwd);
    const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));

    const res = await archifyRender({ ir, type: "architecture" }, { cwd });
    const htmlPath = (res.details as { path: string }).path;
    const f = inspectArtifact(readFileSync(htmlPath, "utf8"));

    expect(f.hasDoctype).toBe(true);
    expect(f.hasSvg).toBe(true);
    for (const label of COMPONENT_LABELS) {
      expect(f.textLabels).toContain(label);
    }
    for (const lane of LANE_LABELS) {
      expect(f.textLabels).toContain(lane);
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails (or is skipped)**

Run without E2E: `( cd bun-apps/pi-agent-ext-archify && bun test --isolate ext-architecture-roundtrip.test.ts )`
Expected: SKIP (suite behind `describe.skip` because `PI_AGENT_E2E` unset).

Run with E2E: `( cd bun-apps/pi-agent-ext-archify && PI_AGENT_E2E=1 bun test --isolate ext-architecture-roundtrip.test.ts )`
Expected: PASS — all 21 component labels and both lane labels appear in `f.textLabels`. If a label is missing, the renderer may have elided it; check the rendered HTML and adjust `sublabel`/layout, not the label strings.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/__tests__/ext-architecture-roundtrip.test.ts
git commit -m "test(archify): pi-agent ext architecture render round-trip (E2E)"
```

> This task has no implementation step because it tests existing `archifyRender` against the Task-1 IR. The "code" is the IR; the test is the guard.

---

## Task 3: Render + commit the HTML artifact

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html`

**Interfaces:**
- Consumes: the IR from Task 1 and the vendored bin.

- [ ] **Step 1: Render the HTML via the vendored CLI**

Run:
```bash
node bun-apps/pi-agent-ext-archify/vendored/bin/archify.mjs deliver architecture \
  bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.json \
  bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html \
  --json --quality showcase
```
Expected: JSON receipt with `"status":"ok"` and the output path. (The IR's `meta.output` points at the same relative path.)

- [ ] **Step 2: Validate the artifact with archify check**

Run:
```bash
node bun-apps/pi-agent-ext-archify/vendored/bin/archify.mjs check \
  bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html
```
Expected: exit 0, no required-external-refs (self-contained).

- [ ] **Step 3: Eyeball the render**

Open `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html` in a browser. Confirm:
- 21 component boxes split across the two lane boundaries (12 static, 9 dynamic).
- The 12 import edges render with arrowheads.
- The 4 views in `meta.views` are selectable and each focuses the right cluster.

If a lane label or component label is clipped, nudge the offending `pos`/`size` in the IR, re-render (Step 1), and re-run Task 1's guard test to ensure the structural invariants still hold.

- [ ] **Step 4: Commit the artifact**

```bash
git add bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html
git commit -m "feat(archify): rendered pi-agent extension architecture HTML report"
```

---

## Self-Review (run after writing)

**1. Spec coverage**
- §4.1 boundaries (static/dynamic lanes) → Task 1 IR + Task 1 test (lane partition).
- §4.2 components (21, label/sublabel/tag) → Task 1 IR + Task 1 test (21 ids).
- §4.3 connections (verified edges only) → Task 1 IR + Task 1 test (edge set); deploy as sublabel note (no fan-out edges) → Task 1 IR.
- §4.4 cards (3 legend cards) → Task 1 IR.
- §4.5 meta.views (4 views) → Task 1 IR + Task 3 Step 3 eyeball.
- §5 workflow (validate/deliver/check) → Task 1 test (validate), Task 3 (deliver + check).
- §6 file locations → all tasks use `ir/`.
- §9 acceptance criteria → Task 1 test (validate passes, 21 components, verified edges), Task 2 (labels render), Task 3 (check passes, lanes render).

**2. Placeholder scan** — none. IR JSON is complete; tests contain real assertions.

**3. Type consistency** — component ids in `EXPECTED_EDGES`, `STATIC`, `DYNAMIC` (Task 1 test) match the IR `components[].id` and `connections[]`. Lane labels in Task 2 `LANE_LABELS` match the IR `boundaries[].label` verbatim. `archifyRender` / `inspectArtifact` signatures match `real-result.test.ts`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-25-pi-agent-ext-architecture-report.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
**2. Inline Execution** — execute in this session with checkpoints.

Which approach?
