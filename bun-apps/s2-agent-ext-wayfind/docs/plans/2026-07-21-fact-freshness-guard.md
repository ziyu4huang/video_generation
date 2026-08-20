# Fact-Freshness Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guard to `/wayfind` that warns (never blocks) when the working branch is behind `origin/<default>`, so a map's factual premise isn't silently baked in from a stale working tree.

**Architecture:** Hybrid. A new `src/freshness.ts` measures how far `HEAD` is behind `origin/<default>` (no network, graceful `null`) and turns it into a warning string via a pure function. `handleWayfinderChart` calls it at the top and injects the warning into both the chart and work-the-map steer messages + a UI notify. The `wayfinder` and `grilling` skills document the discipline (the manual-skill-load path the command doesn't reach).

**Tech Stack:** TypeScript (Bun workspace, `node:child_process` `spawnSync`), `bun:test`, Biome. Source runs under pi's jiti runtime → use `node:child_process` (not the `Bun` global) — matches `s2-agent-ext-movie-director/src/providers.ts`.

## Global Constraints

- **Runtime:** source must run under pi's jiti loader (Node-ish). Use `node:child_process` `spawnSync` for git — never the `Bun` global in `src/`.
- **Offline-safe:** NEVER call `git fetch`. Compare against the LOCAL `origin/<default>` ref only.
- **Graceful:** any git failure / missing repo / missing `origin/<default>` / missing git binary → `null`. Never throw, never block `/wayfind`.
- **No network, no env egress:** `--offline`-compatible.
- **Style:** Biome (`bun run check`). 2-space indent, double quotes, trailing commas.
- **Build gate:** `bunx tsc` (alias `bun run build`) must exit 0.
- **Branch:** work on the existing `feat/wayfind-fact-freshness-guard` (off `origin/main`). Conventional commits (`feat(wayfind):`, `test(wayfind):`, `docs(wayfind):`).
- **Design ref:** `bun-apps/s2-agent-ext-wayfind/docs/specs/2026-07-21-fact-freshness-guard-design.md`.

## File Structure

- **Create** `src/freshness.ts` — `FactFreshness` interface, `checkFactFreshness(cwd, opts?)`, `buildFreshnessWarning(f)`. One responsibility: measure + render branch staleness.
- **Create** `tests/freshness.test.ts` — unit tests: real temp-git fixtures (behind / current / no-origin / non-git) + injected-failing-spawn + `buildFreshnessWarning` pure cases.
- **Modify** `src/commands.ts` — import freshness; call it at the top of `handleWayfinderChart`; inject warning into both steer messages + `ctx.ui.notify`.
- **Modify** `tests/commands.test.ts` — add a `/wayfind — fact-freshness guard` describe block (MockPi + temp git repo; asserts warn-on-stale, silent-on-current, silent-on-non-git).
- **Modify** `skills/wayfinder/SKILL.md` — new "Fact freshness" section + step pointers in Chart & Work.
- **Modify** `skills/grilling/SKILL.md` — caveat on the two "environment for facts" rules (lines 14 & 24).

---

## Task 1: Freshness module + unit tests

**Files:**
- Create: `bun-apps/s2-agent-ext-wayfind/src/freshness.ts`
- Test: `bun-apps/s2-agent-ext-wayfind/tests/freshness.test.ts`

**Interfaces:**
- Produces: `checkFactFreshness(cwd: string, opts?: { spawnImpl?: SpawnImpl }): FactFreshness | null` and `buildFreshnessWarning(f: FactFreshness | null): string | null`, where `FactFreshness = { behind: number; base: string }`.

- [ ] **Step 1: Write the failing test file `tests/freshness.test.ts`**

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { buildFreshnessWarning, checkFactFreshness } from "../src/freshness.js";

const roots: string[] = [];

/** Make a temp dir, run `setup` to initialize it, track it for cleanup. */
function makeDir(setup: (cwd: string) => void): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-fresh-"));
  roots.push(cwd);
  setup(cwd);
  return cwd;
}

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

/** Run git in `cwd`; throw on failure so a broken fixture fails loud. */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Fixture: a repo where HEAD is exactly `behind` commits behind origin/main. */
function behindRepo(behind: number): string {
  return makeDir((cwd) => {
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.email", "t@t");
    git(cwd, "config", "user.name", "t");
    git(cwd, "commit", "--allow-empty", "-m", "base");
    for (let i = 0; i < behind; i++) git(cwd, "commit", "--allow-empty", "-m", `ahead-${i}`);
    // main now sits `behind` commits ahead of "base".
    git(cwd, "checkout", "-b", "feature", `HEAD~${behind}`);
    git(cwd, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
    git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  });
}

describe("checkFactFreshness", () => {
  it("reports the behind count + base when HEAD lags origin/main", () => {
    const f = checkFactFreshness(behindRepo(3));
    expect(f).not.toBeNull();
    expect(f?.behind).toBe(3);
    expect(f?.base).toBe("origin/main");
  });

  it("reports behind 0 when HEAD is current with origin/main", () => {
    const f = checkFactFreshness(behindRepo(0));
    expect(f?.behind).toBe(0);
    expect(f?.base).toBe("origin/main");
  });

  it("falls back to origin/main when origin/HEAD is unset but origin/main exists", () => {
    const cwd = makeDir((c) => {
      git(c, "init", "-b", "main");
      git(c, "config", "user.email", "t@t");
      git(c, "config", "user.name", "t");
      git(c, "commit", "--allow-empty", "-m", "x");
      git(c, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
      // deliberately no symbolic-ref for refs/remotes/origin/HEAD
    });
    const f = checkFactFreshness(cwd);
    expect(f?.base).toBe("origin/main");
    expect(f?.behind).toBe(0);
  });

  it("returns null when there is no origin ref (graceful)", () => {
    const cwd = makeDir((c) => {
      git(c, "init", "-b", "main");
      git(c, "config", "user.email", "t@t");
      git(c, "config", "user.name", "t");
      git(c, "commit", "--allow-empty", "-m", "x");
    });
    expect(checkFactFreshness(cwd)).toBeNull();
  });

  it("returns null in a non-git directory (graceful)", () => {
    expect(checkFactFreshness(makeDir(() => {}))).toBeNull();
  });

  it("returns null when spawn throws (git unavailable) — via injected spawn", () => {
    const failing = (): SpawnSyncReturns<string> => {
      throw new Error("ENOENT");
    };
    expect(checkFactFreshness(behindRepo(1), { spawnImpl: failing })).toBeNull();
  });
});

describe("buildFreshnessWarning", () => {
  it("returns null when current (behind 0)", () => {
    expect(buildFreshnessWarning({ behind: 0, base: "origin/main" })).toBeNull();
  });

  it("returns null when the check itself was null", () => {
    expect(buildFreshnessWarning(null)).toBeNull();
  });

  it("returns a warning naming the count and base when behind", () => {
    const w = buildFreshnessWarning({ behind: 5, base: "origin/main" });
    expect(w).not.toBeNull();
    expect(w).toContain("5");
    expect(w).toContain("origin/main");
    expect(w!.toLowerCase()).toContain("behind");
  });

  it("uses singular 'commit' when behind 1", () => {
    const w = buildFreshnessWarning({ behind: 1, base: "origin/main" });
    expect(w).toContain("1 commit ");
    expect(w).not.toContain("1 commits");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/s2-agent-ext-wayfind && bun test tests/freshness.test.ts )`
Expected: FAIL — `Cannot find module '../src/freshness.js'` (the module does not exist yet).

- [ ] **Step 3: Write the implementation `src/freshness.ts`**

```ts
/**
 * Fact-freshness guard for /wayfind.
 *
 * The grilling discipline gathers facts from the environment (the working tree),
 * but the working tree reflects the *current branch*, which may lag the line of
 * development (origin/<default>). Facts from a stale tree get baked into a map's
 * premise and only surface as wrong at commit time. checkFactFreshness() measures
 * how far HEAD is behind origin/<default> so /wayfind can warn up front.
 *
 * Design: docs/specs/2026-07-21-fact-freshness-guard-design.md
 *  - No network: compares against the LOCAL origin/<default> ref only.
 *  - Graceful: null when not a git repo, origin/<default> is absent, or git is
 *    unavailable — offline / non-git cwd never blocks wayfind.
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

export interface FactFreshness {
  /** Commits HEAD is behind the base (e.g. origin/<default>). 0 == current. */
  behind: number;
  /** The base ref compared against, e.g. "origin/<default>". */
  base: string;
}

type GitSpawnOpts = { cwd: string; encoding: "utf8" };
type SpawnImpl = (cmd: string, args: readonly string[], opts: GitSpawnOpts) => SpawnSyncReturns<string>;

const FALLBACK_BASE = "origin/main";

/** Default spawn — node:child_process. The `as` cast resolves the encoding
 *  overload union to the utf8 string variant. */
const defaultSpawn: SpawnImpl = (cmd, args, opts) => spawnSync(cmd, args, opts) as SpawnSyncReturns<string>;

/** Run git; return the result on exit 0, else null. Null also when spawn itself
 *  throws (git binary missing) — graceful. */
function gitOk(spawnImpl: SpawnImpl, cwd: string, args: readonly string[]): SpawnSyncReturns<string> | null {
  try {
    const r = spawnImpl("git", args, { cwd, encoding: "utf8" });
    return r.status === 0 ? r : null;
  } catch {
    return null;
  }
}

/** Resolve the line-of-development ref: origin/<default> via symbolic-ref,
 *  falling back to origin/main. Null when no usable ref exists. */
function resolveBase(spawnImpl: SpawnImpl, cwd: string): string | null {
  const sym = gitOk(spawnImpl, cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym) {
    const candidate = sym.stdout.trim();
    if (candidate && gitOk(spawnImpl, cwd, ["rev-parse", "--verify", "--quiet", candidate])) {
      return candidate;
    }
  }
  if (gitOk(spawnImpl, cwd, ["rev-parse", "--verify", "--quiet", FALLBACK_BASE])) {
    return FALLBACK_BASE;
  }
  return null;
}

/**
 * How far HEAD is behind the line of development (origin/<default>).
 *
 * No network: compares against the LOCAL origin/<default> ref. The caller
 * surfaces the ref's provenance ("per your last fetch") so a stale ref is
 * visible. Graceful: null when not a git repo, origin/<default> is absent, or
 * git is unavailable.
 *
 * @param opts.spawnImpl inject a spawn fake for tests; defaults to node:child_process.
 */
export function checkFactFreshness(cwd: string, opts: { spawnImpl?: SpawnImpl } = {}): FactFreshness | null {
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const base = resolveBase(spawnImpl, cwd);
  if (!base) return null;
  const count = gitOk(spawnImpl, cwd, ["rev-list", "--count", `HEAD..${base}`]);
  if (!count) return null;
  const behind = Number.parseInt(count.stdout.trim(), 10);
  return Number.isNaN(behind) ? null : { behind, base };
}

/**
 * Pure: turn the freshness check into a warning string, or null when current.
 * Extracted from the command layer so the message text is unit-testable without
 * a pi ExtensionCommandContext.
 */
export function buildFreshnessWarning(f: FactFreshness | null): string | null {
  if (!f || f.behind <= 0) return null;
  const commits = f.behind === 1 ? "commit" : "commits";
  return (
    `⚠️ Fact freshness: this branch is ${f.behind} ${commits} behind ${f.base} ` +
    `(per your last fetch). Facts gathered now may not reflect ${f.base} — ` +
    "rebase first, or proceed aware."
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/s2-agent-ext-wayfind && bun test tests/freshness.test.ts )`
Expected: PASS — all 10 cases green.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
( cd bun-apps/s2-agent-ext-wayfind && bun run check && bunx tsc )
git add bun-apps/s2-agent-ext-wayfind/src/freshness.ts bun-apps/s2-agent-ext-wayfind/tests/freshness.test.ts
git commit -m "feat(wayfind): add fact-freshness check (behind origin/<default>)

checkFactFreshness measures how far HEAD is behind origin/<default> (no
network, graceful null). buildFreshnessWarning renders it as a pure string.
See docs/specs/2026-07-21-fact-freshness-guard-design.md."
```

---

## Task 2: Wire the guard into `handleWayfinderChart`

**Files:**
- Modify: `bun-apps/s2-agent-ext-wayfind/src/commands.ts` (import + top of `handleWayfinderChart` + both steer messages)
- Test: `bun-apps/s2-agent-ext-wayfind/tests/commands.test.ts` (new describe block)

**Interfaces:**
- Consumes (from Task 1): `checkFactFreshness(cwd): FactFreshness | null`, `buildFreshnessWarning(f): string | null`.

- [ ] **Step 1: Add the failing wiring tests to `tests/commands.test.ts`**

Add this import near the other `node:` imports at the top of the file:

```ts
import { spawnSync } from "node:child_process";
```

Append this describe block at the end of the file:

```ts
// ─── /wayfind — fact-freshness guard (warns when HEAD lags origin/main) ──────
describe("/wayfind — fact-freshness guard", () => {
  function ctxCapturing(cwd: string): { ctx: any; notifications: string[] } {
    const notifications: string[] = [];
    return {
      notifications,
      ctx: {
        cwd,
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: (m: string) => notifications.push(m), setStatus: () => {} },
      },
    };
  }

  /** Initialize `cwd` as a git repo where HEAD is `behind` commits behind origin/main. */
  function gitBehind(cwd: string, behind: number): void {
    const g = (...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });
    g("init", "-b", "main");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    g("commit", "--allow-empty", "-m", "base");
    for (let i = 0; i < behind; i++) g("commit", "--allow-empty", "-m", `a${i}`);
    g("checkout", "-b", "feature", `HEAD~${behind}`);
    g("update-ref", "refs/remotes/origin/main", "refs/heads/main");
    g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  }

  it("warns (notify + steer) when charting on a branch behind origin/main", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    gitBehind(cwd, 4);
    const { ctx, notifications } = ctxCapturing(cwd);

    await pi.commands.get("wayfind")?.("some destination", ctx);

    expect(notifications.some((n) => n.includes("4") && n.includes("origin/main"))).toBe(true);
    expect(pi.sent.some((s) => s.includes("4") && s.includes("origin/main"))).toBe(true);
  });

  it("stays silent (no fact-freshness warning) on a current branch", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    gitBehind(cwd, 0);
    const { ctx, notifications } = ctxCapturing(cwd);

    await pi.commands.get("wayfind")?.("some destination", ctx);

    expect(notifications.every((n) => !n.includes("Fact freshness"))).toBe(true);
    expect(pi.sent.every((s) => !s.includes("Fact freshness"))).toBe(true);
  });

  it("stays silent in a non-git cwd (graceful)", async () => {
    const { pi } = setup();
    const { ctx, notifications } = ctxCapturing(makeCwd()); // plain temp dir, not a repo

    await pi.commands.get("wayfind")?.("some destination", ctx);

    expect(notifications.every((n) => !n.includes("Fact freshness"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/s2-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: FAIL — the "warns when charting ... behind" case fails (no warning is emitted yet: `notifications` and `pi.sent` don't contain `"4"` / `"origin/main"`).

- [ ] **Step 3: Wire the guard into `src/commands.ts`**

3a. Add the import. In the import block near the top of `commands.ts`, after the existing `./` relative imports (e.g. after the `./grill.js` import line), add:

```ts
import { buildFreshnessWarning, checkFactFreshness } from "./freshness.js";
```

3b. At the very top of `handleWayfinderChart` — immediately after the `const sessionId = getSessionId(ctx);` line — add the check + notify:

```ts
    const sessionId = getSessionId(ctx);
    const freshnessWarn = buildFreshnessWarning(checkFactFreshness(ctx.cwd));
    if (freshnessWarn) ctx.ui.notify(freshnessWarn, "warning");
```

3c. Inject the warning into the **work-the-map** steer message. Find this block:

```ts
      pi.sendUserMessage(
        [
          `Working wayfinder ticket ${claimed.id} "${claimed.title}" on effort ${effort}.`,
          `Load the \`wayfinder\` skill. Ticket type: ${claimed.type}.`,
          `Question: ${claimed.question}`,
          "Resolve it (one ticket this session): record the answer, then close the ticket + append to the map's Decisions so far. Graduate any newly-specifiable fog into fresh tickets.",
        ].join("\n"),
        { deliverAs: "steer" },
      );
```

Replace its array with one that appends the warning when present (only the closing of the array changes):

```ts
      pi.sendUserMessage(
        [
          `Working wayfinder ticket ${claimed.id} "${claimed.title}" on effort ${effort}.`,
          `Load the \`wayfinder\` skill. Ticket type: ${claimed.type}.`,
          `Question: ${claimed.question}`,
          "Resolve it (one ticket this session): record the answer, then close the ticket + append to the map's Decisions so far. Graduate any newly-specifiable fog into fresh tickets.",
          ...(freshnessWarn ? [freshnessWarn] : []),
        ].join("\n"),
        { deliverAs: "steer" },
      );
```

3d. Inject the warning into the **chart** steer message. Find this block:

```ts
    pi.sendUserMessage(
      [
        `Charting a wayfinder map for: ${destination}`,
        "Load the `wayfinder` skill (chart-the-map mode).",
        "1. Grill to pin the destination + scope. 2. Map the frontier breadth-first — surface open decisions + first takeable steps. 3. If no fog surfaces, the journey is small enough to skip the map (tell me). 4. Otherwise create tickets under .planning/" +
          effort +
          "/tickets/ (one file each, wired with blocking edges).",
      ].join("\n"),
      { deliverAs: "steer" },
    );
```

Replace its array with:

```ts
    pi.sendUserMessage(
      [
        `Charting a wayfinder map for: ${destination}`,
        "Load the `wayfinder` skill (chart-the-map mode).",
        "1. Grill to pin the destination + scope. 2. Map the frontier breadth-first — surface open decisions + first takeable steps. 3. If no fog surfaces, the journey is small enough to skip the map (tell me). 4. Otherwise create tickets under .planning/" +
          effort +
          "/tickets/ (one file each, wired with blocking edges).",
        ...(freshnessWarn ? [freshnessWarn] : []),
      ].join("\n"),
      { deliverAs: "steer" },
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/s2-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: PASS — all three new cases green, and the existing command tests still green.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
( cd bun-apps/s2-agent-ext-wayfind && bun run check && bunx tsc )
git add bun-apps/s2-agent-ext-wayfind/src/commands.ts bun-apps/s2-agent-ext-wayfind/tests/commands.test.ts
git commit -m "feat(wayfind): warn on stale branch at /wayfind start

handleWayfinderChart checks fact freshness at the top (covers both chart
and work-the-map) and injects the warning into both steer messages + a UI
notify. Silent when current or non-git. See docs/specs/...-design.md."
```

---

## Task 3: Prose discipline (wayfinder + grilling skills) + final gate

**Files:**
- Modify: `bun-apps/s2-agent-ext-wayfind/skills/wayfinder/SKILL.md`
- Modify: `bun-apps/s2-agent-ext-wayfind/skills/grilling/SKILL.md`

**Interfaces:** none (documentation). `tests/skills.test.ts` is structural (frontmatter `name`/`description`/H1, ≤1024-char frontmatter) — the edits must keep the frontmatter valid and a top-level H1; no new assertion is added (a content-grep would be inconsistent with the suite's structural-only design).

- [ ] **Step 1: Add a "Fact freshness" section + step pointers to `skills/wayfinder/SKILL.md`**

1a. Add a new conceptual section. Immediately **after** the `## Refer by name` section (before `## The Map`), insert:

```markdown
## Fact freshness

The working tree reflects the *current branch*, which may lag the line of development (`origin/<default>`). A map built on facts gathered from a stale tree rests on a false premise — wasted work that only surfaces at commit time. The `/wayfind` command checks this at start and warns when the branch is behind; heed it: warn the human and prefer rebasing before charting. If you reach this skill without the command, run `git rev-list --count HEAD..origin/<default>` yourself — if the count is non-zero, flag it before gathering facts.
```

1b. In the **Chart the map** ordered list, add a step before the current step 1. Change:

```markdown
1. **Name the destination.** Run a `grilling` and `domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
```

to:

```markdown
1. **Confirm fact freshness.** If the `/wayfind` command warned the branch is behind `origin/<default>`, tell the human and prefer rebasing first — see **Fact freshness** above. A map charted on a stale premise is wasted work.
2. **Name the destination.** Run a `grilling` and `domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
```

(Increment the numbers of the following Chart steps accordingly: the old 2→3, 3→4, 4→5, 5→6, 6→7.)

1c. In **Work through the map**, step 1, append a freshness clause. Change:

```markdown
1. **Load the **map** — the low-res view, not every ticket body.
```

to:

```markdown
1. **Load the **map** — the low-res view, not every ticket body. If the `/wayfind` command warned the branch is behind `origin/<default>`, flag it before resolving — see **Fact freshness**.
```

- [ ] **Step 2: Add a freshness caveat to `skills/grilling/SKILL.md`**

2a. Find line 14:

```markdown
 If a *fact* can be found by exploring the environment (filesystem, tools, code, docs), **look it up rather than asking**. Read the file, grep the codebase, check the config — do not make the user transcribe what the repo already states.
```

Append a second sentence so it reads:

```markdown
 If a *fact* can be found by exploring the environment (filesystem, tools, code, docs), **look it up rather than asking**. Read the file, grep the codebase, check the config — do not make the user transcribe what the repo already states. But the environment reflects the *current branch*, which may lag the line of development — before treating gathered facts as ground truth for a decision, confirm the branch is current (`/wayfind` checks this; otherwise `git rev-list --count HEAD..origin/<default>`); if behind, say so and prefer rebasing.
```

2b. Find line 24:

```markdown
 - **Reach for the environment for facts.** A question whose answer lives in the codebase is a research task, not a grill question.
```

Change to:

```markdown
 - **Reach for the environment for facts — but confirm it's current.** A question whose answer lives in the codebase is a research task, not a grill question. The codebase you grep reflects the current branch; if it lags the line of development, say so before trusting what you find.
```

- [ ] **Step 3: Verify the structural skill test still passes**

Run: `( cd bun-apps/s2-agent-ext-wayfind && bun test tests/skills.test.ts )`
Expected: PASS — frontmatter still valid (`name`, `description` starting with "Use when", ≤1024 chars), top-level H1 still present for both edited skills. (If it fails on description length, the edit touched frontmatter by mistake — re-check; the edits above are body-only.)

- [ ] **Step 4: Full gate — check + typecheck + entire unit suite**

Run: `( cd bun-apps/s2-agent-ext-wayfind && bun run check && bunx tsc && bun test )`
Expected: PASS — Biome clean, `tsc` exit 0, all tests green (freshness + commands + skills + the rest).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-wayfind/skills/wayfinder/SKILL.md bun-apps/s2-agent-ext-wayfind/skills/grilling/SKILL.md
git commit -m "docs(wayfind): document fact-freshness discipline in skills

wayfinder gains a 'Fact freshness' section + step pointers (chart & work);
grilling's 'facts from environment' rules gain a staleness caveat. Covers
the manual-skill-load path the command guard doesn't reach."
```

- [ ] **Step 6: Manual smoke (record results; no commit unless a fix is needed)**

On a throwaway branch behind `origin/main`:
```bash
git switch -c smoke/freshness origin/main
git commit --allow-empty -m x            # HEAD now 0 ahead, but to simulate BEHIND:
git switch -c smoke/behind origin/main~0 # (see note)
```
Simpler reliable smoke: in the actual repo, note `git rev-list --count HEAD..origin/main`. Then in a running pi session run `/wayfind smoke-test-destination` and confirm:
- If the count is **> 0**: a ⚠️ line appears in the UI notify **and** in the agent's priming steer, naming the count + `origin/main`.
- If the count is **0**: no fact-freshness line appears.

(If a clean current branch is desired for the 0-case, `git switch main` first.) Delete the smoke branch with `git switch - && git branch -D smoke/freshness smoke/behind` (or whatever was created). If the smoke reveals a bug, return to the relevant task's RED step.

---

## Self-Review (run after writing, before handoff)

**1. Spec coverage** — every spec section maps to a task:
- Code component `src/freshness.ts` (`checkFactFreshness`, `buildFreshnessWarning`) → Task 1.
- Wiring in `handleWayfinderChart` (both paths + notify) → Task 2.
- Prose: `wayfinder` (section + Chart + Work) and `grilling` (two rule caveats) → Task 3.
- Edge cases (non-git, no-origin, git-missing, behind=0, ahead+behind→report behind, no-fetch) → Task 1 tests + `buildFreshnessWarning` null cases.
- Testing section (freshness unit, wiring via MockPi, structural skill pass, manual smoke) → Tasks 1/2/3.
- Decisions (locus=wayfind, baseline=origin/<default>, trigger=/wayfind start, stance=warn, form=hybrid, no-fetch) → encoded across all three tasks.
- Open question (ADR-0004) → deliberately deferred; not required for the feature.

**2. Placeholder scan** — no TBD/TODO/"add error handling"/"similar to". Every code step shows complete code; every edit shows the exact old→new text.

**3. Type consistency** — `FactFreshness = { behind: number; base: string }` defined in Task 1, consumed identically in Task 2 (`checkFactFreshness(ctx.cwd)` → `buildFreshnessWarning(...)`). `SpawnImpl`/`SpawnSyncReturns<string>` imported from `node:child_process` in both `src/freshness.ts` and the two test files. `ctx.ui.notify(msg, level)` matches the existing `"info"`/`"warning"` usage in `commands.ts`.

No gaps found.
