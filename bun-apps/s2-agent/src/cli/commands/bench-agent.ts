/**
 * `bench-agent` — GLM speed/effectiveness benchmark.
 *
 * Modes:
 *   (default)  run the focused config×task matrix; emit results.jsonl + REPORT.md
 *   --probe prefill  T1 cold+warm under full vs stripped tool loads (context-cost A/B)
 *   --dry      fixtures + gates only, canned outputs, zero LLM calls (self-test)
 *
 * Each matrix cell is fresh-isolated: a temp copy of the task fixture, a fresh
 * shared session pinned to the config's model+thinking, one prompt, then
 * metrics extraction + the task's deterministic quality gate (bench/core +
 * bench/tasks). No silent model fallback: every cell logs its resolved model
 * line to stderr, and the resolved id is asserted to be the requested GLM.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "../args.ts";
// Type-only: dispatch imports this module at runtime, so a value import here
// would close a cycle. Erased at compile time (same pattern as
// extensions/registry.ts line 12).
import type { Command } from "../dispatch.ts";
import {
	type BenchConfig,
	type CellResult,
	type MetricsMessage,
	DEFAULT_CONFIGS,
	extractMetrics,
	finalAssistantText,
	renderReport,
} from "../bench/core.ts";
import { BENCH_TASKS, copyFixtureToTemp, type BenchTask } from "../bench/tasks.ts";
import { createSharedSession, resolveLLM } from "../sessions/shared.ts";

const PROBE_TASK = BENCH_TASKS[0]!; // needle
const DEFAULT_TIMEOUT_SEC = 300;

export function selectConfigs(csv?: string): BenchConfig[] {
	if (!csv) return DEFAULT_CONFIGS;
	const wanted = csv.split(",").map((s) => s.trim()).filter(Boolean);
	const legal = DEFAULT_CONFIGS.map((c) => c.id);
	const unknown = wanted.filter((w) => !legal.includes(w));
	if (unknown.length > 0) {
		throw new Error(`unknown config id(s): ${unknown.join(", ")}. Legal: ${legal.join(", ")}`);
	}
	return DEFAULT_CONFIGS.filter((c) => wanted.includes(c.id));
}

export function selectTasks(csv?: string): BenchTask[] {
	if (!csv) return BENCH_TASKS;
	const wanted = csv.split(",").map((s) => s.trim()).filter(Boolean);
	const legal = BENCH_TASKS.map((t) => t.id);
	const unknown = wanted.filter((w) => !legal.includes(w));
	if (unknown.length > 0) {
		throw new Error(`unknown task id(s): ${unknown.join(", ")}. Legal: ${legal.join(", ")}`);
	}
	return BENCH_TASKS.filter((t) => wanted.includes(t.id));
}

interface PromptOutcome {
	ok: boolean;
	error?: string;
	wallMs: number;
}

/** Structural session slice the bench touches (same pattern as
 *  task-runner.ts) — keeps this module free of pi-coding-agent type imports. */
interface BenchSession {
	prompt: (task: string) => Promise<void>;
	subscribe: (fn: (event: { type: string; message?: { role?: string } }) => void) => () => void;
}

/** Race one prompt against a wall-clock timeout; never rejects. The finally
 *  clears the timer on BOTH success and failure paths. */
async function promptWithTimeout(
	session: { prompt: (task: string) => Promise<void> },
	task: string,
	timeoutMs: number,
): Promise<PromptOutcome> {
	const t0 = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			session.prompt(task),
			new Promise<never>((_, rej) => {
				timer = setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
		return { ok: true, wallMs: Date.now() - t0 };
	} catch (e: any) {
		return { ok: false, error: String(e?.message ?? e), wallMs: Date.now() - t0 };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** One prompt + REAL per-turn durations, measured from message_end event
 *  arrivals: Date.now() at the subscriber for every event, then each assistant
 *  arrival minus the previous arrival (or prompt start for the first entry).
 *  This is the only trustworthy per-turn clock — message timestamps are
 *  stream-start stamped by pi-ai (before the fetch), so timestamp deltas
 *  measure call-initiation gap, not generation. Unsubscribes before returning. */
async function promptCollectingDurations(
	session: BenchSession,
	task: string,
	timeoutMs: number,
): Promise<PromptOutcome & { turnDurationsMs: number[] }> {
	const arrivals: { role?: string; arrivalMs: number }[] = [];
	const unsubscribe = session.subscribe((evt) => {
		if (evt.type === "message_end" && evt.message) {
			arrivals.push({ role: evt.message.role, arrivalMs: Date.now() });
		}
	});
	const promptStartMs = Date.now();
	try {
		const outcome = await promptWithTimeout(session, task, timeoutMs);
		const turnDurationsMs: number[] = [];
		let prevMs: number | undefined; // previous ENTRY's arrival, any role
		for (const a of arrivals) {
			if (a.role === "assistant") {
				const dur = a.arrivalMs - (prevMs ?? promptStartMs);
				if (dur > 0) turnDurationsMs.push(dur);
			}
			prevMs = a.arrivalMs;
		}
		return { ...outcome, turnDurationsMs };
	} finally {
		unsubscribe();
	}
}

/** Assert the resolved lane is the requested GLM — the harness must not
 *  silently fall back to another model and pollute the matrix. */
function assertGLMLane(provider: string, modelId: string): void {
	if (!modelId.includes("glm-5.3")) {
		throw new Error(`refusing to bench: resolved model ${provider}/${modelId} is not glm-5.3`);
	}
}

/** One matrix cell: fresh temp fixture, fresh session, one prompt, metrics + gate.
 *  One transient retry (timeout or throw on attempt 0 gets a second attempt;
 *  attempt 1 always resolves into a CellResult, never throws). */
async function runCell(config: BenchConfig, task: BenchTask, timeoutMs: number): Promise<CellResult> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const runDir = await copyFixtureToTemp(task);
		let created: Awaited<ReturnType<typeof createSharedSession>> | undefined;
		try {
			const llm = resolveLLM({ model: `${config.model}:${config.thinking}` });
			assertGLMLane(llm.provider, llm.modelId);
			created = await createSharedSession(llm, { cwd: runDir, tools: task.tools });
			console.error(`[bench] model: ${llm.provider}/${llm.modelId}:${llm.thinkingLevel}`);
			const outcome = await promptCollectingDurations(created.session, task.prompt, timeoutMs);
			if (!outcome.ok && attempt === 0) continue; // one transient retry (finally disposes)
			// AgentMessage is structurally a MetricsMessage superset; cast at the boundary.
			const messages = created.session.messages as unknown as MetricsMessage[];
			const metrics = extractMetrics(messages, outcome.wallMs, outcome.turnDurationsMs);
			const quality = await task.check(finalAssistantText(messages), runDir);
			return {
				configId: config.id,
				taskId: task.id,
				ok: outcome.ok,
				error: outcome.error,
				metrics,
				quality,
			};
		} catch (e: any) {
			if (attempt === 1) {
				return {
					configId: config.id,
					taskId: task.id,
					ok: false,
					error: String(e?.message ?? e),
					metrics: null,
					quality: null,
				};
			}
		} finally {
			created?.session.dispose();
		}
	}
	/* unreachable: attempt 1 always returns */ throw new Error("runCell exhausted retries");
}

/** --dry: no sessions, no LLM. Copy each fixture, run its gate on a canned
 *  final reply (needle+analysis canned-pass, edit canned-fail — a pristine
 *  edit fixture fails its own tests), render the (DRY) report. */
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
		cells.push({ configId: "dry", taskId: task.id, ok: true, metrics: extractMetrics([], 0, []), quality });
	}
	return { report: renderReport(cells, { startedAt: new Date().toISOString(), dry: true }), cells };
}

/** --probe prefill: needle task, one session per load, prompt twice (cold then warm). */
async function runPrefillProbe(timeoutMs: number): Promise<string> {
	const loads = [
		{ name: "full", tools: undefined as string[] | undefined },
		{ name: "stripped", tools: ["read"] as string[] | undefined },
	];
	const rows: string[] = [
		"| load | tools | cold wall(s) | warm wall(s) | cold cacheW | warm cacheR |",
		"|---|---|---|---|---|---|",
	];
	for (const load of loads) {
		const runDir = await copyFixtureToTemp(PROBE_TASK);
		const llm = resolveLLM({ model: "zai/glm-5.3:high" });
		assertGLMLane(llm.provider, llm.modelId);
		const { session } = await createSharedSession(llm, { cwd: runDir, tools: load.tools });
		try {
			console.error(`[probe:${load.name}] model: ${llm.provider}/${llm.modelId}:${llm.thinkingLevel}`);
			const toolCount = (session.getActiveToolNames?.() ?? []).length;
			// Each prompt gets its own subscribe window (cold durations from cold's
			// arrivals, warm likewise); allM spans both prompts → concat.
			const cold = await promptCollectingDurations(session, PROBE_TASK.prompt, timeoutMs);
			const coldM = extractMetrics(
				session.messages as unknown as MetricsMessage[],
				cold.wallMs,
				cold.turnDurationsMs,
			);
			const warm = await promptCollectingDurations(
				session,
				"Again — reply with only the exact token.",
				timeoutMs,
			);
			const allM = extractMetrics(
				session.messages as unknown as MetricsMessage[],
				warm.wallMs,
				[...cold.turnDurationsMs, ...warm.turnDurationsMs],
			);
			const warmCacheRead = allM.cacheReadTokens - coldM.cacheReadTokens;
			rows.push(
				`| ${load.name} | ${toolCount} | ${(cold.wallMs / 1000).toFixed(1)} | ${(warm.wallMs / 1000).toFixed(1)} | ${coldM.cacheWriteTokens} | ${warmCacheRead} |`,
			);
		} finally {
			session.dispose();
		}
	}
	return [`# bench-agent prefill probe — ${new Date().toISOString()}`, "", ...rows].join("\n");
}

async function runBenchAgent(parsed: ParsedArgs): Promise<void> {
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
			console.error(
				`[bench] ${config.id} × ${task.id} → ${
					cell.ok
						? cell.quality?.pass
							? "quality PASS"
							: `quality FAIL (${cell.quality?.detail})`
						: `ERROR ${cell.error}`
				}`,
			);
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

export const benchAgentCommand: Command = {
	name: "bench-agent",
	summary: "GLM speed/effectiveness benchmark (config×task matrix + prefill probe)",
	details: `Usage:
  s2-agent cli bench-agent [options]

Runs the focused GLM speed/effectiveness matrix (5 configs × 3 tasks)
headlessly, applies deterministic quality gates, and writes results.jsonl +
REPORT.md under output/bench-agent/<ts>/.

Configs (default: all):
  5.3-high, 5.3-medium, 5.3-low (zai/glm-5.3 at high/medium/low thinking),
  5.3-highspeed (zai/glm-5.3-highspeed:high), 5.3-flash (zai/glm-5.3-flash:medium)

Tasks (default: all):
  needle    exact-token retrieval (read-only)
  edit      fix a failing bun test in a temp fixture copy (read/edit/bash)
  analysis  cross-file answers from a small mixed-language tree (read-only)

Options:
  --configs <csv>      subset of configs (e.g. 5.3-high,5.3-low)
  --tasks <csv>        subset of tasks (e.g. needle,edit)
  --probe prefill      context-cost A/B: needle cold+warm under full vs
                       stripped tool loads
  --dry                self-test: fixtures + gates only, canned outputs,
                       zero LLM calls
  --timeout-sec <n>    per-cell prompt timeout in seconds (default 300)

Examples:
  s2-agent cli bench-agent --dry
  s2-agent cli bench-agent --configs 5.3-high --tasks needle --timeout-sec 180
  s2-agent cli bench-agent --probe prefill`,
	run: runBenchAgent,
};
