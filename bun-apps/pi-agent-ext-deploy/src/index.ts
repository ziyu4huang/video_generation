/**
 * pi-agent-ext-deploy — factory registering pi_deploy + pi_verify.
 *
 * Two thin tools that wrap the existing build/verify/deploy scripts:
 *   • pi_deploy — codegen → bundle pi-agent.js → thin ext bundles →
 *                 factory-verify → freeze (mirrors scripts/deploy.ts).
 *   • pi_verify — run a run-test.sh tier (quick|medium|high|readonly|full).
 *
 * Scripts stay the single source of truth; argv logic is pure (argv.ts) and
 * spawning/guarding lives in run.ts. Human-in-chat driver: the user asks the
 * agent to build/verify/deploy and the agent invokes the tool as a one-off.
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runDeploy } from "./deploy-tool.ts";
import { runVerify } from "./verify-tool.ts";

const piDeployTool = defineTool({
	name: "pi_deploy",
	label: "Build & Deploy pi-agent Bundle",
	description:
		"Build and deploy the pi-agent bundle + thin extension bundles (mirrors `bun scripts/deploy.ts`). " +
		"Returns mode, outDir, pi-agent.js size, ext-bundle built/failed counts, exit code, and a log path.",
	parameters: Type.Object({
		mode: Type.Optional(
			Type.Union(
				[Type.Literal("bundle"), Type.Literal("snapshot"), Type.Literal("standalone"), Type.Literal("exe")],
				{ description: "Deploy mode. Default: bundle.", default: "bundle" },
			),
		),
		outDir: Type.Optional(
			Type.String({
				description: "Output dir. Must be under <repo>/dist/ or the OS temp dir. Default: <repo>/dist/pi-agent.",
			}),
		),
		noFreeze: Type.Optional(Type.Boolean({ description: "Skip chmod a-w (dev). Default: false.", default: false })),
	}),
	async execute(_id, params) {
		try {
			const r = await runDeploy({
				mode: params.mode as "bundle" | "snapshot" | "standalone" | "exe" | undefined,
				outDir: params.outDir,
				noFreeze: params.noFreeze ?? false,
			});
			const text =
				(r.ok ? "✓ deployed" : "✗ deploy failed") +
				` (mode=${r.mode}, exit=${r.exitCode}, ext built=${r.extBundles.built}` +
				(r.extBundles.failed.length ? `, failed=${r.extBundles.failed.join(",")}` : "") +
				`, pi-agent.js=${r.piAgentJsBytes ? `${(r.piAgentJsBytes / 1e6).toFixed(1)}MB` : "n/a"})` +
				(r.logPath ? `\nlog: ${r.logPath}` : "") +
				(r.errorTail ? `\n${r.errorTail}` : "");
			return {
				content: [{ type: "text" as const, text }],
				details: r,
				isError: r.ok ? undefined : true,
			};
		} catch (err) {
			return {
				content: [{ type: "text" as const, text: `Error: ${String((err as Error).message ?? err)}` }],
				details: { ok: false },
				isError: true,
			};
		}
	},
});

const piVerifyTool = defineTool({
	name: "pi_verify",
	label: "Verify pi-agent (run-test.sh tier)",
	description:
		"Run a pi-agent run-test.sh tier (quick|medium|high|readonly|full; default medium) and report per-step pass/fail. " +
		"high = the exact CI `deploy -- verify` job. Returns steps, exit code, and a log path.",
	parameters: Type.Object({
		tier: Type.Optional(
			Type.Union(
				[Type.Literal("quick"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("readonly"), Type.Literal("full")],
				{ description: "run-test.sh tier. Default: medium.", default: "medium" },
			),
		),
		bail: Type.Optional(Type.Boolean({ description: "Stop on first failure (--bail). Default: false.", default: false })),
	}),
	async execute(_id, params) {
		try {
			const r = await runVerify({
				tier: params.tier as "quick" | "medium" | "high" | "readonly" | "full" | undefined,
				bail: params.bail ?? false,
			});
			const stepLines = r.steps.map((s) => `  ${s.passed ? "✓" : "✗"} ${s.name} (${s.seconds}s)`).join("\n");
			const text =
				(r.ok ? "✓ verify passed" : "✗ verify failed") +
				` (tier=${r.tier}, exit=${r.exitCode})` +
				(stepLines ? `\n${stepLines}` : "") +
				(r.logPath ? `\nlog: ${r.logPath}` : "") +
				(r.errorTail ? `\n${r.errorTail}` : "");
			return {
				content: [{ type: "text" as const, text }],
				details: r,
				isError: r.ok ? undefined : true,
			};
		} catch (err) {
			return {
				content: [{ type: "text" as const, text: `Error: ${String((err as Error).message ?? err)}` }],
				details: { ok: false },
				isError: true,
			};
		}
	},
});

const extension: ExtensionFactory = (pi) => {
	pi.registerTool(piDeployTool);
	pi.registerTool(piVerifyTool);
};

export default extension;
