# Wayfinder map: 2026-07-26-brainstrom-to-improve-wayfind-superpowers-hand-o

## Destination

Improve the **wayfind → superpowers hand-off**. Resolved via grilling to a
**clarification** (not a refactor): `task_plan.md` is a human-readable preview,
not the plan coordinator's execution substrate. **Closed inline** — no ticketed
decision map was warranted (grilling-sized, per wayfinder step 3).

## The finding (why this wasn't a non-issue)

The documented round-trip — `/wayfind seed` → `task_plan.md` → "execute via SDD" →
`/wayfind sync` closes tickets — **does not work through task_plan.md**:

- The plan coordinator's `discoverActivePlan` reads `.planning/<effort>/plans/*.md`
  (writing-plans output), **never `task_plan.md`**; `parsePlan` is never called on it.
- So executing the `task_plan.md` seed tracks/closes **nothing**. The round-trip
  only closes tickets when execution runs **writing-plans → `plans/*.md` → SDD**.
- `task_plan.md` was effectively **orphaned**: produced by seed, referenced in ~12
  places as "the coordinator's execution substrate / consumed by parsePlan /
  execute the plan", but **nothing tracked or consumed it**.

## Decisions (resolved by grilling, one question at a time)

1. **Pain** = the coarse-vs-fine granularity gap: `task_plan.md` steps are coarse
   acceptance criteria, not the bite-sized TDD steps SDD wants.
2. **Fix shape** = clarify the model + fix the misleading pointer (smallest,
   honest) — not "collapse writing-plans into seed" or "build a new bridge".
3. **`task_plan.md` fate** = demote to a **human-readable preview** (kept; not
   tracked, not executed). The real tracking artifact is `plans/*.md`.
4. **`/wayfind seed` fate** = **kept** — it produces the preview. Execution runs
   ② ticket → writing-plans → `plans/*.md` → SDD → `/wayfind sync` (closes tickets
   via `plans/*.md` phases).

## Outcome (executed inline, not handed off)

This was small + clear after grilling, so it was **executed directly** (no
writing-plans/SDD handoff needed — docs/comments/skill-text only, no behavior
change). Two commits landed:

- **`d43be805`** (`video_generation__superpowers`): corrected ~12 misleading
  claims across wayfind (`chain.ts`, `commands.ts`, `grill.ts`,
  `to-tickets`/`grill-me-with-docs` SKILL.md, `README.md`) + core-task
  (`goal/prompts.ts`). wayfind 177 + core-task 530 tests pass.
- **`c15bfa1`** (`study-news`): aligned the Wayfind × Superpowers SOP
  (Stage 5a, artifact map, three hand-off table, + a 實況校正 correction note).

## Out of scope

- **Wiring `task_plan.md` into the coordinator** (making seed's output actually
  tracked) — a real alternative if a wayfind-side tracking loop is ever wanted;
  deliberately not chosen (the `plans/*.md` path already tracks execution).
- **Deprecating `/wayfind seed`** — seed is kept as the preview producer.
