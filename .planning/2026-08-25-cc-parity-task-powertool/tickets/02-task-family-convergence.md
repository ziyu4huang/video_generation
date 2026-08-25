# Ticket 02 — Task-family convergence + todo CC semantics

Status: pending

## Why

Two model-visible task families exist: ext-task's `todo` mega-tool and
ext-subagent's `task_create/get/list/update` over TeamTaskStore. In workflow
sessions the model sees BOTH with overlapping vocabulary and no shared
state. The `todo` half is also missing CC semantics: deps never "resolve"
(completed deps still render `⛓ #1`), edges are one-way (no addBlocks),
`activeForm` promises a spinner that doesn't exist, the workflow-discipline
rules are absent from the description, and tool errors are not flagged
`isError`.

## Scope

1. **Convergence decision (first, in-ticket)**: pick ONE model-visible
   family. Options measured in the review: (a) split `todo` into four
   CC-shaped tools (`todo_create/update/list/get` — each with a flat
   `type:"object"` root; the z.ai-GLM `anyOf` constraint survives per-tool),
   keeping the session-scope + widget + per-session buckets; or (b) converge
   on the TeamTaskStore `task_*` family and reduce `todo` to a TUI face.
   Decide by: session-vs-team scope fit, stealth-trim guard, widget/overlay
   reuse, and what workflow sessions actually need on screen. Record the
   decision as a map D-entry + spec.md §1 update. The OTHER family becomes
   TUI-only or is deleted (D4).
2. **Effective-blocked semantics**: a selector computing blockedBy minus
   completed/deleted deps; `list` lines and the overlay render resolved deps
   as cleared (or drop them). Pin with table-driven tests.
3. **Symmetric edges**: `addBlocks`/`removeBlocks` mirroring the kept
   family's existing link/unlink pattern (task-tools.ts:78-83 if (b) wins).
4. **Workflow-discipline description text** (kept family): the three CC
   rules — mark in_progress before starting; completed only when fully done
   (never with failing tests); when blocked, keep in_progress and create a
   NEW task describing the blocker. In the description, not a restored
   snippet (stealth-trim guard stays green).
5. **activeForm**: wire the in_progress activeForm into the composite
   widget's active line (or the goal status line) — or reword the field
   description to stop overpromising. Prefer wiring.
6. **isError envelopes**: reducer/validation errors return `isError:true`
   tool results; ask-user validation failures stop setting `cancelled:true`
   (the user never cancelled). Check goal's `event.isError` retry keying
   (hooks.ts:201) still behaves.
7. **ask-user overuse guideline**: one line — only ask when the decision is
   genuinely the user's and changes what happens next; otherwise pick a
   sensible default and mention it.

Not in scope: session-only todo semantics (stay); wayfind/ticket
integration; the plan coordinator.

## Done-when

- [ ] Exactly ONE model-visible task family in every session shape
      (workflow + plain), test-pinned.
- [ ] Effective-blocked, symmetric edges, discipline text, isError,
      activeForm all landed on the kept family.
- [ ] Canonical gates green; spec.md §1 rows updated; PR merged CLEAN.
