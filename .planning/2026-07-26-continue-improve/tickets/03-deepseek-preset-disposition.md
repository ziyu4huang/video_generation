---
type: grilling
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
