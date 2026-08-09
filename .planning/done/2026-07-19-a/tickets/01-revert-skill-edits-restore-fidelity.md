---
type: task
status: closed
claimed: pi-agent
---

# 01 — Revert superpowers skill edits; restore byte-identicality

## Question

Revert the CONTENT edits PR #676 + #678 made to the five superpowers skills — `writing-plans`, `requesting-code-review`, `subagent-driven-development` (#676 path changes + #678 goal/todo protocol), `executing-plans`, `verification-before-completion` (#678) — so they are byte-identical to upstream again (README:7,10,27)? wayfind's own edits (`to-spec`, `to-tickets`) STAY — wayfind is owned, not upstream-ported.

**Sequencing sub-decision:** revert-first (invariant restored now; goal/todo go dark until the layer ships) or layer-first (skills stay edited longer; seamless cutover)? Recommend **revert-first** — the invariant violation is the debt; the stopgap's benefit is non-essential and ADR-0003 already documents the manual fallback.

**Relocation sub-decision:** the conventions those edits carried (the `plans/<NN>-<slug>.md` path from #676; the goal/todo protocol from #678) move to the coordination layer ([02](02-unified-coordination-layer.md)) / wayfind side — they do NOT survive in superpowers skills.

### Context

- `tests/skills.test.ts` asserts structure only (frontmatter, skill-dir set, no stray files) — NOT content-identity — so the violation passed CI silently. Consider ADDING a content-fidelity assertion (pins the invariant against regression) as part of this ticket.
- Upstream may have advanced since the port → "restore" may be a re-port, not a pure `git revert` (see map fog: upstream re-sync mechanics).

## Resolution (closed 2026-07-19 — pi-agent; user endorsed revert-all-conventions + assess-#639)

**Invariant refined:** "byte-identical to upstream **EXCEPT necessary pi-port glue**." The literal "byte-identical" was always too strict — a pi-port necessarily diverges for tool/action mapping.

**Reverted** (commit `dabad74e`): the 7 superpowers skill files touched by convention injections — #664 (`.planning` path), #676 (`plans/NN-slug`), #678 (goal/todo protocol) — restored to #617-port (upstream-verbatim) content. `plans/<NN>` / `ADR-0003` / `goal_complete` now **0 hits** across superpowers skills.

**Kept:** #639's `using-superpowers/references/pi-tools.md` subagent-dispatch mapping — necessary pi-port glue (maps "dispatch a subagent" → `pi-agent-ext-workflow`'s `subagent` tool), NOT a convention injection. Untouched.

**Consequences (relocation, not loss):**
- The `.planning/<effort>/plans/` + goal/todo conventions now live ONLY in wayfind (owned: `to-spec`, `to-tickets`) + the vault SOP doc + ADR-0003 — NOT in superpowers skills. `writing-plans` reverted to the upstream default `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
- Sequencing = revert-first (endorsed): goal/todo driving is now DARK on the superpowers side until [02](02-unified-coordination-layer.md)'s coordination layer ships. The `/goal` prompt in wayfind `to-tickets` survives; ADR-0003 documents the manual fallback.
- [02](02-unified-coordination-layer.md) now carries the relocated conventions (must provide goal/todo driving + bridge the path mismatch).

**Deferred → [07](07-skill-fidelity-guard.md):** a content-fidelity test guarding the invariant against future silent violations.
