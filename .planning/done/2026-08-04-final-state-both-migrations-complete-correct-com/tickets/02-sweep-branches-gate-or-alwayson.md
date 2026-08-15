type: grilling
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

Should **`sweep_branches`** (`bun-apps/pi-agent-ext-devops/extensions/devops.ts:139`, ~376 tok/req) be **gated** or **always-on**?

Context:
- Devops branch-sweep tool — mutates/deletes branches; destructive blast radius.
- Currently has zero `gating:` field; siblings `await_pr_merge` and `pr_status` in the same file are also ungated (`await_pr_merge` is ticket 04).
- Options: keyword gate (e.g. devops/cleanup keywords), or `core: true` if always-on is intended.

Resolution records: the chosen `gating:` value (verbatim, to paste at `devops.ts:139`).

## Resolution

**Decision: keyword gate (devops)** (chosen 2026-08-04). Destructive branch-sweep shouldn't fire unrestricted. This also sets the devops gating posture for ticket 04 (`await_pr_merge`).

Tool description (source): Classify every local + remote branch and report which are safe to delete. CONSERVATIVE: a branch is deleted only when gh shows a MERGED PR for it (high confidence); uncertain cases ([gone] without gh proof, or a head ref reused by an open PR) go to a `review` bucket the human decides — never auto-deleted. Worktree-checked-out, protected (main/master/default) and the current branch are NEVER deleted (absolute). Dry-run by default: returns the plan only; pass execute:true to delete the high-confidence set, or confirm:[...] to delete specific reviewed branches. Uses structured git/gh JSON — never `git branch --merged` (wrong for squash merges).

Proposed gating (apply at ticket 06; adjust keywords if a clearer set emerges):
```ts
gating: { keywords: ["sweep", "branch", "branches", "cleanup", "prune", "delete-branch", "devops"] }
```
Target: `bun-apps/pi-agent-ext-devops/extensions/devops.ts:139` (the `pi.registerTool({ name: "sweep_branches", ... })`).
