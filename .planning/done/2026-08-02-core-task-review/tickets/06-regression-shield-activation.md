---
type: grilling
status: closed
blocked by:
findings: M3
resolved: 2026-08-12 — option (b) inert-by-design, shipped in #1072 — auditor floor #5 (`regression_shield`) marked inert; no `--verify` flag added
---

# 06 — `regression_shield` (auditor safety floor #5) is inert — activate or mark

## Problem

Auditor safety floor #5 ("approval w/o per-item evidence → disapproval") can **never fire** in core-task: the shield activates only when `goal.verificationContract?.trim()` is truthy, and **no command/flag sets a contract**. The shield module is dead code in practice (only `parseAuditorVerdict` + the read-tool floor are live). This is a documented, deliberate incomplete port — but a meaningful capability divergence from GLA.

## Evidence

- `core-task/src/goal/shield.ts` fully ported; activates only with a contract (`auditor.ts:121-148,249-263`).
- `state.ts:81` reads `verificationContract`; `commands.ts:97-126` parses only `--audit/--model/--tokens` — **no flag sets it**. grep = 0 assignment sites.
- Doc: `docs/2026-07-25-opt-in-auditor.md` §2 Non-goals confirms deliberate incomplete port.

## Decision to make

- **(a) Activate:** ship a `/goal --verify "contract…"` flag (or read a contract from `.pi/core-task/contracts/<id>.md`) that populates `verificationContract`, so floor #5 is live. Add a test that an approval without matching `<evidence>` is rejected.
- **(b) Mark inert:** add an explicit comment at `auditor.ts:121` that floor #5 is inert-by-design until a contract setter ships, so future readers don't assume it's enforced.

## Acceptance

- [ ] Direction chosen; if (a), the flag works + the shield rejects evidence-less approvals (test); if (b), the inertness comment is in place and `shield.ts`'s dead path is noted.

## Notes

(a) is a real feature (small); (b) is a 2-line doc fix. Pick based on whether per-goal verification contracts are a near-term want.
