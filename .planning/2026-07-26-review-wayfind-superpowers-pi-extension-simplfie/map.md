# Wayfinder map: 2026-07-26-review-wayfind-superpowers-pi-extension-simplfie

## Destination

Reverse **ADR-0002**: remove `pi-agent-ext-wayfind`'s `workspace:*` dependency on
`pi-agent-ext-core-task`. The sole runtime coupling ADR-0002 added is the shared
status-widget import (`getSharedStatusWidget()` in `src/index.ts`); dropping the
package dependency means re-deciding how wayfind displays its TUI status line
without importing core-task — preserving ADR-0002's *intent* (one composite
widget, deterministic ordering, no footer collision) as far as the chosen
strategy allows. The plan-coordinator handoff contract (`__piWayfindActive` seam,
plan-seed shape, `parsePlan` test) is **not** ADR-0002 and stays. The destination
is a settled decision set + supersession ADR, handed off to `writing-plans` / SDD
for execution.

## Notes

- **Domain**: pi extension packages `@repo/pi-agent-ext-wayfind` (the focus) and
  `@repo/pi-agent-ext-superpowers` (the consistency-alignment reference — already
  at the coupling floor: 0 deps, 3 pi-imports, 2 files, no runtime seams; per the
  prior `2026-07-26-after-sync-...-superpowers` audit, commit `09e0489f`).
- **Why wayfind is coupled and superpowers isn't (intrinsic)**: wayfind
  coordinates with the plan coordinator (grill→plan handoff) and joins the
  composite status widget; superpowers is a standalone skill-injector with no
  cross-extension coordination. The asymmetry is largely forced by what each
  does, not sloppiness.
- **The jiti constraint (load-bearing)**: pi loads extensions via jiti; module
  identity across jiti/native loaders isn't guaranteed, so any cross-extension
  singleton MUST be `globalThis`-backed (a module-level `let instance` silently
  breaks into disconnected instances). `getSharedStatusWidget()` lives on
  `globalThis.__piCoreTaskStatusWidget`. This constraint governs every replacement
  strategy (see ticket 02).
- **Skills every session should consult**: `wayfinder` (this map), `grilling`,
  `domain-modeling` (CONTEXT.md + ADRs) when working the decision tickets.
- **Standing preferences**: zh-TW conversation, English artifacts.
- **Fact freshness**: charted 15 commits behind origin/main, but **none of the 15
  touch wayfind/superpowers** (picker/obsidian/hermes/distill/workflow-tui/ltx) —
  facts are current for this scope; rebase optional.

## Decisions so far

<!-- the index — one line per closed decision ticket -->

- [01 — Research: core-task coupling surface + blast radius](tickets/01-research-coupling-surface.md) — sole runtime coupling is `src/index.ts:16` `getSharedStatusWidget()` (status widget, ADR-0002); the `parsePlan` test import + `__piWayfindActive` seam are a *separate* older plan-handoff contract that stays. Blast radius is small (index.ts + package.json + ADR supersession); tests unaffected.
- [02 — Grilling: status-display strategy after dropping the core-task dep](tickets/02-grilling-status-strategy.md) — **Option A: duck-type `globalThis.__piCoreTaskStatusWidget`** (no import, no package dep; register the section when present); **no fallback** (ADR-0002's accepted consequence retained). Build-time dep gone, loose runtime string+shape contract remains, unified widget UX preserved.
- [03 — Grilling: scope boundaries of the ADR-0002 reversal](tickets/03-grilling-scope-boundaries.md) — handoff = Decision-1 reversal **only**: keep the seam + plan-seed contract (coupling B, untouched), keep command consolidation (Decision 2), internal coupling out; **versioning = shared semver policy + documented divergence** (different upstream lineages, not forced equal) adds one small doc task.

## Not yet specified

<!-- All decisions resolved (01, 02, 03 closed). The route to the destination -->
<!-- is clear — the remaining work (supersession ADR + Option-A implementation + -->
<!-- versioning-policy doc) is the writing-plans/SDD handoff, not map decisions. -->

_None — all decisions resolved; the route to the destination is clear._

## Out of scope

- **Superpowers' coupling** — already at the floor (0 deps); nothing to reduce.
  It stays as the consistency-alignment reference only.
- **The `__piWayfindActive` seam + plan-seed contract** — this is the grill→plan
  handoff (older than ADR-0002; ADR-0001/0003 territory), load-bearing
  functionality, not the status-widget coupling ADR-0002 added. Reversing
  ADR-0002 does not touch it.
- **Internal module coupling** (`index.ts`=9, `commands.ts`=8 relative imports) —
  normal hub-and-spoke composition-root structure, not pathological; the chosen
  destination (dep removal) doesn't require restructuring it.
