# Spec — hermes-memory failure lifecycle (`state` + `severity`)

- **Date:** 2026-08-02
- **Status:** design (pending plan)
- **Scope:** single spec → single plan → single implementation cycle (full scope)
- **Source:** research findings at
  `.planning/2026-08-02-try-to-checkout-code-use-gh-and-learning-from-ht/findings.md` §2
  (UPSP "Immune" lifecycle pattern, adapted).

## 1. Problem

`failures.md` is a flat list. Every entry — a transient bad model output, a resolved lesson,
a permanent `tool-quirk`/`convention` environment fact — sits side by side with the same
implicit status. Concretely:

- **Injection is date-only.** `getRecentFailures` (`sqlite-memory-repo.ts:805`,
  `surreal-memory-repo.ts:881`) and the snapshot's `getFailureEntries`
  (`memory-store.ts:1190`) filter `target='failure' AND created >= cutoff`. A failure we
  *fixed* two days ago is still injected; a `tool-quirk` we've known for months is still
  injected if its `created` is recent.
- **No lifecycle.** There is no way to mark a failure "resolved" (we have a fix) or
  "acquired" (it's now a permanent known constraint). `memworth.fail` counts up forever.
- **`tool-quirk`/`convention` accumulate.** They are reference material, not "recent failures
  to avoid," yet they compete for the same injection slots and char budget as live failures.

## 2. Goal / non-goals

**Goal.** Give failure entries a lightweight lifecycle so the injected prompt surfaces only
what is still *active*, lets fixed/transient failures retire, and lets permanent facts
graduate out of injection — without a new container or data movement.

**Non-goals (explicitly out of scope for v1):**
- No automatic transitions (no age-out timer, no recurrence-reactivation). Transitions are
  manual. Automation is a possible v2.
- No 8-file persona split (UPSP's `birth/chronic/transplant/surgery/...`). One `state` field.
- No `severity`-based injection ranking. `severity` is advisory-only for v1.
- No moving `acquired` entries out of `failures.md`. They stay; the injection filter excludes
  them.
- No new config flags (the existing `failureInjectionMaxAgeDays` / `MaxEntries` still apply,
  now over the `active`-only subset).

## 3. Design

### 3.1 Storage (follows the established `category` / `status` pattern)

- `state` and `severity` are **frontmatter fields** — the markdown source of truth, alongside
  `id` / `created` / `last` / `provenance` / `sources` / `memworth`. They are
  **failure-target-specific**: present only on `target='failure'` entries, omitted for
  `memory`/`user` (same as the failure body segments).
- They are **mirrored to DB columns** (`state TEXT`, `severity INTEGER NULL`) on both
  backends (SQLite + Surreal), so injection filtering is a cheap indexed `WHERE` rather than
  a parse-and-filter. Same shape as `category` (body-derived + DB column) and `status`
  (DB column for supersession).
- The runtime `MemoryEntry` carries `state` and `severity` so they flow through
  `getRecentFailures` → snapshot → injection.

Encoding example (failure entry frontmatter):
```
---
id: <uuid>
created: 2026-08-02
last: 2026-08-02
state: active
severity: 2
---
[failure] The lock retry path swallows ELOCKED — Failed: op aborted — Tool state: lockfile held — Corrected to: bump lockOpRetries
```

### 3.2 States

| `state` | injected? | `memworth.fail` | searchable? | semantics |
|---|---|---|---|---|
| `active` | ✅ (recent + capped) | counts up on recurrence | yes | still biting |
| `resolved` | ❌ | **frozen** (stops counting) | yes | we have a fix/workaround; may recur |
| `acquired` | ❌ | **frozen** | yes (on-demand via search) | permanent known constraint; stays in `failures.md` |

- **`severity`** (`1` minor / `2` notable / `3` critical, optional, nullable): advisory only
  for v1. It does **not** gate injection and does **not** rank within the cap. (A later v2
  may rank `active` entries by severity within `failureInjectionMaxEntries`.)

### 3.3 Transitions — manual only

No automatic state changes. An entry moves between states only when explicitly set, via any
of:
1. **`memory_tool`** — optional `state` / `severity` params on add and edit.
2. **Review ops** — `applyReviewOperations` accepts `state` (mirrors how it already accepts
   `category`).
3. **Direct frontmatter edit** — a human edits the `.md`; the startup mirror
   (`syncMarkdownMemories`) syncs the new `state`/`severity` to the DB. Idempotent.

Default on add (when `state` not supplied): inferred from category (see 3.4).

### 3.4 Defaults + backfill (category-inferred)

**New entries** default `state` by category when `state` is not explicitly supplied:
- `failure` / `correction` → `active`
- `tool-quirk` / `convention` → `acquired`   (born permanent)
- `insight` / `preference` → `active`

**Backfill** the ~40 existing `failures.md` entries by the same mapping. Idempotent and
safe — identical in shape to the 5d stable-id backfill:
- For each failure entry whose frontmatter has **no `state`** (legacy), set `state` to the
  category-inferred default and mirror to the DB column.
- If `state` is already present (set by backfill or manually), **leave it** — backfill never
  overwrites an explicit state. (This is what makes re-running safe.)
- `severity` is left unset on backfill (truly optional; no inference).

### 3.5 Injection change (the #1 win)

Add `state = 'active'` to the filter in **both** injection code paths and **both** backends:
- Snapshot path: `memory-store.ts` `getFailureEntries(maxAgeDays)` → keep only `state==='active'`.
- Repo path: `sqlite-memory-repo.ts:805` and `surreal-memory-repo.ts:881` `getRecentFailures`
  → add `AND state = 'active'` to the WHERE.

Net effect on day-1: `resolved` failures and `tool-quirk`/`convention` (backfilled to
`acquired`) stop being injected. The existing `failureInjectionMaxAgeDays` /
`failureInjectionMaxEntries` still apply, now over the `active`-only subset.

### 3.6 `memworth.fail` freeze

Once `state` transitions out of `active` (to `resolved` or `acquired`), the `memworth.fail`
counter **freezes** — subsequent recurrence-detection no longer increments it for that entry.
`memworth.success` is unaffected. (Rationale: a resolved/acquired entry is no longer "a thing
that fails"; counting its recurrences is noise.)

## 4. Components touched

| File | Change |
|---|---|
| `src/types.ts` | Add `state`/`severity` to the failure-entry shape + `MemoryEntry`; add `state`/`severity` to review-op type (mirrors `category`). |
| `src/store/memory-format.ts` | Parse/encode `state`/`severity` in frontmatter (`parseMetadataFrontmatter` + the encode side); validation (state ∈ {active,resolved,acquired}; severity ∈ {1,2,3}). |
| `src/store/memory-store.ts` | `getFailureEntries` filters `state==='active'`; default-state-by-category on add; freeze `memworth.fail` on transition. |
| `src/store/sqlite/sqlite-memory-repo.ts` | Add `state`/`severity` columns + migration; `getRecentFailures` adds `AND state='active'`; mapRow carries the fields. |
| `src/store/surreal/surreal-memory-repo.ts` | Same as SQLite ( Surreal side): columns, `getRecentFailures` filter, mapping. |
| `src/store/repository.ts` | Surface `state`/`severity` on `MemoryEntry` / list-row types. |
| `src/handlers/review-memory-ops.ts` | Accept `state` in ops (mirrors `category` handling). |
| `src/tools/memory-tool.ts` | Optional `state`/`severity` params on add/edit. |
| backfill/migration module (wherever the stable-id backfill lives) | Idempotent `state` backfill by category (frontmatter + DB). |

No `config.ts` changes (no new flags).

## 5. Data flow

- **Add/edit** → write `state`/`severity` to frontmatter (or infer default) → mirror to DB
  column on sync.
- **Inject** → `getFailureEntries` / `getRecentFailures` return only `state='active'`, recent
  by date, capped → rendered into the prompt block.
- **Startup / backfill** → for failure entries with no `state`, infer from category, write to
  frontmatter + DB. Idempotent.
- **Search** — `acquired`/`resolved` entries remain consultable on-demand via `memory_search`
  (general search returns entries regardless of state). `getRecentFailures` is injection-scoped
  and **always** filters `state='active'`; it is not a "show all" path.

## 6. Migration / rollout

1. **Schema migration** (SQLite + Surreal): add `state TEXT` (default `'active'`) and
   `severity INTEGER NULL` columns.
2. **Idempotent backfill**: set `state` by category on failure entries whose `state` is unset.
3. **Dry-run verification** (risk mitigation — see §8): before relying on the injection
   filter, log/report how many entries move to each state and **which `active` candidates
   would stop injecting**, so a mis-mapping can't silently hide a live failure.

## 7. Error handling

- **Invalid/missing `state`** → treat as `'active'` (safe default — never silently hide a
  failure). Validation logs a warning, coerces to `active`.
- **Invalid `severity`** → drop (null). No coercion to a default.
- **Backfill idempotency** → only writes `state` when unset; never overwrites an explicit
  value. Re-running is a no-op.
- **Frontmatter/DB drift** → the startup mirror reconciles (DB ← frontmatter) on sync, as it
  already does for `id`/`memworth`.

## 8. Risks

- **Injection filter changes prompt contents** (highest risk). A mis-mapped backfill could
  stop surfacing a genuinely-active failure. **Mitigation:** the dry-run report (§6.3) +
  defaulting missing/invalid `state` to `active` (§7) means the only way an entry stops
  injecting is an *explicit, correct* `resolved`/`acquired` mark or a correct category-based
  backfill — both auditable.
- **Two injection code paths** (snapshot `getFailureEntries` + repo `getRecentFailures`).
  Both must get the filter; a miss means one path still leaks non-`active` entries. Covered
  by tests on both.
- **`memworth.fail` freeze semantics** are a behavior change for resolved/acquired entries.
  Low risk (counters are advisory), but noted.

## 9. Testing

- **Format**: parse/encode `state`+`severity` in frontmatter; round-trip; omission when unset;
  validation/coercion of bad values.
- **Backfill**: category→state mapping (failure/correction→active;
  tool-quirk/convention→acquired; insight/preference→active); idempotent re-run is a no-op;
  explicit `state` is never overwritten.
- **Injection filter**: `getFailureEntries` (snapshot) and `getRecentFailures` (SQLite + Surreal)
  both exclude `resolved`/`acquired`; keep `active` within age + cap.
- **`memworth.fail` freeze**: transitioning `active`→`resolved`/`acquired` stops the counter;
  `active` entries still count.
- **Defaults**: new entries get category-inferred `state` when none supplied; explicit `state`
  param overrides.
- **Migration**: adding columns is safe on an existing DB; backfill runs once, idempotent.

## 10. Deferred / open

- Auto age-out + recurrence-reactivation (v2, if ever).
- `severity`-based ranking within the injection cap (v2).
- Separate append-only `errors.log` for raw `errorCapture` traces (orthogonal; the findings'
  §2 "alerts.md" idea — separate effort).
