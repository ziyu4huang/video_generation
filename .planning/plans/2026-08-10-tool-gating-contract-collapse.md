# tool-gating Contract Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the 10 duplicated `tool-gating.d.ts` copies across `bun-apps/`, replacing each with a `compilerOptions.types` entry pointing at `@repo/pi-agent-ext-core-interface`, so the tool-gating type contract has exactly one source of truth.

**Architecture:** Pure type-level migration. Each package gains a `devDependencies` entry plus a tsconfig `types` entry, and loses its local `.d.ts`. The augmentation resolves through `core-interface`'s `exports["."].types → src/types.d.ts`, which references `tool-gating.d.ts`. A new `dep-guard` invariant makes the otherwise-invisible tsconfig dependency edge enforceable. Zero runtime change — proven numerically, not asserted.

**Tech Stack:** Bun workspace (`bun-apps/`), TypeScript 6 with `moduleResolution: "bundler"`, `node:test` + `node:assert/strict` for the repo-level guards.

**Spec:** `.planning/specs/2026-08-10-tool-gating-contract-collapse-design.md`

---

## Critical constraints (read before starting)

1. **Never `cd` at the top level.** The repo blocks it via `no-cd-drift.sh`. Use `( cd <dir> && … )`, `--cwd`, or absolute paths.
2. **`bun install` runs from `bun-apps/`, never the repo root.**
3. **Never JSON round-trip these files.** `JSON.stringify(JSON.parse(raw), null, 2)` reformats 6 of 9 `package.json` files and every `tsconfig.json`, burying the real change in noise. All edits in this plan are targeted string replacements that assert they matched exactly once.
4. **Mid-migration typechecks are not evidence.** These packages' `tsc` programs overlap through relative imports, so a package can pass because a *neighbour's* copy is still present. Only Task 5, run after every deletion, is authoritative.

**Scratch dir** (used throughout — substitute the real path):

```bash
SCRATCH=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--embed/7d40bfb5-e3d5-45e3-b751-78b63bfaa9cd/scratchpad
```

**The 10 packages:**

```
flux2  krea2  file2md  research-tool  wayfind  obsidian  subagent  workflow  movie-director   ← 9 types-only
hermes-memory                                                                                  ← already declares the dep
```

`bun-apps/pi-agent/src/tool-gating.d.ts` (the host copy) was **not** migrated by
this plan — see the spec. It was migrated in a later follow-up task (outside
this plan): deleted and replaced with an explicit `compilerOptions.types`
edge, after a final review disproved the original "serves the monorepo-wide
typecheck" justification for keeping it.

---

## Task 1: Capture pre-migration baselines

Every package's isolated typecheck already has pre-existing errors from sibling packages pulled in via relative imports. Acceptance in Task 5 is "same total, zero `gating`", so the totals must be recorded first.

**Files:**
- Create: `$SCRATCH/baseline-<pkg>.txt` (10 files, outside the repo)

- [ ] **Step 1: Record all 10 baselines**

```bash
SCRATCH=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--embed/7d40bfb5-e3d5-45e3-b751-78b63bfaa9cd/scratchpad
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
for p in flux2 krea2 file2md research-tool wayfind obsidian subagent workflow movie-director hermes-memory; do
  ( cd $B/pi-agent-ext-$p && bunx tsc --noEmit -p tsconfig.json ) > "$SCRATCH/baseline-$p.txt" 2>&1
  printf "%-16s total=%-4s gating=%s\n" "$p" \
    "$(grep -c 'error TS' "$SCRATCH/baseline-$p.txt")" \
    "$(grep -ci 'gating' "$SCRATCH/baseline-$p.txt")"
done | tee "$SCRATCH/baseline-summary.txt"
```

Expected: 10 lines. Every `gating=` value **must be 0** (the local copies are still in place). `total=` varies per package — `movie-director` is known to be `19`.

- [ ] **Step 2: Stop if any baseline shows `gating` > 0**

A non-zero `gating` count before any edit means that package's augmentation is already broken and this migration is not the cause. Investigate before continuing — do not proceed with a dirty signal.

- [ ] **Step 3: Note the pre-existing test failures**

The same trap applies to `bun test`: three of these packages already fail tests on a clean tree. Measured on branch `tool-gating-contract-collapse` @ `4d087469` (`origin/main` + the spec doc only):

| Package | pass | fail |
|---|---|---|
| `tool-gate` | 296 | 0 |
| `core-interface` | 5 | 0 |
| `flux2` | 136 | 0 |
| `krea2` | 66 | 0 |
| **`file2md`** | 164 | **34** |
| `research-tool` | 108 | 0 |
| **`wayfind`** | 431 | **1** |
| `obsidian` | 381 | 0 |
| `subagent` | 546 | 0 |
| `workflow` | 1065 | 0 |
| `movie-director` | 889 | 0 |
| **`hermes-memory`** | 1382 | **1** |

These failures are **pre-existing and unrelated** to this migration — it changes no runtime code. Task 6 compares against this table rather than expecting zero. Fixing them is out of scope for this plan; raise it with the user separately.

If your own measured baseline differs from this table, use yours (the table may have aged) and record it before editing anything.

No commit — these are scratch artifacts.

---

## Task 2: Add the `dep-guard` tsconfig-`types` invariant

`dep-guard`'s `importedRepos()` scans for `from "@repo/X"` and `import("@repo/X")`. A tsconfig `types` entry is invisible to it, so after this migration 10 packages would depend on `core-interface` through an unguarded edge.

**Files:**
- Modify: `bun-apps/tests/dep-guard.test.ts`

- [ ] **Step 1: Write the failing unit tests for the pure helper**

Append to `bun-apps/tests/dep-guard.test.ts`, after the existing top-level `describe(...)` block:

```ts
describe("parseTypesRepos (tsconfig `types` dependency edges)", () => {
	it("extracts @repo entries from compilerOptions.types", () => {
		const t = { compilerOptions: { types: ["bun", "@repo/pi-agent-ext-core-interface"] } };
		assert.deepEqual([...parseTypesRepos(t)], ["pi-agent-ext-core-interface"]);
	});

	it("ignores non-@repo entries", () => {
		assert.deepEqual([...parseTypesRepos({ compilerOptions: { types: ["bun", "node"] } })], []);
	});

	it("returns empty when types is absent, empty, or not an array", () => {
		assert.deepEqual([...parseTypesRepos({ compilerOptions: {} })], []);
		assert.deepEqual([...parseTypesRepos({})], []);
		assert.deepEqual([...parseTypesRepos({ compilerOptions: { types: [] } })], []);
		assert.deepEqual([...parseTypesRepos({ compilerOptions: { types: "bun" } })], []);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun run --cwd /Users/huangziyu/proj/video_generation__embed/bun-apps test:deps
```

Expected: FAIL with `ReferenceError: Can't find variable: parseTypesRepos` (or `parseTypesRepos is not defined`).

- [ ] **Step 3: Implement the helpers**

Add both functions next to the existing `declaredRepos` helper in `bun-apps/tests/dep-guard.test.ts` (above the first `describe`):

```ts
/**
 * Pure: bare `@repo/*` names listed in a parsed tsconfig's
 * `compilerOptions.types`. Such an entry is a REAL dependency edge that
 * `importedRepos` cannot see — there is no import statement, only a type
 * reference resolved through the target's `exports["."].types`.
 *
 * Field convention for these edges (enforced by the invariant below):
 *   - types-only consumers          → devDependencies
 *   - runtime consumers (publishSeam / readSeam / SEAM_KEYS)
 *                                   → dependencies / peerDependencies
 */
function parseTypesRepos(tsconfig: unknown): Set<string> {
	const types = (tsconfig as { compilerOptions?: { types?: unknown } })?.compilerOptions?.types;
	const out = new Set<string>();
	if (!Array.isArray(types)) return out;
	for (const t of types) {
		if (typeof t === "string" && t.startsWith("@repo/")) out.add(t.replace("@repo/", ""));
	}
	return out;
}

/** `@repo/*` tsconfig `types` edges for a package. Missing tsconfig → empty
 *  (three ext packages have none: zai-mcp, knowledge-card, ltx). */
function typesRepos(pkg: string): Set<string> {
	const f = join(ROOT, pkg, "tsconfig.json");
	if (!existsSync(f)) return new Set();
	return parseTypesRepos(JSON.parse(readFileSync(f, "utf8")));
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

```bash
bun run --cwd /Users/huangziyu/proj/video_generation__embed/bun-apps test:deps
```

Expected: PASS, all tests green.

- [ ] **Step 5: Add the repo-wide invariant**

Inside the existing `describe("monorepo dependency hygiene guard (ADR-0001)", …)` block, after the invariant-1 `it(...)`:

```ts
	it("every @repo tsconfig `types` entry is declared in its package.json", () => {
		const violations: string[] = [];
		for (const pkg of EXTS) {
			const dec = declaredRepos(pkg);
			for (const t of typesRepos(pkg)) {
				if (!dec.has(t)) {
					violations.push(`  ${pkg} lists @repo/${t} in tsconfig compilerOptions.types — NOT declared in package.json`);
				}
			}
		}
		assert.deepEqual(violations, [], violations.length ? "undeclared tsconfig type deps:\n" + violations.join("\n") : "");
	});
```

- [ ] **Step 6: Prove the invariant is not vacuous (red demo)**

No package has an `@repo` `types` entry yet, so the new `it` passes trivially. Force it red once:

```bash
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
# Add the types entry to flux2 WITHOUT the package.json dep
bun -e '
const fs=require("fs"), f="'$B'/pi-agent-ext-flux2/tsconfig.json";
const raw=fs.readFileSync(f,"utf8");
const out=raw.replace(`    "types": ["bun"],`, `    "types": ["bun", "@repo/pi-agent-ext-core-interface"],`);
if (out===raw) { console.error("ANCHOR NOT FOUND"); process.exit(1); }
fs.writeFileSync(f,out);
'
bun run --cwd $B test:deps
```

Expected: FAIL with `pi-agent-ext-flux2 lists @repo/pi-agent-ext-core-interface in tsconfig compilerOptions.types — NOT declared in package.json`.

- [ ] **Step 7: Revert the red demo and confirm green**

```bash
git -C /Users/huangziyu/proj/video_generation__embed checkout -- bun-apps/pi-agent-ext-flux2/tsconfig.json
bun run --cwd /Users/huangziyu/proj/video_generation__embed/bun-apps test:deps
```

Expected: PASS. `git status --short` shows only `bun-apps/tests/dep-guard.test.ts` modified.

- [ ] **Step 8: Commit**

```bash
R=/Users/huangziyu/proj/video_generation__embed
git -C $R add bun-apps/tests/dep-guard.test.ts
git -C $R commit -m "$(cat <<'EOF'
test(dep-guard): guard @repo dependency edges declared via tsconfig types

importedRepos() only sees `from "@repo/X"` / `import("@repo/X")`. A
tsconfig compilerOptions.types entry is a real dependency edge with no
import statement, so it was invisible to invariant 1 — removing the
package.json entry would break the typecheck while dep-guard stayed
green. Adds parseTypesRepos()/typesRepos() plus the invariant, and
records the field convention (types-only -> devDependencies) next to
the check that enforces it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

### As executed (review outcome — landed in `0923234b`)

Code review of the first attempt produced four changes beyond the steps above. Recorded here so a replay matches the shipped code:

1. `repoTypesEntries` was **renamed `parseTypesRepos`** so the file's `*Repos` helper convention holds (it returns stripped names, not raw entries). The step text above uses the final name; the Step 2 red-phase error will therefore read `parseTypesRepos is not defined`.
2. The JSDoc claim "(enforced by the invariant below)" was **false** — the invariant calls `declaredRepos`, which unions all four dependency fields, so field placement is not machine-checked. Corrected to "(documented, NOT enforced — the invariant below accepts any dependency field)".
3. An `edges(pkg)` helper (`importedRepos(pkg) ∪ typesRepos(pkg)`) was added and wired into the **self-import, ADR-0001 TIER-0, and no-host-import** invariants. Without it, this commit's own premise — that a `types` entry is an edge `importedRepos` cannot see — would have been closed in one invariant and left open in three. Invariant 1 deliberately stays on `importedRepos` alone, so its diagnostic names the right mechanism.
4. **Pre-existing bug fixed:** the acyclicity invariant had never executed. `color` starts empty, so `color.get(n)` is `undefined` and `undefined === WHITE (0)` is `false` — `visit()` was never called. Both comparison sites became `(color.get(x) ?? WHITE) === WHITE`. Brought into scope because Task 3 adds 10 new edges to this graph, and landing them while the cycle check is confirmed-dead is the wrong order.

Verified by injecting a synthetic reverse edge (`@repo/pi-agent-ext-tool-gate` into `core-interface`'s devDependencies): the guard reported `dependency cycle: pi-agent-ext-core-interface → pi-agent-ext-tool-gate → pi-agent-ext-power-tool → pi-agent-ext-core-interface`, then the edit was reverted. The graph is acyclic today.

Known minor, deliberately not fixed: three invariant titles and the self-import remediation hint still say "imports" though they now cover imports ∪ `types` edges; `JSON.parse` in `typesRepos` is unguarded (`tsconfig.json` is officially JSONC, though every ext tsconfig parses as strict JSON today and none use `extends`).

---

## Task 3: Migrate the 9 types-only packages

All 9 share the identical recipe. The script below asserts each replacement matched exactly once and aborts otherwise, so a silent no-op is impossible.

**Files (per package `<p>` in flux2, krea2, file2md, research-tool, wayfind, obsidian, subagent, workflow, movie-director):**
- Modify: `bun-apps/pi-agent-ext-<p>/package.json` — add one `devDependencies` line
- Modify: `bun-apps/pi-agent-ext-<p>/tsconfig.json` — extend `compilerOptions.types`
- Delete: `bun-apps/pi-agent-ext-<p>/src/tool-gating.d.ts` (`extensions/` for research-tool)

- [ ] **Step 1: Apply the three edits to all 9 packages**

```bash
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
bun -e '
const fs = require("fs");
const B = "'$B'";
const DEP = `    "@repo/pi-agent-ext-core-interface": "workspace:*",\n`;

// anchor = the devDependencies line the new entry is inserted BEFORE, chosen so
// the block stays alphabetically sorted. research-tool already has an @repo
// entry (obsidian) and "core-interface" sorts before it.
const PKGS = [
  { name: "flux2",          anchor: `    "@types/bun"`,                      dts: "src/tool-gating.d.ts" },
  { name: "krea2",          anchor: `    "@types/bun"`,                      dts: "src/tool-gating.d.ts" },
  { name: "file2md",        anchor: `    "@types/bun"`,                      dts: "src/tool-gating.d.ts" },
  { name: "research-tool",  anchor: `    "@repo/pi-agent-ext-obsidian"`,     dts: "extensions/tool-gating.d.ts" },
  // wayfind has @tailwindcss/cli between @playwright and @types — "@repo"
  // sorts BEFORE "@tailwindcss", so its anchor is not "@types/bun".
  { name: "wayfind",        anchor: `    "@tailwindcss/cli"`,                dts: "src/tool-gating.d.ts" },
  { name: "obsidian",       anchor: `    "@types/bun"`,                      dts: "src/tool-gating.d.ts" },
  { name: "subagent",       anchor: `    "@types/bun"`,                      dts: "src/tool-gating.d.ts" },
  { name: "workflow",       anchor: `    "@types/bun"`,                      dts: "src/tool-gating.d.ts" },
  { name: "movie-director", anchor: `    "@types/bun"`,                      dts: "src/tool-gating.d.ts" },
];

const fail = (m) => { console.error("ABORT: " + m); process.exit(1); };

for (const { name, anchor, dts } of PKGS) {
  const dir = `${B}/pi-agent-ext-${name}`;

  // 1. package.json — insert the dep before the anchor line, exactly once.
  const pf = `${dir}/package.json`;
  const praw = fs.readFileSync(pf, "utf8");
  if (praw.includes("@repo/pi-agent-ext-core-interface")) fail(`${name}: dep already present`);
  const hits = praw.split(anchor).length - 1;
  if (hits !== 1) fail(`${name}: anchor ${anchor.trim()} matched ${hits} times (want 1)`);
  fs.writeFileSync(pf, praw.replace(anchor, DEP + anchor));

  // 2. tsconfig.json — extend the types array, exactly once.
  const tf = `${dir}/tsconfig.json`;
  const traw = fs.readFileSync(tf, "utf8");
  const OLD = `    "types": ["bun"],`;
  const NEW = `    "types": ["bun", "@repo/pi-agent-ext-core-interface"],`;
  const thits = traw.split(OLD).length - 1;
  if (thits !== 1) fail(`${name}: types anchor matched ${thits} times (want 1)`);
  fs.writeFileSync(tf, traw.replace(OLD, NEW));

  // 3. delete the local copy.
  const df = `${dir}/${dts}`;
  if (!fs.existsSync(df)) fail(`${name}: ${dts} missing`);
  fs.unlinkSync(df);

  console.log(`ok  ${name}`);
}
'
```

Expected: nine `ok <name>` lines, no `ABORT`.

- [ ] **Step 2: Verify the diff is minimal (no reformatting)**

```bash
R=/Users/huangziyu/proj/video_generation__embed
git -C $R diff --stat
```

Expected: 18 modified files at `1 insertion(+), 1 deletion(-)` or `1 insertion(+)` each, plus 9 deletions of ~52 lines. If any `package.json` or `tsconfig.json` shows more than the intended single line changed, revert that file and hand-edit it.

- [ ] **Step 3: Link the new workspace deps**

```bash
( cd /Users/huangziyu/proj/video_generation__embed/bun-apps && bun install )
```

Expected: completes without error. Then check the lockfile:

```bash
git -C /Users/huangziyu/proj/video_generation__embed diff --stat bun-apps/bun.lock
```

A lockfile change here is expected (9 new workspace edges). Review it; it must contain only `@repo/pi-agent-ext-core-interface` edges, no unrelated version churn.

- [ ] **Step 4: Commit**

```bash
R=/Users/huangziyu/proj/video_generation__embed
# Stage with a single -A over bun-apps/. Do NOT use an unquoted shell glob
# pointing at the deleted .d.ts files — zsh aborts with "no matches found"
# once they are gone, before git ever sees the pathspec.
git -C $R add -A bun-apps/
git -C $R status --short   # confirm: 18 modified + 9 deleted + bun.lock, nothing else
git -C $R commit -m "$(cat <<'EOF'
refactor(ext): consume the shared tool-gating augmentation in 9 packages

Replaces each package's byte-identical local tool-gating.d.ts with a
compilerOptions.types entry resolving @repo/pi-agent-ext-core-interface.
Types-only consumers, so the dep goes in devDependencies.

Type-level only; no gating declaration is touched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Migrate `hermes-memory`

Two differences from Task 3: the dependency is **already declared** (in `dependencies`, because this package imports `readSeam` / `KnowledgePipeline` at runtime), and its `types` array is a multi-line block.

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/tsconfig.json`
- Delete: `bun-apps/pi-agent-ext-hermes-memory/src/tool-gating.d.ts`
- `package.json` is **not** modified.

- [ ] **Step 1: Extend the multi-line types block and delete the copy**

```bash
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
bun -e '
const fs = require("fs");
const dir = "'$B'/pi-agent-ext-hermes-memory";
const fail = (m) => { console.error("ABORT: " + m); process.exit(1); };

const pkg = fs.readFileSync(`${dir}/package.json`, "utf8");
if (!pkg.includes(`"@repo/pi-agent-ext-core-interface": "workspace:*"`)) fail("dep unexpectedly absent");

const tf = `${dir}/tsconfig.json`;
const raw = fs.readFileSync(tf, "utf8");
const OLD = `    "types": [\n      "bun"\n    ],`;
const NEW = `    "types": [\n      "bun",\n      "@repo/pi-agent-ext-core-interface"\n    ],`;
const hits = raw.split(OLD).length - 1;
if (hits !== 1) fail(`types anchor matched ${hits} times (want 1)`);
fs.writeFileSync(tf, raw.replace(OLD, NEW));

const df = `${dir}/src/tool-gating.d.ts`;
if (!fs.existsSync(df)) fail("src/tool-gating.d.ts missing");
fs.unlinkSync(df);
console.log("ok  hermes-memory");
'
```

Expected: `ok  hermes-memory`, no `ABORT`.

- [ ] **Step 2: Confirm no local copies remain outside the host**

```bash
find /Users/huangziyu/proj/video_generation__embed/bun-apps -name 'tool-gating.d.ts' -not -path '*/node_modules/*'
```

Expected at this step: exactly two paths —
`bun-apps/pi-agent-ext-core-interface/src/tool-gating.d.ts` (canonical) and
`bun-apps/pi-agent/src/tool-gating.d.ts` (host copy, not migrated by this
plan).

*Update:* a later follow-up task (outside this plan) migrated the host copy
too, after a final review disproved the "serves the monorepo-wide typecheck"
justification for keeping it. As of that follow-up, only the canonical copy
remains.

- [ ] **Step 3: Commit**

```bash
R=/Users/huangziyu/proj/video_generation__embed
# -A over the package dir: the deleted .d.ts cannot be named by an unquoted
# shell glob (zsh aborts on no-match once the file is gone).
git -C $R add -A bun-apps/pi-agent-ext-hermes-memory/
git -C $R status --short   # confirm: 1 modified (tsconfig.json) + 1 deleted
git -C $R commit -m "$(cat <<'EOF'
refactor(hermes-memory): drop the leftover local tool-gating.d.ts

This package already depended on @repo/pi-agent-ext-core-interface for
readSeam/KnowledgePipeline, yet still carried its own copy of the
augmentation. Adds the tsconfig types entry and deletes the copy; the
package.json dep is unchanged (runtime consumer, stays in dependencies).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Authoritative verification (all-deleted state)

This is the **only** typecheck evidence that counts. Every copy is now gone, so no package can pass on a neighbour's augmentation.

**Files:** none modified.

- [ ] **Step 1: Re-run all 10 typechecks and diff against the baselines**

```bash
SCRATCH=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--embed/7d40bfb5-e3d5-45e3-b751-78b63bfaa9cd/scratchpad
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
FAIL=0
for p in flux2 krea2 file2md research-tool wayfind obsidian subagent workflow movie-director hermes-memory; do
  ( cd $B/pi-agent-ext-$p && bunx tsc --noEmit -p tsconfig.json ) > "$SCRATCH/after-$p.txt" 2>&1
  before=$(grep -c 'error TS' "$SCRATCH/baseline-$p.txt")
  after=$(grep -c 'error TS' "$SCRATCH/after-$p.txt")
  gating=$(grep -ci 'gating' "$SCRATCH/after-$p.txt")
  status=OK
  if [ "$before" != "$after" ] || [ "$gating" != "0" ]; then status=FAIL; FAIL=1; fi
  printf "%-16s before=%-4s after=%-4s gating=%-3s %s\n" "$p" "$before" "$after" "$gating" "$status"
done
echo "=== overall: $([ $FAIL -eq 0 ] && echo PASS || echo FAIL) ==="
```

Expected: 10 `OK` lines and `overall: PASS`. Acceptance per package is `after == before` **and** `gating == 0`.

- [ ] **Step 2: If any package FAILs, diagnose before proceeding**

`gating > 0` means that package's `types` entry did not resolve — check its `package.json` dep and that `bun install` linked it (`ls bun-apps/node_modules/@repo/`). `after != before` with `gating == 0` means an unrelated error appeared; diff the two files:

```bash
diff "$SCRATCH/baseline-<pkg>.txt" "$SCRATCH/after-<pkg>.txt"
```

Do not continue to Task 6 while any package fails.

---

## Task 6: Prove zero runtime change

The migration must not have touched a single `gating` declaration. These numbers are the proof — they must be **identical**, not merely healthy.

**Files:** none modified.

- [ ] **Step 1: Re-run the savings harness**

```bash
bun run --cwd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate qa:savings 2>&1 | head -8
```

Expected, unchanged from the pre-migration measurement on `origin/main` @ `6debb26e`:

```
tools captured: 68  (core present: 23/23, gated present: 37)
OFF baseline:   21,124 tok/req
ON at start:    10,113 tok/req
SAVED:          11,011 tok/req  (52.1%)
enable_tool:    243 tok/req
```

Any drift means a gating declaration changed — a defect. Stop and find it.

- [ ] **Step 2: Re-run the gate-recall harness**

```bash
bun run --cwd /Users/huangziyu/proj/video_generation__embed/bun-apps/pi-agent-ext-tool-gate qa:gate-recall 2>&1 | tail -3
```

Expected: `✅ PASS — 0 failing gate(s), 0 uncovered`.

- [ ] **Step 3: Run the affected packages' tests**

```bash
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
for p in flux2 krea2 file2md research-tool wayfind obsidian subagent workflow movie-director hermes-memory tool-gate; do
  printf "%-16s " "$p"
  ( cd $B/pi-agent-ext-$p && bun test 2>&1 | grep -E '^ *[0-9]+ (pass|fail)' | tr '\n' ' ' )
  echo
done
```

Expected: **identical pass/fail counts to the Task 1 Step 3 baseline table** — not zero failures. `file2md` (34), `wayfind` (1), and `hermes-memory` (1) fail before this migration and must fail exactly the same way after it. Any *change* in a count, in either direction, needs explaining before proceeding.

`tool-gate` is included because its `drift-guard.test.ts` drives every migrated extension's registrars — it is the direct regression net for accidental gating edits, and it must stay at 296 pass / 0 fail.

Note: `pi-agent-ext-archify` uses `bun test --isolate` per the manifest; it is not in this list because it holds no copy.

- [ ] **Step 4: Run the repo-level guards**

```bash
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
bun run --cwd $B test:deps
bun run --cwd $B test:seam
```

Expected: both PASS. `test:deps` now exercises the new invariant against 10 real edges — it is no longer vacuous.

- [ ] **Step 5: Commit nothing, record the results**

This task modifies no files. If everything passed, note the numbers in the PR description.

---

## Task 7: Update the canonical header to document the `types`-array path

`core-interface/src/tool-gating.d.ts` tells consumers to add a triple-slash directive. After this migration, 10 of 15 consumers use the tsconfig `types` array instead, and the header also names a package (`@repo/pi-tool-gating-contract`) that no longer exists.

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-interface/src/tool-gating.d.ts:5-12`

- [ ] **Step 1: Replace the consumer-instructions paragraph**

Replace these lines (currently lines 5–12):

```
 * Lets a tool's `ToolDefinition` carry an owner-declared `gating` field.
 * Formerly duplicated (byte-identical) across ~14 packages so no cross-package
 * type dependency was introduced; a drift-guard test asserted structural
 * agreement. That duplication is now collapsed into `@repo/pi-agent-ext-core-interface`.
 * Consumers surface the augmentation in their isolated typecheck by adding
 *     /// <reference types="@repo/pi-agent-ext-core-interface" />
 * as the first line of their primary entry (or by adding this file to their
 * tsconfig `include`).
```

with:

```
 * Lets a tool's `ToolDefinition` carry an owner-declared `gating` field.
 * Formerly duplicated (byte-identical) across ~14 packages so no cross-package
 * type dependency was introduced. That duplication is now collapsed here.
 *
 * Consumers surface the augmentation in their isolated typecheck EITHER by
 * listing this package in their tsconfig `compilerOptions.types`:
 *     "types": ["bun", "@repo/pi-agent-ext-core-interface"]
 * (preferred — program-wide, no arbitrary host file; used by the 10 packages
 * migrated in .planning/specs/2026-08-10-tool-gating-contract-collapse-design.md),
 * OR with a triple-slash directive on their primary entry:
 *     /// <reference types="@repo/pi-agent-ext-core-interface" />
 * (used by tool-gate / core-task / power-tool). Either way the package must be
 * declared in package.json — bun-apps/tests/dep-guard.test.ts enforces both edges.
```

- [ ] **Step 2: Fix the stale package name further down**

In the "Why this file is a MODULE" paragraph, replace:

```
 *  types="@repo/pi-tool-gating-contract" />` directive, or a tsconfig `include`
```

with:

```
 *  types="@repo/pi-agent-ext-core-interface" />` directive, or a tsconfig `include`
```

- [ ] **Step 3: Verify nothing broke**

```bash
B=/Users/huangziyu/proj/video_generation__embed/bun-apps
( cd $B/pi-agent-ext-core-interface && bun test && bunx tsc --noEmit )
( cd $B/pi-agent-ext-movie-director && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -ci gating )
```

Expected: core-interface tests pass, its own typecheck is clean, and the `gating` grep prints `0`. (Comment-only edits cannot change behavior; this confirms no accidental damage to the reference directives.)

- [ ] **Step 4: Commit**

```bash
R=/Users/huangziyu/proj/video_generation__embed
git -C $R add bun-apps/pi-agent-ext-core-interface/src/tool-gating.d.ts
git -C $R commit -m "$(cat <<'EOF'
docs(core-interface): document the tsconfig types path, fix stale package name

The header told consumers to use a triple-slash directive; 10 of the 15
consumers now use the tsconfig compilerOptions.types array instead. Also
corrects a reference to @repo/pi-tool-gating-contract, a package that no
longer exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria

- [ ] `find bun-apps -name tool-gating.d.ts -not -path '*/node_modules/*'` returns exactly 2 paths at the end of this plan (canonical + `pi-agent` host copy, not migrated here). A later follow-up task (outside this plan) migrated the host copy too, leaving exactly 1 path.
- [ ] All 10 packages: `after == before` total errors, `gating == 0` (Task 5, run in the all-deleted state)
- [ ] `qa:savings` reports `ON at start: 10,113` and `SAVED: 11,011` — unchanged
- [ ] `qa:gate-recall` reports `0 failing, 0 uncovered`
- [ ] `test:deps` passes and its new invariant covers 10 real edges
- [ ] Every package's pass/fail counts match the Task 1 Step 3 baseline exactly (including the pre-existing `file2md` 34, `wayfind` 1, `hermes-memory` 1)
- [ ] `bun-apps/bun.lock` diff contains only `@repo/pi-agent-ext-core-interface` edges
- [ ] 4 commits: dep-guard invariant, 9-package migration, hermes-memory, doc header
