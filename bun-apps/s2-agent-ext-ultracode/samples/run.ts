/**
 * run.ts — LIBRARY-LEVEL runner for a workflow `.js` file (NOT full e2e).
 *
 * Calls runWorkflow() DIRECTLY — no pi TUI, no CLI, no `workflow` tool, no
 * model in the loop writing a script. This is the fastest way to exercise the
 * workflow runtime against a real model, but it BYPASSES the s2-agent CLI /
 * argv parsing / extension loading / the workflow tool itself. For a TRUE
 * end-to-end smoke through the same path a user invokes
 * (`s2-agent -e workflow -p …`), use samples/smoke-e2e.ts instead.
 *
 * Usage (from repo root):
 *   bun bun-apps/s2-agent-ext-ultracode/samples/run.ts <script.js> [args-json]
 *
 *   # default smoke:
 *   bun bun-apps/s2-agent-ext-ultracode/samples/run.ts \
 *     bun-apps/s2-agent-ext-ultracode/samples/dynamic-workflow-smoke01.js
 *
 * The model defaults to PI_MODEL (the same env s2-agent bridges). Set it
 * explicitly for reproducibility:
 *   PI_MODEL=prism-ml/bonsai-27b bun …/run.ts …/smoke01.js
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
