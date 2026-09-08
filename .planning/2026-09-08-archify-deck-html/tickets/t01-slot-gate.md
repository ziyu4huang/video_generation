# t01 — slot gate at build time

status: closed (2026-09-08)

## Result

`slotProblems` moved from the advisory lint tool to `layout-registry.ts` (next
to `CatalogEntry`) and is enforced in `buildDeck` right after the lint errors:
a missing/empty/over-full template slot now throws
`deck would render broken: slide N: layout "..." — missing slot ...` instead of
rendering a silently empty page.

The gate's first run caught a real inconsistency: `table.layout.json` declared
`note` "optional" in its own description but required in the slot spec — the
spec is now `"required": false`, and two test manifests (deck-determinism's
table slide, the project-kickoff skeleton) that relied on the wrong requiredness
build clean again.

Tests: `tests/deck-slot-gate.test.ts` (missing slot, empty array, over-max,
well-formed still builds). Suite 740/0, tsc clean.
