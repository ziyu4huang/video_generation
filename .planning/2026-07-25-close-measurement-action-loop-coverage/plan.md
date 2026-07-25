# tool-gate coverage check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an offline QA, `qa/coverage.ts`, that flags any registered tool which is heavy (≥ threshold tok/req) but NOT tracked by any tool-gate gate — closing the measurement→action loop so a forgotten gate never silently degrades savings.

**Architecture:** A new QA module in `@repo/pi-agent-ext-tool-gate` that reuses power-tool's `schema-cost` collector (`buildSchemaCostReport`, the same call `qa/savings.ts` already makes) and compares the captured heavy tools against tool-gate's `TRACKED_TOOLS` set. The pure accounting core is extracted as `analyzeCoverage(report, threshold, root)` so it is unit-testable against a hand-crafted fixture without booting collection; the async `measureCoverage()` is a thin wrapper around the one `buildSchemaCostReport` call. The one-way dependency `tool-gate → power-tool schema-cost` is preserved (no back-edge). Offline only — zero runtime change.

**Tech Stack:** TypeScript, Bun (`bun:test`), TypeBox. Package: `@repo/pi-agent-ext-tool-gate`. Imports from sibling `@repo/pi-agent-cli` (schema-cost command) and the SDK.

## Global Constraints

Verbatim from the approved spec (`.planning/2026-07-25-close-measurement-action-loop-coverage/spec.md`):

- **Threshold = 300 tok/req** (`DEFAULT_COVERAGE_THRESHOLD = 300`), configurable via `--coverage-threshold <n>`.
- **Verdict is non-gating by default**; coverage affects `pass` ONLY under `--strict` (mirrors task-breaking gates + false-fires: reported always, gated under `--strict`).
- **Builtins excluded** — `source === "(builtin)"` tools are in `CORE_TOOLS` by design and can never be gated; never report them, never count them as heavy.
- **No runtime change** — offline QA only. Do not touch `updateSticky`/`filterActive`/`gateFires` or the fail-open + sticky contract.
- **One-way dependency preserved** — `tool-gate` imports `power-tool schema-cost` (via `pi-agent-cli`); `power-tool` must NOT import `tool-gate`.
- **Out of scope:** usage-aware auto-tuning; power-tool runtime nudge message; eliminating the `/ 4` heuristic duplication. Do not implement these.
- **Repo discipline:** NEVER top-level `cd` (repo blocks it). Run tests via `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`. Bun only — no npm/yarn. All artifacts in English.

**Reference shapes (authoritative — read these before Task 1):**
- `ToolCost` (`@repo/pi-agent-ext-power-tool/schema-cost`, re-exported by `pi-agent-cli/src/commands/schema-cost.ts`): `{ name: string; descLen: number; paramsLen: number; approxTokens: number; source: string; hasExecute?: boolean; schemaValid?: boolean }`. Builtin sentinel: `source === "(builtin)"`.
- `SchemaCostReport`: `{ tools: ToolCost[]; totalTokens: number; builtinCount: number; extensionCount: number; errors: { source: string; error: string }[] }`.
- `buildSchemaCostReport(cwd?, entries?): Promise<SchemaCostReport>` and `resolveRepoRoot(): string` — both exported from `../../pi-agent-cli/src/commands/schema-cost.ts`.
- `TRACKED_TOOLS` (`extensions/tool-gate.ts:224`): `const TRACKED_TOOLS = new Set([...CORE_TOOLS, ...GATES.flatMap((g) => g.names)]);` — currently NOT exported. `Set<string>`. Precomputed at module load.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `qa/coverage.ts` | CREATE | Pure core `analyzeCoverage` (no I/O) + async `measureCoverage` wrapper + `formatCoverage` + `assertSane` + runnable `main`. The whole module. |
| `qa/coverage.test.ts` | CREATE | Fixture-based unit tests for `analyzeCoverage`/`formatCoverage`/`assertSane` (no boot) + one structural integration test for `measureCoverage` against the real repo. |
| `extensions/tool-gate.ts:224` | EDIT | `const TRACKED_TOOLS` → `export const TRACKED_TOOLS`. One word. Zero behavior change (already precomputed at load). |
| `qa/run.ts` | EDIT | Add `coverage: CoverageReport` + `coverageProblems` to `QaResult`; add `coverageThreshold?` to `QaOptions`; call `measureCoverage` in `runQa`; fold `coverageProblems` into `sane`; gate on coverage under `--strict`; render `## Coverage` block + JSON + summary line; parse `--coverage-threshold`. |
| `package.json` | EDIT | Add `"qa:coverage": "bun run qa/coverage.ts"` to `scripts`. |
| `README.md` | EDIT | Document the coverage axis alongside savings / miss-rate. |

**Dependency graph (acyclic):** `qa/run.ts → qa/coverage.ts → { pi-agent-cli schema-cost, extensions/tool-gate.ts }`. `extensions/tool-gate.ts` imports nothing new. `power-tool` is never imported by `tool-gate` at runtime — only the shared `schema-cost` command module path that `savings.ts` already uses.

---

## Task 1: coverage.ts pure core + export TRACKED_TOOLS + unit tests

**Files:**
- Create: `bun-apps/pi-agent-ext-tool-gate/qa/coverage.ts`
- Create: `bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts`
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts:224`
- Test: `bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts`

**Interfaces:**
- Consumes: `type { SchemaCostReport, ToolCost }` from `../../pi-agent-cli/src/commands/schema-cost.ts`; `TRACKED_TOOLS` (newly exported) from `../extensions/tool-gate.ts`.
- Produces: `DEFAULT_COVERAGE_THRESHOLD` (number), `UngatedTool` + `CoverageReport` (interfaces), `analyzeCoverage(report, threshold, root): CoverageReport`, `formatCoverage(r): string[]`, `assertSane(r): string[]`. (Task 2 adds `measureCoverage` + `main` to the same file.)

- [ ] **Step 1: Export TRACKED_TOOLS**

In `extensions/tool-gate.ts:224`, change:
```ts
const TRACKED_TOOLS = new Set([...CORE_TOOLS, ...GATES.flatMap((g) => g.names)]);
```
to:
```ts
export const TRACKED_TOOLS = new Set([...CORE_TOOLS, ...GATES.flatMap((g) => g.names)]);
```
(Add the word `export` only. The immediately-following doc comment already explains it; leave it.)

- [ ] **Step 2: Write the failing test file**

Create `qa/coverage.test.ts`:
```ts
/**
 * Tests for the coverage analyzer (close the measurement→action loop).
 *
 * The pure core (analyzeCoverage) is exercised against a hand-crafted
 * SchemaCostReport fixture — no agent boot, no repo discovery. One structural
 * integration test (measureCoverage) runs the real collector at the end.
 */
import { describe, expect, it } from "bun:test";
import {
	analyzeCoverage,
	formatCoverage,
	assertSane,
	DEFAULT_COVERAGE_THRESHOLD,
} from "./coverage.ts";
import type { SchemaCostReport, ToolCost } from "../../pi-agent-cli/src/commands/schema-cost.ts";

/** Minimal ToolCost fixture — only the fields analyzeCoverage reads matter. */
const tool = (name: string, approxTokens: number, source: string): ToolCost =>
	({ name, descLen: 0, paramsLen: 0, approxTokens, source }) as ToolCost;

/** Build a SchemaCostReport shell from a tool list (totals derived). */
function report(tools: ToolCost[]): SchemaCostReport {
	return {
		tools,
		totalTokens: tools.reduce((s, t) => s + t.approxTokens, 0),
		builtinCount: tools.filter((t) => t.source === "(builtin)").length,
		extensionCount: tools.filter((t) => t.source !== "(builtin)").length,
		errors: [],
	} as SchemaCostReport;
}

const ROOT = "/fake/repo";
const TH = DEFAULT_COVERAGE_THRESHOLD; // 300

describe("analyzeCoverage", () => {
	it("reports a heavy tool NOT in TRACKED_TOOLS as ungated", () => {
		const r = analyzeCoverage(report([tool("synthetic_heavy", 500, "some-ext")]), TH, ROOT);
		expect(r.ungated.map((u) => u.name)).toEqual(["synthetic_heavy"]);
		expect(r.heavyTools).toBe(1);
		expect(r.gatedHeavy).toBe(0);
		expect(r.pass).toBe(false);
	});

	it("counts a heavy TRACKED tool as gatedHeavy (not ungated)", () => {
		// "flux2" is a real gate name → present in TRACKED_TOOLS
		const r = analyzeCoverage(report([tool("flux2", 500, "movie-director")]), TH, ROOT);
		expect(r.gatedHeavy).toBe(1);
		expect(r.ungated).toEqual([]);
		expect(r.pass).toBe(true);
	});

	it("never reports a builtin, even if heavy", () => {
		const r = analyzeCoverage(report([tool("bash", 9999, "(builtin)")]), TH, ROOT);
		expect(r.ungated).toEqual([]);
		expect(r.heavyTools).toBe(0); // builtins excluded from the heavy count
		expect(r.gatedHeavy).toBe(0);
		expect(r.pass).toBe(true);
	});

	it("ignores sub-threshold tools", () => {
		const r = analyzeCoverage(report([tool("synthetic_small", 100, "some-ext")]), TH, ROOT);
		expect(r.ungated).toEqual([]);
		expect(r.heavyTools).toBe(0);
		expect(r.pass).toBe(true);
	});

	it("sorts ungated desc by tokens", () => {
		const r = analyzeCoverage(
			report([tool("a", 400, "x"), tool("b", 900, "x"), tool("c", 600, "x")]),
			TH,
			ROOT,
		);
		expect(r.ungated.map((u) => u.name)).toEqual(["b", "c", "a"]);
	});

	it("respects a threshold override lower than default", () => {
		// 250 < default 300 but >= 200 → caught only under the override
		const r = analyzeCoverage(report([tool("synthetic_mid", 250, "x")]), 200, ROOT);
		expect(r.ungated.map((u) => u.name)).toEqual(["synthetic_mid"]);
		expect(r.threshold).toBe(200);
	});

	it("passes root through to the report", () => {
		const r = analyzeCoverage(report([]), TH, ROOT);
		expect(r.root).toBe(ROOT);
		expect(r.totalTools).toBe(0);
	});
});

describe("formatCoverage", () => {
	it("renders a healthy (✅) report when nothing is ungated", () => {
		const r = analyzeCoverage(report([tool("flux2", 500, "md")]), TH, ROOT);
		const out = formatCoverage(r).join("\n");
		expect(out).toContain("✅");
		expect(out).not.toContain("NOT gated");
	});

	it("renders a gap (❌) + the ungated tool list when something is missing", () => {
		const r = analyzeCoverage(report([tool("synthetic_heavy", 500, "x")]), TH, ROOT);
		const out = formatCoverage(r).join("\n");
		expect(out).toContain("❌");
		expect(out).toContain("synthetic_heavy");
	});
});

describe("assertSane", () => {
	it("flags a non-positive threshold", () => {
		const r = analyzeCoverage(report([tool("flux2", 500, "md")]), -1, ROOT);
		expect(assertSane(r).some((p) => p.includes("threshold"))).toBe(true);
	});

	it("flags an empty report (no tools captured)", () => {
		const r = analyzeCoverage(report([]), TH, ROOT);
		expect(assertSane(r).some((p) => p.includes("no tools"))).toBe(true);
	});

	it("is clean for a normal report", () => {
		const r = analyzeCoverage(report([tool("flux2", 500, "md")]), TH, ROOT);
		expect(assertSane(r)).toEqual([]);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test qa/coverage.test.ts )`
Expected: FAIL — `Cannot find module "./coverage.ts"` (file does not exist yet).

- [ ] **Step 4: Write the pure core of coverage.ts**

Create `qa/coverage.ts` with ONLY the pure core (no `measureCoverage`, no `main` yet — those land in Task 2):
```ts
/**
 * Coverage measurement — QA harness (close the measurement→action loop).
 *
 * Question: which registered tools are heavy (≥ threshold tok/req) but NOT
 * tracked by any tool-gate gate — i.e. candidates the author forgot to gate?
 *
 * power-tool's schema-cost measures every tool's per-request token cost;
 * tool-gate's GATES array is hand-maintained. If a heavy extension lands but is
 * never added to a gate, tool-gate's fail-open design keeps it always-active
 * (safe — no breakage) but the savings silently degrade. This QA surfaces that
 * gap so the loop closes: schema-cost measures → coverage finds the ungated
 * heavy → author adds a gate → savings confirms the recovery.
 *
 * Pure core (analyzeCoverage) is separated from the one buildSchemaCostReport
 * call so it is unit-testable against a fixture without booting collection.
 *
 * Run: `bun run qa:coverage`  (wired in package.json)
 */
import type { SchemaCostReport } from "../../pi-agent-cli/src/commands/schema-cost.ts";
import { TRACKED_TOOLS } from "../extensions/tool-gate.ts";

/** Heavy tools at or above this per-request token cost are coverage candidates. */
export const DEFAULT_COVERAGE_THRESHOLD = 300;

/** A heavy tool that no gate tracks. */
export interface UngatedTool {
	name: string;
	tokens: number;
	source: string;
}

/** The coverage verdict. `pass === (ungated.length === 0)`. */
export interface CoverageReport {
	/** Repo root the measurement ran against. */
	root: string;
	/** Token threshold used for this run. */
	threshold: number;
	/** Total tools captured (builtins + extensions). */
	totalTools: number;
	/** Non-builtin tools at/above threshold. */
	heavyTools: number;
	/** Heavy tools NOT in TRACKED_TOOLS — the findings (sorted desc by tokens). */
	ungated: UngatedTool[];
	/** Heavy tools that ARE tracked — healthy. */
	gatedHeavy: number;
	/** True iff ungated is empty. */
	pass: boolean;
}

/**
 * Pure: classify a captured report into the coverage verdict. No I/O.
 * Builtins (source === "(builtin)") are never heavy and never reported.
 */
export function analyzeCoverage(
	report: SchemaCostReport,
	threshold: number,
	root: string,
): CoverageReport {
	const ungated: UngatedTool[] = [];
	let heavyTools = 0;
	let gatedHeavy = 0;
	for (const t of report.tools) {
		if (t.source === "(builtin)") continue; // builtins can't be gated
		if (t.approxTokens < threshold) continue; // below threshold = not heavy
		heavyTools++;
		if (TRACKED_TOOLS.has(t.name)) {
			gatedHeavy++;
			continue;
		}
		ungated.push({ name: t.name, tokens: t.approxTokens, source: t.source });
	}
	ungated.sort((a, b) => b.tokens - a.tokens);
	return {
		root,
		threshold,
		totalTools: report.tools.length,
		heavyTools,
		ungated,
		gatedHeavy,
		pass: ungated.length === 0,
	};
}

/** Human-readable report. */
export function formatCoverage(r: CoverageReport): string[] {
	const lines: string[] = [
		`threshold:   ${r.threshold} tok/req`,
		`tools:       ${r.totalTools} total · ${r.heavyTools} heavy (excl. builtins) · ${r.gatedHeavy} gated-heavy ✅`,
		`ungated:     ${r.ungated.length} heavy tool(s) not tracked by any gate`,
	];
	if (r.ungated.length) {
		lines.push("", "heavy tools NOT gated (candidates the author forgot):");
		for (const u of r.ungated) lines.push(`  ${u.tokens.toString().padStart(5)} tok  ${u.name}  [${u.source}]`);
		lines.push("", "❌ coverage gap — add a GATE entry (extensions/tool-gate.ts) or confirm intentional always-on");
	} else {
		lines.push("", "✅ every heavy tool is tracked by a gate (or is a builtin)");
	}
	return lines;
}

/** Hard structural assertions (always-gating if violated). */
export function assertSane(r: CoverageReport): string[] {
	const problems: string[] = [];
	if (r.threshold <= 0) problems.push("threshold <= 0 — nonsensical");
	if (r.totalTools === 0) problems.push("no tools captured — schema-cost collection returned nothing");
	if (r.heavyTools < r.gatedHeavy) problems.push("gatedHeavy > heavyTools — impossible");
	return problems;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test qa/coverage.test.ts )`
Expected: PASS — all `analyzeCoverage`/`formatCoverage`/`assertSane` cases green.

- [ ] **Step 6: Run the full package suite to confirm the TRACKED_TOOLS export broke nothing**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: all pre-existing tests still pass (the export is additive, zero behavior change).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/qa/coverage.ts \
        bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts \
        bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts
git commit -m "feat(tool-gate): add coverage pure core (analyzeCoverage) + export TRACKED_TOOLS"
```

---

## Task 2: measureCoverage wrapper + runnable entry + qa:coverage script

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/coverage.ts` (append async wrapper + `main`)
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts` (append integration test)
- Modify: `bun-apps/pi-agent-ext-tool-gate/package.json` (add `qa:coverage` script)
- Test: `bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts`

**Interfaces:**
- Consumes: `buildSchemaCostReport`, `resolveRepoRoot` from `../../pi-agent-cli/src/commands/schema-cost.ts`; `analyzeCoverage` from Task 1.
- Produces: `measureCoverage(root?, threshold?): Promise<CoverageReport>` — the async entrypoint `qa/run.ts` (Task 3) and the `qa:coverage` script call.

- [ ] **Step 1: Merge the value imports into the top import block**

`measureCoverage` needs `buildSchemaCostReport` + `resolveRepoRoot` as VALUES (not just the type). Task 1 imported only `type SchemaCostReport`. Merge the value imports into that same top line (keep imports at the top — never mid-file; TS hoists them but mid-file imports are bad style).

In `qa/coverage.ts`, change the existing top import:
```ts
import type { SchemaCostReport } from "../../pi-agent-cli/src/commands/schema-cost.ts";
import { TRACKED_TOOLS } from "../extensions/tool-gate.ts";
```
to:
```ts
import { buildSchemaCostReport, resolveRepoRoot, type SchemaCostReport } from "../../pi-agent-cli/src/commands/schema-cost.ts";
import { TRACKED_TOOLS } from "../extensions/tool-gate.ts";
```

- [ ] **Step 2: Append the async wrapper + runnable main to coverage.ts**

At the END of `qa/coverage.ts` (after `assertSane`), append (NO import here — they're at the top now):
```ts

// --- async collection + runnable entry -------------------------------------

/**
 * Measure coverage against the real repo, offline (capturing-mock collection —
 * no agent boot; same path `qa/savings.ts` uses). Pass an explicit `root`, or
 * omit to auto-resolve (walk up to `bun-apps/`).
 */
export async function measureCoverage(
	root?: string,
	threshold?: number,
): Promise<CoverageReport> {
	const resolved = root ?? resolveRepoRoot();
	const th = threshold ?? DEFAULT_COVERAGE_THRESHOLD;
	const report = await buildSchemaCostReport(resolved);
	return analyzeCoverage(report, th, resolved);
}

async function main() {
	const r = await measureCoverage();
	console.log(formatCoverage(r).join("\n"));
	const problems = assertSane(r);
	if (problems.length) {
		console.error("\n❌ STRUCTURAL FAIL:");
		for (const p of problems) console.error("  - " + p);
		process.exit(1);
	}
	console.log(`\n${r.pass ? "✅" : "❌"} coverage ${r.pass ? "complete" : `gap: ${r.ungated.length} ungated`} (non-gating by default)`);
}

// Bun: run only when invoked directly (`bun run qa:coverage`).
if (import.meta.main) void main();
```

- [ ] **Step 3: Append the integration test to coverage.test.ts**

At the END of `qa/coverage.test.ts`, append:
```ts

describe("measureCoverage (integration — real repo)", () => {
	it("collects the real repo and is structurally sane", async () => {
		const { measureCoverage } = await import("./coverage.ts");
		const r = await measureCoverage();
		// Structural sanity (NOT a brittle count): the repo has tools and the
		// collector didn't fall over. The exact ungated count is intentionally
		// NOT asserted — a non-zero ungated is a real finding, not a test failure.
		expect(r.totalTools).toBeGreaterThan(0);
		expect(assertSane(r)).toEqual([]);
		// The repo gates at least one heavy tool (e.g. flux2 / ltx / movie-*).
		expect(r.gatedHeavy).toBeGreaterThanOrEqual(1);
	});
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test qa/coverage.test.ts )`
Expected: PASS — all Task-1 cases plus the new integration case. (The integration case boots the offline capturing-mock collector; if it is slow in CI it may be gated later, but it is offline and deterministic.)

- [ ] **Step 5: Add the qa:coverage script**

In `package.json`, in the `"scripts"` object, add one line (preserve trailing commas / existing entries):
```json
    "qa:coverage": "bun run qa/coverage.ts",
```
Place it alongside `"qa:miss"` / `"qa:savings"`.

- [ ] **Step 6: Run the standalone script to confirm end-to-end output**

Run: `bun run --cwd bun-apps/pi-agent-ext-tool-gate qa:coverage`
Expected: prints the threshold/tools/ungated lines + a `✅ coverage complete` (if the repo is fully gated) or `❌ coverage gap: N ungated` followed by the list. Either is acceptable — a gap is a real finding, not a failure of this task. Exit code 0 (assertSane passes).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/qa/coverage.ts \
        bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts \
        bun-apps/pi-agent-ext-tool-gate/package.json
git commit -m "feat(tool-gate): add measureCoverage wrapper + qa:coverage script + integration test"
```

---

## Task 3: wire coverage into qa/run.ts (report + flag + verdict)

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/run.ts` (imports, `QaOptions`, `QaResult`, `runQa` body, `formatReport`, `formatJson`, `parseArgs`, `main` summary)
- Test: no `run.test.ts` exists — verify via the `bun run qa` commands below.

**Interfaces:**
- Consumes: `measureCoverage`, `formatCoverage`, `assertSane` (aliased) , `CoverageReport` from `./coverage.ts`.
- Produces: `QaResult.coverage` + `QaResult.coverageProblems`; `QaOptions.coverageThreshold`; the `--coverage-threshold` CLI flag; a `## Coverage` report block.

> ⚠️ The savings module ALSO exports `assertSane`. Import coverage's under an alias to avoid a name clash.

- [ ] **Step 1: Add the coverage import**

At the top of `qa/run.ts`, immediately after the existing savings import:
```ts
import { measureSavings, formatSavings, assertSane, caveats, type SavingsReport } from "./savings.ts";
```
add:
```ts
import {
	measureCoverage,
	formatCoverage,
	assertSane as assertCoverageSane,
	type CoverageReport,
} from "./coverage.ts";
```

- [ ] **Step 2: Add coverageThreshold to QaOptions**

In the `QaOptions` interface, add a field:
```ts
export interface QaOptions {
	root?: string;
	strict?: boolean;
	l2?: boolean;
	model?: string;
	out?: string;
	json?: boolean;
	coverageThreshold?: number;
}
```

- [ ] **Step 3: Add coverage fields to QaResult**

In the `QaResult` interface, add two fields (place them after `savingsProblems` for locality):
```ts
	coverage: CoverageReport;
	coverageProblems: string[];
```
(Full updated interface for clarity — replace the existing `QaResult` block:
```ts
export interface QaResult {
	timestamp: string;
	root: string;
	mode: { strict: boolean; l2: boolean; model?: string };
	savings: SavingsReport;
	coverage: CoverageReport;
	corpus: CorpusResult;
	l2: L2Block;
	savingsProblems: string[];
	coverageProblems: string[];
	savingsFloorMet: boolean;
	pass: boolean;
	reason: string;
}
```
)

- [ ] **Step 4: Update runQa to measure coverage + fold into the verdict**

Replace the body of `runQa` from the `const savings = await measureSavings(opts.root);` line through the `return { ... };` with:
```ts
	const savings = await measureSavings(opts.root);
	const coverage = await measureCoverage(opts.root, opts.coverageThreshold);
	const corpus = evaluateCorpus();

	let l2: L2Block;
	if (opts.l2) {
		const rows = evaluateReachability();
		const live = await runLive(undefined, { model: opts.model } as LiveOpts);
		l2 = { enabled: true, reachability: summarizeReachability(rows), rows, live };
	} else {
		l2 = { enabled: false, reachability: null, rows: [], live: { ran: false, reason: "skipped (pass --l2)" } };
	}

	const savingsProblems = assertSane(savings);
	const coverageProblems = assertCoverageSane(coverage);
	const savingsFloorMet = savings.savedPct >= SAVINGS_FLOOR.pct && savings.savedTok >= SAVINGS_FLOOR.tok;
	const sane = savingsProblems.length === 0 && coverageProblems.length === 0;
	const intendedOk = corpus.intendedPass && sane;
	const strictOk = corpus.taskBreakingGates.length === 0; // false-fires excluded
	const strictCoverageOk = coverage.ungated.length === 0; // coverage gate (--strict only)
	const pass =
		(opts.strict ? intendedOk && strictOk && strictCoverageOk : intendedOk) && savingsFloorMet;
	const reason = !savingsFloorMet
		? `savings below floor (need ≥${SAVINGS_FLOOR.pct}% AND ≥${SAVINGS_FLOOR.tok.toLocaleString()} tok; got ${savings.savedPct}%/${savings.savedTok.toLocaleString()})`
		: !corpus.intendedPass
			? `L1 intended-behavior bar failed (see must-fire/must-not-fire/escape cases)`
			: !sane
				? `savings/coverage structurally broken: ${[...savingsProblems, ...coverageProblems].join("; ")}`
				: opts.strict && !strictOk
					? `--strict: ${corpus.taskBreakingGates.length} task-breaking gate(s) open (${corpus.taskBreakingGates.join(", ")}) — false-fires excluded`
					: opts.strict && !strictCoverageOk
						? `--strict: ${coverage.ungated.length} ungated heavy tool(s) (${coverage.ungated.map((u) => u.name).join(", ")}) — add a gate or confirm always-on`
						: "savings floor met + L1 intended-behavior holds; task-breaking gates + coverage reported (use --strict to gate on them)";

	return {
		timestamp: new Date().toISOString(),
		root: savings.root,
		mode: { strict: !!opts.strict, l2: !!opts.l2, model: opts.model },
		savings,
		coverage,
		corpus,
		l2,
		savingsProblems,
		coverageProblems,
		savingsFloorMet,
		pass,
		reason,
	};
```

- [ ] **Step 5: Render the Coverage block in formatReport**

In `formatReport`, immediately after the Savings block's floor line:
```ts
		`- savings floor (≥${SAVINGS_FLOOR.pct}% AND ≥${SAVINGS_FLOOR.tok.toLocaleString()} tok): ${r.savingsFloorMet ? "✅ met" : "❌ NOT met"}`,
		``,
```
insert (before the `## Layer-1 capability (deterministic)` line):
```ts
		`## Coverage`,
		...formatCoverage(r.coverage),
		`- coverage verdict: ${r.coverage.pass ? "✅ complete" : `❌ ${r.coverage.ungated.length} ungated`} — ${r.mode.strict ? "GATING (--strict)" : "non-gating by default"}`,
		``,
```

- [ ] **Step 6: Add coverage to formatJson**

In `formatJson`, inside the object passed to `JSON.stringify`, add a `coverage` key (e.g. after the `savings` block):
```ts
			coverage: {
				threshold: r.coverage.threshold,
				totalTools: r.coverage.totalTools,
				heavyTools: r.coverage.heavyTools,
				gatedHeavy: r.coverage.gatedHeavy,
				ungated: r.coverage.ungated,
				pass: r.coverage.pass,
				structuralProblems: r.coverageProblems,
			},
```

- [ ] **Step 7: Add a coverage line to the main() summary**

In `main()`, in the `summary` array, after the `L1:` line and before the `capability:` line (or after `capability:` — either is fine; place it after `L1:` for grouping), add:
```ts
		`coverage:  ${r.coverage.ungated.length} ungated heavy tool(s) · ${r.coverage.gatedHeavy} gated-heavy  [${r.coverage.pass ? "✅" : "❌"}${r.mode.strict ? " --strict gates" : " non-gating"}]`,
```

- [ ] **Step 8: Parse the --coverage-threshold flag**

In `parseArgs`, inside the `for` loop, add a branch (e.g. after the `--root` branch):
```ts
		else if (a === "--coverage-threshold") opts.coverageThreshold = Number(argv[++i]);
```

- [ ] **Step 9: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bunx tsc --noEmit && echo TYPECHECK_OK )`
Expected: `TYPECHECK_OK` (no type errors; the alias + new fields all resolve).

- [ ] **Step 10: Verify the QA gate end-to-end**

Run all four (the spec's verification matrix):
```bash
( cd bun-apps/pi-agent-ext-tool-gate && bun test )                                    # suite still green
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa                                       # default: coverage non-gating, exit 0
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa --coverage-threshold 200              # override flows through
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa --strict                              # coverage now gates; exit 0 if repo fully gated
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa --json | head -40                     # coverage key present in JSON
```
Expected: suite green; each `qa` run prints a `coverage:` summary line and a `## Coverage` block in the written report; `--strict` exits 0 (repo is currently fully gated — if it is NOT, that is a real finding to surface to the user, not a failure of this task; report it).

- [ ] **Step 11: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/qa/run.ts
git commit -m "feat(tool-gate): wire coverage into qa/run.ts (report + --coverage-threshold + --strict gate)"
```

---

## Task 4: document the coverage axis in README

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/README.md` (add a Coverage subsection alongside the existing Savings / Miss-rate QA docs)

**Interfaces:** none (docs only).

- [ ] **Step 1: Read the existing QA docs section**

Read `bun-apps/pi-agent-ext-tool-gate/README.md` and locate where `qa/savings.ts` / `qa/miss-rate.ts` are documented (the QA / verification section). The new subsection mirrors their shape.

- [ ] **Step 2: Add the Coverage subsection**

Add a `### Coverage` subsection alongside the savings/miss-rate docs, with this content (adapt heading level to match neighbors):
```markdown
### Coverage (`qa/coverage.ts`)

A third QA axis — **structural completeness** — alongside savings (amount) and
miss-rate (recall). It answers: *which registered tools are heavy (≥ threshold
tok/req) but NOT tracked by any gate — i.e. candidates the author forgot to gate?*

A forgotten gate is safe (fail-open keeps the tool always-active) but silently
degrades savings. This check closes the loop: schema-cost measures → coverage
finds the ungated heavy → author adds a gate → savings confirms the recovery.

\`\`\`bash
bun run qa:coverage                       # standalone, advisory (never fails)
bun run qa:coverage --coverage-threshold 200   # tighten the threshold for a run
bun run qa                                # coverage reported, non-gating by default
bun run qa --strict                       # ungated heavy tools → FAIL
\`\`\`

Default threshold **300 tok/req** (`--coverage-threshold` overrides). Builtins
are excluded (they cannot be gated). The verdict is **non-gating by default**;
under `--strict`, any ungated heavy tool fails the gate.
```
(Use real triple-backticks, not the escaped `\`\`\`` shown above.)

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/README.md
git commit -m "docs(tool-gate): document the coverage QA axis"
```

---

## Verification (whole plan)

```bash
# unit + integration
( cd bun-apps/pi-agent-ext-tool-gate && bun test )

# the new QA standalone
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa:coverage

# full QA gate still passes (coverage is non-gating by default)
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa

# --strict surfaces coverage as a gate (should still pass if repo is fully gated)
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa --strict
```

**Success =** all tests green + `qa:coverage` runs and reports a stable `gatedHeavy` count + `bun run qa` unchanged (non-gating) + `qa --strict` still passes (repo currently fully gated; if not, that is a real finding to surface, not a test failure).

## Out of scope (do NOT implement in this plan)

- Usage-aware auto-tuning (gate by call frequency, not just schema cost) — stays fog.
- Power-tool runtime nudge message ("consider gating / lazy-loading") — decoupled follow-up.
- Eliminating the `/ 4` heuristic duplication between tool-gate's `measureToolTokens` and power-tool's `estimateTokens` — separate follow-up; coverage is immune (uses `buildSchemaCostReport`).
- Changing the core pipeline (`updateSticky`/`filterActive`/`gateFires`) or the fail-open + sticky contract.
