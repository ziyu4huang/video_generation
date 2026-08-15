---
type: grilling
status: open
blocked by:
---
# 02 — ask-user TUI side-car review (core-task)

Read-only review of `bun-apps/pi-agent-ext-core-task/src/ask-user/` (2026-08-16). The
module split (state / view / tool, pure reducer) is sound — every finding below is in
the **hint layer and the mode semantics**, not the architecture.

**No code changed in this effort.** A2 and A6 need a decision before implementation.

## A1 · HIGH — the footer literally prints `n n to add notes`

`view/dialog-builder.ts:187`

```ts
if (state.focusedOptionHasPreview) hintParts.push(`n ${t(HINT_PART_NOTES)}`);
//                                                 ^            ^ = "n to add notes"
```

Renders `n n to add notes` under `en`, `n n 新增備註` under `zh-TW`. Fires on every
question whose focused option carries a preview.

## A2 · HIGH — notes are unreachable for multi-select, but the reducer plumbs them

`state/key-router.ts:178` gates the `n` key on
`!q.multiSelect && state.focusedOptionHasPreview`. Yet `state-reducer.ts` reads
`notesByTab` for multi answers in two places (`persistMultiSelectAnswer:78`,
`multiConfirmHandler:177`). Those branches can never be reached.

Tying notes to preview presence is also arbitrary — a user may well want to annotate a
plain option.

**Decision needed:** un-gate `n` (drop the preview condition, allow on multiSelect), or
delete the multi-select notes plumbing.

## A3 · MEDIUM — the collapse hint is defined, translated, tested, and never shown

`HINT_PART_COLLAPSE = "Ctrl+] to collapse"` exists in `dialog-builder.ts:29`, has a
`zh-TW` entry (`i18n-dictionaries.ts:59`) and an assertion
(`i18n-bridge.test.ts:59`) — but `buildHintText` never appends it. The affordance is
invisible until after the user has already discovered it; `COLLAPSED_HINT` only appears
once collapsed.

## A4 · MEDIUM — the collapse key is configurable, the hint is hard-coded

`config.ts:123 resolveCollapseKey` accepts any spec (e.g. `alt+o`), but
`HINT_PART_EXPAND` / `COLLAPSED_HINT` hard-code `Ctrl+]`. Configure `alt+o` and the
collapsed line says "Ctrl+] to expand" (wrong) while
`ask-user-question.ts:135`'s notify says "alt+o" (right). Two sources of truth.

## A5 · MEDIUM — a dead second hint vocabulary

`HINT_SINGLE`, `HINT_MULTI`, `HINT_MULTISELECT_SUFFIX`, `HINT_NOTES_SUFFIX` are
exported and used nowhere. The comment at `dialog-builder.ts:182` records that
`HINT_MULTISELECT_SUFFIX` "existed but was never appended" — the bug was fixed by
inlining, the constant stayed, and the same trap is now armed for `HINT_NOTES_SUFFIX`
(it is A1's near-miss twin).

Root cause shared with A1/A3/A4: `buildHintText` hand-assembles the footer with
if-push, while a parallel constant table pretends to be the vocabulary. One table of
`{ key, condition, label }` driving the render would collapse all four.

## A6 · MEDIUM — Esc is asymmetric and destructive

| Mode | Esc does |
|---|---|
| `notesVisible` | leave notes (non-destructive) |
| `inputMode` | **cancel the entire questionnaire** |
| any question tab | **cancel the entire questionnaire**, discarding every answer, no confirmation |

On a four-question dialog, one stray Esc loses everything.

**Decision needed:** proposal is Esc-in-inputMode returns to the option list, and Esc on
a question tab with >=1 answer jumps to the submit tab (where Cancel is an explicit,
deliberate choice) instead of aborting.

## A7 · MEDIUM — single-select answers are not restored on tab switch

`state-reducer.ts:97 switchTabResult` always resets `optionIndex: 0`, but restores
multi-select ticks via `syncMultiSelectFromAnswers`. So revisiting an answered
**multi**-select tab shows your ticks; revisiting an answered **single**-select tab puts
the cursor on row 0 with no indication of what you chose. Fix: derive `optionIndex` from
the saved answer's label.

## A8 · LOW — view state flows back into the "canonical" reducer state

`questionnaire-session.ts:125 mirrorNotesDraft` reads `notesInput.getValue()` after
every commit and writes it into `state.notesDraft`. Combined with the
`forward_notes_keystroke` effect this is a round trip, and it means the reducer is not
the single source of truth for the field `state.ts` says it owns.

## A9 · LOW — multi-select submit is hard to discover

`key-router.ts:200`: Enter on an ordinary row toggles; only the `next` sentinel commits.
The footer reads "Enter to select · Space to toggle", which implies Enter submits.
Suggest "Enter/Space to toggle · Next to confirm".
