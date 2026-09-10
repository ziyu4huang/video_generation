---
effort: 2026-09-10-spwf-drive-ab
created: 2026-09-10
last: 2026-09-10
status: active
---

# Wayfinder map: 2026-09-10-spwf-drive-ab — model A/B on the live-drive case battery

## Destination

User directive (2026-09-10): continue the loop with the Planner-Agent-led
successor to the live-drive arc. End state = the case battery (C1–C5, C8)
re-run on TWO explicitly pinned models (`zai/glm-5.3` vs
`lm-studio/google/gemma-4-12b`) with NEUTRAL prompts, on a pinned immutable
deployed dir; every receipt passively records its per-leg model (session
JSONL `model_change` + per-assistant-message `model`) with a `pin:match`
check; a committed case×model verdict matrix; model deltas are FINDINGS —
only a RED triggers a fix. The prior arc's model attribution is CORRECTED by
receipt evidence (§0). Close-out per CONVENTIONS.

## §0 Adjudication finding (planner-verified from session JSONLs, 2026-09-10)

The prior map's "model confound" narrative was itself WRONG:

| Prior leg | Session JSONL record | Evidence |
|---|---|---|
| C1-source/deployed, C2b, C3, C4, C5, C8 (all `-p` legs) | **glm-5.3 (zai), without exception** | every assistant message `"model":"glm-5.3"`; first entry `model_change {provider:"zai", modelId:"glm-5.3"}` |
| C6/C7 pty legs | google/gemma-4-12b | snapshot model bar (37 hits) |

So the `-p` behavioral greens were ALREADY glm-5.3 observations
(`~/.pi/agent/settings.json` default zai/glm-5.3; receipts recorded
`env:{}` — no override). The gemma evidence was pty-only (driver inherited
shell env — unprovable retroactively; the new per-leg model field closes
this class forever). Re-attributed from session JSONL, 2026-09-10.
Consequence: the untested cell is routing × gemma; both columns re-run fresh
under neutral prompts regardless.

## Context (measured 2026-09-10)

- Model pinning: `--provider <name> --model <pattern>` flags
  (`flag-spec.ts:92-93`); precedence explicit flag > `PI_MODEL`/`PI_PROVIDER`
  env > settings.json > builtin default zai/glm-5.3
  (`pre-load-providers.ts:634-669`). Shell may carry PI_MODEL pollution —
  the driver sets both env vars per leg AND passes flags; pin vs recorded
  mismatch voids the leg (D1).
- Deploy: pin `0.10.3+g88611db` (my double-fix deploy, E2E full-pass,
  reviewer byte-verified the ext.cjs fixes in that dir). `current` was moved
  again by a sibling (g9feaa18, sha unknown to this repo) — never used.
- Collision: sibling `2026-09-10-audit-gate-fidelity` will touch devops
  local_ci + 19 ext package.json files — THIS effort touches neither.
- Prior harness assets: output/spwf-drive/* (scratch); drive-case.ts has
  contention precheck, nonce isolation, 300s manual-kill cap, receipt always
  written. Known gaps being fixed in t02: no --dist flag, no model field,
  weak C3 order check, C5 expectation mis-specified.
- @repo symlinks in bun-apps/node_modules were dangling (wrong relative
  paths, created 2026-09-10 06:18 by a sibling process) — fixed this session
  (`../../<pkg>` form).
- Latency: glm-5.3 -p legs 21–119s quiet; gemma -p latency unknown (fresh
  column). Provider stalls happened twice on zai (13–19 min) — cap 300s.

## Tickets

- [ ] t01 adjudication + effort open + pin-proof smokes:
      prior-attribution.json from prior receipts' sessionFiles; 2 smoke legs
      (zai/glm-5.3 + lm-studio/gemma) with recorded model == pin
- [ ] t02 harness upgrades: --dist flag; per-leg model field + pin:match;
      C3 write-order detector; C5 check redefined (read to-spec ∨ to-tickets)
- [ ] t03 A/B battery: 12 cells (6 cases × 2 models), neutral prompts frozen
      in tickets/03, deployed pinned; glm column first, then gemma
- [ ] t04 verdict matrix + findings: committed table; deltas = findings;
      RED → minimal fix → gates → redeploy → same-case re-run (paired)
- [ ] t05 close-out: promotion decision (D7 conditional), reviewer, PR chain,
      successor next-goal

## Decisions so far

- D1 triple pin per leg: explicit flags + driver env override (PI_MODEL/
  PI_PROVIDER) + passive receipt record; mismatch voids the leg.
- D2 deployed pinned immutable dir only (g88611db); source leg only on
  deployed-RED (diagnostic, not matrix).
- D3 neutral prompt strings frozen verbatim in tickets/03; shared across
  models; never edited between legs.
- D4 fresh scratch root output/spwf-ab/ (no prior-leg state pollution);
  mutating-case scratch wiped before each leg.
- D5 checks-driven verdicts written BEFORE running; empty checks →
  UNSPECIFIED (never a false RED).
- D6 budget: ≤2 legs/cell; SKIP receipts preserved; never prompt-engineer a
  pass; deltas recorded as findings.
- D7 harness stays scratch; promotion is a close-out conditional decision
  (candidate: wayfind scripts/ + allowlist test line; package.json edits →
  defer with reason).
- D8 pty glm-5.3 supplement (C6/C7) = stretch, not blocking the matrix.

## Frontier

- t01 is enabling: the attribution correction + pin-proof smokes gate the
  whole matrix.
- C6/C7 glm-5.3 supplement is stretch (prior = gemma pty evidence only).

## Fog of war

- zai stall recurrence (→ SKIP, preserved).
- lm-studio state at run time (which variant resident — recorded).
- `current` moves again (pinned dirs immune; recorded).
- audit-gate-fidelity may open PRs concurrently — no file-level conflict.

## Cross-effort links

- Builds-on: 2026-09-09-superpowers-wayfind-drive — reuses its harness,
  case battery, and receipt discipline; corrects its model attribution.
- Shares-decision-with: 2026-09-09-self-arc-16 — receipts discipline
  (LLM-free verification where possible; model-visible checks labeled).
