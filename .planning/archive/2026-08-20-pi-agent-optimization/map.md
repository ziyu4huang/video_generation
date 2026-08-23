---
effort: 2026-08-20-pi-agent-optimization
created: 2026-08-20
last: 2026-08-23
status: complete
---
# pi-agent-optimization — deploy chain / CI / extension-DX hardening

## Destination

A faster, truthful deploy chain and one-command extension scaffolding for the (then)
pi-agent host — from a deep review of 2026-08-20. Package names below say "pi-agent";
everything was renamed s2-agent on 2026-08-21 (#1755).

## Context (measured 2026-08-20 on this machine)

Four workstreams approved in one scope, sequenced A→B→C→D:

- **Phase A** — broken `update-pi.sh --rebuild` paths, dead deploy code, doc drift.
- **Phase B** — change-triggered local_ci deploy-e2e gate (`PI_AGENT_E2E` bundle assertions).
- **Phase C** — shared `@repo/pi-agent-ext-runpy-core` deduplicating the flux2/krea2/ltx
  runpy triplets + doctor/tsconfig consolidation.
- **Phase D** — `ext new` scaffold command + manifest single-source codegen for
  `static-extensions.ts`.

## Tickets

- Phase A — deploy fix — **closed** (#1732, 2026-08-20)
- Phase B — CI deploy gate — **closed** (#1734, 2026-08-20)
- Phase C — runpy-core — **closed (abandoned)**: never started as planned. The follow-up
  header in `plans/2026-08-20-knowledge-lib-face.md` records it explicitly ("Phase C runpy
  abandoned"); that plan shipped instead as the obsidian lib-face fix (#1737). No
  `runpy-core` package exists; runpy remains per-package.
- Phase D — scaffold + static codegen — **closed** in two PRs: A #1739
  (static-extensions.ts generator + `regen:static`) and B #1741 (`ext new` scaffold).
  `EXTRA_ENTRIES` and deps-probe were already derived; `EXTENSION_SPECS` deliberately stays
  hand-written.

Amendments recorded in plans, not silently edited into the spec:
- Phase B premise overstated — real gap was only the PI_AGENT_E2E-gated bundle-mode
  assertions; the ensureBundle cache already existed.
- Phase D narrowed to what was genuinely hand-maintained (static-extensions.ts only).

## Decisions

- **D1 — migrate-one-validate-then-replicate** for C1 (ltx first). Never exercised — C died.
- **D2 — generate only what is truly derivable.** Only `static-extensions.ts` was
  hand-maintained; the rest of the manifest surface already had single sources.

## Frontier

cleared. The scaffold command is now baked convention in CLAUDE.md
(`bun bun-apps/s2-agent/src/cli.ts ext new …`).

Housekeeping note (2026-08-23): execution was tracked via git history, not checkbox
hygiene — phase-a/b/d plans still show open `- [ ]` steps despite same-day merges. Left
as-is; rewriting them would fabricate history.

## Fog of war

- Per-package runpy triplication (the abandoned C) still exists. If a fourth native-port
  package ever needs runpy, revive the C1 seam then.

## Cross-effort links

- **Renamed-by**: `.planning/2026-08-22-ultracode-rename` — all `pi-agent*` names above
  became `s2-agent*` (#1755, 2026-08-21).
