# Merge pi-agent-ext-ask-user into pi-agent-ext-goal-todo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically merge the `pi-agent-ext-ask-user` package into `pi-agent-ext-goal-todo` (folder, package.json, manifest entry, CI wiring) with zero behavior change, as the first step of a larger "core-task pi-ext" consolidation.

**Architecture:** This is a pure relocation, not a code integration. `pi-agent-ext-ask-user` (the `ask_user_question` tool: ~40 files under `src/ask-user/`, one extension entry point) and `pi-agent-ext-goal-todo` (`/goal` + `todo` + shared status widget) share **zero code, state, or runtime coupling** — confirmed by grep across the repo. So the merge is: `git mv` ask-user's `extensions/` and `src/ask-user/` subtrees into goal-todo's package directory (relative import paths are preserved because the whole subtree moves together), merge the two `package.json`s, merge the two `CONTEXT.md`s, then fix up every place that hardcodes `pi-agent-ext-ask-user` as a **separate package directory**: `bun-apps/pi-agent/run-dir/manifest.json` (extension entry path), `.github/workflows/ci.yml` (test matrix — `working-directory: bun-apps/${{ matrix.package }}` would 404 otherwise), `.github/CI.md` (docs — including the **branch-protection required-checks list**, which is a live GitHub setting, not just a doc), and two historical comments in `pi-agent-ext-power-tool`.

This is a **different mechanism** than the sibling 2026-07-17 wayfind/planning-with-files → goal-todo consolidation plan (`docs/superpowers/plans/2026-07-17-wayfind-pwf-status-widget-unification.md`), which keeps packages separate and wires them together via a `workspace:*` dependency + shared `PowerToolStatusWidget` singleton — that pattern exists because wayfind/pwf need to *render into* goal-todo's status widget at runtime. ask-user has no such need (it's a full-screen modal dialog, not a footer status line), so there is nothing to wire — a straight physical merge is simpler and correct here. Future "core-task pi-ext" merges should pick whichever of these two mechanisms fits: physical merge when there's no runtime coupling to preserve, dependency+widget-section when there is.

**Tech Stack:** TypeScript, Bun workspaces (glob-based `workspaces: ["./*"]` in `bun-apps/package.json` — no explicit package list to edit), `bun test`, GitHub Actions, `gh api` (branch protection).

---

## Task 1: Move ask-user's extension entry + full `src/ask-user` subtree into goal-todo

**Files:**
- Move: `bun-apps/pi-agent-ext-ask-user/extensions/pi-ask-user.ts` → `bun-apps/pi-agent-ext-goal-todo/extensions/pi-ask-user.ts`
- Move: `bun-apps/pi-agent-ext-ask-user/src/ask-user/` (all ~40 files, recursively) → `bun-apps/pi-agent-ext-goal-todo/src/ask-user/`

- [ ] **Step 1: Confirm baseline — both packages' tests currently pass in isolation**

Run:
```bash
( cd bun-apps/pi-agent-ext-ask-user && bun test )
( cd bun-apps/pi-agent-ext-goal-todo && bun test )
```
Expected: both PASS. This is the regression baseline you'll compare against after the move.

- [ ] **Step 2: `git mv` the extension entry point**

```bash
git mv bun-apps/pi-agent-ext-ask-user/extensions/pi-ask-user.ts \
       bun-apps/pi-agent-ext-goal-todo/extensions/pi-ask-user.ts
```

- [ ] **Step 3: `git mv` the entire `src/ask-user` subtree in one shot**

```bash
git mv bun-apps/pi-agent-ext-ask-user/src/ask-user \
       bun-apps/pi-agent-ext-goal-todo/src/ask-user
```

Do **not** touch file contents in this step. `extensions/pi-ask-user.ts` imports `register` via `import register from "../src/ask-user";` — a relative path — which still resolves correctly because both sides of the move (`extensions/` and `src/ask-user/`) kept their sibling relationship inside the new parent directory.

- [ ] **Step 4: Run goal-todo's test suite and confirm it now includes ask-user's tests**

```bash
( cd bun-apps/pi-agent-ext-goal-todo && bun test )
```
Expected: PASS, and the test count/output includes files from `src/ask-user/__tests__/`, `src/ask-user/state/__tests__/`, and `src/ask-user/tool/__tests__/` (bun test recursively discovers `*.test.ts` under the package directory — no config change needed since goal-todo's own tests are already nested the same way under `src/goal/__tests__`, `src/todo/state/__tests__`, etc.).

- [ ] **Step 5: Run typecheck**

```bash
( cd bun-apps/pi-agent-ext-goal-todo && bun run typecheck )
```
Expected: PASS. goal-todo's `tsconfig.json` `include` is `["src/**/*.ts", "extensions/**/*.ts", "__tests__/**/*.ts"]` — this already covers the newly-arrived `src/ask-user/**` and `extensions/pi-ask-user.ts` without any tsconfig edit.

---

## Task 2: Merge `package.json` metadata and delete ask-user's now-redundant config files

**Files:**
- Modify: `bun-apps/pi-agent-ext-goal-todo/package.json`
- Delete: `bun-apps/pi-agent-ext-ask-user/package.json`
- Delete: `bun-apps/pi-agent-ext-ask-user/tsconfig.json` (byte-identical to goal-todo's — confirmed via `diff`)

- [ ] **Step 1: Update goal-todo's `package.json` description and keywords**

In `bun-apps/pi-agent-ext-goal-todo/package.json`, change:

```json
  "description": "Pi extension: /goal (+ goal_complete tool) and todo (+ /todos) with a shared composite above-editor status widget. Extracted from pi-agent-ext-power-tool; goal+todo kept together because they share the widget + lifecycle hooks.",
  "license": "MIT",
  "keywords": ["pi-package", "goal", "todo", "task-tracking"],
```

to:

```json
  "description": "Pi extension: /goal (+ goal_complete tool), todo (+ /todos) with a shared composite above-editor status widget, and ask_user_question (structured option selector). goal+todo kept together because they share the widget + lifecycle hooks; ask_user_question merged in 2026-07-18 as the first step of the core-task pi-ext consolidation (no shared code with goal/todo — a self-contained modal dialog tool, relocated as-is).",
  "license": "MIT",
  "keywords": ["pi-package", "goal", "todo", "task-tracking", "ask-user", "questionnaire"],
```

Leave `peerDependencies` and `devDependencies` untouched — both packages already declare the identical set (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`, `@types/bun`, `typescript`), confirmed by inspection.

- [ ] **Step 2: Delete ask-user's now-orphaned config files**

```bash
git rm bun-apps/pi-agent-ext-ask-user/package.json
git rm bun-apps/pi-agent-ext-ask-user/tsconfig.json
```

---

## Task 3: Merge `CONTEXT.md` content, delete ask-user's file

**Files:**
- Modify: `bun-apps/pi-agent-ext-goal-todo/CONTEXT.md`
- Delete: `bun-apps/pi-agent-ext-ask-user/CONTEXT.md`

- [ ] **Step 1: Rewrite goal-todo's `CONTEXT.md` header to cover both domains, then append ask-user's language section**

Replace the very first line and intro paragraph:

```markdown
# pi-agent-ext-goal-todo
```

with:

```markdown
# pi-agent-ext-goal-todo

Also owns `ask_user_question` (merged from `pi-agent-ext-ask-user` on 2026-07-18 — see the "ask_user_question" section below). It shares no code or state with goal/todo; it was relocated here as the first step of a broader "core-task pi-ext" consolidation, not because of a runtime coupling.
```

Then append, at the end of the file, ask-user's entire `## Language` section content **renamed to its own H2** so it doesn't collide with goal-todo's existing `## Language` heading:

```markdown

## Language — ask_user_question

The `ask_user_question` tool: a structured option selector with a free-text "Other" fallback. Extracted from power-tool; ported from @juicesharp/rpiv-ask-user-question.

**ask_user_question**:
The structured-choice tool — 1–4 questions, each with 2–4 options; the user picks one (or multi-selects), types a free-text answer, or abandons. The deterministic way to get a decision from the user mid-task.
_Avoid_: prompt, input (it is a structured multi-option selector, not a free prompt)

**Other fallback**:
The free-text escape hatch — every question auto-appends a "Type something." row so the user can always answer outside the offered options (or press Esc to abandon).
_Avoid_: custom input, free-text box (it is the auto-appended free-text fallback every question has)

**Reconciler** (`before_agent_start`):
Rewrites a pending `ask_user_question` tool call into the canonical question shape before the agent turn starts — so a malformed or model-shaped call still renders correctly.
_Avoid_: validator, normalizer (it is a pending-call canonicalization on `before_agent_start`)
```

- [ ] **Step 2: Delete ask-user's `CONTEXT.md`**

```bash
git rm bun-apps/pi-agent-ext-ask-user/CONTEXT.md
```

- [ ] **Step 3: Confirm the ask-user package directory is now empty and remove it**

```bash
find bun-apps/pi-agent-ext-ask-user -type f
```
Expected: no output (all files moved or `git rm`'d in Tasks 1–3).

```bash
rmdir bun-apps/pi-agent-ext-ask-user/extensions bun-apps/pi-agent-ext-ask-user/src bun-apps/pi-agent-ext-ask-user
```

---

## Task 4: Update the extension manifest and refresh the lockfile

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/manifest.json:22-27`
- Run: `bun install` (from `bun-apps/`)

- [ ] **Step 1: Point the `pi-agent-ext-ask-user` manifest entry at its new location**

In `bun-apps/pi-agent/run-dir/manifest.json`, change:

```json
    {
      "name": "pi-agent-ext-ask-user",
      "entry": "pi-agent-ext-ask-user/extensions/pi-ask-user.ts",
      "bundleMode": "thin",
      "testGate": "cd bun-apps/pi-agent-ext-ask-user && bun test",
      "version": "0.1.0"
    },
```

to:

```json
    {
      "name": "pi-agent-ext-ask-user",
      "entry": "pi-agent-ext-goal-todo/extensions/pi-ask-user.ts",
      "bundleMode": "thin",
      "version": "0.1.0"
    },
```

Keep the `"name"` field as `"pi-agent-ext-ask-user"` — it's a stable logical identifier (shown by `inspect_extensions`, read by `bun-apps/pi-agent-cli/src/commands/tools-metrics.ts` for the schema-cost baseline's `source` field), independent of which directory the file physically lives in. Drop the `testGate` line: it's now redundant with the `pi-agent-ext-goal-todo` entry's own `testGate` (`cd bun-apps/pi-agent-ext-goal-todo && bun test`), which already runs ask-user's tests since Task 1 moved them into that directory. Leaving both would run the same `bun test` command twice in CI for no benefit.

- [ ] **Step 2: Refresh `bun-apps/bun.lock`**

```bash
( cd bun-apps && bun install )
```
Expected: lockfile updates to drop the now-deleted `@repo/pi-agent-ext-ask-user` workspace package. Confirm with `git diff bun-apps/bun.lock` that the only change is that package's removal (no unrelated dependency bumps).

- [ ] **Step 3: Verify no other `package.json` in the repo depended on `@repo/pi-agent-ext-ask-user` as a workspace package**

```bash
grep -rl "@repo/pi-agent-ext-ask-user" --include="package.json" bun-apps
```
Expected: no output. (Confirmed during planning — only ask-user's own now-deleted `package.json` referenced this name. `pi-agent-ext-wayfind` depends on `@repo/pi-agent-ext-goal-todo` for the shared status widget, which is untouched by this merge.)

---

## Task 5: Remove the ask-user entry from the CI test matrix

**Files:**
- Modify: `.github/workflows/ci.yml:89`

- [ ] **Step 1: Delete the matrix line**

In `.github/workflows/ci.yml`, delete this line from the `tests` job's matrix (it currently sits between the `pi-agent-ext-btw` and `pi-agent-ext-goal-todo` entries):

```yaml
          - { package: pi-agent-ext-ask-user, test-cmd: "bun test" }
```

Do not touch the `pi-agent-ext-goal-todo` line right after it — it already runs `bun test` in that directory, which now covers ask-user's tests too (Task 1, Step 4 already proved this passes).

- [ ] **Step 2: Validate the YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
```
Expected: no error (exits silently).

---

## Task 6: Update `.github/CI.md` — package count, matrix list, and the branch-protection runbook

**Files:**
- Modify: `.github/CI.md`

- [ ] **Step 1: Update the required-checks `gh api` runbook block (~line 20-27)**

Change:

```
`main` is under branch protection: the **25 checks** below are **required**
```
to:
```
`main` is under branch protection: the **24 checks** below are **required**
```

And in the `contexts` array, remove `"test · pi-agent-ext-ask-user", ` so the line reads:

```
  "test · pi-agent-ext-btw", "test · pi-agent-ext-goal-todo",
```

- [ ] **Step 2: Update the "What is tested" package count and list (~line 128-142)**

Change `23 bun-apps/* packages` to `22 bun-apps/* packages`, and remove `pi-agent-ext-ask-user` from the enumerated code block so the relevant line reads:

```
pi-agent-ext-btw, pi-agent-ext-goal-todo,
```

- [ ] **Step 3: Add a historical note next to the existing doc-drift note, documenting the merge**

Right after the existing sentence:

```
`pi-agent-ext-btw`/`pi-agent-ext-ask-user`/`pi-agent-ext-goal-todo` were already
in the `ci.yml` matrix but missing from this list (a doc-drift gap found and
fixed alongside the 5 newly-added packages below).
```

add:

```

`pi-agent-ext-ask-user`'s standalone check was retired on 2026-07-18 when the
package was merged into `pi-agent-ext-goal-todo` (see that package's
`CONTEXT.md`) — its tests now run under `test · pi-agent-ext-goal-todo`.
```

---

## Task 7 (MANUAL — requires your explicit confirmation at merge time): Update the live GitHub branch protection rule

**This step mutates a live GitHub repository setting shared by everyone who pushes to `main`. Do not run it as part of an automated plan-execution pass — run it yourself, and only once this PR is about to merge (or has just merged) to `main`.**

Why this can't be skipped: `main`'s branch protection has `strict: true` required status checks, including `"test · pi-agent-ext-ask-user"`. Once Task 5 removes that matrix entry from `ci.yml`, no workflow run will ever report that check again — GitHub will show it as permanently "Expected — Waiting for status to be reported" on every future PR, which blocks all merges to `main` (per the existing warning already in `CI.md`: "a job that doesn't run on most PRs can't be a required check").

**Sequencing:** run this immediately after this PR merges to `main` (not before — the PR itself still needs the old check to pass while open; not long after — every other PR is blocked in the gap).

- [ ] **Step 1: Fetch the current protection rule to preserve its other settings**

```bash
gh api repos/ziyu4huang/video_generation/branches/main/protection > /tmp/main-protection-before.json
```

- [ ] **Step 2: Re-assert the protection rule with the 24 required checks (ask-user dropped)**

```bash
gh api -X PUT repos/ziyu4huang/video_generation/branches/main/protection \
  --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": [
  "test · pi-agent", "test · pi-agent-cli", "test · pi-agent-ext-flux2",
  "test · pi-agent-ext-krea2", "test · pi-agent-ext-ltx",
  "test · pi-agent-ext-movie-director", "test · pi-agent-ext-power-tool",
  "test · pi-agent-ext-web-access", "test · gui-movie-director",
  "extension-contract", "regression gates",
  "test · pi-agent-ext-knowledge-card", "test · pi-agent-ext-hermes-memory",
  "test · pi-agent-ext-workflow",
  "test · pi-agent-ext-btw", "test · pi-agent-ext-goal-todo",
  "test · pi-agent-ext-file2md", "test · pi-agent-ext-obsidian",
  "test · pi-agent-ext-research-tool",
  "test · pi-agent-ext-zai-mcp", "test · pi-agent-ext-wayfind", "test · perf-harness"
] } } /* …preserve existing review/admin settings from /tmp/main-protection-before.json… */
JSON
```

**Before running this**, open `/tmp/main-protection-before.json` and merge its existing `enforce_admins`, `required_pull_request_reviews`, and any other top-level settings into the PUT body above — the PUT replaces the entire rule, it does not patch. This mirrors the exact caveat already documented in `CI.md`.

- [ ] **Step 3: Verify**

```bash
gh api repos/ziyu4huang/video_generation/branches/main/protection --jq '.required_status_checks.contexts[]' | sort
```
Expected: 24 lines, no `test · pi-agent-ext-ask-user`.

---

## Task 8: Update historical comments in pi-agent-ext-power-tool

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/extensions/cli-subcommand.ts:15-18`
- Modify: `bun-apps/pi-agent-ext-power-tool/src/__tests__/index.test.ts:186-187`

These comments document the 2026-07-12 monolith-split (#504/#502/#499) and are now one hop out of date — they still describe `ask_user_question` as living in its own package. Update, don't delete, so the extraction history stays legible.

- [ ] **Step 1: Update `cli-subcommand.ts`**

Change:

```
 * Post-monolith-split (#504/#502/#499): knowledge_query/graph_health moved to
 * pi-agent-ext-knowledge-card, todo/goal_complete moved to
 * pi-agent-ext-goal-todo, ask_user_question moved to pi-agent-ext-ask-user.
```

to:

```
 * Post-monolith-split (#504/#502/#499): knowledge_query/graph_health moved to
 * pi-agent-ext-knowledge-card, todo/goal_complete moved to
 * pi-agent-ext-goal-todo, ask_user_question moved to pi-agent-ext-ask-user
 * (merged into pi-agent-ext-goal-todo 2026-07-18 — no shared code, relocated
 * as the first step of the core-task pi-ext consolidation).
```

- [ ] **Step 2: Update `index.test.ts`**

Change:

```
    // ask_user_question -> pi-agent-ext-ask-user (A2); goal+todo ->
    // pi-agent-ext-goal-todo (A3); knowledge_query + graph_health -> knowledge-graph hub.
```

to:

```
    // ask_user_question -> pi-agent-ext-ask-user (A2, merged into
    // pi-agent-ext-goal-todo 2026-07-18); goal+todo -> pi-agent-ext-goal-todo
    // (A3); knowledge_query + graph_health -> knowledge-graph hub.
```

- [ ] **Step 3: Run power-tool's tests to confirm the comment-only edit didn't break anything**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test )
```
Expected: PASS (comment-only change, no behavior impact).

---

## Task 9: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the merged package's full test suite**

```bash
( cd bun-apps/pi-agent-ext-goal-todo && bun test && bun run typecheck )
```
Expected: PASS.

- [ ] **Step 2: Confirm no stray references to the deleted package path remain**

```bash
grep -rn "pi-agent-ext-ask-user" bun-apps .github --include="*.ts" --include="*.json" --include="*.yml" --include="*.md" --exclude-dir=node_modules
```
Expected: only intentional historical mentions carrying the merge note — the two files from Task 8 (`cli-subcommand.ts`, `index.test.ts`) plus `pi-agent-ext-power-tool/PRD.md` and `pi-agent-ext-power-tool/README.md` (two more stale same-package doc mentions found during Task 8's code review and fixed alongside it) — the `manifest.json` `"name": "pi-agent-ext-ask-user"` logical identifier from Task 4, and the `CI.md` historical note from Task 6, Step 3. No live path/import/matrix references.

- [ ] **Step 3: Regenerate the schema-cost baseline and diff it**

```bash
( cd bun-apps/pi-agent-cli && bun run src/index.ts tools-metrics --schema-cost --json ) > /tmp/schema-cost-after.json
diff <(jq -S . bun-apps/pi-agent-cli/baselines/schema-cost-baseline.json) <(jq -S . /tmp/schema-cost-after.json)
```
Expected: no diff, or only the `ask_user_question` tool's `source` field changing value (harmless — cosmetic label, not a behavior change). If it changed, overwrite the committed baseline with the regenerated one.

- [ ] **Step 4: Full workspace install + build sanity check**

```bash
( cd bun-apps && bun install && bun run --filter=pi-agent-ext-goal-todo typecheck )
```
Expected: PASS, no missing-package errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git status
git commit -m "refactor(pi-ext): merge pi-agent-ext-ask-user into pi-agent-ext-goal-todo

First step of the core-task pi-ext consolidation. No shared code existed
between the two packages, so this is a pure relocation: ask-user's
extensions/ and src/ask-user/ subtrees move as-is, package.json/CONTEXT.md
merge, manifest.json/ci.yml/CI.md update to reflect the single directory.

Branch protection's required-checks list still needs a live gh api update
after this merges — see Task 7 in the plan, run separately."
```

Do **not** run Task 7's `gh api` PUT as part of this commit — it is a live infrastructure change, sequenced to run right after this merges to `main` (see Task 7's own instructions).

---

## Self-Review Notes

- **Spec coverage:** every file this plan's own investigation found referencing `pi-agent-ext-ask-user` as a directory/path is covered (package internals: Tasks 1-3; manifest: Task 4; CI matrix: Task 5; CI docs + live branch protection: Tasks 6-7; historical comments: Task 8). Tool-name-only references (`tool-gate.ts:31`, `workflow-tools-available.test.ts:29`, both just the string `"ask_user_question"`) need no change — they reference the tool, not the package location.
- **Placeholder scan:** no TBD/TODO — every step has the literal file content or exact command.
- **Type/name consistency:** the manifest `"name"` field is deliberately left as `"pi-agent-ext-ask-user"` throughout (Task 4) — this is called out explicitly so a later task doesn't "fix" it inconsistently.
- **Not in scope:** renaming the destination package (e.g. to something more generic than "goal-todo" now that it also hosts ask-user) — left as-is per your answer that this is the first step of a larger consolidation; a rename decision should wait until the shape of that larger consolidation is clearer, to avoid renaming twice.
