# workflow-pack default model — explicit pi-default inheritance (design)

**Date:** 2026-07-18
**Branch (next):** off `origin/main` (post PR #631)
**Owner:** Ziyu Huang

## 1. Goal

Make workflow-pack's model resolution **explicit and guaranteed** instead of
implicit. Today, when no `--model` and no `manifest.model` is supplied, the
engine passes `mainModel: undefined` to `runWorkflow`, and a correct run depends
on `createAgentSession` silently falling back to pi's settings default
(`agent.ts:425-428` even warns this fallback can produce "silent empty
responses" if the real `SettingsManager` is not wired). This works today but is
fragile and invisible — the run receipt shows `agents=1` with no indication of
which model was used or where it came from.

This change makes the pi default an **explicit, resolved input** and surfaces the
resolved model + its source in every receipt, on both entry paths.

## 2. Scope

- **Model id only.** Thinking level is out of scope (stays as-is; the deferred
  `manifest.thinking` / `defaultThinkingLevel` question remains tracked in
  issue #630 / docket D3-1).
- **Both paths** (Path A CLI `workflow run`, Path B interactive `workflow` tool)
  — with the documented Path B limitation below.
- **Surface:** `pi-agent-ext-workflow/src/workflow-pack.ts` (engine resolver +
  `runWorkflowScript` receipt), `pi-agent-cli/src/commands/workflow.ts` (CLI
  receipt + pi-default computation), `pi-agent-ext-workflow/src/workflow-tool.ts`
  (Path B result label). Plus tests.

## 3. Precedence (the contract)

```
--model (flag)  >  PI_MODEL (env)  >  manifest.model (pack)  >  pi default (settings/fallback)
```

- `--model` flag and `PI_MODEL` env are **caller overrides** (same tier family,
  flag wins over env because the flag is the more deliberate act; both sit
  above the pack default).
- `manifest.model` is the **pack default** — it overrides the global pi default
  for that pack but is overridden by any caller override. (This is Path A's
  current behavior, now made explicit. Confirmed by the user.)
- **pi default** = the model `pi-agent.sh`'s session uses: resolved from
  `~/.pi/agent/settings.json` (`defaultProvider` + `defaultModel`), falling back
  to the hardcoded `zai/glm-5.2`. This is the SAME source `pi-agent.sh` uses, so
  "workflow-pack default == pi-agent.sh default" holds by construction.

When all four are absent the resolver returns `{model: undefined, source:"none"}`
and the engine still hands `undefined` to `createAgentSession` (the original
last-resort fallback). This only happens when settings has no default AND no
override is given — i.e. never on a normally-configured machine.

## 4. Components

### 4.1 `resolveModel` — pure resolver (engine, `workflow-pack.ts`)

```ts
export type ModelSource = "--model" | "env" | "manifest" | "pi-default" | "none";

export function resolveModel(
  callerModel: string | undefined,    // the --model flag value (already provider/id-composed)
  envModel: string | undefined,       // process.env.PI_MODEL
  manifestModel: string | undefined,  // pack manifest.model
  piDefaultModel: string | undefined, // resolved pi default (provider/id), from the CLI
): { model: string | undefined; source: ModelSource };
```

Pure + injectable: every branch is unit-tested with no disk/LLM. Returns the
winning model plus which tier supplied it. Replaces the current
`resolvePackOverrides` model line (`caller.model ?? pack?.manifest.model`) which
silently dropped both env and pi-default tiers and returned no source.

### 4.2 `piDefaultModel` — computed in the CLI, passed to the engine

The engine stays free of settings-reading. The CLI computes the pi default using
the **existing** resolution machinery in `pi-agent-cli/src/sessions/shared.ts`
(`resolveLLM`) + the settings read already used by `sessions/passthrough.ts`
(`defaultProvider`/`defaultModel`):

```ts
// userDefaults = the {defaultProvider, defaultModel} passthrough.ts already
// reads from ~/.pi/agent/settings.json — reuse that exact read, do not add a
// second settings reader.
const piDefault = resolveLLM({ userDefaults });
const piDefaultModel = `${piDefault.provider}/${piDefault.modelId}`; // e.g. "zai/glm-5.2"
```

This reuses `pi-agent.sh`'s exact default path (no new settings reader). The CLI
passes `piDefaultModel` (plus `callerModel` from `buildMainSpec(parsed)` and
`envModel` from `process.env.PI_MODEL`) into `runWorkflowScript`.

### 4.3 `runWorkflowScript` integration (engine)

- Calls `resolveModel(callerModel, envModel, resolved.pack?.manifest.model,
  opts.piDefaultModel)` to get `{model, source}`.
- Passes `model` as `mainModel` to `runWorkflow` **explicitly** (instead of
  `undefined`). This removes the implicit `createAgentSession` fallback for the
  no-override case — the model is now always a resolved value, eliminating the
  `agent.ts:425-428` silent-empty risk.
- Returns `model` + `modelSource` in the receipt object.

### 4.4 CLI receipt (`commands/workflow.ts`)

- Text one-liner gains the model + source:
  `✓ echo — agents=1 1178ms (model: zai/glm-5.2 [pi-default]) (source: path) → object {…}`
- `--json` gains two fields: `"model": "zai/glm-5.2"`, `"modelSource": "pi-default"`.
- Dry-run shows them too (resolution happens before the agent runs).

### 4.5 Path B result label (`workflow-tool.ts`)

Path B's model is the session `mainModel` (already = pi default; correct). This
change only **labels** it:
- The tool's result `details` gains `model` + `modelSource: "session"`.
- `manifest.model` is **still NOT applied** on Path B (the Task-2 guard stays) —
  the manager has no per-run model hook; applying it would mutate shared session
  state. Documented in the result + carry-over note: "Path B manifest.model
  requires an `ExecOptions.mainModel` hook — separate work, see #630."

## 5. Data flow (Path A)

```
CLI: parsed.model ──► buildMainSpec ──► callerModel
     process.env.PI_MODEL ─────────────► envModel
     resolveLLM({userDefaults}) ────────► piDefaultModel  ("zai/glm-5.2")
                              │
            runWorkflowScript({callerModel, envModel, piDefaultModel, …})
                              │
     resolveModel(caller, env, manifest.model, piDefault) ──► {model, source}
                              │
     runWorkflow({ mainModel: model })   ◄── explicit, no implicit fallback
                              │
     receipt {model, modelSource} ──► CLI text + --json
```

## 6. Testing

- `resolveModel` (pure): one guard per branch — caller wins, env wins (no
  caller), manifest wins (no caller/env), pi-default wins (no caller/env/manifest),
  none (all undefined → `{undefined,"none"}`).
- Engine `runWorkflowScript` (stub agent, injectable `piDefaultModel`): receipt
  carries `model`+`modelSource`; with no overrides `source === "pi-default"` and
  `mainModel` passed to `runWorkflow` equals the pi default (not undefined).
- CLI `workflow-command.test.ts`: receipt text contains `model: … [pi-default]`;
  `--json` has `model`/`modelSource`. Reuse the Batch-D2 passthrough-mock pattern.
- Path B `workflow-tool-pack.test.ts`: result `details` has
  `model`+`modelSource:"session"`; the existing Task-2 "no manifest.model on
  Path B" guard still passes.
- Live verification (manual, not automated): from `/tmp`, `workflow run
  <echo-pack>` with and without `--model` — receipt shows the resolved model and
  source for both; matches the model an equivalent `pi-agent.sh -p` session uses.

## 7. Risks & controls

- **Behavior equivalence:** swapping `mainModel: undefined` (implicit fallback)
  for explicit `mainModel: "zai/glm-5.2"` should be equivalent (same model) but
  more robust. Controlled by the live with/without-`--model` comparison +
  receipt assertion that `mainModel` is now the resolved value, not undefined.
- **`resolveLLM` reuse vs drift:** the pi default must come from the SAME path
  `pi-agent.sh` uses. Reusing `sessions/shared.ts resolveLLM` + the passthrough
  settings read guarantees this; do not introduce a second settings reader.
- **Path B scope discipline:** do NOT touch the manager API or the Task-2 guard
  in this change. Path B's manifest.model application is explicitly deferred
  (needs `ExecOptions.mainModel` hook, tracked in #630).
- **`PI_MODEL` tier placement:** env sits with caller overrides (above manifest).
  Confirmed by the user. If a future caller expects env to be a "default,"
  revisit — but matching `resolveLLM`'s existing semantics is least surprising.

## 8. Out of scope

- Thinking-level inheritance / `manifest.thinking` (D3-1, #630).
- Path B per-run model / `manifest.model` application (needs manager hook, #630).
- Surfacing thinking level in the receipt.
