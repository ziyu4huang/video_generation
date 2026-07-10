/**
 * `workflow run <name>` — headless runner for pi-dynamic-workflows scripts.
 *
 * This is a NON-agent meta-command: it calls `runWorkflow()` DIRECTLY (from
 * `@repo/pi-dynamic-workflows`), bypassing the agent session pipeline
 * that `commands/zk-*.ts` and the extension sub-commands use. That is the whole
 * point — the deterministic engine (gate / retry / loopUntilDry / journaling /
 * resume) is reachable from the CLI, a script, or a hook, not only from the
 * VSCode workflow editor. See `docs/workflow-cli.md`.
 *
 * Script resolution order (first hit wins):
 *   1. `<name>` as a literal path (absolute, or relative to cwd) when it exists.
 *   2. `.claude/workflows/<name>.js` (repo engine scripts — closed-loop-proof, …).
 *   3. `bun-apps/<pkg>/workflows/<name>.js` (package-local engine scripts).
 *   4. The literal `<name>` with a `.js` suffix tried in (2) and (3).
 *
 * `.claude/workflows/*.js` are ALSO runnable by Claude Code's own `Workflow`
 * tool (best-effort); running them HERE gives them the deterministic gates. The
 * two runtimes share the `agent()`/`phase()`/`export const meta` script syntax.
 *
 * Flags: `--args '<JSON>'` (the script's `args` global), `--model <spec>`
 * (session main model, also the default for untagged agents), `--dry-run`
 * (parse + validate the script only, no agent calls), `--no-persist-logs`
 * (logs persist by default). Global flags (`--thinking`, `--provider`, …) are
 * accepted but only `--model`/`--provider` feed the workflow agent.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, isAbsolute, dirname } from "node:path";
import type { ParsedArgs } from "../args.ts";
import type { Command } from "../cli.ts";

// `@repo/pi-dynamic-workflows` is a workspace dependency. Import the
// engine + its script parser by name so the bundler treats them as externals
// exactly like the other workspace deps (pi-obsidian, pi-vlm, …).
import { runWorkflow, parseWorkflowScript, type WorkflowAgent } from "@repo/pi-dynamic-workflows";

/** Where engine workflow scripts live in this repo (Claude-Code-shared). */
const CLAUDE_WORKFLOWS_DIR = ".claude/workflows";
/** Package-local engine workflow script directories. */
const PKG_WORKFLOWS_GLOB = "bun-apps";

export interface ResolvedWorkflow {
	/** Absolute path to the script file that was read. */
	path: string;
	/** Script source text. */
	script: string;
	/** How it was resolved, for the run receipt. */
	source: "path" | ".claude/workflows" | "package-workflows";
}

/**
 * Resolve a workflow `<name>` (or path) to its script text. Pure + injectable
 * (readFileSync + repo root) so the contract test can exercise every branch
 * without touching the engine or an LLM.
 */
export function resolveWorkflowScript(
	name: string,
	opts: { cwd?: string; read?: (p: string) => string; exists?: (p: string) => boolean } = {},
): ResolvedWorkflow {
	if (!name || typeof name !== "string" || !name.trim()) {
		throw new Error(`workflow: a script name or path is required (got "${name}")`);
	}
	const cwd = opts.cwd ?? process.cwd();
	const read = opts.read ?? ((p) => readFileSync(p, "utf8"));
	const exists = opts.exists ?? ((p) => existsSync(p));

	// 1. Literal path (absolute, or relative to cwd).
	const asPath = isAbsolute(name) ? name : resolve(cwd, name);
	if (exists(asPath) && statSyncOrNull(asPath)?.isFile()) {
		return { path: asPath, script: read(asPath), source: "path" };
	}

	// Candidate names with and without the .js suffix (so `workflow run foo`
	// and `workflow run foo.js` both work).
	const names = name.endsWith(".js") ? [name] : [`${name}.js`, name];

	// 2. .claude/workflows/<name>(.js)
	const claudeRoot = findRepoRoot(cwd, exists);
	if (claudeRoot) {
		for (const candidate of names) {
			const p = join(claudeRoot, CLAUDE_WORKFLOWS_DIR, candidate);
			if (exists(p) && statSyncOrNull(p)?.isFile()) {
				return { path: p, script: read(p), source: ".claude/workflows" };
			}
		}

		// 3. bun-apps/<pkg>/workflows/<name>(.js)
		const pkgRoot = join(claudeRoot, PKG_WORKFLOWS_GLOB);
		if (exists(pkgRoot) && statSyncOrNull(pkgRoot)?.isDirectory()) {
			for (const pkg of readdirSync(pkgRoot)) {
				for (const candidate of names) {
					const p = join(pkgRoot, pkg, "workflows", candidate);
					if (exists(p) && statSyncOrNull(p)?.isFile()) {
						return { path: p, script: read(p), source: "package-workflows" };
					}
				}
			}
		}
	}

	throw new Error(
		`workflow: script "${name}" not found.\n` +
			`Looked for: ${asPath}\n` +
			(claudeRoot
				? `  ${join(claudeRoot, CLAUDE_WORKFLOWS_DIR, names[0]!)}\n` +
					`  ${join(claudeRoot, PKG_WORKFLOWS_GLOB, "<pkg>", "workflows", names[0]!)}\n`
				: "") +
			`Pass an absolute path or a name under .claude/workflows/ or bun-apps/<pkg>/workflows/.`,
	);
}

/** Stats a path, returning undefined on ENOENT/etc. Use `?.isFile()` — undefined
 *  (unlike `false`) is nullish so the optional-chaining narrows correctly. */
function statSyncOrNull(
	p: string,
): { isFile: () => boolean; isDirectory: () => boolean } | undefined {
	try {
		return statSync(p);
	} catch {
		return undefined;
	}
}

/**
 * Walk up from `start` to the first dir containing `.claude/workflows/` or a
 * `bun-apps/` dir — the repo root for workflow-script resolution. Falls back to
 * `start` itself so an absolute-path run outside a repo still resolves the path
 * branch above. Pure (uses the injected `exists`).
 */
function findRepoRoot(start: string, exists: (p: string) => boolean): string | undefined {
	let dir = start;
	for (let i = 0; i < 12; i++) {
		if (exists(join(dir, CLAUDE_WORKFLOWS_DIR)) || exists(join(dir, PKG_WORKFLOWS_GLOB))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

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
function buildMainSpec(parsed: ParsedArgs): string | undefined {
	const model = parsed.model;
	const provider = parsed.provider;
	if (!model) return undefined;
	// Already provider-qualified?
	if (model.includes("/")) return model;
	return provider ? `${provider}/${model}` : model;
}

export interface RunWorkflowScriptOptions {
	name: string;
	args?: unknown;
	model?: string;
	dryRun?: boolean;
	persistLogs?: boolean;
	cwd?: string;
	/**
	 * Injectable agent (the LLM caller). Defaults to a real WorkflowAgent; tests
	 * pass a stub so the engine's gates run without network/LLM access. Typed to
	 * match `Pick<WorkflowAgent, "run">` so it threads straight into runWorkflow.
	 */
	agent?: Pick<WorkflowAgent, "run">;
	/**
	 * Streaming callbacks so the CLI can show phase/agent progress. Same shapes
	 * as runWorkflow's onPhase/onAgentEnd.
	 */
	onPhase?: (title: string) => void;
	onAgentEnd?: (event: { label: string; phase?: string; result: unknown; error?: string }) => void;
}

/**
 * Core runner: resolve → (dry-run validates only) → runWorkflow. Returns the
 * engine's receipt plus the resolved script path. Exported so the contract test
 * drives it with a stub agent and no LLM.
 */
export async function runWorkflowScript(
	opts: RunWorkflowScriptOptions,
): Promise<{
	meta: { name: string; description: string };
	result: unknown;
	logs: string[];
	phases: string[];
	agentCount: number;
	durationMs: number;
	runId?: string;
	scriptPath: string;
	source: ResolvedWorkflow["source"];
	dryRun: boolean;
}> {
	const resolved = resolveWorkflowScript(opts.name, { cwd: opts.cwd });
	const { meta } = parseWorkflowScript(resolved.script);

	if (opts.dryRun) {
		return {
			meta: { name: meta.name, description: meta.description },
			result: { validated: true },
			logs: [`dry-run: script "${meta.name}" parsed and validated (${resolved.path})`],
			phases: [],
			agentCount: 0,
			durationMs: 0,
			scriptPath: resolved.path,
			source: resolved.source,
			dryRun: true,
		};
	}

	const receipt = await runWorkflow(resolved.script, {
		args: opts.args,
		mainModel: opts.model,
		persistLogs: opts.persistLogs ?? true,
		cwd: opts.cwd,
		...(opts.agent ? { agent: opts.agent } : {}),
		onPhase: opts.onPhase,
		onAgentEnd: opts.onAgentEnd as any,
	});

	return {
		meta: { name: receipt.meta.name, description: receipt.meta.description },
		result: receipt.result,
		logs: receipt.logs,
		phases: receipt.phases,
		agentCount: receipt.agentCount,
		durationMs: receipt.durationMs,
		runId: receipt.runId,
		scriptPath: resolved.path,
		source: resolved.source,
		dryRun: false,
	};
}

/** `workflow run <name> [options]`. */
export const workflowRunCommand: Command = {
	name: "run",
	summary: "Run a pi-dynamic-workflows script headlessly (deterministic engine).",
	details: `Usage: bun-pi-agent-cli workflow run <name> [options]

Runs a workflow script through the deterministic engine (runWorkflow from
@repo/pi-dynamic-workflows) — the SAME engine the VSCode workflow editor
uses, but headlessly. The engine's gate / retry / loopUntilDry / journaling /
resume primitives are therefore reachable from the CLI, a script, or a hook.

Script resolution (first hit wins):
  1. <name> as a literal path (absolute or relative to cwd)
  2. .claude/workflows/<name>.js
  3. bun-apps/<pkg>/workflows/<name>.js

Options:
  --args '<JSON>'        JSON value for the script's \`args\` global
  --model <spec>         session main model: "id", "provider/id" (also the
                         default for agents the script leaves untagged)
  --provider <name>      provider prefix when --model has no "/"
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --dry-run              parse + validate the script only (no agents, no LLM)
  --no-persist-logs      skip writing the run log to disk (logs persist by default)

Output: a one-line receipt (run id, agents, duration, result kind) + the final
result as JSON when --json is set.

Examples:
  bun-pi-agent-cli workflow run closed-loop-proof
  bun-pi-agent-cli workflow run closed-loop-proof --args '{"kbFile":"mlx-movie-director-self-improve"}'
  bun-pi-agent-cli workflow run ./my-workflow.js --model lm-studio/google/gemma-4-26b-a4b-qat
  bun-pi-agent-cli workflow run closed-loop-proof --dry-run`,
	run: async (parsed: ParsedArgs): Promise<void> => {
		const name = parsed.positionals[0];
		if (!name) {
			console.error("Usage: workflow run <name> [--args JSON] [--model spec] [--dry-run]\n");
			console.error("Resolve a name from .claude/workflows/ or bun-apps/<pkg>/workflows/, or pass a path.");
			throw new Error("workflow run: <name> is required");
		}

		const args = parseWorkflowArgs(parsed.workflowArgs);
		const model = buildMainSpec(parsed);

		const receipt = await runWorkflowScript({
			name,
			args,
			model,
			dryRun: parsed.dryRun,
			persistLogs: !parsed.noPersistLogs,
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
	details: `Usage: bun-pi-agent-cli workflow list

Enumerates .claude/workflows/*.js and bun-apps/<pkg>/workflows/*.js, parsing
each script's \`export const meta\` to print name + description. Scripts that
fail to parse are reported as errors (not skipped silently) so a broken script
is surfaced.`,
	run: async (parsed: ParsedArgs): Promise<void> => {
		const cwd = process.cwd();
		const claudeRoot = findRepoRoot(cwd, existsSync) ?? cwd;
		const dirs = [
			{ label: ".claude/workflows", dir: join(claudeRoot, CLAUDE_WORKFLOWS_DIR) },
			...readdirSyncSafe(join(claudeRoot, PKG_WORKFLOWS_GLOB)).map((pkg) => ({
				label: `bun-apps/${pkg}/workflows`,
				dir: join(claudeRoot, PKG_WORKFLOWS_GLOB, pkg, "workflows"),
			})),
		];
		const rows: { source: string; name: string; description: string }[] = [];
		const errors: { path: string; message: string }[] = [];
		for (const { label, dir } of dirs) {
			if (!existsSync(dir)) continue;
			for (const file of readdirSyncSafe(dir)) {
				if (!file.endsWith(".js")) continue;
				const p = join(dir, file);
				try {
					const { meta } = parseWorkflowScript(readFileSync(p, "utf8"));
					rows.push({ source: label, name: meta.name, description: meta.description });
				} catch (e) {
					errors.push({ path: p, message: (e as Error).message.split("\n")[0]! });
				}
			}
		}
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
			console.log(`  ${r.name.padEnd(nameW)}  ${r.source.padEnd(srcW)}  ${r.description}`);
		}
		if (errors.length) {
			console.log(`\n${errors.length} script(s) failed to parse:`);
			for (const e of errors) console.log(`  ✗ ${e.path}: ${e.message}`);
		}
	},
};

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

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

// Re-export `basename` so callers/tests importing this module can derive a
// short label from a resolved path without a second import.
export const _basename = basename;
