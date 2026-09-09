# Ticket 01 — vision-LLM contract leaf in core-interface

## Goal

Remove the direct `flux2 → file2md` and `hermes-memory → file2md` library
couplings by promoting the vision-LLM surface (`askImage`,
`resolveVisionLLM`, `ResolvedLLM`) to a contract leaf in
`bun-apps/s2-agent-core-interface`, with `file2md` remaining the
implementation that fulfills it.

## Why

`askImage`/`resolveVisionLLM` is a literal LLM seam (which model/endpoint
answers vision questions) — per effort D1 it belongs beside
`embedding-leaf.ts` (the existing precedent: contract leaf + seam → env →
defaults resolution), not as an import from a sibling extension.

## Constraints

- core-interface stays DEPENDENCY-LIGHT: no import from any ext package.
  The leaf is types + resolution contract; the implementation is injected or
  resolved the same way embedding-leaf does it (read that file first and copy
  its shape).
- NO wire-name changes: exported function names may move but keep their
  signatures; file2md re-exports for back-compat so its own consumers/tests
  keep passing.
- flux2 and hermes-memory switch imports to `@repo/s2-agent-core-interface`
  and DROP their `@repo/s2-agent-ext-file2md` runtime dep in package.json
  ONLY if no other file2md import remains in that package (map all call
  sites first — see Fog of war in map.md).
- file2md gains `@repo/s2-agent-core-interface` dep if not present.
- Repo conventions: explicit `.ts` extensions on relative imports;
  `workspace:*` dep specifiers; never run `bun install` (the lead runs it
  once after all tickets land — if a dep edge you added is not yet linked,
  note it in your report instead of installing).
- NO git mutations (no commit/stage/branch). Edit files + run tests only.

## Steps

1. Map exact usage: grep `from "@repo/s2-agent-ext-file2md"` in
   `bun-apps/s2-agent-ext-flux2` and `bun-apps/s2-agent-ext-hermes-memory`
   (src + extensions, exclude tests). List every imported symbol.
2. Read `bun-apps/s2-agent-core-interface/src/embedding-leaf.ts` +
   `src/index.ts` to copy the leaf pattern and export style.
3. Create `src/vision-llm-leaf.ts` in core-interface: the contract (types +
   resolver that consults an injected impl). Export from `src/index.ts`.
4. file2md: implement/register against the leaf; keep `askImage` etc.
   exported from its own entry (back-compat re-export from the leaf types).
5. Switch flux2 + hermes-memory imports; adjust their package.json deps.
6. Tests: each touched package `bun test` green; add/adjust a small unit test
   for the leaf resolution order if the pattern warrants one.

## Acceptance

- `grep -rn 'from "@repo/s2-agent-ext-file2md"' bun-apps/s2-agent-ext-flux2/src bun-apps/s2-agent-ext-hermes-memory/src` → only back-compat-explained hits (or none).
- `bun bun-apps/tests/dep-guard.test.ts`-equivalent (`cd bun-apps && bun test tests/dep-guard.test.ts`) green.
- `bun test` green in: s2-agent-core-interface, s2-agent-ext-file2md,
  s2-agent-ext-flux2, s2-agent-ext-hermes-memory.
- Report: files changed, call-site map, any dep edges needing `bun install`.
