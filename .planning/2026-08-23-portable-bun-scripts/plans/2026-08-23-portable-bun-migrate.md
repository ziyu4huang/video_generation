# Portable Bun Scripts Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every skill-facing bash script in `bun-apps/s2-agent-ext-*` (skill-embedded tools + 13× `run-test.sh` + `ci-local.sh`) to a portable Bun script, A/B-proven against the old bash implementation and pinned by committed golden-parity tests.

**Architecture:** One shared parity harness (`bun-apps/tests/helpers/bash-parity.ts`) gives every conversion the same A/B protocol: capture normalized stdout + exit codes from the old `.sh`, require a byte-match from the new `.ts`, and commit those expectations as a permanent test. Each conversion is a same-directory twin; the old `.sh` is deleted only after the parity gate is green. Wave 1 (Tasks 2–7) = skill-embedded tools; Wave 2 (Tasks 8–11) = tier launchers + rename-everywhere call sites; Task 12 seals the gate with a guard test.

**Tech Stack:** Bun (scripts are `bun run`-able `.ts` at repo root; zero new deps; `bun:sqlite` for the dedup DB); existing `bun test` per package; devops chain for all PRs.

## Global Constraints

- Run everything from repo root; never top-level `cd`; Python never involved. Bun IS the runtime (this repo is Bun-first).
- Every converted script keeps: same flags & argv shape, same stdout shape **including ANSI colors**, same exit codes (0 pass / 1 failure / 2 usage), same relative-path semantics (paths resolve from the script's directory or repo root exactly as the old bash did).
- Goldens are normalized only for: ANSI codes (`\x1b[…m`), elapsed `(Ns)` timings, `/tmp/*-runtest.log` paths, and inline package names. Nothing else is ever normalized — a diff after normalization means an actual regression.
- Old `.sh` deleted ONLY after: (a) transient A/B diff against the live old script is empty, (b) the committed parity test passes. Never commit a `.sh` and `.ts` twin together.
- SKILL.md frontmatter `description:` strings are single-line YAML — when editing them, keep them one line, quotes allowed (the list-ext-skills.ts parser handles quoted + block scalars).
- Each task ends with: canonical `bun run test` of touched packages + tsc/check gate via the package's canonical script, then a devops-chain PR (prepare-feature-branch-cli → local-ci-cli → merge-pr-after-ci-cli → verify-merge-cli).
- Per CLAUDE.md: watchdog OFF for write-heavy dispatch; the independent reviewer subagent is the real quality gate.

---

### Task 1: Shared golden-parity harness

**Files:**
- Create: `bun-apps/tests/helpers/bash-parity.ts`
- Test: `bun-apps/tests/helpers/bash-parity.test.ts`

**Interfaces:**
- Consumes: nothing (standalone).
- Produces:
  - `stripAnsi(s: string): string`
  - `normalizeRunOutput(s: string, pkgName?: string): string` — strips ANSI, `\((\d+(\.\d+)?)s\)` elapsed, `/tmp/[\w-]+-runtest\.log` → `/tmp/<log>`, and the literal `pkgName` string (so the same launcher body normalizes across the 12 per-package copies).
  - `runScript(runner: "bun" | "bash", scriptPath: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): { stdout: string; stderr: string; code: number }` — spawns `<runner> <scriptPath> …`; throws on nonzero exit **of the spawn itself** only (spawn failure, e.g. ENOENT), never on the child's exit code. (Adjudicated 2026-08-23: the brief's prose said 2-arg `scriptPath, args, opts` — a stale remnant; the Step-3 code, Step-1 test and `assertParity`'s internal call all agree on runner-first, which is the binding contract.)
  - `GoldenCase = { name: string; args: string[]; cwd?: string; env?: Record<string, string>; expectCode?: number; out?: string; outIs?: "exact" | "normalized"; pkgName?: string; errIncludes?: string[] }` — `c.pkgName` is passed to `normalizeRunOutput` when `outIs === "normalized"` (inline package-name substitution, needed by Task 9's 12-package goldens); `errIncludes` matches the RAW unnormalized stderr (stdout is the only normalized channel).
  - `assertParity(newScriptPath: string, cases: GoldenCase[]): void` — runs each case against `bun newScriptPath`, normalizes per `outIs`, asserts `code` (default 0) and stdout golden; asserts `stderr` contains each `errIncludes` entry. (Adjudicated 2026-08-23: the earlier `scriptArgs`/`args` second parameter was dead code — each case carries its own `args` — and unreachable `pkgName`; both fixed in the contract before Tasks 2–12 consume it.)

- [ ] **Step 1: Write the failing tests for the normalizer + runner**

```ts
// bun-apps/tests/helpers/bash-parity.test.ts
import { describe, expect, test } from "bun:test";
import { normalizeRunOutput, stripAnsi, runScript } from "./bash-parity";

describe("normalizeRunOutput", () => {
  test("strips ANSI, elapsed timings, tmp log paths, and package name", () => {
    const in_ = "\x1b[32m✓ quick  \x1b[2m(12s)\x1b[0m\x1b[33m▶ s2-agent-ext-btw run-test.sh — tier=quick\x1b[0m";
    const out = normalizeRunOutput(in_, "s2-agent-ext-btw");
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("✓ quick");
    expect(out).not.toContain("(12s)");
    expect(out).toContain("tier=quick");
  });
  test("normalizes /tmp logs", () => {
    expect(normalizeRunOutput("log: /tmp/s2-agent-ext-btw-runtest.log")).toContain("/tmp/<log>");
  });
  test("stripAnsi only strips the escape", () => {
    expect(stripAnsi("a\x1b[31mb\x1b[0mc")).toBe("abc");
  });
});

describe("runScript", () => {
  test("returns child stdout/stderr/code; child exit 1 is not a throw", () => {
    const r = runScript("bun", "-e", ["console.error('boom'); process.exit(1)"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("boom");
  });
});

describe("assertParity", () => {
  test("normalized happy path passes; exit/stdout mismatch throw; errIncludes on raw stderr; pkgName substituted", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-ab-"));
    const script = join(dir, "probe.ts");
    // ANSI + elapsed + inline pkg name on stdout; "boom" on stderr; exit 1
    writeFileSync(script, `console.log("\\x1b[32m✓ s2-agent-ext-btw  \\x1b[2m(12s)\\x1b[0m"); console.error("boom"); process.exit(1);`);
    assertParity(script, [
      { name: "pass", args: [], expectCode: 1, out: "✓ <pkg>  (Ns)", outIs: "normalized", pkgName: "s2-agent-ext-btw", errIncludes: ["boom"] },
    ]);
    expect(() => assertParity(script, [{ name: "x", args: [], expectCode: 0 }])).toThrow(/expected exit 0, got 1/);
    expect(() => assertParity(script, [{ name: "x", args: [], expectCode: 1, out: "nope" }])).toThrow(/stdout mismatch/);
  });
});
```

- [ ] **Step 2: Run — verify it fails (module missing)**

Run: `bun test bun-apps/tests/helpers/bash-parity.test.ts`
Expected: FAIL — `Cannot find module "./bash-parity"`.

- [ ] **Step 3: Implement the harness**

```ts
// bun-apps/tests/helpers/bash-parity.ts
import { spawnSync } from "node:child_process";

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[\d;]*m/g, "");
}

export function normalizeRunOutput(s: string, pkgName?: string): string {
  let out = stripAnsi(s);
  out = out.replace(/\(\d+(\.\d+)?s\)/g, "(Ns)");           // elapsed timings
  out = out.replace(/\/tmp\/[\w-]+-runtest\.log/g, "/tmp/<log>");
  if (pkgName) out = out.split(pkgName).join("<pkg>");       // inline package name
  return out;
}

export function runScript(
  runner: "bun" | "bash",
  scriptPath: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(runner, [scriptPath, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
  if (r.error) throw r.error; // spawn failure only — never a child's exit code
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

export type GoldenCase = {
  name: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  expectCode?: number;
  out?: string;
  outIs?: "exact" | "normalized";
  pkgName?: string; // substituted in normal-mode stdout via normalizeRunOutput
  errIncludes?: string[]; // raw stderr (unnormalized)
};

export function assertParity(newScriptPath: string, cases: GoldenCase[]): void {
  for (const c of cases) {
    const r = runScript("bun", newScriptPath, c.args, { cwd: c.cwd, env: c.env });
    const code = r.code;
    if (code !== (c.expectCode ?? 0)) {
      throw new Error(`${c.name}: expected exit ${c.expectCode ?? 0}, got ${code}\nstderr: ${r.stderr}`);
    }
    if (c.out !== undefined) {
      const got = c.outIs === "normalized" ? normalizeRunOutput(r.stdout, c.pkgName) : r.stdout;
      if (got.trim() !== c.out.trim()) {
        throw new Error(`${c.name}: stdout mismatch\n--- expected ---\n${c.out}\n--- got ---\n${got}`);
      }
    }
    for (const e of c.errIncludes ?? []) {
      if (!r.stderr.includes(e)) throw new Error(`${c.name}: stderr missing ${JSON.stringify(e)}`);
    }
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test bun-apps/tests/helpers/bash-parity.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/tests/helpers/bash-parity.ts bun-apps/tests/helpers/bash-parity.test.ts
git commit -m "test(helpers): golden-parity harness for bash→bun migrations"
```

---

### Task 2: dedup.sh → dedup.ts (tracer — hardest case first)

**Files:**
- Create: `bun-apps/s2-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/dedup.ts`
- Test: `bun-apps/s2-agent-ext-hermes-memory/tests/dedup-parity.test.ts`
- Modify: `bun-apps/s2-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md` (body refs, `DEDUP=…` path, usage line, Pitfalls) + frontmatter `description:` ("Ships with dedup.sh" → "Ships with dedup.ts")
- Delete (on green): `…/pi-memory-bulk-dedup/dedup.sh`

**Interfaces:**
- Consumes: Task 1 `assertParity`, `normalizeRunOutput`.
- Produces: `bun <pkg>/skills/pi-memory-bulk-dedup/dedup.ts <flags>` — same full flag set as the old script: `--target {failure|memory|user}`, `--db <path>`, `--commit`, `--prune-stubs`, `--keep-backups N`, `--prefix-len N` (default 80), `--stub-maxlen N` (default 120), `--help`. Exit 0 pass / 1 failure / 2 usage. DB access via `bun:sqlite` (D5); `.md` trim logic REUSED VERBATIM from dedup.sh (the §-delimiter filter — copy the escaping/parsing code, do not redesign).
- Contract check: old `dedup.sh` uses the `sqlite3` CLI; the parity is on **stdout + exit codes**, so `bun:sqlite` internals are free to differ.

- [ ] **Step 1: Capture goldens (old .sh alive)**

Run the OLD script against a fixture and save expectations:

```bash
mkdir -p /tmp/dedup-fixture && cd /tmp/dedup-fixture
# crafted .md (per-target) with §-entries, plus a small sqlite DB with candidate rows —
# build via the same SQL the old script uses (see its DBS=…/sqlite3 calls) or seed via
# python/venv/bin/python sqlite3 module; MUST be non-destructive: always --db <fixture copy>.
bash bun-apps/s2-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/dedup.sh --help            # → exit 0
bash …/dedup.sh --target failure --db /tmp/dedup-fixture/db.sqlite --dry-run                    # → exit 0, BEFORE→AFTER counts
bash …/dedup.sh --target failure --db /tmp/dedup-fixture/db.sqlite --commit --keep-backups 1    # → exit 0, on a COPY
bash …/dedup.sh --target bogus-name --db /tmp/dedup-fixture/db.sqlite --dry-run                 # → exit 2, usage error
```

Record each `(args → stdout, code)`, normalize (only if the output contains timings/paths that vary across runs — otherwise byte-exact), and paste the four cases into the test below. The `--commit` case must be run against **copies** of the fixture each time (destructive by design).

- [ ] **Step 2: Write the failing parity test**

```ts
// bun-apps/s2-agent-ext-hermes-memory/tests/dedup-parity.test.ts
// captured 2026-08-23 from dedup.sh@<sha before deletion> — normalize = none (output is static)
import { test, expect } from "bun:test";
import { assertParity } from "../../../tests/helpers/bash-parity"; // bun-apps/tests/helpers
import { mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEDUP = "skills/pi-memory-bulk-dedup/dedup.ts";

function fixture(): { dir: string; md: string; db: string } { /* create tmp prefix.memory.md with §-entries + seed db.sqlite from the capture script; return paths */ }

test("dedup.ts help", () => {
  assertParity(DEDUP, [{ name: "help", args: ["--help"], expectCode: 0, out: HELP_GOLDEN }]);
});
test("dedup.ts dry-run BEFORE→AFTER", () => { … out: DRYRUN_GOLDEN … });
test("dedup.ts commit on a copy", () => { … out: COMMIT_GOLDEN … });
test("dedup.ts bogus target exits 2", () => {
  assertParity(DEDUP, [
    { name: "usage-error", args: ["--target","bogus-name","--db","/tmp/x.sqlite","--dry-run"], expectCode: 2, errIncludes: ["usage"] },
  ]);
});
```

- [ ] **Step 3: Run — verify fail** (`bun test bun-apps/s2-agent-ext-hermes-memory/tests/dedup-parity.test.ts` → FAIL: no dedup.ts)

- [ ] **Step 4: Implement dedup.ts**

Port flag parsing, `.md` §-filter, DB detection (bun:sqlite), dry-run/commit/prune-stubs/keep-backups semantics, and ALL stdout lines from dedup.sh — line-for-line identical strings. Reuse the log-line format `i=` counters and the `BEFORE→AFTER` summary verbatim.

- [ ] **Step 5: Transient A/B — byte-diff both implementations**

```bash
mkdir /tmp/ab && cp -R /tmp/dedup-fixture /tmp/ab && {
  bash …/dedup.sh --target failure --db /tmp/ab/db.sqlite --dry-run > /tmp/ab/old.txt; echo "code=$?" >> /tmp/ab/old.txt
} 
# same for new: bun …/dedup.ts … > /tmp/ab/new.txt
diff /tmp/ab/old.txt /tmp/ab/new.txt   # MUST be empty (minus any elapsed-timing lines, normalized)
```

- [ ] **Step 6: Run parity test — pass; delete dedup.sh**

```bash
bun test bun-apps/s2-agent-ext-hermes-memory/tests/dedup-parity.test.ts   # PASS
rm bun-apps/s2-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/dedup.sh
```

- [ ] **Step 7: Update the SKILL.md**

All occurrences `dedup.sh` → `dedup.ts`; the `DEDUP=…` var line; `bash dedup.sh --help` → `bun …/dedup.ts --help`; write the new description line: `Ships with dedup.ts; dry-run + backup + FTS verify before any destructive apply.`

- [ ] **Step 8: Gates + commit**

```bash
bun run --cwd bun-apps/s2-agent-ext-hermes-memory test   # canonical + tsc if part of it
git add -A bun-apps/s2-agent-ext-hermes-memory
git commit -m "feat(hermes-memory): dedup.ts — portable bun twin of dedup.sh (golden parity pinned)"
```

---

### Task 3: smoke.sh → smoke.ts (power-tool / playwright-cli)

**Files:**
- Create: `bun-apps/s2-agent-ext-power-tool/skills/playwright-cli/scripts/smoke.ts`
- Test: `bun-apps/s2-agent-ext-power-tool/tests/smoke-parity.test.ts`
- Modify: `skills/playwright-cli/SKILL.md` (`bash skills/playwright-cli/scripts/smoke.sh` → `bun …/smoke.ts`)
- Delete (on green): `scripts/smoke.sh`

**Notes (from the old script, read 2026-08-23):** the smoke has NO flags. It must keep using `bunx playwright-cli` (NEVER `npx` — the exact npm collision guard) and print the two `ok:` lines + `playwright-cli skill smoke: PASS`; fail paths print `FAIL: …`, exit 1. Pinned version read from `node_modules/@playwright/cli/package.json`.

- [ ] **Step 1: Capture goldens** — run old script in the power-tool package root: stdout = the 3 lines, exit 0. Record.
- [ ] **Step 2: Write failing test** — `assertParity("skills/playwright-cli/scripts/smoke.ts", [{name:"smoke", args:[], cwd:"power-tool-root", expectCode:0, out:SMOKE_GOLDEN}])`; skip-if-deps-absent guard: `if (!existsSync("node_modules/@playwright/cli/package.json")) { test.skip }` — mirrors the old `|| fail "…run 'bun install'"`.
- [ ] **Step 3: run — fail**; **Step 4: implement smoke.ts** (spawn `bunx playwright-cli --version` + `bunx playwright-cli list`; read pinned semver; same outputs/fail messages).
- [ ] **Step 5: transient A/B diff** (run both scripts in power-tool root, diff = empty).
- [ ] **Step 6: parity green → delete smoke.sh; Step 7: SKILL.md ref; Step 8: canonical gates + commit.**

---

### Task 4: find-polluter.sh → find-polluter.ts (systematic-debugging)

**Files:**
- Create: `bun-apps/s2-agent-ext-superpowers/skills/systematic-debugging/find-polluter.ts`
- Test: `bun-apps/s2-agent-ext-superpowers/tests/find-polluter-parity.test.ts`
- Modify: `skills/systematic-debugging/SKILL.md` mentions (`./find-polluter.sh` → `bun …/find-polluter.ts`)
- Delete (on green): `find-polluter.sh`

**Notes (old script, 63 lines):** `set -e`; wrong-arg-count → **exit 1** with two usage lines (`Usage: …`, `Example: …`) to stderr. Success-with-pre-existing-pollution path (chosen as the hermetic fixture): CWD contains `$POLLUTION_CHECK` → prints `⚠️  Pollution already exists before test 1/N` …skip lines, ends `✅ No polluter found - all tests clean!`, exit 0, and never runs `npm test`. Keep `npm test` in the bisection loop verbatim (behavior contract), but in the Fibonacci… no — functional loop unchanged; only stdout/exit test on the two hermetic cases.

- [ ] **Step 1: Capture goldens**: (a) no args → exit 1, stderr `Usage: `; (b) in a tmp dir with a sentinel file `.POLLUTER` (empty): `bunx`-free run with args `.POLLUTER "src/**/*.test.ts"` → exit 0, stdout contains `⚠️  Pollution already exists before test 1/1` + `✅ No polluter found`.
- [ ] **Step 2: failing parity test** (both cases via `assertParity`, exit codes + `outIs:"normalized"` if emoji widths differ? No — keep byte-exact; use `cwd: <tmpdir>` via a `beforeAll` fixture).
- [ ] **Step 3–6:** implement (TS with `node:child_process` + fs), A/B diff, delete `.sh`.
- [ ] **Step 7: SKILL.md refs; Step 8: gates + commit.**

---

### Task 5: hitl-loop.template.sh → hitl-loop.template.ts (template — structural golden)

**Files:**
- Create: `bun-apps/s2-agent-ext-superpowers/skills/systematic-debugging/scripts/hitl-loop.template.ts`
- Test: `bun-apps/s2-agent-ext-superpowers/tests/hitl-loop-template.test.ts`
- Modify: `SKILL.md:269` (the template reference; keep the `scripts/hitl-loop.template.` prefix — template is copied, never executed)
- Delete (on green): `scripts/hitl-loop.template.sh`

**Notes:** the template is a COPY source for the human-in-the-loop loop scaffold. Convert each library helper (`stage`, `say`/`step`, `open_url`, `ask`/`ask_secret`, `write_env`, `set_secret`/`set_var`, `pause`/`confirm`) to its Bun equivalent; keep `STAGES` markers and the identical stage shape; the emitted artifact becomes `bun hitl-loop.ts`-runnable with the same stage semantics. Golden = structural: the template file contains `STAGES`, `stage(`, `ask_secret`, `open_url`, `exit` on failure — asserted by reading the file (no execution).

- [ ] **Step 1: failing structural test** (asserts markers present in template.ts — fails while the file doesn't exist).
- [ ] **Step 2: implement template.ts**, porting each helper 1:1 from the old template (ASCII quotes/`Number`/`spawnSync` accordingly).
- [ ] **Step 3: test passes; Step 4: delete .sh; Step 5: SKILL.md ref; Step 6: gates + commit.**

---

### Task 6: update-superpowers.sh → update-superpowers.ts

**Files:**
- Create: `bun-apps/s2-agent-ext-superpowers/scripts/update-superpowers.ts`
- Test: `bun-apps/s2-agent-ext-superpowers/tests/update-superpowers.test.ts`
- Delete (on green): `scripts/update-superpowers.sh`
- (No SKILL.md references it; `s2-agent/update-pi.sh` is unrelated and deferred.)

**Notes (40 lines):** `CLAUDE_PLUGINS_CACHE` env (default `$HOME/.claude-glm/plugins/cache/claude-plugins-official/superpowers`), optional `[version]`, else newest by `sort -V`; missing cache → stderr + exit 1; missing version dir → stderr + exit 1; then `rm -rf skills` + `cp -R`. A/B fixture must NOT touch the real package dir: copy the package to a tmp root, point the .ts at it via a `--pkg-root` (new, or reuse CWD: the script resolves `PKG` relative to itself — in the test, run the .ts from a copy via `cwd`? The script resolves its own dir → instead: test runs `update-superpowers.ts` with `cwd=<tmp copy of pkg>` and a `CLAUDE_PLUGINS_CACHE=<tmp cache with v1.0.0/v2.0.0>`; assert resulting `skills/` tree **equals** the cache's `v2.0.0/skills` and prints the sync banner + diff hint. Semver sort: implement `sort -V` equivalent (split dots, numeric compare; suffix compare) in TS.

- [ ] **Step 1: failing test** (tmp cache fixture + tmp pkg copy; expect skills/ tree == v2.0.0's; stderr clean; and the `[version]` explicit-flag path == cache's v1.0.0).
- [ ] **Step 2: implement update-superpowers.ts** (readdir + semver-sort; `fs.rmSync` + `cpSync`; same stdout lines).
- [ ] **Step 3: transient A/B** — run old `.sh` and new `.ts` against two identical tmp pkg copies; diff the two resulting `skills/` trees (`diff -r`) = empty.
- [ ] **Step 4: delete .sh; Step 5: gates + commit.**

---

### Task 7: smoke-e2e.sh → smoke-e2e.ts (ultracode sample)

**Files:**
- Create: `bun-apps/s2-agent-ext-ultracode/samples/smoke-e2e.ts`
- Test: `bun-apps/s2-agent-ext-ultracode/tests/smoke-e2e-contract.test.ts`
- Modify: the file header comment only (no SKILL.md reference exists)
- Delete (on green): `samples/smoke-e2e.sh`

**Notes (48 lines):** happy path = live LM Studio model call (`exec bun …cli.ts -e ultracode --model … -p "…strict prompt…"`) — equivalent to run-test's `smoke` tier: **never asserted in CI** (skipped when LM Studio down). Contract cases only: missing workflow file → stderr `workflow file not found: <path>` + **exit 2**; default `PI_MODEL=google/gemma-4-12b` override preserved. Note the old script `exec`s the CLI (replaces the process) — the .ts should keep the same one-shot semantics via `process.exit(spawnSync(cli,…).status)`.

- [ ] **Step 1: failing contract test** (exit 2 case + default model grep in the built prompt).
- [ ] **Step 2: implement smoke-e2e.ts** (same strict-prompt construction — the `WF_SCRIPT` relay text verbatim).
- [ ] **Step 3: A/B diff the contract cases; Step 4: delete .sh; Step 5: gates + commit.**

---

### Task 8: devops scripts/run-test.sh → run-test.ts + tier parity test

**Files:**
- Create: `bun-apps/s2-agent-ext-devops/scripts/run-test.ts`
- Test: `bun-apps/s2-agent-ext-devops/tests/run-test-parity.test.ts`
- Delete (on green): `scripts/run-test.sh`
- (Call-site renames are Task 11 — NOT here. Keeping this task purely port-green means the deploy probe still finds the old name until Task 11 lands; do both in sequence within the same PR.)

**Notes (from the ~250-line original, read verbatim):** tiers `quick|medium|smoke|full` (+ numeric aliases 0–3), `--effort=`, `--effort <v>`, `-l|--list`, `--list-siblings`, unknown args forwarded to `bun test`, unknown effort → exit 2, `SIBLING_PKGS=(s2-agent-ext-obsidian s2-agent-ext-knowledge-card s2-agent-ext-file2md)` printed one-per-line by `--list-siblings`, `step()` prints `✓ <name>  (Ns)` / `✗ <name>  (Ns)` (ANSI colored), per-run log `/tmp/s2-agent-runtest.log`, exit 0 iff every selected step passed. Colors and the exact `print_list` block are part of the contract (verify-tool parses the summary; the guard test consumes `--list-siblings`).

- [ ] **Step 1: Capture goldens**: `--list` (normalized: ANSI + (Ns) + `/tmp` — NOTE: `--list` output is static, exact), `--list-siblings` (byte-exact, 3 lines), `unknown-effort` (exit 2 + stderr `error: unknown effort 'x'`), and `--effort=medium --bail` forwarding sanity (normalized summary lines — run live, capture the tail).
- [ ] **Step 2: failing parity test** — the three static cases via `assertParity`; plus a `quick`-tier live case kiosk gated: `if (process.env.SKIP_SLOW) test.skip` with a comment that the CI run of `bun run --cwd bun-apps/s2-agent-ext-devops test` is NOT the tier runner. Expect: golden `✓ effort=quick passed` path normalized.
- [ ] **Step 3: implement run-test.ts** — port: arg parser (`--effort=`, `--effort`, `-l|--list`, tier words, `--list-siblings`, extras), tier dispatch, `step()` with the SAME colors/lines, `SIBLING_PKGS` + per-pkg `bun run test` (canonical), `run.sh`-based smoke tier (LM Studio curl + grep model), `/tmp/s2-agent-runtest.log`, exit 0/1/2. Use `spawnSync`/`spawn` with `stdio: "pipe"` writing the log; keep `PI_AGENT_E2E` env semantics untouched.
- [ ] **Step 4: transient A/B** — capture old & new outputs for `--list`, `--list-siblings`, unknown-effort, and ONE live `quick` run: `diff <(normalized-old) <(normalized-new)` = empty.
- [ ] **Step 5: parity green → delete run-test.sh; Step 6: gates (devops canonical test + tsc) + commit.**

---

### Task 9: the 12 per-package run-test.sh → run-test.ts

**Files:**
- Create: `bun-apps/<pkg>/run-test.ts` × 12 (btw, file2md, flux2, hermes-memory, knowledge-card, krea2, ltx, movie-director, obsidian, power-tool, research-tool, task)
- Test: `bun-apps/tests/run-test-launchers-parity.test.ts` (scans all 12; goldens under `bun-apps/tests/goldens/run-test-<pkg>.list` captured in Step 1)
- Delete (on green): the 12 `run-test.sh`

**Notes:** structure (read `s2-agent-ext-btw` + the devops one): identical `step()`/colors/flags (`-l|--list`, tier words, extras); tiers per package derived at capture time (btw = quick/full; others may differ — **capture from each old script's `case` line in Step 1**). Some packages need canonical-script caveats — e.g. file2md `--isolate` and obsidian scoped tests are encoded in the package's `bun run test` per the comments — keep `bun run test` (canonical) as the runner, never bare `bun test`.

- [ ] **Step 1: capture goldens per package** — loop: `bash <pkg>/run-test.sh --list | normalize > bun-apps/tests/goldens/run-test-<pkg>.list`; record tiers + exit 2 case for unknown tier.
- [ ] **Step 2: failing parity test** (`bun-apps/tests/run-test-launchers-parity.test.ts`): for each pkg: `assertParity(<pkg>/run-test.ts, [{ name: "list-<pkg>", args: ["--list"], out: <golden file contents>, outIs: "normalized", pkgName: "<pkg>" }])` + unknown-tier exit 2. Fails while no .ts exists.
- [ ] **Step 3: implement** — port ONE canonical shape (copy of Task 8's per-pkg subset): tier parse (`-l|--list`, tier names, extras forwarding), `step()` same colors, `/tmp/<pkg>-runtest.log`, canonical `bun run test` (NOT bare `bun test`), exit 0/1/2. Tailor the tier list per package (from Step 1 capture).
- [ ] **Step 4: transient A/B** — for each pkg: old vs new on `--list` + unknown-tier (diff empty) and one real tier run (quick) normalized diff empty.
- [ ] **Step 5: delete all 12 .sh; Step 6: gates + commit** (`bun test bun-apps/tests/run-test-launchers-parity.test.ts` + the devops gates for Task 8).

---

### Task 10: ci-local.sh → ci-local.ts

**Files:**
- Create: `bun-apps/s2-agent-ext-devops/scripts/ci-local.ts`
- Modify (if the reader confirms — read first): `local-ci-cli.ts:7`, `ci-matrix.ts:18`, `ci-gates.ts:16` comments naming `ci-local.sh`
- Test: `bun-apps/s2-agent-ext-devops/tests/ci-local-parity.test.ts`
- Delete (on green): `scripts/ci-local.sh`

- [ ] **Step 1: read `local-ci-cli.ts` fully** — determine whether it shells out to `ci-local.sh` (then that's a real rename-everywhere call site, added to Task 11's list) or only documents it. Record the answer in the test's provenance comment.
- [ ] **Step 2: capture goldens** — old `ci-local.sh`'s flag surface (head the file; there may be `--help`/`--list`-style flags) + the usage-error case + any `--dry-run`-safe emission; `local-ci-cli --dry-run` pre-change output (JSON) as the integration baseline.
- [ ] **Step 3: failing parity test** (static cases only — the full matrix run is the integration A/B, not a unit golden).
- [ ] **Step 4: implement ci-local.ts** (spawn `bun run` per matrix row; same parse of the workflow matrix block from scripts — copy the parser verbatim from the bash awk/sed if it parses a matrix in-place, or import the shared parser from `src/ci-matrix.ts` if the logic lives there).
- [ ] **Step 5: transient A/B** — usage/error cases diff-empty; `local-ci-cli --dry-run` output identical pre/post.
- [ ] **Step 6: delete .sh; Step 7: gates + commit.**

---

### Task 11: Rename-everywhere — code call sites + integration A/B

**Files:**
- Modify: `bun-apps/s2-agent-ext-devops/src/deploy-run.ts:34` (`existsSync(join(pkg,"scripts","run-test.sh"))` → `run-test.ts`)
- Modify: `bun-apps/s2-agent-ext-devops/src/verify-tool.ts:2-3` (`./run-test.sh <tier>` argv → `run-test.ts`; summary-parse unchanged)
- Modify: `bun-apps/s2-agent-ext-devops/src/deploy-argv.ts:5,19` (argv tail + comment)
- Modify: `bun-apps/s2-agent/src/__tests__/e2e-harness.ts:11` + `e2e-launcher.test.ts:20` (comments + PI_AGENT_E2E contract text)
- Modify: `bun-apps/s2-agent/src/doctor.ts:493` (hint → `./run-test.ts medium`)
- Modify: `ci-matrix.ts:18`, `ci-gates.ts:16`, `local-ci-cli.ts:7` (comments; + real invocation if Task 10 step 1 found one)
- Modify: `bun-apps/tests/ci-workflow-references.test.ts` (shell-out target → `run-test.ts`; its guard contract: `--list-siblings` one-name-per-line)
- Modify: `bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md` (§ tier table, `ci-local.sh` mentions; keep `scripts/sync-repo.sh` as labeled history if it appears)

**Notes:** the deployed-E2E auto-run (deploy-cli → verify-deploy-e2e) is the probe-level A/B; `verify_pi_agent_deploy` at `high`-tier is the argv+summary-parse A/B.

- [ ] **Step 1: apply all renames above** (pure find-and-replace per file; grep after: `grep -rn "run-test\.sh\|ci-local\.sh" bun-apps/s2-agent/src bun-apps/s2-agent-ext-devops/src bun-apps/tests | grep -v node_modules` → only devops-workflow SKILL.md history text remains).
- [ ] **Step 2: Unit gates** — `bun run --cwd bun-apps/s2-agent-ext-devops check` + `typecheck`; `bun run --cwd bun-apps/s2-agent test`; `bun test bun-apps/tests/ci-workflow-references.test.ts`.
- [ ] **Step 3: Integration A/B** — `bun bun-apps/s2-agent-ext-devops/src/local-ci-cli.ts --dry-run` (diff vs Task 10's baseline = none); then `verify_pi_agent_deploy` via `bun bun-apps/s2-agent-ext-devops/src/verify-tool.ts --help`-shaped args at a tier (or the tool through the s2-agent bridge) — expected: same step summary shape; deploy-cli run → probes pass on `run-test.ts` existence.
- [ ] **Step 4: commit.**

---

### Task 12: Seal the gate — guard test + doc sweep finalization

**Files:**
- Create: `bun-apps/tests/no-bash-skills-guard.test.ts`
- Test: the guard itself
- Modify: any SKILL.md references missed by Tasks 2–10 (final `grep -rn '\.sh' bun-apps/s2-agent-ext-*/skills/*/SKILL.md` must return only documented exceptions)

- [ ] **Step 1: failing guard test** — asserts (reading the docs, not running): no active SKILL.md under `bun-apps/s2-agent-ext-*/skills/*/` references `dedup.sh`, `run-test.sh`, `ci-local.sh`, `smoke.sh`, `find-polluter.sh`; ALLOWLIST = `wizard/template.sh` (D6) and `dsh-plugin/sv-analyzer/build.sh` (external, D6) — recorded with a comment citing `spec.md` D6/D7.
- [ ] **Step 2: fix any residual doc refs for real** (Tasks 2–11 should have caught them; this step is the honest sweep).
- [ ] **Step 3: gates** — `bun test bun-apps/tests/no-bash-skills-guard.test.ts` green; full devops local CI on the PR; merge via devops chain; deploy + `verify-deploy-e2e`.
- [ ] **Step 4: commit.**

---

## Self-Review (writing-plans check)

1. **Spec coverage** — §1 item 1 (skill tools) → Tasks 2–7; §1 item 2 (tier launchers) → Tasks 8–11; §1 item 3 (goldens) → Task 1 + every parity test; §1 item 4 (docs) → Tasks 2–7 + 11 + 12. D1–D8 all reflected (D2 → Task 11; D3 → Tasks 1–10; D5 → Task 2 step 4; D6 → Task 12 allowlist; D7 → frozen out of scope; D8 → task-level PR notes).
2. **Placeholder scan** — every task has real files, real interfaces, real commands; the only capture-time derivations are named explicitly (Step 1 "capture goldens" from a live old script, and Task 10's flag-surface discovery) — deliberate and required by the A/B design; no "TBD"/"handle edge cases" phrasing.
3. **Type consistency** — `assertParity`/`normalizeRunOutput`/`runScript`/`GoldenCase` names used identically in Tasks 2–12; `outIs: "normalized" | "exact"`, `errIncludes` — consistent.

## Execution Handoff

Plan complete. Two execution options: **1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. **2. Inline Execution** — batch execution with checkpoints. Which approach?
