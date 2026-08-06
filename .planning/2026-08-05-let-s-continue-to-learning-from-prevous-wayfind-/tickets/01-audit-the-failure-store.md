---
type: research
status: closed
closed: 2026-08-05 (charted this session)
---

# 01 — Audit the failure store: what is actually crowding the 40K budget?

## Question

Of the failure-memory target (`~/.pi/agent/pi-hermes-memory/failures.md`), reported at ~90% of its 40K-char budget: what is the concrete breakdown — (a) raw `errorCapture` traces, (b) recurring/duplicate curated entries, (c) resolved-but-not-removed entries, (d) genuinely unique curated lessons? This fact base grounds every other ticket (taxonomy, dedup, decay, the errors.log candidate).

## Resolution — ANSWERED (2026-08-05)

Audited directly. **The bloat is curated-but-recurring operational tool-quirks — NOT raw error capture.**

- **Size**: ~37,449 bytes / 40,000 char budget (**~94%**, even tighter than the memory tool's 90% read).
- **Category tag mix** (45 tags): **19 tool-quirk · 13 convention · 12 insight · 1 failure**.
- **Raw `errorCapture` traces in the store: ZERO** (no `exit code` / `stderr` / `Error:` / `.ts:` stack frames). The #854 rate-limiting has effectively suppressed raw-trace accumulation. → The REJECTED.md candidate's premise ("auto-captured stack traces compete with curated failures") is **currently unfalsified-but-inert**: errorCapture is not a present contributor.
- **The real bloat = the `await_pr_merge` family: 7 entries** (lines 87 / 255 / 287 / 303 / 312 / 321 / 377), all `tool-quirk`, spanning 2026-08-02 → 2026-08-04 as understanding evolved:
  - **2 are near-verbatim duplicates** of the *same* PR-#1028 cross-worktree incident (lines 303 & 312 — same lesson, recorded twice).
  - **2 are redundant resolutions** of the #1030 fix (lines 321 & 377 — both "resolved, now merges directly when green").
  - Entry at line 87 (2026-08-02, PR #1010) is **largely superseded** by the #1030 fix.
  - → ~7 entries should compress to **~2** (one active canonical + one resolved-historical). That family alone reclaims substantial budget.
- **Implication for the map**: the high-leverage levers are **dedup** ([04](04-dedup-identity-and-merge-rule.md)) and **decay/supersede** ([05](05-decay-aging-and-supersede-policy.md)). The [errors.log candidate](03-errorslog-rotation-candidate.md) is real-but-low-priority until errorCapture is shown contributing again.

**Assets**: `~/.pi/agent/pi-hermes-memory/failures.md` (audited in place).
