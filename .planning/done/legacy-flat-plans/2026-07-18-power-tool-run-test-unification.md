# power-tool run-test.sh Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `bun-apps/pi-agent-ext-power-tool` a tiered `run-test.sh` (`quick|medium|high|readonly|full`) with the same CLI shape as `bun-apps/pi-agent/run-test.sh`, wired onto power-tool's existing L0 (unit) / L2 (opt-in real-CLI + real-model) test layers. `pi-agent` itself needs no change — it already has the target script.

**Architecture:** Extract the skip-vs-fail decision inside `src/__tests__/l2-e2e.test.ts` into a small pure function (`resolveTestMode`) in a new non-test module, so it can be unit-tested without touching LM Studio or vault-mind. Add a `PI_REQUIRE_L2` env var that turns a blocked L2 test into a hard failure instead of a skip. Then write `run-test.sh` as a self-contained bash script (no shared lib — matches `pi-agent/run-test.sh`'s current style), dispatching to `bun test` / `bunx tsc --noEmit` with different env-var combinations per tier.

**Tech Stack:** Bun (`bun:test`), TypeScript (`tsc --noEmit`), bash.

**Design doc:** `docs/superpowers/specs/2026-07-18-power-tool-run-test-unification-design.md`

---

## File Structure

- **Create:** `bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.ts` — pure `resolveTestMode()` function (no side effects, no imports of `bun:test`).
- **Create:** `bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.test.ts` — unit tests for `resolveTestMode()`.
- **Modify:** `bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts` — import `resolveTestMode`, replace the inline `canRun`/`runner`/`title` logic (lines ~211–224) with a call to it, add `PI_REQUIRE_L2` handling in the test body.
- **Create:** `bun-apps/pi-agent-ext-power-tool/run-test.sh` — the tiered launcher (executable).
- **Modify:** `bun-apps/pi-agent-ext-power-tool/README.md` — add a `## Testing` section documenting `run-test.sh` usage.

---

### Task 1: `resolveTestMode()` pure function + unit tests

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.test.ts
import { describe, test, expect } from "bun:test";
import { resolveTestMode } from "./l2-test-mode";

describe("resolveTestMode", () => {
  test("no blockers -> run", () => {
    const result = resolveTestMode("todo", [], true, false);
    expect(result.mode).toBe("run");
    expect(result.title).toBe("L2: todo");
  });

  test("blocked, L2 not enabled -> skip", () => {
    const result = resolveTestMode("todo", ["set PI_RUN_L2=1 to run L2 e2e"], false, false);
    expect(result.mode).toBe("skip");
    expect(result.title).toBe("L2: todo — skipped (set PI_RUN_L2=1 to run L2 e2e)");
  });

  test("blocked, L2 enabled, not required -> skip", () => {
    const result = resolveTestMode("todo", ["LM Studio not reachable on :1234"], true, false);
    expect(result.mode).toBe("skip");
    expect(result.title).toBe("L2: todo — skipped (LM Studio not reachable on :1234)");
  });

  test("blocked, L2 enabled AND required -> fail", () => {
    const result = resolveTestMode("todo", ["LM Studio not reachable on :1234"], true, true);
    expect(result.mode).toBe("fail");
    expect(result.title).toBe("L2: todo — REQUIRED but blocked (LM Studio not reachable on :1234)");
  });

  test("blocked, L2 NOT enabled but required flag set anyway -> skip (PI_REQUIRE_L2 only matters when L2 is enabled)", () => {
    const result = resolveTestMode("todo", ["set PI_RUN_L2=1 to run L2 e2e"], false, true);
    expect(result.mode).toBe("skip");
  });

  test("multiple blockers joined with semicolons in title", () => {
    const result = resolveTestMode(
      "knowledge_query",
      ["LM Studio not reachable on :1234", "vault-mind not reachable on :8000"],
      true,
      false,
    );
    expect(result.title).toBe(
      "L2: knowledge_query — skipped (LM Studio not reachable on :1234; vault-mind not reachable on :8000)",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-power-tool && bun test src/__tests__/l2-test-mode.test.ts )`
Expected: FAIL — `error: Cannot find module './l2-test-mode'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.ts
/**
 * Pure decision logic for how l2-e2e.test.ts registers each tool's test:
 *   - "run"  — no blockers, execute the real assertion body.
 *   - "skip" — blocked (L2 disabled, or a required service is down) and not
 *              required to fail — registers as bun:test's test.skip().
 *   - "fail" — blocked AND PI_REQUIRE_L2=1 (and L2 itself is enabled) — used
 *              by run-test.sh's `full` tier so a down service fails the run
 *              instead of silently skipping.
 * Extracted so this branching can be unit-tested without spawning the real
 * CLI or probing LM Studio / vault-mind.
 */
export interface TestModeResult {
  mode: "run" | "skip" | "fail";
  title: string;
}

export function resolveTestMode(
  toolName: string,
  blockers: string[],
  l2Enabled: boolean,
  requireL2: boolean,
): TestModeResult {
  if (blockers.length === 0) {
    return { mode: "run", title: `L2: ${toolName}` };
  }
  if (l2Enabled && requireL2) {
    return { mode: "fail", title: `L2: ${toolName} — REQUIRED but blocked (${blockers.join("; ")})` };
  }
  return { mode: "skip", title: `L2: ${toolName} — skipped (${blockers.join("; ")})` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-power-tool && bun test src/__tests__/l2-test-mode.test.ts )`
Expected: PASS — 6 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.ts bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-test-mode.test.ts
git commit -m "test: add resolveTestMode for l2-e2e skip/fail/run decision"
```

---

### Task 2: Wire `resolveTestMode` + `PI_REQUIRE_L2` into `l2-e2e.test.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts:211-239`

- [ ] **Step 1: Read the current block to confirm line numbers still match**

Run: `sed -n '192,240p' bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts`
Expected: shows the `for (const tool of TOOLS)` loop with the `canRun`/`runner`/`title` logic and the `runner(title, async () => { ... })` body, ending at the `expect` for markers.

- [ ] **Step 2: Replace the loop body**

Replace:

```typescript
for (const tool of TOOLS) {
  const needsVault = VAULT_TOOLS.has(tool.name);
  const blockers: string[] = [];
  if (!l2Enabled) blockers.push("set PI_RUN_L2=1 to run L2 e2e");
  else {
    if (!lmStudioUp) blockers.push("LM Studio not reachable on :1234");
    if (needsVault && !vaultMindUp) blockers.push("vault-mind not reachable on :8000");
  }
  const canRun = blockers.length === 0;
  const runner = canRun ? test : test.skip;
  // Skip reason goes in the title so it's visible in `bun test` output.
  const title = canRun
    ? `L2: ${tool.name}`
    : `L2: ${tool.name} — skipped (${blockers.join("; ")})`;

  runner(title, async () => {
    const { exitCode, stdout } = invokeTool(tool.prompt, tool.timeoutMs);

    // Gate 1: exit code must be 0
    expect(exitCode, `${tool.name}: exit code 0`).toBe(0);

    // Gate 2: all expected content markers present in stdout (case-insensitive)
    if (tool.markers.length > 0) {
      const lower = stdout.toLowerCase();
      for (const marker of tool.markers) {
        expect(lower, `${tool.name}: stdout contains "${marker}"`).toInclude(marker.toLowerCase());
      }
    }
  }, { timeout: (tool.timeoutMs ?? 120_000) + 5_000 });
```

With:

```typescript
// PI_REQUIRE_L2=1 turns a blocked L2 test into a hard failure instead of a
// skip — used by run-test.sh's `full` tier so a down LM Studio/vault-mind
// fails the run rather than silently passing via skip.
const requireL2 = process.env.PI_REQUIRE_L2 === "1";

for (const tool of TOOLS) {
  const needsVault = VAULT_TOOLS.has(tool.name);
  const blockers: string[] = [];
  if (!l2Enabled) blockers.push("set PI_RUN_L2=1 to run L2 e2e");
  else {
    if (!lmStudioUp) blockers.push("LM Studio not reachable on :1234");
    if (needsVault && !vaultMindUp) blockers.push("vault-mind not reachable on :8000");
  }
  const { mode, title } = resolveTestMode(tool.name, blockers, l2Enabled, requireL2);
  const runner = mode === "skip" ? test.skip : test;

  runner(title, async () => {
    if (mode === "fail") {
      throw new Error(`${tool.name}: blocked — ${blockers.join("; ")}`);
    }

    const { exitCode, stdout } = invokeTool(tool.prompt, tool.timeoutMs);

    // Gate 1: exit code must be 0
    expect(exitCode, `${tool.name}: exit code 0`).toBe(0);

    // Gate 2: all expected content markers present in stdout (case-insensitive)
    if (tool.markers.length > 0) {
      const lower = stdout.toLowerCase();
      for (const marker of tool.markers) {
        expect(lower, `${tool.name}: stdout contains "${marker}"`).toInclude(marker.toLowerCase());
      }
    }
  }, { timeout: (tool.timeoutMs ?? 120_000) + 5_000 });
```

- [ ] **Step 3: Add the import**

At the top of the file, next to the existing `import { test, expect } from "bun:test";`, add:

```typescript
import { resolveTestMode } from "./l2-test-mode";
```

- [ ] **Step 4: Run the default (no env) suite to confirm behavior is unchanged**

Run: `( cd bun-apps/pi-agent-ext-power-tool && bun test src/__tests__/l2-e2e.test.ts )`
Expected: PASS overall; every `L2: <tool>` test shows as skipped with title `L2: <tool> — skipped (set PI_RUN_L2=1 to run L2 e2e)` — same wording as before the change.

- [ ] **Step 5: Run with `PI_REQUIRE_L2=1` but `PI_RUN_L2` unset — confirm it still skips (not fail)**

Run: `( cd bun-apps/pi-agent-ext-power-tool && PI_REQUIRE_L2=1 bun test src/__tests__/l2-e2e.test.ts )`
Expected: PASS overall, still skipped (matches Task 1's "L2 NOT enabled but required flag set anyway -> skip" case) — `PI_REQUIRE_L2` alone (without `PI_RUN_L2=1`) must not fail the suite.

- [ ] **Step 6: Run the full unit suite for the package to confirm nothing else broke**

Run: `( cd bun-apps/pi-agent-ext-power-tool && bun test )`
Expected: PASS — same pass count as before this task, plus the 6 new `l2-test-mode.test.ts` tests.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts
git commit -m "feat: wire PI_REQUIRE_L2 into l2-e2e via resolveTestMode"
```

---

### Task 3: `run-test.sh`

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/run-test.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
########################################
# run-test.sh — multi-effort-level test launcher for pi-agent-ext-power-tool.
#
# Mirrors bun-apps/pi-agent/run-test.sh's tier names. power-tool has no
# build/deploy step of its own — tiers map onto its L0 (unit) / L2 (opt-in
# real-CLI + real-model) test layers instead (see l2-e2e.test.ts header).
# There is no standalone L1 (deterministic subprocess, no model): invoking a
# tool through the real CLI always calls the configured LLM, so `high` and
# `full` run the same suite and differ only in skip-vs-fail on blocked
# services (PI_REQUIRE_L2).
#
#   quick    (0)   unit only, no typecheck.                              ~1s
#   medium   (1)   + typecheck (tsc --noEmit). DEFAULT.                  ~5s
#   high     (2)   + PI_RUN_L2=1 (blocked services SKIP).                varies
#   readonly (2.5) PI_RUN_L2=1, l2-e2e.test.ts ONLY (skip allowed).      Opt-in tier (not in the stack).
#   full     (3)   quick + medium + PI_RUN_L2=1 PI_REQUIRE_L2=1          varies
#                  (blocked services FAIL, not skip).
#
# USAGE
#   ./run-test.sh                  # = medium
#   ./run-test.sh quick            # pre-commit, no typecheck
#   ./run-test.sh high
#   ./run-test.sh readonly         # l2-e2e.test.ts only, skip allowed
#   ./run-test.sh full             # whole stack, blocked services FAIL
#   ./run-test.sh --effort=medium
#   ./run-test.sh --list           # print the tier table, exit 0
#   ./run-test.sh medium --bail    # extra flags forwarded to `bun test`
########################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── colors ────────────────────────────────────────────────────────────────
G() { printf '\033[32m%s\033[0m' "$1"; }
R() { printf '\033[31m%s\033[0m' "$1"; }
Y() { printf '\033[33m%s\033[0m' "$1"; }
D() { printf '\033[2m%s\033[0m' "$1"; }

# ── parse args ────────────────────────────────────────────────────────────
EFFORT="medium"
LIST=0
EXTRA=()
while [ $# -gt 0 ]; do
	case "$1" in
		--effort=*) EFFORT="${1#*=}"; shift ;;
		--effort) EFFORT="${2:-}"; shift 2 ;;
		-l|--list) LIST=1; shift ;;
		quick|medium|high|readonly|full|0|1|2|3) EFFORT="$1"; shift ;;
		*) EXTRA+=("$1"); shift ;;
	esac
done
case "$EFFORT" in
	0) EFFORT="quick" ;; 1) EFFORT="medium" ;; 2) EFFORT="high" ;; 3) EFFORT="full" ;;
esac

print_list() {
	cat <<EOF
$(Y "pi-agent-ext-power-tool run-test.sh — effort tiers"):

  $(G quick)    $(D '~1s')     unit only, no typecheck
  $(G medium)   $(D '~5s')     + typecheck (tsc --noEmit)  $(Y "[default]")
  $(G high)     $(D 'varies')  + PI_RUN_L2=1 (blocked services SKIP)
  $(G readonly) $(D 'varies')  PI_RUN_L2=1, l2-e2e.test.ts ONLY (skip allowed)
  $(G full)     $(D 'varies')  quick + medium + PI_RUN_L2=1 PI_REQUIRE_L2=1 (blocked services FAIL)

Env gates l2-e2e.test.ts reads:
  PI_RUN_L2=1      enable L2 (spawns real CLI + real LM Studio model)  (high+)
  PI_REQUIRE_L2=1  blocked services FAIL instead of SKIP               (full)
  PI_L2_MODEL      override the LM Studio model (default: google/gemma-4-26b-a4b-qat)
EOF
}

if [ "$LIST" -eq 1 ]; then print_list; exit 0; fi

case "$EFFORT" in
	quick|medium|high|readonly|full) ;;
	*) echo "$(R "error"): unknown effort '$EFFORT' (want: quick|medium|high|readonly|full)" >&2
	   echo "try: ./run-test.sh --list" >&2; exit 2 ;;
esac

# ── tier runners ──────────────────────────────────────────────────────────
# set -e is OFF here (set -uo pipefail only), so a failing tier reports
# instead of aborting. Do NOT wrap calls in `|| true` — that would reset rc
# to 0 and every tier would report pass even on failure.
OVERALL=0

run_unit() {
	unset PI_RUN_L2 PI_REQUIRE_L2
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_typecheck() {
	( cd "$SCRIPT_DIR" && bunx tsc --noEmit )
}

run_l2() {
	unset PI_REQUIRE_L2
	export PI_RUN_L2=1
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_l2_only() {
	unset PI_REQUIRE_L2
	export PI_RUN_L2=1
	( cd "$SCRIPT_DIR" && bun test src/__tests__/l2-e2e.test.ts ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_l2_strict() {
	export PI_RUN_L2=1
	export PI_REQUIRE_L2=1
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

# Run a named step, capture rc + elapsed, color the summary line, fold OVERALL.
step() {
	local name="$1"; shift
	local start rc elapsed
	start=$(date +%s)
	"$@" >/tmp/power-tool-runtest.log 2>&1
	rc=$?
	elapsed=$(( $(date +%s) - start ))
	if [ "$rc" -eq 0 ]; then
		echo "$(G '✓') ${name}  $(D "(${elapsed}s)")"
	else
		echo "$(R '✗') ${name}  $(D "(${elapsed}s)")"
		OVERALL=1
	fi
	if [ "$rc" -ne 0 ]; then
		sed 's/^/      /' /tmp/power-tool-runtest.log | tail -n 25 >&2
	fi
}

echo "$(Y "▶ pi-agent-ext-power-tool run-test.sh — effort=$EFFORT")"

case "$EFFORT" in
	quick)
		step "unit (quick)" run_unit
		;;
	medium)
		step "unit (quick)" run_unit
		step "typecheck (medium)" run_typecheck
		;;
	high)
		step "unit (quick)" run_unit
		step "typecheck (medium)" run_typecheck
		step "unit + L2 e2e (high, skip-on-blocked)" run_l2
		;;
	readonly)
		step "L2 e2e only (readonly, skip-on-blocked)" run_l2_only
		;;
	full)
		step "unit (quick)" run_unit
		step "typecheck (medium)" run_typecheck
		step "unit + L2 e2e (full, FAIL-on-blocked)" run_l2_strict
		;;
esac

echo ""
if [ "$OVERALL" -eq 0 ]; then
	echo "$(G "✓ effort=$EFFORT passed")"
else
	echo "$(R "✗ effort=$EFFORT had failures (see above)")"
fi
exit "$OVERALL"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x bun-apps/pi-agent-ext-power-tool/run-test.sh`

- [ ] **Step 3: Verify `--list` output**

Run: `bun-apps/pi-agent-ext-power-tool/run-test.sh --list`
Expected: prints the tier table (exit code 0), no test execution.

- [ ] **Step 4: Verify `quick`**

Run: `bun-apps/pi-agent-ext-power-tool/run-test.sh quick`
Expected: one step (`unit (quick)`), exits 0, completes in ~1-2s (no typecheck, no L2 network probes).

- [ ] **Step 5: Verify `medium` (default)**

Run: `bun-apps/pi-agent-ext-power-tool/run-test.sh`
Expected: two steps (`unit (quick)`, `typecheck (medium)`), exits 0.

- [ ] **Step 6: Verify `high` with LM Studio OFF**

Run: `bun-apps/pi-agent-ext-power-tool/run-test.sh high`
Expected: three steps all ✓ (the L2 e2e tests register as skipped with "LM Studio not reachable" in their titles, which still counts as a pass at the `bun test` process level); overall exits 0.

- [ ] **Step 7: Verify `readonly`**

Run: `bun-apps/pi-agent-ext-power-tool/run-test.sh readonly`
Expected: one step (`L2 e2e only (readonly, skip-on-blocked)`), exits 0, only runs `l2-e2e.test.ts` (visibly fewer tests registered than `high`'s full-suite run — check the captured log at `/tmp/power-tool-runtest.log` if unsure).

- [ ] **Step 8: Verify `full` with LM Studio OFF — must FAIL**

Run: `bun-apps/pi-agent-ext-power-tool/run-test.sh full`
Expected: `unit (quick)` ✓, `typecheck (medium)` ✓, `unit + L2 e2e (full, FAIL-on-blocked)` ✗ (the L2 tests throw "blocked — LM Studio not reachable on :1234" instead of skipping); overall exits 1 with `✗ effort=full had failures`.

- [ ] **Step 9: If available, verify `high`/`full` with LM Studio ON**

If LM Studio is running locally with the model loaded: run `bun-apps/pi-agent-ext-power-tool/run-test.sh high` again.
Expected: the L2 tests actually execute (spawn the real CLI), titles show `L2: <tool>` without "skipped"/"REQUIRED but blocked". If this environment isn't available, skip this step and note it wasn't verified.

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/run-test.sh
git commit -m "feat: add tiered run-test.sh to pi-agent-ext-power-tool"
```

---

### Task 4: Document `run-test.sh` in the package README

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/README.md` (insert before the `## Layout` section, i.e. after line 297)

- [ ] **Step 1: Insert the section**

Insert after the closing ` ``` ` on line 297 (the end of the directory-tree code block just before `## What the numbers mean`... actually insert this new section directly before `## What the numbers mean` at line 299, so the doc reads: Layout-adjacent tree → Testing → What the numbers mean). Concretely, insert this block immediately before the `## What the numbers mean` heading:

```markdown
## Testing

```bash
./run-test.sh                  # medium (default): unit + typecheck
./run-test.sh quick            # unit only, no typecheck
./run-test.sh high             # + PI_RUN_L2=1 (blocked services SKIP)
./run-test.sh readonly         # PI_RUN_L2=1, l2-e2e.test.ts only (skip allowed)
./run-test.sh full             # + PI_REQUIRE_L2=1 (blocked services FAIL, not skip)
./run-test.sh --list           # print the tier table
```

`high`/`full` spawn the real `pi-agent` CLI and call a real LM Studio model
(`google/gemma-4-26b-a4b-qat` by default, override via `PI_L2_MODEL`) —
`knowledge_query`/`graph_health` additionally need vault-mind's ChromaDB on
`:8000`. There is no standalone "real CLI, no model" tier: invoking a tool
through the CLI always triggers model inference, so `high` and `full` run the
same suite and differ only in whether a blocked service skips (`high`) or
fails (`full`) the run. See `src/__tests__/l2-e2e.test.ts` for the per-tool
gate list.
```

- [ ] **Step 2: Verify placement renders correctly**

Run: `grep -n "^## " bun-apps/pi-agent-ext-power-tool/README.md`
Expected: `## Testing` appears between `## Layout` and `## What the numbers mean` in the heading list (order: ... Usage, Layout, Testing, What the numbers mean).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/README.md
git commit -m "docs: document run-test.sh tiers in power-tool README"
```

---

## Self-Review Notes

- **Spec coverage:** design doc's tier table (quick/medium/high/readonly/full), the `PI_REQUIRE_L2` code change, run-test.sh's CLI shape (`--list`, `--effort=`, extra-flag forwarding, colorized `step()`), and the manual testing plan (7 scenarios) are each covered by Tasks 1-3. README documentation was implicit in the spec's spirit and added as Task 4.
- **Placeholder scan:** no TBD/TODO; every step has complete code or an exact command + expected output.
- **Type consistency:** `resolveTestMode(toolName, blockers, l2Enabled, requireL2)` signature and `TestModeResult` shape (`{ mode, title }`) are identical between Task 1's implementation, Task 1's tests, and Task 2's call site.
