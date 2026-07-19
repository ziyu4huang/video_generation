# Rename pi-agent-ext-goal-todo → pi-agent-ext-core-task — Implementation Plan (EXECUTED)

> **STATUS: EXECUTED 2026-07-20.** Originally frozen (deferred until the
> 2026-07-19-a plan-coordinator landed); unfrozen and executed in the same
> pass because the name was already decided (core-task), no in-flight code
> referenced goal-todo (plan-coordinator not yet built), and #710 had
> reconciled the planning landscape. One manual step remains (GitHub
> branch-protection required-check) — see Execution Notes at the bottom.
>
> **For agentic workers:** When unfrozen, use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `pi-agent-ext-goal-todo` package to `pi-agent-ext-core-task` across the whole monorepo (directory, package name, registrations, CI, cross-package dependency, metrics baseline, widget identifiers, docs) with zero behavior change.

**Architecture:** Pure rename + reference fixup. No runtime logic changes. The package already owns `/goal` + `goal_complete`, `todo` + `/todos`, `ask_user_question`, the shared composite status widget, and the `__piGoalActive` coordination seam — and is the designated home for the upcoming plan-coordinator. The name "core-task" matches the concept the team already uses internally (CONTEXT.md: "broader core-task pi-ext consolidation") and the monorepo's concept-naming convention (power-tool, btw, wayfind, hermes-memory). The rename is mechanical; the only coordination points are (a) a live GitHub branch-protection required-check name change, and (b) the cross-package `globalThis` widget-singleton key that must stay in sync between this package and `pi-agent-ext-wayfind`.

**Tech Stack:** Bun workspace monorepo, TypeScript, pi-coding-agent extension protocol, GitHub Actions CI.

## Global Constraints

- **Conversation language zh-TW; all written artifacts (code, commits, docs) English** — per CLAUDE.md.
- **Never top-level `cd`** — use `( cd <dir> && ... )` or `--cwd`. `no-cd-drift.sh` blocks it.
- **One registered extension per folder**, entry at `extensions/<X>.ts` where `<X>` = folder minus `pi-agent-ext-` — per CLAUDE.md. Renaming the folder to `pi-agent-ext-core-task` ⇒ entry becomes `extensions/core-task.ts`.
- **No double-registration** — an extension must NOT be in both `manifest.json` `extensions[]` (dynamic `-e`) and `static-extensions.ts` (static import). goal-todo is correctly static-only (in `manifest.json` under `staticExtensions[]` metadata, NOT `extensions[]`); core-task must stay static-only.
- **`bun install` runs from `bun-apps/`, never repo root.**
- **Branch-protection required-check is a LIVE GitHub setting** — renaming the CI job breaks it until manually updated on GitHub.

---

## Sequencing Gate (read before executing)

**Precondition:** `.planning/2026-07-19-a/` plan-coordinator work has landed (its tickets say the coordination layer "lives inside goal-todo" and publishes `__piPlan*`). Rename AFTER, so:
1. We rename once, not twice.
2. The plan-coordinator's own registration/references are renamed in the same pass.
3. The "core-task" identity is fully earned by then.

If plan-coordinator landed as a SEPARATE package instead, re-evaluate whether this package should still be `core-task` — but the rename plan below still applies (just without plan-coordinator references).

---

## Frozen Blast Radius (captured 2026-07-20; RE-VERIFY in Task 0)

| # | File:line (as of capture) | What | Renames to |
|---|---|---|---|
| 1 | `bun-apps/pi-agent-ext-goal-todo/` (dir) | package directory | `bun-apps/pi-agent-ext-core-task/` |
| 2 | `…/package.json` `"name"` + description + keywords | pkg identity | `@repo/pi-agent-ext-core-task` |
| 3 | `…/extensions/goal-todo.ts` (entry file) | registered entry | `…/extensions/core-task.ts` |
| 4 | `bun-apps/pi-agent/run-dir/manifest.json:50` | `staticExtensions[]` entry | `"pi-agent-ext-core-task"` |
| 5 | `bun-apps/pi-agent/src/static-extensions.ts:44` (comment), `:55` (import), `:68` (name) | static registration | path `pi-agent-ext-core-task/extensions/core-task.ts`, var name, `"pi-agent-ext-core-task"` |
| 6 | `.github/workflows/ci.yml:90` (matrix), `:211` (regex), `:257` (comment) | CI test job | `pi-agent-ext-core-task` |
| 7 | `.github/CI.md:28,135,143,148,149` | CI docs + required-check list | `pi-agent-ext-core-task` |
| 8 | `bun-apps/pi-agent-ext-wayfind/package.json:59` | workspace dep | `"@repo/pi-agent-ext-core-task": "workspace:*"` |
| 9 | `bun-apps/pi-agent-ext-wayfind/src/index.ts:8,16,48,49` + `overlay.ts:3` | import specifier + comments | `@repo/pi-agent-ext-core-task/src/shared/status-widget.js` |
| 10 | `scripts/schema-cost-baseline.json:94,256` | hardcoded `"source": "goal-todo"` | `"core-task"` (must match dynamic derivation `tools-metrics.ts:559` = filename `.pop()`) |
| 11 | `…/CONTEXT.md` header + body | domain-language doc header | `pi-agent-ext-core-task` |
| 12 | `…/src/goal/goal.ts:1` header; `…/src/goal/overlay.ts`, `…/src/todo/overlay.ts`, `…/src/shared/status-widget.ts` comments | legacy "power-tool"/"goal-todo" origin refs | updated origin line (see Task 6) |

**Cosmetic widget identifiers (Task 7 — largest surface, may split into its own PR):**

| # | Identifier | File | Notes |
|---|---|---|---|
| W1 | `WIDGET_KEY = "pi-power-tool"` | `src/shared/status-widget.ts` | Local Map key — safe to rename alone. |
| W2 | `SINGLETON_GLOBAL_KEY = "__piPowerToolStatusWidget"` | `src/shared/status-widget.ts` | Cross-package via imported `getSharedStatusWidget()`; atomic if goal-todo + wayfind update together. `instanceof` deliberately unused (jiti hazard), so only type/comment refs. |
| W3 | class `PowerToolStatusWidget` → `CoreTaskStatusWidget` | `status-widget.ts` def + `getSharedStatusWidget` return type; test file; comment refs in goal/todo overlays + wayfind | Mechanical; large comment surface. |

**NOT renamed (correct as-is):** `__piGoalActive` (semantically about `/goal`, not power-tool-named), the `goal`/`todo`/`ask-user` source subtrees and their internal files, `globalThis.__piPlan*` seams (owned by plan-coordinator work).

---

## Task 0: Re-verify blast radius at execution time

**Why:** The plan-coordinator landing will ADD references to this package (its own registration, possibly its own `staticExtensions[]`/manifest entries, possibly new `__piPlan*` publisher code). The table above is a 2026-07-20 snapshot; it WILL drift.

**Files:** none modified — read-only re-scan.

- [ ] **Step 1: Re-run the reference scan and diff against the frozen table**

```bash
# Package-name / dir references (exclude node_modules, .git, historical plan docs)
grep -rn "goal-todo\|pi-goal-todo\|@repo/pi-agent-ext-goal-todo" \
  --include="*.ts" --include="*.json" --include="*.md" --include="*.sh" --include="*.toml" \
  bun-apps scripts .github \
  | grep -v node_modules | grep -v "docs/superpowers/"
```

Expected: matches the frozen Blast Radius table ABOVE, PLUS any new references the plan-coordinator work introduced. Record the delta; fold each new hit into a task below before executing.

- [ ] **Step 2: Re-verify the widget-identifier scan**

```bash
grep -rn "pi-power-tool\|__piPowerToolStatusWidget\|PowerToolStatusWidget" \
  --include="*.ts" bun-apps | grep -v node_modules
```

Expected: goal-todo + wayfind only. If plan-coordinator added a widget section, it will appear here too — fold into Task 7.

- [ ] **Step 3: Confirm no NEW double-registration risk**

Confirm `pi-agent-ext-core-task` (post-rename) stays OUT of `manifest.json` `extensions[]` and is only in `staticExtensions[]` + `static-extensions.ts`. Run `pi ext-doctor` if available.

---

## Task 1: Rename package directory + package.json + entry file

**Files:**
- Rename: `bun-apps/pi-agent-ext-goal-todo/` → `bun-apps/pi-agent-ext-core-task/`
- Rename: `…/extensions/goal-todo.ts` → `…/extensions/core-task.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/package.json`

**Interfaces:**
- Produces: package `@repo/pi-agent-ext-core-task`, entry `extensions/core-task.ts` (default export unchanged — internal relative imports stay valid because the whole subtree moves together).

- [ ] **Step 1: Move the directory (preserves git history)**

```bash
git mv bun-apps/pi-agent-ext-goal-todo bun-apps/pi-agent-ext-core-task
git mv bun-apps/pi-agent-ext-core-task/extensions/goal-todo.ts \
       bun-apps/pi-agent-ext-core-task/extensions/core-task.ts
```

- [ ] **Step 2: Update package.json identity**

In `bun-apps/pi-agent-ext-core-task/package.json`:
- `"name"`: `"@repo/pi-agent-ext-core-tod"` → `"@repo/pi-agent-ext-core-task"`
- `"description"`: lead with "core-task" framing (drive + track + decide + shared status surface)
- `"keywords"`: replace `"goal"`/`"todo"`/`"task-tracking"` with `["pi-package", "core-task", "goal", "todo", "task-tracking", "ask-user"]` (keep goal/todo as discoverability keywords)

- [ ] **Step 3: Update the entry file's header comment**

In `extensions/core-task.ts`, the header says `pi-agent-ext-goal-todo-ask — /goal + todo + ask_user_question unified.`. Change the first line to `pi-agent-ext-core-task — the task-execution cockpit: /goal + todo + ask_user_question + shared composite status widget.` Keep the rest (the goal/todo/ask-user merge history is accurate).

- [ ] **Step 4: Verify the package still tests green after the move**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test )
```

Expected: `282 pass` (unchanged — no logic touched). If count differs, a relative import broke in the move; fix path.

- [ ] **Step 5: Verify typecheck**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun run typecheck )
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task bun-apps/pi-agent-ext-goal-todo
git commit -m "refactor(pi-ext): rename goal-todo package dir + entry to core-task

Pure relocation; no logic change. 282 tests still green."
```

---

## Task 2: Update registration (manifest + static-extensions)

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/manifest.json:50`
- Modify: `bun-apps/pi-agent/src/static-extensions.ts:44,55,68`

**Interfaces:**
- Consumes: Task 1's new dir + entry path.
- Produces: `pi-agent-ext-core-task` registered as the always-on extension under its new name.

- [ ] **Step 1: manifest.json staticExtensions[]**

`bun-apps/pi-agent/run-dir/manifest.json` — in the `staticExtensions` array, replace `"pi-agent-ext-goal-todo"` with `"pi-agent-ext-core-task"`. Leave its position (first) unchanged.

- [ ] **Step 2: static-extensions.ts import + factory + comment**

In `bun-apps/pi-agent/src/static-extensions.ts`:
- Line 44 comment: `goal-todo, hermes-memory,` → `core-task, hermes-memory,`
- Line 55: `import goalTodoExtension from "../../pi-agent-ext-goal-todo/extensions/goal-todo.ts";` → `import coreTaskExtension from "../../pi-agent-ext-core-task/extensions/core-task.ts";`
- Line 68: `{ name: "pi-agent-ext-goal-todo", factory: goalTodoExtension },` → `{ name: "pi-agent-ext-core-task", factory: coreTaskExtension },`

- [ ] **Step 3: Verify pi-agent typecheck**

```bash
( cd bun-apps/pi-agent && bun run typecheck 2>/dev/null || bunx tsc --noEmit )
```

Expected: PASS (resolves the new import path).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent/run-dir/manifest.json bun-apps/pi-agent/src/static-extensions.ts
git commit -m "refactor(pi-agent): register core-task under new name (manifest + static)"
```

---

## Task 3: Update wayfind dependency + import

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/package.json:59`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/index.ts:8,16,48,49`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/overlay.ts:3`

**Interfaces:**
- Consumes: Task 1's new package name `@repo/pi-agent-ext-core-task`.
- Produces: wayfind imports the shared status widget from the renamed package.

- [ ] **Step 1: wayfind package.json dep**

`bun-apps/pi-agent-ext-wayfind/package.json:59`:
`"@repo/pi-agent-ext-goal-todo": "workspace:*"` → `"@repo/pi-agent-ext-core-task": "workspace:*"`

- [ ] **Step 2: wayfind import specifier + comments**

`bun-apps/pi-agent-ext-wayfind/src/index.ts`:
- Line 8 comment: `owned by pi-agent-ext-goal-todo` → `owned by pi-agent-ext-core-task`
- Line 16: `import { getSharedStatusWidget } from "@repo/pi-agent-ext-goal-todo/src/shared/status-widget.js";` → `from "@repo/pi-agent-ext-core-task/src/shared/status-widget.js";`
- Lines 48-49 comment: `pi-agent-ext-goal-todo` → `pi-agent-ext-core-task`

`bun-apps/pi-agent-ext-wayfind/src/overlay.ts:3` comment: `(owned by pi-agent-ext-goal-todo, …)` → `pi-agent-ext-core-task`.

- [ ] **Step 3: Refresh the Bun workspace linker**

```bash
( cd bun-apps && bun install )
```

Expected: installs; resolves `@repo/pi-agent-ext-core-task`.

- [ ] **Step 4: Verify wayfind tests + typecheck**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test )
( cd bun-apps/pi-agent-ext-wayfind && bun run typecheck )
```

Expected: PASS (wayfind's widget section still resolves via the new specifier).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind bun-apps/bun.lock
git commit -m "refactor(wayfind): depend on renamed core-task for shared status widget"
```

---

## Task 4: Update CI + branch protection (has manual GitHub step)

**Files:**
- Modify: `.github/workflows/ci.yml:90,211,257`
- Modify: `.github/CI.md:28,135,143,148,149`
- **Manual:** GitHub repo settings → branch protection.

**Interfaces:** none (CI config + GitHub setting).

- [ ] **Step 1: ci.yml matrix entry**

`.github/workflows/ci.yml:90`: `{ package: pi-agent-ext-goal-todo, test-cmd: "bun test" }` → `{ package: pi-agent-ext-core-task, test-cmd: "bun test" }`.

- [ ] **Step 2: ci.yml regex pattern**

`.github/workflows/ci.yml:211`: in the PATTERN regex, `pi-agent-ext-(goal-todo|hermes-memory|…)` → `pi-agent-ext-(core-task|hermes-memory|…)`.

- [ ] **Step 3: ci.yml comment**

`.github/workflows/ci.yml:257`: update the `goal-todo/…` comment to `core-task/…`.

- [ ] **Step 4: CI.md docs + required-checks list**

`.github/CI.md` lines 28, 135, 143, 148, 149: replace `pi-agent-ext-goal-todo` → `pi-agent-ext-core-task` in the required-checks list strings AND prose.

- [ ] **Step 5: ⚠️ MANUAL — update GitHub branch-protection required-check**

The job `test · pi-agent-ext-goal-todo` is a **required check** on the default branch. After rename, CI emits `test · pi-agent-ext-core-task`. Until the protection rule is updated, PRs are BLOCKED.

Go to: **GitHub → repo Settings → Branches → [default branch] rule → Required status checks** → remove `test · pi-agent-ext-goal-todo`, add `test · pi-agent-ext-core-task`. (Do this AFTER the renamed CI job has run at least once so GitHub offers it in the autocomplete.)

- [ ] **Step 6: Verify the CI job name locally (optional sanity)**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test )   # the exact cmd the matrix runs
```

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml .github/CI.md
git commit -m "ci: rename goal-todo matrix entry + docs to core-task

NOTE: GitHub branch-protection required-check updated manually out-of-band."
```

---

## Task 5: Update schema-cost baseline

**Files:**
- Modify: `scripts/schema-cost-baseline.json:94,256`

**Interfaces:** none (metrics baseline).

**Why:** `bun-apps/pi-agent-cli/src/commands/tools-metrics.ts:559` derives `source` dynamically as the entry filename's last path segment (`.replace(/\.ts$/, "").split("/").pop()`). After Task 1 renames the entry to `core-task.ts`, dynamic source becomes `core-task`. The committed baseline hardcodes `"source": "goal-todo"` for the `todo` and `goal_complete` tools; it MUST match or the metrics diff flags a false regression.

- [ ] **Step 1: Update the two source fields**

`scripts/schema-cost-baseline.json`:
- Line ~94 (`"name": "todo"` block): `"source": "goal-todo"` → `"source": "core-task"`
- Line ~256 (`"name": "goal_complete"` block): `"source": "goal-todo"` → `"source": "core-task"`

- [ ] **Step 2: Regenerate / verify the baseline (preferred)**

If the metrics generator is runnable, regenerate to confirm no OTHER field drifted:

```bash
( cd bun-apps/pi-agent-cli && bun run tools-metrics 2>/dev/null ) || \
  echo "no generator script — manual edit in Step 1 is sufficient"
```

Expected: the regenerated `source` for `todo` + `goal_complete` is `core-task`; token counts unchanged (rename must not change schema size).

- [ ] **Step 3: Commit**

```bash
git add scripts/schema-cost-baseline.json
git commit -m "chore(schema-cost): update baseline source goal-todo → core-task"
```

---

## Task 6: Update in-package docs + legacy origin headers

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-task/CONTEXT.md` (header line 1 + any body refs)
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts:1` (header origin line)
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/overlay.ts:2-5` (comments)
- Modify: `bun-apps/pi-agent-ext-core-task/src/todo/overlay.ts:2-5` (comments)
- Modify: `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts` (header comment refs, if not already handled in Task 7)

**Interfaces:** none (docs/comments only).

- [ ] **Step 1: CONTEXT.md header**

`CONTEXT.md` line 1 `# pi-agent-ext-goal-todo` → `# pi-agent-ext-core-task`. Add a one-line note under the header: *Renamed from pi-agent-ext-goal-todo on <exec-date>; name reflects the core-task consolidation home (drive /goal + track todo + decide ask_user + shared status surface).*

- [ ] **Step 2: goal.ts header origin line**

`src/goal/goal.ts:1` currently: `goal tool + /goal command — ported from @narumitw/pi-goal v0.11.0.`. Prepend/replace with a unified origin line consistent across the package: `// origin: extracted from power-tool (2026-07 monolith split); upstream lineage @narumitw/pi-goal — see CONTEXT.md`. Move the detailed upstream notes into CONTEXT.md's history section (M-4 from the review).

- [ ] **Step 3: overlay comment refs**

`src/goal/overlay.ts` and `src/todo/overlay.ts`: comments reference `PowerToolStatusWidget` and the shared widget — leave the class name as-is if Task 7 is deferred, OR update to `CoreTaskStatusWidget` if Task 7 is done first. Keep the comments' *substance* (why there's one widget key) intact.

- [ ] **Step 4: Verify tests still green (sanity — comments only, must not change)**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test )
```

Expected: `282 pass`.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task
git commit -m "docs(core-task): update CONTEXT header + unify origin lines post-rename"
```

---

## Task 7 (OPTIONAL / may split into its own PR): Widget identifier rename

**Scope note:** This is the cosmetic cleanup of M-1 (widget key + class still named after power-tool). It is the LARGEST surface and touches wayfind too. It MAY be executed in the same rename PR or deferred to a follow-up. If deferred, leave a `// TODO(rename): …` at each identifier.

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts` (W1, W2, W3 def + return type)
- Modify: `bun-apps/pi-agent-ext-core-task/src/shared/__tests__/status-widget.test.ts` (W3 type refs)
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/overlay.ts`, `src/todo/overlay.ts` (W3 comment refs)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/overlay.ts`, `src/index.ts` (W3 comment refs)

**Interfaces:**
- Produces: `WIDGET_KEY="pi-core-task"`, `SINGLETON_GLOBAL_KEY="__piCoreTaskStatusWidget"`, class `CoreTaskStatusWidget`.

**Atomicity rule (W2):** the global singleton key is shared via the imported `getSharedStatusWidget()`. goal-todo and wayfind MUST update to the same `status-widget.ts` in the same change — a half-updated state gives each package a different singleton (the exact jiti-dual-instance bug the singleton prevents). Since wayfind imports the function (not the key constant), updating the constant in `status-widget.ts` propagates to both as long as both rebuild/reimport together.

- [ ] **Step 1: Rename the three identifiers in status-widget.ts**

In `src/shared/status-widget.ts`:
- `const WIDGET_KEY = "pi-power-tool";` → `"pi-core-task";`
- `const SINGLETON_GLOBAL_KEY = "__piPowerToolStatusWidget";` → `"__piCoreTaskStatusWidget";`
- `export class PowerToolStatusWidget` → `export class CoreTaskStatusWidget`
- `getSharedStatusWidget(): PowerToolStatusWidget` → `…: CoreTaskStatusWidget`
- the `new PowerToolStatusWidget()` inside `getSharedStatusWidget` → `new CoreTaskStatusWidget()`
- update the class doc comment that says `PowerToolStatusWidget` → `CoreTaskStatusWidget`

- [ ] **Step 2: Update the test file**

`src/shared/__tests__/status-widget.test.ts:10` import + any `PowerToolStatusWidget` usage → `CoreTaskStatusWidget`.

- [ ] **Step 3: Update comment references in overlays + wayfind**

`src/goal/overlay.ts`, `src/todo/overlay.ts`, `pi-agent-ext-wayfind/src/overlay.ts`, `pi-agent-ext-wayfind/src/index.ts`: replace `PowerToolStatusWidget` → `CoreTaskStatusWidget` in comments. (No runtime change — these are comment/type refs only; `instanceof` is deliberately unused.)

- [ ] **Step 4: Verify both packages green + typecheck**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test )
( cd bun-apps/pi-agent-ext-wayfind && bun test && bun run typecheck )
```

Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task bun-apps/pi-agent-ext-wayfind
git commit -m "refactor(status-widget): rename PowerToolStatusWidget → CoreTaskStatusWidget

Renames WIDGET_KEY, singleton global key, and class to match the
core-task package. Atomic across goal-todo + wayfind (shared singleton)."
```

---

## Post-Rename Verification (run after all tasks)

- [ ] **V1: Full extension test sweep**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test )     # 282 pass
( cd bun-apps/pi-agent-ext-wayfind && bun test )       # ≥139 pass
( cd bun-apps/pi-agent && bun run typecheck 2>/dev/null || true )
```

- [ ] **V2: Extension loads under its new name**

```bash
# via the static-extensions path (source mode)
bun bun-apps/pi-agent/src/cli.ts -p "call inspect_extensions" 2>/dev/null | grep -i "core-task\|goal-todo" || true
```

Expected: `core-task` appears in the extension-token-tax table; `goal-todo` does NOT.

- [ ] **V3: Workspace links resolve**

```bash
( cd bun-apps && bun install && bun pm ls 2>/dev/null | grep -i "core-task\|goal-todo" ) || true
```

Expected: `@repo/pi-agent-ext-core-task` present; no `goal-todo`.

- [ ] **V4: No stale `goal-todo` refs remain (excluding historical plan docs)**

```bash
grep -rn "pi-agent-ext-goal-todo\|@repo/pi-agent-ext-goal-todo\|goal-todo.ts" \
  --include="*.ts" --include="*.json" --include="*.sh" \
  bun-apps scripts .github | grep -v node_modules
```

Expected: empty.

- [ ] **V5: CI green on a PR** (confirms the renamed matrix job runs + branch-protection was updated).

---

## Open Risks / Notes

1. **Branch protection (Task 4 Step 5)** — the only non-mechanical step. The renamed CI job name MUST be added to GitHub required-checks or PRs block. This bit the 2026-07-18 ask-user merge; same trap.
2. **`staticExtensions[]` vs `extensions[]`** — keep core-task in `staticExtensions[]` (metadata) + `static-extensions.ts` (load) ONLY. Never add to `extensions[]` (would double-register). Verified clean as of capture.
3. **Historical plan docs** (`docs/superpowers/plans/2026-07-18-*`) reference `goal-todo` extensively — deliberately NOT updated; they are point-in-time records. The V4 grep excludes `docs/superpowers/`.
4. **`.planning/2026-07-19-a/` references** — these planning docs say "the layer lives inside goal-todo". After plan-coordinator lands and this rename executes, update those tickets' resolution notes to reflect the new name (or leave as historical; they are workspaces, not canonical docs).
5. **Widget class rename (Task 7)** touches wayfind comments — coordinate if wayfind has other in-flight changes at execution time.

---

## Self-Review (plan author, frozen 2026-07-20)

- **Spec coverage:** Decision = rename to `core-task` (✓ Task 1). All 12 blast-radius rows covered by Tasks 1-6; cosmetic identifiers by Task 7. Branch-protection manual step isolated (Task 4 Step 5). Metrics baseline covered (Task 5). Docs/comments (Task 6). ✓
- **Placeholder scan:** No "TBD"/"implement later". The only conditional is Task 7 (explicitly OPTIONAL with a deferral path). Commands are concrete.
- **Type consistency:** New package name `@repo/pi-agent-ext-core-task`, entry `extensions/core-task.ts`, var `coreTaskExtension`, class `CoreTaskStatusWidget`, keys `pi-core-task` / `__piCoreTaskStatusWidget` — used consistently across tasks.
- **Sequencing:** Task 0 (re-verify) MUST run first because plan-coordinator landing will add refs. Gate clearly stated. ✓
