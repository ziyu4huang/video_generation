> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Spec — `sweep_branches` tool (pi-agent-ext-devops)

**Effort:** `2026-08-02-devops-sweep-branches-tool`
**Status:** implemented (TDD) — 91/91 tests green, `tsc --noEmit` clean
**Form:** new registered tool (3rd in the extension, alongside `await_pr_merge` / `pr_status`)
**Default safety:** dry-run (plan only); deletions only on `execute: true`
**Core rule:** delete only on **positive gh merge evidence**; anything not confidently proven is
surfaced for **human decision** (`review` bucket), never auto-deleted. `[gone]` is a hint, not proof.

## 1. Origin — self-reflection (why this exists)

The trigger was a "remove unused local and remote branch" task. Running it exposed that
**agent-side branch cleanup is unreliable in exactly the way this extension was built to fix**
(the `gh pr checks | grep -c` footgun). Hard-won learnings:

1. **`git branch --merged` is silently wrong for squash merges.** A squash-merged branch never
   puts its tip commit into `main`'s history, so `--merged` reports almost nothing as merged —
   even when dozens are merged. An agent trusting it declares "nothing to do" and leaves cruft.
2. **`[origin/…: gone]` is NOT merge evidence.** It means the remote branch was deleted — which
   happens after a merged PR **and** after a closed-without-merge PR (or a manual delete). Hint
   only, never proof.
3. **The only authoritative merge evidence is PR `state=MERGED`** via `gh … --json`.
4. **Worktree blindness.** `git branch -d` fails mid-loop on any branch checked out in a worktree.
5. **No protected/current guard.** Easy to delete `main` / `HEAD` by accident.
6. **No dry-run → destructive.** `git push origin --delete` is team-visible and near-irreversible.
7. **Binary "delete vs keep" hides the uncertain middle.** A `[gone]`-without-gh-proof branch is
   *probably* merged but unprovable; silently keeping it loses cleanup value, silently deleting it
   risks a closed-unmerged branch. → needs a **human-decision** path, not a coin-flip.

**Distillation (the predicate this tool encodes):**
> Deletion is **confidence-gated**. Auto-delete only at **high** confidence (gh proves a MERGED PR,
> no open-PR name conflict, no guard). **Uncertain** cases (`[gone]`-unverified, name-reused) go to
> a `review` bucket the human decides — never auto-deleted. Guards are absolute: never
> `{protected, current, worktree-locked}`. Everything via structured `git`/`gh` JSON; unknown → keep.

This is the same philosophy as the existing tools ("structured JSON, never text grep; unknown →
safe default"), now with an explicit confidence tier + human-in-the-loop for the ambiguous middle.

## 2. Goal

A tested, deterministic tool that classifies every local + remote branch into
`delete` / `review` / `keep` using authoritative gh merge evidence **plus a confidence tier**, so
high-confidence merges are auto-deletable while genuinely uncertain cases are surfaced for human
decision — never silently acted on.

## 3. API

```ts
sweep_branches({
  execute?:        boolean,   // default false → plan only, delete nothing
  confirm?:        string[],  // branches the human reviewed & approved (must have appeared in a
                             //   prior `review` bucket; still re-guarded; cannot bypass evidence)
  includeLocal?:   boolean,   // default true
  includeRemote?:  boolean,   // default true
  protected?:      string[],  // default ["main","master"] (+ repo default branch auto-added)
  prune?:          boolean,   // default true → `git fetch --prune` so [gone] hints are fresh
  limit?:          number,    // default 200 → gh pr list --limit
}) → {
  fetched: boolean,
  mergedRefNames: string[],            // refs gh reported MERGED
  openRefNames:   string[],            // refs gh reported OPEN (name-conflict source)
  plan: {
    deleteLocal:  BranchPlan[],        // HIGH confidence only — safe to auto-delete
    deleteRemote: BranchPlan[],        // HIGH confidence only
    review:       BranchPlan[],        // MEDIUM/LOW — human decides; NEVER auto-deleted
    keep:         { name, reason }[],  // guards + no-signal branches, with reason
  },
  executed?: { deletedLocal: string[], deletedRemote: string[], skipped: {name,reason}[] }
}
// BranchPlan = { name, kind:"local"|"remote", confidence:"high"|"medium"|"low", reason,
//                signals:{ mergedPr?:number, gone?:boolean, containedInDefault?:boolean, openPr?:boolean } }
//
// execute:true  → deletes ONLY deleteLocal/deleteRemote.
// confirm:[...] → additionally deletes those reviewed branches (re-guarded; must have a hint,
//                 i.e. have been in `review`, never a no-signal `keep` branch).
```

## 4. Classification logic + confidence (pure)

**Signals:** `S1` mergedPr (gh MERGED PR for head ref — authoritative) · `S2` gone
(remote-tracking ref `[gone]` — hint, ambiguous) · `S3` contained (`--merged` into default — safe,
misses squash) · `S4` openPr (an OPEN PR reuses the head ref — **conflict**, lowers confidence).

**Guards (absolute, checked first):** `inWorktree` / `isProtected` / `isCurrent` → `keep`.

**For non-guarded branches:**
```
if S4 (openPr reuses ref)   → medium → review   "merged but an open PR reuses the ref — human confirms which"
else if S1 (mergedPr)       → high   → delete    "gh-confirmed merge"        (local→deleteLocal, remote→deleteRemote)
else if S2 (gone)           → low    → review    "remote deleted, merge unverifiable by gh"
else                        → none   → keep      "no merge evidence / active remote / local-only"
```
`S3` (contained) is reported in `signals` as corroboration; it does not change the tier (squash
repos rarely set it, and `S1` is already authoritative). local-vs-remote routing is by `kind`.

## 5. Data sources (all structured; parsers are pure + defensive)

| Signal | Source | Parser |
|---|---|---|
| local branches + gone marker | `git branch -vv` | `parseBranchVv` → `{name, goneRemote}[]` |
| remote branches | `git branch -r` | `parseRemoteBranches` → `name[]` (strip `origin/`, drop `HEAD ->`) |
| worktree locks | `git worktree list --porcelain` | `parseWorktrees` → `branch[]` |
| current branch | `git rev-parse --abbrev-ref HEAD` | inline |
| **merged PRs (S1 gate)** | `gh pr list --state merged --json headRefName,number --limit N` | `parseMergedPrs` → `Map<ref, prNumber>` |
| open PRs (S4 conflict) | `gh pr list --state open --json headRefName` | `parseOpenPrRefs` → `Set<ref>` |
| contained (S3, info) | `git branch --merged <default>` | `parseContained` → `Set<name>` |
| default branch | `git symbolic-ref refs/remotes/origin/HEAD` (best-effort) | inline |

Unknown / garbage / missing → safe defaults (`S1=false`, `S4=false`); never throw.

## 6. Safety model

- **Dry-run by default.** No `execute: true` → nothing is deleted; only a plan is returned.
- **⚠ ABSOLUTE INVARIANT — worktree-locked branches are never deleted.** A branch checked out in
  any worktree is (1) excluded from every deletable bucket, (2) re-checked immediately before every
  deletion for race safety, and (3) protected by `git` itself — `git branch -D` refuses a branch
  checked out in a worktree (*"Cannot delete branch … checked out at …"*). Three layers;
  non-bypassable. (Real-world case already safe: `archify/ext-architecture-report` and
  `fix/hermes-graph-orphan-heal` are both `[gone]` AND worktree-locked → doubly protected.)
- **Confidence-gated deletion (the human-in-the-loop).** Only **high**-confidence branches are
  auto-deletable. **medium/low** go to `review` and are deleted **only** via explicit
  `confirm:[…]` — which re-runs all guards and refuses any branch that was not in `review`
  (no force-deleting evidence-less branches). This operationalizes *"hand the uncertain ones to a human."*
- **Evidence-required.** No bucket ever deletes without either gh merge proof (high) or explicit
  human confirmation of a hinted branch (confirm). `[gone]` alone never auto-deletes.
- **Hard guards** (checked twice — planning AND pre-deletion): never delete `main`/`master`/repo-default or current.
- **Local deletions** use `git branch -D` (force safe: merge authoritatively verified; `-d` wrongly
  refuses squash-merged). **Remote** use `git push origin --delete`.

## 7. Architecture (mirrors existing extension)

| Layer | File | Responsibility |
|---|---|---|
| Pure logic | `src/branch-logic.ts` | `classifyBranch` (signals → {confidence,bucket}), `defaultProtected`, reason builders. No I/O. |
| Parsers | `src/gh.ts` (extend) | `parseBranchVv`, `parseRemoteBranches`, `parseWorktrees`, `parseMergedPrs`, `parseOpenPrRefs`, `parseContained`; `createGhClient` gains `mergedPrRefs()`, `openPrRefs()`, `branchVv()`, `remoteBranches()`, `worktrees()`, `containedBranches()`. |
| Recipe | `src/branch-recipe.ts` | `buildSweepPlan(...)` (inject `SpawnFn`/`GhClient`) + `executeSweep(...)` (delete high only; honor `confirm`; re-guard each delete). |
| Glue | `extensions/devops.ts` | register `sweep_branches`; wire live `Bun.spawn`; default dry-run. |

## 8. Testing (TDD)

- `branch-logic.test.ts`: `classifyBranch` truth-table over every `(guards, S1, S2, S3, S4)`
  combination → expected `{confidence, bucket}`. Key cases: `S1 && !S4 → high/delete`; `S1 && S4 →
  medium/review`; `!S1 && S2 → low/review`; `!S1 && !S2 → keep`; any guard → keep; `S2-only never deletes`.
- `gh.test.ts` (extend): the 6 new parsers on recorded stdout incl. malformed/empty → safe defaults.
- `branch-recipe.test.ts`: `buildSweepPlan` with a scripted fake — verifies bucketing, guard
  precedence, the `review`-never-auto-deleted guarantee (`execute:true` leaves review untouched),
  `confirm:[x]` deletes `x` iff `x` was in `review` AND still passes guards, and the **invariant
  test**: a worktree-bound branch injected into the delete set is **never** passed to
  `git branch -D` (skipped as `worktree-locked`); `confirm` of a no-signal keep branch is refused.
- `entry.test.ts` (extend): registration smoke (name, params schema, dry-run returns plan with all 4 buckets).

## 9. Out of scope (YAGNI)

- Deleting on `[gone]`-alone or on `git branch --merged` text inspection — refused by design.
- Bulk force-delete of local-only / unmerged branches (`--force`). Refused by design.
- A tunable `minConfidence` threshold (auto-delete at medium) — possible future knob; default stays high.
- Stale reflog pruning, `git gc`, cross-fork/other-remote cleanup, interactive TTY picker.
