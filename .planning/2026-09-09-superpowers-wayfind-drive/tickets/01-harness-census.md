---
type: grilling
claimed: 01a08832-18ff-7a4f-ad2c-f615b8a6995e
status: open
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
