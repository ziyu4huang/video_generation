# Neutralize Remaining SQLite-hardcoded Strings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the backend-neutrality pass started in #792: remove the remaining hard-coded "SQLite" from `/memory-sync-markdown`'s sibling user-facing strings in `memory-tool.ts`, align two README lines with the shipped command wording, and add a source-level neutrality guard so a backend token can't silently return to `memory-tool.ts`'s string literals.

**Architecture:** These are edge-case warning strings emitted by the memory tool when the Markdown write succeeds but the search-store mirror sync fails or matches nothing. The store is backend-neutral (the repo is a `MemoryRepository`), so the noun becomes the generic "search store" — no `getLabel` wiring is warranted for warnings (YAGNI; the primary UX label already lives on `/memory-sync-markdown`). A guard test scans the file's string literals for any backend token.

**Tech Stack:** TypeScript + Bun (`bun test`); the package's CI gate is `bun test` (tsc has pre-existing `@types/node` noise — environmental, not a finding).

## Global Constraints
- Change ONLY user-facing/runtime string literals + the matching README prose + the test assertions that lock them. Internal identifiers (`syncAddToSqlite`, `sqliteProjectFor`, …), internal comments, CHANGELOG history, CONTEXT.md, and README architecture prose (accurate for the default SQLite backend) are **out of scope**.
- New noun: "search store" (matches the shipped command's "active search store").
- Run tests via subshell from the package dir; never top-level `cd`.
- Pre-existing `@types/node` tsc errors are environmental — only NEW errors referencing changed symbols would matter.

## File Structure
| File | Action |
|---|---|
| `src/tools/memory-tool.ts` | Neutralize 5 user-facing strings. |
| `tests/tools/memory-tool.test.ts` | Update 2 assertions; add 1 source-level neutrality guard test. |
| `README.md` | Align 2 lines (L33, L373) with the shipped command wording. |

---

## Task 1: Neutralize remaining SQLite strings + neutrality guard

**Files:** `src/tools/memory-tool.ts`, `tests/tools/memory-tool.test.ts`, `README.md`

- [ ] **Step 1: Neutralize the 5 user-facing strings in `src/tools/memory-tool.ts`**

Three identical error-path template literals (in `syncAddToSqlite`, `syncReplaceToSqlite`, `syncRemoveFromSqlite`):
```ts
return `Saved to Markdown, but search store sync failed: ${err instanceof Error ? err.message : String(err)}`;
```
(was: `… but SQLite search sync failed: …`)

Two "no match" literals:
```ts
return "Saved to Markdown, but no matching search store row was updated. Run /memory-sync-markdown if search results look stale.";
```
```ts
return "Saved to Markdown, but no matching search store row was removed. Run /memory-sync-markdown if search results look stale.";
```
(was: `… no matching SQLite memory row was updated/removed …`)

Do NOT touch internal identifiers, comments, or the `sqliteTarget`/`sqliteProject` local vars.

- [ ] **Step 2: Update the 2 locking assertions in `tests/tools/memory-tool.test.ts`** (lines ~302, ~349):
```ts
assert.match(parsed.message, /search store sync failed/);
```
(was: `/SQLite search sync failed/`). Leave test descriptions/comments mentioning "SQLite" alone (they are diagnostics, not product strings).

- [ ] **Step 3: Add the source-level neutrality guard test** in `tests/tools/memory-tool.test.ts`:
```ts
it('memory-tool user-facing strings contain no hardcoded backend token', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'tools', 'memory-tool.ts'),
    'utf-8',
  );
  // Matches sqlite/surrealdb only INSIDE string literals (quoted), ignoring
  // identifiers (e.g. syncAddToSqlite) and comments.
  const backendInLiteral = /['"`][^'"`\n]*(sqlite|surrealdb)[^'"`\n]*['"`]/i;
  assert.ok(
    !backendInLiteral.test(src),
    'memory-tool.ts must not hardcode a backend name inside any string literal',
  );
});
```
(Ensure `fs` and `path` are imported at the top of the test file if not already.)

- [ ] **Step 4: Verify code+test**
```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-tool.test.ts )
```
Expected: all PASS, including the new guard.

- [ ] **Step 5: Commit (code+test)**
```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/tools/memory-tool.test.ts
git commit -m "fix(hermes-memory): neutralize SQLite-hardcoded warnings in memory-tool + add neutrality guard"
```

- [ ] **Step 6: Align README L33 + L373**
L33: `# Backfill older Markdown memories into SQLite search (optional)` → `# Backfill older Markdown memories into the search store (optional)`
L373: `| \`/memory-sync-markdown\` | Backfill Markdown memories into the SQLite search store |` → `| \`/memory-sync-markdown\` | Backfill Markdown memories into the active search store |`

- [ ] **Step 7: Commit (docs)**
```bash
git add bun-apps/pi-agent-ext-hermes-memory/README.md
git commit -m "docs(hermes-memory): align README with backend-neutral /memory-sync-markdown wording"
```

- [ ] **Step 8: Final verify**
```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
```
Expected: all PASS (706+), 0 fail.

## Verification (acceptance)
- `grep -rin "sqlite" src/tools/memory-tool.ts` → matches only in identifiers/comments, never inside a quoted string literal.
- `bun test` green.
- README L33/L373 match the shipped command's "search store" noun.
