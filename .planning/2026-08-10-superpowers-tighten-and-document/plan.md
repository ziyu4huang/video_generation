# Superpowers — Tighten & Document Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-advertise the double-counted `using-superpowers` skill, document the default-exclude policy in ADR-0008, and harden `artifact-leak.test.ts` to git-tracked scope — netting ~763 tok/req saved, a documented policy, and a reliably-green suite.

**Architecture:** Three independent, sequentially-committable changes to `pi-agent-ext-superpowers`: (1) a one-constant + comment change in `src/superpowers.ts` with its test updated; (2) a new ADR doc; (3) a test-only refactor of `artifact-leak.test.ts` from raw-FS to git-tracked enumeration. No runtime behavior change beyond the advertised-skill set (13→12) and the leak test's scope.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome (`bun run check`), `tsc` (`bun run build`). Pi `ExtensionAPI`. No new deps.

## Global Constraints

- Fidelity lock (ADR-0004): never edit `skills/*/SKILL.md` — "unregister ≠ edit".
- No `.superpowers/` writes (ADR-0007): all artifacts route to `.planning/`.
- Shell discipline: never top-level `cd`; use `git -C` or `( cd … && … )`.
- Package test gate: `bun run test` (== `biome check .` + `bunx tsc` + `bun test`). There is **no** separate `typecheck` script in this package — `bun run build` (`tsc`) is the type gate.
- Repo SOP: PR per change, squash-merge via `gh ship`, never wait for remote CI (disabled by design).

## File Structure

- **Modify** `src/superpowers.ts` — `DEFAULT_SKILL_EXCLUDE` constant + its doc comment (Task 1).
- **Modify** `tests/skill-exclude.test.ts` — expected advertised set (13→12), both defaults excluded (Task 1).
- **Create** `docs/adr/0008-default-skill-exclusion-policy.md` — the policy ADR (Task 2).
- **Modify** `tests/artifact-leak.test.ts` — raw-FS → git-tracked enumeration + untracked-ignored case (Task 3).
- **Unchanged** `tests/bootstrap.test.ts` (D1 doesn't touch the bootstrap read path; existing coverage verified in Task 1 Step 5) and `tests/skills-fidelity.test.ts` (14 fixtures still match — de-advertising touches no files).

---

### Task 1: De-advertise `using-superpowers`

**Files:**
- Modify: `src/superpowers.ts` (the `DEFAULT_SKILL_EXCLUDE` constant + its preceding doc comment)
- Modify: `tests/skill-exclude.test.ts` (the `DEFAULT_SKILL` constant + the 6 assertions that derive the expected advertised set)

**Interfaces:**
- Consumes: none (first task).
- Produces: `DEFAULT_SKILL_EXCLUDE` now holds two entries; `resolveAdvertisedSkillPaths` / the `resources_discover` handler advertise 12 (not 13) skills by default. The bootstrap read path (`resolveBootstrapSkillPath` / `getBootstrapContent`) is untouched — `using-superpowers` content still loads via the bootstrap.

- [ ] **Step 1: Update the tests first (TDD — red).** In `tests/skill-exclude.test.ts`:

(a) Replace the constant:
```ts
const DEFAULT_SKILL = "verification-before-completion";
```
with:
```ts
const DEFAULT_SKILLS = ["verification-before-completion", "using-superpowers"];
```

(b) In the file's top doc comment, replace:
```
 * — saves ~139 tok/req for ~zero behavioral cost. Other skills are unloaded
 * only when listed in `PI_SUPERPOWERS_SKILL_EXCLUDE`.
```
with:
```
 * — `verification-before-completion` (~900 tok, Phase-3 clean-pass) and
 * `using-superpowers` (~763 tok, bootstrap dedup — its body is already injected
 * by the bootstrap). See ADR-0008. Other skills are unloaded only when listed
 * in `PI_SUPERPOWERS_SKILL_EXCLUDE`.
```

(c) In the test `"excludes verification-before-completion by default (no env set); advertises every other skill as an individual dir"`, replace:
```ts
    const expected = allSkillDirNames().filter((n) => n !== DEFAULT_SKILL);
    expect(advertised).toEqual(expected);
    expect(advertised).not.toContain(DEFAULT_SKILL);
```
with:
```ts
    const expected = allSkillDirNames().filter((n) => !DEFAULT_SKILLS.includes(n));
    expect(advertised).toEqual(expected);
    for (const d of DEFAULT_SKILLS) expect(advertised).not.toContain(d);
```
and rename the test title to: `"excludes both default skills by default (v-b-c + using-superpowers); advertises every other skill as an individual dir"`.

(d) In `"a truthy/unrecognized DEFAULTS value leaves the default ON"`, replace:
```ts
    expect(advertised).not.toContain(DEFAULT_SKILL);
```
with:
```ts
    for (const d of DEFAULT_SKILLS) expect(advertised).not.toContain(d);
```

(e) In `"the default-excluded skill's pinned SKILL.md stays on disk byte-identical (ADR-0004 — unregister ≠ edit)"`, replace:
```ts
    expect(existsSync(join(skillsDir, DEFAULT_SKILL, "SKILL.md"))).toBe(true);
```
with:
```ts
    for (const d of DEFAULT_SKILLS) expect(existsSync(join(skillsDir, d, "SKILL.md"))).toBe(true);
```
and rename the title to: `"the default-excluded skills' pinned SKILL.md stay on disk byte-identical (ADR-0004 — unregister ≠ edit)"`.

(f) In `"composes with the default (env-listed skill AND verification-before-completion both excluded)"`, replace:
```ts
    const expected = allSkillDirNames().filter((n) => n !== "test-driven-development" && n !== DEFAULT_SKILL);
```
with:
```ts
    const expected = allSkillDirNames().filter((n) => n !== "test-driven-development" && !DEFAULT_SKILLS.includes(n));
```

(g) In `"supports a comma-list and trims whitespace (composes with the default)"`, replace:
```ts
      (n) => n !== "test-driven-development" && n !== "systematic-debugging" && n !== DEFAULT_SKILL,
```
with:
```ts
      (n) => n !== "test-driven-development" && n !== "systematic-debugging" && !DEFAULT_SKILLS.includes(n),
```

(h) In `"with DEFAULTS=0: omits the excluded skill and advertises every other skill — the default skill IS loaded (raw knob)"`, replace:
```ts
    // default suppressed → verification-before-completion IS loaded here
    expect(advertised).toContain(DEFAULT_SKILL);
```
with:
```ts
    // defaults suppressed → BOTH default skills are loaded here
    for (const d of DEFAULT_SKILLS) expect(advertised).toContain(d);
```

- [ ] **Step 2: Run the tests to verify they fail (red).**
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/skill-exclude.test.ts )`
Expected: FAIL — the default-advertised set still contains `using-superpowers` (current `DEFAULT_SKILL_EXCLUDE` has one entry), so the `expected`/`advertised` equality and the `not.toContain("using-superpowers")` assertions fail.

- [ ] **Step 3: Make the code change (green).** In `src/superpowers.ts`, replace:
```ts
/** Skills UNREGISTERED by default (Phase-3 clean-pass — the model resists
 *  confidence-escalation even without this skill, so dropping it costs ~zero
 *  behavior for ~139 tok/req saved). Override via the env list, or disable
 *  entirely via {@link DEFAULTS_DISABLE_ENV}. */
export const DEFAULT_SKILL_EXCLUDE = ["verification-before-completion"] as const;
```
with:
```ts
/**
 * Skills UNREGISTERED by default (never advertised via `resources_discover`),
 * each for a distinct reason — see ADR-0008 for the full policy:
 *   - `verification-before-completion` (~900 tok) — Phase-3 clean-pass: the
 *     model resists confidence-escalation even without this skill, so dropping
 *     it costs ~zero behavior.
 *   - `using-superpowers` (~763 tok) — bootstrap dedup: its full body is
 *     already injected as the bootstrap by {@link getBootstrapContent}, which
 *     also instructs the agent not to load it again, so advertising it
 *     duplicates the content for ~zero behavioral gain.
 * Override via the env list ({@link SKILL_EXCLUDE_ENV}), or disable the
 * defaults entirely via {@link DEFAULTS_DISABLE_ENV}.
 */
export const DEFAULT_SKILL_EXCLUDE = ["verification-before-completion", "using-superpowers"] as const;
```

- [ ] **Step 4: Run the tests to verify they pass (green).**
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/skill-exclude.test.ts )`
Expected: PASS — all assertions green; advertised set is 12 skills (neither default present).

- [ ] **Step 5: Verify the bootstrap path is unaffected.**
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: PASS — D1 changes only the advertised set; `getBootstrapContent` still reads `skills/using-superpowers/SKILL.md` directly, and the `resources_discover` wiring test uses `DEFAULTS=0` so it still returns the whole `skills/` dir. No edits to `bootstrap.test.ts`.

- [ ] **Step 6: Commit.**
```bash
git add bun-apps/pi-agent-ext-superpowers/src/superpowers.ts bun-apps/pi-agent-ext-superpowers/tests/skill-exclude.test.ts
git commit -m "feat(superpowers): de-advertise using-superpowers (bootstrap dedup, ~763 tok/req)

Add using-superpowers to DEFAULT_SKILL_EXCLUDE — its full body is already
injected as the bootstrap (getBootstrapContent), which tells the agent not to
load it again, so advertising it duplicated ~763 tok/req for ~zero gain.
Rewrite the policy comment with accurate figures + an ADR-0008 pointer.
Advertised set 13 -> 12. See ADR-0008."
```

---

### Task 2: Write ADR-0008 — default skill-exclusion policy

**Files:**
- Create: `docs/adr/0008-default-skill-exclusion-policy.md`

**Interfaces:**
- Consumes: Task 1's `DEFAULT_SKILL_EXCLUDE` (the ADR documents it).
- Produces: a decision record future changes to the exclude set must reference.

- [ ] **Step 1: Create the ADR.** Write exactly this to `bun-apps/pi-agent-ext-superpowers/docs/adr/0008-default-skill-exclusion-policy.md`:

````markdown
# ADR-0008: Default skill-exclusion policy

Date: 2026-08-10
Status: accepted
See: [ADR-0004](./0004-skill-fidelity-positive-pin.md) (unregister ≠ edit),
[ADR-0007](./0007-unconditional-artifact-home.md),
[spec](../../../../.planning/2026-08-10-superpowers-tighten-and-document/spec.md)

## Context

The package ships 14 fidelity-locked skills (ADR-0004). `resources_discover`
advertises the set pi registers at session start — every advertised skill costs
its full `SKILL.md` in the system prompt every request. Two skills should not be
advertised by default, for distinct reasons, but until now only one was excluded
and its rationale lived in a code comment that drifted (it claimed "~139 tok/req
saved"; the skill is 3,646 bytes ≈ 900 tok).

A measurement also found that `using-superpowers` was both **injected as the
bootstrap body** (`getBootstrapContent()` reads `skills/using-superpowers/SKILL.md`
and embeds it, with the instruction "Do not try to load using-superpowers again")
**and advertised** as one of the 13 skills — a ~763 tok/req double-count plus a
confusing invokable skill the agent is told not to use.

## Decision

`DEFAULT_SKILL_EXCLUDE = ["verification-before-completion", "using-superpowers"]`,
each excluded for a distinct reason:

| Skill | Size | Reason | Class |
|-------|------|--------|-------|
| `verification-before-completion` | 3,646 B ≈ 900 tok | Phase-3 clean-pass: the model resists confidence-escalation even without this skill, so excluding it costs ~zero behavior. | behavior |
| `using-superpowers` | 3,063 B ≈ 763 tok | Bootstrap dedup: its full body is already injected as the bootstrap (`getBootstrapContent`), which tells the agent not to load it again. | redundancy |

Figures are `wc -c` on each `SKILL.md` divided by ~4 (chars-per-token heuristic).

Neither skill's `SKILL.md` is edited — "unregister ≠ edit" (ADR-0004). Both files
stay on disk byte-identical; they are simply omitted from the
`resources_discover` advertisement.

**Override knobs:**
- `PI_SUPERPOWERS_SKILL_EXCLUDE` — additive comma-list of skill dir-names to also
  exclude (composed with the defaults).
- `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` (or `false`/`no`/`off`) — suppress the
  defaults entirely, re-advertising both (including the `using-superpowers`
  double-count). Acceptable as an explicit opt-out, e.g. a probe fat-run that must
  load every skill.

## Consequences

- Advertised set: 13 → 12; ~763 tok/req saved (the `verification-before-completion`
  exclusion predates this ADR).
- `using-superpowers` content remains ever-present via the bootstrap (injected on
  `session_start`/`session_compact` until first `agent_end`, re-armed on compact);
  only the redundant `/skill:using-superpowers` command + system-prompt entry is
  removed.
- Disabling defaults restores the historical "all 14 advertised" behavior.

## Alternatives considered

- **Strip `using-superpowers` from the bootstrap (keep it advertised).** Rejected:
  the bootstrap must be present before the agent's first response, so it cannot be
  deferred to on-demand skill loading.
- **Re-enable `verification-before-completion`.** Rejected: the Phase-3 finding
  (no behavioral cost to excluding it) still stands.
- **Document only, don't exclude `using-superpowers`.** Rejected: the
  double-count is pure waste with ~zero behavioral gain.
````

- [ ] **Step 2: Verify the ADR (deliverable check).**
Run: `( cd bun-apps/pi-agent-ext-superpowers && head -5 docs/adr/0008-default-skill-exclusion-policy.md )`
Expected: shows the `# ADR-0008` title + `Status: accepted`.
Run: `grep -c -e 'verification-before-completion' -e 'using-superpowers' -e 'PI_SUPERPOWERS_SKILL_EXCLUDE' bun-apps/pi-agent-ext-superpowers/docs/adr/0008-default-skill-exclusion-policy.md`
Expected: a count ≥ 6 (both skills named multiple times, both knobs present).

- [ ] **Step 3: Commit.**
```bash
git add bun-apps/pi-agent-ext-superpowers/docs/adr/0008-default-skill-exclusion-policy.md
git commit -m "docs(superpowers): ADR-0008 — default skill-exclusion policy

Documents both default-excluded skills with distinct rationales
(v-b-c = Phase-3 behavior; using-superpowers = bootstrap dedup), accurate
token figures, the two override knobs, and the disable-defaults trade-off."
```

---

### Task 3: Harden `artifact-leak.test.ts` to git-tracked scope

**Files:**
- Modify: `tests/artifact-leak.test.ts` (raw-FS walk → git-tracked enumeration; add an untracked-ignored case)

**Interfaces:**
- Consumes: none.
- Produces: a leak guard that fails only on *committed* leaks (not local gitignored scratch).

- [ ] **Step 1: Add the failing test first (TDD — red).** Append this second test to the existing `tests/artifact-leak.test.ts` (leave the existing `listFiles` + existing test untouched for now):
```ts
test("local UNTRACKED scratch under .superpowers/ does not false-red the guard", () => {
  // An untracked (gitignored) file must never be reported as a leak — this is
  // the regression that made the suite red on otherwise-clean main.
  const scratchDir = join(repoRoot, ".superpowers", "sdd", "plan");
  const scratchFile = join(scratchDir, "scratch-task-brief.md");
  Bun.spawnSync(["mkdir", "-p", scratchDir]);
  Bun.spawnSync(["touch", scratchFile]);
  try {
    const offenders: string[] = [];
    for (const root of ["docs/superpowers", ".superpowers"]) {
      for (const abs of listFiles(join(repoRoot, root))) {
        const rel = abs.slice(repoRoot.length + 1).replace(/\\/g, "/");
        if (!ALLOWED.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  } finally {
    Bun.spawnSync(["rm", "-f", scratchFile]);
    Bun.spawnSync(["rmdir", "-p", scratchDir], { stdout: "ignore", stderr: "ignore" });
  }
});
```
(This calls the existing raw-FS `listFiles` directly, so it will find the untracked scratch and FAIL.)

- [ ] **Step 2: Run the tests to verify the new test fails (red).**
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/artifact-leak.test.ts )`
Expected: FAIL — the new test reports the untracked `scratch-task-brief.md` as an offender (the raw-FS walk sees it); the existing test still passes.

- [ ] **Step 3: Switch the enumeration to git-tracked scope (green).** Replace the ENTIRE contents of `tests/artifact-leak.test.ts` with:
```ts
/**
 * Repo lint (ADR-0007 defense-in-depth): no superpowers artifact may be COMMITTED
 * under the upstream paths `docs/superpowers/` or `.superpowers/`. Enumeration is
 * git-tracked (`git ls-files`), so local gitignored scratch (e.g. `.superpowers/sdd/`
 * from an SDD run) never false-reds the suite on otherwise-clean main. Runs in the
 * ext's `bun run test` matrix (ci.yml:111) so a committed leak fails CI.
 */
import { expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/ → ext pkg → bun-apps → repo root (3 levels up)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Files grandfathered under the upstream paths (the ADR-0007 baseline). */
const ALLOWED = new Set(["docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md"]);

const GUARD_ROOTS = ["docs/superpowers", ".superpowers"];

/** Tracked (committed) files under the guard roots. Local gitignored scratch
 *  (e.g. an untracked `.superpowers/sdd/` dir) never appears here, so it cannot
 *  false-red the guard. */
function trackedFilesUnder(roots: string[]): string[] {
  const out = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "--", ...roots]);
  const stdout = (out.stdout ?? "").toString().trim();
  return stdout ? stdout.split("\n") : [];
}

/** Committed leaks under the guard roots: tracked, non-symlink, not grandfathered.
 *  Symlinks are skipped because `docs/superpowers/{specs,plans}` are intentional
 *  tracked symlinks to `.planning/{specs,plans}` (ADR-0007 amendment). */
function findLeakedFiles(): string[] {
  const offenders: string[] = [];
  for (const rel of trackedFilesUnder(GUARD_ROOTS)) {
    const abs = join(repoRoot, rel);
    if (lstatSync(abs).isSymbolicLink()) continue;
    if (!ALLOWED.has(rel)) offenders.push(rel);
  }
  return offenders;
}

test("no superpowers artifacts leak to upstream paths (ADR-0007)", () => {
  expect(findLeakedFiles()).toEqual([]);
});

test("local UNTRACKED scratch under .superpowers/ does not false-red the guard", () => {
  // An untracked (gitignored) file must never be reported as a leak — this is
  // the regression that made the suite red on otherwise-clean main.
  const scratchDir = join(repoRoot, ".superpowers", "sdd", "plan");
  const scratchFile = join(scratchDir, "scratch-task-brief.md");
  Bun.spawnSync(["mkdir", "-p", scratchDir]);
  Bun.spawnSync(["touch", scratchFile]);
  try {
    expect(findLeakedFiles()).toEqual([]);
  } finally {
    Bun.spawnSync(["rm", "-f", scratchFile]);
    Bun.spawnSync(["rmdir", "-p", scratchDir], { stdout: "ignore", stderr: "ignore" });
  }
});
```

- [ ] **Step 4: Run the tests to verify both pass (green).**
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/artifact-leak.test.ts )`
Expected: PASS — both cases green; the untracked scratch is ignored (it never appears in `git ls-files`).

- [ ] **Step 5: Clean the local orphans (one-time hygiene, your "no .superpowers/" constraint).**
Run: `rm -rf /Users/huangziyu/proj/video_generation__superpowers/.superpowers`
(The 23 stale pre-`a5a0864a` files are gitignored; deletion produces no git diff. Nothing recreates them post-fix.)

- [ ] **Step 6: Run the full package gate.**
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun run test )`
Expected: PASS — `biome check` + `tsc` + `bun test` all green (artifact-leak's 2 cases, skill-exclude, bootstrap, fidelity, and the rest).

- [ ] **Step 7: Commit.**
```bash
git add bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts
git commit -m "test(superpowers): harden artifact-leak guard to git-tracked scope

Switch the ADR-0007 leak walk from raw readdirSync to \`git ls-files\` so local
gitignored scratch (e.g. .superpowers/sdd/ from an SDD run) no longer false-reds
the suite on otherwise-clean main — only COMMITTED leaks fail. Adds a case
proving an untracked .superpowers/ file is ignored. Symlinks (the intentional
docs/superpowers/{specs,plans} -> .planning links) stay skipped."
```

---

## Final (after Task 3)

- Confirm the whole package is green: `( cd bun-apps/pi-agent-ext-superpowers && bun run test )`.
- Open the PR for `feat/superpowers-tighten-and-document` (plan + Tasks 1–3 commits), squash-merge via `gh ship`, fast-forward `synced-main`.
