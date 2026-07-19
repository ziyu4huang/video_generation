---
type: task
status: open
---

# 01 — Revert superpowers skill edits; restore byte-identicality

## Question

Revert the CONTENT edits PR #676 + #678 made to the five superpowers skills — `writing-plans`, `requesting-code-review`, `subagent-driven-development` (#676 path changes + #678 goal/todo protocol), `executing-plans`, `verification-before-completion` (#678) — so they are byte-identical to upstream again (README:7,10,27)? wayfind's own edits (`to-spec`, `to-tickets`) STAY — wayfind is owned, not upstream-ported.

**Sequencing sub-decision:** revert-first (invariant restored now; goal/todo go dark until the layer ships) or layer-first (skills stay edited longer; seamless cutover)? Recommend **revert-first** — the invariant violation is the debt; the stopgap's benefit is non-essential and ADR-0003 already documents the manual fallback.

**Relocation sub-decision:** the conventions those edits carried (the `plans/<NN>-<slug>.md` path from #676; the goal/todo protocol from #678) move to the coordination layer ([02](02-unified-coordination-layer.md)) / wayfind side — they do NOT survive in superpowers skills.

### Context

- `tests/skills.test.ts` asserts structure only (frontmatter, skill-dir set, no stray files) — NOT content-identity — so the violation passed CI silently. Consider ADDING a content-fidelity assertion (pins the invariant against regression) as part of this ticket.
- Upstream may have advanced since the port → "restore" may be a re-port, not a pure `git revert` (see map fog: upstream re-sync mechanics).
