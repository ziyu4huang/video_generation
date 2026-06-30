/**
 * Pi-compatible passthrough runner.
 *
 * This is the mode entered when argv does not match a friendly sub-command.
 * It mirrors `pi -p` / `pi --mode json` behavior closely enough that the
 * pi-obsidian `obsidian_distill` / `obsidian_garden` subagent tools — which
 * re-invoke `process.argv[1]` with flags like
 *   --mode json -p --no-session --approve -e <pkg> --tools <csv>
 *   --append-system-prompt <tmpfile> <task>
 * — work transparently. The `-e` / `--approve` flags are accepted and ignored
 * because pi-obsidian is already baked into every session (self-contained).
 *
 * Output modes:
 *   text  — stream assistant text deltas to stdout (human readable)
 *   json  — emit one NDJSON event per line (pi schema subset), consumed by the
 *           obsidian subagent parser which reads `message_end` assistant text.
 */
import { resolveLLM, createSharedSession, type ResolvedLLM } from "./shared.ts";
import { runJsonTask, runPrettyTask } from "./task-runner.ts";
import type { ParsedArgs } from "../args.ts";

/** Apply vault-related flags to the process environment (obsidian reads these). */
export function applyVaultEnv(parsed: ParsedArgs): void {
	if (parsed.vault) process.env.OB_VAULT_PATH = parsed.vault;
	if (parsed.vaultDir) process.env.OB_VAULT_DIR = parsed.vaultDir;
}

/** Build the LLM target from parsed flags + user settings defaults. */
export async function resolveLLMFromArgs(
	parsed: ParsedArgs,
): Promise<ResolvedLLM> {
	// Read user default provider/model from settings (best-effort, non-fatal).
	let userDefaults: { provider?: string; model?: string } | undefined;
	try {
		const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
		const { readFileSync, existsSync } = await import("node:fs");
		const { join } = await import("node:path");
		const settingsPath = join(getAgentDir(), "settings.json");
		if (existsSync(settingsPath)) {
			const s = JSON.parse(readFileSync(settingsPath, "utf8"));
			userDefaults = {
				provider: s.defaultProvider,
				model: s.defaultModel,
			};
		}
	} catch {
		/* ignore */
	}

	return resolveLLM({
		provider: parsed.provider,
		model: parsed.model,
		thinking: parsed.thinking,
		userDefaults,
	});
}

/** Print the active model label (text mode only). */
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
		console.error("See: bun-pi-agent-cli --help");
		process.exit(1);
	}

	const llm = await resolveLLMFromArgs(parsed);
	const { session } = await createSharedSession(llm, {
		tools: parsed.tools,
		excludeTools: parsed.excludeTools,
		appendSystemPrompt: parsed.appendSystemPrompt,
		// --no-session is accepted for pi-compat but is a no-op: every passthrough
		// turn is already ephemeral (in-memory SessionManager). No branching needed.
	});

	if (parsed.mode === "json") {
		await runJsonTask(session, task, parsed.verbose);
	} else {
		printModel(session);
		console.error(`prompt: ${task}\n`);
		await runPrettyTask(session, task, "passthrough", parsed.verbose);
	}
	session.dispose();
}
