# Ticket 11 — Reviewer default-off + shield wire-or-delete

Status: pending

## Why

Two default-on/inert pieces of the goal completion path fight the model or
pretend to exist: (1) the Reviewer regex-classifies prose findings
(CLASS_PATTERNS, reviewer.ts:90) and AUTO-ENQUEUES `/list` goals without
Confirm, default `enabled: true` — its own changelog records four rounds of
field-observed false positives (v0.26.3/0.26.4/v0.28.16/v0.28.24), the
signature of a heuristic that doesn't generalize, and it overlaps the
repo's real planning layer (wayfind/`.planning/`). (2) The regression
shield is unreachable: `verificationContract` is settable by no command or
flag, so the whole shield branch (auditor.ts:269-280, shield.ts:41, ~150
lines) can never fire.

## Scope

1. **Reviewer default → off** (map D6): flip the default, keep the opt-in
   path (`/goal --review`-style or settings) for unattended rigs; document
   the flip in CONTEXT.md (goal section) + release-note the behavior
   change in the PR body. Confirm-enqueue stays mandatory for the opt-in
   path too (no silent auto-enqueue at all).
2. **Shield**: wire `/goal --verify <contract>` (the natural surface —
   the auditor already consumes the contract when set) or delete shield.ts
   + the auditor branch + tests. Prefer wiring if the contract shape is
   still coherent with today's auditor; delete if it references retired
   surfaces.
3. Tests: default-off pinned (a completing goal does NOT enqueue reviewer
   findings by default); opt-in path still works end-to-end; shield branch
   either covered by a real wiring test or gone.
4. Spec.md §2 gains the divergence entry: "s2 reviewer is opt-in; CC has
   no reviewer analog" (it's an advantage ONLY when it's right — off by
   default is the honest posture per D6).

Not in scope: the auditor's core verdict flow (unchanged); quota-retry;
reviewer's classification patterns themselves (only the default + enqueue
discipline).

## Done-when

- [ ] Default path: goal completion produces a report but enqueues
      nothing without opt-in (test + manual receipt).
- [ ] Shield either wired (`/goal --verify` reaches the auditor branch,
      test) or deleted (grep verificationContract → zero hits).
- [ ] Canonical gates green; PR merged CLEAN.
