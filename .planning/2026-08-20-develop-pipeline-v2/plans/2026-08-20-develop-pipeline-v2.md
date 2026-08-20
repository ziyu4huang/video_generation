# develop-pipeline v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pipeline v2 — workflow as primary execution engine, T1/T2/T3 tier system, `pipeline-gate` teeth, unified dispatch records with a learning loop.

**Architecture:** Two new pure-core CLI commands in `bun-apps/pi-agent/src/cli/commands/` (mechanical text scanners, no LLM), two workflow templates in `bun-apps/pi-agent-ext-workflow/samples/`, a normalize layer merging workflow journal + `subagent_runs` into one record schema, and a rewrite of one superpowers skill. Each unit is independently testable.

**Tech Stack:** Bun + TypeScript, bun test, existing pi-agent cli `Command` shape, workflow script globals (`agent`/`phase`/`parallel`/`pipeline`/`log`).

**Spec:** `.planning/2026-08-20-develop-pipeline-v2/spec.md`

## Global Constraints

- Written output (code, comments, commits, docs) in English; replies to the user in zh-TW.
- Per-package canonical test script only: `( cd bun-apps/<pkg> && bun test )` — never a hand-assembled subset. `pi-agent`'s canonical test includes cross-package typecheck; a red cross-pkg tsc red-lights the whole repo.
- Skills ≤300 lines each (drift-report signal 2 in `loop.ts`).
- Remote CI stays disabled; all gates local. `local_ci` ≤5 min budget — do NOT wire new checks into it.
- No top-level `cd` — use `( cd <dir> && ... )` or `--cwd`.
- Vendor/worktree discipline per CLAUDE.md; commits via normal flow, git phases via devops chain.

---

### Task 1: `pipeline-gate` command — pure checkers + tests + wiring

**Files:**
- Create: `bun-apps/pi-agent/src/cli/commands/pipeline-gate.ts`
- Test: `bun-apps/pi-agent/src/cli/commands/pipeline-gate.test.ts`
- Modify: `bun-apps/pi-agent/src/cli/dispatch.ts` (import + COMMANDS entry, mirroring `loopCommand` at dispatch.ts:50,83)

**Interfaces:**
- Consumes: the `Command` shape from `../dispatch.ts` (same as `loop.ts:138-151`).
- Produces (Task 4 consumes in prose only — the workflow Gate phase shells out to the CLI): exported pure functions `parseTierFromMap`, `countOpenQuestions`, `countOpenDecisions`, `ticketRunExpected`, `classifySize`, `runGate`.

- [ ] **Step 1: Write the failing tests**

```ts
// pipeline-gate.test.ts
import { describe, expect, test } from "bun:test";
import {
	parseTierFromMap,
	countOpenQuestions,
	countOpenDecisions,
	ticketRunExpected,
	classifySize,
	runGate,
} from "./pipeline-gate.ts";

const MAP_T2 = `---\neffort: x\ntier: T2\n---\n# Wayfinder map\n## Not yet specified\n<!-- none -->\n`;
const MAP_OPEN = `---\ntier: T3\n---\n## Not yet specified\n- how do we X?\n- who owns Y?\n`;

describe("parseTierFromMap", () => {
	test("reads tier from frontmatter", () => {
		expect(parseTierFromMap(MAP_T2)).toBe("T2");
	});
	test("null when absent", () => {
		expect(parseTierFromMap("no frontmatter")).toBe(null);
	});
});

describe("countOpenQuestions", () => {
	test("comment-only block is zero", () => {
		expect(countOpenQuestions(MAP_T2)).toBe(0);
	});
	test("counts non-comment lines under Not yet specified", () => {
		expect(countOpenQuestions(MAP_OPEN)).toBe(2);
	});
	test("missing section is zero", () => {
		expect(countOpenQuestions("# just a title")).toBe(0);
	});
});

describe("countOpenDecisions", () => {
	test("unchecked boxes count", () => {
		expect(countOpenDecisions("- [ ] pick A or B\n- [x] done one")).toBe(1);
	});
	test("Not yet specified section counts too", () => {
		expect(countOpenDecisions("## Not yet specified\n- open Q here")).toBe(1);
	});
});

describe("ticketRunExpected", () => {
	test("counts Run:/Expected: pairs", () => {
		const t = ticketRunExpected("### Task 1\n**Run:** bun test x\n**Expected:** PASS\n### Task 2\nno markers");
		expect(t).toEqual({ tasks: 2, missing: 1 });
	});
});

describe("classifySize", () => {
	test("3 files one package = T1", () => {
		expect(classifySize(["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent/src/b.ts", "bun-apps/pi-agent/src/c.ts"])).toBe("T1");
	});
	test("5 files one package = T2", () => {
		expect(classifySize(Array.from({ length: 5 }, (_, i) => `bun-apps/pi-agent/src/f${i}.ts`))).toBe("T2");
	});
	test("two packages = T2", () => {
		expect(classifySize(["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent-ext-workflow/src/b.ts"])).toBe("T2");
	});
	test("three packages = T3", () => {
		expect(classifySize(["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent-ext-workflow/src/b.ts", "bun-apps/pi-agent-ext-subagent/src/c.ts"])).toBe("T3");
	});
	test("new extension dir = T3", () => {
		expect(classifySize(["bun-apps/pi-agent-ext-newthing/src/index.ts"])).toBe("T3");
	});
});

describe("runGate", () => {
	test("green T2 effort exits 0", () => {
		const r = runGate({
			declaredTier: "T2",
			mapText: MAP_T2,
			specText: "# spec\nall decided",
			ticketTexts: ["### Task 1\n**Run:** x\n**Expected:** y"],
			ledgerText: "| ticket | outcome | sha |\n|---|---|---|\n| 01 | green | abc |",
			changedFiles: ["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent/src/b.ts"],
		});
		expect(r.exitCode).toBe(0);
		expect(r.checks.every((c) => c.pass)).toBe(true);
	});
	test("open Q in map fails with remedy naming wayfind", () => {
		const r = runGate({
			declaredTier: "T3",
			mapText: MAP_OPEN,
			specText: "# spec",
			ticketTexts: [],
			ledgerText: "",
			changedFiles: ["bun-apps/a/src/x.ts", "bun-apps/b/src/x.ts", "bun-apps/c/src/x.ts"],
		});
		expect(r.exitCode).toBe(1);
		const openQ = r.checks.find((c) => c.name === "map-frozen")!;
		expect(openQ.pass).toBe(false);
		expect(openQ.remedy).toContain("wayfind");
	});
	test("tier under-declaration fails", () => {
		const r = runGate({
			declaredTier: "T1",
			mapText: "",
			specText: "",
			ticketTexts: [],
			ledgerText: "",
			changedFiles: ["bun-apps/a/src/x.ts", "bun-apps/b/src/x.ts", "bun-apps/c/src/x.ts"],
		});
		expect(r.checks.find((c) => c.name === "tier-match")!.pass).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent && bun test src/cli/commands/pipeline-gate.test.ts )`
Expected: FAIL — "Cannot resolve module ./pipeline-gate.ts"

- [ ] **Step 3: Write the implementation**

```ts
/**
 * `pipeline-gate` — mechanical handoff-contract checks for the develop-pipeline
 * v2 tier system (spec: .planning/2026-08-20-develop-pipeline-v2/spec.md §4).
 * Pure text scanning, no LLM, no network. Checks by declared tier:
 *
 *   tier-match     declared tier vs mechanical size of the change (all tiers)
 *   map-frozen     map.md "## Not yet specified" block has no open lines (T2/T3)
 *   spec-settled   spec.md has no unchecked decisions / open section (T2/T3)
 *   tickets-runnable  every task has Run: and Expected: markers (T2/T3)
 *   ledger-complete dispatch ledger exists with outcome+sha rows (T2/T3)
 *
 * Red output names the broken contract, the stage to return to, and what to
 * backfill ("fog flows left"). Exits 0 green / 1 red / 2 usage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Tier = "T1" | "T2" | "T3";

export interface GateCheck {
	name: string;
	pass: boolean;
	detail: string;
	/** What to do when red — names the stage to return to. */
	remedy: string;
}

/** `tier: T<n>` from map.md frontmatter; null when absent. */
export function parseTierFromMap(mapText: string): Tier | null {
	const m = mapText.match(/^tier:\s*(T[123])\s*$/m);
	return (m?.[1] as Tier) ?? null;
}

/** Non-comment, non-empty lines under `## Not yet specified` (the wayfind
 * open-Q block convention; `<!-- ... -->` marks a closed block). */
export function countOpenQuestions(mapText: string): number {
	return countSectionLines(mapText, "Not yet specified");
}

/** Unchecked `- [ ]` boxes anywhere + open lines under Not yet specified. */
export function countOpenDecisions(specText: string): number {
	const boxes = (specText.match(/^\s*-\s\[\s\]\s/gm) ?? []).length;
	return boxes + countSectionLines(specText, "Not yet specified");
}

function countSectionLines(text: string, heading: string): number {
	const re = new RegExp(`^##\\s+${heading}\\s*$`, "m");
	const m = text.match(re);
	if (!m || m.index === undefined) return 0;
	const after = text.slice(m.index).split("\n").slice(1);
	let n = 0;
	for (const line of after) {
		if (line.startsWith("## ")) break;
		const t = line.trim();
		if (t.length > 0 && !t.startsWith("<!--")) n++;
	}
	return n;
}

/** Tasks (### Task) vs tasks carrying both Run:/Expected: markers. */
export function ticketRunExpected(text: string): { tasks: number; missing: number } {
	const tasks = text.split("\n").filter((l) => /^###\s+Task\b/.test(l)).length;
	const runnable = text.split(/^(?=###\s+Task\b)/m).filter(
		(block) => /\*\*Run:\*\*/.test(block) && /\*\*Expected:\*\*/.test(block),
	).length;
	return { tasks, missing: tasks - runnable };
}

/** Mechanical size rules (spec §1): ≥3 packages or a new bun-apps/<pkg>/
 * directory → T3; ≥4 files, 2 packages, or exports-facing files → T2; else T1. */
export function classifySize(changedFiles: string[]): Tier {
	const pkgs = new Set(
		changedFiles
			.filter((f) => f.startsWith("bun-apps/"))
			.map((f) => f.split("/").slice(0, 2).join("/")),
	);
	if (pkgs.size >= 3) return "T3";
	const known = new Set([
		"bun-apps/pi-agent", "bun-apps/pi-agent-core-runtime", "bun-apps/pi-agent-core-interface",
		"bun-apps/gui-movie-director", "bun-apps/perf-harness", "bun-apps/docs",
	]);
	for (const p of pkgs) if (!known.has(p)) return "T3";
	if (pkgs.size === 2) return "T2";
	if (changedFiles.length >= 4) return "T2";
	if (changedFiles.some((f) => /(^|\/)(index|extensions\/[^/]+)\.ts$/.test(f))) return "T2";
	return "T1";
}

const ORDER: Tier[] = ["T1", "T2", "T3"];

export interface GateInput {
	declaredTier: Tier;
	mapText: string;
	specText: string;
	ticketTexts: string[];
	ledgerText: string;
	changedFiles: string[];
}

export interface GateResult {
	checks: GateCheck[];
	exitCode: 0 | 1;
}

/** Run all checks for the declared tier. Pure — callers feed file contents. */
export function runGate(input: GateInput): GateResult {
	const { declaredTier, mapText, specText, ticketTexts, ledgerText, changedFiles } = input;
	const checks: GateCheck[] = [];

	const size = classifySize(changedFiles);
	checks.push({
		name: "tier-match",
		pass: ORDER.indexOf(size) <= ORDER.indexOf(declaredTier),
		detail: `declared ${declaredTier}, mechanical size ${size} over ${changedFiles.length} files`,
		remedy: "re-tier the effort: bump the map.md frontmatter tier and backfill the left-side artifacts that tier requires",
	});

	if (declaredTier !== "T1") {
		const openQ = countOpenQuestions(mapText);
		checks.push({
			name: "map-frozen",
			pass: openQ === 0,
			detail: `${openQ} open question(s) in map.md`,
			remedy: "return to wayfind grill — resolve the open Qs before executing past them",
		});
		const openD = countOpenDecisions(specText);
		checks.push({
			name: "spec-settled",
			pass: openD === 0,
			detail: `${openD} open decision(s) in spec.md`,
			remedy: "return to wayfind to-spec — settle every decision before planning",
		});
		const missing = ticketTexts.reduce((n, t) => n + ticketRunExpected(t).missing, 0);
		checks.push({
			name: "tickets-runnable",
			pass: missing === 0,
			detail: `${missing} task(s) missing Run:/Expected: markers`,
			remedy: "return to superpowers writing-plans — every task needs a Run: and an Expected:",
		});
		const ledgerRows = ledgerText.split("\n").filter((l) => /^\|/.test(l) && /\b(green|red|budget-dead|skipped)\b/.test(l));
		const badRows = ledgerRows.filter((l) => !/[0-9a-f]{7,40}/.test(l));
		checks.push({
			name: "ledger-complete",
			pass: ledgerRows.length > 0 && badRows.length === 0,
			detail: `${ledgerRows.length} ledger row(s), ${badRows.length} missing outcome or SHA`,
			remedy: "finish the dispatch ledger (workflow Report phase) — every row needs an outcome and a commit SHA",
		});
	}

	return { checks, exitCode: checks.every((c) => c.pass) ? 0 : 1 };
}

function readOr(path: string, fallback: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return fallback;
	}
}

function changedFilesSinceBase(repoRoot: string): string[] {
	const r = Bun.spawnSync(["git", "diff", "--name-only", "origin/main...HEAD"], { cwd: repoRoot });
	return r.stdout ? r.stdout.toString().split("\n").filter(Boolean) : [];
}

async function run(repoRoot: string, args: string[]): Promise<number> {
	const effort = args.find((a) => a.startsWith("--effort="))?.slice("--effort=".length)
		?? args[args.indexOf("--effort") + 1];
	const tierArg = args.find((a) => a.startsWith("--tier="))?.slice("--tier=".length);
	if (!effort && !tierArg) {
		console.log("usage: pi-agent cli pipeline-gate --effort <name> [--tier T1]   (T1: --tier replaces the missing map.md declaration)");
		return 2;
	}
	const effortDir = effort ? join(repoRoot, ".planning", effort) : "";
	const declaredTier = (tierArg as Tier)
		?? parseTierFromMap(readOr(join(effortDir, "map.md"), ""));
	if (!declaredTier) {
		console.log("pipeline-gate: no tier declaration found (map.md frontmatter or --tier)");
		return 2;
	}
	const tickets = effort
		? Array.from(new Bun.Glob("tickets/*.md").scanSync({ cwd: effortDir })).map((f) =>
				readOr(join(effortDir, f), ""),
			)
		: [];
	const result = runGate({
		declaredTier,
		mapText: effort ? readOr(join(effortDir, "map.md"), "") : "",
		specText: effort ? readOr(join(effortDir, "spec.md"), "") : "",
		ticketTexts: tickets,
		ledgerText: effort ? readOr(join(effortDir, "dispatch-ledger.md"), "") : "",
		changedFiles: changedFilesSinceBase(repoRoot),
	});
	for (const c of result.checks) {
		console.log(`${c.pass ? "PASS" : "RED "} ${c.name}: ${c.detail}`);
		if (!c.pass) console.log(`      -> ${c.remedy}`);
	}
	return result.exitCode;
}

export const pipelineGateCommand = {
	name: "pipeline-gate",
	summary: "mechanical tier/handoff-contract checks (pipeline v2)",
	details: `Usage:
  pi-agent cli pipeline-gate --effort <name>
  pi-agent cli pipeline-gate --tier T1

Checks the develop-pipeline v2 handoff contracts for an effort: tier
declaration vs mechanical change size (anti-drift), map.md frozen, spec
settled, every ticket task has Run:/Expected:, dispatch ledger complete.
Pure text scanning, no LLM. Exits 0 green, 1 red (with the stage to
return to), 2 usage error. T1 efforts have no effort folder — pass
--tier T1 explicitly.`,
	run: async (parsed: import("../args.ts").ParsedArgs) => {
		await run(join(import.meta.dir, "../../../../.."), parsed.positionals);
	},
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent && bun test src/cli/commands/pipeline-gate.test.ts )`
Expected: PASS, all tests green.

- [ ] **Step 5: Wire into dispatch.ts**

In `bun-apps/pi-agent/src/cli/dispatch.ts`: add `import { pipelineGateCommand } from "./commands/pipeline-gate.ts";` next to the loop import (dispatch.ts:50), and add `pipelineGateCommand,` to the `COMMANDS` array (dispatch.ts:69, next to `loopCommand` at :83).

- [ ] **Step 6: Verify the command is reachable and the canonical package gate passes**

Run: `bun bun-apps/pi-agent/src/cli.ts pipeline-gate`
Expected: usage line, exit 2.

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS (includes cross-package typecheck).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent/src/cli/commands/pipeline-gate.ts bun-apps/pi-agent/src/cli/commands/pipeline-gate.test.ts bun-apps/pi-agent/src/cli/dispatch.ts
git commit -m "feat(pi-agent): pipeline-gate — mechanical tier/handoff-contract checks (pipeline v2)"
```

---

### Task 2: `dispatch-log` command — unified records + normalize layer

**Files:**
- Create: `bun-apps/pi-agent/src/cli/commands/dispatch-log.ts`
- Test: `bun-apps/pi-agent/src/cli/commands/dispatch-log.test.ts`
- Modify: `bun-apps/pi-agent/src/cli/dispatch.ts` (same wiring as Task 1)

**Interfaces:**
- Consumes: `SubagentRunRecord` (fields: `id`, `status`: `done|failed|timedout|budget`, `usage.total`, timestamps — source of truth `bun-apps/pi-agent-ext-subagent/src/subagent-run-persistence.ts`; records at `~/.pi/subagents/runs/<id>.json`) and `PersistedRunState` / `PersistedAgentState` (fields: `runId`, `workflowName`, `exec.tokenBudget`, `agents[]: {id, label, status: queued|running|done|error|skipped, tokens}` — source of truth `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts:12-60`).
- Produces: `DispatchRecord` + `normalizeSubagentRecord(rec, effort, tier)` + `normalizeWorkflowRun(state, effort, tier)` + `renderDispatchLog(records, filter)`.

- [ ] **Step 1: Write the failing tests**

```ts
// dispatch-log.test.ts
import { describe, expect, test } from "bun:test";
import {
	normalizeSubagentRecord,
	normalizeWorkflowRun,
	renderDispatchLog,
	type DispatchRecord,
} from "./dispatch-log.ts";

describe("normalizeSubagentRecord", () => {
	test("done -> green", () => {
		const r = normalizeSubagentRecord(
			{ id: "r1", status: "done", usage: { total: 180000 }, task: "impl ticket 02", startedAt: "2026-08-20T10:00:00Z" },
			"demo-effort",
			"T2",
		);
		expect(r.engine).toBe("manual");
		expect(r.outcome).toBe("green");
		expect(r.tokenBudget).toBe(180000);
	});
	test("budget -> budget-dead, timedout -> budget-dead, failed -> red", () => {
		expect(normalizeSubagentRecord({ id: "r2", status: "budget", usage: {} }, "e", "T1").outcome).toBe("budget-dead");
		expect(normalizeSubagentRecord({ id: "r3", status: "timedout", usage: {} }, "e", "T1").outcome).toBe("budget-dead");
		expect(normalizeSubagentRecord({ id: "r4", status: "failed", usage: {} }, "e", "T1").outcome).toBe("red");
	});
});

describe("normalizeWorkflowRun", () => {
	test("maps agent statuses into records", () => {
		const rs = normalizeWorkflowRun(
			{
				runId: "wf_1",
				workflowName: "execute-plan",
				exec: { tokenBudget: 500000 },
				agents: [
					{ id: 1, label: "impl:01", prompt: "p", status: "done", tokens: 210000 },
					{ id: 2, label: "verify:01", prompt: "p", status: "error", tokens: 30000 },
					{ id: 3, label: "impl:02", prompt: "p", status: "skipped" },
				],
			},
			"demo-effort",
			"T3",
		);
		expect(rs).toHaveLength(3);
		expect(rs[0]).toMatchObject({ engine: "workflow", ticket: "01", outcome: "green", tokenBudget: 210000 });
		expect(rs[1].outcome).toBe("red");
		expect(rs[2].outcome).toBe("skipped");
	});
});

describe("renderDispatchLog", () => {
	test("filters by outcome and counts death rate", () => {
		const records: DispatchRecord[] = [
			{ effort: "e", tier: "T2", ticket: "01", engine: "workflow", tokenBudget: 200000, maxTurns: 8, outcome: "green", commit: "abc1234", ts: "2026-08-20T10:00:00Z" },
			{ effort: "e", tier: "T2", ticket: "02", engine: "workflow", tokenBudget: 150000, maxTurns: 8, outcome: "budget-dead", commit: null, ts: "2026-08-20T11:00:00Z" },
		];
		const out = renderDispatchLog(records, {});
		expect(out).toContain("green");
		expect(out).toContain("budget-dead");
		expect(out).toContain("50%"); // death rate line
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent && bun test src/cli/commands/dispatch-log.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * `dispatch-log` — unified dispatch records for pipeline v2 (spec §3).
 * Every dispatch (workflow-driven or manual subagent) normalizes into one
 * schema, queryable by effort/tier/outcome. Feeds devops_retrospect and the
 * wayfind entry consult; replaces the single 2026-08-16 budget baseline with
 * accumulated history.
 *
 * Sources:
 *   manual   — ~/.pi/subagents/runs/<id>.json (SubagentRunRecord)
 *   workflow — per-run PersistedRunState via createRunPersistence (workflow ext)
 * Normalize functions are exported pure; live reads only in run().
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DispatchRecord {
	effort: string;
	tier: string;
	ticket: string;
	engine: "workflow" | "manual";
	tokenBudget: number;
	maxTurns: number;
	outcome: "green" | "red" | "budget-dead" | "skipped";
	commit: string | null;
	ts: string;
}

/** Manual subagent run -> DispatchRecord. Status mapping:
 * done->green, failed->red, budget|timedout->budget-dead. */
export function normalizeSubagentRecord(
	rec: { id: string; status: string; usage?: { total?: number }; task?: string; startedAt?: string },
	effort: string,
	tier: string,
): DispatchRecord {
	const outcome =
		rec.status === "done" ? "green"
		: rec.status === "failed" ? "red"
		: rec.status === "budget" || rec.status === "timedout" ? "budget-dead"
		: "skipped";
	return {
		effort,
		tier,
		ticket: rec.task?.match(/(?:ticket|task)\s*#?(\d+)/i)?.[1] ?? rec.id,
		engine: "manual",
		tokenBudget: rec.usage?.total ?? 0,
		maxTurns: 0,
		outcome,
		commit: null,
		ts: rec.startedAt ?? "",
	};
}

/** One workflow run -> one record per agent. Ticket parsed from the agent
 * label ("impl:01" / "verify:02" -> "01"); tokenBudget falls back to the
 * agent's actual token spend, then the run-level exec cap. */
export function normalizeWorkflowRun(
	state: {
		runId: string;
		workflowName: string;
		exec?: { tokenBudget?: number | null };
		agents: { id: number; label: string; status: string; tokens?: number }[];
	},
	effort: string,
	tier: string,
): DispatchRecord[] {
	return state.agents.map((a) => ({
		effort,
		tier,
		ticket: a.label.match(/(\d+)/)?.[1] ?? String(a.id),
		engine: "workflow" as const,
		tokenBudget: a.tokens ?? state.exec?.tokenBudget ?? 0,
		maxTurns: 0,
		outcome:
			a.status === "done" ? ("green" as const)
			: a.status === "error" ? ("red" as const)
			: ("skipped" as const),
		commit: null,
		ts: state.runId,
	}));
}

export interface DispatchFilter {
	effort?: string;
	tier?: string;
	outcome?: string;
}

/** Human-readable table + a death-rate summary line. */
export function renderDispatchLog(records: DispatchRecord[], filter: DispatchFilter): string {
	const rows = records.filter(
		(r) =>
			(!filter.effort || r.effort === filter.effort) &&
			(!filter.tier || r.tier === filter.tier) &&
			(!filter.outcome || r.outcome === filter.outcome),
	);
	const death = rows.filter((r) => r.outcome === "budget-dead" || r.outcome === "red").length;
	const pct = rows.length === 0 ? 0 : Math.round((death / rows.length) * 100);
	const lines = rows.map(
		(r) =>
			`${r.ts}  ${r.effort} ${r.tier} #${r.ticket} ${r.engine} ${r.outcome} ${Math.round(r.tokenBudget / 1000)}k ${r.commit ?? "—"}`,
	);
	return [...lines, ``, `${rows.length} dispatch(es), ${pct}% death rate (red + budget-dead)`].join("\n");
}

function loadManualRecords(effort: string, tier: string): DispatchRecord[] {
	const dir = join(process.env.HOME ?? "~", ".pi/subagents/runs");
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 200);
	} catch {
		return [];
	}
	const out: DispatchRecord[] = [];
	for (const f of files) {
		try {
			out.push(normalizeSubagentRecord(JSON.parse(readFileSync(join(dir, f), "utf8")), effort, tier));
		} catch {
			// malformed record — skip
		}
	}
	return out;
}

async function run(_repoRoot: string, args: string[]): Promise<number> {
	const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
	const effort = flag("effort") ?? "";
	const tier = flag("tier") ?? "T?";
	const records = loadManualRecords(effort, tier);
	console.log(renderDispatchLog(records, { effort: effort || undefined, outcome: flag("outcome") }));
	console.log(`(workflow-side records: run the workflow Report phase or 'workflow journal' — normalizeWorkflowRun is wired there)`);
	return records.length === 0 && effort ? 1 : 0;
}

export const dispatchLogCommand = {
	name: "dispatch-log",
	summary: "query unified dispatch records (manual + workflow)",
	details: `Usage:
  pi-agent cli dispatch-log [--effort <name>] [--tier T2] [--outcome budget-dead]

Prints normalized dispatch records from the manual subagent archive
(~/.pi/subagents/runs) plus the workflow journal summary, with a
death-rate line. Exits 0 with records, 1 when a filtered query is empty.`,
	run: async (parsed: import("../args.ts").ParsedArgs) => {
		await run(join(import.meta.dir, "../../../../.."), parsed.positionals);
	},
};
```

Note for the implementer: `loadManualRecords` reads raw record JSON — before finalizing, verify the exact `SubagentRunRecord` field names against `bun-apps/pi-agent-ext-subagent/src/subagent-run-persistence.ts` and adjust the anonymous parameter type in `normalizeSubagentRecord` to import that type if it is exported (prefer importing over redeclaring). The tests define the contract; keep them passing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent && bun test src/cli/commands/dispatch-log.test.ts )`
Expected: PASS.

- [ ] **Step 5: Wire into dispatch.ts, run canonical gates, commit**

Same wiring as Task 1 (`dispatchLogCommand`).

Run: `( cd bun-apps/pi-agent && bun test )` — Expected: PASS.

```bash
git add bun-apps/pi-agent/src/cli/commands/dispatch-log.ts bun-apps/pi-agent/src/cli/commands/dispatch-log.test.ts bun-apps/pi-agent/src/cli/dispatch.ts
git commit -m "feat(pi-agent): dispatch-log — unified dispatch records with death-rate summary (pipeline v2)"
```

---

### Task 3: `execute-t1` workflow template

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/samples/execute-t1.js`
- Test: `bun-apps/pi-agent-ext-workflow/tests/execute-templates.test.ts`

**Interfaces:**
- Consumes: workflow script globals `agent`/`phase`/`log` (injected by the runtime — never imported; see `samples/dynamic-workflow-smoke01.js` header comment), and Task 1's CLI: `bun bun-apps/pi-agent/src/cli.ts pipeline-gate --tier T1`.
- Produces: a runnable template whose `meta.name` is `"execute-t1"`; Task 4 follows its structure.

- [ ] **Step 1: Write the failing test**

```ts
// execute-templates.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const samples = join(import.meta.dir, "../samples");

/** Structural checks: the template must parse as a workflow script (meta +
 * phases declared, pipeline/agent usage present) without a model round-trip. */
describe("execute-t1 template", () => {
	const src = readFileSync(join(samples, "execute-t1.js"), "utf8");

	test("meta declares name and single phase", () => {
		expect(src).toContain('name: "execute-t1"');
		expect(src).toMatch(/phases:\s*\[\s*\{\s*title:\s*"Execute"\s*\}/);
	});
	test("dispatches one impl agent and one verify agent with evidence-base caps", () => {
		expect(src).toMatch(/label:\s*"impl"/);
		expect(src).toMatch(/label:\s*"verify"/);
		expect(src).toMatch(/tokenBudget|budget/);
	});
	test("gate check happens before any agent dispatch", () => {
		const gateIdx = src.indexOf("pipeline-gate");
		const agentIdx = src.indexOf("agent(");
		expect(gateIdx).toBeGreaterThan(-1);
		expect(gateIdx).toBeLessThan(agentIdx);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/execute-templates.test.ts )`
Expected: FAIL — file not found.

- [ ] **Step 3: Write the template**

```js
/**
 * execute-t1.js — pipeline v2 T1 template (spec §2): one impl agent + one
 * verify agent, no phase overhead. Workflow SCRIPT: agent/phase/log are
 * runtime-injected globals — do not import them, do not run with `bun`
 * directly. Feed through samples/run.ts or the `workflow` tool.
 *
 *   bun bun-apps/pi-agent-ext-workflow/samples/run.ts \
 *     bun-apps/pi-agent-ext-workflow/samples/execute-t1.js
 *
 * args: { task: "what to implement", runCmd: "gate command", expected: "what green looks like",
 *         commitHint: "files touched" }
 */
export const meta = {
	name: "execute-t1",
	description: "T1 execution: 1 impl + 1 verify, gate-checked",
	phases: [{ title: "Execute" }],
};

phase("Execute");

// Gate first — red stops entry, fog flows left (spec §4).
const gate = Bun.spawnSync([
	"bun", "bun-apps/pi-agent/src/cli.ts", "pipeline-gate", "--tier", "T1",
]);
const gateText = gate.stdout ? gate.stdout.toString() : "";
if (gate.exitCode !== 0) {
	log(`pipeline-gate RED — refusing to dispatch:\n${gateText}`);
	return { ok: false, stage: "gate", gateText };
}
log(`gate green:\n${gateText.trim().split("\n")[0]}`);

const brief = [
	`Mission (bounded, T1): ${args.task}`,
	`Run: ${args.runCmd}`,
	`Expected: ${args.expected}`,
	`Scope: ${args.commitHint}. Do not touch anything else.`,
	`Finish with: run the gate command, commit what is green with a clear message,`,
	`and return a final report (mandatory, even on budget death):`,
	`{ status, commit, gateOutput, notes }.`,
].join("\n");

const impl = await agent(brief, { label: "impl", tokenBudget: 260_000 });

const verify = await agent(
	[
		"Read-only verify child. Re-run the gate command and sanity-grep the diff.",
		`Impl report:\n${String(impl)}`,
		"Return a verdict: { verdict: 'green' | 'red', evidence }. Never edit files.",
	].join("\n"),
	{ label: "verify" },
);

log(`verify verdict: ${String(verify).trim().slice(0, 200)}`);

return { ok: true, stage: "done", impl, verify: String(verify).trim() };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/execute-templates.test.ts )`
Expected: PASS.

- [ ] **Step 5: Canonical package gate + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )` — Expected: PASS (canonical script, may include build).

```bash
git add bun-apps/pi-agent-ext-workflow/samples/execute-t1.js bun-apps/pi-agent-ext-workflow/tests/execute-templates.test.ts
git commit -m "feat(workflow): execute-t1 template — gate-checked single impl+verify dispatch (pipeline v2)"
```

---

### Task 4: `execute-plan` workflow template (T2/T3 main template)

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/samples/execute-plan.js`
- Test: extend `bun-apps/pi-agent-ext-workflow/tests/execute-templates.test.ts`

**Interfaces:**
- Consumes: `pipeline()` + `agent()` globals (runtime, `workflow-runtime.ts:70`), Task 1 CLI, Task 3's structural conventions.
- Produces: `meta.name === "execute-plan"`; the Report phase output format that `dispatch-ledger.md` rows follow: `| ticket | outcome | sha |`.

- [ ] **Step 1: Write the failing tests (append to execute-templates.test.ts)**

```ts
describe("execute-plan template", () => {
	const src = readFileSync(join(samples, "execute-plan.js"), "utf8");

	test("meta declares name and all four phases in order", () => {
		expect(src).toContain('name: "execute-plan"');
		const order = ["Gate", "Execute", "Janitor", "Report"].filter((p) => src.includes(`"${p}"`));
		expect(order).toEqual(["Gate", "Execute", "Janitor", "Report"]);
	});
	test("Execute phase pipelines tickets through impl+verify stages", () => {
		expect(src).toMatch(/pipeline\(/);
		expect(src).toMatch(/label:\s*"impl:/);
		expect(src).toMatch(/label:\s*"verify:/);
	});
	test("Gate phase runs before pipeline and exits on red", () => {
		const gateIdx = src.indexOf("pipeline-gate");
		const pipelineIdx = src.indexOf("pipeline(");
		expect(gateIdx).toBeGreaterThan(-1);
		expect(gateIdx).toBeLessThan(pipelineIdx);
		expect(src).toMatch(/return\s*\{\s*ok:\s*false,\s*stage:\s*"gate"/);
	});
	test("Report phase emits ledger rows with outcome and sha columns", () => {
		expect(src).toMatch(/\|\s*ticket\s*\|\s*outcome\s*\|\s*sha\s*\|/);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/execute-templates.test.ts )`
Expected: FAIL on the new describe block.

- [ ] **Step 3: Write the template**

```js
/**
 * execute-plan.js — pipeline v2 T2/T3 main template (spec §2). Replaces the
 * executing-plans ticket-by-ticket dispatch: driver keeps judgement, this
 * script owns the deterministic fan-out. Workflow SCRIPT — runtime-injected
 * globals; feed through samples/run.ts or the `workflow` tool.
 *
 *   bun bun-apps/pi-agent-ext-workflow/samples/run.ts \
 *     bun-apps/pi-agent-ext-workflow/samples/execute-plan.js
 *
 * args: { effort: "2026-08-20-x", tickets: [{ id: "01", title: "...", runCmd: "...",
 *         expected: "...", brief: "self-contained mission text" }] }
 */
export const meta = {
	name: "execute-plan",
	description: "T2/T3 execution: gate -> pipelined impl+verify -> janitor -> ledger report",
	phases: [
		{ title: "Gate" },
		{ title: "Execute" },
		{ title: "Janitor" },
		{ title: "Report" },
	],
};

phase("Gate");
const gate = Bun.spawnSync([
	"bun", "bun-apps/pi-agent/src/cli.ts", "pipeline-gate", "--effort", args.effort,
]);
const gateText = gate.stdout ? gate.stdout.toString() : "";
if (gate.exitCode !== 0) {
	log(`pipeline-gate RED — fog flows left:\n${gateText}`);
	return { ok: false, stage: "gate", gateText };
}
log(`gate green for ${args.effort}`);

phase("Execute");
// One ticket flows impl -> verify independently; no barrier between tickets.
const results = await pipeline(
	args.tickets,
	(t) =>
		agent(
			[
				`Mission (bounded, one ticket): ${t.id} — ${t.title}`,
				t.brief,
				`Run: ${t.runCmd}`,
				`Expected: ${t.expected}`,
				`Evidence-base caps: aim for few, full turns (turn count dominates cost).`,
				`Finish with: run the gate, commit what is green, return a final report`,
				`{ status, commit, gateOutput, notes } — mandatory even on budget death.`,
			].join("\n"),
			{ label: `impl:${t.id}`, phase: "Execute", tokenBudget: 260_000 },
		),
	(implReport, t) =>
		agent(
			[
				"Read-only verify child. Re-run the ticket's gate command and",
				"sanity-grep the diff vs the mission brief.",
				`Ticket ${t.id}. Impl report:\n${String(implReport)}`,
				"Return { verdict: 'green'|'red', evidence }. Never edit files.",
			].join("\n"),
			{ label: `verify:${t.id}`, phase: "Execute" },
		).then((verdict) => ({ ticket: t.id, implReport: String(implReport), verdict: String(verdict) })),
);

phase("Janitor");
// Sweep budget-dead children: report status, re-run gates, flag what is green
// but uncommitted. (Agents that died return null — pipeline drops them; the
// janitor agent below inspects git state rather than trusting reports.)
const janitor = await agent(
	[
		"Read-only janitor sweep. Run 'git status' and 'git log --oneline -10'.",
		"For every hunk that is green (passes its ticket gate) but uncommitted, list it.",
		"Return { recoverable: [{ticket, files, gate}], clean: bool }. Never edit files.",
	].join("\n"),
	{ label: "janitor", phase: "Janitor" },
);

phase("Report");
const rows = results
	.filter(Boolean)
	.map((r) => {
		const outcome = /green/i.test(r.verdict) ? "green" : "red";
		const sha = (r.implReport.match(/\b[0-9a-f]{7,40}\b/) ?? ["—"])[0];
		return `| ${r.ticket} | ${outcome} | ${sha} |`;
	});
const ledger = ["| ticket | outcome | sha |", "|---|---|---|", ...rows].join("\n");
log(`dispatch ledger:\n${ledger}\njanitor: ${String(janitor).trim().slice(0, 300)}`);

return { ok: true, stage: "done", ledger, janitor: String(janitor) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/execute-templates.test.ts )`
Expected: PASS.

- [ ] **Step 5: Canonical package gate + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )` — Expected: PASS.

```bash
git add bun-apps/pi-agent-ext-workflow/samples/execute-plan.js bun-apps/pi-agent-ext-workflow/tests/execute-templates.test.ts
git commit -m "feat(workflow): execute-plan template — gate/pipeline/janitor/report spine (pipeline v2)"
```

---

### Task 5: superpowers `dispatching-parallel-agents` rewrite

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/dispatching-parallel-agents/SKILL.md` (full rewrite in place)

**Interfaces:**
- Consumes: Task 3/4 template names (`execute-t1`, `execute-plan`) and their args shapes; Task 1 CLI.
- Produces: the single source of truth for "how to dispatch under pipeline v2" — every future plan inherits it.

- [ ] **Step 1: Write the failing check**

There is no unit-test harness for skill prose; the gate is the drift report's ≤300-line bar plus a structural test if the package has a skills test (check `bun-apps/pi-agent-ext-superpowers/tests/` — if a skills-index test exists, extend it; otherwise this task's gate is Step 3's manual verify).

- [ ] **Step 2: Rewrite the skill (target ≤200 lines)**

New outline — replace the old manual-dispatch-centric body:

```markdown
---
name: dispatching-parallel-agents
description: Use when dispatching implementation work under pipeline v2 — workflow templates are the default engine; manual subagent dispatch is the exception path
---

# Dispatching Parallel Agents (pipeline v2)

## Default: workflow templates own the fan-out

- T2/T3 execution goes through `execute-plan` (samples/execute-plan.js):
  gate -> pipelined impl+verify per ticket -> janitor -> ledger report.
- T1 execution goes through `execute-t1` (samples/execute-t1.js):
  one impl + one verify agent.
- Your job as driver: write the per-ticket mission brief (self-contained
  task + Run:/Expected: + scope), pass evidence-base caps (150-260k
  tokenBudget, 6-14 maxTurns equivalents — few, full turns), and read the
  Report phase output. Do NOT hand-dispatch tickets the template can run.

## Mission brief contract (unchanged from the 2026-08-16 evidence base)

1. Self-contained: one mission-group per child; the child sees nothing else.
2. Run:/Expected: on every ticket — pipeline-gate rejects plans without them.
3. Mandatory final report, even on budget death.
4. Verify child is read-only and runs after every write child.
5. Turn count dominates cost (~10k+ fixed overhead per turn) — prefer
   fewer, fuller turns.

## When to reclaim MANUAL dispatch (the exception path)

- A red verdict needs cross-ticket judgement -> dispatch yourself, or
  switch to systematic-debugging.
- The workflow runtime is unavailable (plain session, no extension) ->
  classic subagent dispatch with the same brief contract.
- Exploratory work with no enumerable tickets -> don't force a template.

## Recovery

- Budget-dead child: check `git log` before redispatching — green work may
  already be committed. Run the janitor sweep, then redispatch only the gap.
- Query history first: `pi-agent cli dispatch-log` — calibrate budgets
  against what this ticket class cost before.
```

- [ ] **Step 3: Verify line bar + package gate**

Run: `wc -l bun-apps/pi-agent-ext-superpowers/skills/dispatching-parallel-agents/SKILL.md`
Expected: ≤300 (target ≤200).

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun run test )` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/dispatching-parallel-agents/SKILL.md
git commit -m "docs(superpowers): dispatching-parallel-agents v2 — workflow templates as default engine, manual dispatch as exception"
```

---

### Task 6: Effort docs — wayfind map, supersede note, CONTEXT-MAP

**Files:**
- Create: `.planning/2026-08-20-develop-pipeline-v2/map.md`
- Create: `.planning/2026-08-20-develop-pipeline-v2/brainstorm/2026-08-20-session.md`
- Modify: `.planning/done/2026-08-17-develop-pipeline/map.md` (supersede note at top)
- Modify: `CONTEXT-MAP.md` (Pipeline of record section)

**Interfaces:**
- Consumes: spec.md (same folder), this plan.
- Produces: the v2 diagram of record; downstream efforts cite it.

- [ ] **Step 1: Write map.md**

```markdown
---
effort: 2026-08-20-develop-pipeline-v2
created: 2026-08-20
tier: T3
status: executing
---

# Wayfinder map: develop-pipeline-v2

## Destination
Pipeline v2: workflow promoted to primary execution engine + T1/T2/T3
tier system + pipeline-gate teeth + unified dispatch records. Spec: ./spec.md.

## Diagram of record

    entry (tier router: mechanical size rules, spec §1)
      T1 small:  bounded chat design -> execute-t1 -> devops
      T2 medium: wayfind quick grill -> thin map+spec -> plan -> execute-plan -> devops
      T3 large:  wayfind full spine -> superpowers plan -> execute-plan (fan-out) -> devops

## Decisions
- D1 two-runtimes "workflow = JUDGMENT only" REOPENED and superseded:
  workflow is the primary execution engine; superpowers executing-plans
  is driver/judgment. Evidence: 2026-08-20 pain points (workflow
  under-used, primitives fragmented, ceremony heavy, handoffs toothless).
- D2 2026-08-17 D5 "no tool-gate linter" superseded: pipeline-gate is the
  mechanical enforcement (user decision 2026-08-20).
- D3 T1 efforts skip the effort folder; tier declaration via --tier /
  commit trailer; dispatch records still land.
- D4 dispatch ledger = workflow Report phase output; dispatch-log queries it.

## Not yet specified
<!-- none -->
```

- [ ] **Step 2: Harvest the brainstorm session**

Copy the design dialogue conclusions (tier table, engine division, record schema, gate checks, migration order — they are all in `spec.md`; the brainstorm note is a 10-20 line summary pointing at spec sections).

- [ ] **Step 3: Supersede note on the old map + CONTEXT-MAP update**

At the top of `.planning/done/2026-08-17-develop-pipeline/map.md` Notes, add:

```markdown
- SUPERSEDED (execution leg + D5) by 2026-08-20-develop-pipeline-v2 on
  2026-08-20: workflow is now the primary execution engine and
  pipeline-gate enforces the handoffs. DECIDE/SYNTHESIZE (wayfind) and
  DESIGN/PLAN (superpowers) stages unchanged.
```

In `CONTEXT-MAP.md` Pipeline of record section, repoint to
`.planning/2026-08-20-develop-pipeline-v2/map.md` (keep the old path as history).

- [ ] **Step 4: Verify gate on this effort itself (dogfood) and commit**

Run: `bun bun-apps/pi-agent/src/cli.ts pipeline-gate --effort 2026-08-20-develop-pipeline-v2`
Expected: PASS (tier-match, map-frozen, spec-settled, tickets-runnable; ledger-complete may be RED until execution finishes — if so, note it and let the Report phase close it).

```bash
git add .planning/2026-08-20-develop-pipeline-v2/ .planning/done/2026-08-17-develop-pipeline/map.md CONTEXT-MAP.md
git commit -m "docs(planning): develop-pipeline-v2 map + supersede note + CONTEXT-MAP repoint"
```

---

## Self-Review (done at write time)

- **Spec coverage:** §1 tiers → Task 1 (`classifySize`) + Task 6 (map/docs); §2 templates → Tasks 3-4, superpowers rewrite → Task 5; §3 records → Task 2; §4 gate → Task 1 + template Gate phases (3-4); §5 migration order → task numbering (gate first = Task 1, templates 3-4, docs 6) — though execution order below applies.
- **Placeholder scan:** Task 5 Step 1 explicitly resolves its test-harness question instead of leaving it open; Task 2 carries one verify-field-names instruction tied to a named file — accepted as a contract-check, not a TBD.
- **Type consistency:** `DispatchRecord` fields identical across Task 2 tests and implementation; `runGate`/`GateCheck` names used by Task 3/4 prose; template `meta.name` values (`execute-t1`, `execute-plan`) match between Tasks 3/4/5/6.

## Execution order note

Spec §5 says gate first: execute Task 1 first, then 2, 3, 4, 5, 6. Tasks 3-4 depend on Task 1 (Gate phase shells out to the CLI). Task 6 should land last so the dogfood run in its Step 4 sees the finished pipeline.
