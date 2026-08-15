# Task 1 report — enable `noUncheckedIndexedAccess` (subagent+workflow) + fix LinkWeighting

**Status:** DONE_WITH_CONCERNS
**Branch:** `fix/subagent-workflow-tsconfig-strictness`
**Base:** `0bb07cde`
**Commit range:** `0bb07cde..3c6b821a` (single implementation commit `3c6b821a`; this report follows in a planning commit)
**Scope:** `bun-apps/pi-agent-ext-subagent/`, `bun-apps/pi-agent-ext-workflow/`, `bun-apps/pi-agent-ext-knowledge-card/` + planning dir. No other packages' tsconfigs were touched.

> Note on starting state: the implementation changes were already present in the working tree (uncommitted) when this task began. This report's job was to (a) reproduce the live error set, (b) verify every narrowing against the brief's rules, (c) confirm TUI trace output is byte-identical, (d) run the full verify matrix, and (e) commit + report. All verification below was performed freshly by this task.

## 1. What changed

- `pi-agent-ext-subagent/tsconfig.json` — added `"noUncheckedIndexedAccess": true` (next to `"strict": true`).
- `pi-agent-ext-workflow/tsconfig.json` — same.
- 10 source files narrowed (6 in subagent `src`, 5 in workflow `src`, 4 in knowledge-card `src`).
- `pi-agent-ext-knowledge-card/src/loop.ts` — `LinkWeighting` import redirected from `./retrieve.ts` (which did not re-export it) to the canonical `./entities.ts`. (Controller's preferred resolution.)

## 2. Verify matrix (run freshly; each line is a verbatim result)

| # | Command | Result |
|---|---------|--------|
| 1 | `( cd bun-apps/pi-agent-ext-subagent && bun run typecheck )` | ✅ EXIT 0 — clean (`$ bunx tsc --noEmit`) |
| 2 | `( cd bun-apps/pi-agent-ext-workflow && bun run typecheck )` | ⚠️ no `typecheck` script; ran `bunx tsc --noEmit` → ✅ EXIT 0 — clean |
| 3 | `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck )` | ⚠️ no tsconfig + no `typecheck` script; `bunx tsc --noEmit` prints help (no project). Knowledge-card source is typechecked downstream by `pi-agent-cli` (which has the flag and compiles its `src`) — see row 6 + the BASE comparison. |
| 4 | `( cd bun-apps/pi-agent-ext-movie-director && bun run typecheck )` | ❌ FAIL — but **only** on pre-existing `../pi-agent-ext-ltx/src/*` + `../pi-agent-ext-flux2/src/vlm.ts` errors (untouched packages, out of scope). **Zero** subagent/workflow/knowledge-card errors. |
| 5 | `( cd bun-apps/pi-agent-ext-obsidian && bun run typecheck )` | ✅ EXIT 0 — clean (`$ tsc --noEmit`) |
| 6 | `( cd bun-apps/pi-agent-cli && bun run typecheck )` | ❌ FAIL — but **only** on pre-existing `../pi-agent-ext-ltx/*` (19) + `../pi-agent-ext-flux2/src/vlm.ts` (1) errors (untouched packages, out of scope; flux2's is an unrelated `TS2353 modelRegistry`). **Zero** subagent/workflow/knowledge-card errors remain. |
| 7 | `( cd bun-apps/pi-agent && bun run typecheck )` | ✅ EXIT 0 — clean (LinkWeighting fix landed) |
| 8 | `( cd bun-apps/pi-agent-ext-subagent && bun test )` | ✅ 546 pass / 0 fail (170 expect calls, 37 files) |
| 9 | `( cd bun-apps/pi-agent-ext-workflow && bun test )` | ⚠️ 1057 pass / 3 todo / **2 fail** — both **pre-existing** (see §4) |
| 10 | `( cd bun-apps/pi-agent-ext-knowledge-card && bun test )` | ✅ 389 pass / 0 fail (1079 expect calls, 34 files) |

## 3. BASE comparison (proof the in-scope errors are cleared; ltx/flux2 are pre-existing)

`pi-agent-cli` is the authoritative downstream compiler of all three in-scope packages. At clean BASE (`git stash` of all in-scope work), `bun run typecheck` reported these per-source error counts:

```
13  ../pi-agent-ext-subagent/src/subagent-tool.ts      ← in-scope (now cleared)
 7  ../pi-agent-ext-subagent/src/tool-action-label.ts  ← in-scope (now cleared)
 5  ../pi-agent-ext-workflow/src/web-tools.ts          ← in-scope (now cleared)
 5  ../pi-agent-ext-workflow/src/task-panel.ts         ← in-scope (now cleared)
 4  ../pi-agent-ext-subagent/src/subagents-tool.ts     ← in-scope (now cleared)
 3  ../pi-agent-ext-subagent/src/watchdog/repo-diff.ts ← in-scope (now cleared)
 2  ../pi-agent-ext-workflow/src/workflow-editor.ts    ← in-scope (now cleared)
 2  ../pi-agent-ext-knowledge-card/src/semantic.ts     ← in-scope (now cleared)
 2  ../pi-agent-ext-ltx/src/shotLanguage.ts            ← OUT of scope (pre-existing)
 2  ../pi-agent-ext-ltx/src/runpy.ts                   ← OUT of scope (pre-existing)
 2  ../pi-agent-ext-ltx/src/index.ts                   ← OUT of scope (pre-existing)
 2  ../pi-agent-ext-ltx/extensions/ltx.ts              ← OUT of scope (pre-existing)
 1  ../pi-agent-ext-workflow/src/workflow-ui.ts        ← in-scope (now cleared)
 1  ../pi-agent-ext-workflow/src/workflow-tool.ts      ← in-scope (now cleared)
 1  ../pi-agent-ext-ltx/src/paths.ts                   ← OUT of scope (pre-existing)
 1  ../pi-agent-ext-knowledge-card/src/supersede.ts    ← in-scope (now cleared)
 1  ../pi-agent-ext-knowledge-card/src/loop.ts         ← in-scope (now cleared; LinkWeighting)
 1  ../pi-agent-ext-knowledge-card/src/ingest.ts       ← in-scope (now cleared)
 1  ../pi-agent-ext-flux2/src/vlm.ts                   ← OUT of scope (pre-existing, unrelated TS2353)
12  ../pi-agent-ext-ltx/src/result.ts                  ← OUT of scope (pre-existing)
```

**After** the fix, `pi-agent-cli` reports **only** the 20 `pi-agent-ext-ltx` (19) + `pi-agent-ext-flux2` (1) errors. The 27 subagent + 14 workflow-own + 5 knowledge-card errors (46 total) are eliminated. The ltx/flux2 errors live in untouched files in separate packages and are independent of this task (different root cause; the brief's premise named only subagent source). The map in the brief was a floor, not a ceiling: 4 extra knowledge-card sites (`ingest.ts`, `semantic.ts` ×2, `supersede.ts`) were surfaced by `pi-agent-cli` compiling knowledge-card `src` under the flag and were fixed identically.

## 4. Sites where semantics changed

**None.** Every narrowing preserves the exact runtime behavior of the defined-case path:
- Guards / optional-chaining / early-returns mirror the existing defined-case branch (e.g. `if (!e) continue;`, `m[2] ?? ""`, `if (!head) {...}`).
- `workflow-editor.ts:101` ANSI-tokenizer loop rewrite (`while` with a `const c = line[j]` + `if (c !== undefined && c in range) break;`) is provably equivalent to the original `while (j<len && !(line[j] in range)) j++;` for all in-bounds `j` (string indexing within `j < length` is always defined; the `c !== undefined` arm is unreachable inside the loop and exists only to satisfy the compiler).
- `task-panel.ts:287` `if (!oldest || !newest) return 0;` is unreachable (guarded by the preceding `samples.length < 2` early-return) — pure type-narrowing, no behavior change.

## 5. Every `!` used, with its invariant

1. `pi-agent-ext-subagent/src/subagent-tool.ts:459` — `history[pairIdx]!`
   - **invariant (in code comment):** `pairIdx` is a valid history index — set from an in-range loop variable `j`, or from `i+1` after a defined-result check.
2. `pi-agent-ext-subagent/src/tool-action-label.test.ts:140` — `history[1]!`
   - **invariant (in code comment):** the test builds `history` as `[call(...), result(...)]` two lines above; index 1 is the `result()` entry.
3. `pi-agent-ext-subagent/src/tool-action-label.test.ts:146` — `history[0]!`
   - **invariant (in code comment):** the test builds `history` as `[result(...)]` one line above; index 0 is that single entry.
4. `pi-agent-ext-workflow/src/task-panel.ts:275` — `samples[0]!.ts`
   - **invariant (in code comment):** the `while` short-circuits on `samples.length > 2`, so `samples[0]` is defined on every condition evaluation.
5. `pi-agent-ext-workflow/src/workflow-ui.ts:230` — `this.stack[this.stack.length - 1]!`
   - **invariant (in code comment):** `NavigatorState.stack` is never empty — initialized with a root frame and `pop()` refuses to go below length 1.
6. `pi-agent-ext-knowledge-card/src/supersede.ts:73` — `fmMatch[1]!`
   - **invariant (in code comment):** `fmMatch` is truthy (guarded by `if (!fmMatch) return ...` directly above) and the regex has one mandatory capture group.

(All other sites used a guard / optional-chaining rather than `!`.)

## 6. TUI trace preservation (PR #1161 labels)

The labels fixed in #1161 are driven by `tool-action-label.ts` (`matchedCallArgsFor`, `scrapeJsonStrings`, `presentPhrase`/`pastPhrase`) and `subagent-tool.ts` (`latestMessageLine`, `formatSubagentTrace`). After narrowing:
- `tool-action-label.test.ts` + `subagent-tool.test.ts` (the TUI trace label tests) — **all pass**.
- `bun-apps/pi-agent-ext-subagent && bun test` — **546 pass / 0 fail**.
No guard alters rendered output: the new `if (!e) continue;` / `if (!last) return null;` / `history[j]?.x` arms are unreachable on the non-empty histories the trace renderer operates on (callers guard emptiness upstream).

## 7. Concerns

1. **`pi-agent-ext-movie-director` and `pi-agent-cli` `bun run typecheck` are not green** — but **not** because of this task. They fail on 20 pre-existing errors in `pi-agent-ext-ltx` (19) and `pi-agent-ext-flux2` (1), which are separate in-repo packages, were untouched by this task, and fail at clean BASE for the same reason. The brief's premise (these packages fail "because they compile subagent's `.ts` source") covers only the subagent root cause, which is now resolved. A follow-up task scoped to `pi-agent-ext-ltx`/`pi-agent-ext-flux2` would close those. (Note: `pi-agent-ext-flux2/src/vlm.ts` is a `TS2353 modelRegistry` unknown-property error, unrelated to `noUncheckedIndexedAccess`.)
2. **2 pre-existing workflow test failures** (`renderNavigator agents view shows a running agent's latest tool call`, `renderPanelDetailed > shows the running agent's latest tool call as a live activity line`) — confirmed failing at clean BASE (`git stash` of all in-scope work → same 2 fails, 79 pass). They are **not** introduced or affected by this type-only change and are out of scope.
3. **`pi-agent-ext-knowledge-card` has no `tsconfig.json`** and no `typecheck` script, so its source cannot be typechecked in isolation. Its correctness is verified transitively via `pi-agent-cli` (row 6) — which is now free of knowledge-card errors — and via its `bun test` suite (389 pass). No new tsconfig was added (out of scope; would be a separate decision).
4. **`pi-agent-ext-workflow` has no `typecheck` script**; verification used `bunx tsc --noEmit` (the workflow tsconfig already carries the flag). The package's `test` script runs biome `check` + `build` + `test:unit`; per the brief, `bun test` was run for the test row.
5. An unrelated, out-of-scope change to `.agents/memory/MEMORY.md` (a `pi-agent-ext-deploy → pi-agent-ext-devops` rename memory entry) was present in the working tree and was **deliberately left unstaged/uncommitted** — it is outside this task's scope.

## 8. Files touched (committed in `3c6b821a`)

```
bun-apps/pi-agent-ext-subagent/tsconfig.json
bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts
bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts
bun-apps/pi-agent-ext-subagent/src/tool-action-label.ts
bun-apps/pi-agent-ext-subagent/src/tool-action-label.test.ts
bun-apps/pi-agent-ext-subagent/src/watchdog/repo-diff.ts
bun-apps/pi-agent-ext-workflow/tsconfig.json
bun-apps/pi-agent-ext-workflow/src/task-panel.ts
bun-apps/pi-agent-ext-workflow/src/web-tools.ts
bun-apps/pi-agent-ext-workflow/src/workflow-editor.ts
bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts
bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts
bun-apps/pi-agent-ext-knowledge-card/src/ingest.ts
bun-apps/pi-agent-ext-knowledge-card/src/loop.ts
bun-apps/pi-agent-ext-knowledge-card/src/semantic.ts
bun-apps/pi-agent-ext-knowledge-card/src/supersede.ts
```
