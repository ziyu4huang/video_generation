# DO — "used vs dropped" signal (enrich memworth)

**UPSP pattern:** §9 (默契集) · **Decision:** DO (candidate) · **Effort:** S–M · **Depends on:** ticket 05

## What
Record which **surfaced** entries the agent's subsequent actions actually **referenced** (by id or content match) within the same session; mark them `used`. Once decay (#1b) exists, `used` entries are spared and `surfaced-but-never-used` ones decay faster.

## Why
A sharper "was this memory useful?" signal than session-end success/fail counting. UPSP's 默契集 records what setup pre-loaded vs what reaction actually used — directly applicable.

## Acceptance
- Surfaced-and-later-referenced entries are marked `used` for that session.
- Hebbian co-occurrence / autonomous distillation tables are **NOT** built (SKIP — needs a resident daemon we don't have).

## Scope hint
- Builds on the assembly log (05) + action-reference matching; integrates with `memworth`/decay.
