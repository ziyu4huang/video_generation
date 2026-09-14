---
effort: 2026-09-15-gemma-compact
created: 2026-09-15
last: 2026-09-15
status: active
---

# Wayfinder map: 2026-09-15-gemma-compact — fill the gemma column + prove 2-compact re-arm

## Destination

Execute the LATEST queue head (validated successor
next-goal-20260914-230436.md): (1) fill the gemma column's UNTESTED cells
(C1/C2/C3/C5 — C4/C8 already PASS) by loading gemma-4-12b into an otherwise
EMPTY LM Studio and running the committed battery's gemma cells immediately
(JIT load + quiet machine = stable residency, unlike the churn window);
(2) prove the superpowers bootstrap RE-ARMS across a SECOND compaction
(2-compact receipt — the existing receipt covers one cycle); (3) curator
delta: the NaN unary-plus lesson enters the playbook (PB-21) with the
line-cap restructure that keeps the schema test green. Closes with
receipts, one PR through the devops chain, reviewer, successor.

## Context (verified 2026-09-15)

- `lms ps` at open: NO models loaded (the churn window has passed —
  sibling idle). `lms load` CLI hangs (9 min, killed) — JIT load via the
  first API request is the reliable path (proven: prior gemma C4/C8 legs
  worked via JIT).
- Battery: committed at wayfind/scripts/spwf-battery.sh (frozen prompts,
  triple pinning); drive-case.ts detector is the promoted canonical copy.
- Pin: 0.10.3+g11e90db carries the NaN fix + F2 directive. Newer sibling
  deploys exist (gbee16fd, current) but g11e90db is this lineage's
  verified base; the gemma surface is identical across them (wayfind/
  superpowers skills byte-checked in the #2266 era; superpowers gained
  only the F2 line since).
- Prior gemma state: C4 PASS, C8 PASS, C1/C2/C3/C5 UNTESTED-infra
  ("Model unloaded." churn + raw token soup on C5).
- session_compact: 1-cycle receipt PASS (attempt 2, 85s window); 2-cycle
  re-arm is the depth ask. F0a: behavioral (tier-3) detector only.
- Playbook: exactly 150 lines / 20 entries (at cap) — PB-21 add requires
  the curator's line-restructure (Added→Status merge frees 20 lines).
- Collision: sibling #2268 open (devops local_ci src + ext package.json) —
  untouched here.

## Tickets

- [ ] t01 open effort (this commit)
- [ ] t02 gemma fill: 6 cells (C1-C5, C8) on JIT-loaded gemma, pinned
      g11e90db, ≤2 legs/cell, receipts → evidence/gemma/
- [ ] t03 2-compact receipt: /compact → probe → /compact → probe (both
      YES) via drive-compact 2-cycle extension
- [ ] t04 playbook PB-21 (NaN unary-plus lesson) + line restructure; schema
      test green
- [ ] t05 close-out: reviewer GLM-5.3, PR chain, matrix delta, successor

## Frontier

- t02 is the queue head; t03 is independent (can interleave).

## Fog of war

- gemma JIT load may evict under sibling pressure mid-battery (→ SKIP
  receipts, preserved; retry once).
- /compact on a near-empty context may be a no-op (the probe question is
  sent fresh each cycle — the re-arm assertion is the bootstrap self-report,
  not context size).
- The schema test's Added-merge restructure must keep the parser green.

## Cross-effort links

- Builds-on: 2026-09-10-spwf-ab-closing (D5 precondition protocol + battery)
  and 2026-09-14-spwf-improve (NaN fix lineage — PB-21's subject).
