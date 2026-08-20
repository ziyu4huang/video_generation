/**
 * `workflow run <name>` — headless runner for s2-agent-ext-workflow scripts.
 *
 * This is a NON-agent meta-command: it calls the engine's shared
 * `runWorkflowScript` DIRECTLY (from `@repo/s2-agent-ext-workflow`), bypassing
 * the agent session pipeline that `commands/zk-*.ts` and the extension
 * sub-commands use. That is the whole point — the deterministic engine
 * (gate / retry / loopUntilDry / journaling / resume) is reachable from the
 * CLI, a script, or a hook, not only from the VSCode workflow editor or the
 * interactive `workflow` tool. See `../docs/workflow-cli.md`.
 *
 * The pack resolver + orchestration LIVE IN THE ENGINE (`workflow-pack.ts`) and
 * are shared with the `workflow` tool's `name` parameter (Path B). This CLI
 * layer is a thin wrapper: flag parsing (--args/--model/--out-dir/...), env
 * read (PI_WORKFLOWS_OUT_DIR), and receipt printing. Resolution order, pack
 * precedence, and args/model merging are owned by the engine — one source of
 * truth across both entry paths.
 *
 * Flags: `--args '<JSON>'` (the script's `args` global), `--model <spec>`
 * (session main model, also the default for untagged agents), `--dry-run`
 * (parse + validate the script only, no agent calls), `--no-persist-logs`
 * (logs persist by default). Global flags (`--thinking`, `--provider`, …) are
 * accepted but only `--model`/`--provider` feed the workflow agent.
 */
import { existsSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import type { Command } from "../dispatch.ts";

// `@repo/s2-agent-ext-workflow` is a workspace dependency. Import the shared
// resolver + orchestration by name so the bundler treats them as externals
// exactly like the other workspace deps (pi-obsidian, pi-file2md, …).
import { runWorkflowScript, listWorkflows, findRepoRoot } from "@repo/s2-agent-ext-workflow";
// pi-default model spec: reuse the SAME settings-read as `resolveLLMFromArgs`
// (no second reader) and feed it through `resolveLLM` with NO provider/model
// override so only user settings + the hardcoded fallback apply. The resulting
// `provider/modelId` is forwarded to the engine as the lowest-precedence tier
// (--model > PI_MODEL > manifest.model > pi-default).
import { resolveLLM } from "../sessions/shared.ts";
import { readUserDefaults } from "../sessions/passthrough.ts";

/**
 * Parse the `--args` value (a JSON string, or omitted). Throws a clear error on
 * bad JSON instead of letting the workflow fail with an opaque parse error.
 */
export function parseWorkflowArgs(raw: string | undefined): unknown {
	if (raw === undefined || raw === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`workflow: --args must be valid JSON (${(e as Error).message}). Got: ${raw}`,
		);
	}
}

/** Build the `provider/modelId` spec passed as the workflow's main model. */
export function buildMainSpec(parsed: ParsedArgs): string | undefined {
	const model = parsed.model;
	const provider = parsed.provider;
	if (!model) return undefined;
	// Already provider-qualified?
	if (model.includes("/")) return model;
	return provider ? `${provider}/${model}` : model;
}

/** `workflow run <name> [options]`. */
export const workflowRunCommand: Command = {
	name: "run",
	summary: "Run a s2-agent-ext-workflow script headlessly (deterministic engine).",
	details: `Usage: s2-agent cli workflow run <name> [options]

Runs a workflow script through the deterministic engine (runWorkflow from
@repo/s2-agent-ext-workflow) — the SAME engine the VSCode workflow editor and
the interactive \`workflow\` tool use, but headlessly. The engine's gate / retry /
loopUntilDry / journaling / resume primitives are therefore reachable from the
CLI, a script, or a hook.

Script resolution (first hit wins) — shared with the \`workflow\` tool's \`name\`:
  1. <name> as a literal path (absolute or relative to cwd)
  2. <cwd>/workflows/<name>   (portable tier; a pack folder wins over a same-name .js)
  3. <binDir>/workflows/<name>   (binDir = dirname(process.execPath); pack-over-file)
  4. .pi/workflows/<name>   (under the repo root; pack-over-file)
  5. bun-apps/<pkg>/workflows/<name>

Options:
  --args '<JSON>'        JSON value for the script's \`args\` global
  --model <spec>         session main model: "id", "provider/id" (also the
                         default for agents the script leaves untagged)
  --provider <name>      provider prefix when --model has no "/"
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --dry-run              parse + validate the script only (no agents, no LLM)
  --no-persist-logs      skip writing the run log to disk (logs persist by default)
  --out-dir <dir>        run-log output dir (default PWD/.pi/workflows/runs;
                         also via PI_WORKFLOWS_OUT_DIR env; absolute or cwd-relative)

Output: a one-line receipt (run id, agents, duration, result kind) + the final
result as JSON when --json is set.

Examples:
  s2-agent cli workflow run echo
  s2-agent cli workflow run echo --args '{"msg":"hi"}'
  s2-agent cli workflow run ./my-workflow.js --model lm-studio/google/gemma-4-12b
  s2-agent cli workflow run echo --dry-run`,
	run: async (parsed: ParsedArgs): Promise<void> => {
		const name = parsed.positionals[0];
		if (!name) {
			console.error("Usage: workflow run <name> [--args JSON] [--model spec] [--dry-run]\n");
			console.error("Resolve a name from <cwd>/workflows/, <binDir>/workflows/, .pi/workflows/, or bun-apps/<pkg>/workflows/, or pass a path.");
			throw new Error("workflow run: <name> is required");
		}

		const args = parseWorkflowArgs(parsed.workflowArgs);
		const model = buildMainSpec(parsed);
		// Output dir precedence: --out-dir flag > PI_WORKFLOWS_OUT_DIR env > PWD/.pi default.
		const outDir = parsed.outDir ?? process.env.PI_WORKFLOWS_OUT_DIR;

		// pi-default model spec: resolveLLM with NO caller/provider override, so
		// only user settings + the hardcoded fallback (zai/glm-5.3) apply. The
		// engine's 4-tier precedence then picks among callerModel (--model),
		// envModel (PI_MODEL), manifest.model, and this pi-default — surfaced in
		// the receipt as `model` + `modelSource`.
		const piDefault = resolveLLM({ userDefaults: await readUserDefaults() });
		const piDefaultModel = `${piDefault.provider}/${piDefault.modelId}`;
		const envModel = process.env.PI_MODEL;

		const receipt = await runWorkflowScript({
			name,
			args,
			callerModel: model,
			envModel,
			piDefaultModel,
			dryRun: parsed.dryRun,
			persistLogs: !parsed.noPersistLogs,
			outDir,
			onPhase: (title) => {
				if (parsed.verbose >= 1) console.log(`▶ phase: ${title}`);
			},
			onAgentEnd: (event) => {
				if (parsed.verbose >= 1) {
					const tag = event.error ? `FAIL: ${event.error}` : "ok";
					console.log(`  · ${event.label} [${tag}]`);
				}
			},
		});

		const resultKind = kindOf(receipt.result);
		// `model` may be undefined when no tier produced a spec (source "none") —
		// omit the tag entirely in that case instead of rendering `model: ?`.
		const modelTag = receipt.model ? ` (model: ${receipt.model} [${receipt.modelSource}])` : "";
		if (parsed.json) {
			console.log(
				JSON.stringify(
					{
						meta: receipt.meta,
						runId: receipt.runId,
						agents: receipt.agentCount,
						durationMs: receipt.durationMs,
						phases: receipt.phases,
						scriptPath: receipt.scriptPath,
						source: receipt.source,
						model: receipt.model,
						modelSource: receipt.modelSource,
						dryRun: receipt.dryRun,
						result: receipt.result,
					},
					null,
					2,
				),
			);
		} else {
			console.log(
				`✓ ${receipt.meta.name} — agents=${receipt.agentCount} ` +
					`${receipt.durationMs ? `${receipt.durationMs}ms ` : ""}` +
					`${modelTag}` +
					`(source: ${receipt.source})` +
					(receipt.runId ? ` run=${receipt.runId}` : "") +
					` → ${resultKind}`,
			);
		}
	},
};

/** `workflow list` — enumerate resolvable workflow scripts with their metas. */
export const workflowListCommand: Command = {
	name: "list",
	summary: "List resolvable workflow scripts (with name + description).",
	details: `Usage: s2-agent cli workflow list

Enumerates <cwd>/workflows/*, <binDir>/workflows/*, .pi/workflows/*, and
bun-apps/<pkg>/workflows/* — both workflow packs (folders with manifest.json)
and single-file scripts (*.js) — parsing each to print name + description.
Entries that fail to parse are reported as errors (not skipped silently) so a
broken artifact is surfaced.`,
	run: async (parsed: ParsedArgs): Promise<void> => {
		const cwd = process.cwd();
		const claudeRoot = findRepoRoot(cwd, existsSync) ?? cwd;
		const { rows, errors } = listWorkflows(claudeRoot);
		if (parsed.json) {
			console.log(JSON.stringify({ workflows: rows, errors }, null, 2));
			return;
		}
		if (!rows.length) {
			console.log("No workflow scripts found.");
			return;
		}
		const nameW = Math.max(4, ...rows.map((r) => r.name.length));
		const srcW = Math.max(6, ...rows.map((r) => r.source.length));
		for (const r of rows) {
			console.log(`  ${r.name.padEnd(nameW)}  ${r.source.padEnd(srcW)}  [${r.kind}]  ${r.description}`);
		}
		if (errors.length) {
			console.log(`\n${errors.length} workflow(s) failed to list:`);
			for (const e of errors) console.log(`  ✗ ${e.path}: ${e.message}`);
		}
	},
};

function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return `string (${value.length} chars)`;
	if (typeof value !== "object") return typeof value;
	if (Array.isArray(value)) return `array (${value.length})`;
	try {
		const keys = Object.keys(value as Record<string, unknown>);
		return `object {${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
	} catch {
		return "object";
	}
}
