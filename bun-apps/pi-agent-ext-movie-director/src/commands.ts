/**
 * commands.ts — the movie-director CLI command table.
 *
 * The 19 orchestration commands become deterministic, no-LLM top-level CLI
 * commands: each is a thin wrapper that calls the SHARED `dispatch()` (from
 * src/dispatch.ts — the same function the `movie` agent tool calls), so the CLI
 * path and the agent-tool path are provably the same logic. Add/fix a command
 * once in dispatch.ts and both surfaces update.
 *
 * Plus:
 *   • `agent` — natural-language orchestration. Shells out to the pi binary
 *     (`bun bun-apps/pi-agent/src/cli.ts -e <this-extension> -p <prompt>`) with
 *     the movie extension baked in. This is the README's documented agent
 *     invocation, reused verbatim — robust (pi is a workspace sibling + the SDK
 *     is a dep) and zero session-machinery duplication.
 *   • meta commands (help / version) are handled in cli.ts directly.
 *
 * Option passing for deterministic commands: loose `--key value` flags + the
 * `--options '<JSON>'` merge (parsed by src/args.ts) land in `parsed.options`,
 * which is forwarded straight to dispatch(). So `pipeline-show --pipeline foo`
 * dispatches `{pipeline:"foo"}`, and `generate --capability image_generation
 * --command t2i --options '{"options":{"prompt":"a cube"}}'` merges the nested
 * prompt blob.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, COMMAND_REFERENCE, commandReferenceBlock, dispatch, type Command as DispatchCommand } from "./dispatch.ts";
import type { ParsedArgs } from "./args.ts";

/** A top-level CLI command (mirrors pi-agent's Command shape). */
export interface Command {
	name: string;
	summary: string;
	details: string;
	run: (parsed: ParsedArgs) => Promise<void>;
}

/** One-line summary for a dispatch command, parsed from its reference block. */
function summaryFor(name: string): string {
	const firstLine = commandReferenceBlock(name).split("\n")[0] ?? "";
	// Format: "  • <name>  — <summary text>."
	const dash = firstLine.indexOf("—");
	if (dash === -1) return name;
	return firstLine.slice(dash + 1).trim().replace(/\.$/, "");
}

/** Pretty-print or JSON-envelope a dispatch result to stdout/stderr. */
function printDispatchResult(name: string, res: { ok: true; text: string } | { ok: false; error: string }, parsed: ParsedArgs): void {
	if (res.ok) {
		if (parsed.json) {
			// Re-parse the dispatch payload (it is already JSON) into an envelope
			// so a programmatic consumer gets {ok, command, result} uniformly.
			let payload: unknown;
			try {
				payload = JSON.parse(res.text);
			} catch {
				payload = res.text;
			}
			console.log(JSON.stringify({ ok: true, command: name, result: payload }, null, 2));
		} else {
			console.log(res.text);
		}
		return;
	}
	// Error path: stderr for humans; stdout JSON envelope for --json consumers.
	if (parsed.json) {
		console.log(JSON.stringify({ ok: false, command: name, error: res.error }));
	} else {
		console.error(`error: ${res.error}`);
	}
	process.exitCode = 1;
}

/**
 * Build a deterministic Command that forwards parsed.options to dispatch(name).
 * Each is a 1:1 mirror of the `movie` tool's command — no LLM, no agent.
 */
function makeDispatchCommand(name: DispatchCommand): Command {
	return {
		name,
		summary: summaryFor(name),
		details: commandReferenceBlock(name),
		run: async (parsed) => {
			const res = await dispatch(name, parsed.options);
			printDispatchResult(name, res, parsed);
		},
	};
}

/** The 18 deterministic orchestration commands. */
export const DETERMINISTIC_COMMANDS: Command[] = COMMANDS.map((c) => makeDispatchCommand(c as DispatchCommand));

/** Names of the deterministic commands (for fast lookup / reserved-set). */
export const COMMAND_NAMES: Set<string> = new Set(DETERMINISTIC_COMMANDS.map((c) => c.name));

// ─── agent command ──────────────────────────────────────────────────────────

/**
 * Resolve the pi CLI entry to shell out to for the `agent` command.
 *
 * Order: `PI_BIN` env override → the in-repo `bun-apps/pi-agent/src/cli.ts`
 * (resolved from this file's location). Throws a clear error if neither
 * resolves, so the failure names the missing path instead of a silent ENOENT.
 */
export function resolvePiBin(opts: { exists?: (p: string) => boolean; dir?: string } = {}): string {
	const exists = opts.exists ?? existsSync;
	const envBin = process.env.PI_BIN;
	if (envBin && exists(envBin)) return envBin;
	// import.meta.dir = .../pi-agent-ext-movie-director/src; repo root = 3 levels up.
	const base = opts.dir ?? import.meta.dir;
	const repoRoot = join(base, "..", "..", "..");
	const inRepo = join(repoRoot, "bun-apps", "pi-agent", "src", "cli.ts");
	if (exists(inRepo)) return inRepo;
	throw new Error(
		`agent: could not resolve the pi binary.\n` +
			`  Looked for: PI_BIN env (${envBin ?? "unset"}) and ${inRepo}.\n` +
			`  Set PI_BIN to your pi CLI entry, or run from within the repo.`,
	);
}

/** Resolve the movie-director extension factory path to pass via `-e`. */
export function resolveExtensionPath(opts: { exists?: (p: string) => boolean; dir?: string } = {}): string {
	const exists = opts.exists ?? existsSync;
	const base = opts.dir ?? import.meta.dir;
	const ext = join(base, "..", "extensions", "movie-director.ts");
	if (exists(ext)) return ext;
	throw new Error(`agent: movie-director extension not found at ${ext}`);
}

/** Build the agent task string from parsed args (mirrors cli-subcommand.ts). */
export function buildAgentTask(parsed: ParsedArgs): string {
	const request = [...parsed.positionals.slice(1), ...parsed.doubleDash].join(" ").trim();
	if (!request) {
		return (
			"Use the movie tool to help the user with video production. " +
			"Ask or infer what they want (a concept, duration, scene count, style), " +
			"then drive the orchestration pipeline. Call movie_help first for the " +
			"command reference and stage contract."
		);
	}
	return (
		"Use the movie tool to fulfill this video-production request. Drive the " +
		"orchestration pipeline (idea → script → scene_plan → assets → edit → compose), " +
		"honoring gate-enforced checkpoints. Call movie_help first if you need the " +
		"command reference. This spends real GPU tokens — run it once and report " +
		"faithfully. Request:\n\n" +
		request
	);
}

/** Build the argv vector handed to spawn (pure — testable without spawning). */
export function buildAgentArgv(parsed: ParsedArgs, opts: { piBin: string; extPath: string }): string[] {
	const argv = ["bun", opts.piBin];
	// Forward agent-relevant globals.
	if (parsed.provider) argv.push("--provider", parsed.provider);
	if (parsed.model) argv.push("--model", parsed.model);
	if (parsed.thinking) argv.push("--thinking", parsed.thinking);
	if (parsed.mode) argv.push("--mode", parsed.mode);
	if (parsed.verbose >= 1) argv.push("-V");
	// Load THIS extension (registers movie + movie_help tools + the scope guard).
	argv.push("-e", opts.extPath);
	// Non-interactive one-shot.
	argv.push("-p", buildAgentTask(parsed));
	return argv;
}

/** Spawn the pi binary with the movie extension baked in, inheriting stdio. */
function runAgentShell(parsed: ParsedArgs, opts: { piBin?: string; extPath?: string; spawn?: typeof spawn } = {}): Promise<number> {
	const piBin = opts.piBin ?? resolvePiBin();
	const extPath = opts.extPath ?? resolveExtensionPath();
	const doSpawn = opts.spawn ?? spawn;
	const argv = buildAgentArgv(parsed, { piBin, extPath });

	return new Promise((resolve) => {
		const child = doSpawn(argv[0]!, argv.slice(1), {
			stdio: "inherit",
			env: process.env,
		});
		child.on("exit", (code) => resolve(code ?? 0));
	});
}

/** The natural-language orchestration command (shells out to pi). */
export const agentCommand: Command = {
	name: "agent",
	summary: "natural-language video-production orchestration via the pi agent + movie tool",
	details: `Usage:
  bun .../pi-agent-ext-movie-director/src/cli.ts agent <natural-language request...> [options]

Drives the full pipeline — idea → script → scene_plan → assets → edit → compose
→ publish — with the pi agent mapping your request onto the \`movie\` tool's
gate-enforced commands. This spends real GPU tokens (MLX image + video gen).

Implementation: shells out to the pi binary (\`bun bun-apps/pi-agent/src/cli.ts\`)
with the movie-director extension baked in (\`-e\`), the same invocation the
README documents for agent-driven runs. Override the pi entry via \`PI_BIN\`.

Options (forwarded to pi):
  --model <pattern>      provider/id[:thinking]  (e.g. sonnet, gemma-4-26b)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --mode json            NDJSON event stream
  -V, --verbose          tool verbosity (repeat for debug)

The deterministic commands (preflight, pipeline-list, generate, compose, …) are
faster and free for everything that does not need the agent's judgement.

Examples:
  bun .../cli.ts agent produce a 30s ad: red sports car on a coastal road
  bun .../cli.ts agent --model sonnet "3-scene product demo for a smartwatch"
  bun .../cli.ts agent -- compose --plan scene_plan.json   # raw flags via --`,
	run: async (parsed) => {
		const code = await runAgentShell(parsed);
		process.exitCode = code;
	},
};

// ─── registry ───────────────────────────────────────────────────────────────

/** All commands (deterministic + agent), in display order. */
export const ALL_COMMANDS: Command[] = [...DETERMINISTIC_COMMANDS, agentCommand];

/** Every command name including meta tokens (help/version reserved in cli.ts). */
export const ALL_NAMES: Set<string> = new Set(ALL_COMMANDS.map((c) => c.name));

/** Find a command by name, or undefined. */
export function findCommand(name: string): Command | undefined {
	return ALL_COMMANDS.find((c) => c.name === name);
}

export { COMMAND_REFERENCE };
