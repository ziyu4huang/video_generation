# Model Preset System — Design

Status: design approved (2026-08-16 — forced decision)  ·  Follow-on to the unify-subagent-model-config effort (Phase 1 config + Phase 2 runner migration).

## Problem

1. **file2md hardcodes model ids** — `DEFAULT_VLM_MODEL` (pipeline.ts:35) + `DEFAULT_MODEL` (sessions.ts:38) both bake in `"lm-studio/google/gemma-4-12b-qat"`. Violates the "no hardcoded model ids in code" principle (ids are env-specific). When config is unset, code silently uses the baked default instead of telling the user their config is incomplete.
2. **Setup is tedious** — writing `~/.pi/workflows/model-tiers.json` correctly (right tiers + the always-local vision) is hand-JSON-editing. Switching the text-LLM provider (e.g. glm → deepseek on token exhaustion) means re-editing multiple fields, and it's easy to forget that vision must stay lm-studio (glm/deepseek can't do vision).

## Solution

### A. Preset system (subagent extension) — the "unified suggest"

Named bundles of full `{tiers, capabilities}` config, applied via a new `/models-preset` command. **This is the ONE place specific model ids live** — as labeled templates (setup-time convenience), never as runtime defaults. Resolution code stays config-driven (env-agnostic).

**`presets.ts`** (subagent ext, new — pure DATA module):
- `glm-lmstudio`: tiers `{small: zai/glm-4.7, medium: zai/glm-5.2, big: zai/glm-5.2}` + capabilities `{vision: lm-studio/google/gemma-4-12b-qat}`.
- `deepseek-lmstudio`: tiers `{small: deepseek/deepseek-flash-v4, medium: deepseek/deepseek-pro, big: deepseek/deepseek-pro}` + capabilities `{vision: lm-studio/google/gemma-4-12b-qat}`.
  ⚠️ deepseek provider is NOT yet in the user's `~/.pi/agent/models.json` ("will use when tokens run out"). These ids are a **best-guess template** the user confirms/edits when they actually switch. The preset's job is to capture the *shape* (deepseek text + lm-studio vision); exact ids get corrected via `/workflows-models` after the provider is added.
- `custom`: not a preset entry — the absence of one. Edit JSON directly via `/workflows-models`.

**`/models-preset` command** (subagent ext, new — `extensions/models-preset.ts`):
- Registered via `pi.registerCommand("models-preset", {...})` — same API as `/workflows-models` (workflow ext) and `/subagents` (this ext).
- No args → list presets (name + one-line summary: which text-LLM + "vision: lm-studio") → pick one.
- On pick → write the full `{tiers, capabilities}` to `~/.pi/workflows/model-tiers.json` (back up the existing file first: `.bak`) → print confirmation.
- Interactive UX: numbered prompt (simplest; the menu-picker component from the picker effort isn't landed yet). Decided in plan.

### B. file2md — config-driven, no hardcodes

- Delete `DEFAULT_VLM_MODEL` (pipeline.ts:35) + `DEFAULT_MODEL` (sessions.ts:38).
- `resolveVisionLLM` (sessions.ts): `capabilities.vision` → (deprecated) env fallback → **throw a clear error** (no silent baked default). Error text: `vision model not configured — run /models-preset to apply a preset (glm-lmstudio, deepseek-lmstudio), or set capabilities.vision in ~/.pi/workflows/model-tiers.json`.
- `resolveLLM` (the base parser): when no env + no resolvable source → throw (don't bake in lm-studio). Callers that need a default must pass it explicitly.

### C. Unified "suggest" in resolver errors (subagent)

- `resolveTierModel` / `resolveModelRole` (model-role-config.ts) — existing "unknown tier" warning mentions `/workflows-models`; extend it to also mention `/models-preset` so a user with an empty/partial config is pointed at the easy path first.

## Why presets may contain ids (reconciling with "no hardcode")

The "no hardcoded model ids in code" principle targets the **resolution path** (resolveTierModel/resolveModelRole/vision-inference must read config, never bake ids). Presets are a different concern: they are **named config templates** a user explicitly *applies* (which writes to their personal config file). They are data, not runtime defaults, and applying one is a deliberate user action. This is the intended exception the user asked for ("preset base so we can choose different preset").

## Scope / YAGNI

- 2 presets now (glm-lmstudio, deepseek-lmstudio). Adding a provider = add one preset entry (data only).
- No preset versioning/migration (config is flat JSON; backup = `.bak` file).
- No auto-detect-and-prompt on missing config (explicit `/models-preset` only — less magic).
- `/workflows-models` (manual fine-editor) stays in the workflow ext unchanged; `/models-preset` (bulk apply) lives in subagent. They coexist.

## Verification

- `presets.ts`: unit test — each preset is a valid `ModelTierConfig` (tiers non-empty, all string values; capabilities.vision present).
- `/models-preset` apply: test — applying a preset writes the exact `{tiers, capabilities}` to a temp model-tiers.json + backs up the prior.
- file2md `resolveVisionLLM`: test — unset (no capabilities + no env) → throws with the `/models-preset` hint; set → resolves correctly. (Existing env-sensitive tests unchanged.)
- subagent: `bun run build` (tsc) + `bun test` + `bun run check` (biome) green.

## Open (for plan / later)

- `/models-preset` interactive UX: numbered prompt vs reuse menu-picker (picker not landed → numbered).
- deepseek exact ids: confirm when user adds the provider.
- 2026-08-16 approved with: /models-preset UX = numbered prompt (menu-picker not landed); deepseek ids confirmed/edited at provider-switch time via /workflows-models (best-guess template stays).
