---
type: research
status: closed
---

# 02 · Repo-wide hardcode audit

## Question

Beyond file2md's `DEFAULT_MODEL` (`sessions.ts`), are there **other hardcoded model ids** in the repo's package code? Produce an exhaustive list so the de-hardcode landing (ticket 05) knows its full scope.

## Method (AFK — no human needed)

Grep `bun-apps/*/src` + `bun-apps/*/extensions` for literal provider/modelId strings, e.g.:

- `"zai/`, `"lm-studio/`, `"deepseek/`, `"google/gemma`, `gemma-4-12b`, `glm-4.7`, `glm-5.2`, `deepseek-pro`
- any `DEFAULT_*_MODEL` constant

**Exclude** (legitimate / out of scope):

- `subagent/src/presets.ts` — intentional labeled templates (the one sanctioned place).
- config files (`~/.pi/**`, `*.json` model-tiers), tests (`__tests__/`, `*.test.ts`, `tests/`), `.planning/`, docs.

For each hit: `file:line` + the literal string + a classification:

- **legit template** (presets) — keep.
- **should-be-config** (runtime default baked in code) — candidate for de-hardcode.
- **test fixture** — keep (but note if it leaks into non-test code).

## Output

Append the list + classification as the resolution. This scopes 05: if ONLY `file2md/sessions.ts DEFAULT_MODEL` exists, 05 is small; if more surface, 05 grows or spawns follow-ups.

## Resolution

Audit run 2026-07-26 (grep `bun-apps/*/src` + `bun-apps/*/extensions`, excluding tests + `presets.ts`). Findings by classification:

### In-scope runtime defaults (the `{tiers,capabilities}` resolution path — what ticket 05 de-hardcodes)

| File:line | Literal | Role |
|---|---|---|
| `file2md/src/pipeline.ts:35` | `DEFAULT_VLM_MODEL = "lm-studio/google/gemma-4-12b-qat"` | exported, consumed by the file2md command + extension |
| `file2md/src/sessions.ts:38` | `DEFAULT_MODEL = "lm-studio/google/gemma-4-12b-qat"` | the `resolveLLM` ultimate fallback (core resolution path) |
| `file2md/extensions/file2md.ts:180` | uses `DEFAULT_VLM_MODEL` | consumer |
| `pi-agent-cli/src/commands/file2md.ts:66` | uses `DEFAULT_VLM_MODEL` | consumer (CLI wrapper) |

→ **05's scope is the file2md cluster above (4 sites, 3 files).** No scope expansion within the model-config system.

### Out of scope — independent default-model logic (NOT part of `{tiers,capabilities}`)

- `pi-agent-cli/src/commands/pdf-to-vault.ts:52` — `pdf-to-vault` is a **separate** pipeline with its own VLM default; not the file2md/model-tiers path.
- `movie-director/src/lmstudio.ts:78-79` — movie-director's own `resolveDefaultModel` (`PREFERRED_MODELS` + `DEFAULT_MODEL`); local LM-Studio selection, independent.
- `knowledge-card/extensions/knowledge-card.ts:144` — `DISTILL_MODEL_DEFAULT`; knowledge-card's own distill-subagent default.

### Legit catalog/template data (keep)

- `presets.ts` — the sanctioned template location (excluded by design).
- `pi-agent/src/pre-load-providers.ts:78-94` — provider **registry seeding** (declares available models: catalog data, not a runtime default).
- `flux2/src/vlm.ts:50` — flux2's known-VLM **catalog entry**.

### Test fixtures (keep; noted for completeness)

All `*.test.ts` / `__tests__/` hits (dispatch, pdf-to-vault, shared, resolve, caption, lmstudio, subagent-args, e2e-* etc.) — env-fallback or assertion literals, not runtime.

### Fog surfaced (→ Not yet specified)

- `pi-agent-cli/src/sessions/shared.ts:65` hardcodes `modelId: "glm-5.2"` — `resolve.test.ts:51` calls it "the hardcoded FALLBACK target (zai/glm-5.2)". This is the **CLI session layer's** own fallback, not the `{tiers,capabilities}` system. Open: does the unified config subsume it, or is it independent CLI resolution? Logged as fog.

**Verdict**: the model-config-system de-hardcode (ticket 05) is contained to the file2md cluster. The other packages carry their own independent default-model logic — ruled out of scope for this map (see map **Out of scope**).
