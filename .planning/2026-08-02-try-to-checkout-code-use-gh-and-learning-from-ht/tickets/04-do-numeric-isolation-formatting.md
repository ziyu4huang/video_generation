# DO — numeric isolation in the assembled memory block

**UPSP pattern:** §7 (§〇 principles 一/三, blood-brain barrier) · **Decision:** DO · **Effort:** XS–S

## What
When surfacing memory in the prompt, translate `memworth{success,fail}` into natural-language interpretation ("this lesson has bitten us repeatedly" / "rarely tripped") rather than emitting raw counters. State as an explicit design rule: the agent edits memory through the validated tool envelope, never raw source mutation.

## Why
Raw counters can anchor/bias the LLM and leak implementation detail; hiding them removes a prompt-gaming incentive surface. Cheap — an assembly-layer formatting change.

## Acceptance
- The assembled memory block never emits raw `memworth` numbers; only prose bands.
- A test asserts the assembled block contains no `memworth.fail = N` / `memworth.success = N` literals.

## Scope hint
- Assembly formatting (`prompt-context.ts` / wherever the memory block is rendered).
