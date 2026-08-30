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
