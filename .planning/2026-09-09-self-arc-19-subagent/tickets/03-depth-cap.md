# t03 — nested-spawn depth cap (default 2, per-agentType maxDepth override)

Status: open
Files: `bun-apps/s2-agent-ext-subagent/src/subagent-tool.ts` (spawn dispatch),
wherever agentType def frontmatter is parsed (locate first — see below), tests.
Schema-cost: expected +0 (no tool-schema change; document description only if the
rejection wording leaks into a description — then generate + cite like t02).

## Goal

Cap non-fork nested spawns: today the ONLY recursion guard is the fork-recursion guard
(`src/subagent-tool.ts:435-448`, `isForkChild`/`runAsForkChild` — its comment documents
that fork-child scope inheritance already covers fork grandchildren). A non-fork child
that spawns a grandchild that spawns a great-grandchild runs uncapped.

## Verified facts (planner, 2026-09-09)

- The fork guard lives at the spawn-options resolution: `params.fork` wraps spawn in
  `runAsForkChild(() => spawn(o))` — an ambient scope primitive that already proves
  cross-process context propagation works in this codebase.
- `src/agent-type-catalog.ts` is only the catalog FORMATTER (`CATALOG_HEADER`,
  `buildAgentTypeCatalog`); the def frontmatter parser is elsewhere — tui-drive seeds
  defs with `model: zai/glm-5.3` frontmatter (`scripts/tui-drive.ts:128,164`) so a
  parser exists and runs live. LOCATE IT FIRST (`grep -rn "frontmatter\|model:" src/`
  plus the def-loading path used by child-dispatch).

## Work items

1. **Depth counter** (map D7): propagate `depth` through the spawn context using
   whichever channel the dispatch seam already carries (ambient scope à la fork, or an
   env var the child's spawn reads at boot — pick the one that survives the existing
   tests, document the choice in a code comment). Root = 0; each spawn increments.
2. **Cap check at spawn time**: if `childDepth > maxDepth(agentType)` → clean
   rejection (structured failure, not a crash): name current depth, the effective cap,
   and the override knob. Default max 2 (root → child → grandchild allowed;
   great-grandchild rejected).
3. **Frontmatter override**: agentType def frontmatter `maxDepth: <n>` overrides the
   default for spawns OF that type (decide and document: override applies to the
   spawned type's own subtree — record in the rejection message semantics test).
4. **Fork interplay** (documented, not merged): fork recursion stays rejected by the
   scope guard BEFORE depth is consulted; depth governs non-fork grandchildren. Add a
   comment at the fork branch pointing at the depth check, and vice versa.
5. **Tests**: spawn at depth == cap → rejection with the wording; depth < cap → passes
   through (fakeSpawn, no LLM); frontmatter `maxDepth: 3` → one more level allowed;
   fork-child nested-fork rejection still fires unchanged.

## Acceptance

- Package gate set green; the four test cases above pass.
- The interplay comment exists at both guard sites.
- If ANY shipped description text changed, schema-cost delta generated + cited (map D8).

## Out of scope

Per-spawn runtime override parameter (frontmatter only, per the directive); UI surface
for depth; changing the fork guard's semantics.
