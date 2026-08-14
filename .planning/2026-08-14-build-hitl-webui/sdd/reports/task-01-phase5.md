# Task 1 (Phase 5) — Drop the tool-mirror + `webui_render` tool

## Scope

Task 1 of the HITL-webui Phase-5 plan (`plan-phase5.md`): pure subtraction per
spec Component 6 + Decision B. Tasks 2–3 belong to a different implementer and
were NOT touched.

## Commits

- BASE: `3295745e` (origin/main, "planning(hitl-webui): Phase-5 plan")
- HEAD: `0c715949` — `feat(webui): drop tool-mirror + webui_render tool (spec Component 6, Decision B)`
- Diff: 11 files, +45 / −794

## Changes

### Deletions (7, via `git rm`)

- `src/tool-mirror.ts`, `src/render-tool.ts`
- `tests/tool-mirror.test.ts`, `tests/tool-mirror-format.test.ts`,
  `tests/tool-mirror-accumulation.test.ts`, `tests/tool-mirror-integration.test.ts`,
  `tests/render-tool.test.ts`

### Modifications (4)

- `tests/render-integration.test.ts` — 4 surgical rewrites per plan Step 1
  (test 1 asserts `webui_present`; tool-execute test deleted; loopback-URL test
  rewritten event-driven; decoupling test drops the tool half) + the two
  NEGATIVE tests appended (plan Step 2).
- `src/webui-wiring.ts` — removed 2 imports (`createRenderTool`,
  `createToolMirror`), the `webui_render` registration line, the whole
  tool-mirror reg block (comment + `reg("tool_result", …)`), reworded 2 stale
  JSDoc comments (`webui_render` → `webui_present`; `render-tool` →
  `present-tool`). Outbound `tool_result` broadcast in `OUTBOUND_EVENTS`
  untouched; guarded-seam comment block above `webui_present` kept.
- `tests/helpers/mock-pi.ts` — L87 comment only.
- `src/present-tool.ts` — L12 comment only (dropped `createRenderTool` mention).

## TDD evidence

- Red (pre-subtraction, plan Step 3): `bun test tests/render-integration.test.ts`
  → 6 pass / 1 fail — the first NEGATIVE failed exactly as predicted
  (`webui_render` still registered: expected false, received true). The second
  negative passed pre-subtraction, as the plan's context note anticipated
  (MockPi keeps one handler per event; broadcast registers last).
- Green (post-subtraction, plan Step 10): `( cd bun-apps/pi-agent-ext-webui && bun run test )`
  → **286 pass / 0 fail** (618 expect() calls, 21 files). `bunx tsc` build exit 0.
  Matches the plan's derivation: 312 − 27 deleted-file tests − 1 removed + 2 new = 286.

## Gates

- `bun run test` (build + bun test): PASS, exit 0, 286/0.
- `rg 'tool-mirror|render-tool|createToolMirror|createRenderTool|webui_render' src tests extensions`:
  only hits are the plan's own verbatim negative-test strings in
  `tests/render-integration.test.ts` (test title/comment/assertions); zero
  references remain in `src/`, `extensions/`, or comments elsewhere.
- Invariants: `render-event-handler.ts` retained (dormant channel, Decision B);
  `webui-wiring.test.ts` untouched; `render-shell.ts` untouched; no new deps;
  loopback/auth untouched.

## Deviations

- None in code. Two procedural notes:
  1. `plan-phase5.md` was not in the local tree at task start; it arrived via
     origin/main (`3295745e`, PR #1314) and was read after the branch checkout.
  2. The plan's Step 11 `git add bun-apps/pi-agent-ext-webui` directory
     shorthand was forbidden by the dispatch instructions; files were staged
     individually (7 `git rm` deletions + 4 explicit `git add` paths).

## Not committed (per instructions)

- This report, `.planning/zk-spawn/`, `history.txt`, `.agents/memory/MEMORY.md`
  left untracked/modified as found.
