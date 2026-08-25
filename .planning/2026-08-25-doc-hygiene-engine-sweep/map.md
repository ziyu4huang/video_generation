---
effort: 2026-08-25-doc-hygiene-engine-sweep
created: 2026-08-25
last: 2026-08-25
status: complete
---

# Doc-hygiene engine sweep — Path-A citations, inert `-e workflow` prose, stale ADR Index headers

## Destination

Every live doc/comment in the engine packages states the CURRENT load reality:
ultracode is static/built-in (no `-e` flag), the Path A CLI meta-command is gone
(round-2 t02, #2015), and every ADR header points at the real index
(repo-root `CONTEXT-MAP.md`). Zero behavior changes, zero version bumps.

## Context

Measured 2026-08-25 on this machine (branch off origin/main @ 62d8984c, after
round-2 t11 #2040 removed `-e <alias>` entirely):

- **Path-A citations ×5 sites / 3 files** (ext-ultracode): `src/workflow-pack.ts:6`
  ("shared by BOTH entry paths"), `PRD.md:26,62,74,79` ("two entry paths";
  headless `bun … cli workflow run` invocation at :98), `CONTEXT.md:56`
  (**Entry path** term names Path A). Path A was removed 2026-08-25 (#2015,
  cli/commands/workflow.ts + dispatch namespace); only Path B (the `workflow`
  tool's `name` param) remains. Round-2 map Fog assigned this to "the
  engine-side effort" — this is it.
- **Inert `-e workflow` / `-e ultracode` prose ×15 sites / 12 files** — all
  comments/docs, zero live argv constructions (verified by grep; none build
  `["-e","workflow"]`). Since ultracode is `load: "static"`
  (registry-config.ts:320-324) the flag is unnecessary; since #2040 bare-name
  rewriting is gone. Files: ext-ultracode README.md:47, samples/{smoke-e2e.ts:9,
  run.ts:9, audit-run-dir-resolve.js:7,70,87}; ext-krea2 workflows/{README.md:35,44,
  test-krea2-e2e.js:20}; ext-flux2 workflows/{README.md:32,41,106,
  self-improve-flux2.js:37, test-flux2-e2e.js:20}, docs/pose-validation.md:192,
  extensions/cli-subcommand.ts:86; s2-agent src/run-dir/workflows/ltx-live-e2e.js:6.
- **s2-agent `workflows/knowledge-distill.js:28`** — stale `cli workflow run
  knowledge-distill` invocation block (the CLI surface died with Path A; the
  tool equivalent survives). Round-2 map Fog: "whichever effort opens first
  takes it" — this one.
- **Stale ADR Index headers ×35 files / 9 packages** — line-1
  `Index: bun-apps/docs/adr/INDEX.md` (nonexistent). Distribution:
  subagent 9, superpowers 7, wayfind 6, tool-gate 5, ultracode 4, core-runtime 1,
  archify 1, hermes-memory 1, task 1. Round-2 t09 (#2034) fixed s2-agent's 8
  with `Index: repo-root \`CONTEXT-MAP.md\``; the sweep owns the rest
  (reviewer-measured count matches: 35).

## Tickets

**Execution order:** 01 → 02 — 01 is the correctness-critical cluster (docs
that actively mislead a reader about entry paths), 02 is mechanical line-1
surgery; no cross-dependency, order chosen so the harder review lands first.

- [x] 01 — ultracode/workflow doc correctness (complete 2026-08-25, PR #2043 squash 92961787: reviewer WITH-FIXES → 2 blockers + 6 NITs fixed in the same PR — knowledge-distill INVOCATION dedupe + meta.description dead form, PRD invented date, s2-agent CONTEXT/cli.ts Path-A prose, 3 test/tool comment sites; audit sample retarget onto live resolve.ts surface; residual `-e` grep 2 benign hits dispositioned)
- [x] 02 — ADR Index header sweep (complete 2026-08-25, PR #2045: 35/35 backticked-form replacements across 9 packages, byte-identical to t09 precedent, residual grep 0, test:adr 17/17, reviewer READY 0 blockers)

## Decisions

- **D1 — PRD gets a status amendment, not a rewrite.** PRD.md is a dated design
  record; the "two entry paths" section keeps its history and gains a
  `STATUS 2026-08-25` note that Path A was removed (#2015). Living glossary
  (CONTEXT.md) and code headers (workflow-pack.ts) are rewritten outright.
- **D2 — prose fixes say "built-in", not a replacement flag.** `run.sh -e workflow -p …`
  → `run.sh -p …` — ultracode is static-loaded; no `-e` incantation exists to
  substitute. Never invent a new invocation form.
- **D3 — one PR per ticket** (scope isolation across 12 packages); no version
  bumps (doc-only, no shipped surface — t09 precedent).

## Frontier

DRAINED — both tickets complete (#2043, #2045). Destination met: no live doc
teaches `-e workflow`/`-e ultracode`/`cli workflow run` or points an ADR Index
at a nonexistent file.

## Fog of war

- `docs/agents/` and root `CONTEXT-MAP.md` may themselves reference the
  `cli workflow run` form — NOT yet measured; ticket 01 greps repo-wide for
  `cli workflow` before closing.
- Whether any packaged skill (ext-ultracode skills/) teaches `-e workflow` —
  same grep covers it.

## Cross-effort links

- `Builds-on: 2026-08-25-s2-agent-simplify-round2` — its Fog of war items
  (engine Path-A docs, 35 stale ADR headers, inert `-e` prose after #2040) ARE
  this effort's Context; close them in that map when the tickets land.
- `Shares-decision-with: 2026-08-25-s2-agent-simplify-round2 ticket 09` — the
  exact ADR Index replacement line and no-bump precedent come from #2034.
