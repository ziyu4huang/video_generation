---
type: grilling
blocked by: []
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (DO — content-level before→after delta; Effort revised E2→E3)
---

# 08 — Decide: Watchdog L1 precise before→after delta

**Source**: 02#3 · axis `robustness` · **Impact 4 / Effort 2 / score 16** (rank 4)

## Question

Decide do/defer/skip + spec for L1 reviewing the over-inclusive post-status file
set instead of the precise before→after delta.

## Resolution (grilled 2026-07-31, branch behind:8, 0 touched subagent/workflow src)

**Decision: DO — content-level before→after delta.** L1 (and L2, which inherits
the same path set) should review exactly the files whose **content** changed
spawn-over-baseline, not the entire dirty-vs-HEAD set.

### False-premise finding (corrects the ticket)

The ticket (02 research) assumed the precise delta "was already computed" and just
needed feeding to L1. **It was not.** `repo-diff.ts`:

```ts
// _before is IGNORED (underscore = intentionally unused)
export function changedTsJsPaths(_before: RepoBaseline, after: RepoBaseline): string[] {
  return after.changedPaths.filter((p) => TS_JS_EXT.has(path.extname(p).toLowerCase()));
}
```

`RepoBaseline = { root, key, changedPaths }`; `computeBaseline` computes per-file
hashes in `hashEntry` but **rolls them into the aggregate `key` and discards them**
— so no per-file content delta exists. Building it needs a baseline schema bump.
⇒ **Effort revised E2 → E3.**

### Grilled fork

- **Delta granularity** (Q1) → **content-level** (correct) over path-level (cheap,
  lossy) / defer. Rationale: a review GATE's false-negative (path-level drops a
  file the subagent re-touched that was pre-dirty — silently unreviewed) is more
  dangerous than the current false-positive (over-inclusive = noisy but safe).
  Path-level is exact only in the clean-tree SDD case; content-level is correct in
  dirty trees too.

### Spec (handoff)

1. **Retain per-file entries in `RepoBaseline`** — add
   `entries: Array<{ path: string; hash: string; state: string }>` (ADDITIVE; keep
   `root`, `key`, `changedPaths` so the edit-gate `after.key === before.key` and
   existing callers are unaffected). `hashEntry` already computes these — collect
   them instead of discarding.
2. **`changedTsJsPaths(before, after)` → content delta** — return TS/JS files in
   `after.entries` whose `hash` **differs** from the matching `before.entries`
   entry, OR that are **absent in before** (newly created). Exclude files whose
   hash is unchanged (pre-dirty files the subagent did NOT touch) and deleted files
   (in before, gone in after — nothing to lint). This catches a pre-dirty file the
   subagent re-edited (hash differs) while excluding one it left alone (hash same).
3. **L2 inherits the fix** — `diffTextForReview` already receives the `tsJs` set
   from `runWatchdog`, so narrowing `changedTsJsPaths` narrows both layers. No
   separate L2 change.
4. **`key` / edit-gate untouched** — the aggregate `key` stays for the
   `after.key === before.key` early-return; only `entries` is added.

### Acceptance criteria (for the implementer)

- (a) **Dirty-tree regression test** (the case this ticket exists for): pre-spawn,
  file X dirty (hash H1) + file Z dirty (hash H1); subagent edits X (→H2), creates
  new Y, leaves Z untouched (H1→H1). L1 lints **X** (hash changed) + **Y** (new),
  NOT **Z** (hash same).
- (b) Clean-tree (SDD) test: `before.changedPaths` empty → all after-changes linted
  (unchanged, exact).
- (c) Edit-gate still works (`key` compare unaffected); existing clean-tree tests
  still pass.

**No new ticket graduates.** Implementation is handoff. NB: this pairs with 06
(06 = sentinel when 0 layers ran; 08 = precise scope when they do) — together they
harden the watchdog gate's correctness + visibility.
