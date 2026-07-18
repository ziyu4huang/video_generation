# workflow-pack default model — explicit pi-default inheritance (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow-pack's model resolution explicit (`--model > PI_MODEL > manifest.model > pi default`) instead of relying on `createAgentSession`'s implicit fallback, and surface the resolved model + source in both paths' receipts.

**Architecture:** A pure `resolveModel()` in the engine returns `{model, source}` from four inputs (caller/env/manifest/piDefault). The CLI computes the pi default by reusing the existing `resolveLLM` + settings-read path (`sessions/shared.ts` + `sessions/passthrough.ts`) — the same path `pi-agent.sh` uses — and passes it as `piDefaultModel` into `runWorkflowScript`, which now passes an explicit `mainModel` to `runWorkflow` (removing the implicit fallback) and returns `model`+`modelSource` in the receipt. Path B labels its result with `modelSource:"session"` but still does not apply `manifest.model` (Task-2 guard stays; manager hook is separate work, #630).

**Tech Stack:** TypeScript, Bun (`bun test`), `node:assert/strict` / `bun:test` `expect`, the injectable + stub-agent harnesses already in `bun-apps/pi-agent-ext-workflow/tests/` and the passthrough-mock pattern in `bun-apps/pi-agent-cli/tests/workflow-command.test.ts`.

## Global Constraints

- **Conversation language:** zh_TW; **all written output (code, comments, commits, docs):** English.
- **Run tests from package roots:** `bun test --cwd bun-apps/<pkg>` / `bun run --cwd bun-apps/pi-agent-ext-workflow build` (tsc). No top-level `cd` (blocked by `no-cd-drift.sh`) — use `--cwd` / `( cd … && … )`.
- **CI gate:** `pi-agent-ext-workflow` = `bun run build && bun test`; `pi-agent-cli` = `bun test`. biome `check` is intentionally excluded (pre-existing drift). Don't introduce new biome errors in touched files but don't fix pre-existing ones.
- **No new settings reader:** the pi default MUST come from the existing `resolveLLM` + passthrough settings-read path. Do not write a second settings reader.
- **Behavior equivalence:** the resolved model passed explicitly as `mainModel` must equal what the implicit fallback used (same model id). Verified by live with/without-`--model` comparison.
- **Path B scope:** do NOT touch the manager API or the Task-2 "no manifest.model on Path B" guard. Only label the result.
- **Commit discipline:** conventional-commit prefixes `fix(workflow-pack):` / `feat(workflow-pack):` / `test(...)`.

---

## File Structure

**Modify:**
- `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts` — add `resolveModel` + `ModelSource`; thread `piDefaultModel`/`callerModel`/`envModel` through `runWorkflowScript`; return `model`+`modelSource` in the receipt; pass explicit `mainModel`.
- `bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts` — Path B: add `model`+`modelSource:"session"` to result `details`.
- `bun-apps/pi-agent-cli/src/sessions/passthrough.ts` — extract the settings-read into a reusable `readUserDefaults()` (used by both `resolveLLMFromArgs` and the new pi-default computation).
- `bun-apps/pi-agent-cli/src/commands/workflow.ts` — compute `piDefaultModel` + `envModel`, pass to `runWorkflowScript`; render `model`+`modelSource` in text + `--json` receipt.

**Test:**
- `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts` — `resolveModel` branch guards + `runWorkflowScript` receipt assertions.
- `bun-apps/pi-agent-ext-workflow/tests/workflow-tool-pack.test.ts` — Path B result label assertion.
- `bun-apps/pi-agent-cli/tests/workflow-command.test.ts` — receipt text + `--json` model fields (passthrough-mock pattern from the merged D4-1 test).

---

## Task 1: Add pure `resolveModel` + branch guards (engine)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts`

**Interfaces:**
- Produces: `export type ModelSource = "--model" | "env" | "manifest" | "pi-default" | "none";` and `export function resolveModel(callerModel, envModel, manifestModel, piDefaultModel): { model: string | undefined; source: ModelSource }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/workflow-pack.test.ts` (match the file's `bun:test` `expect` style):

```ts
import { resolveModel } from "../src/workflow-pack.js";

describe("resolveModel — precedence --model > PI_MODEL > manifest > pi-default", () => {
  test("caller --model wins", () => {
    const r = resolveModel("cli/x", "env/y", "manifest/z", "pi/d");
    expect(r).toEqual({ model: "cli/x", source: "--model" });
  });
  test("env wins when no caller (PI_MODEL above manifest)", () => {
    const r = resolveModel(undefined, "env/y", "manifest/z", "pi/d");
    expect(r).toEqual({ model: "env/y", source: "env" });
  });
  test("manifest wins when no caller/env", () => {
    const r = resolveModel(undefined, undefined, "manifest/z", "pi/d");
    expect(r).toEqual({ model: "manifest/z", source: "manifest" });
  });
  test("pi-default wins when no caller/env/manifest", () => {
    const r = resolveModel(undefined, undefined, undefined, "pi/d");
    expect(r).toEqual({ model: "pi/d", source: "pi-default" });
  });
  test("all undefined -> {undefined, none}", () => {
    const r = resolveModel(undefined, undefined, undefined, undefined);
    expect(r).toEqual({ model: undefined, source: "none" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-pack.test.ts`
Expected: FAIL — `resolveModel` is not exported.

- [ ] **Step 3: Implement `resolveModel`**

Add to `src/workflow-pack.ts` (near `mergeArgs`/`resolvePackOverrides`):

```ts
/** How the workflow's main model was chosen — surfaced in the run receipt. */
export type ModelSource = "--model" | "env" | "manifest" | "pi-default" | "none";

/**
 * Resolve the workflow's main model from the four-tier precedence
 * (--model flag > PI_MODEL env > manifest.model > pi default). Pure — every
 * tier is an explicit input so each branch is unit-testable with no disk/LLM.
 * `{ model: undefined, source: "none" }` when nothing is configured (the engine
 * then hands undefined to createAgentSession as the original last-resort fallback).
 */
export function resolveModel(
  callerModel: string | undefined,
  envModel: string | undefined,
  manifestModel: string | undefined,
  piDefaultModel: string | undefined,
): { model: string | undefined; source: ModelSource } {
  if (callerModel) return { model: callerModel, source: "--model" };
  if (envModel) return { model: envModel, source: "env" };
  if (manifestModel) return { model: manifestModel, source: "manifest" };
  if (piDefaultModel) return { model: piDefaultModel, source: "pi-default" };
  return { model: undefined, source: "none" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-pack.test.ts`
Expected: PASS (all `resolveModel` tests + existing tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts
git commit -m "feat(workflow-pack): add pure resolveModel (4-tier model precedence)"
```

---

## Task 2: Wire `resolveModel` into `runWorkflowScript` (engine)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts` (`RunWorkflowScriptOptions`, `runWorkflowScript`)

**Interfaces:**
- Consumes: `resolveModel` (Task 1).
- Produces: `RunWorkflowScriptOptions` gains `callerModel?: string`, `envModel?: string`, `piDefaultModel?: string` (the existing `model?: string` is kept as a deprecated alias mapping to `callerModel` for backward compat with existing callers/tests — see Step 1 note). `runWorkflowScript`'s return gains `model: string | undefined` and `modelSource: ModelSource`.

- [ ] **Step 1: Write the failing test**

Add to `tests/workflow-pack.test.ts` in the `runWorkflowScript` describe block:

```ts
test("no overrides -> mainModel is the pi default (source pi-default), not undefined", async () => {
  // drive with a stub agent + dry-run-equivalent: resolveModel runs before the agent.
  // Use a real echo pack path so resolution succeeds; dryRun so no agent fires.
  const echoPack = path.resolve(REPO, "bun-apps/pi-agent-cli/workflows/echo");
  const receipt = await runWorkflowScript({
    name: echoPack,
    dryRun: true,
    piDefaultModel: "zai/glm-5.2",
  });
  expect(receipt.model).toBe("zai/glm-5.2");
  expect(receipt.modelSource).toBe("pi-default");
});

test("manifest.model beats pi default (source manifest)", async () => {
  // args-demo or a pack with manifest.model — use the synthetic pack helper if
  // the real packs lack model; else build a tmp pack with manifest.model set.
  // Assert receipt.modelSource === "manifest" and receipt.model === manifest's model.
});
```

NOTE for the implementer: the existing `runWorkflowScript` tests pass `model:` (the old field). Keep `model?` working as an alias for `callerModel` so those tests don't break — in `runWorkflowScript`, treat `opts.callerModel ?? opts.model` as the caller value. (This alias is the only backward-compat concession; document it in a comment.)

- [ ] **Step 2: Run to verify fail**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-pack.test.ts`
Expected: FAIL — `receipt.model`/`receipt.modelSource` undefined; `piDefaultModel` opt not accepted.

- [ ] **Step 3: Wire it in**

In `src/workflow-pack.ts`:

(a) Extend `RunWorkflowScriptOptions`:
```ts
export interface RunWorkflowScriptOptions {
  name: string;
  args?: unknown;
  /** Caller --model flag (provider/id). Alias: legacy `model`. */
  callerModel?: string;
  /** @deprecated use callerModel; kept as alias for existing callers. */
  model?: string;
  /** PI_MODEL env value (provider/id), if the CLI reads it. */
  envModel?: string;
  /** Resolved pi default (provider/id), computed by the CLI from settings. */
  piDefaultModel?: string;
  dryRun?: boolean;
  persistLogs?: boolean;
  cwd?: string;
  outDir?: string;
  agent?: Pick<WorkflowAgent, "run">;
  onPhase?: (title: string) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown; error?: string }) => void;
}
```

(b) In `runWorkflowScript`, replace the model resolution (currently `resolvePackOverrides(resolved.pack, { args: opts.args, model: opts.model })` for the model line) with `resolveModel`:
```ts
const resolved = resolveWorkflowScript(opts.name, { cwd: opts.cwd });
const { meta } = parseWorkflowScript(resolved.script);
const callerModel = opts.callerModel ?? opts.model;
const { model, source: modelSource } = resolveModel(
  callerModel,
  opts.envModel,
  resolved.pack?.manifest.model,
  opts.piDefaultModel,
);
// args still merge via the existing mergeArgs (manifest.args under caller args)
const args = mergeArgs(resolved.pack?.manifest.args, opts.args);
```
Keep the `identity`/`dryRun` block as-is. In the `runWorkflow` call, pass `mainModel: model` explicitly (was `overrides.model`). In BOTH the dry-run return and the live return, add `model` and `modelSource`:
```ts
return { ..., model, modelSource, dryRun: true };
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-pack.test.ts`
Expected: PASS (new + existing). The existing `runWorkflowScript` tests that pass `model:` still pass via the alias.

- [ ] **Step 5: Build (tsc) + full package**

Run: `bun run --cwd bun-apps/pi-agent-ext-workflow build && bun test --cwd bun-apps/pi-agent-ext-workflow`
Expected: tsc clean; 0 new failures (known flaky `usage-limit-integration.test.ts` timeout under parallel load passes alone).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts
git commit -m "feat(workflow-pack): runWorkflowScript resolves model via resolveModel + returns model/source"
```

---

## Task 3: CLI — compute pi default + render model in receipt

**Files:**
- Modify: `bun-apps/pi-agent-cli/src/sessions/passthrough.ts` (extract `readUserDefaults`)
- Modify: `bun-apps/pi-agent-cli/src/commands/workflow.ts` (compute + pass + render)
- Test: `bun-apps/pi-agent-cli/tests/workflow-command.test.ts`

**Interfaces:**
- Consumes: `runWorkflowScript` now accepts `callerModel`/`envModel`/`piDefaultModel` and returns `model`/`modelSource` (Task 2).
- Produces: `readUserDefaults(): { provider?: string; model?: string }` exported from `passthrough.ts` (reused by `resolveLLMFromArgs` and the workflow command).

- [ ] **Step 1: Extract `readUserDefaults` in passthrough.ts**

Refactor `resolveLLMFromArgs` so the settings-read is its own exported helper (no behavior change):
```ts
/** Read user default provider/model from ~/.pi/agent/settings.json (best-effort). */
export function readUserDefaults(): { provider?: string; model?: string } | undefined {
  try {
    const { getAgentDir } = require("@earendil-works/pi-coding-agent");
    const { readFileSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return undefined;
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    return { provider: s.defaultProvider, model: s.defaultModel };
  } catch {
    return undefined;
  }
}

export async function resolveLLMFromArgs(parsed: ParsedArgs): Promise<ResolvedLLM> {
  return resolveLLM({
    provider: parsed.provider,
    model: parsed.model,
    thinking: parsed.thinking,
    userDefaults: readUserDefaults(),
  });
}
```
NOTE: keep the ORIGINAL dynamic-`import()` style if that's what the file uses (it does — see passthrough.ts:65-80); preserve it in `readUserDefaults` to avoid changing the module-loading behavior. The `require()` above is illustrative — match the file's existing `await import(...)` pattern.

- [ ] **Step 2: Compute + pass in workflow.ts run()**

In `commands/workflow.ts`, after `const model = buildMainSpec(parsed);`:
```ts
import { resolveLLM } from "../sessions/shared.js";
import { readUserDefaults } from "../sessions/passthrough.js";

// pi default = resolveLLM with NO model/provider override (settings + fallback only).
const piDefault = resolveLLM({ userDefaults: readUserDefaults() });
const piDefaultModel = `${piDefault.provider}/${piDefault.modelId}`;
const envModel = process.env.PI_MODEL;
```
Then in the `runWorkflowScript({...})` call, replace `model,` with:
```ts
callerModel: model,
envModel,
piDefaultModel,
```

- [ ] **Step 3: Render model + source in receipt**

In the text receipt branch (the `console.log("✓ ${receipt.meta.name} …")` line), insert the model label:
```ts
const modelTag = receipt.model ? ` (model: ${receipt.model} [${receipt.modelSource}])` : "";
console.log(
  `✓ ${receipt.meta.name} — agents=${receipt.agentCount} ` +
    `${receipt.durationMs ? `${receipt.durationMs}ms ` : ""}` +
    `${modelTag}` +
    `(source: ${receipt.source})` +
    (receipt.runId ? ` run=${receipt.runId}` : "") +
    ` → ${resultKind}`,
);
```
In the `--json` branch, add `model: receipt.model, modelSource: receipt.modelSource,` to the printed object.

- [ ] **Step 4: Write the failing test**

Add to `tests/workflow-command.test.ts`, reusing the D4-1 passthrough-mock pattern (mock `@repo/pi-agent-ext-workflow` `runWorkflowScript`, capture the model opts + return a fake receipt with `model`/`modelSource`):
```ts
test("CLI computes piDefaultModel + passes callerModel/envModel; renders model in receipt", async () => {
  // mock runWorkflowScript to capture {callerModel, envModel, piDefaultModel} and
  // return {model:"zai/glm-5.2", modelSource:"pi-default", ...}.
  // Drive run() with no --model, no PI_MODEL; assert:
  //   - captured callerModel === undefined
  //   - captured piDefaultModel === "zai/glm-5.2" (or settings value; mock settings read)
  //   - printed receipt contains "model: zai/glm-5.2 [pi-default]"
  // Then a second case with --model "lm-studio/x" -> callerModel === "lm-studio/x",
  //   rendered model source "--model".
});
```
Mock `readUserDefaults` (via mock.module on `../sessions/passthrough.js`) to return a fixed `{provider:"zai",model:"glm-5.2"}` so the test is hermetic (no real settings dependency).

- [ ] **Step 5: Run to verify pass**

Run: `bun test --cwd bun-apps/pi-agent-cli tests/workflow-command.test.ts`
Expected: PASS (new + existing 10).

- [ ] **Step 6: Build + full package**

Run: `bun run --cwd bun-apps/pi-agent-cli build`
Expected: bundle succeeds.
Run: `bun test --cwd bun-apps/pi-agent-cli`
Expected: only known pre-existing e2e timeouts (`src/__tests__/meta.e2e.test.ts`, `shared.test.ts`) — nothing new.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-cli/src/sessions/passthrough.ts bun-apps/pi-agent-cli/src/commands/workflow.ts bun-apps/pi-agent-cli/tests/workflow-command.test.ts
git commit -m "feat(pi-agent-cli): workflow run resolves pi-default model + shows it in receipt"
```

---

## Task 4: Path B — label result with model source

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-tool-pack.test.ts`

**Interfaces:**
- Produces: the tool's result `details` gains `model?: string` and `modelSource: "session"` on BOTH the background path (`{runId, background:true}`) and the inline snapshot path.

**Context:** Path B's model is the session `mainModel` (= pi default by construction). This task only LABELS it — do NOT apply `manifest.model` (Task-2 guard stays). Investigate where the session mainModel is observable (likely `ctx.session.mainModel` or via the manager) — if not reachable, set `modelSource:"session"` and omit `model` (or use whatever the session exposes), with a comment.

- [ ] **Step 1: Investigate ctx shape**

Read `workflow-tool.ts` `execute()` (≈ lines 387-516) and grep for what `ctx` exposes (`ctx.session`, `ctx.mainModel`, the `manager`). Determine the most reliable way to read the session's main model. If none is available, the label is `modelSource:"session"` with `model: undefined` and a comment explaining it's the host session's model.

- [ ] **Step 2: Write the failing test**

Add to `tests/workflow-tool-pack.test.ts`:
```ts
test("Path B result details label modelSource:'session' (manifest.model still NOT applied)", async () => {
  // build a pack WITH manifest.model; run via name, background:true.
  // assert result.details.modelSource === "session".
  // re-assert the Task-2 guard: the options object handed to startInBackground
  //   still has NO model/mainModel key (manifest.model NOT applied).
});
```

- [ ] **Step 3: Run to verify fail**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-tool-pack.test.ts`
Expected: FAIL — `details.modelSource` absent.

- [ ] **Step 4: Add the label**

In `workflow-tool.ts` execute(), add to the background return `details` AND the inline snapshot `details`:
```ts
details: { runId, background: true, modelSource: "session", ...(sessionMainModel ? { model: sessionMainModel } : {}) }
```
where `sessionMainModel` is read per Step 1 (or omitted if unreachable). Do NOT change the `startInBackground`/`runSync` options object (Task-2 guard).

- [ ] **Step 5: Run to verify pass**

Run: `bun test --cwd bun-apps/pi-agent-ext-workflow tests/workflow-tool-pack.test.ts`
Expected: PASS (new + existing 12, including the Task-2 model-asymmetry guard).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts bun-apps/pi-agent-ext-workflow/tests/workflow-tool-pack.test.ts
git commit -m "feat(workflow-pack): Path B result labels modelSource:session"
```

---

## Task 5: Live verification + final sweep

**Files:** none (verification only).

- [ ] **Step 1: Live Path A — without --model, from /tmp**

```bash
REPO=$(pwd); mkdir -p /tmp/wf-dm/out
( cd /tmp/wf-dm && bun "$REPO/bun-apps/pi-agent-cli/src/cli.ts" workflow run "$REPO/bun-apps/pi-agent-cli/workflows/echo" --args '{"msg":"default-model"}' --out-dir /tmp/wf-dm/out )
```
Expected: receipt prints `model: zai/glm-5.2 [pi-default]`; run succeeds (`agents=1`).

- [ ] **Step 2: Live Path A — with --model**

```bash
( cd /tmp/wf-dm && bun "$REPO/bun-apps/pi-agent-cli/src/cli.ts" workflow run "$REPO/bun-apps/pi-agent-cli/workflows/echo" --model lm-studio/google/gemma-4-26b-a4b-qat --out-dir /tmp/wf-dm/out )
```
Expected: receipt prints `model: lm-studio/google/gemma-4-26b-a4b-qat [--model]`.

- [ ] **Step 3: Confirm parity with pi-agent.sh default**

Both runs' `[pi-default]` model (`zai/glm-5.2`) must equal `~/.pi/agent/settings.json`'s `defaultProvider/defaultModel` — the same value a bare `pi-agent.sh` session uses. State this explicitly in the PR body.

- [ ] **Step 4: Final test sweep + build**

```bash
bun run --cwd bun-apps/pi-agent-ext-workflow build && bun test --cwd bun-apps/pi-agent-ext-workflow
bun run --cwd bun-apps/pi-agent-cli build && bun test --cwd bun-apps/pi-agent-cli
```
Expected: tsc + bundle clean; only known pre-existing flaky/e2e failures.

- [ ] **Step 5: Commit any doc update + open PR**

If the live run surfaced a doc tweak (e.g. `commands/workflow.ts` header comment, or `docs/workflow-cli.md`), commit it. Open a PR against `main` (`gh pr create --body-file`, `GH_PAGER=cat`).

---

## Self-Review

**Spec coverage:** spec §3 precedence → Tasks 1-2 (`resolveModel` 4-tier). spec §4.2 pi-default reuse → Task 3 (readUserDefaults + resolveLLM, no new reader). spec §4.3 explicit mainModel → Task 2 Step 3b. spec §4.4 receipt → Task 3 Step 3. spec §4.5 Path B label → Task 4. spec §6 testing → each task's TDD step + Task 5 live. spec §7 risks (behavior equivalence, reuse-not-drift, Path B scope) → Task 2 alias + Task 3 reuse + Task 4 guard-preservation respectively.

**Placeholder scan:** Task 2 Step 1 and Task 4 Step 1 contain "investigate" notes — these are genuine unknowns (the manifest-model test pack fixture; the ctx shape for session mainModel) with concrete fallback procedures, not lazy TBDs. All code steps carry actual code.

**Type consistency:** `resolveModel(callerModel, envModel, manifestModel, piDefaultModel) → {model, source: ModelSource}` matches across Task 1 (definition), Task 2 (call site), Task 3 (CLI passes callerModel/envModel/piDefaultModel). `RunWorkflowScriptOptions.model` alias → `callerModel` documented. Receipt `model`/`modelSource` field names match Task 2 (return), Task 3 (render), Task 4 (Path B details — note Path B uses `modelSource:"session"` literal, not the engine `ModelSource` union; that's intentional, documented in Task 4).

**Scope:** single focused plan; Path B manager hook explicitly excluded (#630); thinking out of scope. No L2 scripts touched.
