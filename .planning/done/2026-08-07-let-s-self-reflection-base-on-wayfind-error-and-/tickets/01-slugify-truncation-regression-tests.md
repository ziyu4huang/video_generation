---
type: task
blocking: []
status: closed
---

## Question
Slugify truncation can cut mid-word or leave a stray trailing dash (e.g. `...-prevous-wayfind-`) — failure memory #444. A fix landed (5f78023b) but the hardening audit found **no truncation regression tests**, so the correct behavior is not structurally enforced. Add coverage and fix the implementation if the bug persists.

## What to build
- In `bun-apps/pi-agent-ext-wayfind`, add regression tests for the slug/truncation helper (`src/wayfinder.ts` ~`:22-30`):
  - word-boundary truncation at/near the 48-char limit (slice at the last `-` at or before 48, not mid-word);
  - re-trim of leading/trailing dashes **after** the slice (no stray trailing `-`);
  - the `...-prevous-wayfind-`-style regression case;
  - short names pass through unchanged.
- If any case fails RED, fix the implementation (do not weaken the tests).

## Acceptance
- Truncation regression tests exist and pass (`bun test` in `pi-agent-ext-wayfind`).
- A deliberately-broken truncation (e.g. naive `.slice(0,48)` with no re-trim) fails the new tests (RED proven).
- `bun run typecheck` green.

## Resolution
Fixed in `18f16900`: slugify now slices at the last `-` at/before the 48-char limit and re-trims leading/trailing dashes; regression coverage added in `tests/slug.test.ts` (word-boundary truncation, re-trim, the `...-prevous-wayfind-`-style case, and short-name passthrough).
