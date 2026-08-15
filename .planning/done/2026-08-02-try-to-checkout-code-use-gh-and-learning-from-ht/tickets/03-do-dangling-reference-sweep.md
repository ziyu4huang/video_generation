# DO — dangling-reference detection sweep

**UPSP pattern:** §4 (§25.9/.10 悬空检测) · **Decision:** DO · **Effort:** S–M

## What
An integrity sweep at backfill / session boundary: parse memory bodies for references to other `md_id`s / known slugs / failure categories; flag any reference whose target is not **live** (`status=active`). Exclude entries created this round (fresh-empty is legal). Hits → a warnings list surfaced to the agent / maintainer.

## Why
Months of memory accumulate broken refs (evicted/superseded targets, renamed slugs). Invisible until it bites. Low effort (DB query + body-ref parser), clear payoff. Pairs with decay (#1b): a ref whose target *decayed out* is the failure mode this catches.

## Acceptance
- Given a body ref to a purged/superseded entry, the sweep flags it with the referencing entry + dead target.
- Freshly-created (this-round) entries are excluded.
- Surfaces as a warnings list, not a hard failure.

## Scope hint
- New sweep module in `pi-agent-ext-hermes-memory` (DB-side `status` lookup + body-reference parser); wired into backfill/session-boundary.
