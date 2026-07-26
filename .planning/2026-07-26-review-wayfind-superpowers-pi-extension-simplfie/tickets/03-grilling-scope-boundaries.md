---
type: grilling
status: closed
claimed: wayfind-decouple-session (2026-07-26)
blocked by: [02]
---

# 03 — Grilling: scope boundaries of the ADR-0002 reversal

## Question

Exactly how far does "reverse ADR-0002" reach? Confirm what stays, what's in
scope, and what's a separate effort — so the handoff plan has clean boundaries.

## Sub-decisions (resolve one at a time)

1. **The `__piWayfindActive` seam + plan-seed contract — keep?** It's the
   grill→plan handoff, not status. Ticket 01 says yes (relative-path test +
   best-effort seam, unaffected by the dep removal). Confirm.
2. **ADR-0002 Decision 2 (command consolidation: `/grill [me|docs|done|domain]`,
   `/wayfind [...]`) — keep?** The reversal targets Decision 1 (status-widget
   dep), not the command consolidation, which stands on its own merits
   (collapsed 19 overlapping commands → 2 namespaces). Likely keep.
3. **Versioning consistency (wayfind `0.1.0` vs superpowers `6.1.1`) — in scope
   for this effort, or a separate cosmetic follow-up?** wayfind tracks its own
   upstream port (Matt Pocock's decision-chain suite); superpowers tracks Primer
   Radiant. The divergence may be intrinsic to each port's lineage.
4. **Internal module coupling (`index.ts`=9, `commands.ts`=8 relative imports) —
   in scope, or out?** Normal hub-and-spoke composition-root structure (leaf
   modules `state`/`overlay`/`map`/`grill`/`freshness`/`constants` have 0
   relative imports), unrelated to the dep removal.

## Notes for the grilling

- Most sub-decisions have an obvious answer (keep seam, keep commands,
  internal-coupling out). The genuinely open one is **(3) versioning**. Don't
  re-litigate the settled ones — confirm and move on.
- Whatever (3) decides may graduate a small follow-up (version-alignment) rather
  than belong to the dep-removal handoff.

## Resolution (2026-07-26)

All four scope sub-decisions resolved:

1. **`__piWayfindActive` seam + plan-seed contract → KEEP.** It's the grill→plan
   handoff (coupling B, ADR-0001/0003 territory), untouched by the dep removal.
   (Confirmed; research-backed — ticket 01.)
2. **Command consolidation (ADR-0002 Decision 2: `/grill`, `/wayfind`) → KEEP.**
   Stands on its own merits; reverting would re-bloat the command surface. The
   reversal targets Decision 1 only.
3. **Versioning (wayfind `0.1.0` vs superpowers `6.1.1`) → shared policy +
   document the divergence.** Both stay semver, each tracking its own upstream
   (Matt Pocock decision-chain vs Primer Radiant); the divergence is intrinsic
   to the different lineages and is recorded as intentional, not forced equal.
   Consistency = process/scheme, not matching numbers. Adds one small doc task
   to the handoff.
4. **Internal module coupling (`index.ts`=9, `commands.ts`=8) → OUT of scope.**
   Normal hub-and-spoke composition-root structure (leaf modules have 0 relative
   imports); unrelated to the dep removal.

➡️ **Handoff boundary = ADR-0002 Decision-1 reversal ONLY** (drop the
status-widget dep, implement Option A) + one small versioning-policy doc.
Nothing else moves.
