---
type: grilling
blocked by: []
status: closed
resolved: 2026-07-26 (fix; PR #860, commit c6e0b6b3)
---

# 05 — distill readState raw JSON.parse robustness

## Decision

**fix — recovery strategy = reset to empty state.** (Grilled 2026-07-26; user
said "fix it", accepted the recommended reset recovery.)

## Findings (fact-finding, branch behind:0)

- `src/distill/state.ts:12` — `JSON.parse(readFileSync(p, "utf8"))` with **no
  try/catch**.
- `distill/converge.ts:runConverge` order: `ingestRecords()` (writes cards, line
  28) → **then** `readState()` (line 49) → `writeState()` (line 65).
- So a corrupt `.distill-state.json` throws **after cards are already persisted**
  → partial converge + `writeState` never runs + caller gets a SyntaxError
  instead of a `ConvergeResult`.

## Recovery strategy chosen: reset (not skip)

- `readState` already returns the empty default when the file is **missing**
  (lines 10-12). A corrupt file is semantically identical ("no usable state"),
  so returning the same empty default is **least surprise** — callers don't
  branch on the difference.
- `reset` lets converge **complete** (threshold adapt + writeState), which
  **overwrites the corrupt file** → self-healing, same philosophy as
  `loadCachedIndex`'s mtime self-heal (ticket 01).
- `skip` would leave cards written but state un-updated, and the next run hits
  the same corrupt file — no self-heal.

## Change

`src/distill/state.ts`: wrap the parse + field-read in `try { ... } catch { return
empty default }`. Comment explains the crash-after-write rationale + self-healing.

## Proof (disable→fail→restore→pass, #839/#841/#843/#858 bar)

New test in `__tests__/distill/state.test.ts`: writes a corrupt
`.distill-state.json` (`{ this is not valid json }}}`), asserts `readState`
returns the default (threshold 50, empty history, null lastRun) without
throwing.

- **Fix OFF (bare JSON.parse)** → test FAILS: `SyntaxError: JSON Parse error:
  Expected '}'` thrown from readState (exactly the ticket's crash).
- **Fix ON** → test PASSES: returns default state, no throw.

Full knowledge-card suite: 379 pass / 0 fail.
