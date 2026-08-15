# Model Preset System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land spec A+B+C — named `{tiers, capabilities}` presets applied via `/models-preset`, file2md fully de-hardcoded (resolvers throw actionable errors), and every config-gap warning/ error suggesting `/models-preset`.

**Architecture:** Preset templates are pure data in `pi-agent-ext-subagent/src/presets.ts`; the `/models-preset` command (`extensions/models-preset.ts`) applies one to `~/.pi/workflows/model-tiers.json` with a `.bak` backup; resolution code (`pi-agent-ext-core-runtime/src/model-role-config.ts`, `pi-agent-ext-file2md/src/sessions.ts`) stays config-driven and never bakes model ids.

**Tech Stack:** Bun workspaces (`bun-apps/`), TypeScript (`bunx tsc`), Biome, `@earendil-works/pi-coding-agent` ExtensionAPI.

## ⚠️ CRITICAL CONTEXT — the core already landed on main (verify-reconcile plan, NOT from-scratch)

Audit of `/Users/huangziyu/proj/video_generation` @ `main` found the bulk of this spec **already implemented and merged**:

- `b74d8634` (2026-07-26) — "feat(subagent,file2md): Phase 2 vision-via-spawnSubagent + **/models-preset + de-hardcode** (#833)"
- `2c4172a9` (2026-07-26) — "fix(subagent): correct deepseek preset model ids (#842)"
- `5cac87fc` (2026-08-15) — "fix(subagent): glm-lmstudio preset tiers glm-5.2 → glm-5.3 (#1383)"
- `0d25d073` (2026-08-16) — "feat(subagent): split deepseek-lmstudio preset into deepseek-pro and deepseek-flash (#1456)"

The spec was approved **after** the code landed (spec approved 2026-08-16; code from 2026-07-26). Therefore this plan's tasks are **verify-or-implement**: each task verifies the landed artifact against the spec decision, and only edits code where a genuine gap or drift is confirmed. Do NOT re-implement from scratch — that would duplicate/conflict with merged code.

Known deltas between spec (as written) and landed code — resolved by this plan's Decision Rule (Task 1):

| Item | Spec says | main has | Resolution |
|---|---|---|---|
| Preset count | 2 (`glm-lmstudio`, `deepseek-lmstudio`) | 3 (`glm-lmstudio`, `deepseek-pro`, `deepseek-flash`) | **Keep main's 3** (strict superset, real follow-up commits; spec text is stale) |
| glm ids | `zai/glm-5.2` | `zai/glm-5.3` | **Keep main** (`5cac87fc` deliberately bumped) |
| deepseek ids | `deepseek/deepseek-flash-v4`, `deepseek/deepseek-pro` | `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro` | **Keep main** (`2c4172a9` corrected ids) |
| vision id | `lm-studio/google/gemma-4-12b-qat` | `lm-studio/google/gemma-4-12b` | **Keep main** (`6ce3d171` moved local LM Studio to `google/gemma-4-12b`) |
| `/models-preset` UX | numbered prompt | `ctx.ui.select` picker | **Keep main** (strictly better; menu-picker concern moot) |
| C: "unknown tier" warning mentions `/models-preset` | required | **unverified — likely the only real gap** | Task 5 locates + (if missing) extends it |

## Global Constraints

- Worktree: `/Users/huangziyu/proj/video_generation` (on `main`). NEVER touch `/Users/huangziyu/proj/video_generation__memory`.
- All written artifacts (code, comments, commits, docs) in English.
- Resolution path (`resolveTierModel` / `resolveModelRole` / `resolveVisionLLM` / `resolveLLM`) must never bake model ids; ids live ONLY in `src/presets.ts` templates and the user's `~/.pi/workflows/model-tiers.json`.
- One registration point per extension: subagent ext is registered via `pi-agent/src/static-extensions.ts` (`extensions/subagent.ts` entry); it must NOT also appear in `run-dir/manifest.json` `extensions[]` (double-register bug).
- No top-level `cd` (repo guard blocks it) — use `( cd <dir> && … )`, `--cwd`, `git -C`.
- Per-package canonical scripts only: subagent `bun run test` = `check (biome) && build (tsc) && test:unit`; also run `bun run typecheck`.
- Local CI only; squash-merge via `gh ship`; never wait for remote GitHub Actions (CI disabled by design in this repo).

---

### Task 1: Baseline audit — confirm landed state + registration singularity

**Files:**
- Modify: none (read-only audit; findings recorded in the PR description)

**Interfaces:**
- Consumes: spec decisions A/B/C.
- Produces: verified ground truth (file paths, registration wiring, warning location) that Tasks 2–5 branch on.

- [x] **Step 1: Run the audit commands** (from repo root; all read-only)

```bash
git -C /Users/huangziyu/proj/video_generation log --oneline -6 -- bun-apps/pi-agent-ext-subagent/src/presets.ts
grep -rn "DEFAULT_VLM_MODEL\|DEFAULT_MODEL" /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-file2md/src/ ; echo "exit=$?"   # expect exit=1 (no matches)
grep -n "models-preset" /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-subagent/extensions/subagent.ts   # expect registerModelsPresetCommand call
grep -n "pi-agent-ext-subagent" /Users/huangziyu/proj/video_generation/bun-apps/pi-agent/run-dir/manifest.json           # inspect WHICH array it is in
grep -rn "workflows-models" /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-workflow/src/ | grep -i "warn\|unknown\|not configured"
grep -rn "unknown tier\|Unknown tier" /Users/huangziyu/proj/video_generation/bun-apps --include='*.ts' | grep -v dist/ | grep -v node_modules
```

- [x] **Step 2: Apply the Decision Rule and record results**

Expected outcomes: (a) both `DEFAULT_*` constants gone (exit=1 from grep); (b) `extensions/subagent.ts` registers the command; (c) if `manifest.json` lists `pi-agent-ext-subagent` inside `extensions[]` while `static-extensions.ts` also loads it → that is a double-registration bug: remove the manifest entry (keep static), else leave as-is (it may sit in a non-`extensions[]` array such as a packages list — check the surrounding JSON key); (d) capture the exact file:line of the "unknown tier" warning for Task 5. Write findings into the eventual PR body.

- [x] **Step 3: Verify**

Run: the Step-1 block once more after any Task-1 fix.
Expected: all greps return the expected outcomes; no code deltas beyond (c).

- [x] **Step 4: Commit (only if Step 2c produced a manifest fix)**

```bash
git -C /Users/huangziyu/proj/video_generation add bun-apps/pi-agent/run-dir/manifest.json
git -C /Users/huangziyu/proj/video_generation commit -m "fix(pi-agent): remove duplicate subagent manifest registration (static-extensions owns it)"
```

### Task 2: presets.ts — verify template data (spec A)

**Files:**
- Verify: `bun-apps/pi-agent-ext-subagent/src/presets.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/` (preset-validity test; see Task 6)

**Interfaces:**
- Consumes: `ModelTierConfig` from `@repo/pi-agent-ext-core-runtime` (`{ tiers: Record<string,string>; capabilities?: Record<string,string> }`).
- Produces: `MODEL_PRESETS: ModelPreset[]`, `findPreset(id: string): ModelPreset | undefined`, `interface ModelPreset { id; label; summary; config: ModelTierConfig }`.

- [x] **Step 1: Verify the landed content matches the reconciled Decision Rule table** (3 presets, glm-5.3, deepseek-v4-*, `lm-studio/google/gemma-4-12b` vision). The landed file is the source of truth; expect exactly:

```ts
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "glm-lmstudio",
    label: "GLM (official) + LM Studio vision",
    summary: "tiers: glm-4.7 / glm-5.3  ·  vision: lm-studio gemma-4-12b",
    config: {
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    },
  },
  {
    id: "deepseek-pro",
    label: "DeepSeek pro (official) + LM Studio vision",
    summary: "tiers: gemma-4-12b / flash / pro  ·  vision: lm-studio gemma-4-12b",
    config: {
      tiers: {
        small: "lm-studio/google/gemma-4-12b",
        medium: "deepseek/deepseek-v4-flash",
        big: "deepseek/deepseek-v4-pro",
      },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    },
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek flash (official) + LM Studio vision",
    summary: "tiers: gemma-4-12b / gemma-4-12b / flash  ·  vision: lm-studio gemma-4-12b",
    config: {
      tiers: {
        small: "lm-studio/google/gemma-4-12b",
        medium: "lm-studio/google/gemma-4-12b",
        big: "deepseek/deepseek-v4-flash",
      },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    },
  },
];
export function findPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}
```

If (and only if) the audit finds the file reverted/missing, restore it verbatim from commit `0d25d073` (`git show 0d25d073:bun-apps/pi-agent-ext-subagent/src/presets.ts`).

- [x] **Step 2: Verify**

```bash
( cd /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-subagent && bun run typecheck )
```
Expected: exit 0.

### Task 3: `/models-preset` command — verify apply + `.bak` + single registration (spec A)

**Files:**
- Verify: `bun-apps/pi-agent-ext-subagent/extensions/models-preset.ts`, `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/models-preset-command.test.ts` (exists on main)

**Interfaces:**
- Consumes: `MODEL_PRESETS` / `findPreset` (Task 2); `getModelTierConfigPath`, `loadModelTierConfig`, `saveModelTierConfig` from `@repo/pi-agent-ext-core-runtime`; `ExtensionAPI.registerCommand`, `ExtensionCommandContext` (`ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.notify`).
- Produces: `createModelsPresetCommand(deps?: PresetCommandDeps)` + `registerModelsPresetCommand(pi: ExtensionAPI)`; `PresetCommandDeps = { getConfigPath?; loadConfig?; saveConfig? }` (DI keeps it testable without `mock.module`).

- [x] **Step 1: Verify the landed behavior contract** (read the file; every bullet must hold):
  - `/models-preset <id>` → direct apply of `findPreset(id)`; unknown id → error notify listing available ids.
  - No args → `ctx.ui.select` picker over `MODEL_PRESETS` (`id  —  summary`).
  - Before overwrite: `renameSync(configPath, configPath + ".bak")` (best-effort), then `saveConfig(preset.config)`.
  - Confirmation via `ctx.ui.confirm` when replacing an existing config.
  - DI defaults hit the real `getModelTierConfigPath` → `~/.pi/workflows/model-tiers.json`.

- [x] **Step 2: Verify registration is exactly once**

`extensions/subagent.ts` calls `registerModelsPresetCommand(pi)`; `run-dir/manifest.json` `extensions[]` does NOT also list the subagent ext (Task 1 Step 2c outcome). Command id string is exactly `"models-preset"`.

- [x] **Step 3: Verify**

```bash
( cd /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-subagent && bun run test )
```
Expected: biome clean, tsc build clean, unit tests incl. `tests/models-preset-command.test.ts` PASS.

### Task 4: file2md de-hardcode — verify throw-with-hint (spec B)

**Files:**
- Verify: `bun-apps/pi-agent-ext-file2md/src/sessions.ts` (`resolveLLM`, `resolveVisionLLM`), `bun-apps/pi-agent-ext-file2md/src/pipeline.ts`

**Interfaces:**
- Consumes: `resolveModelRole({ capability: "vision" }, loadModelTierConfig())` from core-runtime.
- Produces: `resolveLLM(opts: { provider?; model?; thinking? }): ResolvedLLM` (throws when unset); `resolveVisionLLM(opts = {}): ResolvedLLM`; `ResolvedLLM = { provider: string; modelId: string; thinkingLevel: ThinkingLevel }`.

- [x] **Step 1: Verify no baked constants + exact error text**

```bash
grep -rn "DEFAULT_VLM_MODEL\|DEFAULT_MODEL" /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-file2md/src/   # must output NOTHING
grep -n "models-preset" /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-file2md/src/sessions.ts                # must hit the throw + the env-deprecation warn
```

Expected `resolveLLM` throw (verbatim contract — keep if present, restore if drifted):
```ts
throw new Error(
  "[file2md] No model configured. Set model config via `/models-preset` (or `/workflows-models`), or export PI_MODEL as a temporary escape hatch.",
);
```
Expected `resolveVisionLLM` shape: explicit `opts.model` → `resolveLLM(opts)`; else `resolveModelRole({ capability: "vision" }, loadModelTierConfig())` → spec; else fall through to `resolveLLM(opts)` (env escape hatch, deprecated warn, else throw).

- [x] **Step 2: Verify**

```bash
( cd /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-file2md && bun run typecheck && bun test )
```
Expected: PASS (this is likely the ONLY gap if the throw text lacks `/models-preset` — then edit `src/sessions.ts` to the exact string above and re-run).

### Task 5: Resolver "unknown tier" warning → suggest `/models-preset` (spec C — the expected real change)

**Files:**
- Modify: the file Task 1 Step 2(d) located (candidate surfaces: `bun-apps/pi-agent-ext-workflow/src/workflows-models-command.ts` or its siblings; `bun-apps/pi-agent-ext-core-runtime/src/agent.ts`; CLI-side tier resolution under `bun-apps/pi-agent/src/`)
- Test: co-located test file of the modified module (e.g. `bun-apps/pi-agent-ext-workflow/tests/workflows-models-command.test.ts`)

**Interfaces:**
- Consumes: located warning string (currently mentions `/workflows-models` only).
- Produces: same warning + the literal suffix ` — or apply a preset via /models-preset`.

- [x] **Step 1: Write the failing test** (add to the module's existing test file; adapt the import to the located module)

```ts
it("unknown-tier warning suggests /workflows-models AND /models-preset", () => {
  // Call the located warning-producing function with a config that lacks the tier,
  // capture the emitted warning (spy on console.warn / logger used there).
  const captured: string[] = [];
  const warnSpy = jest.spyOn(console, "warn").mockImplementation((m?: unknown) => { captured.push(String(m)); });
  try {
    resolveWithUnknownTier({ tiers: {} }, "big"); // = located function, unknown tier
    expect(captured.join("\n")).toContain("/workflows-models");
    expect(captured.join("\n")).toContain("/models-preset");
  } finally {
    warnSpy.mockRestore();
  }
});
```
(If the package uses `bun:test`, swap `jest.spyOn` for `spyOn` from `"bun:test"`.)

- [x] **Step 2: Run it and verify it FAILS**

```bash
( cd /Users/huangziyu/proj/video_generation/bun-apps/<located-pkg> && bun test )
```
Expected: FAIL — warning mentions `/workflows-models` but not `/models-preset`. (If it PASSES, spec C is already satisfied: mark verify-only, skip Steps 3–4.)

- [x] **Step 3: Minimal implementation — append the hint**

In the located warning template string, directly after the `/workflows-models` mention, append:
```
 — or apply a preset via /models-preset
```
Example shape (adapt to the real string, do not change anything else):
```ts
// before
console.warn(`[tiers] unknown tier "${tier}" — configure it via /workflows-models`);
// after
console.warn(`[tiers] unknown tier "${tier}" — configure it via /workflows-models — or apply a preset via /models-preset`);
```

- [x] **Step 4: Verify + commit**

```bash
( cd /Users/huangziyu/proj/video_generation/bun-apps/<located-pkg> && bun run typecheck && bun test )
git -C /Users/huangziyu/proj/video_generation add -A bun-apps/<located-pkg>
git -C /Users/huangziyu/proj/video_generation commit -m "feat(<pkg>): unknown-tier warning also suggests /models-preset"
```
Expected: tests PASS including the new assertion.

### Task 6: Cross-package test gates (spec Verification section)

**Files:**
- Verify: `bun-apps/pi-agent-ext-subagent/tests/models-preset-command.test.ts`, preset-validity coverage, `bun-apps/pi-agent-ext-file2md` resolver-throw coverage
- Create (only if missing): `bun-apps/pi-agent-ext-subagent/tests/presets.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 artifacts.
- Produces: green canonical gates.

- [x] **Step 1: Ensure preset-validity test exists; if absent create it with exactly:**

```ts
import { describe, expect, it } from "bun:test";
import { MODEL_PRESETS } from "../src/presets.js";

describe("MODEL_PRESETS", () => {
  it("every preset is a valid ModelTierConfig with local vision", () => {
    for (const p of MODEL_PRESETS) {
      expect(Object.keys(p.config.tiers).length).toBeGreaterThan(0);
      for (const v of Object.values(p.config.tiers)) expect(typeof v).toBe("string");
      expect(p.config.capabilities?.vision).toMatch(/^lm-studio\//);
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
```

- [x] **Step 2: Run the full gate set (canonical scripts, in order)**

```bash
( cd /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-subagent    && bun run typecheck && bun run test )
( cd /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-core-runtime && bun run typecheck && bun test )
( cd /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-file2md      && bun run typecheck && bun test )
( cd /Users/huangziyu/proj/video_generation/bun-apps/pi-agent-ext-workflow     && bun run typecheck && bun run test )
```
Expected: all PASS. (Subagent `test` = biome + tsc build + unit; workflow `test` script may include build — run it whole, never a hand-assembled subset.)

- [x] **Step 3: Commit (if Step 1 created a test file)**

```bash
git -C /Users/huangziyu/proj/video_generation add bun-apps/pi-agent-ext-subagent/tests/presets.test.ts
git -C /Users/huangziyu/proj/video_generation commit -m "test(subagent): preset validity — tiers non-empty, vision always lm-studio"
```

### Task 7: Ship

- [x] **Step 1: Branch + PR (devops skill chain: `prepare_branch`; CLI fallback `bun-apps/pi-agent-ext-devops/src/prepare-cli.ts`)**

```bash
git -C /Users/huangziyu/proj/video_generation checkout -b feat/model-preset-closeout
# … Tasks 1–6 edits/commits …
git -C /Users/huangziyu/proj/video_generation push -u origin feat/model-preset-closeout
gh pr create --title "feat: model preset system closeout — /models-preset hints + spec reconciliation" --body "Audit + gaps per .planning/2026-07-26-model-preset-system/plan.md"
```

- [x] **Step 2: Local CI on changed packages (Task 6 Step 2 set) → green = merge immediately**

```bash
gh ship   # = gh pr merge --squash — NEVER --auto, never wait for remote CI
```

- [x] **Step 3: Verify merge scope + sweep** (`verify-merge-cli.ts`, `sweep-cli.ts` from the devops package).

---

## Risks / Open items

1. **Implementation precedes approval (biggest anomaly):** core A+B landed 2026-07-26 (#833) while the spec was force-approved 2026-08-16 (#1457). This plan therefore verifies/reconciles instead of building anew; executors must NOT re-implement landed pieces.
2. **Spec-vs-main id drift is intentional on main** (glm-5.3 via #1383, deepseek-v4-* + 3 presets via #842/#1456, `gemma-4-12b` sans `-qat` via #1364). Decision Rule: main wins; spec text is stale. If the owner wants spec-literal ids instead, that is a NEW decision → reopen the spec, don't edit silently.
3. **deepseek provider not yet in `~/.pi/agent/models.json`** — preset ids remain a best-guess template; the user confirms/edits exact ids at provider-switch time via `/workflows-models` (spec's baked decision). Apply-time validation (`validateConfigSpecs` gating in the models-registry reader) will reject apply if ids aren't in the catalog — expected behavior, not a bug.
4. **"Unknown tier" warning location unresolved at plan time** (grep in core-runtime/workflow/subagent sources found no such string; likely surfaced via `sortedTierNames` callers, the workflow command, or agent.ts fallback paths). Task 1 Step 2(d) locates it; Task 5 is designed verify-first so a pre-satisfied hint is a no-op.
5. **Manifest double-registration risk:** `run-dir/manifest.json` mentions `pi-agent-ext-subagent` (line ~74) while `static-extensions.ts` statically loads it. If the manifest occurrence is inside `extensions[]`, that is a live double-register bug → Task 1 fixes; if it's another array (e.g. packages list), leave it.
6. **UX superset:** spec demanded a numbered prompt; landed code uses `ctx.ui.select` (menu picker). Treated as satisfying the decision (picker ⊇ numbered prompt); flagging in case the owner wanted the literal numbered flow.
7. **Worktree is behind `origin/main` by 2 commits** at plan time — shipper must `sync_repo`/rebase before branching.
8. No preset versioning/migration, no auto-detect-and-prompt (spec YAGNI decisions) — do not add them.

## Execution record (2026-08-16)

Executed as verify-reconcile: T1–T6 all verify-only no-ops — implementation already on main since #833 (+ #842/#1383/#1456). T1 registration singular (staticExtensions[], no double-register). T2 3 presets on main (glm-lmstudio, deepseek-pro, deepseek-flash — Decision Rule: main wins). T3 command contract verified (picker UX ⊇ numbered prompt; .bak; confirm-on-existing). T4 file2md throw text already mentions /models-preset (sessions.ts:34-36). T5 no-op — hint already present in agent.ts:190 warning (#833 itself); plan's assumption wrong in the best way. T6 gates green (core-runtime 199/0 + biome-clean new test; workflow 1078/0). Out-of-plan hardening: tests/agent-model-spec.test.ts pins the /models-preset hint (substring). T7 = this closing PR.
