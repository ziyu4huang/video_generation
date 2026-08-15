> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-31-watch-dot

## Destination

A prioritized **decision backlog of new watchdog COVERAGE improvements** (beyond the
three already-decided `06`/`08`/`09` in the sibling effort
`2026-07-31-let-s-continue-to-improve-base-on-known-upstream`). Scope is the
**coverage** axis only: make L1 check more **languages** and more **lint sources**,
and stop L2 from reviewing **raggedly-truncated** diffs. Each candidate resolves as
`do / defer / skip`. **Planning only — this map decides, it does not build.**

## Notes

- **Domain**: `bun-apps/pi-agent-ext-subagent` watchdog — the two-layer review gate
  (L1 = `typescript-language-server` LSP diagnostics on changed TS/JS; L2 = model
  review of the diff). Code in `src/watchdog/`.
- **Skills every session should consult**: `grilling` + `domain-modeling` (HITL, one
  decision per session).
- **Do NOT re-litigate** `06`/`08/`09` — closed in the sibling effort (06 zero-layer
  sentinel, 08 L1 precise delta, 09 cross-ext singleton). They are the baseline, not
  candidates here.
- **⚠️ web_search is currently unavailable** in this env (Zai wrapper bug, Exa
  rate-limited, no other keys). `research` tickets may resolve on framework-level
  knowledge with a "verify before implementation" caveat — see sibling effort's
  ecosystem tickets (12/13/14) for the precedent.
- Conversational language: 繁體中文; all written artifacts: English.
- **Fact freshness**: charted at behind:0 (origin/main tip `3c0d3bd8`).

## Decisions so far

- [01 — Python LSP landscape](tickets/01-research-python-lsp-landscape.md) — framework-level (⚠ verify before impl, web_search down): **pyright/basedpyright** best fit for the existing LSP client + the watchdog's catch-real-errors goal; **ruff** optional 2nd source (lint); **jedi** too weak. Unblocks 02.
- [02 — Python L1 coverage](tickets/02-grill-python-l1-coverage.md) — **DO**: generalize L1 into a multi-provider registry (client already language-agnostic; abstract ext→languageId + provider-resolver config), add **pyright** for Python. ⚠ verify venv/extraPaths config before impl. Unblocks 03.
- [03 — Biome L1 lint](tickets/03-grill-biome-l1-lint.md) — **DO**: biome as a **CLI-lint lane** in L1 (`biome lint --reporter=json` on changed TS/JS; reuses repo's existing biome toolchain — NOT an LSP-registry entry). Severity by domain (correctness/suspicious/security→blocker; style/complexity/perf/a11y+format→concern). Fills tsserver's gap (strict-types, no `noUnusedLocals` → unused/cruft unseen). Establishes L1's 2nd lane (LSP-providers + CLI-lint); ruff-as-Python-lint is now the same shape.
- [04 — L2 large-diff curation](tickets/04-grill-l2-diff-curation.md) — **DO**: smart per-file-budget curation (conservative noise filter — lockfiles + generated artifacts only; KEEP vendored-source) + mandatory `truncated` flag surfaced in `l2.note` AND top-level `summary`. Fan-out rejected (loses cross-file wiring + ×N cost). Surfaced new ticket **05** (separate L2 input-set bug).
- [05 — L2 input file set](tickets/05-grill-l2-input-file-set.md) — **DO**: L2 input = `after.changedPaths` (drop the `tsJs.length ? tsJs : ` ternary) — L2 is a model (language-agnostic); the TS/JS filter dropped Python on mixed changes. L1 keeps `tsJs` (language-specific, 02's registry concern). Docs/config now reach L2 but bounded by 04's per-file budget; expand 04's noise filter (deny-list) if wasteful. → **map complete (frontier empty)**.

## Not yet specified

- **Further language coverage** (Rust/Go/etc. beyond Python) — now **trivially addable** as a new `L1Provider` registry entry (02 → generalize settled the architecture). Deferred unless a real language need appears; ruff-as-Python-lint is now the same shape as biome (a CLI-lint-lane entry, per 03). Revisit only if a real incident surfaces demand.

## Out of scope

(Not selected during breadth-first scoping — closed, never graduates unless the
destination is redrawn.)

- **Quality/config cluster**: L2 prompt tunability / project specialization; hard-gate
  option (blocker → actually block); L1↔L2 layer orchestration policy.
- **Robustness/cost cluster**: L2 retry / failure≠skip conflation (overlaps sibling
  effort ticket 12); L1 `typescript-language-server` cold-start caching; cross-run
  memory / false-positive suppression.
- **Cross-extension reach**: extending the watchdog gate to the workflow extension's
  `agent()` fan-out (parallel/pipeline).
