# SDD Report — Task 1 (Phase 4): `/output` serving route + wiring chain

- **Task:** zk-spawn / Task 1 of `plan-phase4.md` (`/output` serving route, `src/output-routes.ts` + wiring chain)
- **Branch:** `hitl-webui-phase4`
- **BASE:** `ef9a33f9702d7d490ec8900db469b2648ef908dc` (matches expected `ef9a33f9`)
- **HEAD:** `c71d2582` — `feat(webui): serve MLX output dir at /output behind the render seam`
- **Preserved files untouched:** `.planning/zk-spawn/`, `history.txt` untracked; `.agents/memory/MEMORY.md` modification left uncommitted.

## Files committed (4)

| File | Change | Summary |
|---|---|---|
| `bun-apps/pi-agent-ext-webui/src/output-routes.ts` | create | `/output` route factory: `resolveOutputDir` (explicit → `MLX_OUTPUT_DIR` → `../video_generation__output`, relative vs `process.cwd()`), 9-entry MIME allowlist + octet-stream fallback, `nosniff` + `no-cache` on every response incl. 404s, trailing-separator containment, uniform 404, optional dirIdx segment parsed and ignored, `null` fall-through for non-GET / non-`/output`. |
| `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` | modify | Import `createOutputRoutes`; `WebuiDeps.outputDir?: string`; seam replaced with chained handler `renderRoutes(req, srv) ?? outputRoutes(req, srv)` (located by symbol `server.setHttpRoutes(createRenderRoutes(registry))`, was ~L361). |
| `bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts` | create | 18 tests: happy paths (png/mp4/octet-stream/subpath/dirIdx/plain), uniform-404 matrix (missing, raw-dot + `%2F`/`%2e` encoded traversals against an on-disk canary, empty name, directory target), fall-through (non-/output, non-GET), `resolveOutputDir` resolution, one live `WebServer` integration test through the real origin-guarded `fetch()`. |
| `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` | modify | One added test: chained seam serves `/output/0/shot.png` via injected `deps.outputDir`, `/api/views` still answers first, unknown path falls through to `null`. |

## TDD evidence

1. **RED (output-routes):** `bun test tests/output-routes.test.ts` → `Cannot find module '../src/output-routes.js'` (module absent).
2. **GREEN (output-routes):** after writing `src/output-routes.ts` verbatim from the plan → initially 12 pass / **6 fail** (all happy paths 404). Root cause: bun:test runs describe bodies eagerly at collection time, so the plan's describe-scoped `const routes = createOutputRoutes({ dir: outDir })` captured `outDir === undefined` before `beforeAll` ran. **Fix (deviation D1):** moved the fixture from `beforeAll` to module-level eager init; all test bodies unchanged → 18 pass / 0 fail.
3. **RED (wiring):** `bun test tests/webui-wiring.test.ts` → 32 pass / **1 fail** (the new chained-seam test; `outputDir` unknown on `WebuiDeps`, `/output` falls through → null).
4. **GREEN (wiring):** after the wiring chain edit → 33 pass / 0 fail.

## Gates

- `( cd bun-apps/pi-agent-ext-webui && bun run test )` → `bunx tsc` build exit 0, then **292 pass / 0 fail** across 25 files (273 existing + 19 new). PASS.
- `git diff --cached --name-only` verified exactly the 4 intended files before commit.

## Deviations from the plan

1. **D1 — output-routes.test.ts fixture ordering (plan bug):** the plan's `beforeAll` fixture + describe-scoped route consts cannot work under bun:test's eager describe-body evaluation. Moved fixture creation (`mkdtempSync`/`mkdirSync`/`writeFileSync` block) to module top level; removed the now-unused `beforeAll` import and the no-op `afterEach(() => {})` stub that existed only "alongside beforeAll". Test bodies, assertions, and the implementation (`src/output-routes.ts`) are verbatim from the plan.
2. **D2 — wiring-test fs import (pre-authorized by the task brief):** added `mkdirSync` to the `node:fs` import list (`mkdirSync, mkdtempSync, rmSync, writeFileSync`) so imports match usage.
3. **Minor:** `rmSync` remains imported-but-unused in `output-routes.test.ts` (as in the plan's verbatim snippet); harmless because the package's `tsc` build only includes `src/**` and `noUnusedLocals` is not set.

## Outcome

Task 1 complete; Task 2 (`image-presentation.ts` + `webui_present` description) intentionally untouched. No push / PR / merge performed.
