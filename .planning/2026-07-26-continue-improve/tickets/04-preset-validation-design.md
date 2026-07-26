---
type: grilling
claimed: continue-improve (2026-07-26)
status: closed
---

# 04 · Preset validation design

## Question

Should `/models-preset` **validate** that a preset's model ids exist in `~/.pi/agent/models.json` before writing the config? Decide the design.

### Prerequisite research (do first — local, not web)

Inspect `~/.pi/agent/models.json`: what is its shape? Is it `{providers: {lm-studio: {...}}}` (keyed) or `[{name:"lm-studio",...}]` (list)? What field names a provider + its available model ids? Record the shape — every later validation/loading ticket (03 gate, 06) reuses this read.

### Design decisions

1. **Read mechanism**: a small helper (where? `subagent/src/` — candidate `models-registry-reader.ts`) that returns the set of known `{provider}` + `{provider}/{modelId}` from `models.json`.
2. **Severity**: **reject-hard** (refuse to write, show what's missing) vs. **warn-then-write** (tell the user, proceed) vs. **warn-only**. Reject-hard is safest; warn-then-write preserves "I know what I'm doing" flexibility.
3. **Granularity**: provider-present? or provider+modelId-present? (models.json may list a provider without enumerating every model id.)

## Context

- This unblocks the **gate** option of ticket 03 (deepseek) and the mechanism for ticket 06 (config-load validation).
- `models.json` is the provider registry; `model-tiers.json` is what presets write. Validation bridges them.

## Acceptance

A decided validation design: the read helper's home + signature, the severity (reject/warn), the granularity. Ready to implement as the shared validator both 03 (apply-time) and 06 (load-time) call.

## Resolution (2026-07-26)

Research settled the source + granularity; grill settled severity. **File-level catalog validation, provider+modelId, reject-hard.**

### Source — file readers (no runtime/auth dep)

Read + union two files:
- `~/.pi/agent/models.json` — local providers, shape `{ providers: { <name>: { ..., models: [{id}] } } }` (note the `providers` wrapper).
- `~/.pi/agent/models-store.json` — cloud catalog, shape `{ <name>: { models: [{id, name, ...}] } }` (NO wrapper). Contains `zai`, `deepseek`, `huggingface`, …

Union → `{ provider → Set<modelId> }`. **Auth (API key) is out of scope** — that's the runtime's job; resolve already errors `No API key for "X"` clearly. Validation only checks catalog validity.

### Granularity — provider + modelId

Parse each spec by **first slash**: `"lm-studio/google/gemma-4-12b-qat"` → provider=`lm-studio`, modelId=`google/gemma-4-12b-qat`. Match modelId against the provider's catalog `models[].id`. **Provider-only was rejected** — it would miss the wrong-id case (deepseek IS a known provider, but its preset ids are wrong; see smoking gun).

### Severity — reject-hard + picker status

- **Apply** (`/models-preset <id>` or picker choice): if ANY spec in the preset fails catalog validation, **refuse to write**. List each problem: `{spec} — {unknown-provider | unknown-model (did you mean …?)}`.
- **Picker** (`/models-preset` no arg): show **✓ / ⚠** next to each preset (validate before display) so problems are visible before choosing.

Rationale: a preset is a **curated template**; one with unresolvable specs is a bug in `presets.ts`, not a user choice to force-write.

### Helper home — new leaf module

`subagent/src/models-registry-reader.ts` — pure file I/O, **no agent.js** (mirrors `model-role-config.ts`'s leaf pattern). Exposes:
- `readKnownModels(agentDir?) → Map<provider, Set<modelId>>` (reads models.json + models-store.json)
- `validateConfigSpecs(config: ModelTierConfig, known?) → { valid: boolean; problems: {spec, provider, modelId, issue}[] }`

Reused by **06** (config-load validation) — single source of truth for "is this spec catalog-known".

### Smoking gun (also feeds ticket 03)

The **deepseek preset's ids are wrong** — `deepseek-flash-v4` / `deepseek-pro` vs the catalog's `deepseek-v4-flash` / `deepseek-v4-pro`. reject-hard validation would flag this on apply/picker → **ticket 03 must resolve** (fix the ids, or remove the preset) for the preset list to ship clean. glm-lmstudio ids are valid (glm-4.7 / glm-5.2 ✓).
