---
type: grilling
status: closed
claimed: claude
---

# 01 — Merge-tooling fate under the never-wait flow

## Question

Remote CI is now disabled (PR #1045) and the global standing rule is "never wait for CI — self-verify locally, `gh ship` (`gh pr merge --squash`) immediately." But `await_pr_merge` is built around polling CI checks → enabling `--auto` → rebasing on BEHIND → waiting for MERGED (with a recent "merge directly when green" fast-path). Under CI-disabled + never-wait, what should the devops merge tooling become? Repurpose `await_pr_merge` into a `ship`/`merge` pi-tool (open PR → run local CI → squash-merge immediately, no waiting), simplify it to a thin immediate-merge, or deprecate it in favor of the shell `gh ship` alias? Note the package's stated philosophy is "tool-based PR-merge lifecycle, replacing brittle agent-side bash polling" — which favors keeping a tool over alias-only.

## Resolution

**Decided 2026-08-07.** Repurpose `await_pr_merge` — do NOT deprecate. Today it merges immediately with no checks (CI disabled → empty checks treated as green → effectively an un-gated merge). Restore a gate, but LOCAL instead of remote: the merge tool gates on local-CI-green.

**Shape: composable** (not self-contained). `local_ci` is a standalone reusable tool (ticket 02); `await_pr_merge` invokes it and merges only if green. Rationale: matches the package's modular design (3 separate tools today); `local_ci` is reusable for pre-PR self-verify; the merge tool stays focused on merge + gate.

Implications for the implementation ticket (04):
- Merge precondition flips from "remote checks green/absent" → "`local_ci` green" (typecheck + tests for changed packages vs origin/main).
- Remote-check polling / `--auto` / enable-auto-merge logic is dropped (CI disabled; never-wait rule).
- BEHIND force-push-to-rerun-CI path is no longer justified (no remote CI to re-trigger) — 04 decides keep-simple-rebase vs drop.
- This also resolves the "gh ship as a pi tool" fog: the repurposed merge tool IS the tool equivalent of the `gh ship` alias.
