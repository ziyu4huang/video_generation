# GLM Speed & Effectiveness Benchmark (`bench-agent`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a permanent `cli bench-agent` harness that measures wall-clock speed, token economics, and task quality per GLM model×thinking config, then tune `pre-load-providers.ts` from the data.

**Architecture:** New bench core (pure functions: metrics extraction, report rendering, config matrix) + committed task fixtures (needle / code-edit / cross-file-analysis) + a `bench-agent` CLI command that runs each config×task cell through the existing `createSharedSession` headless path, applies deterministic quality gates, and emits `results.jsonl` + `REPORT.md`. A `--probe prefill` mode A/Bs full vs stripped tool loads. Tuning of `src/pre-load-providers.ts` follows the data.

**Tech Stack:** Bun + TypeScript, pi SDK `createAgentSession` (via `src/cli/sessions/shared.ts`), `bun test`.

**Spec:** `.planning/specs/2026-08-30-glm-speed-benchmark-design.md`

## Global Constraints

- Package: `bun-apps/s2-agent`. All commands run from repo root: `bun bun-apps/s2-agent/src/cli.ts cli bench-agent …`
- Tests: `bun test` inside `bun-apps/s2-agent`; typecheck `bun run typecheck`. Canonical gate: `bun run typecheck && bun test`.
- No edits to vendor code; no new npm deps; Bun APIs only (no node:child_process spawn of python).
- Sessions must be created with `cwd` = the per-run temp fixture dir so session JSONLs never land in the repo's sessions namespace and fixture edits never touch the repo.
- Bench exit code: 0 unless a harness error (a failed cell is recorded data, not a CI failure).
- Fixtures committed under `bun-apps/s2-agent/bench/tasks/`; run outputs under `bun-apps/s2-agent/output/bench-agent/<ISO-ts>/` (gitignored).
- Scope of tuning changes: `bun-apps/s2-agent/src/pre-load-providers.ts` (+ its pinned test) ONLY — no extension config changes.

---

### Task 1: Bench core library (pure) + unit tests

**Files:**
- Create: `bun-apps/s2-agent/src/cli/bench/core.ts`
- Create: `bun-apps/s2-agent/src/cli/bench/core.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Tasks 2–3):
  - `interface BenchConfig { id: string; model: string; thinking: string }`
  - `const DEFAULT_CONFIGS: BenchConfig[]`
  - `interface RunMetrics { wallMs: number; turns: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number; medianTurnMs: number; p90TurnMs: number; tokensPerSec: number; reasoningRatio: number; cacheHitRatio: number }`
  - `interface MetricsMessage { role: string; content?: { type: string; text?: string }[]; usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }; timestamp?: number }`
  - `function extractMetrics(messages: MetricsMessage[], wallMs: number): RunMetrics`
  - `function finalAssistantText(messages: MetricsMessage[]): string`
  - `interface QualityResult { pass: boolean; detail: string }`
  - `interface CellResult { configId: string; taskId: string; ok: boolean; error?: string; metrics: RunMetrics | null; quality: QualityResult | null }`
  - `function renderReport(results: CellResult[], meta: { startedAt: string; dry: boolean }): string`

- [ ] **Step 1: Write the failing tests** — `core.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIGS, extractMetrics, finalAssistantText, renderReport } from "./core.ts";

// Timestamps in ms. user@1000 → assistant@11000 (usage 400 in / 800 out / 300 reasoning /
// 600 cacheRead / 0 cacheWrite) → toolResult@12000 → assistant@20000 (usage 3500 in / 500 out /
// 200 reasoning / 3450 cacheRead).
const MESSAGES = [
	{ role: "user", content: [{ type: "text", text: "do the task" }], timestamp: 1000 },
	{
		role: "assistant",
		content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "working" }],
		usage: { input: 400, output: 800, reasoning: 300, cacheRead: 600, cacheWrite: 0 },
		timestamp: 11000,
	},
	{ role: "toolResult", content: [], timestamp: 12000 },
	{
		role: "assistant",
		content: [{ type: "text", text: "NEEDLE-7Q4X9M2B" }],
		usage: { input: 3500, output: 500, reasoning: 200, cacheRead: 3450, cacheWrite: 100 },
		timestamp: 20000,
	},
];

describe("extractMetrics", () => {
	test("sums usage, derives turns/latency/ratios", () => {
		const m = extractMetrics(MESSAGES, 20000);
		expect(m.turns).toBe(2);
		expect(m.inputTokens).toBe(3900);
		expect(m.outputTokens).toBe(1300);
		expect(m.reasoningTokens).toBe(500);
		// reasoning is a SUBSET of output (pi-ai contract): ratio = 500/1300.
		expect(m.reasoningRatio).toBeCloseTo(0.3846, 3);
		// cacheRead / (cacheRead + input + cacheWrite) = 4050/7500.
		expect(m.cacheHitRatio).toBeCloseTo(0.54, 2);
		// per-turn durations: 11000-1000=10000, 20000-12000=8000 → median 9000, p90 9800.
		expect(m.medianTurnMs).toBe(9000);
		expect(m.p90TurnMs).toBe(9800);
		// output tokens over generation seconds: 1300 / 18s.
		expect(m.tokensPerSec).toBeCloseTo(72.2, 1);
	});
	test("empty messages → zeroed metrics, no NaN", () => {
		const m = extractMetrics([], 1000);
		expect(m.turns).toBe(0);
		expect(Number.isNaN(m.reasoningRatio)).toBe(false);
		expect(m.reasoningRatio).toBe(0);
	});
});

describe("finalAssistantText", () => {
	test("joins text parts of the LAST assistant message, skips thinking", () => {
		expect(finalAssistantText(MESSAGES)).toBe("NEEDLE-7Q4X9M2B");
	});
	test("no assistant → empty string", () => {
		expect(finalAssistantText([{ role: "user", content: [], timestamp: 1 }])).toBe("");
	});
});

describe("DEFAULT_CONFIGS", () => {
	test("five focused configs, ids stable (flag --configs depends on them)", () => {
		expect(DEFAULT_CONFIGS.map((c) => c.id)).toEqual([
			"5.3-high", "5.3-medium", "5.3-low", "5.3-highspeed", "5.3-flash",
		]);
	});
});

describe("renderReport", () => {
	test("renders a markdown table with every cell + a per-config summary", () => {
		const r = renderReport(
			[
				{
					configId: "5.3-high", taskId: "needle", ok: true,
					metrics: extractMetrics(MESSAGES, 20000),
					quality: { pass: true, detail: "needle exact-match" },
				},
				{
					configId: "5.3-medium", taskId: "edit", ok: false, error: "timeout",
					metrics: null, quality: null,
				},
			],
			{ startedAt: "2026-08-30T00:00:00Z", dry: false },
		);
		expect(r).toContain("# bench-agent report");
		expect(r).toContain("| 5.3-high | needle |");
		expect(r).toContain("| 5.3-medium | edit |");
		expect(r).toContain("timeout");
		expect(r).toContain("## Per-config summary");
	});
});
```

- [ ] **Step 2: Run to verify failure** — `( cd bun-apps/s2-agent && bun test src/cli/bench/core.test.ts )` → FAIL (module not found).

- [ ] **Step 3: Implement `core.ts`:**

```ts
/**
 * bench/core — pure bench-agent primitives: config matrix, metrics extraction
 * from session messages, report rendering. NO session/LLM side effects here
 * (the command module owns those) so everything in this file is unit-testable.
 */
export interface BenchConfig { id: string; model: string; thinking: string }

export const DEFAULT_CONFIGS: BenchConfig[] = [
	{ id: "5.3-high", model: "zai/glm-5.3", thinking: "high" },
	{ id: "5.3-medium", model: "zai/glm-5.3", thinking: "medium" },
	{ id: "5.3-low", model: "zai/glm-5.3", thinking: "low" },
	{ id: "5.3-highspeed", model: "zai/glm-5.3-highspeed", thinking: "high" },
	{ id: "5.3-flash", model: "zai/glm-5.3-flash", thinking: "medium" },
];

export interface MetricsMessage {
	role: string;
	content?: { type: string; text?: string }[];
	usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
	timestamp?: number;
}

export interface RunMetrics {
	wallMs: number; turns: number;
	inputTokens: number; outputTokens: number; reasoningTokens: number;
	cacheReadTokens: number; cacheWriteTokens: number;
	medianTurnMs: number; p90TurnMs: number; tokensPerSec: number;
	reasoningRatio: number; cacheHitRatio: number;
}

export interface QualityResult { pass: boolean; detail: string }
export interface CellResult {
	configId: string; taskId: string; ok: boolean; error?: string;
	metrics: RunMetrics | null; quality: QualityResult | null;
}

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}
function p90(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

export function extractMetrics(messages: MetricsMessage[], wallMs: number): RunMetrics {
	let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0;
	let turns = 0;
	const durations: number[] = [];
	let prevTs: number | undefined;
	for (const m of messages) {
		const ts = m.timestamp;
		if (m.role === "assistant" && m.usage) {
			turns += 1;
			input += m.usage.input ?? 0;
			output += m.usage.output ?? 0;
			reasoning += m.usage.reasoning ?? 0;
			cacheRead += m.usage.cacheRead ?? 0;
			cacheWrite += m.usage.cacheWrite ?? 0;
			if (prevTs !== undefined && ts !== undefined && ts > prevTs) durations.push(ts - prevTs);
		}
		if (ts !== undefined) prevTs = ts;
	}
	const genSec = durations.reduce((a, b) => a + b, 0) / 1000;
	const denom = cacheRead + input + cacheWrite;
	return {
		wallMs, turns,
		inputTokens: input, outputTokens: output, reasoningTokens: reasoning,
		cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
		medianTurnMs: median(durations), p90TurnMs: p90(durations),
		tokensPerSec: genSec > 0 ? output / genSec : 0,
		reasoningRatio: output > 0 ? reasoning / output : 0,
		cacheHitRatio: denom > 0 ? cacheRead / denom : 0,
	};
}

export function finalAssistantText(messages: MetricsMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && Array.isArray(m.content)) {
			return m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
		}
	}
	return "";
}

export function renderReport(results: CellResult[], meta: { startedAt: string; dry: boolean }): string {
	const lines: string[] = [];
	lines.push(`# bench-agent report — ${meta.startedAt}${meta.dry ? " (DRY)" : ""}`, "");
	lines.push("| config | task | wall(s) | turns | out tok | reason tok | reason% | tok/s | med turn(s) | p90(s) | cache% | quality |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const r of results) {
		const m = r.metrics;
		const row = m
			? `| ${r.configId} | ${r.taskId} | ${(m.wallMs / 1000).toFixed(1)} | ${m.turns} | ${m.outputTokens} | ${m.reasoningTokens} | ${(m.reasoningRatio * 100).toFixed(0)} | ${m.tokensPerSec.toFixed(1)} | ${(m.medianTurnMs / 1000).toFixed(1)} | ${(m.p90TurnMs / 1000).toFixed(1)} | ${(m.cacheHitRatio * 100).toFixed(0)} | ${r.ok ? (r.quality?.pass ? "PASS" : `FAIL(${r.quality?.detail ?? "?"})`) : `ERROR(${r.error ?? "?"})`} |`
			: `| ${r.configId} | ${r.taskId | ""} | - | - | - | - | - | - | - | - | - | ERROR(${r.error ?? "?"}) |`;
		lines.push(row);
	}
	lines.push("", "## Per-config summary", "");
	lines.push("| config | cells ok | quality pass | mean wall(s) | mean reason% |");
	lines.push("|---|---|---|---|---|");
	for (const cfg of [...new Set(results.map((r) => r.configId))]) {
		const cells = results.filter((r) => r.configId === cfg);
		const okc = cells.filter((r) => r.ok);
		const qc = cells.filter((r) => r.quality?.pass);
		const meanWall = okc.length ? okc.reduce((a, r) => a + (r.metrics?.wallMs ?? 0), 0) / okc.length / 1000 : 0;
		const meanReason = okc.length ? (okc.reduce((a, r) => a + (r.metrics?.reasoningRatio ?? 0), 0) / okc.length) * 100 : 0;
		lines.push(`| ${cfg} | ${okc.length}/${cells.length} | ${qc.length}/${cells.length} | ${meanWall.toFixed(1)} | ${meanReason.toFixed(0)} |`);
	}
	return lines.join("\n");
}
```

NOTE the deliberate guard: `r.taskId | ""` is wrong-looking on purpose? NO — implementer: write `| ${r.taskId} |` (plain). That `| ""` alternative must NOT be typed; the table cell is `${r.taskId}`.

- [ ] **Step 4: Run tests** — `( cd bun-apps/s2-agent && bun test src/cli/bench/core.test.ts )` → PASS.

- [ ] **Step 5: Commit** — `git add bun-apps/s2-agent/src/cli/bench/ && git commit -m "feat(bench): pure bench core — config matrix, metrics extraction, report rendering"`

---

### Task 2: Task fixtures + deterministic quality gates

**Files:**
- Create: `bun-apps/s2-agent/bench/tasks/needle/TASK.md`
- Create: `bun-apps/s2-agent/bench/tasks/needle/data.txt`
- Create: `bun-apps/s2-agent/bench/tasks/needle/expected.json`
- Create: `bun-apps/s2-agent/bench/tasks/edit/TASK.md`
- Create: `bun-apps/s2-agent/bench/tasks/edit/src/calc.ts`
- Create: `bun-apps/s2-agent/bench/tasks/edit/src/calc.test.ts`
- Create: `bun-apps/s2-agent/bench/tasks/analysis/TASK.md`
- Create: `bun-apps/s2-agent/bench/tasks/analysis/src/{users.ts,orders.json,config.ts,NOTES.md}`
- Create: `bun-apps/s2-agent/bench/tasks/analysis/expected.json`
- Create: `bun-apps/s2-agent/src/cli/bench/tasks.ts`
- Create: `bun-apps/s2-agent/src/cli/bench/tasks.test.ts`

**Interfaces:**
- Consumes: `QualityResult` from Task 1.
- Produces (used by Task 3):
  - `interface BenchTask { id: string; dir: string; tools: string[]; prompt: string; check: (assistantText: string, runDir: string) => Promise<QualityResult> }`
  - `const BENCH_TASKS: BenchTask[]` (prompt read from each fixture's `TASK.md` at module init)
  - `async function copyFixtureToTemp(task: BenchTask): Promise<string>` (returns temp dir path)

- [ ] **Step 1: Create fixture files.**

`needle/TASK.md`:
```markdown
Read `data.txt` in the current directory. Exactly one line contains a token of the
form `NEEDLE-XXXXXXXX`. Reply with ONLY that exact token, nothing else.
```

`needle/data.txt` (10 filler lines + the token on line 7; filler describes imaginary services so semantic shortcuts can't find it):
```
service-registry: alpha gateway listens on 8443
telemetry sink: batch size 512, flush every 30s
feature flags: canary cohort pinned at 12%
edge cache: ttl 300s, stale-while-revalidate on
quota ledger: refill 40/min burst 80
audit stream: topic partitions 6, retention 14d
deployment marker: NEEDLE-7Q4X9M2B acknowledged by controller
mesh policy: mTLS strict, rotation 24h
scheduler: max inflight jobs 64
billing reconciler: drift window 5m, tolerance 0.5%
```

`needle/expected.json`:
```json
{ "needle": "NEEDLE-7Q4X9M2B" }
```

`edit/TASK.md`:
```markdown
`src/calc.ts` implements `movingSum(values, window)` but its result is wrong for
every position after the first. Reproduce with `bun test src/calc.test.ts`
(2 of 3 tests fail), find the bug, and fix `src/calc.ts` so ALL tests pass.
You may ONLY modify `src/calc.ts` — never the test file.
```

`edit/src/calc.ts` (bug: accumulator never drops the outgoing element):
```ts
/** Sum of a sliding window of `window` elements, aligned to each end position. */
export function movingSum(values: number[], window: number): number[] {
	const out: number[] = [];
	let acc = 0;
	for (let i = 0; i < values.length; i++) {
		acc += values[i];
		// BUG: never subtracts the element leaving the window.
		if (i >= window) acc -= 0;
		out.push(acc);
	}
	return out;
}
```

`edit/src/calc.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { movingSum } from "./calc.ts";

describe("movingSum", () => {
	test("window larger than input: cumulative", () => {
		expect(movingSum([1, 2, 3], 5)).toEqual([1, 3, 6]);
	});
	test("sliding window drops outgoing elements", () => {
		expect(movingSum([1, 2, 3, 4], 2)).toEqual([1, 3, 5, 7]);
	});
	test("constant window", () => {
		expect(movingSum([5, 5, 5], 1)).toEqual([5, 5, 5]);
	});
});
```

`analysis/TASK.md`:
```markdown
Cross-reference the files in `src/` and answer with EXACTLY three lines:
1. <order-id of the first order whose buyer lives in the city whose region code is "NW">
2. <sku of the cheapest item in that order>
3. <name of the user who owns that order>
Use the data as-is; no code execution needed, just read the files.
```

`analysis/src/users.ts`:
```ts
export const users = [
	{ id: "u1", name: "Ada Cheng", city: "Port Meridian" },
	{ id: "u2", name: "Bo Tai", city: "Harbor Vale" },
	{ id: "u3", name: "Cleo Frost", city: "Northgate" },
];
```

`analysis/src/config.ts`:
```ts
export const regions: Record<string, string> = {
	"Port Meridian": "SE",
	"Harbor Vale": "NW",
	"Northgate": "NW",
};
```

`analysis/src/orders.json`:
```json
[
	{ "id": "ord-101", "buyer": "u3", "items": [{ "sku": "SKU-AX", "price": 30 }, { "sku": "SKU-BQ", "price": 12 }] },
	{ "id": "ord-102", "buyer": "u1", "items": [{ "sku": "SKU-CM", "price": 8 }] },
	{ "id": "ord-103", "buyer": "u2", "items": [{ "sku": "SKU-DP", "price": 25 }, { "sku": "SKU-EF", "price": 19 }] },
	{ "id": "ord-104", "buyer": "u3", "items": [{ "sku": "SKU-GH", "price": 22 }] }
]
```
(Correct chain: NW cities = Harbor Vale + Northgate → u3 (Northgate) is earliest NW buyer → ord-101 → cheapest item SKU-BQ → owner Cleo Frost.)

`analysis/src/NOTES.md`:
```markdown
# Order desk notes
- Orders are listed chronologically; ord-101 is the earliest.
- Region codes are keyed by CITY name, not by user id.
```

`analysis/expected.json`:
```json
{ "answers": ["ord-101", "SKU-BQ", "Cleo Frost"] }
```

- [ ] **Step 2: Write the failing tests** — `tasks.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_TASKS, copyFixtureToTemp, checkNeedle, checkEdit, checkAnalysis } from "./tasks.ts";

const tmpRoots: string[] = [];
afterAll(() => { for (const t of tmpRoots) rmSync(t, { recursive: true, force: true }); });

describe("BENCH_TASKS", () => {
	test("three tasks with prompts loaded from TASK.md", () => {
		expect(BENCH_TASKS.map((t) => t.id).sort()).toEqual(["analysis", "edit", "needle"]);
		for (const t of BENCH_TASKS) expect(t.prompt.length).toBeGreaterThan(20);
	});
});

describe("copyFixtureToTemp", () => {
	test("copies the fixture tree to a temp dir; repo file untouched by a write", () => {
		const task = BENCH_TASKS.find((t) => t.id === "needle")!;
		const dir = await copyFixtureToTemp(task);
		tmpRoots.push(dir);
		expect(join(dir, "data.txt")).toBeFile? undefined : null;
		// (use expect(...).toBeTruthy on existsSync instead — see below)
	});
});

describe("quality gates", () => {
	test("needle: exact token passes, near-miss fails", async () => {
		expect((await checkNeedle("NEEDLE-7Q4X9M2B", "/ignore")).pass).toBe(true);
		const near = await checkNeedle("The token is NEEDLE-7Q4X9M2B.", "/ignore");
		expect(near.pass).toBe(true); // substring match allowed: token must appear verbatim
		expect((await checkNeedle("NEEDLE-XXXX", "/ignore")).pass).toBe(false);
	});
	test("edit: pristine fixture fails, fixed copy passes, test-file tamper fails", async () => {
		const task = BENCH_TASKS.find((t) => t.id === "edit")!;
		const pristine = await copyFixtureToTemp(task);
		tmpRoots.push(pristine);
		const pristineResult = await checkEdit("", pristine);
		expect(pristineResult.pass).toBe(false);
		const fixed = await copyFixtureToTemp(task);
		tmpRoots.push(fixed);
		writeFileSync(join(fixed, "src/calc.ts"), `export function movingSum(values: number[], window: number): number[] {
	const out: number[] = []; let acc = 0;
	for (let i = 0; i < values.length; i++) { acc += values[i]; if (i >= window) acc -= values[i - window]; out.push(acc); }
	return out;
}
`);
		expect((await checkEdit("", fixed)).pass).toBe(true);
		const tampered = await copyFixtureToTemp(task);
		tmpRoots.push(tampered);
		writeFileSync(join(tampered, "src/calc.test.ts"), `import { test, expect } from "bun:test"; test("always", () => { expect(1).toBe(1); });
`);
		const tamperedResult = await checkEdit("", tampered);
		expect(tamperedResult.pass).toBe(false);
		expect(tamperedResult.detail).toContain("test file");
	});
	test("analysis: all three answers present passes; missing one fails", async () => {
		const ok = await checkAnalysis("1. ord-101\n2. SKU-BQ\n3. Cleo Frost", "/ignore");
		expect(ok.pass).toBe(true);
		const missing = await checkAnalysis("1. ord-101\n2. SKU-BQ\n3. Wrong Name", "/ignore");
		expect(missing.pass).toBe(false);
		expect(missing.detail).toContain("Cleo Frost");
	});
});
```

NOTE for the implementer: the copy test above uses a placeholder assertion (`toBeFile? undefined : null` line) — replace with `expect(existsSync(join(dir, "data.txt"))).toBe(true);` (import `existsSync` from `node:fs`) and also assert a write into the temp dir does not change the repo fixture (compare `readFileSync(join(task.dir, "data.txt"))` before/after).

- [ ] **Step 3: Run to verify failure** — `( cd bun-apps/s2-agent && bun test src/cli/bench/tasks.test.ts )` → FAIL.

- [ ] **Step 4: Implement `tasks.ts`:**

```ts
/**
 * bench/tasks — the three benchmark fixtures + their deterministic quality
 * gates. Gates are pure-ish (needle/analysis are string checks; edit runs
 * `bun test` in the run dir + verifies the test file is untampered via sha256).
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QualityResult } from "./core.ts";

const TASKS_ROOT = join(import.meta.dir, "../../../bench/tasks");

export interface BenchTask {
	id: string;
	dir: string;
	tools: string[];
	prompt: string;
	check: (assistantText: string, runDir: string) => Promise<QualityResult>;
}

export async function copyFixtureToTemp(task: BenchTask): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), `bench-${task.id}-`));
	cpSync(task.dir, dir, { recursive: true });
	return dir;
}

export async function checkNeedle(text: string, _runDir: string): Promise<QualityResult> {
	const expected = JSON.parse(readFileSync(join(TASKS_ROOT, "needle/expected.json"), "utf8")).needle as string;
	return text.includes(expected)
		? { pass: true, detail: "needle exact-match" }
		: { pass: false, detail: `needle "${expected}" not found in final reply` };
}

async function sha256(path: string): Promise<string> {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** `bun test` in the run dir must exit 0 AND src/calc.test.ts must be byte-identical to the fixture. */
export async function checkEdit(_text: string, runDir: string): Promise<QualityResult> {
	const pristineTest = await sha256(join(TASKS_ROOT, "edit/src/calc.test.ts"));
	const runTest = await sha256(join(runDir, "src/calc.test.ts"));
	if (pristineTest !== runTest) return { pass: false, detail: "test file tampered" };
	const proc = Bun.spawnSync(["bun", "test", "src/calc.test.ts"], { cwd: runDir, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode === 0) return { pass: true, detail: "fixture tests pass" };
	const tail = proc.stderr.toString().trim().split("\n").slice(-3).join(" | ");
	return { pass: false, detail: `bun test exit ${proc.exitCode}: ${tail.slice(0, 160)}` };
}

export async function checkAnalysis(text: string, _runDir: string): Promise<QualityResult> {
	const answers = JSON.parse(readFileSync(join(TASKS_ROOT, "analysis/expected.json"), "utf8")).answers as string[];
	const missing = answers.filter((a) => !text.includes(a));
	return missing.length === 0
		? { pass: true, detail: "all 3 cross-file answers present" }
		: { pass: false, detail: `missing: ${missing.join(", ")}` };
}

export const BENCH_TASKS: BenchTask[] = [
	{
		id: "needle",
		dir: join(TASKS_ROOT, "needle"),
		tools: ["read"],
		prompt: readFileSync(join(TASKS_ROOT, "needle/TASK.md"), "utf8"),
		check: checkNeedle,
	},
	{
		id: "edit",
		dir: join(TASKS_ROOT, "edit"),
		tools: ["read", "edit", "bash"],
		prompt: readFileSync(join(TASKS_ROOT, "edit/TASK.md"), "utf8"),
		check: checkEdit,
	},
	{
		id: "analysis",
		dir: join(TASKS_ROOT, "analysis"),
		tools: ["read"],
		prompt: readFileSync(join(TASKS_ROOT, "analysis/TASK.md"), "utf8"),
		check: checkAnalysis,
	},
];
```

- [ ] **Step 5: Run tests** — `( cd bun-apps/s2-agent && bun test src/cli/bench/ )` → PASS (edit gate test spawns real `bun test` twice against temp copies — expected a few seconds).

- [ ] **Step 6: Verify fixtures never leak into CI's test discovery** — `bun test bench/` from the package root must NOT run `bench/tasks/edit/src/calc.test.ts` as a repo test (it lives outside `src/`, but assert it): run `( cd bun-apps/s2-agent && bun test 2>&1 | grep -c calc.test )` → expect 0 matches in the run header lines for bench/tasks (if bun does pick it up, add `bench/` to the package `test` script exclusion: `bun test --exclude 'bench/**'`... verify against actual bun behavior and adjust).

- [ ] **Step 7: Commit** — `git add bun-apps/s2-agent/bench/ bun-apps/s2-agent/src/cli/bench/ && git commit -m "feat(bench): three task fixtures with deterministic quality gates"`

---

### Task 3: `bench-agent` command — runner, probe, dry mode, wiring

**Files:**
- Create: `bun-apps/s2-agent/src/cli/commands/bench-agent.ts`
- Create: `bun-apps/s2-agent/src/cli/commands/bench-agent.test.ts`
- Modify: `bun-apps/s2-agent/src/cli/dispatch.ts` (import + COMMANDS array, after `agentTrendsCommand`)
- Modify: `bun-apps/s2-agent/src/cli/args.ts` (ParsedArgs fields: `configs?: string; probe?: string; dry?: boolean; timeoutSec?: number; tasks?: string`)
- Modify: `bun-apps/s2-agent/src/cli/flag-spec.ts` (flag rows + field unions)
- Create/Modify: `bun-apps/s2-agent/.gitignore` (ensure `output/` ignored)

**Interfaces:**
- Consumes: `DEFAULT_CONFIGS/extractMetrics/finalAssistantText/renderReport/CellResult` (Task 1), `BENCH_TASKS/copyFixtureToTemp` (Task 2), `createSharedSession/resolveLLM` from `../sessions/shared.ts`, `Command` from `../dispatch.ts` (type-only import to avoid cycles — dispatch imports the command, the command imports the type; if a runtime cycle fires, move `Command` to `../command-types.ts` and re-export from dispatch).
- Produces: CLI surface `s2-agent cli bench-agent [--configs csv] [--tasks csv] [--probe prefill] [--dry] [--timeout-sec N]`.

- [ ] **Step 1: Add flags.** In `flag-spec.ts`: add `"configs" | "tasks" | "probe"` to `ValueField`, `"dry"` to `BooleanField`, `"timeoutSec"` to `NumericField`; add owner-group rows:
```ts
// ── bench-agent — GLM speed/effectiveness benchmark ─────────────────────────
{ flag: "--configs", field: "configs", example: "5.3-high,5.3-medium" },
{ flag: "--tasks", field: "tasks", example: "needle,edit" },
{ flag: "--probe", field: "probe", example: "prefill" },
{ flag: "--timeout-sec", field: "timeoutSec", min: 10, example: "300" },
// (boolean --dry joins the BOOLEAN_FLAGS table)
```
In `args.ts` add the five fields to `ParsedArgs` with doc comments (mirror `agent-trends` fields' style).

- [ ] **Step 2: Write failing command tests** — `bench-agent.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { selectConfigs, selectTasks, runDry } from "./bench-agent.ts";
import { BENCH_TASKS } from "../bench/tasks.ts";
import { DEFAULT_CONFIGS } from "../bench/core.ts";

describe("selectConfigs", () => {
	test("filter by csv ids; unknown id → throws with the legal ids", () => {
		expect(selectConfigs("5.3-high,5.3-low").map((c) => c.id)).toEqual(["5.3-high", "5.3-low"]);
		expect(() => selectConfigs("bogus")).toThrow(/5.3-high/);
	});
	test("undefined → full default matrix", () => {
		expect(selectConfigs(undefined)).toEqual(DEFAULT_CONFIGS);
	});
});

describe("selectTasks", () => {
	test("filter by csv ids; undefined → all", () => {
		expect(selectTasks("needle").map((t) => t.id)).toEqual(["needle"]);
		expect(selectTasks(undefined)).toEqual(BENCH_TASKS);
		expect(() => selectTasks("nope")).toThrow();
	});
});

describe("runDry", () => {
	test("copies fixtures, runs gates on canned outputs, renders a dry report, exit 0", async () => {
		const { report, cells } = await runDry();
		expect(cells).toHaveLength(3);
		expect(cells.filter((c) => c.quality?.pass).length).toBe(2); // needle+analysis canned-pass, edit canned-fail (pristine)
		expect(report).toContain("(DRY)");
	});
});
```

- [ ] **Step 3: Run to verify failure** — `( cd bun-apps/s2-agent && bun test src/cli/commands/bench-agent.test.ts )` → FAIL.

- [ ] **Step 4: Implement `bench-agent.ts`.** Structure (full logic; adapt import paths to the codebase's conventions observed in `commands/agent.ts`):

```ts
/**
 * `bench-agent` — GLM speed/effectiveness benchmark.
 *
 * Modes:
 *   (default)  run the focused config×task matrix; emit results.jsonl + REPORT.md
 *   --probe prefill  T1 cold+warm under full vs stripped tool loads (context-cost A/B)
 *   --dry      fixtures + gates only, canned outputs, zero LLM calls (self-test)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "../args.ts";
import {
	type BenchConfig, type CellResult, DEFAULT_CONFIGS, extractMetrics,
	finalAssistantText, renderReport,
} from "../bench/core.ts";
import { BENCH_TASKS, copyFixtureToTemp, type BenchTask } from "../bench/tasks.ts";
import { createSharedSession, resolveLLM } from "../sessions/shared.ts";

const PROBE_TASK = BENCH_TASKS[0]; // needle
const DEFAULT_TIMEOUT_SEC = 300;

export function selectConfigs(csv?: string): BenchConfig[] {
	if (!csv) return DEFAULT_CONFIGS;
	const wanted = csv.split(",").map((s) => s.trim()).filter(Boolean);
	const legal = DEFAULT_CONFIGS.map((c) => c.id);
	const unknown = wanted.filter((w) => !legal.includes(w));
	if (unknown.length > 0) throw new Error(`unknown config id(s): ${unknown.join(", ")}. Legal: ${legal.join(", ")}`);
	return DEFAULT_CONFIGS.filter((c) => wanted.includes(c.id));
}

export function selectTasks(csv?: string): BenchTask[] {
	if (!csv) return BENCH_TASKS;
	const wanted = csv.split(",").map((s) => s.trim()).filter(Boolean);
	const legal = BENCH_TASKS.map((t) => t.id);
	const unknown = wanted.filter((w) => !legal.includes(w));
	if (unknown.length > 0) throw new Error(`unknown task id(s): ${unknown.join(", ")}. Legal: ${legal.join(", ")}`);
	return BENCH_TASKS.filter((t) => wanted.includes(t.id));
}

interface PromptOutcome { ok: boolean; error?: string; wallMs: number }

async function promptWithTimeout(session: { prompt: (t: string) => Promise<void> }, task: string, timeoutMs: number): Promise<PromptOutcome> {
	const t0 = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			session.prompt(task),
			new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs); }),
		]);
		return { ok: true, wallMs: Date.now() - t0 };
	} catch (e: any) {
		return { ok: false, error: String(e?.message ?? e), wallMs: Date.now() - t0 };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** One matrix cell: fresh temp fixture, fresh session, one prompt, metrics + gate. One transient retry. */
async function runCell(config: BenchConfig, task: BenchTask, timeoutMs: number): Promise<CellResult> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const runDir = await copyFixtureToTemp(task);
		let session: Awaited<ReturnType<typeof createSharedSession>> | undefined;
		try {
			const llm = await resolveLLM({ overrideModel: `${config.model}:${config.thinking}` });
			session = await createSharedSession(llm, { cwd: runDir, tools: task.tools });
			const outcome = await promptWithTimeout(session.session as any, task.prompt, timeoutMs);
			if (!outcome.ok && attempt === 0) { session.session.dispose?.(); continue; } // one retry
			const messages = (session.session as any).messages ?? [];
			const metrics = extractMetrics(messages, outcome.wallMs);
			const quality = await task.check(finalAssistantText(messages), runDir);
			return { configId: config.id, taskId: task.id, ok: outcome.ok, error: outcome.error, metrics, quality };
		} catch (e: any) {
			if (attempt === 1) return { configId: config.id, taskId: task.id, ok: false, error: String(e?.message ?? e), metrics: null, quality: null };
		} finally {
			(session as any)?.session?.dispose?.();
		}
	}
	/* unreachable */ throw new Error("runCell exhausted retries");
}

export async function runDry(): Promise<{ report: string; cells: CellResult[] }> {
	const cells: CellResult[] = [];
	const canned: Record<string, string> = {
		needle: "NEEDLE-7Q4X9M2B",
		analysis: "1. ord-101\n2. SKU-BQ\n3. Cleo Frost",
		edit: "(no llm in dry mode)",
	};
	for (const task of BENCH_TASKS) {
		const runDir = await copyFixtureToTemp(task);
		const quality = await task.check(canned[task.id] ?? "", runDir);
		cells.push({ configId: "dry", taskId: task.id, ok: true, metrics: extractMetrics([], 0), quality });
	}
	return { report: renderReport(cells, { startedAt: new Date().toISOString(), dry: true }), cells };
}

/** --probe prefill: needle task, one session per load, prompt twice (cold then warm). */
async function runPrefillProbe(timeoutMs: number): Promise<string> {
	const loads = [
		{ name: "full", tools: undefined as string[] | undefined },
		{ name: "stripped", tools: ["read"] as string[] | undefined },
	];
	const rows: string[] = ["| load | tools | cold wall(s) | warm wall(s) | cold cacheW | warm cacheR |", "|---|---|---|---|---|---|"];
	for (const load of loads) {
		const runDir = await copyFixtureToTemp(PROBE_TASK);
		const llm = await resolveLLM({ overrideModel: "zai/glm-5.3:high" });
		const created = await createSharedSession(llm, { cwd: runDir, tools: load.tools });
		const session = created.session as any;
		try {
			const toolCount = (session.getTools?.() ?? []).length;
			const cold = await promptWithTimeout(session, PROBE_TASK.prompt, timeoutMs);
			const coldM = extractMetrics(session.messages ?? [], cold.wallMs);
			const warm = await promptWithTimeout(session, "Again — reply with only the exact token.", timeoutMs);
			const allM = extractMetrics(session.messages ?? [], warm.wallMs);
			const warmM = { wall: warm.wallMs, cacheRead: allM.cacheReadTokens - coldM.cacheReadTokens };
			rows.push(`| ${load.name} | ${toolCount} | ${(cold.wallMs / 1000).toFixed(1)} | ${(warmM.wall / 1000).toFixed(1)} | ${coldM.cacheWriteTokens} | ${warmM.cacheRead} |`);
		} finally {
			session.dispose?.();
		}
	}
	return [`# bench-agent prefill probe — ${new Date().toISOString()}`, "", ...rows].join("\n");
}

export async function benchAgentCommand(parsed: ParsedArgs): Promise<void> {
	const timeoutMs = (parsed.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
	const outRoot = join(import.meta.dir, "../../../output/bench-agent");
	if (parsed.dry) {
		const { report } = await runDry();
		console.log(report);
		return;
	}
	if (parsed.probe === "prefill") {
		const report = await runPrefillProbe(timeoutMs);
		const dir = join(outRoot, new Date().toISOString().replace(/[:.]/g, "-"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "PROBE.md"), report);
		console.log(report);
		console.error(`\nwritten: ${join(dir, "PROBE.md")}`);
		return;
	}
	if (parsed.probe) throw new Error(`unknown probe "${parsed.probe}" (only: prefill)`);
	const configs = selectConfigs(parsed.configs);
	const tasks = selectTasks(parsed.tasks);
	const startedAt = new Date().toISOString();
	const results: CellResult[] = [];
	for (const config of configs) {
		for (const task of tasks) {
			console.error(`[bench] ${config.id} × ${task.id} …`);
			const cell = await runCell(config, task, timeoutMs);
			results.push(cell);
			console.error(`[bench] ${config.id} × ${task.id} → ${cell.ok ? (cell.quality?.pass ? "quality PASS" : `quality FAIL (${cell.quality?.detail})`) : `ERROR ${cell.error}`}`);
		}
	}
	const dir = join(outRoot, startedAt.replace(/[:.]/g, "-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
	const report = renderReport(results, { startedAt, dry: false });
	writeFileSync(join(dir, "REPORT.md"), report + "\n");
	console.log(report);
	console.error(`\nwritten: ${join(dir, "REPORT.md")}`);
}

export const benchAgentCommandSpec = {
	name: "bench-agent",
	summary: "GLM speed/effectiveness benchmark (config×task matrix + prefill probe)",
	details: [
		"Runs the focused matrix (5 GLM configs × 3 tasks) headlessly, applies",
		"deterministic quality gates, and writes results.jsonl + REPORT.md under",
		"output/bench-agent/<ts>/. Modes: --probe prefill (context-cost A/B),",
		"--dry (self-test, no LLM). Filters: --configs csv, --tasks csv,",
		"--timeout-sec N (default 300).",
	].join(" "),
	run: benchAgentCommand,
};
```

- [ ] **Step 5: Wire into dispatch.ts** — import `benchAgentCommandSpec` from `./commands/bench-agent.ts`; add to `COMMANDS` after `agentTrendsCommand`. Follow the exact export shape sibling commands use (some export a `Command` object directly, e.g. `agentTrendsCommand` — match that shape; if siblings export `{name, summary, details, run}`, drop the `Spec` suffix and export `benchAgentCommand` as the `Command`).

- [ ] **Step 6: Ensure output/ is ignored** — `git check-ignore bun-apps/s2-agent/output/x || echo 'bench/' >> bun-apps/s2-agent/.gitignore` (create .gitignore if absent; verify with `git status --short` after a dry run).

- [ ] **Step 7: Run tests + typecheck** — `( cd bun-apps/s2-agent && bun run typecheck && bun test src/cli/commands/bench-agent.test.ts src/cli/bench/ )` → PASS.

- [ ] **Step 8: Live smoke (real API, executor-run, NOT CI)** — `( cd bun-apps/s2-agent && bun ../s2-agent/src/cli.ts cli bench-agent --configs 5.3-high --tasks needle --timeout-sec 180 )` → one cell, quality PASS, REPORT.md written. If `zai/glm-5.3:high` auth/config fails, STOP: the harness must not silently fall back to another model (assert the resolved model line printed to stderr contains `glm-5.3`).

- [ ] **Step 9: Commit** — `git add -A bun-apps/s2-agent/src/cli/ bun-apps/s2-agent/.gitignore && git commit -m "feat(bench): cli bench-agent command — matrix runner, prefill probe, dry self-test"`

---

### Task 4: Run the benchmark, record findings

**Files:**
- Create: `bun-apps/s2-agent/output/bench-agent/<ts>/REPORT.md` (tool output, gitignored)
- Create: `.planning/plans/2026-08-30-glm-speed-benchmark-findings.md` (committed)

**Interfaces:**
- Consumes: the finished CLI from Task 3.
- Produces: findings document that Task 5's tuning decisions cite (with measured numbers).

- [ ] **Step 1: Full matrix** — `( cd bun-apps/s2-agent && bun ../s2-agent/src/cli.ts cli bench-agent --timeout-sec 300 )` (~15 cells, 20–40 min; monitor stderr progress lines).

- [ ] **Step 2: Prefill probe** — `( cd bun-apps/s2-agent && bun ../s2-agent/src/cli.ts cli bench-agent --probe prefill --timeout-sec 180 )`.

- [ ] **Step 3: Write findings** — `.planning/plans/2026-08-30-glm-speed-benchmark-findings.md` with: (a) the REPORT.md matrix verbatim; (b) PROBE.md verbatim; (c) three explicit answers: do `:medium`/`:low` change glm-5.3's reasoning ratio (numbers)? which config wins latency at equal quality? what does the tools schema cost cold vs warm? (d) recommended levers for Task 5.

- [ ] **Step 4: Commit** — `git add .planning/plans/2026-08-30-glm-speed-benchmark-findings.md && git commit -m "docs(bench): GLM speed benchmark findings — matrix + prefill probe"`

---

### Task 5: Tuning pass on `pre-load-providers.ts` (data decides)

**Files:**
- Modify: `bun-apps/s2-agent/src/pre-load-providers.ts` (levers per findings)
- Modify: `bun-apps/s2-agent/src/pre-load-providers.test.ts` (pinned guards that the changes touch)

**Interfaces:**
- Consumes: findings from Task 4.
- Produces: updated catalog/tiers; every change cites a measured number from the findings file in its comment.

- [ ] **Step 1: Apply ONLY the levers the data supports** (each conditional; skip cleanly if unsupported):
  - **L1 — levels are real levers** (reasoning ratio differs across `5.3:high/medium/low`) AND `medium` holds quality: set `BUILTIN_MODEL_DEFAULT.thinking` to `"medium"` + add a comment citing the measured ratio delta.
  - **L2 — levels are real** but medium drops quality: keep `"high"`, add explicit `thinkingLevelMap` to `glm-5.3` ONLY if the map changes wire behavior (verify against pi-ai's zai adapter first — read `openai-completions.js` `detectCompat` + thinkingFormat handling before adding; a map that re-derives the same default is noise, do not add it).
  - **L3 — `glm-5.3-highspeed` matches 5.3 quality with better latency**: change `DEFAULT_MODEL_TIER_CONFIG.tiers.medium` to `"zai/glm-5.3-highspeed"`.
  - **L4 — none of the above**: no catalog change; record that the current default is already optimal, with numbers.
- [ ] **Step 2: Update pinned tests** — `pre-load-providers.test.ts`: update the folded-compat/resolution assertions the change touches (e.g. tier resolution guard if tiers changed; BUILTIN_MODEL_DEFAULT guard if thinking changed). Also `src/cli/sessions/shared.ts`'s FALLBACK mirrors `BUILTIN_MODEL_DEFAULT` — keep them agreeing (there is a guard test asserting this; update both sides together if it fires).
- [ ] **Step 3: Package gates** — `( cd bun-apps/s2-agent && bun run typecheck && bun test )` → PASS.
- [ ] **Step 4: Local CI** — `run_local_ci` scoped to changed packages → green.
- [ ] **Step 5: Confirm with a re-run** — re-run the matrix for the OLD and NEW default configs only (e.g. `--configs 5.3-high,5.3-medium --tasks needle,edit,analysis`); the new default must be ≥ baseline quality with better latency. Append the confirmation table to the findings file.
- [ ] **Step 6: Commit** — `git add bun-apps/s2-agent/src/pre-load-providers.ts bun-apps/s2-agent/src/pre-load-providers.test.ts .planning/plans/2026-08-30-glm-speed-benchmark-findings.md && git commit -m "tune(bench): data-driven GLM default/tier adjustment from bench-agent findings"`

---

## Self-Review (done at plan time)

- **Spec coverage:** harness (Task 3), task suite + gates (Task 2), matrix (Tasks 1+3), metrics/output (Tasks 1+3), probe (Task 3), tuning flow (Task 5), dry self-test + unit tests (Tasks 1–3), findings recording (Task 4). Hermes verification: covered by the probe's stripped-vs-full comparison + documented in findings (spec §5). ✓
- **Placeholders:** the two explicit implementer NOTEs (Task 1 Step 3 note about the table cell, Task 2 Step 2 note about the copy assertion) replace placeholder patterns with concrete replacements. ✓
- **Type consistency:** `BenchConfig/RunMetrics/QualityResult/CellResult/BenchTask` names used identically across Tasks 1–3; `createSharedSession` returns `{session, …}` (matches `CreateAgentSessionResult`); command export shape flagged for implementer to match siblings. ✓
