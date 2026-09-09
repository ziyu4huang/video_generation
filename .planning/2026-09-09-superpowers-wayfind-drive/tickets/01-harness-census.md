---
type: task
status: closed
resolved: 2026-09-09
---

# t01 — harness + census + baseline

## Question

# t01 — harness + census + baseline

- `output/spwf-drive/drive-case.ts`: thin `-p` spawner — contention precheck
  (LM Studio resident large model → wait), per-case session isolation (D3
  tier chain), JSONL detectors (marker count, read paths, toolCall order),
  emits `receipt.json` per case {case, argv, env, cwd, sessionsDir,
  detected:{marker,reads[],order}, verdict, nonce}.
- pty variant parameterizing `tui-drive.ts` for C6/C7 keystroke scripts.
- Verify isolation tier empirically (D3) on source AND deployed legs.
- Census leg: what does a bare repo-root boot actually advertise (skill list
  via a -p ask + probe-extension-introspection read)?
- 8 baseline receipts pre-fix under `output/spwf-drive/baseline/` (C1 on both
  legs; others one leg for cost).

Acceptance: 8 receipts on disk; detector tiers proven; census recorded in
map Context.


## Resolution

Harness shipped (drive-case.ts, drive-pty.ts, probe-bootstrap.ts - scratch). Detector corrections F0a (bootstrap injection not persisted) + F0b (PI_SESSIONS_DIR reader-only - nonce pinning). Census: bare boot advertises both families + repo skills; default model resolved google/gemma-4-12b (local). 7 baseline legs run; 2 stalls preserved as environment evidence.
