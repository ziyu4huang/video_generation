# Phase A — pi-agent deploy fix + dead code + doc alignment: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the broken `update-pi.sh --rebuild` deploy path (stale since PR #1305), delete dead deploy code, align 6 drifted doc spots with reality, and clear local clutter — the first PR of the pi-agent-optimization effort.

**Architecture:** Six small tasks, one PR. One behavioral fix (deploy-script path) with a string-parsing regression test that runs ungated in the default `bun test`; everything else is deletion or documentation. All git operations go through the devops tool chain.

**Tech Stack:** Bash (update-pi.sh, run.sh, check-deploy-artifacts.sh), TypeScript + `bun:test` (e2e-launcher.test.ts), Markdown (SKILL.md, TODO.md).

**Spec:** `.planning/pi-agent-optimization/spec.md` — Phase A section.

## Global Constraints

- Written output (docs, comments, commits, file content) is English.
- Never top-level `cd` in shell commands — use `( cd <dir> && … )`, `--cwd`, or absolute paths.
- `bun install` from `bun-apps/` only; never commit `package-lock.json`.
- Tests: run each package's canonical `bun run test`; pi-agent also `bun run typecheck`.
- Git sync/branch/PR via devops CLI chain (`prepare-cli.ts`, `local-ci-cli.ts`, `pr-finish-cli.ts`) — never hand-rolled git phases the chain owns.
- This worktree is detached-HEAD-on-main style: branch from `origin/main` via `prepare_branch` BEFORE the first commit.

---

### Task 1: Fix `update-pi.sh --rebuild` stale deploy-script path + regression test

**Files:**
- Modify: `bun-apps/pi-agent/update-pi.sh:141-154` (comment block + `do_rebuild`)
- Test: `bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts` (new describe block; extend the `node:fs` import on line 38)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `do_rebuild` invokes `bun ../pi-agent-ext-devops/scripts/deploy.ts` from the pi-agent cwd (satisfies deploy.ts's `assertCorrectCwd`, deploy.ts:158). New test convention: every `bun <script>.ts` reference inside update-pi.sh resolves relative to `bun-apps/pi-agent`.

Context: PR #1305 (2026-08-14) moved deploy.ts from `bun-apps/pi-agent/scripts/deploy.ts` to `bun-apps/pi-agent-ext-devops/scripts/deploy.ts`. update-pi.sh:153 still runs the old path, so every `--rebuild` since then fails. The comment block at update-pi.sh:146-149 documents the OLD move (build.ts → deploy.ts) and must be extended, not replaced — it is accurate history.

- [ ] **Step 1: Write the failing test**

In `bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts`:

(a) Extend the `node:fs` import (line 38) to include `existsSync`:

```ts
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, readFileSync, realpathSync, lstatSync, readlinkSync, existsSync } from "node:fs";
```

(b) Append this block at the end of the file (UNGATED — it string-parses a shell script and stats paths; it builds nothing, matching this file's own convention documented in its header):

```ts
// update-pi.sh spawns repo scripts with `bun <script>.ts` from the
// bun-apps/pi-agent cwd (do_rebuild / do_typecheck). #1305 moved deploy.ts
// out of pi-agent/scripts/ and --rebuild failed silently for a week because
// nothing checked those references. Pure parse + existsSync: no spawns, so
// this runs in the default ungated `bun test`.
describe("update-pi.sh referenced scripts exist", () => {
	test("every `bun <script>.ts` reference resolves from bun-apps/pi-agent", () => {
		const wrapper = readFileSync(path.join(REAL_PKG_DIR, "update-pi.sh"), "utf8");
		const refs = [...wrapper.matchAll(/bun (\.{0,2}\/?[^\s&;)"']+\.ts)/g)].map((m) => m[1]!);
		expect(refs.length).toBeGreaterThan(0);
		for (const rel of refs) {
			expect(existsSync(path.resolve(REAL_PKG_DIR, rel))).toBe(true);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test src/__tests__/e2e-launcher.test.ts )`
Expected: FAIL — `existsSync(...bun-apps/pi-agent/scripts/deploy.ts)` is false (the reference exists in the wrapper but the file does not).

- [ ] **Step 3: Apply the fix**

In `bun-apps/pi-agent/update-pi.sh`, extend the comment block (lines 146-149) and change line 153. New text for the whole block:

```bash
# Builds via the devops package's deploy.ts (default --bundle mode →
# dist/pi-agent/). NOTE: deploy.ts moved to
# bun-apps/pi-agent-ext-devops/scripts/ in PR #1305 (2026-08-14) — the old
# `bun scripts/deploy.ts` (this package) became a dead path that always
# failed, and before that it was `scripts/build.ts --all` (unified INTO
# deploy.ts, commit a0e512a7 / PR #647). deploy.ts's assertCorrectCwd still
# requires cwd == bun-apps/pi-agent, so we cd here and reference the script
# relatively.
do_rebuild() {
  echo
  echo "$(green '▶') rebuild pi-agent dist bundle"
  (cd "$REPO_ROOT/bun-apps/pi-agent" && bun ../pi-agent-ext-devops/scripts/deploy.ts)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/__tests__/e2e-launcher.test.ts )`
Expected: PASS (all blocks; the new one included).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/update-pi.sh bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts
git commit -m "fix(pi-agent): update-pi.sh --rebuild targets pi-agent-ext-devops/scripts/deploy.ts

Broken since #1305 moved deploy.ts out of pi-agent/scripts/. Adds an
ungated string-parse regression test so the next move fails loudly."
```

---

### Task 2: Delete dead `deploy-swap` module

**Files:**
- Delete: `bun-apps/pi-agent-ext-devops/scripts/lib/deploy-swap.ts`
- Delete: `bun-apps/pi-agent-ext-devops/scripts/lib/deploy-swap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (module has zero production importers — verified by grep in Step 1).

Context: `healInterruptedSwap` was written for deploy.ts's old atomic `.prev` swap; today's deploy.ts `rmSync`s the target directly (deploy.ts:821). Only the test file imports the module.

- [ ] **Step 1: Prove zero importers**

Run: `grep -rn "deploy-swap" bun-apps/ --include="*.ts" | grep -v node_modules`
Expected: exactly 2 lines — deploy-swap.ts itself and deploy-swap.test.ts. If any third line appears, STOP and surface it (the plan's deletion premise is wrong).

- [ ] **Step 2: Delete both files**

```bash
git rm bun-apps/pi-agent-ext-devops/scripts/lib/deploy-swap.ts bun-apps/pi-agent-ext-devops/scripts/lib/deploy-swap.test.ts
```

- [ ] **Step 3: Run the devops package gate**

Run: `( cd bun-apps/pi-agent-ext-devops && bun run test )`
Expected: PASS (its `deploy-swap` test case disappears from the run; nothing else references the module).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(devops): delete dead deploy-swap module

healInterruptedSwap served deploy.ts's retired atomic-swap layout; the
current deploy rmSyncs the target directly. Zero production importers."
```

---

### Task 3: Align run.sh upgrade prose with actual update-pi.sh behavior

**Files:**
- Modify: `bun-apps/pi-agent/run.sh:36-40` (header comment)
- Modify: `bun-apps/pi-agent/run.sh:80-83` (`--update-help` heredoc)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (comment/heredoc text only; `./pi-agent.sh` shares this file via symlink, so one edit fixes all three copies).

Context: Both spots claim the wrapper "runs `bun update <all 4> --latest` at the monorepo root in ONE call". update-pi.sh:275-303 deliberately does NOT — its own comment explains `bun update --latest` in bun 1.3.14 splices the pkgs into ROOT package.json and leaves sub-workspace exact pins stale, so it perl-rewrites the pins instead. The prose must describe the pin-rewrite.

- [ ] **Step 1: Replace header comment lines 36-40**

Old (run.sh:36-40):

```
#   The wrapper runs `bun update <all 4 packages> --latest` at the monorepo
#   root in ONE call (so they never drift apart from each other), verifies
#   each installed version, and rewrites bun.lock (the canonical lockfile)
#   for ALL bun-apps/* consumers at once. NEVER use `npm install` — it writes
#   the gitignored package-lock.json and breaks the Bun workspace layout.
```

New:

```
#   The wrapper rewrites the exact version pins for all 4 packages across
#   every bun-apps/*/package.json in one pass (perl in-place edit —
#   `bun update --latest` cannot fix sub-workspace exact pins in bun 1.3.x),
#   reconciles bun.lock, verifies each installed version, and lockstep-checks
#   every consumer. NEVER use `npm install` — it writes the gitignored
#   package-lock.json and breaks the Bun workspace layout.
```

- [ ] **Step 2: Replace heredoc lines 80-83**

Old (run.sh:80-83, inside the `--update-help` heredoc):

```
  The wrapper runs `bun update <all 4 packages> --latest` at the monorepo
  root in ONE call (they're published in lockstep by the same upstream
  vendor — pinned to exact versions everywhere, so this is the only way
  they change), verifies each version, and bumps bun.lock for all consumers.
```

New:

```
  The wrapper rewrites the exact version pins for all 4 packages across
  every bun-apps/*/package.json in one pass (they're published in lockstep
  by the same upstream vendor, and `bun update --latest` cannot fix
  sub-workspace exact pins — the wrapper's perl pin-edit can), reconciles
  bun.lock, and verifies each installed version.
```

- [ ] **Step 3: Run the launcher e2e**

Run: `( cd bun-apps/pi-agent && bun test src/__tests__/e2e-launcher.test.ts )`
Expected: PASS (the `--update-help` block asserts the heredoc prints; content-agnostic, but confirms nothing broke).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent/run.sh
git commit -m "docs(pi-agent): run.sh upgrade prose matches the pin-edit wrapper

Both the header and --update-help claimed a 'bun update --latest' call the
wrapper deliberately never makes (bun 1.3.x cannot bump sub-workspace
exact pins that way)."
```

---

### Task 4: devops tool descriptions + SKILL.md deploy surfaces + stale gate-script comment

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/extensions/devops.ts:711` (pi_deploy description)
- Modify: `bun-apps/pi-agent-ext-devops/extensions/devops.ts:763` (pi_verify description)
- Modify: `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md:187` (trigger-table row) + new rows after 188
- Modify: `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md:232-238` (CLI fallback list)
- Modify: `scripts/check-deploy-artifacts.sh:39-41` (SIDE EFFECT comment)

**Interfaces:**
- Consumes: nothing.
- Produces: SKILL.md documents two surfaces executors will need in later phases: `deploy-sh-cli.ts` (Pipeline B) and `verify-deploy-cli.ts`.

- [ ] **Step 1: Fix pi_deploy description (devops.ts:711)**

Old:

```ts
			description:
				"Build and deploy the pi-agent bundle + thin extension bundles (mirrors `bun scripts/deploy.ts`). " +
				"Returns mode, outDir, pi-agent.js size, ext-bundle built/failed counts, exit code, and a log path.",
```

New:

```ts
			description:
				"Build and deploy the pi-agent bundle + thin extension bundles (runs pi-agent-ext-devops/scripts/deploy.ts). " +
				"Returns mode, outDir, pi-agent.js size, ext-bundle built/failed counts, exit code, and a log path.",
```

- [ ] **Step 2: Fix pi_verify description (devops.ts:763)**

Old:

```ts
			description:
				"Run a pi-agent run-test.sh tier (quick|medium|high|readonly|full; default medium) and report per-step pass/fail. " +
				"high = the exact CI `deploy -- verify` job. Returns steps, exit code, and a log path.",
```

New:

```ts
			description:
				"Run a pi-agent run-test.sh tier (quick|medium|high|readonly|full; default medium) and report per-step pass/fail. " +
				"high = the full build + deploy e2e tiers (patches, extension loading, launcher). Returns steps, exit code, and a log path.",
```

- [ ] **Step 3: Update SKILL.md trigger table (line 187) and add Pipeline B rows**

Replace line 187:

```markdown
| Build + deploy the pi-agent bundle + thin ext bundles (runs `pi-agent-ext-devops/scripts/deploy.ts`) | `pi_deploy` |
```

After line 188 (`| Run a pi-agent `run-test.sh` tier … | `pi_verify` |`) add:

```markdown
| Deploy the versioned sh core + ext set (Pipeline B, config `deploy-config.yaml`) | `deploy:sh` — `bun run --cwd bun-apps/pi-agent deploy:sh` (CLI: `bun bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts [--ext <name>] [--list]`) |
| End-to-end verify a fresh bundle deploy (install → quick tier → deploy → foreign-cwd boot) | `bun bun-apps/pi-agent-ext-devops/src/verify-deploy-cli.ts` |
```

- [ ] **Step 4: Extend the CLI fallback list (SKILL.md:232-238)**

Add to the fenced bash block after the `verify-merge-cli.ts` line:

```bash
  bun bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts [--list|--ext <name>]
  bun bun-apps/pi-agent-ext-devops/src/verify-deploy-cli.ts          # full deploy verify
```

- [ ] **Step 5: Fix check-deploy-artifacts.sh comment (lines 39-41)**

Old:

```bash
# SIDE EFFECT: deploy.ts always targets <repo>/dist/pi-agent and deletes it
# first — there is no out-dir flag. dist/ is gitignored build output and a
```

New:

```bash
# SIDE EFFECT: this script's deploys target <repo>/dist/pi-agent (deploy.ts's
# default; it also accepts an out-dir positional, unused here) and delete it
# first. dist/ is gitignored build output and a
```

(Leave the following lines — "freshly rebuilt one beats a stale one…" — untouched.)

- [ ] **Step 6: Run gates**

Run: `( cd bun-apps/pi-agent-ext-devops && bun run test )`
Expected: PASS.

Run: `bash scripts/check-deploy-artifacts.sh` — NOT needed (comment-only change; the script takes ~4s+3 deploys, skip).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/extensions/devops.ts bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md scripts/check-deploy-artifacts.sh
git commit -m "docs(devops): align tool descriptions + SKILL.md with real deploy surfaces

pi_deploy/pi_verify cited a moved script path and a CI job that never
runs here; SKILL.md was missing Pipeline B (deploy:sh) and
verify-deploy-cli from the plain-session fallbacks."
```

---

### Task 5: Clutter cleanup + TODO #0 closure + stale test comment

**Files:**
- Delete (untracked, local-only): `bun-apps/pi-agent-cli/`, `bun-apps/pi-agent-ext-core-runtime/`, `bun-apps/pi-agent-ext-core-interface/`, `bun-apps/pi-agent-ext-core-task/`
- Delete (untracked, local-only): `bun-apps/pi-agent/vault/`
- Modify: `bun-apps/pi-agent/run-dir/resolve.test.ts:187` (stale comment)
- Modify: `bun-apps/pi-agent/TODO.md` (item #0)

**Interfaces:**
- Consumes: nothing.
- Produces: TODO.md item #0 marked done; `RunDirLayoutMode` stays `"deploy-bundle" | "source"` (already retired upstream — this task only closes the bookkeeping).

Context: The explorer reported TODO #0 (retire portable/release layout branches) as open, but ground truth shows both `run.sh` (lines 108-111 comment; binary pi-agent.js/src/cli.ts detection) and `run-dir/resolve.ts` (`RunDirLayoutMode` at resolve.ts:78) already retired those arms. What remains is one stale comment in resolve.test.ts and the TODO entry itself.

- [ ] **Step 1: Verify each ghost dir is a husk, then delete**

For each of the four dirs, confirm NO `package.json` exists inside (a dir WITH package.json is a real package — STOP and report instead of deleting):

```bash
for d in bun-apps/pi-agent-cli bun-apps/pi-agent-ext-core-runtime bun-apps/pi-agent-ext-core-interface bun-apps/pi-agent-ext-core-task; do
  [ -f "$d/package.json" ] && echo "REAL PACKAGE: $d" || echo "husk ok: $d";
done
```

Expected: `husk ok` ×4. Then:

```bash
rm -rf bun-apps/pi-agent-cli bun-apps/pi-agent-ext-core-runtime bun-apps/pi-agent-ext-core-interface bun-apps/pi-agent-ext-core-task
rmdir bun-apps/pi-agent/vault
```

- [ ] **Step 2: Fix resolve.test.ts:187 comment**

Old:

```ts
				// -ne is a flag with no path payload (deploy-package mode) — not hit here
```

New:

```ts
				// -ne is a flag with no path payload (deploy-bundle mode) — not hit here
```

- [ ] **Step 3: Mark TODO #0 done**

In `bun-apps/pi-agent/TODO.md`, replace the `### 0. retire the … launcher` heading and body (lines 22-43) with:

```markdown
### 0. retire the `portable` / `release` layout branches in the launcher  ✅ DONE (2026-08-20)

Both consumers were already retired upstream: `run.sh` detects only
pi-agent.js (bundle) / src/cli.ts (source) with an explicit historical note,
and `run-dir/resolve.ts`'s `RunDirLayoutMode` is `"deploy-bundle" | "source"`.
This entry closed the bookkeeping: the last stale `deploy-package` reference
in resolve.test.ts was corrected. (pi-agent-optimization Phase A.)
```

- [ ] **Step 4: Run gates**

Run: `( cd bun-apps/pi-agent && bun test run-dir/resolve.test.ts && bun run typecheck )`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/run-dir/resolve.test.ts bun-apps/pi-agent/TODO.md
git commit -m "chore(pi-agent): close TODO #0 — portable/release arms already retired

run.sh + resolve.ts dropped the layout variants upstream; fixes the last
stale deploy-package comment. Ghost husk dirs removed locally (untracked)."
```

---

### Task 6: Full gate + PR through the devops chain

**Files:** none (verification + PR only).

**Interfaces:**
- Consumes: Tasks 1-5 commits on the working branch.
- Produces: merged Phase A PR; branch swept.

- [ ] **Step 1: Run both packages' canonical gates**

```bash
( cd bun-apps/pi-agent && bun run test && bun run typecheck )
( cd bun-apps/pi-agent-ext-devops && bun run test )
```

Expected: PASS everywhere. If anything fails, fix before proceeding (systematic-debugging if non-obvious).

- [ ] **Step 2: Prepare branch + local CI + PR via devops chain**

```bash
bun bun-apps/pi-agent-ext-devops/src/prepare-cli.ts --rebase
bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts
# then create the PR (title below), and finish it:
bun bun-apps/pi-agent-ext-devops/src/pr-finish-cli.ts <pr-number> \
  --expected-scope bun-apps/pi-agent/** --expected-scope bun-apps/pi-agent-ext-devops/** --expected-scope scripts/check-deploy-artifacts.sh
```

PR title: `fix(pi-agent): Phase A — repair update-pi.sh rebuild, purge dead deploy code, align deploy docs`

PR body: summarize Tasks 1-5 (broken rebuild path since #1305 + regression test; deploy-swap deletion; run.sh/devops/SKILL.md doc alignment; ghost-dir cleanup + TODO #0 closure).

- [ ] **Step 3: Verify merge + sync**

```bash
bun bun-apps/pi-agent-ext-devops/src/verify-merge-cli.ts <pr-number>
bun bun-apps/pi-agent-ext-devops/src/sync-cli.ts
```

Expected: MERGED, scope clean, worktree synced to the new main.
