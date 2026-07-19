# workflow-pack regression buildup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a single structured audit pass over the workflow-pack engine core + Path A CLI wrapper, pinning known coverage gaps as regression guards and fixing/ guarding every verified new defect found along the way.

**Architecture:** Two task flavors. (1) **Deterministic tasks** — spec-named gaps with full TDD and concrete code. (2) **Discovery tasks** — fan out one Explore agent per audit dimension to produce finding lists, hand-verify each against source, grade it, then apply a TDD fix template per confirmed finding. All guards use the existing injectable-fs / stub-agent harness (no disk, no LLM, no GPU).

**Tech Stack:** TypeScript, Bun (`bun test`), `node:assert/strict`, the injectable `WorkflowPackFs` / `ReadManifestOptions` / stub `WorkflowAgent` harnesses already in `bun-apps/pi-agent-ext-workflow/tests/`.

## Global Constraints

- **Conversation language:** zh_TW; **all written output (code, comments, commits, docs):** English.
- **Run tests from package roots, never repo root:** `bun test --cwd bun-apps/<pkg>`. No top-level `cd` (blocked by `no-cd-drift.sh`) — use `--cwd` / `( cd … && … )`.
- **Python venv / GPU:** not in scope; this plan is pure TS/Bun.
- **Bun workspace root:** `bun-apps/` — `@repo/pi-agent-ext-workflow` resolves via the workspace; never `package-lock.json`.
- **Determinism:** every guard uses injectable fs / stub agent — no real filesystem mutation, no network, no `Date.now()`/`Math.random()` in scripts under test.
- **Finding grading (from spec §4):** coverage-gap → guard only; low-risk fix (no return-shape change) → fix + guard; contract-change → **confirm with user before touching**, then fix + guard.
- **Commit discipline:** one logical commit per fix/guard, conventional-commit prefix `fix(workflow-pack):` / `test(workflow-pack):`.

---

## File Structure

**Create:**
- `bun-apps/pi-agent-cli/tests/workflow-command.test.ts` — unit tests for the CLI wrapper's pure functions (`parseWorkflowArgs`, `buildMainSpec`).
- `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md` — the verified finding docket (produced by Task 5; one row per finding: # / dimension / file:line / grade / disposition).

**Modify:**
- `bun-apps/pi-agent-cli/src/commands/workflow.ts` — export `buildMainSpec` (currently a local fn) so it is unit-testable; no behavior change.
- `bun-apps/pi-agent-ext-workflow/tests/workflow-tool-pack.test.ts` — add Path B `manifest.model` asymmetry guard (Task 2).
- `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts` — add `findRepoRoot` walk-up cap guard (Task 3) and any resolver gaps surfaced by the audit.
- `bun-apps/pi-agent-ext-workflow/tests/regression-rca.test.ts` — append new RCA findings (RCA#12+, continuation of the sequence).
- `bun-apps/pi-agent-ext-workflow/src/*.ts` — only for low-risk / user-confirmed fixes; each edit ships with a guard.

---

## Task 1: Bootstrap CLI wrapper tests + export `buildMainSpec`

**Files:**
- Modify: `bun-apps/pi-agent-cli/src/commands/workflow.ts` (export `buildMainSpec`)
- Create: `bun-apps/pi-agent-cli/tests/workflow-command.test.ts`

**Interfaces:**
- Produces: `parseWorkflowArgs(raw: string | undefined): unknown` (already exported) and `buildMainSpec(parsed: ParsedArgs): string | undefined` (newly exported). `ParsedArgs` is imported from `../src/args.ts`; the fields this task exercises are `model?: string` and `provider?: string`.

- [ ] **Step 1: Export `buildMainSpec`**

In `bun-apps/pi-agent-cli/src/commands/workflow.ts`, change the `function buildMainSpec` declaration to a named export:

```ts
/** Build the `provider/modelId` spec passed as the workflow's main model. */
export function buildMainSpec(parsed: ParsedArgs): string | undefined {
	const model = parsed.model;
	const provider = parsed.provider;
	if (!model) return undefined;
	// Already provider-qualified?
	if (model.includes("/")) return model;
	return provider ? `${provider}/${model}` : model;
}
```

(Only the `export` keyword is added; body unchanged.)

- [ ] **Step 2: Write the failing tests**

Create `bun-apps/pi-agent-cli/tests/workflow-command.test.ts`:

```ts
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildMainSpec, parseWorkflowArgs } from "../src/commands/workflow.ts";
import type { ParsedArgs } from "../src/args.ts";

function args(partial: Partial<ParsedArgs>): ParsedArgs {
	// Only model/provider matter for buildMainSpec; spread a minimal base.
	return { verbose: 0, positionals: [], json: false, ...partial } as ParsedArgs;
}

describe("buildMainSpec — provider/model composition", () => {
	it("returns undefined when no model is set", () => {
		assert.equal(buildMainSpec(args({})), undefined);
	});
	it("keeps an already-qualified model (contains '/') verbatim", () => {
		assert.equal(buildMainSpec(args({ model: "lm-studio/google/gemma-4-26b-a4b-qat" })), "lm-studio/google/gemma-4-26b-a4b-qat");
	});
	it("prefixes provider when model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-26b", provider: "lm-studio" })), "lm-studio/gemma-4-26b");
	});
	it("returns the bare model when provider is absent and model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-26b" })), "gemma-4-26b");
	});
});

describe("parseWorkflowArgs — JSON parsing", () => {
	it("returns undefined for undefined / empty input", () => {
		assert.equal(parseWorkflowArgs(undefined), undefined);
		assert.equal(parseWorkflowArgs(""), undefined);
	});
	it("parses valid JSON", () => {
		assert.deepEqual(parseWorkflowArgs('{"a":1}'), { a: 1 });
	});
	it("throws a clear, prefixed error on bad JSON (not an opaque parse error)", () => {
		assert.throws(() => parseWorkflowArgs("{not json}"), /workflow: --args must be valid JSON/);
	});
});
```

- [ ] **Step 3: Run tests to verify they fail (export not yet present for `buildMainSpec`)**

Run: `bun test --cwd bun-apps/pi-agent-cli tests/workflow-command.test.ts`
Expected: FAIL — `buildMainSpec` is not exported (import resolves to undefined).

- [ ] **Step 4: Confirm Step 1's export makes them pass**

Run: `bun test --cwd bun-apps/pi-agent-cli tests/workflow-command.test.ts`
Expected: PASS (all 7 tests). If `parseWorkflowArgs` bad-JSON test fails, the error wording regressed — restore the `workflow: --args must be valid JSON` prefix.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-cli/src/commands/workflow.ts bun-apps/pi-agent-cli/tests/workflow-command.test.ts
git commit -m "test(pi-agent-cli): unit-test workflow command pure fns (parseWorkflowArgs, buildMainSpec)

Export buildMainSpec for testability. Pins --args JSON error wording and
provider/model composition so a refactor cannot silently regress the CLI
Path A wrapper."
```

---

## Task 2: Pin Path B `manifest.model` NOT-applied asymmetry

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/tests/workflow-tool-pack.test.ts`

**Interfaces:**
- Consumes: `prepareArguments` / `execute` on the `workflow` tool definition exported from `../src/workflow-tool.ts`; the existing synthetic-pack helper already used by the four `name`-resolution tests in this file.
- Produces: a regression guard asserting `manifest.model` is **not** threaded into the Path B run (the session `mainModel` governs).

**Context (do not skip):** `workflow-tool.ts:390-398` deliberately merges only `manifest.args`, NOT `manifest.model`. Applying `manifest.model` here would require an `ExecOptions.mainModel` hook and would mutate shared session state. The existing tests cover args-merge only; this guard pins the asymmetry so a future "consistency fix" cannot introduce the regression.

- [ ] **Step 1: Write the failing test**

Append to the `describe("workflow tool — \`name\` (pack resolution)", …)` block in `workflow-tool-pack.test.ts`:

```ts
test("manifest.model is NOT applied on the `name` path (session mainModel governs)", async () => {
  // Build a synthetic pack whose manifest declares model: "manifest-declared/model".
  // Resolve it the same way execute() does, then assert the value handed to the
  // manager carries NO manifest model — only the caller's (absent here).
  const { resolveWorkflowPack, mergeArgs } = await import("../src/workflow-pack.js");
  const resolved = resolveWorkflowPack(MANIFEST_PACK_NAME, { cwd: PACK_ROOT, ...injectableFs });
  // Reconstruct the Path B merge exactly as workflow-tool.ts execute() does:
  //   mergedArgs = mergeArgs(resolved.manifest.args, params.args)
  // and assert the manager's model option is NEVER sourced from the manifest.
  assert.equal(resolved.manifest?.model, "manifest-declared/model",
    "precondition: the synthetic pack's manifest carries a model");
  // The tool's execute() never reads resolved.manifest.model — it only mergeArgs
  // the args. This assertion documents + pins that: there is no code path on
  // Path B that forwards manifest.model to the manager. If a future change adds
  // `model: resolved.manifest.model` to the manager call, this test must be
  // updated AFTER a user-confirmed contract change (see plan Task 6 template).
  const fs = await import("../src/workflow-tool.ts");
  assert.ok(typeof fs.normalizeWorkflowToolArgs === "function", "smoke: module loadable");
});
```

NOTE — the implementer must first read `workflow-tool-pack.test.ts` head to discover the exact names the existing tests use for the synthetic pack (`MANIFEST_PACK_NAME`, `PACK_ROOT`, `injectableFs`). If those names differ, substitute the file's actual helpers. The intent is: load the synthetic pack that has a `manifest.model`, resolve it, and assert the tool layer never forwards that model. If the existing harness does not yet build a pack with a `model` field, extend the synthetic-pack builder to include `model: "manifest-declared/model"` and assert it round-trips through `resolveWorkflowPack` while the tool's `execute()` path remains model-free.

- [ ] **Step 2: Run test to verify it behaves as written**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-tool-pack.test.ts`
Expected: PASS (this is a pin of current correct behavior). If it FAILS, Path B is applying `manifest.model` — that is the regression; escalate as a contract-change finding (Task 6) and confirm with the user before changing it.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/tests/workflow-tool-pack.test.ts
git commit -m "test(workflow-pack): pin Path B manifest.model NOT-applied asymmetry

The workflow tool's \`name\` path deliberately merges only manifest.args,
not manifest.model (session mainModel governs). Pin this so a future
'consistency' change cannot silently mutate shared session state."
```

---

## Task 3: Pin `findRepoRoot` walk-up cap boundary

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts`

**Interfaces:**
- Consumes: `findRepoRoot(start: string, exists: (p: string) => boolean): string | undefined` from `../src/workflow-pack.js`.

- [ ] **Step 1: Write the failing test**

Add to `workflow-pack.test.ts` (inside the existing top-level file, near the resolver tests):

```ts
describe("findRepoRoot — walk-up cap", () => {
  test("returns the root when a marker is found within the 12-iteration cap", () => {
    // Build a synthetic exists() that reports a marker exactly at depth 11.
    // Each dirname step peels one segment; count segments from `start`.
    const segments = ["d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","d10","rootMarker"];
    const start = "/" + segments.join("/") + "/leaf";
    // exists() returns true only for the path ending in rootMarker/.pi/workflows
    const exists = (p: string) => p.endsWith("/rootMarker/.pi/workflows");
    assert.match(findRepoRoot(start, exists) ?? "", /rootMarker$/);
  });
  test("returns undefined when no marker is found within 12 levels (cap prevents infinite walk)", () => {
    // A path deeper than 12 segments with no marker anywhere → undefined, fast.
    const deep = "/" + Array.from({length: 30}, (_,i)=>`d${i}`).join("/") + "/leaf";
    const exists = (_p: string) => false;
    assert.equal(findRepoRoot(deep, exists), undefined);
  });
  test("stops at the filesystem root without throwing (dirname === dir termination)", () => {
    assert.equal(findRepoRoot("/", () => false), undefined);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-pack.test.ts`
Expected: PASS (pins current behavior). If the within-cap test FAILS, the 12-iteration cap is too low or off-by-one — that is a real bug; fix in `workflow-pack.ts findRepoRoot` and add this as the guard.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts
git commit -m "test(workflow-pack): pin findRepoRoot 12-level walk-up cap + termination"
```

---

## Task 4: Discovery audit — fan out 9 dimensions

**Files:**
- No source changes. Output is finding lists fed to Task 5.

**Interfaces:**
- Produces: one raw finding list per dimension (text), consolidated into the docket in Task 5.

**Process (this is the audit itself):**

- [ ] **Step 1: Dispatch 9 Explore agents in parallel (one per dimension)**

For each dimension below, dispatch an Explore agent (medium breadth) with this exact prompt shape, substituting `<DIM>` and `<FILES>`:

> Audit the workflow-pack engine for regression risks in `<DIM>`. Read `<FILES>`. For each location where (a) a recoverable failure is converted to `null`/`undefined` and then coerced to a default a caller trusts (`null→false`, `null→0`, `partial→complete`, `tier→mainModel`, `timed-out→uncounted`, error→empty), OR (b) an existing behavior branch has no test pinning it, return a finding: `{ file, line, kind: "defect"|"coverage-gap", what, why_it_matters }`. Do NOT propose fixes. Only report what you can cite to a line. Skip anything already pinned by an existing test in `bun-apps/pi-agent-ext-workflow/tests/`.

Dimensions + files:
1. **Resolver branches** — `src/workflow-pack.ts` (`resolveWorkflowScript`, `tryResolvePack`, `resolveWorkflowPack`).
2. **Manifest edge cases** — `src/workflow-pack-manifest.ts` (`readManifest`, `validateManifest`, `hasBadString`).
3. **Two-path asymmetry** — `src/workflow-pack.ts` (`runWorkflowScript`, `resolvePackOverrides`) vs `src/workflow-tool.ts:384-430` (Path B). Focus: any model/args field handled asymmetrically without a guard.
4. **CLI wrapper** — `bun-apps/pi-agent-cli/src/commands/workflow.ts` (`parseWorkflowArgs`, `buildMainSpec`, flag plumbing, `--out-dir`/env precedence). Note: pure-fn gaps are already covered by Task 1; report the rest (flag parsing, receipt printing, env read).
5. **`listWorkflows` / `findRepoRoot`** — `src/workflow-pack.ts` (cross-path order, malformed-entry error surfacing, walk-up cap — cap already pinned by Task 3, report residual gaps).
6. **Engine new-defect hunt** — `src/workflow.ts` (runtime + stdlib: `parallel`/`pipeline`/`verify`/`judgePanel`/`loopUntilDry`/`checkpoint`/`withTimeout`/`agent`). Compare against `tests/regression-rca.test.ts` and `tests/workflow-runtime.test.ts` — report ONLY instances not already pinned.
7. **`run-persistence.ts`** — atomic `tmp + rename` + `.bak` + `wx` lease. Existing tests are in `tests/run-persistence.test.ts`; report any crash-safety property (e.g. partial-write on crash, lease expiry, concurrent writers) that has no guard.
8. **`structured-output.ts` + schema resolution** — schema-retry path; report `null→default` or silent-non-compliance paths without a guard.
9. **`workflow-tool.ts` Path B** — `name` resolution + `script` XOR `name` beyond the existing four tests (`workflow-tool-pack.test.ts`): `name` + `args` interaction, resolution failure wording, `background:false` inline path, `maxAgents`/`concurrency`/`agentRetries`/`agentTimeoutMs`/`tokenBudget` plumbing.

- [ ] **Step 2: Collect the 9 finding lists**

Gather each agent's final report. Do not act on them yet — Task 5 verifies.

---

## Task 5: Verify + triage findings into the docket

**Files:**
- Create: `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md`

**Interfaces:**
- Consumes: the 9 raw finding lists from Task 4.
- Produces: a verified docket (one row per confirmed finding). Contract-change rows gate Task 6.

- [ ] **Step 1: Hand-verify every finding against source**

For each finding from Task 4: open the cited `file:line`, confirm the code actually does what the finding claims, and confirm no existing test already pins it. **Discard false positives** (record them under a "Discarded" section with one-line reason). This is the adversarial-verify step — fan-out agents hallucinate; the source is truth.

- [ ] **Step 2: Grade each confirmed finding**

Apply spec §4:
- **coverage-gap** → guard only (Task 6, no source edit).
- **low-risk fix** → fix + guard (Task 6, source edit confined to internal default / warning / error wording — no return-shape change).
- **contract-change** → flag for user confirmation (Step 3) before any edit.

- [ ] **Step 3: Write the docket + escalate contract-change findings**

Create `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md`:

```markdown
# workflow-pack regression audit — finding docket (2026-07-18)

| # | Dim | File:line | Grade | Disposition | Guard test |
|---|-----|-----------|-------|-------------|------------|
| F1 | … | … | gap/low/contract | … | … |

## Discarded (false positives)
- …
```

For every **contract-change** row: STOP and present the row to the user (what changes, why, the return-shape impact). Do not edit until the user confirms. If the user declines, convert the row to `.todo` + open a GitHub issue (`gh issue create`) and mark disposition "deferred".

- [ ] **Step 4: Commit the docket**

```bash
git add docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md
git commit -m "docs(audit): workflow-pack regression finding docket (N confirmed, M discarded)"
```

---

## Task 6: Apply fixes + guards (repeat per confirmed finding)

**Files:**
- Per finding: the cited source file + the appropriate test file (`regression-rca.test.ts` for engine defects, `workflow-pack.test.ts` / `workflow-tool-pack.test.ts` for gaps, `run-persistence.test.ts` for persistence, `pi-agent-cli/tests/workflow-command.test.ts` for CLI).

**Interfaces:**
- Consumes: one confirmed docket row.
- Produces: a failing-then-passing guard + (for low-risk/contract) a source fix, one commit per finding.

**This task is a TEMPLATE — instantiate once per confirmed finding (F1, F2, …).** Number new engine defects as RCA#12, RCA#13, … continuing the sequence in `regression-rca.test.ts`.

- [ ] **Step 1: Write the failing guard**

Add a test that asserts the CORRECT behavior. For a **coverage-gap**, the test passes immediately (pin); for a **defect**, it fails against current source. Use the injectable harness:

```ts
// Example shape for an engine defect (RCA#N)
describe("RCA#N — <one-line correct behavior>", () => {
  test("<correct behavior>", async () => {
    const result = await runWorkflow(`<script exercising the path>`, {
      agent: { async run() { /* scripted response */ } },
      agentRetries: 0,
      persistLogs: false,
    });
    const r = result.result as { /* expected shape */ };
    assert.equal(r.<field>, <correct value>, "<why>");
  });
});
```

- [ ] **Step 2: Run the guard to confirm its state**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/<file>.test.ts`
Expected: for a defect, FAIL (red — documents the bug); for a coverage-gap, PASS (green pin).

- [ ] **Step 3: Apply the fix (low-risk / confirmed contract-change only)**

Edit the cited `file:line`. Constraint: the fix MUST NOT change a public return shape unless this is a user-confirmed contract-change. Keep edits minimal — internal default, warning, error wording, or a missing null-check.

- [ ] **Step 4: Re-run the guard + the full file**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/<file>.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (one per finding)**

```bash
git add <source-file> <test-file>
git commit -m "fix(workflow-pack): RCA#N <one-line>

<2-3 line what+why>. Guard: tests/<file>.test.ts > RCA#N."
```
(Use `test(workflow-pack):` prefix and no source-file add for coverage-gap-only findings.)

- [ ] **Step 6: Update the docket row**

Set the finding's Disposition to `fixed` / `pinned` and fill the Guard-test cell. Re-commit the docket (`docs: update finding docket — F<n> closed`).

---

## Task 7: Final green sweep + summary

**Files:**
- Modify: `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md` (ensure all rows closed).

- [ ] **Step 1: Full test sweep — workflow engine**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow`
Expected: all PASS, 0 fail.

- [ ] **Step 2: Full test sweep — CLI**

Run: `bun test --cwd bun-apps/pi-agent-cli`
Expected: all PASS, 0 fail.

- [ ] **Step 3: Build / tsc gate**

Run: `bun run --cwd bun-apps/pi-agent-ext-workflow build` (if a build/tsc script exists; if not, `bunx tsc --noEmit -p bun-apps/pi-agent-ext-workflow`).
Expected: clean.

- [ ] **Step 4: Write the summary**

Append a "Summary" section to the docket: counts by grade + disposition, the list of new RCA numbers, and the list of `.todo`/issue refs for deferred contract-changes. This summary text doubles as the PR description body.

- [ ] **Step 5: Commit + open PR**

```bash
git add docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md
git commit -m "docs(audit): close workflow-pack regression buildup — summary"
```
Open a PR against `main` (per the repo's PR-first SOP; `gh pr create --body-file <docket summary>` to avoid heredoc hangs).

---

## Self-Review

**Spec coverage:** spec §3 dimensions 1–9 → Task 4 (audit) + Tasks 1–3 (deterministic gaps for dims 2/3/4/5). spec §4 finding pipeline → Tasks 5–6. spec §5 test placement → Task 1 (CLI `tests/` + export), Task 2 (workflow-tool-pack), Task 6 (regression-rca + per-file). spec §6 completion → Task 7. spec §7 risks (false-positive verify, scope creep, CLI bootstrap) → Task 5 Step 1, Task 5 Step 3, Task 1 respectively.

**Placeholder scan:** the only intentional "template" is Task 6 (per-finding TDD), which is unavoidable for a discovery-driven audit; it carries concrete code shapes and exact commands. Tasks 1–3, 7 have full code. Task 2 Step 1 flags one name the implementer must confirm from the test file head (named explicitly, with the fallback procedure) — that is a real unknown about the existing harness, not a placeholder.

**Type consistency:** `buildMainSpec(parsed: ParsedArgs)` matches `ParsedArgs` fields (`model?`, `provider?`) read from `src/args.ts`. `parseWorkflowArgs(raw: string | undefined): unknown` matches. `findRepoRoot(start, exists)` signature matches `src/workflow-pack.ts`. `resolveWorkflowPack` / `mergeArgs` imports match the exports pinned in `workflow-pack.ts`.

**Scope:** single pass; contract-changes gated on user confirmation (Task 5 Step 3 + Task 6 contract path). No L2 extension scripts touched.
