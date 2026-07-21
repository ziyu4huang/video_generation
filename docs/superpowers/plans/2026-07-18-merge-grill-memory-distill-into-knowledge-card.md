# Merge grill-memory + distill into knowledge-card / hermes-memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete two thin `pi-agent-ext-*` packages by merging their behavior into existing packages — grill-memory's skill into hermes-memory, distill's Gate→Converge→State pipeline into knowledge-card's `zk_ingest` tool.

**Architecture:** Pure relocation + one tool-surface consolidation. distill's `src/` moves verbatim into `knowledge-card/src/distill/` with cross-package imports rewritten local; its tool surface is folded into `zk_ingest` as a new optional `action` param (`gate`/`converge`/`status`, default = current ingest). grill-memory's SKILL.md moves into hermes-memory's new `skills/` dir with a `pi.skills` manifest entry. No semantic change to either pipeline.

**Tech Stack:** Bun + TypeScript, pi-coding-agent 0.80.10 ExtensionAPI, typebox, biome. Tests via `bun test`.

## Global Constraints

- **Run python via** `python/venv/bin/python` only — never system `python3` (not relevant to this plan but holds repo-wide).
- **No top-level `cd`** — use `( cd <dir> && ... )` subshells or `--cwd`. The `no-cd-drift.sh` hook blocks top-level cd.
- **pi-coding-agent version pinned** `0.80.10` across all packages.
- **knowledge-card test script is `bun test __tests__/`** — every relocated test MUST land under `pi-agent-ext-knowledge-card/__tests__/` to be run.
- **Back-compat invariant:** `zk_ingest` called with no `action` param MUST behave exactly as today (the deterministic ingest path). All new params are `Type.Optional`.
- **Manifest `pi.skills` mechanism** is how grill-memory ships today; the same field on hermes-memory is the delivery path (verified: hermes-memory currently has no `skills/` dir and no `pi.skills` entry).
- **Commits:** end every commit message with `Co-Authored-By: Claude <noreply@anthropic.com>`. Commit per task.

## File Structure

**hermes-memory (`pi-agent-ext-hermes-memory/`)**
- Create: `skills/grill-memory/SKILL.md` (moved verbatim from grill-memory)
- Create: `tests/grill-memory-skill.test.ts` (moved + path-adjusted)
- Modify: `package.json` (add `pi.skills`, append `files`)

**knowledge-card (`pi-agent-ext-knowledge-card/`)**
- Create: `src/distill/types.ts`, `src/distill/state.ts`, `src/distill/threshold.ts`, `src/distill/gate.ts`, `src/distill/converge.ts` (moved, imports rewritten)
- Create: `__tests__/distill/gate.test.ts`, `state.test.ts`, `threshold.test.ts`, `converge.test.ts`, `pipeline.test.ts`, `e2e-supersede.test.ts` (moved, import paths rewritten)
- Create: `__tests__/distill/zk-ingest-action.test.ts` (rewritten from distill.test.ts — asserts zk_ingest honors `action`)
- Modify: `extensions/knowledge-card.ts` (add `action` param + gate/converge/status branches to `zk_ingest`; update description)
- Modify: `extensions/__tests__/perf/schema-cost.regression.test.ts` (re-baseline zk_ingest schema cost)
- Modify: `src/supersede.ts` (comment update only)

**Repo-wide fallout**
- Modify: `bun-apps/pi-agent/run-dir/manifest.json`
- Modify: `.github/workflows/ci.yml`, `.github/CI.md`
- Modify: `bun-apps/pi-agent-cli/package.json`
- Modify: `bun-apps/KNOWLEDGE-LAYER.md`, `bun-apps/pi-agent-cli/PRD.md`
- Modify: `bun-apps/pi-agent-ext-knowledge-card/CONTEXT.md`, `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md`
- Modify: `.claude/workflows/pi-infra-self-improve.*` (scope list, if it names distill)
- Delete: `bun-apps/pi-agent-ext-grill-memory/` (entire package)
- Delete: `bun-apps/pi-agent-ext-distill/` (entire package)

---

### Task 1: Move grill-memory skill into hermes-memory

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/skills/grill-memory/SKILL.md`
- Create: `bun-apps/pi-agent-ext-hermes-memory/tests/grill-memory-skill.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/package.json`

**Interfaces:**
- Consumes: the existing SKILL.md content at `bun-apps/pi-agent-ext-grill-memory/skills/grill-memory/SKILL.md` and its test at `bun-apps/pi-agent-ext-grill-memory/tests/skill.test.ts`.
- Produces: a hermes-memory package that ships the `grill-memory` skill via `pi.skills`, with a passing test asserting frontmatter + READ/WRITE protocols.

- [ ] **Step 1: Create the skills dir + copy SKILL.md verbatim**

Run:
```bash
mkdir -p bun-apps/pi-agent-ext-hermes-memory/skills/grill-memory
cp bun-apps/pi-agent-ext-grill-memory/skills/grill-memory/SKILL.md \
   bun-apps/pi-agent-ext-hermes-memory/skills/grill-memory/SKILL.md
```
Expected: file exists; `diff` against the source shows no differences.

- [ ] **Step 2: Create the relocated test (path-adjusted)**

Create `bun-apps/pi-agent-ext-hermes-memory/tests/grill-memory-skill.test.ts` with this exact content (the only change vs the original is the `SKILL_PATH` join — `../skills/grill-memory/SKILL.md` resolves from `tests/` up to package root then into `skills/`):

```ts
// tests/grill-memory-skill.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_PATH = join(import.meta.dir, "../skills/grill-memory/SKILL.md");
const raw = readFileSync(SKILL_PATH, "utf-8");
const fm = raw.match(/^---\n([\s\S]*?)\n---/);
const frontmatter = fm ? fm[1] : "";
const body = fm ? raw.slice(fm[0].length) : raw;

test("has YAML frontmatter with name + description", () => {
  expect(frontmatter).toContain("name: grill-memory");
  expect(frontmatter).toContain("description:");
});

test("description starts with 'Use when' (trigger-only, not a workflow summary)", () => {
  expect(frontmatter.match(/description:\s*(.*)/)?.[1]?.trimStart()).toMatch(/^Use when/);
});

test("READ protocol instructs memory_search against the user target (grill traits = user-traits)", () => {
  expect(body).toContain("memory_search");
  expect(body).toContain('target: "user"');
});

test("WRITE protocol instructs calling grill_decision per resolved decision", () => {
  expect(body).toContain("grill_decision");
});

test("preserves the one-recommendation-per-question discipline", () => {
  expect(body.toLowerCase()).toContain("one recommendation");
});
```

- [ ] **Step 3: Run the relocated test — verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/grill-memory-skill.test.ts )`
Expected: 5 passing.

- [ ] **Step 4: Wire the `pi.skills` manifest + `files` in package.json**

In `bun-apps/pi-agent-ext-hermes-memory/package.json`, change the `pi` block from:
```json
  "pi": {
    "extensions": [
      "./src/index.ts"
    ]
  },
```
to:
```json
  "pi": {
    "extensions": [
      "./src/index.ts"
    ],
    "skills": ["./skills"]
  },
```
And in the `files` array, append `"skills"`:
```json
  "files": [
    "src",
    "skills",
    "README.md",
    "LICENSE",
    "docs"
  ],
```

- [ ] **Step 5: Run hermes-memory test suite — verify nothing regressed**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: full suite green (including the 2 existing grill tests + the new skill test).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/skills \
        bun-apps/pi-agent-ext-hermes-memory/tests/grill-memory-skill.test.ts \
        bun-apps/pi-agent-ext-hermes-memory/package.json
git commit -m "feat(hermes-memory): absorb grill-memory skill

Move the grill-memory SKILL.md + test into hermes-memory (the package that
already owns the grill_decision runtime). Adds a pi.skills manifest entry so
the skill ships from its new home. Behavior unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Move distill src into knowledge-card/src/distill/ with local imports

**Files:**
- Create: `bun-apps/pi-agent-ext-knowledge-card/src/distill/types.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/src/distill/state.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/src/distill/threshold.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/src/distill/gate.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/src/distill/converge.ts`

**Interfaces:**
- Consumes: knowledge-card's existing `src/ingest.ts` (`ingestRecords`, types `KnowledgeRecord`, `IngestSummary`) and `src/supersede.ts` (`markSuperseded`); `@repo/pi-agent-ext-obsidian/extensions/obsidian.ts` (`parseFrontmatter`).
- Produces: `src/distill/` exporting `runGate`, `runConverge`, `readState`, `writeState`, `adjustThreshold`, and the distill types (`MemoryEntry`, `EnrichedNote`, `ConvergeMetrics`, `DistillState`, etc.). Later tasks import these.

- [ ] **Step 1: Create the distill dir and copy the 5 src files verbatim**

Run:
```bash
mkdir -p bun-apps/pi-agent-ext-knowledge-card/src/distill
for f in types state threshold gate converge; do
  cp bun-apps/pi-agent-ext-distill/src/$f.ts \
     bun-apps/pi-agent-ext-knowledge-card/src/distill/$f.ts
done
```
Expected: 5 files created.

- [ ] **Step 2: Rewrite converge.ts cross-package imports as local**

In `bun-apps/pi-agent-ext-knowledge-card/src/distill/converge.ts`, replace the two cross-package import lines:

Old:
```ts
import type { KnowledgeRecord, IngestSummary } from "../../pi-agent-ext-knowledge-card/src/ingest.ts";
import { ingestRecords } from "../../pi-agent-ext-knowledge-card/src/ingest.ts";
import { markSuperseded } from "../../pi-agent-ext-knowledge-card/src/supersede.ts";
```

New:
```ts
import type { KnowledgeRecord, IngestSummary } from "../ingest.ts";
import { ingestRecords } from "../ingest.ts";
import { markSuperseded } from "../supersede.ts";
```

- [ ] **Step 3: Rewrite gate.ts obsidian import to the knowledge-card convention**

In `bun-apps/pi-agent-ext-knowledge-card/src/distill/gate.ts`, replace:

Old:
```ts
import { parseFrontmatter } from "../../pi-agent-ext-obsidian/extensions/obsidian.ts";
```

New:
```ts
import { parseFrontmatter } from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
```

(This matches how every other knowledge-card src file imports obsidian — see `src/supersede.ts:19`, `src/ingest.ts:53`.)

- [ ] **Step 4: Verify the moved module compiles + imports resolve**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun build src/distill/converge.ts --no-bundle > /dev/null )`
Expected: exits 0, no "Cannot find module" errors. (If `bun build` complains about `--no-bundle` on a non-entry, fall back to: `bun -e 'import("./src/distill/converge.ts").then(()=>console.log("ok")).catch(e=>{console.error(e);process.exit(1)})'` from inside the package — expect `ok`.)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-knowledge-card/src/distill
git commit -m "feat(knowledge-card): move distill pipeline src into src/distill/

Verbatim move of gate/state/threshold/converge/types from pi-agent-ext-distill.
Cross-package imports rewritten local (ingest, supersede) and to the
@repo/pi-agent-ext-obsidian convention (parseFrontmatter). No behavior change.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Move distill lib tests into knowledge-card/__tests__/distill/

**Files:**
- Create: `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/gate.test.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/state.test.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/threshold.test.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/converge.test.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/pipeline.test.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/e2e-supersede.test.ts`

(6 of the 7 distill tests — the 7th, `distill.test.ts`, is rewritten separately in Task 5.)

**Interfaces:**
- Consumes: `src/distill/*` from Task 2; `src/retrieve.ts` (existing) for e2e-supersede.
- Produces: the 6 distill lib tests running green under `bun test __tests__/` (knowledge-card's test script).

- [ ] **Step 1: Copy the 6 test files verbatim**

Run:
```bash
mkdir -p bun-apps/pi-agent-ext-knowledge-card/__tests__/distill
for f in gate state threshold converge pipeline e2e-supersede; do
  cp bun-apps/pi-agent-ext-distill/__tests__/$f.test.ts \
     bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/$f.test.ts
done
```
Expected: 6 files created.

- [ ] **Step 2: Rewrite `../src/X.ts` → `../../src/distill/X.ts` in all 6 files**

In each of the 6 new test files, replace every occurrence of:
- `"../src/gate.ts"` → `"../../src/distill/gate.ts"`
- `"../src/state.ts"` → `"../../src/distill/state.ts"`
- `"../src/threshold.ts"` → `"../../src/distill/threshold.ts"`
- `"../src/converge.ts"` → `"../../src/distill/converge.ts"`
- `"../src/types.ts"` → `"../../src/distill/types.ts"`

(These appear in the `import ... from "..."` lines. Each file uses 1–3 of them.)

- [ ] **Step 3: Rewrite the e2e-supersede cross-package retrieve import**

In `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/e2e-supersede.test.ts`, replace:

Old:
```ts
import { retrieveRecords } from "../../pi-agent-ext-knowledge-card/src/retrieve.ts";
```

New:
```ts
import { retrieveRecords } from "../../src/retrieve.ts";
```

- [ ] **Step 4: Run the 6 relocated tests — verify green**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/distill/ )`
Expected: all 6 files green. If any fails on an import path, re-check Step 2/3 for a missed occurrence.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-knowledge-card/__tests__/distill
git commit -m "test(knowledge-card): relocate distill lib tests under __tests__/distill/

6 distill pipeline tests moved from pi-agent-ext-distill with import paths
rewritten to src/distill/ (and retrieve via ../../src/). Picked up by the
package's 'bun test __tests__/' script.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Fold the distill tool into zk_ingest (action: gate|converge|status)

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` (zk_ingest registration block, ~lines 935–1140)

**Interfaces:**
- Consumes: `runGate`, `runConverge`, `readState` from `../src/distill/` (Task 2); types `MemoryEntry`, `EnrichedNote`, `ConvergeMetrics`.
- Produces: `zk_ingest` honors an optional `action` param. `action` absent → current ingest behavior (back-compat). `gate`/`converge`/`status` → distill pipeline surfaces.

- [ ] **Step 1: Write the failing test for the new action surface**

Create `bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/zk-ingest-action.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { captureTools } from "../../../perf-harness/src/index.ts";
import kcardFactory from "../../extensions/knowledge-card.ts";

const tools = captureTools(kcardFactory);

describe("zk_ingest distill actions", () => {
  test("distill tool is gone (folded into zk_ingest)", () => {
    expect(tools.distill).toBeUndefined();
  });

  test("zk_ingest parameters include optional action/entries/notes/metrics", () => {
    const params = (tools.zk_ingest as any).parameters as Record<string, unknown>;
    const props = (params as any).properties as Record<string, unknown>;
    expect(props.action).toBeDefined();
    expect(props.entries).toBeDefined();
    expect(props.notes).toBeDefined();
    expect(props.metrics).toBeDefined();
  });

  test("zk_ingest action='gate' returns survivors + killed (read-only)", async () => {
    const execute = (tools.zk_ingest as any).execute;
    const res = await execute(
      "t1",
      {
        action: "gate",
        vault: "/nonexistent-vault-zk-test",
        entries: [
          { id: "a", target: "memory", content: "short", created: "2026-01-01" },
          { id: "b", target: "memory", content: "well-formed real entry content", created: "2026-07-18" },
        ],
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    expect(res.isError).toBe(false);
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.candidates).toBe(2);
    expect(Array.isArray(data.survivors)).toBe(true);
    expect(data.killed).toBeGreaterThanOrEqual(1); // the "short" malformed entry
  });

  test("zk_ingest action='status' returns threshold + history shape", async () => {
    const execute = (tools.zk_ingest as any).execute;
    const res = await execute(
      "t2",
      { action: "status", vault: "/nonexistent-vault-zk-test-status" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    expect(res.isError).toBe(false);
    const data = JSON.parse((res.content as any)[0].text);
    expect(typeof data.threshold).toBe("number");
    expect("lastRun" in data).toBe(true);
    expect("historyEntries" in data).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/distill/zk-ingest-action.test.ts )`
Expected: FAIL — `action`/`entries`/`notes`/`metrics` are undefined on the parameters; the `gate`/`status` calls return the "no input files" error (action not yet honored).

- [ ] **Step 3: Add the new imports at the top of the extension**

In `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts`, alongside the existing `../src/ingest.ts`-style imports near the top, add:

```ts
import { runGate } from "../src/distill/gate.ts";
import { runConverge } from "../src/distill/converge.ts";
import { readState } from "../src/distill/state.ts";
import type { MemoryEntry } from "../src/distill/types.ts";
```

- [ ] **Step 4: Add the `action` param + description update to the zk_ingest schema**

In the `parameters: Type.Object({ ... })` of the `zk_ingest` registration, add these four properties (place `action` first so it reads naturally):

```ts
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("gate"),
						Type.Literal("converge"),
						Type.Literal("status"),
					],
					{
						description:
							"Distill pipeline action (absent = deterministic ingest, the default). " +
							"'gate' filters raw hermes-memory entries (dedup/stale/malformed) and returns " +
							"survivors for in-context enrichment (read-only). 'converge' writes enriched " +
							"notes via the ingest path, supersedes raw pi-memory cards, and adjusts the " +
							"adaptive threshold. 'status' reports the current threshold + run history. " +
							"Workflow: status → gate → enrich survivors in your reasoning → converge.",
					},
				),
			),
			entries: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						target: Type.String(),
						content: Type.String(),
						created: Type.String(),
						last: Type.Optional(Type.String()),
					}),
					{ description: "Raw hermes-memory entries (required for action='gate')." },
				),
			),
			notes: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						type: Type.String(),
						title: Type.String(),
						detail: Type.String(),
						tags: Type.Array(Type.String()),
						dimension: Type.Optional(Type.String()),
						confidence: Type.Optional(Type.Number()),
						supersedesCardId: Type.Optional(Type.String()),
					}),
					{ description: "Enriched notes (required for action='converge')." },
				),
			),
			metrics: Type.Optional(
				Type.Object(
					{
						candidates: Type.Number(),
						killed: Type.Number(),
						survivors: Type.Number(),
					},
					{ description: "Gate metrics (required for action='converge')." },
				),
			),
```

Also update the `description:` string of the tool itself — append after the existing last line:
```
"Optionally, with action='gate'|'converge'|'status' it drives the agent self-triggered distill pipeline ",
"(Gate→Enrich-in-agent→Converge) over hermes-memory entries.",
```

- [ ] **Step 5: Add the action dispatch at the very top of the zk_ingest `execute` body**

Immediately inside `async execute(_id, params, _signal, _u, ctx) {`, before the existing `const { cwd } = ctx;` line, insert this dispatch. (`vaultPath` resolution is shared with the ingest path, so resolve it first; the gate/converge/status actions reuse it. The default-ingest path is untouched.)

```ts
			// ── distill pipeline actions (folded from pi-agent-ext-distill) ──
			const action = params.action as "gate" | "converge" | "status" | undefined;
			if (action === "gate" || action === "converge" || action === "status") {
				let vaultPath: string;
				try {
					vaultPath = params.vault ?? (await resolveVault(ctx.cwd)).path;
				} catch (e) {
					return {
						content: [
							{
								type: "text",
								text: `zk_ingest: vault resolution failed: ${(e as Error).message}`,
							},
						],
						isError: true,
						details: { code: "vault_resolution_failed" },
					};
				}

				if (action === "status") {
					const state = readState(vaultPath);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									threshold: state.threshold,
									lastRun: state.lastRun,
									historyEntries: state.history.length,
									recentRuns: state.history.slice(-3),
								}),
							},
						],
						isError: false,
						details: null,
					};
				}

				if (action === "gate") {
					const entries = (params.entries ?? []) as MemoryEntry[];
					const result = runGate(entries, vaultPath);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									candidates: result.candidates,
									killed: result.killed.length,
									survivors: result.survivors.map((s) => ({
										id: s.entry.id,
										content: s.entry.content,
										target: s.entry.target,
										reason: s.reason,
									})),
									killReasons: result.killed.reduce(
										(acc: Record<string, number>, k) => {
											acc[k.reason] = (acc[k.reason] ?? 0) + 1;
											return acc;
										},
										{},
									),
								}),
							},
						],
						isError: false,
						details: null,
					};
				}

				// action === "converge"
				const notes = (params.notes ?? []) as any[];
				const metrics = (params.metrics ?? { candidates: 0, killed: 0, survivors: 0 }) as any;
				const result = await runConverge(notes, vaultPath, metrics);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					isError: false,
					details: null,
				};
			}
```

- [ ] **Step 6: Run the new test — verify it passes**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/distill/zk-ingest-action.test.ts )`
Expected: all 4 tests green.

- [ ] **Step 7: Run the full knowledge-card suite — verify no regression**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test )`
Expected: green, including the relocated distill tests + the existing zk_ingest ingest-path tests.

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts \
        bun-apps/pi-agent-ext-knowledge-card/__tests__/distill/zk-ingest-action.test.ts
git commit -m "feat(knowledge-card): fold distill pipeline into zk_ingest actions

zk_ingest gains an optional action param (gate|converge|status); absent = the
existing deterministic ingest (back-compat). Retires the standalone 'distill'
tool — one tool, one deterministic write surface. Enrichment stays in the
driving agent between gate and converge.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Re-baseline the schema-cost regression test

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/extensions/__tests__/perf/schema-cost.regression.test.ts`

**Why:** Adding `action`/`entries`/`notes`/`metrics` to zk_ingest's schema increases its token cost and may exceed the pinned 2120 budget (1927 baseline + 10%). The "4 tools" count is unchanged (action is a param, not a tool).

- [ ] **Step 1: Run the schema-cost test to see the new actual cost**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test extensions/__tests__/perf/schema-cost.regression.test.ts )`

Note: this test file lives under `extensions/__tests__/` (not `__tests__/`), so it is NOT run by the package's `bun test __tests__/` script — invoke it explicitly.

- [ ] **Step 2: Re-baseline the budget + baseline constants**

Expected outcome handling:
- **If it PASSES within the existing 2120 budget:** no change needed — proceed to Step 4.
- **If it FAILS** (new cost > 2120): read the failure's `actual` token count from the output. Then in `schema-cost.regression.test.ts`, update BOTH:
  - the baseline constant (currently `1927`) → the new measured total, AND
  - the budget constant (currently `2120`) → `round(newBaseline * 1.1)` (preserve the +10% headroom policy).

For example, if the new measured total is `2015`:
```ts
// baseline 2015 (re-measured 2026-07-18 after folding distill actions into zk_ingest)
// budget = round(2015 * 1.1) = 2217
```
Update both the `baseline` and the `assertWithinBudget(..., <budget>)` numbers and the explanatory comment with today's date.

- [ ] **Step 3: Re-run — verify green**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test extensions/__tests__/perf/schema-cost.regression.test.ts )`
Expected: PASS.

- [ ] **Step 4: Commit (only if the file changed)**

```bash
git add bun-apps/pi-agent-ext-knowledge-card/extensions/__tests__/perf/schema-cost.regression.test.ts
git commit -m "test(knowledge-card): re-baseline zk_ingest schema cost after distill fold

zk_ingest now carries the gate/converge/status action params; re-measured the
total schema-token cost and bumped the baseline + 10% headroom budget.

Co-Authored-By: Claude <noreply@anthropic.com>"
```
If the file did not change (Step 2 PASS-within-budget), skip this commit.

---

### Task 6: Mechanical fallout — manifest, CI, workspace dep, workflow scope

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/manifest.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/CI.md`
- Modify: `bun-apps/pi-agent-cli/package.json`
- Modify: `.claude/workflows/pi-infra-self-improve.js` (and `.md` if present) — only if it names `pi-agent-ext-distill`

**Interfaces:** none (pure config/doc wiring).

- [ ] **Step 1: Update the run-dir manifest**

In `bun-apps/pi-agent/run-dir/manifest.json`:
- Remove the line: `"pi-agent-ext-distill/extensions/pi-distill.ts",` (from the extensions array).
- Replace `"pi-agent-ext-grill-memory/skills",` with `"pi-agent-ext-hermes-memory/skills",`.

Verify hermes-memory's extension path (`pi-agent-ext-hermes-memory/src/index.ts`) is already present; if not, do NOT add it here — that is a pre-existing wiring concern out of scope.

- [ ] **Step 2: Remove distill from the CI matrix**

In `.github/workflows/ci.yml`, delete the matrix entry:
```yaml
          - { package: pi-agent-ext-distill, test-cmd: "bun test" }
```

In `.github/CI.md`, remove the two occurrences of `pi-agent-ext-distill` (lines ~30 and ~139 — one in the test-job list, one in the package enumeration).

- [ ] **Step 3: Remove the unused workspace dep from pi-agent-cli**

In `bun-apps/pi-agent-cli/package.json`, remove the line:
```json
    "@repo/pi-agent-ext-distill": "workspace:*",
```
(pi-agent-cli has zero source imports of distill — verified during design; this dep is dead.)

- [ ] **Step 4: Run `bun install` to update the lockfile**

Run: `bun install`
Expected: `bun.lock` updated (distill removed from the workspace dep graph). No errors.

- [ ] **Step 5: Update pi-infra-self-improve workflow scope (only if it lists distill)**

Run:
```bash
grep -n "pi-agent-ext-distill" .claude/workflows/pi-infra-self-improve.js .claude/workflows/pi-infra-self-improve.md 2>/dev/null
```
- If **no output**: skip — nothing to change.
- If **matches**: remove `pi-agent-ext-distill` from the scope list (the distill tests now run under knowledge-card, which is already in scope). Keep `pi-agent-ext-knowledge-card` in the list.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/run-dir/manifest.json .github/workflows/ci.yml .github/CI.md \
        bun-apps/pi-agent-cli/package.json bun.lock .claude/workflows/pi-infra-self-improve.js .claude/workflows/pi-infra-self-improve.md
git commit -m "chore: drop distill + grill-memory from manifest, CI, cli deps

- manifest: distill ext removed; grill-memory skills -> hermes-memory skills
- ci.yml + CI.md: drop pi-agent-ext-distill matrix entry
- pi-agent-cli: remove dead @repo/pi-agent-ext-distill workspace dep
- pi-infra-self-improve scope: drop distill (covered by knowledge-card)

Co-Authored-By: Claude <noreply@anthropic.com>"
```
(If git complains that some staged paths don't exist — e.g. you skipped the workflow edit — drop those paths from the `git add` list.)

---

### Task 7: Docs — context, layer map, PRD, supersede comment

**Files:**
- Modify: `bun-apps/KNOWLEDGE-LAYER.md`
- Modify: `bun-apps/pi-agent-cli/PRD.md`
- Modify: `bun-apps/pi-agent-ext-knowledge-card/src/supersede.ts` (comment only)
- Modify: `bun-apps/pi-agent-ext-knowledge-card/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md`

**Interfaces:** none (docs).

- [ ] **Step 1: KNOWLEDGE-LAYER.md — rewrite the distill row + remove standalone ref**

In `bun-apps/KNOWLEDGE-LAYER.md`:
- Line ~26: change the parenthetical `pi-agent-ext-distill (v0.0.0, NOT runtime-wired)` to read: `pi-agent-ext-knowledge-card (zk_ingest actions gate/converge/status)`.
- Lines ~40 and ~105 (the table row + the bullet that call distill a standalone package): replace the description so it states distill is now surfaced via `zk_ingest`'s `action` param inside knowledge-card — no standalone package. Remove the `(New, unwired)` / `no docs yet` framing.

Exact replacement for the table row (line ~40):
```markdown
| [`zk_ingest` distill actions](./pi-agent-ext-knowledge-card/) | Agent-self-triggered distillation of hermes entries (Gate→Enrich→Converge) | `zk_ingest` with `action=gate`/`converge`/`status` |
```

- [ ] **Step 2: pi-agent-cli/PRD.md — repoint the distill bullet**

In `bun-apps/pi-agent-cli/PRD.md` line ~88, change:
```markdown
- `pi-agent-ext-distill` (knowledge distillation pipeline: hermes-memory → vault → graph)
```
to:
```markdown
- `pi-agent-ext-knowledge-card` `zk_ingest` actions `gate`/`converge`/`status` (knowledge distillation pipeline: hermes-memory → vault → graph)
```

- [ ] **Step 3: supersede.ts comment — repoint the consumer**

In `bun-apps/pi-agent-ext-knowledge-card/src/supersede.ts` line ~4, change:
```
 * Used by pi-agent-ext-distill (mechanism B) to retire a raw `pi-memory:*` card
```
to:
```
 * Used by zk_ingest converge action (mechanism B) to retire a raw `pi-memory:*` card
```

- [ ] **Step 4: knowledge-card CONTEXT.md — add the Distill language section**

Append to `bun-apps/pi-agent-ext-knowledge-card/CONTEXT.md` (after the Architecture section):

```markdown

### Distill pipeline (folded into zk_ingest)

**Distill actions** (`zk_ingest` `action=gate|converge|status`):
The agent-self-triggered hermes-memory bloat reducer, surfaced as actions on
`zk_ingest` (no separate tool). `gate` deterministically filters raw entries;
enrichment happens in the driving agent's reasoning turn; `converge` writes via
`ingestRecords` + supersedes raw cards + adjusts the adaptive threshold.
_Avoid:_ distill tool (it is zk_ingest actions, not a tool).

**Survivors / Killed**:
Gate outputs — survivors are entries that passed (dedup/stale/malformed filter,
each with a reason), ready for in-context enrichment; killed are the rejected
entries (reason: duplicate/stale/malformed).
_Avoid:_ kept/passed, rejected/filtered.

**EnrichedNote**:
The agent-enriched shape handed to converge — id/type/title/detail/tags,
optional dimension/confidence/supersedesCardId.
_Avoid:_ note, card (it is the enriched-shape input to converge).

**DistillState**:
Per-vault pipeline state — adaptive threshold (N ∈ [20,200]) + run history +
lastRun. Read via `action=status`; converge adjusts the threshold from killRate
+ passRate (high kill+pass → −5; low pass → +10; else stable) and persists.
_Avoid:_ config, settings (it is the distill run-state + threshold + history).
```

- [ ] **Step 5: hermes-memory CONTEXT.md — add grill-memory skill entry**

Append to `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md`:

```markdown

### grill-memory skill

**grill-memory** (skill, `skills/grill-memory/SKILL.md`):
A trigger-on-description Pi skill shipped from this package's `skills/` dir.
Co-fires with the `grilling` skill during a grill — READ behavioral memory
into each recommendation via `memory_search`, WRITE each resolved decision via
the `grill_decision` tool (whose runtime lives in this package's
`src/tools/grill-decision-tool.ts`). Formerly its own package
(`pi-agent-ext-grill-memory`); merged in because the runtime was already here.
```

- [ ] **Step 6: Commit**

```bash
git add bun-apps/KNOWLEDGE-LAYER.md bun-apps/pi-agent-cli/PRD.md \
        bun-apps/pi-agent-ext-knowledge-card/src/supersede.ts \
        bun-apps/pi-agent-ext-knowledge-card/CONTEXT.md \
        bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md
git commit -m "docs: repoint distill + grill-memory references after the merge

distill is now zk_ingest actions (not a package); grill-memory skill now ships
from hermes-memory. KNOWLEDGE-LAYER, cli PRD, supersede comment, and both
CONTEXT files updated.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Delete the two source packages

**Files:**
- Delete: `bun-apps/pi-agent-ext-grill-memory/` (entire package)
- Delete: `bun-apps/pi-agent-ext-distill/` (entire package)

- [ ] **Step 1: Confirm no live refs remain**

Run:
```bash
grep -rn "pi-agent-ext-grill-memory\|pi-agent-ext-distill\|@repo/pi-agent-ext-distill" \
   --include='*.json' --include='*.ts' --include='*.tsx' --include='*.md' --include='*.yml' --include='*.yaml' \
   /Users/huangziyu/proj/video_generation__memory \
   | grep -v node_modules
```
Expected: only matches inside the two packages-to-delete themselves (plus possibly historical CHANGELOG lines in hermes-memory). No live wiring refs should remain (Tasks 6 + 7 removed them). If a live ref appears outside the two packages, stop and fix it before deleting.

- [ ] **Step 2: Delete both packages**

Run:
```bash
rm -rf bun-apps/pi-agent-ext-grill-memory bun-apps/pi-agent-ext-distill
```

- [ ] **Step 3: Re-run bun install to clean the workspace graph**

Run: `bun install`
Expected: no errors; lockfile stable.

- [ ] **Step 4: Commit**

```bash
git add -A bun-apps/pi-agent-ext-grill-memory bun-apps/pi-agent-ext-distill
git commit -m "chore: remove pi-agent-ext-grill-memory + pi-agent-ext-distill packages

Behavior fully merged: grill-memory skill lives in hermes-memory; distill
pipeline lives in knowledge-card's zk_ingest actions. The two source packages
are gone.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Final verification

**Files:** none (verification only).

- [ ] **Step 1: knowledge-card full suite**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test )`
Expected: green, including `__tests__/distill/*` (6 relocated + 1 new action test).

- [ ] **Step 2: hermes-memory full suite**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: green, including the new `grill-memory-skill.test.ts`.

- [ ] **Step 3: pi build:all + getAllTools probe**

Run: `bun run --cwd bun-apps/pi-agent build:all`
Expected: succeeds.

Then the tools probe — the schema-cost regression test already does `captureTools(kcardFactory)` (the recurring deploy footgun guard from repo memory), so it doubles as the "is the tool surface right?" check:
Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test extensions/__tests__/perf/schema-cost.regression.test.ts )`
Expected: the "4 tools registered" assertion still lists exactly `knowledge_query`, `zk_ask`, `zk_card`, `zk_ingest` — i.e. NO `distill` tool, and `zk_ingest` present.

- [ ] **Step 4: Confirm grill-memory skill still ships from hermes-memory**

Run:
```bash
test -f bun-apps/pi-agent-ext-hermes-memory/skills/grill-memory/SKILL.md && echo "skill present"
grep -n '"skills"' bun-apps/pi-agent-ext-hermes-memory/package.json
```
Expected: `skill present` and the `"skills": ["./skills"]` line.

- [ ] **Step 5: Repo-wide grep — no live wiring refs**

Run:
```bash
grep -rn "pi-agent-ext-grill-memory\|pi-agent-ext-distill" \
   --include='*.json' --include='*.ts' --include='*.tsx' --include='*.md' --include='*.yml' --include='*.yaml' \
   /Users/huangziyu/proj/video_generation__memory \
   | grep -v node_modules | grep -v CHANGELOG
```
Expected: no output (CHANGELOG historical mentions are acceptable).

- [ ] **Step 6: If all green — done, no commit (verification only)**

If anything failed, fix it under the relevant task and re-run. Do not mark complete on red.

---

## Self-Review notes

- **Spec coverage:** Part 1 (grill-memory → hermes-memory) = Task 1. Part 2 (distill → zk_ingest) = Tasks 2–5. Part 3 (manifest/CI/dep/scope) = Task 6. Part 4 (docs) = Task 7. Deletion = Task 8. Verification = Task 9. All spec sections covered.
- **Back-compat:** `action` is `Type.Optional`; the dispatch is a guard at the top of execute — the default ingest path is unreachable only when `action` is one of the three literals, else it falls through unchanged.
- **Schema-cost risk** is explicitly handled (Task 5) — the one regression test that could break.
- **`action`/`entries`/`notes`/`metrics` param names** are used identically in Task 4 (schema), Task 4 Step 5 (dispatch), and Task 4 Step 1 (test). Consistent.
- **Type re-export:** `MemoryEntry` is imported into the extension for the `runGate` call signature; other distill types stay internal to `src/distill/`.
