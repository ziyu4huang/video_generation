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

