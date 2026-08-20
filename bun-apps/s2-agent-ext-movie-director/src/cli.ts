/**
 * cli.ts — the movie-director standalone CLI entry point.
 *
 *   bun bun-apps/s2-agent-ext-movie-director/src/cli.ts <command> [options]
 *
 * A self-contained CLI mirroring `s2-agent`'s shape, but for the
 * movie-director orchestration layer. Each of the 19 orchestration commands is
 * a deterministic, no-LLM top-level command (a direct call to the shared
 * `dispatch()`), plus an `agent` command for natural-language runs. Designed so
 * orchestration workflows are scriptable / CI-friendly without spinning up an
 * LLM for the parts that don't need one (preflight, pipeline-list, checkpoint
 * reads/writes, cost, compose, final-review).
 *
 * Routing is split into a PURE `route(argv)` decision (exported, fully unit-
 * testable with no spawn) and a thin `main()` executor. See README.md
 * §"Standalone CLI" for the command reference + examples.
 */
import { parseArgs } from "./args.ts";
import { ALL_COMMANDS, ALL_NAMES, agentCommand, findCommand } from "./commands.ts";
import { COMMAND_REFERENCE, commandReferenceBlock } from "./dispatch.ts";

const VERSION = "0.1.0";

/** Exported for CI-safe execution tests (no subprocess spawn). */
export { execute as executeRoute, VERSION };

/** A pure routing decision for an argv vector (no side effects). */
export type Route =
	| { kind: "version" }
	| { kind: "help"; target?: string }
	| { kind: "command"; name: string }
	| { kind: "agent-passthrough" };

/**
 * Decide what `main()` should do for a given argv. Pure + total — the unit-test
 * surface for CLI routing (no spawn, no console, no process mutation).
 *
 * Precedence:
 *   1. --version / -v flag, or `version` meta token → version
 *   2. no args → root help
 *   3. `help [target]` → help (root, or one command's reference)
 *   4. `<cmd> --help` → that command's reference
 *   5. first positional is a known command → dispatch it
 *   6. otherwise → agent-passthrough (the whole line is a natural-language prompt)
 */
export function route(argv: string[]): Route {
	const parsed = parseArgs(argv);
	if (parsed.version) return { kind: "version" };
	if (argv.length === 0) return { kind: "help" };

	const first = parsed.positionals[0];
	if (first === "version") return { kind: "version" };
	if (first === "help") return { kind: "help", target: parsed.positionals[1] };
	if (parsed.help) return { kind: "help", target: first };
	if (first && ALL_NAMES.has(first)) return { kind: "command", name: first };
	return { kind: "agent-passthrough" };
}

function printRootHelp(): void {
	const cmdLines = ALL_COMMANDS.map((c) => `  ${c.name.padEnd(16)} ${c.summary}`).join("\n");
	console.log(`movie-director v${VERSION} — instruction-driven video production orchestration (OpenMontage rewrite)

Usage:
  bun .../s2-agent-ext-movie-director/src/cli.ts <command> [options]
  bun .../s2-agent-ext-movie-director/src/cli.ts <command> --help   (per-command reference)

Deterministic commands (no LLM — direct calls to the orchestration core):
${cmdLines}

Meta:
  help [command]                 Show root help, or one command's full reference
  version                        Print version

Passing options:
  --<key> <value>                A dispatch option (value-coerced: number/bool/JSON/string)
                                  e.g. --pipeline talking-head --stage idea --humanApproved
  --<key>=<value>                Inline form (use for dash/negative values: --offset=-5)
  --options '<JSON>'             Merge a JSON object of options (escape hatch for nested values)
  --                             End-of-options: the rest is an agent prompt verbatim

Global flags:
  --json                         Emit a {ok, command, result|error} envelope (for scripts)
  -V, --verbose                  Verbose (repeat for debug)
  --model/--provider/--thinking  Forwarded to the agent command only
  --mode json                    NDJSON event stream (agent command)
  --dry-run                      (accepted; forwarded to agent)
  -h, --help / -v, --version     Help / version

The deterministic commands are a 1:1 mirror of the \`movie\` tool — they call the
SAME dispatch() the agent calls, so behavior is identical. Use \`agent\` only when
you need the LLM to map a free-form concept onto the pipeline.

Examples:
  bun .../cli.ts preflight
  bun .../cli.ts pipeline-list
  bun .../cli.ts pipeline-show --pipeline talking-head
  bun .../cli.ts init-project --projectId demo --pipeline talking-head
  bun .../cli.ts write-checkpoint --projectId demo --pipeline talking-head --stage idea --humanApproved
  bun .../cli.ts cost-snapshot --projectId demo
  bun .../cli.ts generate --capability image_generation --command t2i --options '{"options":{"prompt":"a red cube"}}'
  bun .../cli.ts agent produce a 30s ad: red sports car on a coastal road
  bun .../cli.ts agent --model sonnet "3-scene product demo"

Environment:
  PI_BIN                Override the pi CLI entry the agent command shells out to
  MD_*                  movie-director runtime overrides (see README)`);
}

/** `help [command]` — root help, or one command's reference block. */
function printHelp(target: string | undefined): void {
	if (!target) {
		printRootHelp();
		return;
	}
	const cmd = findCommand(target);
	if (cmd) {
		console.log(cmd.details);
		return;
	}
	console.error(`Unknown command: ${target}\n\nCommands: ${[...ALL_NAMES].join(", ")}`);
	process.exitCode = 1;
}

/** Execute a routing decision (the only side-effecting part of the CLI). */
async function execute(route: Route, argv: string[]): Promise<void> {
	switch (route.kind) {
		case "version":
			console.log(`movie-director ${VERSION}`);
			return;
		case "help":
			printHelp(route.target);
			return;
		case "command": {
			const cmd = findCommand(route.name);
			if (cmd) {
				await cmd.run(parseArgs(argv));
				return;
			}
			// Should be unreachable (route only returns known names).
			console.error(`Unknown command: ${route.name}`);
			process.exitCode = 1;
			return;
		}
		case "agent-passthrough":
			await agentCommand.run(parseArgs(argv));
			return;
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	await execute(route(argv), argv);
}

if (import.meta.main) {
	try {
		await main();
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`error: ${msg}`);
		process.exitCode = 1;
	}
}

// Re-export for tests / programmatic use.
export { parseArgs, ALL_COMMANDS, ALL_NAMES, findCommand, COMMAND_REFERENCE, commandReferenceBlock };
