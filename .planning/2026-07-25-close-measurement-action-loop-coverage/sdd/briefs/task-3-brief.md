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

