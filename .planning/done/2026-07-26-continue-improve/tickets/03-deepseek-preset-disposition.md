---
type: grilling
status: closed
---

# 03 · DeepSeek preset disposition

## Question

The `deepseek-lmstudio` preset writes config with `deepseek/` provider ids, but the user's `~/.pi/agent/models.json` registers **only `lm-studio`**. Applying it produces config that cannot resolve — a footgun shipped in the preset system.

Disposition options:

- **(a) Remove it** — ship only `glm-lmstudio` until deepseek is actually configured. Simplest; the preset list stays honest.
- **(b) Keep + gate** — warn at apply-time if the preset's provider isn't in `models.json`. Best UX, but depends on the validation mechanism (ticket 04).
- **(c) Keep as experimental** — document the manual `/workflows-models` correction in the preset's summary/label, no enforcement.

## Context

- `presets.ts` comment already flags the deepseek ids as "best-guess template — provider may not be configured". That's a doc disclaimer, not enforcement.
- Option (b) only makes sense once 04 lands a models.json-reading validator; if 04 is deferred, (a) or (c) is the honest choice now.

## Acceptance

A decided disposition (remove / gate / keep-experimental) + the rationale, applied to `presets.ts` (and the gate if (b) once 04 enables it).

## Resolution (2026-07-26)

**Disposition: fix the ids + keep the preset.**

Verified against the catalog (`~/.pi/agent/models-store.json`): provider key `deepseek` holds exactly `deepseek-v4-flash` + `deepseek-v4-pro`. The preset's old ids (`deepseek-flash-v4` / `deepseek-pro`) were simply wrong — a typo shipped as data.

Why fix-and-keep over remove:
- The ids are a **factual bug**, not a design question — correct ids exist in the catalog.
- `deepseek` is a real catalog provider → the preset is a legitimate template for deepseek users (the package ships templates for common providers, not just the current user's active `zai/`).
- 04 (closed) already gates apply with `validateConfigSpecs` (catalog-validity, reject-hard) → fixed ids pass ✓.
- Runtime auth (deepseek API key) is explicitly **out of scope** per 04 (runtime's job); not unique to deepseek, not a reason to remove.

Applied to `presets.ts`: `deepseek-flash-v4`→`deepseek-v4-flash`, `deepseek-pro`→`deepseek-v4-pro` (both tier values + the summary string). The "best-guess template" comment is replaced with a catalog-verified note (ids verified against models-store; provider API key is a separate runtime concern). Test (`models-preset-command.test.ts`) updated to assert the corrected ids — this is the regression guard against re-typo.
