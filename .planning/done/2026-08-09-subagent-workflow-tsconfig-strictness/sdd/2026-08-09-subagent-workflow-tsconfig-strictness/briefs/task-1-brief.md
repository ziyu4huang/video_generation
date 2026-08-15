# Task 1 brief — enable noUncheckedIndexedAccess (subagent+workflow) + fix LinkWeighting

You are fixing a cross-package typecheck-strictness gap. TYPE-ONLY: zero runtime behavior change. Read this brief first — it is your requirements, with the exact sites.

## 1. Enable the flag in two tsconfigs
- `bun-apps/pi-agent-ext-subagent/tsconfig.json`: add `"noUncheckedIndexedAccess": true` to `compilerOptions` (next to `"strict": true`).
- `bun-apps/pi-agent-ext-workflow/tsconfig.json`: same.

## 2. Narrow every site (reproduce live with `bun run typecheck` after enabling the flag, fix until green)

Authoritative error set (captured via `bunx tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess`):

**subagent (29)** — `bun-apps/pi-agent-ext-subagent/src/`:
- `subagent-tool.ts`: 322 (cols 36,60,7 and the 322 cluster), 323:48, 436:9, 443:11, 445:15, 445:51, 445:77, 459:33, 463:42, 466:18, 471:36
- `subagents-tool.ts`: 195:33, 558:31, 650:21, 650:54
- `tool-action-label.ts`: 217:9 (TS2538 index), 344:11, 344:39, 345:26, 354:37, 354:9, 355:24
- `tool-action-label.test.ts`: 140:33, 146:33
- `watchdog/repo-diff.ts`: 72:9, 73:20, 74:22

**workflow-own (14)** — `bun-apps/pi-agent-ext-workflow/src/`:
- `task-panel.ts`: 275:38, 285:21, 285:33, 287:17, 287:32
- `web-tools.ts`: 50:47, 50:64, 51:14, 52:16, 52:28
- `workflow-editor.ts`: 101:37, 101:55
- `workflow-tool.ts`: 754:21
- `workflow-ui.ts`: 230:5

Enabling the flag in subagent surfaces all 29. Enabling it in workflow surfaces 41 = the 27 subagent *src* errors re-pathed through `../pi-agent-ext-subagent/` + the 14 workflow-own above. Fixing subagent src clears the 27; then fix the 14 workflow-own.

## 3. Fix knowledge-card `LinkWeighting`
- `entities.ts:282` exports `export type LinkWeighting = "count" | "idf";`.
- `loop.ts:43` imports `type LinkWeighting` from `./retrieve.ts`, which does NOT re-export it.
- Fix: import `LinkWeighting` from the canonical `./entities.ts` in `loop.ts` (preferred), OR add `export type { LinkWeighting } from "./entities.ts";` to `retrieve.ts`. Goal: `pi-agent` typecheck green.

## How to narrow (rules)
- Preserve runtime behavior exactly. For array/object index access now `T | undefined`: guard with `if` (x) / optional-chaining / early-return mirroring the existing defined-case behavior.
- For `arr[arr.length - 1]`-style "last" access (`last`, `e`, `prev`, `newest`, `oldest`, `tok`, `slot`): a guarded early-return on empty is the safe narrowing. If a clear invariant exists you MAY use `!` with a `// invariant:` comment.
- For function args flagged `AgentHistoryEntry | undefined` / `T | undefined` / `StackFrame | undefined`: narrow at the call site (guard) rather than widening the callee signature.
- NEVER silently change control flow to "make it compile". If a site genuinely needs new undefined-handling, implement it correctly and note it in the report.

## TUI preservation (critical)
`tool-action-label.ts` (`matchedCallArgsFor`, `presentPhrase`/`pastPhrase` around 217/344-355) and `subagent-tool.ts` (322/323 `last`, 436-471 `e`/entry args) drive the trace labels fixed in PR #1161. After narrowing, the existing tests in `tool-action-label.test.ts` and `subagent-tool.test.ts` MUST still pass with unchanged behavior. If a guard would alter output, choose the narrowing that keeps output identical.

## Verify (capture each result line in the report)
Run each in a subshell. If a package has no `typecheck` script, run `bunx tsc --noEmit` instead.
```
( cd bun-apps/pi-agent-ext-subagent && bun run typecheck )
( cd bun-apps/pi-agent-ext-workflow && bun run typecheck )
( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck )
( cd bun-apps/pi-agent-ext-movie-director && bun run typecheck )
( cd bun-apps/pi-agent-ext-obsidian && bun run typecheck )
( cd bun-apps/pi-agent-cli && bun run typecheck )
( cd bun-apps/pi-agent && bun run typecheck )
( cd bun-apps/pi-agent-ext-subagent && bun test )
( cd bun-apps/pi-agent-ext-workflow && bun test )
( cd bun-apps/pi-agent-ext-knowledge-card && bun test )
```

## Commit + report
- Commit on the current branch `fix/subagent-workflow-tsconfig-strictness`. Suggested message: `fix(subagent,workflow): enable noUncheckedIndexedAccess + narrow index-access sites`.
- Write your report to `sdd/2026-08-09-subagent-workflow-tsconfig-strictness/reports/task-1-report.md`: status, commit sha range, per-package typecheck+test result lines, any site where semantics changed (should be none), any `!` used with its invariant.
- Return: Status (DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED), commit shas, one-line test summary, concerns.
