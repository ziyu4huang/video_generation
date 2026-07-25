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

