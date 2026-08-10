# Task 2 Report — content-hash + sync-state accessors (09-impl T2)

**Status:** DONE
**Commit:** `62950249` — `feat(knowledge-pipeline): planning content-hash + sync-state accessors (09-impl T2)`
**Branch:** `knowledge-pipeline/09-impl-planning-sync` (HEAD `62950249`, parent `a8c9817f` T1)

## What was implemented

Three in-scope files, exactly as the brief specified — pure content-hash + thin sync-state accessors reading/writing the T1 `card_md_hash` table.

1. **`src/store/planning-sync-state.ts`** (NEW, 62 lines) — the pure layer:
   - `planningContentHash(card: Card): string` — `hashEntry(canonicalCardBytes(card))`, reusing `merge-plan.hashEntry` (16-hex sha256). NOT reinvented.
   - `canonicalCardBytes(card)` — the **PINNED** canonical byte form (see diff hunk below).
   - `sortKeysDeep(value)` — recursive key-sort for deterministic JSON (frontmatter key order is NOT stable across runs; arrays left in serializer order).
   - `getStoredHash` / `upsertHash` / `deleteHash` — thin wrappers delegating to the new `CardStore` accessors.
2. **`src/store/card-store.ts`** (MODIFIED, +42) — extended `CardStore` interface with `getCardMdHash` / `upsertCardMdHash` / `deleteCardMdHash` (additive, after `serializerFor`) and implemented them on the `store` object with the SAME `runWithTransientRetry(() => backend.withCorruptionRecovery(() => …))` envelope as `getCard`/`upsertCard`. SQL: `SELECT/INSERT…ON CONFLICT DO UPDATE/DELETE` against `card_md_hash`, keyed by `card_id`; UPSERT stamps `mirrored_at = today()`.
3. **`src/store/planning-sync-state.test.ts`** (NEW, 85 lines) — the brief's test verbatim.

## Key diff hunks

### Canonical byte form (`planning-sync-state.ts`, the pinned formula)
```ts
function canonicalCardBytes(card: Card): string {
  return JSON.stringify({
    kind: card.kind,
    content: card.content,
    frontmatter: sortKeysDeep(card.frontmatter),
  });
}
```
`hashEntry` returns the 16-hex sha256 of that string; `planningContentHash` is `hashEntry(canonicalCardBytes(card))`. Key-order-invariant via `sortKeysDeep`; content/frontmatter-value-sensitive.

### One CardStore accessor envelope (`card-store.ts`)
```ts
upsertCardMdHash(cardId: string, hash: string, kind = "mirror"): Promise<void> {
  return runWithTransientRetry(() =>
    backend.withCorruptionRecovery(() => {
      getDb()
        .prepare(
          `INSERT INTO card_md_hash (card_id, content_hash, mirrored_at, kind)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(card_id) DO UPDATE SET
             content_hash = excluded.content_hash,
             mirrored_at = excluded.mirrored_at,
             kind = excluded.kind`,
        )
        .run(cardId, hash, today(), kind);
    }),
  );
},
```
Identical envelope to `getCard`/`upsertCard`. `getCardMdHash` maps the row → `{ hash, mirroredAt, kind }` (or `null`); `deleteCardMdHash` is a parameterized `DELETE`.

## TDD evidence

### RED (before implementation) — right reason
```
$ bun test src/store/planning-sync-state.test.ts
error: Cannot find module './planning-sync-state.js' from '.../planning-sync-state.test.ts'
 0 pass
 1 fail
```
Confirmed RED for the exact reason the brief predicted (module did not exist; `getCardMdHash` not yet on `CardStore`).

### GREEN (after implementation)
```
$ bun test src/store/planning-sync-state.test.ts
src/store/planning-sync-state.test.ts:
(pass) planningContentHash > is deterministic for identical content + frontmatter [0.18ms]
(pass) planningContentHash > is 16 hex chars (hashEntry width) [0.06ms]
(pass) planningContentHash > changes when content changes [0.03ms]
(pass) planningContentHash > is invariant to frontmatter key ORDER (stable stringify) [0.02ms]
(pass) planningContentHash > changes when a frontmatter VALUE changes [0.02ms]
(pass) card_md_hash round-trip (via CardStore accessors) > getStoredHash returns null when absent [10.24ms]
(pass) card_md_hash round-trip (via CardStore accessors) > upsertHash then getStoredHash round-trips (default kind='mirror') [3.39ms]
(pass) card_md_hash round-trip (via CardStore accessors) > upsertHash is idempotent UPSERT (re-write overwrites hash + mirrored_at) [2.56ms]
(pass) card_md_hash round-trip (via CardStore accessors) > deleteHash removes the row [2.41ms]
 9 pass
 0 fail
```
All 9 tests pass (5 hash-property + 4 round-trip).

## Full-suite gate

```
$ bun run check            # tsc --noEmit — clean (zero diagnostics)
$ bun test                 # full package
 1420 pass
 1 skip
 1 fail
 Ran 1422 tests across 122 files. [13.73s]
```

- Baseline-after-T1 was **1411 pass / 1 skip / 1 fail**. Now **1420 pass / 1 skip / 1 fail** → **+9 passing** exactly equals the 9 new T2 tests. **Zero new failures, zero new skips.**
- The single failure is the known pre-existing ticket-04 date-aging time-bomb: `formatForSystemPrompt never emits memworth (memory + failure blocks — regression pin)` at `tests/store/memory-store.test.ts:2630` — UNRELATED to this task, untouched (confirmed by name + that it fails identically in isolation `bun test tests/store/memory-store.test.ts`).

## Self-review

- ✅ `planningContentHash` is deterministic, 16-hex (`/^[0-9a-f]{16}$/`), content-sensitive, frontmatter-key-order-INVARIANT, frontmatter-value-sensitive — all 5 properties asserted.
- ✅ The 3 store accessors round-trip against `card_md_hash`: read-null-when-absent → upsert → read-back (hash + default `kind='mirror'` + `mirroredAt` set) → idempotent UPSERT overwrite → delete-then-null.
- ✅ Reused `hashEntry` from `merge-plan.ts` (no reinvented hashing). Reused `today` from `memory-format.ts` (returns `YYYY-MM-DD`, DATE-compatible for `mirrored_at`).
- ✅ Matched the existing `runWithTransientRetry(() => backend.withCorruptionRecovery(...))` envelope of `getCard`/`upsertCard` exactly.
- ✅ Interface extension is additive (3 new methods after `serializerFor`); no change to existing `CardStore` members, serializers, or dedup registries.
- ✅ Strict git discipline: staged only the 3 in-scope files by explicit path; the `.planning/.../sdd/` scratch dir stayed untracked/off-limits; exactly ONE commit.
- ✅ `kind` discriminator column already present (T1) so 10-impl can add `kind='validated'` rows with no migration; `upsertHash` defaults `kind='mirror'` per brief.
- ✅ `canonicalCardBytes` omits `Card.embed`/`Card.graph` deliberately (per brief: Tier-1 md-canonical fields = content + frontmatter + defensive `kind` only). These are not persisted/indexed in 06a anyway.

## Concerns

**One verbatim-typo deviation in the test file (documented, faithful to DoD).**
The brief's test code uses `after(() => rmSync(dir, …))` for the round-trip suite's best-effort cleanup, but its `node:test` import line is `import { describe, it } from "node:test";` — `after` is NOT imported. As written, the round-trip `describe` block throws `ReferenceError: after is not defined` at registration time, so none of the 4 round-trip tests would ever run (only the 5 pure hash-property tests would pass). That would violate the DoD ("the 3 store accessors round-trip against `card_md_hash`").

Resolution: added `after` to the import list — `import { after, describe, it } from "node:test";` — a single-word addition. Every other line of the test, and every assertion, function signature, and the canonical-bytes formula, is byte-identical to the brief. This honors the DoD over a copy-paste typo in the spec; flagged here for visibility. (Under Bun's `node:test` shim, `after` is a named export of `node:test`; once imported it runs cleanup correctly and the temp dir is removed.)

No other concerns. T3 (mirror UPDATE path) and T7 (on-demand refresh) can consume `planningContentHash` + `getStoredHash`/`upsertHash`/`deleteHash` as-is.
