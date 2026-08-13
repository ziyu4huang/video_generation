# Task 3 Report — `survivingK` config knob (ticket 19 T3, LeanRAG ③)

**Ticket:** 19 — LeanRAG redundancy-aware retrieval, dedup-first slice (final task)
**Package:** `bun-apps/pi-agent-ext-hermes-memory`
**Branch:** `feat/kp-19-leanrag-redundancy-aware-retrieval`
**BASE (Task 3):** `4a73e87f` (chore: kp-19 T2 report — Task 3 sits on top of this)
**Impl commit:** `fbe6d08d` — `feat(hermes-memory): add survivingK cap knob to semantic search (kp-19 T3)`
**Status:** DONE

---

## What was implemented

A `survivingK` config knob that **caps** the post-dedup returned semantic-search
list. Per the Global Constraints, `survivingK` is a **CAP, not a refill**: the
post-dedup count-below-`topK` shortfall is acceptable behavior; `survivingK`
only ever reduces (caps) the list. It is applied **AFTER** the contentHash dedup
pass (Task 2) on **all three** return paths of `searchSemantic`.

### 4-point config registration (mirrors ticket 14's `vectorTopK`)

| Point | File | Change |
|---|---|---|
| 1. Constant | `src/constants.ts` | `export const DEFAULT_SURVIVING_K = 10;` (right after `DEFAULT_VECTOR_EF`) |
| 2. Type | `src/types.ts` | `survivingK: number;` on `MemoryConfig` (after `vectorEf?`) — required, per brief + Global Constraints |
| 3. Default | `src/config.ts` | `survivingK: DEFAULT_SURVIVING_K,` in `DEFAULT_CONFIG` + `DEFAULT_SURVIVING_K` imported |
| 4. Parse allowlist | `src/config.ts` `loadConfig` | `if (typeof parsed.survivingK === "number" && Number.isFinite(parsed.survivingK) && parsed.survivingK > 0) config.survivingK = Math.floor(parsed.survivingK);` — byte-for-byte the same guard shape as `vectorTopK` |

### Threading through `searchSemantic`

- `src/store/semantic-search.ts`: added `survivingK?: number` to `SearchSemanticOptions`.
- In `searchSemantic`: `const cap = survivingK ?? topK;` — **defaults to `topK` when unset, so existing behavior is UNCHANGED** when the option isn't passed.
- **Cap AFTER dedup on all 3 paths:**
  - Warm (HNSW): `return deduped.slice(0, cap);` — preserves the cold-index trigger signal (the `deduped.length === 0` check runs on the un-sliced list).
  - `knowledgeFallback`: added a `cap: number` param; `return dedupByContentHash(hits).slice(0, cap);`.
  - `memoryFallback`: added a `cap: number` param; `return dedupByContentHash(hits).slice(0, cap);`.
- The cold fallbacks still use `topK` for retrieval + their internal loop limit (unchanged param); only the final post-dedup slice uses `cap`. This keeps the cold-path retrieval breadth unchanged and applies the cap strictly after dedup.

### Out of scope (deliberately NOT done)
- **No `boostWeight`** (ticket 20 — multi-signal frequency-vote — YAGNI here). The `dedupByContentHash` doc comment now states the survivingK cap is applied by the CALLER and boostWeight remains deferred.
- **No caller/tool adoption.** `src/tools/knowledge-search-tool.ts` is untouched. The knob is exposed only via `SearchSemanticOptions.survivingK?`; wiring the tool to pass `config.survivingK` is a deliberate follow-up.

---

## TDD evidence

### RED — wrote failing tests first, watched them fail

**Command:**
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts tests/store/semantic-search.test.ts )
```

**Result:** `7 fail` (the 3 config tests + 4 of the 6 new searchSemantic cap tests).
The other 2 new searchSemantic tests (`defaults survivingK to topK when unset`, `CAP not a refill: post-dedup shortfall returned as-is`) pass trivially under the un-implemented code because they assert the *existing* behavior the default must preserve — they are regression guards, not RED drivers.

**Why they failed:**
- Config tests: `config.survivingK` was `undefined` (no field registered yet) → `assert.strictEqual(config.survivingK, 10)` failed.
- searchSemantic warm cap: no cap applied → 5 hits returned where 3 expected.
- searchSemantic "cap AFTER dedup": no cap → 3 hits where 2 expected.
- COLD knowledge/memory caps: no cap → full lists where capped lists expected.

Representative failure output:
```
(pass) searchSemantic — survivingK cap (ticket 19 T3) > WARM: caps the post-dedup ranked list to survivingK
  [
    "m1","m2","m3",
+   "m4",
+   "m5",
  ]
7 tests failed
```

### GREEN — implemented, watched them pass

**Command:**
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts tests/store/semantic-search.test.ts )
```

**Result:** `89 pass, 0 fail` — all 9 new tests green; all 80 pre-existing tests in the two files still green.

### Typecheck (this package: `bun run check` = `tsc --noEmit`)
```
$ tsc --noEmit
EXIT=0
```
Clean. (`MemoryConfig.survivingK: number` required-field is safe: the only full `MemoryConfig` object literal in the package is `DEFAULT_CONFIG`, which sets it; all other usages are spreads of `DEFAULT_CONFIG` or `Pick<...>` subsets.)

### FULL suite
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
1530 pass
1 skip
0 fail
1164 expect() calls
Ran 1531 tests across 131 files.
```
Baseline was **1521 pass**; added **9 new tests** → 1530. Output pristine (no console noise, no warnings).

---

## Files changed (6 — staged explicitly, no `git add -A`)

| File | Change |
|---|---|
| `src/constants.ts` | `+DEFAULT_SURVIVING_K = 10` |
| `src/types.ts` | `+survivingK: number` on `MemoryConfig` |
| `src/config.ts` | import + `DEFAULT_CONFIG.survivingK` + parse-allowlist guard |
| `src/store/semantic-search.ts` | `SearchSemanticOptions.survivingK?` + `cap = survivingK ?? topK` + `.slice(0, cap)` on all 3 return paths + stale comment refresh |
| `tests/config.test.ts` | 3 config tests (default / valid+floor / invalid→default) |
| `tests/store/semantic-search.test.ts` | 6 cap tests (warm cap / default→topK / cap-after-dedup / cap-not-refill / cold knowledge cap / cold memory cap) |

Diff stat: `6 files changed, 166 insertions(+), 8 deletions(-)`.

---

## Self-review (Global Constraints checklist)

- [x] **4-point config registration complete** — constants → types → DEFAULT_CONFIG → loadConfig allowlist, all present.
- [x] **Default preserves current behavior** — `cap = survivingK ?? topK`; `searchSemantic` results unchanged when the option isn't passed (regression tests confirm; full suite had zero pre-existing-test deltas beyond the +9 added).
- [x] **Cap AFTER dedup, on ALL 3 paths** — warm `deduped.slice(0, cap)`; `knowledgeFallback` + `memoryFallback` slice their `dedupByContentHash(...)` result. The cold-index backfill trigger still keys off the un-sliced `deduped` (signal preserved).
- [x] **survivingK is a CAP, not a refill** — no over-fetch, no compensation; a post-dedup shortfall below `survivingK` is returned as-is (dedicated test).
- [x] **No boostWeight** — ticket 20 deferred; doc comment updated to say so.
- [x] **No caller changes** — `knowledge-search-tool.ts` untouched (verified via `git diff --stat`); knob exposed only via `SearchSemanticOptions.survivingK?`.
- [x] **YAGNI** — minimal, single-purpose change; no speculative surface.

---

## Notes for the reviewer

- The brief says `survivingK: number` (required) on `MemoryConfig` while `vectorTopK?: number` is optional. Both the brief AND the Global Constraints specify the required form; "mirror vectorTopK" refers to the **4-point registration pattern + the `>0 floor` guard**, not the optional modifier. Required is safe here (only `DEFAULT_CONFIG` constructs the literal; tsc is green).
- The existing config test file has **no** `vectorTopK`/`vectorEf` tests (the brief's "mirroring how vectorTopK is tested" assumption). The new `survivingK` config tests instead mirror the **decay / proactive** config-test style already in `tests/config.test.ts` (same `loadConfig(temp-file)` fixture, same default/valid/invalid triple).
- NaN/Infinity cannot be represented in JSON, so the "NaN rejected" case is exercised by the same `typeof === "number" && Number.isFinite && > 0` guard via the JSON-representable invalid set (−1, 0, `"x"`, `true`, `null`); the `Number.isFinite` clause defends the in-memory path against NaN/Infinity.

---

## Fix wave (final review)

**BASE (fix wave):** `8c4a1ccc` (branch tip before fix wave)
**Impl commit:** `56dfe7c1` — `fix wave (final review): harden contentHash falsy-guard + clamp survivingK cap`

### What was changed

**Fix 1 (substantive):** Treat falsy `contentHash` (null / "" / undefined) as "no key" in deduplication.

- `dedupByContentHash`: Changed guard from `if (h.contentHash === undefined)` to `if (!h.contentHash)`. Now any falsy hash (undefined, null, empty string) is treated as "no key" and is always kept. Only non-empty strings are real dedup keys.
- `toHit` (warm path): Changed from `if (h.contentHash !== undefined)` to `if (h.contentHash)`. Now only truthy non-empty strings set the `contentHash` field on the hit; falsy hashes produce shape-compatible hits with no `contentHash` key at all.

**Rationale:** The previous `=== undefined` guard would treat `null` or `""` as a defined shared key, causing two distinct cards that happened to share a falsy hash (e.g., corrupt rows, or the `getStoredHashes` `?? ""` normalization) to over-collapse to one. This was a final-review recommendation.

**Fix 2 (Minor):** Clamp the `survivingK` cap to avoid JS slice footgun.

- Changed `const cap = survivingK ?? topK;` to `const cap = Math.max(0, survivingK ?? topK);`

**Rationale:** JavaScript's `Array.slice(0, -1)` drops the last element instead of capping. A caller passing `survivingK: -1` would trigger this footgun. Clamping to 0 ensures negative values produce an empty result (consistent with `survivingK: 0`). The config path already floors to >0; this hardens the option-level entry.

### TDD evidence

**RED — focused tests fail before fixes:**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/semantic-search.test.ts --tnap "fix wave" )
```

Result: **4 fail**
- `WARM: two rows with contentHash="" are BOTH returned` — Expected `['m1', 'm2']`, received `['m1']` (over-collapsed)
- `WARM: two rows with contentHash=null are BOTH returned` — Expected `['m1', 'm2']`, received `['m1']` (over-collapsed)
- `WARM: toHit only sets contentHash when truthy` — Expected hits without `contentHash` key for falsy values, received hits with `contentHash: ""` and `contentHash: null`
- `survivingK: -1 returns []` — Expected `[]`, received `[m1, m2]` (JS slice drop-last behavior)

**GREEN — fixes applied, focused tests pass:**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/semantic-search.test.ts --tnap "fix wave" )
```

Result: **7 pass, 0 fail** — all 7 fix-wave tests green (4 original RED + 3 added coverage tests)

**Full suite:**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
```

Result: **1537 pass, 1 skip, 0 fail**
- Baseline was 1530 pass
- Added 7 new tests → 1537 pass
- All pre-existing tests still pass

**Typecheck:**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun run check )  # tsc --noEmit
```

Result: **EXIT 0** — clean

**Task-1 regression check:**

```bash
bun test tests/store/semantic-search.test.ts --tnap "surfaces contentHash on the warm path when knn provides it"
```

Result: **PASS** — the truthy-set change in `toHit` does not break real hash flow; a truthy non-empty hash still sets `contentHash` correctly.

### Files changed

| File | Change |
|---|---|
| `src/store/semantic-search.ts` | `dedupByContentHash`: falsy-guard `!h.contentHash`; `toHit`: truthy-set `if (h.contentHash)`; `cap = Math.max(0, survivingK ?? topK)`; +doc comments |
| `tests/store/semantic-search.test.ts` | +7 fix-wave tests (4 RED drivers + 3 coverage) |

Diff stat: `2 files changed, 118 insertions(+), 4 deletions(-)`

### Self-review

- [x] **Fix 1 falsy-guard correct:** `!h.contentHash` catches undefined, null, and "". All three are treated as "no key" (always kept). Real non-empty hashes still dedup correctly (verified by existing Task-1 test + new "truthy contentHash still dedups" test).
- [x] **Fix 1 toHit truthy-set shape-compatible:** Falsy hashes produce hits with no `contentHash` key at all, matching hashless warm hits and cold-path hits. The `SemanticSearchHit.contentHash?` optional field handles this correctly.
- [x] **Fix 2 cap clamp correct:** `Math.max(0, ...)` ensures negative values clamp to 0, never trigger JS drop-last semantics. `survivingK: 0` → `[]`, `survivingK: -1` → `[]`, `survivingK: -5` → `[]`.
- [x] **No scope creep:** Only the two fixes from the final-review recommendation. No typing changes (Minor#2 deferred as cosmetic). No additional behavior changes.
- [x] **Tests real-behavior:** The fix-wave tests exercise the actual bug patterns (over-collapse on null/"", slice drop-last on negative). The added coverage tests verify the intended invariants (truthy hashes still dedup, clamp works for larger negatives).
- [x] **Full suite pristine:** 1537 pass, no new failures. Typecheck clean. Task-1 regression test passes.
