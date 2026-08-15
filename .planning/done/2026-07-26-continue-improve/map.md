> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-26-continue-improve

## Destination

The unified model-config system is bulletproof: **no hardcoded model ids anywhere in code**, presets only produce **resolvable** config (validated against the user's `~/.pi/agent/models.json`), and **missing config guides the user** (via `/models-preset`) rather than throwing or silently falling back — all green on a clean CI. This is the "hardening pass" that the just-merged Phase 2 (PR #833: vision-via-spawnSubagent + presets) left half-done.

## Notes

- **Domain**: `pi-agent-ext-subagent` + `pi-agent-ext-file2md` model-config. The unified config is `~/.pi/workflows/model-tiers.json` (`{tiers, capabilities}`) + provider registry `~/.pi/agent/models.json`. Resolution lives in `subagent/src/model-role-config.ts` (leaf, no agent.js); file2md resolves vision via `sessions.ts` → `resolveVisionLLM` → that leaf.
- **Skills every session should consult**: `grilling` + `domain-modeling` for the decisions; `systematic-debugging` for the test-isolation work (ticket 05).
- **Standing preferences**:
  - **NO hardcoded model ids in CODE** (CONTEXT.md principle — ids are env-specific). Config files are the only place env-specific ids may live. `presets.ts` is the labeled-template exception (setup-time data, not runtime defaults).
  - Config-driven resolution; `loadModelTierConfig` reads disk fresh (no cache).
  - **CI is a clean environment** — no `~/.pi` config. Tests must NOT assume it; any test transitively running the real `resolveVisionLLM` must isolate config (mock / seed / env).
  - bun `mock.module` realm quirk: mocking `vision-inference` yields a SEPARATE `model-role-config` instance that can't see test-seeded config → mock `sessions.ts`'s `resolveVisionLLM` directly in those tests.

## Decisions so far

- [01 · Missing-config contract](tickets/01-missing-config-contract.md) — **throw** when neither config nor `PI_MODEL` env is set (actionable `/models-preset` pointer); env kept as a **permanent deprecated escape hatch**; resolver is **uniform / path-agnostic** (caller recovery out of scope). Unblocks 05; 06 mirrors at load-time.
- [02 · Repo-wide hardcode audit](tickets/02-repo-wide-hardcode-audit.md) — the model-config-system hardcodes are contained to the **file2md cluster** (pipeline.ts `DEFAULT_VLM_MODEL`, sessions.ts `DEFAULT_MODEL`, + 2 consumers); other packages carry independent default-model logic, ruled out of scope.
- [03 · DeepSeek preset disposition](tickets/03-deepseek-preset-disposition.md) — **fix the ids + keep**. Catalog-verified (provider `deepseek` holds `deepseek-v4-flash`/`deepseek-v4-pro`); the shipped ids (`deepseek-flash-v4`/`deepseek-pro`) were a plain typo. Fixed in `presets.ts` (2 tier values + summary + comment); 04's `validateConfigSpecs` gates apply (✓ catalog-valid); runtime auth stays out of scope.
- [04 · Preset validation design](tickets/04-preset-validation-design.md) — **file-level catalog validation** (read `models.json` ∪ `models-store.json`, provider+modelId granularity), **reject-hard** on apply + ✓/⚠ in picker; auth out of scope (runtime's job). New leaf helper `subagent/src/models-registry-reader.ts`, reused by 06. **Smoking gun: deepseek preset ids are wrong** (`deepseek-flash-v4`/`deepseek-pro` vs catalog `deepseek-v4-flash`/`deepseek-v4-pro`) → forces ticket 03.
- [05 · De-hardcode test-isolation pattern](tickets/05-dehardcode-test-isolation-pattern.md) — **re-landed**. `resolveLLM` throws (no `DEFAULT_MODEL`); `DEFAULT_VLM_MODEL` removed from pipeline.ts + both file2md.ts commands. Isolation: (a) `mock.module(sessions)` for the 4 mocked I/O tests, (c) `PI_MODEL` env for `misc.e2e`, + **`--isolate`** on file2md's runner (the new sessions mock would leak to the real-resolver tests otherwise; mirrors archify). All 3 packages green on clean CI.
- [06 · Config-load validation](tickets/06-config-load-validation.md) — `loadModelTierConfig` **stays pure** (hot path, no cache); validation reuses 04's `validateConfigSpecs` at **session_start warn-once** + `/workflows-models` ✓/⚠ display. Resolve untouched (01's domain; runtime catches residual). Warn-only at load; reject-hard stays /models-preset write-time.

**✅ All 6 tickets closed — destination reached.** The model-config system is bulletproof: no hardcoded model ids in code, presets only produce catalog-validated config (reject-hard at write, ✓/⚠ at load), missing config throws an actionable `/models-preset` pointer, and all packages are green on a clean (config-less) CI.

## Not yet specified

- **Preset auto-discovery** (generate presets FROM the catalog vs. hand-templates): **sharpened by 04** — the catalog source is now known (`models-store.json` keyed by provider). Sharp enough to ticket, but it's a feature enhancement beyond "hardening" — deferred unless the destination is redrawn.
- **`pi-agent-cli` sessions/shared.ts hardcoded `glm-5.2` fallback** (surfaced by audit 02): the CLI session layer's own fallback, outside `{tiers,capabilities}`. Open whether the unified config subsumes it or it stays independent CLI resolution.

## Out of scope

- **Other packages' independent default-model logic** (surfaced by audit 02): `pdf-to-vault.ts` own VLM default, `movie-director/lmstudio.ts` `resolveDefaultModel`, `knowledge-card` `DISTILL_MODEL_DEFAULT`. These are per-package defaults, not part of the unified `{tiers,capabilities}` system this map hardens. Each is a candidate for its own de-hardcode effort if pursued.
