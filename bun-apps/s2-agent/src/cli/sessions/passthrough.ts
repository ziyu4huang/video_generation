/**
 * Pi-compatible passthrough runner.
 *
 * This is the mode entered when argv does not match a friendly sub-command.
 * It mirrors `pi -p` / `pi --mode json` behavior closely enough that the
 * pi-obsidian `obsidian_distill` / `obsidian_garden` subagent tools — which
 * re-invoke `process.argv[1]` with flags like
 *   --mode json -p --no-session --approve -e <pkg> --tools <csv>
 *   --append-system-prompt <tmpfile> <task>
 * — work transparently. The `-e` flag dynamically imports extension factories
 * (source mode only; compiled binary users should use the extension's registered
 * subcommand). The `--approve` flag is accepted and ignored (self-trusted).
 *
 * Output modes:
 *   text  — stream assistant text deltas to stdout (human readable)
 *   json  — emit one NDJSON event per line (pi schema subset), consumed by the
 *           obsidian subagent parser which reads `message_end` assistant text.
 *
 * `resolveLLMFromArgs` / `readUserDefaults` (moved to shared.ts) and
 * `applyVaultEnv` (moved to ../vault-paths.ts) started here; only the
 * passthrough run itself remains.
 */
import { applyDryRun, resolveLLMFromArgs } from "./shared.ts";
import { runSessionTurn } from "./run-agent-session.ts";
import { applyVaultEnv } from "../vault-paths.ts";
import { resolve } from "node:path";
import type { ParsedArgs } from "../args.ts";

/**
 * Dynamically import extension factories from file paths. Only works in source
 * mode (Bun natively imports .TS). In compiled binary mode these imports fail
 * gracefully — the user sees a warning and should use the extension's registered
 * CLI subcommand instead (e.g. `s2-agent cli power-tool`).
 *
 * Paths are resolved against cwd (not the CLI's own location), matching how
 * the original s2-agent's `-e` flag works.
 */
async function loadExtensions(paths: string[], cwd: string): Promise<unknown[]> {
	const factories: unknown[] = [];
	for (const p of paths) {
		try {
			// Resolve relative paths against cwd to match s2-agent's -e behavior.
			const abs = resolve(cwd, p);
			const mod = await import(abs);
			const ext = mod.default ?? mod.extension ?? Object.values(mod)[0];
			if (typeof ext === "function") {
				factories.push(ext);
			} else {
				console.error(`[passthrough] extension "${p}" has no default export (expected a factory function)`);
			}
		} catch (e) {
			console.error(`[passthrough] could not load extension "${p}": ${(e as Error).message}. Use the extension's CLI subcommand instead.`);
		}
	}
	return factories;
}

/**
 * Print the active model label (text mode only).
 *
 * Deliberately NOT shared.ts's `modelLabel`: that falls back to the RESOLVED
 * `llm.provider/modelId` pair, while this header reports the pair off the
 * session's own model object — which substring-match resolution
 * (resolveModel's fallback lane) can differ from (`--model sonnet` →
 * session.model.id "claude-sonnet-5"). thinkingLevel likewise reads the
 * session ("?" when unset), not the parsed llm. Reusing modelLabel here would
 * change stderr bytes on every shorthand --model invocation.
 */
function printModel(session: {
	model?: { provider: string; id: string; name?: string };
	thinkingLevel?: string;
}) {
	const m = session.model;
	if (!m) {
		console.error("(no model selected)");
		return;
	}
	const label = m.name ? `${m.name}` : `${m.provider}/${m.id}`;
	console.error(
		`model: ${label}  [${m.provider}/${m.id}]  thinking: ${session.thinkingLevel ?? "?"}`,
	);
}

/**
 * Run one agent turn in passthrough mode.
 *
 * @param parsed  parsed pi-style args
 * @param prompt  explicit prompt (overrides positionals); used by agent commands
 */
export async function runPassthrough(
	parsed: ParsedArgs,
	prompt?: string,
): Promise<void> {
	applyVaultEnv(parsed);

	const task = prompt ?? parsed.positionals.join(" ").trim();
	if (!task) {
		console.error("No prompt given. Pass a task string, or use a sub-command.");
		console.error("See: s2-agent cli --help");
		process.exit(1);
	}

	const llm = await resolveLLMFromArgs(parsed);

	// If -e was provided, dynamically import extensions (source-mode only).
	const extraFactories =
		parsed.extensionPaths.length > 0
			? await loadExtensions(parsed.extensionPaths, process.cwd())
			: [];

	// --no-session is accepted for pi-compat but is a no-op: every passthrough
	// turn is already ephemeral (in-memory SessionManager). No branching needed.
	await runSessionTurn(parsed, {
		llm,
		task,
		labelName: "passthrough",
		tools: parsed.tools,
		excludeTools: applyDryRun(parsed),
		appendSystemPrompt: parsed.appendSystemPrompt,
		extraExtensionFactories: extraFactories.length > 0 ? extraFactories : undefined,
		header:
			parsed.mode === "json"
				? undefined
				: (session) => {
						printModel(session as Parameters<typeof printModel>[0]);
						console.error(`prompt: ${task}\n`);
					},
	});
}
