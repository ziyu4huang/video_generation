# Task 12 Report — final verification

Branch: `feat/btw-panel-in-webui`, head before this task: `1c733782` ("test(webui): pin the btw/webui bus contract without package coupling").

## Step 1 — btw package gate

```
( cd bun-apps/pi-agent-ext-btw && bun run test )
```

Result: **PASS**

- 31 pass, 0 fail, 86 expect() calls, 7 test files, 221ms
- Includes the new webui-seam tests (`webui-events.test.ts`: 4 tests; `webui-bridge.test.ts`: 4 tests, incl. the overlay-attach regression pin from Task 3 fix round 1) plus all pre-existing tests (registration, extension-contract, markdown-render) — TUI regression-free.

## Step 2 — webui package gate

```
( cd bun-apps/pi-agent-ext-webui && bun run test )
```

Result: **PASS**

- 319 pass, 0 fail, 701 expect() calls, 27 test files, 515ms
- 27 = 16 pre-existing test files + 6 new btw test files + 5 pre-existing helper/tier files already present before this effort (27-file count is the full current suite; all green).

## Step 3 — no cross-package coupling

```
git grep -n "pi-agent-ext-btw" -- bun-apps/pi-agent-ext-webui/src bun-apps/pi-agent-ext-webui/package.json
git grep -n "from ['\"]@repo/pi-agent-ext" -- bun-apps/pi-agent-ext-webui/src
```

Result: **CLEAN (no coupling)**

- Grep A: exactly one match — `src/btw-channels.ts:5` — a comment: `* Mirrors bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts WITHOUT importing`. Comment-only, documents the deliberate mirror; zero code coupling.
- Grep B: zero matches — no `@repo/pi-agent-ext*` imports anywhere in `src/`.
- `package.json`: zero matches — no dependency entry.
- Permitted `tests/btw-contract.test.ts` comment mentions: unchanged, allowed per brief.

## Step 4 — no real-model test calls

```
git grep -rn "prompt(" -- bun-apps/pi-agent-ext-btw/__tests__ bun-apps/pi-agent-ext-webui/tests | grep -v "sendUserMessage\|summarizeThread\|session.prompt"
```

Result: **CLEAN (no real model calls)**

- Exactly one match — `tests/helpers/mock-pi.ts:10` — a doc comment: `* exactly as agent-session.js short-circuits `prompt()` on a "handled" input`. Comment-only; every test uses fake sessions, recording mocks, or pure helpers.

## Step 5 — clean tree

`git status --short` before this task showed only:

- `.agents/memory/MEMORY.md` (never staged, standing rule)
- `.planning/2026-08-15-btw-panel-in-webui/sdd/progress.md` (this task's ledger append)
- `.planning/2026-08-15-btw-panel-in-webui/sdd/task-12-brief.md` (untracked; committed by this task)
- `sdd/review-*.diff` files, `.planning/zk-spawn/`, `history.txt` (all excluded by standing rule)

No code stragglers — every code task committed. This task commits the brief + this report + the ledger.

## Type-consistency checklist (from brief self-review §3) — spot-verified in green gates

The contract assertions are enforced by the green suites: channel strings (`webui:btw-command` / `btw:event`) pinned by both packages' tests; frame shapes pinned by webui tests (inbound flat frame, outbound `{type:"btw", event}`); snapshot ids pinned by panel/contract tests; `btw-panel-collapsed` localStorage key pinned by panel tests — all exercised in Step 2's 319 green tests and Step 1's 31 green tests.

## Verdict

All gates green, sweep clean, no real-model calls, no code stragglers.
