type: grilling
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

Should **`await_pr_merge`** (`bun-apps/pi-agent-ext-devops/extensions/devops.ts:62`, ~330 tok/req) be **gated** or **always-on**?

Context:
- Devops tool that waits/polls for a PR to merge — long-running; lower destructive risk than `sweep_branches` but still a heavy async hold.
- Same file as `sweep_branches` (ticket 02) — consider a consistent devops gating posture across the two.
- Options: keyword gate, or `core: true` if always-on is intended.

Resolution records: the chosen `gating:` value (verbatim, to paste at `devops.ts:62`).

## Resolution

**Decision: keyword gate (devops)** (chosen 2026-08-04). Consistent devops posture with ticket 02 (`sweep_branches`); controls token cost of a long async hold.

Tool description (source): "Poll a PR's CI checks, enable auto-merge when they pass, on BEHIND rebase+force-push the feature branch so checks re-run, and wait for MERGED. A robust, tool-based replacement for brittle agent-side `gh pr checks | grep` polling loops. Returns merged/failed/timed-out + a check tally. Wraps the `gh` CLI (structured JSON — no grep footguns). Default strategy rebase, default timeout 600s, auto-deletes the branch on merge, auto force-pushes on BEHIND (powerful: set handleBehind=fail to opt out)."

Proposed gating (apply at ticket 06; adjust if a clearer set emerges):
```ts
gating: { keywords: ["pr", "pull-request", "merge", "merged", "await", "wait", "poll", "devops"] }
```
Target: `bun-apps/pi-agent-ext-devops/extensions/devops.ts:62`.
