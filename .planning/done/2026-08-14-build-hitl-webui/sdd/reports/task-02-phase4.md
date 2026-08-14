# Task 02 — Phase 4: image presentation helper + `webui_present` guidance (+ authorized hardening micro-fix)

- **BASE:** `c71d2582c1fbe42ad0bf6c0b7303b13e958820e9` (Task 1 done: output-routes.ts + chained seam live)
- **HEAD:** `ed96f06c` — 2 commits, `hitl-webui-phase4` branch (not pushed / no PR, per task instructions)

## Commit A — `fea0ce4a` `feat(webui): imageMd/imageMdFromDetails helpers + teach webui_present the /output pattern`

Files (exactly 3):
- `bun-apps/pi-agent-ext-webui/src/image-presentation.ts` (new)
- `bun-apps/pi-agent-ext-webui/src/present-tool.ts` (description/promptSnippet strings only — no schema/execute change)
- `bun-apps/pi-agent-ext-webui/tests/image-presentation.test.ts` (new)

TDD evidence (plan Task 2 steps 1–7, verbatim spec):
1. RED — `bun test tests/image-presentation.test.ts`: `Cannot find module '../src/image-presentation.js'` (0 pass / 1 fail / 1 error).
2. Created `src/image-presentation.ts` (pure `node:path` only; `IMAGE_EXTENSIONS` = png/jpg/jpeg/webp/gif; `rel === ".."` / `..${sep}` / absolute escape checks that do NOT false-reject `..foo.png`).
3. PARTIAL GREEN — 17 pass / 1 fail: only the `webui_present description teaches the /output pattern` test failed on `toContain("![image](/output/0/<name>)")` — exactly the plan's expected intermediate state.
4. Edited `present-tool.ts` description + promptSnippet (strings only). GREEN — 18 pass / 0 fail.
5. Full gate: `bun run test` (tsc build + suite) — 310 pass / 0 fail (292 prior + 18 new).

## Commit B — `ed96f06c` `fix(webui): uniform 404 on malformed %-sequences and null bytes in /output route`

Files (exactly 2):
- `bun-apps/pi-agent-ext-webui/src/output-routes.ts`
- `bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts`

Authorized hardening micro-fix from Task-1 review findings 1–2. TDD:
1. RED — added 2 tests in the `failure paths (uniform 404)` describe: `/output/%FF` → 404 (threw URIError from `decodeURIComponent` at output-routes.ts:96) and `/output/%00.png` → 404 (threw TypeError from `statSync` "without null bytes"). Both failed asserting 404.
2. Implementation: wrapped `decodeURIComponent(...)` in try/catch → `notFound()` on URIError; added `if (rest.includes("\0")) return notFound();` after decode, before dir-idx strip. No other behavior touched.
3. GREEN — `tests/output-routes.test.ts` 20 pass / 0 fail.

## Gates

- `( cd bun-apps/pi-agent-ext-webui && bun run test )` after Commit A: **310 pass / 0 fail** (26 files).
- Same gate after Commit B (final): **312 pass / 0 fail** (26 files, 699 expect() calls) — 292 prior + 18 image tests + 2 hardening. Matches the expected ~312.

## Deviations

None. Verbatim plan code used for Task 2 steps 1–7; hardening fix applied exactly as authorized. Preserved files (`?? .planning/zk-spawn/`, `?? history.txt`, `M .agents/memory/MEMORY.md`, plus the pre-existing untracked `?? .planning/.../task-01-phase4.md`) left uncommitted. No push / PR / merge performed.
