# Task 3 Report: Repo lint — fail on upstream-path artifact leakage (ADR-0006)

## Implementation Summary

### Step 1: Write the lint test
Created `bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts` with the test code from the brief.

**Modification made to the original brief code:**
- Changed `statSync` to `lstatSync` to detect symlinks
- Added `if (stat.isSymbolicLink()) continue;` to skip symlinked directories

This modification was necessary because `docs/superpowers/plans` and `docs/superpowers/specs` are symlinks to `.planning/plans` and `.planning/specs`. Without skipping symlinks, the test would incorrectly flag all files in `.planning/` as "leaked" artifacts.

### Step 2: Run test to verify PASS on clean tree

```bash
$ bun test --cwd bun-apps/pi-agent-ext-superpowers tests/artifact-leak.test.ts
bun test v1.3.14 (0d9b296a)

tests/artifact-leak.test.ts:
(pass) no superpowers artifacts leak to upstream paths (ADR-0006) [0.45ms]

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file. [9.00ms]
```

Result: **PASS** ✓ - Only the baseline audit file exists under `docs/superpowers/`; `.superpowers/` is absent.

### Step 3: Verify FAIL on provoked leak (manual sanity)

Created probe file to verify the test catches violations:

```bash
$ mkdir -p docs/superpowers/specs && echo probe > docs/superpowers/specs/probe.md
# Note: This created the file through the symlink, so was skipped
$ echo probe > docs/superpowers/probe.md
$ bun test --cwd bun-apps/pi-agent-ext-superpowers tests/artifact-leak.test.ts
bun test v1.3.14 (0d9b296a)

tests/artifact-leak.test.ts:
34 |     for (const abs of listFiles(join(repoRoot, root))) {
35 |       const rel = abs.slice(repoRoot.length + 1).replace(/\\/g, "/");
36 |       if (!ALLOWED.has(rel)) offenders.push(rel);
37 |     }
38 |   }
39 |   expect(offenders).toEqual([]);
                         ^
error: expect(received).toEqual(expected)

- []
+ [
+   "docs/superpowers/probe.md",
+ ]

- Expected  - 1
+ Received  + 3

      at <anonymous> (/Users/huangziyu/proj/video_generation__tool_gate/bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts:39:21)
(fail) no superpowers artifacts leak to upstream paths (ADR-0006) [0.72ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [13.00ms]
```

Result: **FAIL** ✓ - Test correctly detected the probe file as an offender.

Cleanup:
```bash
$ rm -f docs/superpowers/probe.md && rm -f .planning/specs/probe.md
$ git status docs/superpowers/ .planning/specs/
On branch video_generation__tool_gate
nothing to commit, working tree clean
```

### Step 4: Run full ext suite + lint

```bash
$ bun test --cwd bun-apps/pi-agent-ext-superpowers
bun test v1.3.14 (0d9b296a)

tests/skills-fidelity.test.ts:
(pass) skill fidelity (ADR-0004) — upstream-ported SKILL.md byte-equal baseline > brainstorming/SKILL.md matches its baseline fixture [0.13ms]
[... 14 skills fidelity tests ...]

tests/skills.test.ts:
(pass) skills suite (Pi loader rules) > discovers all 14 expected skills [0.03ms]
[... 79 skills validation tests ...]

tests/artifact-leak.test.ts:
(pass) no superpowers artifacts leak to upstream paths (ADR-0006) [0.10ms]

tests/binary-mode.test.ts:
(pass) resolveSkillsDir in compiled-binary mode > resolves to the embedded-assets extraction dir when the env var is set [0.52ms]
[... 3 more binary-mode tests ...]

tests/sdd-workspace.test.ts:
(pass) sdd-workspace (pi-port effort nesting) > routes to .planning/$effort/sdd/$slug when PI_PLANNING_EFFORT is set [40.43ms]
[... 2 more sdd-workspace tests ...]

tests/bootstrap.test.ts:
(pass) superpowers extension wiring > registers exactly the upstream event hooks [0.10ms]
[... 10 more bootstrap tests ...]

tests/skill-exclude.test.ts:
(pass) default exclude (Phase-3 clean-pass) > excludes verification-before-completion by default (no env set); advertises every other skill as an individual dir [0.29ms]
[... 8 more skill-exclude tests ...]

 129 pass
 0 fail
 228 expect() calls
Ran 129 tests across 7 files. [134.00ms]
```

Lint check:
```bash
$ bun run --cwd bun-apps/pi-agent-ext-superpowers lint
Checked 14 files in 18ms. No fixes applied.
Found 4 infos.
```

The 4 lint infos are pre-existing issues in `tests/binary-mode.test.ts` (useLiteralKeys suggestions), not related to my changes. The new file `tests/artifact-leak.test.ts` is lint-clean.

Result: **All tests PASS** ✓, **lint clean for new file** ✓

### Step 5: Commit

```bash
$ git add bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts
$ git commit -m "test(superpowers): repo lint — fail on upstream-path artifact leakage (ADR-0006)"
[video_generation__tool_gate 42725cfc] test(superpowers): repo lint — fail on upstream-path artifact leakage (ADR-0006)
 1 file changed, 40 insertions(+)
 create mode 100644 bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts
```

## Commit Details

```
commit 42725cfc62ffe4bbfc9dfb9587ec2d2494285293
Author: Ziyu Huang <ziyu4huang@gmail.com>
Date:   2026-08-02 02:24:00 +0800

    test(superpowers): repo lint — fail on upstream-path artifact leakage (ADR-0006)

 .../tests/artifact-leak.test.ts                    | 40 ++++++++++++++++++++++
 1 file changed, 40 insertions(+)
```

## Notes

1. **Symlink handling**: The test was modified from the brief to skip symlinked directories using `lstatSync` and `isSymbolicLink()` check. This was necessary because `docs/superpowers/plans` and `docs/superpowers/specs` are symlinks to `.planning/plans` and `.planning/specs`. The test should only flag actual files stored under the upstream paths, not files accessed through symlinks.

2. **Baseline ALLOWED set**: The baseline contains one grandfathered file: `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md`, which is the ADR-0006 baseline audit file referenced in the brief.

3. **Lint warnings**: The 4 lint infos are pre-existing in `tests/binary-mode.test.ts` and are not related to the new test file.
