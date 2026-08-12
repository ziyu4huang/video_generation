---
name: pre-plan-runtime-validation
description: Validate verbatim plan code against the REAL runtime (store round-trip, API response shape, persisted DB columns, side-effects) BEFORE the plan ships. Use when finalizing or reviewing a plan whose verbatim implementation code reads a store/repository/database field, calls an external API or library, or assumes runtime behavior (persistence, round-trip, side-effects) that is not yet proven — especially before an SDD/TDD effort begins and before any verbatim code is handed to an implementer. Prevents η-class failures where a plan assumes a field round-trips but the store silently drops it, making the feature a silent no-op until a real-store test catches it mid-effort.
---

# Pre-Plan Runtime Validation

Validate verbatim plan code against the **real runtime** before the plan ships — not discovered mid-implementation.

## When to use

Use when finalizing or reviewing a plan whose verbatim implementation code does any of:

1. reads a field from a store / repository / database (e.g. `store.getCard(id).graph.relations`),
2. calls an external API or library, or
3. assumes runtime behavior (persistence, round-trip, side-effects) that isn't proven.

**Especially** before an SDD/TDD effort begins, and before any verbatim code is handed to an implementer. The cost of catching a wrong runtime assumption here is minutes; the cost of discovering it mid-effort is a multi-task structural correction.

## The η lesson (why this skill exists)

In the 10-impl staleness effort (PR #1242), the plan's verbatim code assumed `store.getCard(id).graph.relations` round-trips through the store. The `06a` store documents `card.graph` as a **type member** but does **NOT persist it** — `getCard(id).graph` is always `undefined`, so the staleness feature was a **silent no-op**. It was only caught mid-effort by a real-store round-trip test (the "η" correction), which then propagated as a structural fix across 4 tasks.

This is a **recurring class of failure**. The memory store already records it as a tool-quirk: *"TDD from fresh in-memory state CANNOT surface store-persistence gaps."* The fix is structural: validate verbatim plan code against the real runtime before the plan ships.

## Procedure

1. **Enumerate.** List every verbatim code block in the plan that touches a store / API / runtime.
2. **Surface the implicit assumption.** For each, name the implicit runtime assumption — e.g. "`getX().field` round-trips through the store", "API call returns shape `Y`", "field is persisted on write".
3. **Smoke-check against the REAL system.** Spin up a real (temp) store/DB, **write** the entity, **read** it back, and confirm the field round-trips; or call the actual API and inspect the real returned shape. **Do NOT accept in-memory object construction as evidence** — constructing a card/object in memory and asserting on it proves nothing about persistence.
4. **Fix the PLAN before it ships.** If an assumption fails (field not persisted, shape differs, side-effect absent), fix the plan's verbatim code (and the design) *before* the plan ships — not discovered mid-implementation.
5. **Record results in the plan.** Add a short "**Runtime assumptions verified**" note to the plan, citing each smoke check (what was written, what was read back, the actual shape).

## Pitfalls

- **In-memory construction hides persistence gaps.** (η: the `06a` store documents `card.graph` as a type member but does not persist it — `getCard().graph` is always `undefined`; the staleness feature was a silent no-op until a real-store round-trip test caught it mid-effort, forcing a 4-task structural correction.)
- **A test's parser/serializer may differ from production.** A naive YAML splitter used in a test can hide malformed-input errors that the real `Bun.YAML` parser (or production serializer) would surface. Validate against the real parser/serializer, not a hand-rolled stand-in.
- **Type definitions describe the TYPE, not the persisted columns.** Verify the actual `SELECT`/`INSERT` columns and the `rowToCard` / mapping code, not just the `.d.ts` / interface. A field can exist on the type and be entirely absent from the schema.
- **Don't trust the plan author's (or a prior session's) claim** that a field round-trips. Re-verify against the **current** code — stores drift, migrations land, mappings change.

## Verification (done before the plan ships)

- Each store-touching verbatim code block, when extracted and run against a real temp store, produces the documented behavior.
- Specifically: every `getX().field` in the plan's code actually round-trips through the real store (write → read-back yields the value).
- The plan includes a "**Runtime assumptions verified**" note citing the smoke checks.
- No runtime assumption in the plan rests solely on in-memory object construction or an unverified type definition.
