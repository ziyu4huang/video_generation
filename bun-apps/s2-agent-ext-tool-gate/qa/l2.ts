/**
 * Layer-2 — task-level capability (wayfinder ticket 04).
 *
 * Two tiers of signal:
 *
 *  (1) REACHABILITY (deterministic, always produced, unit-tested). For each
 *      curated task, is the intended gated tool even REACHABLE under tool-gate
 *      ON — i.e. does the gate fire on the task prompt, OR can `enable_tool`
 *      intent-mode reach it — vs OFF (always reachable)? A task that is
 *      reachable OFF but not ON is a CONFIRMED capability regression: the agent
 *      can only obtain the tool via a proactive name-mode `enable_tool` call.
 *      No LLM needed to know this — it's a property of the keyword/gate logic.
 *
 *  (2) LIVE USAGE (experimental; armed by --model; NOT calibrated without a
 *      configured model). Drives `s2-agent -p` ON vs OFF per task, repeats N
 *      times, and detects whether the agent called the intended tool. Answers
 *      "did the agent actually USE it" — the question reachability can't.
 *
 * Fog resolved here (graduated from the map):
 *   - success-judge: tool-usage detection (objective, cheapest) for live;
 *     reachability for the deterministic tier.
 *   - flake budget: N=3 per cell (prototype — NOT statistically rigorous; a
 *     real verdict would raise N and add a significance test).
 */
import { spawn } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { gateFires, matchIntent } from "../extensions/tool-gate.ts";
import { CORPUS_GATES } from "./evaluate.ts";
import { L2_TASKS, type L2Task } from "./l2-tasks.ts";

// M9: resolve the s2-agent CLI absolutely from this file's location so the
// live A/B spawn works regardless of process.cwd(). l2.ts lives at
// bun-apps/s2-agent-ext-tool-gate/qa/, so ../../s2-agent/src/cli.ts.
const __QA_DIR = dirname(fileURLToPath(import.meta.url));
const PI_AGENT_CLI = resolvePath(__QA_DIR, "..", "..", "s2-agent", "src", "cli.ts");

const findGate = (id: string) => {
	const g = CORPUS_GATES.find((x) => x.names[0] === id);
	if (!g) throw new Error(`L2 task references unknown gate '${id}'`);
	return g;
};
const emptySticky = new Set<string>();

// ── tier 1: reachability (deterministic) ────────────────────────────────────

export interface ReachabilityResult {
	task: L2Task;
	/** Gate fires on the task prompt (keyword / requires). */
	firesOnPrompt: boolean;
	/** enable_tool({intent: prompt}) reaches the intended gate. */
	intentReaches: boolean;
	/** If the intent reaches a DIFFERENT gate (misroute), its identity; else null. */
	misroutesTo: string | null;
	/** Reachable under ON = fires OR intent-reaches. */
	onReachable: boolean;
	/** Always true (OFF = ungated). */
	offReachable: boolean;
	/** Reachable OFF but not ON — confirmed capability regression. */
	gap: boolean;
	/** onReachable matches the author's expectReachable. */
	predictionHeld: boolean;
}

export function evaluateReachability(tasks: L2Task[] = L2_TASKS): ReachabilityResult[] {
	return tasks.map((task) => {
		const matched = matchIntent(task.prompt, CORPUS_GATES, emptySticky);
		const intendedMatched = matched.some((g) => g.names[0] === task.intendedGate);
		const firesOnPrompt = gateFires(findGate(task.intendedGate), task.prompt.toLowerCase());
		const onReachable = firesOnPrompt || intendedMatched;
		const misroutesTo = intendedMatched
			? null
			: matched.length
				? matched[0].names[0]
				: null;
		return {
			task,
			firesOnPrompt,
			intentReaches: intendedMatched,
			misroutesTo,
			onReachable,
			offReachable: true,
			gap: !onReachable,
			predictionHeld: onReachable === task.expectReachable,
		};
	});
}

export interface ReachabilitySummary {
	total: number;
	reachable: number;
	gaps: number;
	misroutes: number;
	predictionsHeld: boolean;
	gapTasks: string[];
}

export function summarizeReachability(r: ReachabilityResult[]): ReachabilitySummary {
	return {
		total: r.length,
		reachable: r.filter((x) => x.onReachable).length,
		gaps: r.filter((x) => x.gap).length,
		misroutes: r.filter((x) => x.misroutesTo).length,
		predictionsHeld: r.every((x) => x.predictionHeld),
		gapTasks: r.filter((x) => x.gap).map((x) => x.task.id),
	};
}

// ── tier 2: live usage (EXPERIMENTAL — armed by --model) ────────────────────
// Untested without a configured model: the spawn invocation + output parsing
// are reasonable against `s2-agent -p` but need calibration on the first armed
// run. Fails gracefully per-run; never throws.

export interface LiveOpts {
	model?: string;
	/** Repetitions per (task × arm). Prototype default 3 — not rigorous. */
	n?: number;
	/** Per-run timeout ms. */
	timeoutMs?: number;
}

export interface LiveTaskResult {
	id: string;
	intendedGate: string;
	onUsedPct: number;
	offUsedPct: number;
	samples: { arm: "on" | "off"; used: boolean; error?: string }[];
}

export interface LiveResult {
	ran: boolean;
	reason: string;
	results?: LiveTaskResult[];
}

/**
 * Heuristic: did the agent call `toolName`? Greps the captured output for the
 * tool name in a call-ish context. CALIBRATION NEEDED against real `-p` output
 * (pi may render tool calls differently) — see runbook in ticket 04 resolution.
 */
export function detectToolUsage(output: string, toolName: string): boolean {
	const re = new RegExp(`\\b${toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
	return re.test(output);
}

function runOnce(prompt: string, arm: "on" | "off", opts: LiveOpts): Promise<{ output: string; error?: string }> {
	const env = { ...process.env };
	if (arm === "off") env.TOOL_GATE_DISABLE = "1";
	const args = ["run", PI_AGENT_CLI];
	if (opts.model) args.push("--model", opts.model);
	args.push("-p", prompt);
	return new Promise((resolve) => {
		const child = spawn("bun", args, {
			cwd: dirname(PI_AGENT_CLI),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 60_000);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ output: out, error: `spawn error: ${e.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ output: out, error: code && code !== 0 ? `exit ${code}` : undefined });
		});
	});
}

export async function runLive(tasks: L2Task[] = L2_TASKS, opts: LiveOpts = {}): Promise<LiveResult> {
	if (!opts.model) {
		return {
			ran: false,
			reason: "live A/B needs a model — pass --model <provider/id> to arm. Reachability (deterministic) is always produced; live usage is the remaining question.",
		};
	}
	const n = opts.n ?? 3;
	const results: LiveTaskResult[] = [];
	for (const task of tasks) {
		const samples: LiveTaskResult["samples"] = [];
		for (let i = 0; i < n; i++) {
			for (const arm of ["on", "off"] as const) {
				const r = await runOnce(task.prompt, arm, opts);
				samples.push({ arm, used: !r.error && detectToolUsage(r.output, task.intendedGate), error: r.error });
			}
		}
		const pct = (arm: "on" | "off") =>
			Math.round((samples.filter((s) => s.arm === arm && s.used).length / n) * 100);
		results.push({
			id: task.id,
			intendedGate: task.intendedGate,
			onUsedPct: pct("on"),
			offUsedPct: pct("off"),
			samples,
		});
	}
	return { ran: true, reason: `live A/B (${n} reps/cell)`, results };
}

// ── formatting ──────────────────────────────────────────────────────────────

export function formatReachability(r: ReachabilityResult[]): string[] {
	const lines: string[] = ["task                  intended       on  off  verdict", "─".repeat(58)];
	for (const x of r) {
		const verdict = x.gap
			? `GAP${x.misroutesTo ? ` (misroute→${x.misroutesTo})` : ""}`
			: `reachable${x.intentReaches && !x.firesOnPrompt ? " (intent)" : ""}`;
		lines.push(
			`${x.task.id.padEnd(20)}  ${x.task.intendedGate.padEnd(14)} ${x.onReachable ? "y" : "n"}   y    ${verdict}`,
		);
	}
	return lines;
}
