---
status: open
---
# Handoff — what is done, what is waiting, what was a false alarm

Written 2026-08-16 at the end of the session that landed PR #1464. Read this before
picking anything up from `tickets/`.

## Landed

- **Ticket 01 (power-tool re-architecture) — DONE**, merged in PR #1464 (`0302f8f3`).
  P1–P8 all shipped. `verify_merge`: CLEAN, 41 files, `outOfScope: []`.
- Two unrelated repairs rode along in the same PR because they blocked it:
  - `fix(devops)`: `pr-finish-cli` was not forwarding `log` into `runLocalCi`, so
    `runSchemaCostCheck` (an in-process import, not a spawn) wrote to stdout and
    corrupted the CLI's own documented JSON-on-stdout contract.
  - `pi-agent-ext-subagent` biome formatting. Its canonical script is
    `check && build && test:unit`; PR #1465 landed two files biome rejects, so **main
    was red** for every PR touching that package. `bun test` alone passes, which is why
    it went unnoticed.

## Ticket 02 (ask-user) — half done; the rest needs two answers

A1/A3/A4/A5 landed. State of each finding:

| # | Ready to implement? |
|---|---|
| A1, A3, A4, A5 | **DONE** — closed together by `view/hint-table.ts`. |
| A2 | **Blocked on the user.** |
| A6 | **Blocked on the user.** |
| A7, A8, A9 | Yes, independent, low risk. |

### The A1/A3/A4/A5 cluster — CLOSED

`buildHintText` hand-assembled the footer with `if (...) hintParts.push(...)` while a
parallel table of `HINT_*` constants sat beside it pretending to be the vocabulary.
Nothing kept the two in sync, so: a label was double-prefixed (A1 printed
`n n to add notes`), a translated-and-tested hint was never appended (A3), a
configurable key was described by a hard-coded string (A4), and four constants were
exported to nobody (A5).

Fixed by `src/ask-user/view/hint-table.ts`: one `{ label, when, args }` table plus one
`buildHintText(ctx)` renderer, shared by the dialog footer and the collapsed bar, with
`config.formatKeySpec` as the single place a key is spelled for a human (the notify path
was moved onto it too). The structural guard is the reachability suite in
`view/__tests__/hint-table.test.ts`, which enumerates all 80 contexts and asserts that
every table label is reachable and every rendered part is a table label.

### A2 — decision needed

`key-router.ts:178` gates `n` on `!q.multiSelect && state.focusedOptionHasPreview`,
but `state-reducer.ts` reads `notesByTab` for multi answers in two places that can
therefore never be reached. Either:
- **un-gate `n`** (drop the preview condition, allow it on multiSelect), or
- **delete the multi-select notes plumbing.**

### A6 — decision needed

Esc on any question tab cancels the whole questionnaire and discards every answer, with
no confirmation. On a four-question dialog one stray Esc loses everything. Proposal:
Esc in `inputMode` returns to the option list; Esc on a question tab with ≥1 answer
jumps to the submit tab, where Cancel is deliberate. Needs sign-off because it changes
a reflex people already have.

## Carried over from an earlier effort, still open

- **A7 (core-runtime)** — repoint `core-runtime/src/index.ts`'s barrel at the owning
  modules, bump the module count 11 → 14 in
  `.planning/specs/2026-08-15-core-packages-simplification-design.md`, update
  CONTEXT.md. The A1–A6 half of that work did land in PR #1464.

## Corrections to things said in this effort

- **`sweep_branches` is NOT missing a worktree guard.** Reported at the end of the
  #1464 session as a risk; re-checked here and it was a misread of a branch NAME.
  `archify-webui-html` (PR #1458, merged) appeared in `deleteLocal` correctly — the
  `__webui` worktree is on `docs-archify-webui-diagram`, a different branch. The guard
  in `branch-logic.ts:63` fires first among the absolute guards, covers local AND
  remote (`branch-recipe.ts:219,227`), and is covered by
  `tests/branch-logic.test.ts:27,42`. Nothing to fix.
- **schema-cost was never the #1464 merge blocker.** It exits 0 and is correctly
  info-only. The blocker was red main (see above).

## Known-real, filed elsewhere

- `sync-cli --preserve <submodule-path>` is a no-op that still runs its paired
  `stash pop`, applying an unrelated `stash@{0}` into the tree. Work around it with
  `git submodule update <path>` before syncing.
</content>
