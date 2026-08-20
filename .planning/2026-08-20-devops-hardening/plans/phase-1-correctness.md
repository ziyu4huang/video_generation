# devops-hardening Phase 1 — Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `verify_merge_landed` scope false-positives (glob-vs-prefix semantics) and harden `sync_default_branch`'s preserve flow against unmerged-index states.

**Architecture:** (1) a new pure, dependency-free `matchesScope(path, entry)` module with explicitly defined entry semantics replaces the inline `startsWith` at `verify-merge-recipe.ts:363`; (2) `sync-recipe.ts` gains an `unmergedPaths` client seam + pre-flight abort (`unmerged_index`) before any preserve stash, and its existing pop-conflict warning is upgraded to spell out the broken aftermath and the manual recovery commands.

**Tech Stack:** TypeScript, Bun (`bun:test`), dual-seam testing (fake `SyncClient` + recording `SpawnFn`, no real git).

**Spec:** `.planning/2026-08-20-devops-hardening/spec.md` (Phase 1 section). The plan argues from the spec; executors read both.

## Global Constraints

- All commands run from repo root; tests via `( cd bun-apps/pi-agent-ext-devops && bun test )` or `bun test` with explicit path from that dir. NEVER top-level `cd` in the Bash tool (repo hook blocks it) — use `( cd <dir> && … )`.
- No new npm dependencies — normalization + `startsWith`/segment comparison only.
- Written output English (comments, commit messages); discussion zh_TW.
- Baseline: `origin/main` @ `f002c04e7` or later. Create the working branch off `origin/main` FIRST (this worktree is detached on an older commit): `bun bun-apps/pi-agent-ext-devops/src/prepare-feature-branch-cli.ts --branch devops-hardening-phase1 --create`.
- Canonical gate: `( cd bun-apps/pi-agent-ext-devops && bun test )` — never a hand-assembled subset as the final check.
- Commit message trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

### Task 1: `matchesScope` pure function + unit tests

**Files:**
- Create: `bun-apps/pi-agent-ext-devops/src/scope-match.ts`
- Create: `bun-apps/pi-agent-ext-devops/tests/scope-match.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `export function matchesScope(path: string, entry: string): boolean` — Task 2 imports it as `../src/scope-match.js` (note the `.js` specifier, matching existing imports in this package).

- [x] **Step 1: Write the failing tests**

```ts
/**
 * Unit tests for matchesScope — the scope-entry semantics behind
 * verify_merge_landed's CLEAN/CONTAMINATED verdict.
 *
 * History: the check used to be literal `startsWith`, so the glob-style entries
 * every caller actually passes (`bun-apps/<pkg>/**`) never matched a real path
 * and every clean merge reported CONTAMINATED (PRs #1737, #1739).
 */
import { test, expect, describe } from "bun:test";
import { matchesScope } from "../src/scope-match.js";

describe("matchesScope — x/** (directory prefix, any depth)", () => {
	test("matches a deep path under the prefix", () => {
		expect(matchesScope("bun-apps/foo/src/deep/x.ts", "bun-apps/foo/**")).toBe(true);
	});
	test("matches a direct child", () => {
		expect(matchesScope("bun-apps/foo/package.json", "bun-apps/foo/**")).toBe(true);
	});
	test("rejects a pseudo-prefix sibling directory", () => {
		expect(matchesScope("bun-apps/foo-bar/x.ts", "bun-apps/foo/**")).toBe(false);
	});
	test("rejects the bare directory itself as a FILE path", () => {
		expect(matchesScope("bun-apps/foo", "bun-apps/foo/**")).toBe(false);
	});
});

describe("matchesScope — x/* (single level)", () => {
	test("matches a direct child", () => {
		expect(matchesScope("bun-apps/foo/a.ts", "bun-apps/foo/*")).toBe(true);
	});
	test("rejects deeper paths", () => {
		expect(matchesScope("bun-apps/foo/src/a.ts", "bun-apps/foo/*")).toBe(false);
	});
});

describe("matchesScope — x/ and bare x", () => {
	test("trailing slash is a directory prefix", () => {
		expect(matchesScope("bun-apps/foo/src/a.ts", "bun-apps/foo/")).toBe(true);
	});
	test("bare entry matches the exact file", () => {
		expect(matchesScope("CLAUDE.md", "CLAUDE.md")).toBe(true);
	});
	test("bare entry matches paths under it as a directory", () => {
		expect(matchesScope("docs/adr/a.md", "docs/adr")).toBe(true);
	});
	test("bare entry NO LONGER matches a pseudo-prefix sibling (tightening)", () => {
		// Old startsWith behavior matched this — a false-CLEAN risk.
		expect(matchesScope("bun-apps/foo-bar/x.ts", "bun-apps/foo")).toBe(false);
	});
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/scope-match.test.ts )`
Expected: FAIL — `Cannot find module '../src/scope-match.js'` (or equivalent resolve error).

- [x] **Step 3: Write the implementation**

`bun-apps/pi-agent-ext-devops/src/scope-match.ts`:

```ts
/**
 * Scope-entry matching for verify_merge_landed's expectedScope.
 *
 * Semantics (explicit, replaces the old literal `startsWith`):
 *   `x/**` → directory prefix `x/`, any depth below it
 *   `x/*`  → exactly one path segment below `x/`
 *   `x/`   → directory prefix (same as `x/**`)
 *   `x`    → the exact file `x`, OR any path under `x/` — but NOT a
 *            pseudo-prefix sibling (`bun-apps/foo` must not match
 *            `bun-apps/foo-bar/…`; the old startsWith did — false-CLEAN risk).
 *
 * No glob library: these four forms cover every real call-site usage.
 */
export function matchesScope(path: string, entry: string): boolean {
	if (entry.endsWith("/**")) {
		return path.startsWith(entry.slice(0, -2));
	}
	if (entry.endsWith("/*")) {
		const dir = entry.slice(0, -1); // "x/*" → "x/"
		if (!path.startsWith(dir)) return false;
		return !path.slice(dir.length).includes("/");
	}
	if (entry.endsWith("/")) {
		return path.startsWith(entry);
	}
	return path === entry || path.startsWith(`${entry}/`);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/scope-match.test.ts )`
Expected: PASS — all tests.

- [x] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/src/scope-match.ts bun-apps/pi-agent-ext-devops/tests/scope-match.test.ts
git commit -m "feat(devops): matchesScope — explicit expectedScope entry semantics

Replaces literal startsWith semantics that made glob-style entries
('bun-apps/<pkg>/**') unmatchable and every clean merge CONTAMINATED
(PRs #1737, #1739). Bare entries tightened: no pseudo-prefix siblings.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire `matchesScope` into `verify-merge-recipe.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/src/verify-merge-recipe.ts` (scope-check block at ~line 360-364, the `VerifyMergeOptions.expectedScope` doc comment at ~line 118, and the header comment ~line 16-17)
- Test: `bun-apps/pi-agent-ext-devops/tests/verify-merge-recipe.test.ts` (extend)

**Interfaces:**
- Consumes: `matchesScope(path, entry): boolean` from Task 1 (import as `./scope-match.js` — same `src/` dir).
- Produces: `expectedScope` verdict behavior later PRs rely on: `bun-apps/<pkg>/**` entries now yield CLEAN on in-scope merges.

- [x] **Step 1: Write the failing recipe-level tests**

Append to `tests/verify-merge-recipe.test.ts` (reuse the file's existing fake `gh`/`client`/`spawn` fixtures — read them first and mirror the existing "merged + numstat" test setup; the new tests only change `expectedScope` values and asserted verdicts):

```ts
describe("runVerifyMerge — expectedScope glob semantics (regression, PRs #1737/#1739)", () => {
	// Fixture: merged PR whose numstat reports these paths:
	//   bun-apps/foo/src/a.ts, bun-apps/foo/package.json
	// Build it by cloning the nearest existing "merged → CLEAN/CONTAMINATED"
	// test and swapping the canned numstat + expectedScope.

	test("glob entry 'bun-apps/foo/**' yields CLEAN for in-scope files", async () => {
		const out = await runVerifyMerge({ /* cloned fixture */ expectedScope: ["bun-apps/foo/**"] });
		expect(out.verdict).toBe("CLEAN");
		expect(out.outOfScope).toEqual([]);
	});

	test("glob entry rejects a pseudo-prefix sibling as CONTAMINATED", async () => {
		const out = await runVerifyMerge({ /* cloned fixture + numstat adds bun-apps/foo-bar/x.ts */
			expectedScope: ["bun-apps/foo/**"],
		});
		expect(out.verdict).toBe("CONTAMINATED");
		expect(out.outOfScope.map((f) => f.path)).toEqual(["bun-apps/foo-bar/x.ts"]);
	});

	test("bare entry 'bun-apps/foo' does NOT match 'bun-apps/foo-bar/x.ts' (tightened)", async () => {
		const out = await runVerifyMerge({ /* cloned fixture */ expectedScope: ["bun-apps/foo"] });
		expect(out.outOfScope.map((f) => f.path)).toContain("bun-apps/foo-bar/x.ts");
	});
});
```

The `/* cloned fixture */` markers mean: copy the closest existing merged-PR test verbatim, change only the noted fields. Do NOT invent a new fixture style.

- [x] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/verify-merge-recipe.test.ts )`
Expected: the `**` CLEAN test FAILS with `verdict: "CONTAMINATED"` (old `startsWith` can't match `**`).

- [x] **Step 3: Implement the wiring**

In `src/verify-merge-recipe.ts`:

1. Add import next to the other local imports: `import { matchesScope } from "./scope-match.js";`
2. Replace the scope-check block:

```ts
	// --- 4. Scope check → outOfScope (only when expectedScope given). ----------
	let outOfScope: VerifyFile[] = [];
	if (opts.expectedScope && opts.expectedScope.length > 0) {
		// matchesScope (not bare startsWith): glob-style entries (`x/**`) must
		// match, and bare entries must not swallow pseudo-prefix siblings.
		// Literal startsWith made every `**` invocation report CONTAMINATED.
		outOfScope = files.filter((f) => !opts.expectedScope!.some((p) => matchesScope(f.path, p)));
	}
```

3. Update the `expectedScope` doc comment on `VerifyMergeOptions` (currently "Optional scope prefixes; touched files outside ALL prefixes → CONTAMINATED.") to:

```ts
	/**
	 * Optional scope entries; touched files outside ALL entries → CONTAMINATED.
	 * Entry semantics (src/scope-match.ts): `x/**` directory prefix (any
	 * depth), `x/*` one segment, `x/` prefix, bare `x` exact-or-directory.
	 */
```

4. Update the file-header lines that still say "scope prefix"/"startsWith" (~lines 16-17) to reference `matchesScope` semantics.

- [x] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/verify-merge-recipe.test.ts tests/scope-match.test.ts )`
Expected: PASS — new tests and every pre-existing verdict test.

- [x] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/src/verify-merge-recipe.ts bun-apps/pi-agent-ext-devops/tests/verify-merge-recipe.test.ts
git commit -m "fix(devops): verify_merge_landed expectedScope uses matchesScope

'bun-apps/<pkg>/**' entries now match in-scope merges (CLEAN) instead of
failing every prefix comparison (false CONTAMINATED on PRs #1737/#1739);
bare entries tightened against pseudo-prefix siblings.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: sync unmerged-index pre-flight (`unmerged_index` abort)

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/src/sync-recipe.ts` (SyncClient interface ~line 101, the live client wiring in the same file or its caller, the FULL-mode pre-flight block ~lines 411-432)
- Test: `bun-apps/pi-agent-ext-devops/tests/sync-recipe.test.ts` (extend)
- Modify: `bun-apps/pi-agent-ext-devops/src/sync-default-branch-cli.ts` (only if it lists abort reasons in --help; check and align)

**Interfaces:**
- Consumes: existing `SyncClient` seam pattern (`dirtyPaths(dir): Promise<string[]>`).
- Produces: new client method `unmergedPaths(dir: string): Promise<string[]>`; new abort reason string `"unmerged_index"` added to the abort-reason union (~line 178-200). Later phases and the CLI surface rely on both names.

- [x] **Step 1: Write the failing tests**

Extend `tests/sync-recipe.test.ts` — the `fakeClient` helper needs one new field. Tests:

```ts
describe("runSync — unmerged-index pre-flight (preserve-flow hardening)", () => {
	test("(i) unmerged entries abort 'unmerged_index' BEFORE any stash push — zero mutating spawns", async () => {
		const { fn, calls } = fakeSpawn();
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			unmerged: { [REPO]: [".agents/memory/MEMORY.md"] }, // ← new fake field
		});
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });
		expect(out.aborted?.reason).toBe("unmerged_index");
		expect(out.aborted?.aborted).toBe(true);
		// No stash, no fetch, no merge — died in pre-flight.
		expect(calls.some((c) => c.args.includes("stash"))).toBe(false);
		expect(calls.some((c) => c.args.includes("merge"))).toBe(false);
	});

	test("(ii) dryRun with unmerged entries: warning, no abort, zero spawns", async () => {
		const { fn, calls } = fakeSpawn();
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			unmerged: { [REPO]: ["a.ts"] },
		});
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });
		expect(out.aborted).toBeUndefined();
		expect(out.warnings.join(" ")).toContain("unmerged");
		expect(calls.length).toBe(0);
	});

	test("(iii) clean index proceeds normally (unmergedPaths consulted, no regression)", async () => {
		// Clone the existing "(a) advances <D> in THIS worktree" test, add
		// `unmerged: {}` to its fakeClient, assert it still merges --ff-only.
	});
});
```

Also extend `fakeClient`'s parameter type with `unmerged?: Record<string, string[]>` and its body with `unmergedPaths: async (dir) => s.unmerged?.[dir] ?? []`. Existing `fakeClient` call sites keep compiling (optional field).

- [x] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/sync-recipe.test.ts )`
Expected: (i) FAILS — no `unmerged` option on fakeClient / no `unmergedPaths` on SyncClient (type error at build/test load).

- [x] **Step 3: Implement**

In `src/sync-recipe.ts`:

1. Extend the `SyncClient` interface (the union list at ~line 101 gains `"unmergedPaths"`):

```ts
	/** Unmerged (conflicted) index entries in <dir>, repo-relative, unique.
	 *  Live impl: `git -C <dir> ls-files -u` → split tab, take path column, dedupe. */
	unmergedPaths: (dir: string) => Promise<string[]>;
```

2. Add `"unmerged_index"` to the abort-reason union where `"preserve_failed"` lives (~line 200).

3. In the FULL-mode pre-flight, immediately after the `dirty_tree` check block (~line 432, BEFORE the fetch at step 4):

```ts
		// Unmerged (conflicted) index entries: a previous stash pop / merge left
		// this worktree mid-conflict. `stash push` against such an index fails
		// with a cryptic "could not write index" (observed 2026-08-19/20 on
		// both worktrees via MEMORY.md) — refuse EARLY with the fix instead.
		const unmerged = await client.unmergedPaths(advanceTarget);
		if (unmerged.length > 0) {
			const howTo = [
				`resolve each file then: git -C ${advanceTarget} add <path>`,
				`or abort the leftover op: git -C ${advanceTarget} merge --abort (or rebase --abort)`,
				`or finish the interrupted stash pop: git -C ${advanceTarget} stash pop`,
			].join("; ");
			const msg =
				`unmerged index entries at ${advanceTarget}: ${unmerged.join(", ")} — ` +
				`a conflicted stash pop or interrupted merge left the tree mid-conflict. Fix first: ${howTo}.`;
			warnings.push(msg);
			if (!dry) {
				return outcome({ aborted: true, reason: "unmerged_index", message: msg });
			}
		}
```

4. Wire the LIVE client (wherever `dirtyPaths` is implemented for real — search `dirtyPaths:` implementations in `src/` (`sync-default-branch-cli.ts` / `recipe.ts`); add alongside it):

```ts
	unmergedPaths: async (dir) => {
		const r = await spawn("git", ["-C", dir, "ls-files", "-u"]);
		if (r.exitCode !== 0) return [];
		const paths = new Set(
			r.stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.map((l) => l.split("\t")[1] ?? ""),
				// format: "<mode> <sha> <stage>\t<path>" — path is after the tab
		);
		return [...paths].filter(Boolean);
	},
```

Mirror exactly how the neighboring live `dirtyPaths` spawns/records (if it routes through a recording wrapper, do the same).

- [x] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/sync-recipe.test.ts )`
Expected: PASS — new (i)(ii)(iii) and all pre-existing sync tests.

- [x] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/src/sync-recipe.ts bun-apps/pi-agent-ext-devops/src/sync-default-branch-cli.ts bun-apps/pi-agent-ext-devops/tests/sync-recipe.test.ts
git commit -m "fix(devops): sync_default_branch aborts 'unmerged_index' before preserve stash

A conflicted stash pop leaves unmerged index entries; the next sync's
preserve stash then died with a cryptic 'could not write index'
(observed 2026-08-19/20 on both worktrees). Now: early abort listing
the paths + concrete recovery commands; dryRun warns only.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Upgrade the preserve pop-conflict warning (aftermath + recovery)

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/src/sync-recipe.ts` (pop-conflict block ~lines 500-504)
- Test: `bun-apps/pi-agent-ext-devops/tests/sync-recipe.test.ts` (extend)

**Interfaces:**
- Consumes: existing `SyncPreserved` shape (`{ paths, restored, conflict? }`) — unchanged.
- Produces: a louder warning string; no new API. (The `preserveConflict` struct from the spec is DROPPED as redundant — `preserved.conflict` already exists; only the guidance was missing. Noted as a spec amendment.)

- [x] **Step 1: Write the failing test**

```ts
describe("runSync — preserve pop-conflict aftermath warning", () => {
	test("pop conflict warning names the conflicted paths, the kept stash, and manual recovery", async () => {
		// Clone the closest existing preserve test; make the canned `stash pop`
		// return exitCode 1 with stderr "CONFLICT (content): merge conflict in …".
		const out = await runSync({ /* cloned fixture, pop exitCode 1 */ });
		expect(out.preserved?.restored).toBe(false);
		const w = out.warnings.join(" ");
		expect(w).toContain("unmerged index entries"); // states the aftermath
		expect(w).toContain("git -C"); // recovery commands
		expect(w).toContain("stash"); // stash retention + pop/drop guidance
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/sync-recipe.test.ts )`
Expected: FAIL — current warning (~line 503) does not mention "unmerged index entries".

- [x] **Step 3: Implement**

Replace the pop-conflict warning push (~line 503) with:

```ts
				preserved = { paths: parkedPaths, restored: false, conflict: trim(pop.stderr || pop.stdout) };
				warnings.push(
					`preserve restore: stash pop CONFLICTED at ${advanceTarget}. ` +
						`AFTERMATH: the worktree now has unmerged index entries + conflict markers in: ${parkedPaths.join(", ")}. ` +
						`The stash is KEPT. Recover manually: resolve the markers, then ` +
						`git -C ${advanceTarget} add <path> && git -C ${advanceTarget} stash drop. ` +
						`Until resolved, the next sync will abort 'unmerged_index' by design.`,
				);
```

(Keep the surrounding control flow exactly as-is — only the message changes.)

- [x] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/sync-recipe.test.ts )`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/src/sync-recipe.ts bun-apps/pi-agent-ext-devops/tests/sync-recipe.test.ts
git commit -m "fix(devops): preserve pop-conflict warning states aftermath + recovery

The old one-line warning hid that the worktree is left with unmerged
index entries and conflict markers, and that the next sync would fail
— the exact state observed 2026-08-19 that broke 2026-08-20's sync.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Full gate + PR (devops chain)

**Files:**
- Modify: `.planning/2026-08-20-devops-hardening/spec.md` (status → `phase-1 shipped`), this plan's checkboxes.

**Interfaces:**
- Consumes: devops chain per `skills/devops-workflow/SKILL.md`.
- Produces: merged PR #TBD on main; Phase 2+ can then trust verify_merge_landed verdicts.

- [ ] **Step 1: Canonical package gate**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test )`
Expected: entire suite PASS (includes any build the canonical script defines).

- [ ] **Step 2: Cross-package typecheck + lint via local_ci (change-scoped)**

Run: `CI=true bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts`
Expected: `overall: "pass"`, wall clock < 5 min. (CI=true skips the FLAKY_UNDER_CI e2e splice test — mandatory.)

- [ ] **Step 3: Pre-merge re-sync (multi-worktree rule: fetch before rebase)**

Run: `bun bun-apps/pi-agent-ext-devops/src/sync-default-branch-cli.ts`
If main advanced: rebase via `bun bun-apps/pi-agent-ext-devops/src/prepare-feature-branch-cli.ts --branch devops-hardening-phase1 --rebase --force-push`.

- [ ] **Step 4: Finish the PR**

```bash
GH_PAGER=cat gh pr create --title "fix(devops): verify_merge_landed scope semantics + sync preserve hardening (devops-hardening Phase 1)" \
  --body-file /tmp/phase1-body.md
# body: summary of the two fixes, incident evidence (2026-08-19/20), test notes,
# spec/plan links. End with the Claude Code footer.
CI=true bun bun-apps/pi-agent-ext-devops/src/merge-pr-after-ci-cli.ts <pr> \
  --expected-scope 'bun-apps/pi-agent-ext-devops/**' \
  --expected-scope '.planning/2026-08-20-devops-hardening/**'
bun bun-apps/pi-agent-ext-devops/src/verify-merge-cli.ts <pr> --fetch \
  --scope 'bun-apps/pi-agent-ext-devops/**,.planning/2026-08-20-devops-hardening/**'
```

The Phase-1a fix makes this verdict trustworthy — this PR is its first real consumer. `CONTAMINATED` here is now a REAL signal: investigate, don't dismiss.

- [ ] **Step 5: Post-merge**

`bun bun-apps/pi-agent-ext-devops/src/prepare-feature-branch-cli.ts --branch devops-hardening-phase2 --create` BEFORE any new commit (detached-HEAD trap), then update spec status + commit on the new branch.

---

## Self-review notes

- Spec coverage: 1a = Tasks 1-2, 1b pre-flight = Task 3, 1b aftermath = Task 4 (amended: reuse existing `preserved.conflict` instead of a new `preserveConflict` field — same information, less API). Gates/PR = Task 5.
- Placeholders: the three `/* cloned fixture */` markers reference the nearest existing test in the same file by instruction, not by line — acceptable because the executor reads the file; everything else is concrete code.
- Type consistency: `matchesScope(path: string, entry: string): boolean` used identically in Tasks 1-2; `unmergedPaths(dir: string): Promise<string[]>` and reason `"unmerged_index"` defined in Task 3, consumed nowhere later in this plan (Phase 2+ plan will restate them).
