# 05 — doctor family doc

blocking: none

## What

Five diagnostic surfaces (`s2-agent doctor`, `ext doctor`, `cli doctor`,
devops `session-doctor-cli.ts`, `debug-s2-session` skill) with no "which one
when". One doc surface with a table; lives in domain-docs.

## Receipt (2026-08-30, main `6f55366f`)

Re-measured: all five surfaces live and answer DIFFERENT questions —
sh doctor (deploy/mode statics), ext doctor (extension registry),
cli doctor (fresh-machine boundary conditions), session-doctor-cli (live
tools-active probe, dev|deploy), debug-s2-session skill (method routing,
backed by session-doctor-cli).

Deliverable (per domain-docs ladder + glossary purity):

- **`bun-apps/s2-agent-ext-devops/docs/doctor-family.md`** — the ONE table:
  5 surfaces × owns/run-when + symptom→doctor quick routing + deliberate
  non-goals (surfaces NOT merged — each check class must fail legibly; the
  doc owns no checks, it is not a sixth surface).
- **devops CONTEXT.md** — new **Doctor family** term (Diagnostics section)
  with _Avoid_ ("run the doctor" without naming which; a sixth mega-doctor)
  and _Source_ anchor to the table.
- **s2-agent CONTEXT.md** — existing `doctor` term gains its single
  _Source_ anchor pointing at the routing table (it is one of five).
- **debug-s2-session SKILL.md** — one pointer line up top (skills are the
  agent discovery layer).

## Done when

- [x] Table answers "which doctor do I run" per symptom
- [x] `bun run test:adr` clean; CONTEXT.md terms consistent
