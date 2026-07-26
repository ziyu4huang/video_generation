# superpowers + wayfind critical-path integration tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the genuine deterministic test gaps surfaced by the wayfinder research (ticket 01, **revised** after reading the code) — the untested `sdd-workspace` pi-port glue + the missing `pi-agent-ext-superpowers` CI matrix slot — and document the real-pi local-smoke probes as the follow-up effort (not executed here).

**Architecture:** Two CI-safe, deterministic tasks that reach green now: (T1) one matrix line adding superpowers to the existing per-package test gate — it is the only `pi-agent-ext-*` absent (`grep -c = 0`) yet has full script parity with wayfind; (T2) a golden-output shell test for `sdd-workspace`'s two branches (`PI_PLANNING_EFFORT` set → `.planning/$effort/sdd/$slug`; unset → `.superpowers/sdd/$slug`), mirroring the repo's `scripts/pr-finish.test.ts` precedent for bash-script decision-logic tests. The real-pi probes (skill-exclude-under-real-pi, SDD fix-loop cross-round) are local-smoke per the 02 decision and are documented as the next effort.

**Tech Stack:** Bun test (TS, `Bun.spawn`/`spawnSync` for the shell test), GitHub Actions matrix (`ci.yml`), bash (`sdd-workspace`).

## Global Constraints
- superpowers package scripts: `"test": "bun run check && bun run build && bun run test:unit"` (biome check → tsc build → bun test). Every new test file must pass `bunx biome check` — CI runs `bun run check` first, a format fail fails the job (lesson from PR #832's wayfind biome flake).
- `sdd-workspace` is bash (`set -euo pipefail`); its `git rev-parse --show-toplevel` means the test must run inside a temp git repo.
- `.planning/` is committed (only `progress.md` is gitignored by name); new test files + ci.yml changes commit normally.
- Real-pi probe-runner tests are **local-smoke-only** (02 decision) — NOT added to CI in this plan.
- Branch off `origin/main` in a fresh worktree (the `video_generation__superpowers` branch is post-squash-merge; #833/#834 landed since but do not touch ci.yml/superpowers).

## Scope-revision note (important for the implementer)

Ticket 01 over-stated the gaps. After reading the code:
- `piBoundaryOverrides()` is a **pure string generator** (routing is prompt-driven, not executable logic), and its content **IS already asserted** by `bootstrap.test.ts` (lines 171-210: "carries the Pipeline routing", DECIDE/SYNTHESIZE, the 2-rule convergence, length guard). Not a gap.
- `parseSkillExclude` / `resolveAdvertisedSkillPaths` / bootstrap injection lifecycle / binary-mode resolution are all unit-covered.
- The **only** untested deterministic surface is `sdd-workspace` (bash, not in the TS suite). That + the matrix slot are this plan.

## File Structure
- **Modify:** `.github/workflows/ci.yml` — add `pi-agent-ext-superpowers` to the per-package test matrix (T1); optionally to `determinism-spotcheck` (stretch T3).
- **Create:** `bun-apps/pi-agent-ext-superpowers/tests/sdd-workspace.test.ts` — golden-output test for the script's effort-set + effort-unset branches (T2).
- **Reference (read-only):** `scripts/pr-finish.test.ts` — repo precedent for bash-script decision-logic tests; `skills/subagent-driven-development/scripts/sdd-workspace` — the script under test.

---

### Task 1: Add superpowers to the CI test matrix  [the (a) one-liner]

**Files:**
- Modify: `.github/workflows/ci.yml` — the `test` job's `matrix.include`, immediately after the wayfind entry (~line 102).

**Interfaces:** none (config-only).

- [ ] **Step 1: add the matrix line**

Insert immediately after the `- { package: pi-agent-ext-wayfind, test-cmd: "bun run test" }` line:

```yaml
            - { package: pi-agent-ext-superpowers, test-cmd: "bun run test" }
```

This mirrors wayfind exactly (superpowers has identical `"test": "bun run check && bun run build && bun run test:unit"` + a `biome.json`).

- [ ] **Step 2: verify the YAML is still valid**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo OK
```
Expected: `OK` (no parse error). Then confirm the entry is present + count:
```bash
grep -c 'pi-agent-ext-superpowers' .github/workflows/ci.yml   # expect 1
```

- [ ] **Step 3: confirm the test-cmd works locally (parity)**

```bash
( cd bun-apps/pi-agent-ext-superpowers && bun run test:unit )
```
Expected: `125 pass` (the full suite green; biome + tsc already proven on #832).

- [ ] **Step 4: commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(superpowers): add pi-agent-ext-superpowers to the test matrix"
```

---

### Task 2: sdd-workspace derivation golden-output test

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/tests/sdd-workspace.test.ts`

**Interfaces:**
- Consumes: the script `skills/subagent-driven-development/scripts/sdd-workspace` (bash; reads `PI_PLANNING_EFFORT`, derives `<plan-basename>` from the plan filename, `git rev-parse --show-toplevel`).
- Produces: a regression test that locks in both branches of the pi-port glue (effort-set → committed `.planning/` audit trail; effort-unset → upstream `.superpowers/sdd/` self-ignoring fallback).

- [ ] **Step 1: write the test**

`bun-apps/pi-agent-ext-superpowers/tests/sdd-workspace.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = resolve(
  import.meta.dir,
  "../skills/subagent-driven-development/scripts/sdd-workspace",
);

/** A throwaway git repo so the script's `git rev-parse --show-toplevel` resolves. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdd-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

/** Run sdd-workspace once; return { stdout, status }. cwd = the temp repo root. */
function run(planAbsPath: string, cwd: string, env: Record<string, string>): { stdout: string; status: number | null } {
  const r = spawnSync("bash", [SCRIPT, planAbsPath], { cwd, env: { ...process.env, ...env } });
  return { stdout: r.stdout.toString().trim(), status: r.status };
}

describe("sdd-workspace (pi-port effort nesting)", () => {
  it("routes to .planning/$effort/sdd/$slug when PI_PLANNING_EFFORT is set", () => {
    const repo = makeTempRepo();
    const plan = join(repo, "plans", "add-auth.md");
    writeFileSync(plan, "# plan\n"); // existence is all the script checks
    try {
      const { stdout, status } = run(plan, repo, { PI_PLANNING_EFFORT: "2026-07-26-foo" });
      expect(status).toBe(0);
      expect(stdout).toBe(join(repo, ".planning", "2026-07-26-foo", "sdd", "add-auth"));
      expect(existsSync(stdout)).toBe(true); // mkdir -p created it
      // effort branch does NOT write a blanket .gitignore (audit trail committed)
      expect(existsSync(join(repo, ".planning", "2026-07-26-foo", "sdd", ".gitignore"))).toBe(false);
    } finally {
      // cleanup left to OS temp lifecycle; tests must not touch the real repo
    }
  });

  it("falls back to .superpowers/sdd/$slug (with self-ignore) when no effort", () => {
    const repo = makeTempRepo();
    const plan = join(repo, "plans", "big-refactor.md");
    writeFileSync(plan, "# plan\n");
    const { stdout, status } = run(plan, repo, { PI_PLANNING_EFFORT: "" });
    expect(status).toBe(0);
    expect(stdout).toBe(join(repo, ".superpowers", "sdd", "big-refactor"));
    expect(existsSync(stdout)).toBe(true);
    // upstream-faithful branch writes the blanket self-ignore
    expect(existsSync(join(repo, ".superpowers", "sdd", ".gitignore"))).toBe(true);
    expect(readFileSync(join(repo, ".superpowers", "sdd", ".gitignore"), "utf8").trim()).toBe("*");
  });

  it("derives the slug from the plan basename, not a deeper path", () => {
    const repo = makeTempRepo();
    const plan = join(repo, "plans", "nested", "deep", "cool.md");
    writeFileSync(plan, "# plan\n");
    const { stdout, status } = run(plan, repo, { PI_PLANNING_EFFORT: "e1" });
    expect(status).toBe(0);
    expect(stdout.endsWith(join(".planning", "e1", "sdd", "cool"))).toBe(true);
  });
});
```

- [ ] **Step 2: run the test — expect PASS (new test of existing behavior)**

```bash
( cd bun-apps/pi-agent-ext-superpowers && bun test tests/sdd-workspace.test.ts )
```
Expected: `3 pass` / `0 fail`.

- [ ] **Step 3: biome format (CI runs `bun run check` first — format fail = job fail)**

```bash
( cd bun-apps/pi-agent-ext-superpowers && bunx biome check --write tests/sdd-workspace.test.ts )
```

- [ ] **Step 4: full suite + the committed `bun run test` chain green**

```bash
( cd bun-apps/pi-agent-ext-superpowers && bun run test )
```
Expected: `check` (biome) → `build` (tsc) → `test:unit` (128 pass = 125 + 3 new), all green.

- [ ] **Step 5: commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/tests/sdd-workspace.test.ts
git commit -m "test(superpowers): golden-output coverage for sdd-workspace effort nesting"
```

---

### (Documented follow-up — NOT executed this plan) real-pi local-smoke probes

Per the 02 decision these are **local-smoke, on-demand, not CI-gated**. Next effort:

- **skill-exclude under real pi** — a `probe-runner` module asserting the advertised skill paths under real `resources_discover` with `PI_SUPERPOWERS_SKILL_EXCLUDE` set + the run-dir `--skill` splice suppressed (`-ns`). Confirms the unit-mocked behavior holds against real pi registration.
- **SDD fix-loop cross-round** — a `probe-runner` module exercising task-brief → implementer → report → re-review across rounds, asserting the report-file carries as cross-round memory (the resume→fresh-dispatch fallback). Rubric-scored.

### (Stretch, only if T1 done + time permits) determinism-spotcheck matrix

Add `pi-agent-ext-superpowers` + `pi-agent-ext-wayfind` to the `determinism-spotcheck` job's `matrix.include` (~line 493+). Same pattern as the existing hermes/workflow/obsidian entries — runs the suite 3× + flags cross-run pass/fail drift. Cheap once superpowers is in the main matrix (T1).
