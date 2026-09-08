# t01 — Commit the ultracode audit workflow (B4 shape) + driver recipe

Status: open · Phase 1 · Blocks: t02, t03, t04

## Goal

`samples/audit-ext-packages.js` committed under
`bun-apps/s2-agent-ext-ultracode/samples/`, shaped exactly like B4
(`cc-parity/review-per-file.js`): `meta` with phases, args-JSON parsing with a
throwing guard, bounded `parallel()` fan-out of one auditor agent per package,
then ONE synthesizer agent over every verdict. Plus a light unit test and a
deterministic driver recipe. The arc's tool becomes the arc's auditor.

## Scope

- **Package list**: derive in-script from args (`args.packages`, array of
  package dir names); the DRIVER recipe passes the 26 measured in the map
  (inventory 2026-09-09). No hardcoded list inside the script — paths ride args.
- **Auditor prompt** (one per package) must state:
  - the package dir (absolute, from `args.repoRoot`);
  - the gate commands to run via Bash, each with `timeoutMs` (D7 defaults:
    check 120s / typecheck 240s / test 600s), derived from the package's
    `package.json` scripts (fall back: `bun run check` if present, else skip
    with note; `bun run typecheck` else `bun x tsc --noEmit`; `bun test`);
  - **READ-ONLY-OR-GATES (D2)**: "You may run ONLY these gate commands (they
    write cache/scratch only). Do NOT modify, create, or delete any source
    file. Report, never fix.";
  - the schema'd return: `{package, check: pass|fail|timeout|skipped,
    typecheck: …, test: …, failures: string[] (≤5, each with file:line or
    command tail excerpt ≤10 lines), warnings: string[] (≤5),
    improvementNotes: string[] (≤5, concrete, no speculation)}`.
- **Synthesizer prompt**: consumes every auditor verdict (completeness = the
  parity receipt, D4); schema'd return:
  `{greenCount, reds: [{package, gate, summary}], warnings: [...],
  improvementRoom: [...], suspectedFlakes: [...]}`.
- **Bounded fan-out (D7)**: chunk `args.packages` into batches (~6–8) with
  sequential `await` between `parallel()` calls; `log()` per batch.
- **Constraints honored**: no `process`/`Date`/`import` in the script; helpers
  inlined; everything else rides args (`repoRoot`, `packages`, optional
  `batchSize`, optional per-gate timeout overrides).

## Steps

1. Write the script modeled on `review-per-file.js` (same arg-parse preamble,
   same phase/log style).
2. Unit test (light, runtime-data discipline — fake runner, NO real model):
   extend or add alongside `tests/cc-parity-workflows.test.ts` asserting
   (a) `{packages:["a","b"]}` spawns exactly 2 auditors + 1 synthesizer;
   (b) every auditor prompt names its package, the three gate commands, and the
   READ-ONLY clause; (c) empty/missing `packages` throws; (d) synthesizer
   prompt embeds every auditor's returned line (completeness gate).
3. Verify `bun run check && bun run typecheck && bun test` green for
   s2-agent-ext-ultracode; scripts-dir-contract untouched (samples/ is not a
   top-level script — verify the test still passes, don't assume); schema-cost
   +0 (no tool description changed — confirm via the canary if in doubt).
4. Record the driver recipe in this ticket's Resolution (deterministic, not a
   new top-level script):
   `PI_MODEL=zai/glm-5.3 ZAI_API_KEY=<sourced from ~/.zshrc> bun
   bun-apps/s2-agent-ext-ultracode/samples/run.ts
   bun-apps/s2-agent-ext-ultracode/samples/audit-ext-packages.js
   '{"repoRoot":"<abs>","packages":[<26>],"batchSize":8}'`

## Acceptance

Script + test committed; ultracode gates green; fake-runner test proves prompt
shape (READ-ONLY clause present in every auditor prompt) and synthesizer
completeness; driver recipe recorded verbatim for t02.

## Evidence

Test file + its output; the recipe string above; no schema-cost delta.
