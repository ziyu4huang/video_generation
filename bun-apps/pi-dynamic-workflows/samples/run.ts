/**
 * run.ts — standalone, non-interactive runner for a workflow `.js` file.
 *
 * Runs the workflow runtime DIRECTLY via runWorkflow() — no pi TUI, no model
 * in the loop to write a script. Feed it a workflow script file (one that
 * starts with `export const meta = { … }` and calls agent()/phase()/log()), and
 * it executes synchronously and prints a JSON summary to stdout.
 *
 * Usage (from repo root):
 *   bun bun-apps/pi-dynamic-workflows/samples/run.ts <script.js> [args-json]
 *
 *   # default smoke:
 *   bun bun-apps/pi-dynamic-workflows/samples/run.ts \
 *     bun-apps/pi-dynamic-workflows/samples/dynamic-workflow-smoke01.js
 *
 * The model defaults to PI_MODEL (the same env pi-agent bridges). Set it
 * explicitly for reproducibility:
 *   PI_MODEL=google/gemma-4-26b-a4b-qat bun …/run.ts …/smoke01.js
 *
 * This is the batch-mode path: deterministic script in, JSON out, exit 0 on
 * success / non-zero on workflow error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWorkflow } from "../src/workflow.ts";

const file = process.argv[2];
if (!file) {
	console.error("usage: bun samples/run.ts <script.js> [args-json]");
	process.exit(2);
}

const script = readFileSync(resolve(process.cwd(), file), "utf8");
const args = process.argv[3] ? JSON.parse(process.argv[3]!) : undefined;

const onLog = (m: string) => console.error(`[log] ${m}`);

try {
	const r = await runWorkflow(script, {
		args,
		mainModel: process.env.PI_MODEL,
		onLog,
		onPhase: (title: string) => console.error(`[phase] ${title}`),
	});
	console.log(
		JSON.stringify(
			{
				ok: true,
				name: r.meta.name,
				result: r.result,
				phases: r.phases,
				agents: r.agentCount,
				durationMs: r.durationMs,
				tokens: r.tokenUsage?.total ?? null,
			},
			null,
			2,
		),
	);
	process.exit(0);
} catch (e) {
	console.error(`workflow failed: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}
