# spec — hermes-memory numeric isolation (UPSP §7, DO ticket 04)

> **Reality check (verified 2026-08-02, per D1 hardening).** The ticket's
> "translate `memworth{success,fail}` into prose bands" premise is **moot**:
> the existing design **strips** memworth entirely from every prompt render
> path — it never surfaces it, in any form. So there is nothing to *translate*.
> What IS real are two verified gaps the ticket's spirit (numeric isolation +
> validated-edit-only) points at — this spec fixes those, not a prose-bander.

## Destination

Close the two verified numeric-isolation / validated-edit gaps:

**A. Project block leaks raw frontmatter (incl. `memworth`).**
`formatProjectBlock` → `renderProjectBlock(projectName, this.memoryEntries)`
joins **raw** entries — the YAML frontmatter (`id`, `created`, `last`, `state`,
`severity`, `pin`, `provenance`, `sources`, **`memworth`**) is fenced verbatim
into the prompt. The sibling render paths already strip:
- memory/user block: snapshot built via `stripMetadata` (`memory-store.ts:445-446`) → body only.
- failure block: `getActiveFailureEntries` → `stripMetadata` → body only.
Only the project block forgot to strip. Fix = consistency (strip there too).

**B. Policy prompt lacks the validated-edit rule.** `MEMORY_POLICY_PROMPT` /
`_COMPACT` never state that the agent edits memory **only** through the memory
tools, never by mutating the `.md` source directly. Add the rule.

## Verified code sites (no assumed mappings)

- `src/store/memory-store.ts:1290` — `formatProjectBlock(projectName)` → calls
  `renderProjectBlock(projectName, this.memoryEntries)` with **raw** entries.
- `src/store/memory-store.ts:1534` — `renderProjectBlock(projectName, entries)`
  joins `entries` verbatim (`entries.join(ENTRY_DELIMITER)`).
- `src/store/memory-store.ts:1435` — `stripMetadata(text) = decodeEntry(text).text`
  → returns the **body only** (frontmatter removed), the isolation primitive.
- `src/store/memory-store.ts:1500` `renderBlock` + `:1546` `renderFailureBlock` —
  siblings that receive already-stripped input (correct precedent).
- `src/constants.ts:62` `MEMORY_POLICY_PROMPT`, `:122`
  `MEMORY_POLICY_PROMPT_COMPACT` — neither carries the tool-envelope rule today.

## Design

- **Gap A** — in `formatProjectBlock`, map entries through `stripMetadata` before
  rendering (mirrors how `loadFromDisk` pre-strips the snapshot at `:445-446`).
  One-line change at the call site; `renderProjectBlock` keeps its signature.
- **Gap B** — add one concise "Memory integrity" line to **both** policy prompts
  (full + compact): edit memory only via the memory tools, never by directly
  mutating the `.md` source (raw edits bypass validation, dedup, and the
  DB↔`.md` sync).

## Acceptance

1. `formatProjectBlock` on a store holding a memworth-bearing frontmatter entry
   emits the entry **body** but **no** `memworth` / `mwSuccess` / `mwFail` /
   frontmatter literals.
2. `formatForSystemPrompt` (memory + failure blocks) never emits `memworth`
   (regression pin — already true, now guarded).
3. Full `buildPromptContext` assembly contains no `memworth` literal.
4. Both `MEMORY_POLICY_PROMPT` and `MEMORY_POLICY_PROMPT_COMPACT` contain the
   validated-edit (tool-envelope, no raw-source-mutation) rule.

## Implementation units (file-scoped, satisfies D2 gate)

| Unit | File | Scope |
|---|---|---|
| Strip project block | `src/store/memory-store.ts` (EDIT `formatProjectBlock` `:1290`) | `stripMetadata` map before `renderProjectBlock` |
| Policy rule | `src/constants.ts` (EDIT both prompts `:62`, `:122`) | one "Memory integrity" line each |
| Isolation tests | `tests/store/memory-store.test.ts` (EDIT) | project-block isolation + memory-block pin |
| Policy-rule test | `tests/handlers/prompt-context.test.ts` (EDIT) | assert rule in both prompts |

## Out of scope (explicit follow-ups, not leaks)

- **Prose-band translation** of `memworth` — moot (design strips, doesn't surface).
  Reopens only if a future decision deliberately surfaces memworth *as* signal.
- **`entriesWithMeta`** (`:1318`) exposes `mwSuccess`/`mwFail` — intentionally;
  it feeds the internal staleness audit / consolidation, NOT prompt assembly.
- **Failure-block memworth surfacing** — already stripped; nothing to do.
