# Ticket 12 — inspect_context window framing

Status: pending

## Why

CC's `/context` renders each category's share of the CONTEXT WINDOW plus a
free-space headline. `inspect_context` renders buckets as percentages of
CURRENT USAGE (grandTotal, inspect-context.ts:104,110-116), has no
free-space row, and its "Conversation + other" bucket is derived by
subtraction (live total minus two char-ratio estimates) — all estimation
error silently lands there with no label saying so.

## Scope

1. **Window-relative rows**: when `usage` exists, render each bucket's
   percent against the window (`bucket / window`), not against current
   usage; keep the absolute token counts per bucket.
2. **Free-space row**: `window − live` as the headline row (CC's framing:
   "free space before auto-compact").
3. **Honest residual**: rename bucket C to `residual (est. error
   included)` — or better, split it when the SDK exposes message-level
   accounting (investigate `ctx.getContextUsage()` granularity first; if
   messages vs tool outputs cannot be split, the rename is the deliverable).
4. **Rendering tests**: pin the new rows with the existing ctx-fixture test
   shape (usage present / usage null / window edge cases); update the
   tool's self_test outline.
5. **Context-reminder divergence check** (map fog): confirm whether any SDK
   seam could inject a CC-style "X% context used" reminder near thresholds;
   if none exists, record the divergence in spec.md §2 (status-line only)
   — do not force it.

Not in scope: pathology saturation warnings (04); schema-cost estimation
(shared formula untouched); the pathology detector's own 85% threshold.

## Done-when

- [ ] inspect_context output shows free space + window-relative shares
      (test-pinned with fixtures).
- [ ] Bucket C labeled honestly or genuinely split.
- [ ] Reminder-injection seam either found+scoped (new ticket) or
      recorded as a deliberate divergence in spec.md §2.
- [ ] Canonical gates green; PR merged CLEAN.
