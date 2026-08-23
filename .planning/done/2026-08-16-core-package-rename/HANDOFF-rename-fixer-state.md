# Handoff state: role-targeted-fixer-for-a-rename-refacto (branch `refactor/core-package-names`)

Budget exhausted mid-run. Everything verified so far is below; the edit for Issue A is
already applied to the working tree (uncommitted). Resume from "REMAINING STEPS".

## Issue A — seam test dead key `__piRateLimitState` — FIXED (edit applied, gate NOT yet re-run)

- The task brief was WRONG on location: `test:seam` is NOT a `bun-apps/pi-agent` script.
  It lives in `bun-apps/package.json` (`"test:seam": "bun test tests/seam-contract.test.ts"`)
  and the failing file is `bun-apps/tests/seam-contract.test.ts` (there is no
  `bun-apps/pi-agent/tests/spawn-subagent.test.ts`; that file is in pi-agent-ext-subagent
  and is unrelated).
- Failure: "NO DEAD KEYS — registered but unreferenced: __piRateLimitState".
- Root cause (1 line): the scanner's `EXTS` filter only matched dirs starting with
  `pi-agent-ext-`, so after the rename the key's owner `pi-agent-core-runtime`
  (rate-limiter.ts line 34, `const GLOBAL_KEY = "__piRateLimitState"`) was no longer
  scanned → the registered key looked dead.
- Fix (APPLIED in `bun-apps/tests/seam-contract.test.ts`): EXTS filter changed to
  `/^pi-agent-(ext|core)-/.test(d)` with an explanatory comment. Including
  `pi-agent-core-interface` is safe: its only `__pi*` mentions are inside comment lines,
  which the scanner skips (verified by grep).
- The relative import at line ~54 was ALREADY correctly renamed
  (`../pi-agent-core-interface/src/index.ts`).

## Issue B — ADR slugs — root-caused, NOT yet fixed

Gate: `( cd bun-apps && bun run test:adr )` → `bun test tests/adr-citation.test.ts`.
Rule: context id = folder minus `pi-agent-ext-`; task states expected slugs
`ADR-task-0001` (folder `pi-agent-ext-task`) and `ADR-pi-agent-core-runtime-0001`
(folder `pi-agent-core-runtime`, no `ext-` prefix to strip). Run the gate once to
confirm the exact expected ids before bulk-editing if unsure.

Exact occurrences to rewrite (verified by grep, all under bun-apps/):

`ADR-core-task-0001` → `ADR-task-0001`:
- bun-apps/pi-agent-ext-task/docs/adr/0001-subagent-dock-focus-claim.md (lines 1, 3)
- bun-apps/pi-agent-ext-task/src/subagents/dock.test.ts (lines 2, 19)
- bun-apps/pi-agent-ext-task/src/subagents/dock-claim.test.ts (line 3)
- bun-apps/pi-agent-ext-task/src/subagents/dock.ts (lines 2, 5)
- bun-apps/pi-agent-ext-task/src/subagents/dock-claim.ts (line 2)
- bun-apps/docs/adr/INDEX.md (lines 49 `### core-task` header, 53 row)

`ADR-core-runtime-0001` → `ADR-pi-agent-core-runtime-0001`:
- bun-apps/pi-agent-core-runtime/docs/adr/0001-runview-destructive-convergence.md (line 1)
- bun-apps/docs/adr/INDEX.md (lines 55 `### core-runtime` header, 59 row)

Also update INDEX.md section headers `### core-task` → `### task` and
`### core-runtime` → `### pi-agent-core-runtime` (the test likely keys on these).

## Issue C — NOT verified

Run: `git diff origin/main -- bun-apps/pi-agent/tests/model-role-config.test.ts`
Expect a clean 2-line package-name rename (old→new). If mangled, fix to a clean rename.

## REMAINING STEPS

1. Fix B per the table above (sed across the listed files only).
2. Verify C.
3. Gates (all from repo root, all must pass):
   - `( cd bun-apps && bun run test:seam 2>&1 | tail -3 )`
   - `( cd bun-apps/pi-agent && bun test 2>&1 | tail -3 )`
   - `( cd bun-apps && bun run test:adr 2>&1 | tail -3 )`
4. Commit (NEVER -A, NEVER `.agents/`):
   `git add bun-apps .github scripts .planning/recon`
   Message:
   `refactor(workspace): rename core packages — pi-agent-ext-core-{runtime,interface} → pi-agent-core-{runtime,interface}; pi-agent-ext-core-task → pi-agent-ext-task; harden devops ext references`
5. Report per the original brief.

## Constraints (from brief)

- NO broad exploration. Biome `useConst` errors in agent-turns.test.ts/biome.json are
  PRE-EXISTING on main — do NOT touch. Already green, do NOT re-run: devops 421 tests,
  pi-agent-ext-task 824 tests, renamed pkgs' typechecks.
- 399 uncommitted files on branch at start (includes `.agents/memory/MEMORY.md` — excluded
  from the add by design).
