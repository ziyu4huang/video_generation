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
 */
import { resolveLLM, createSharedSession, applyDryRun, type ResolvedLLM } from "./shared.ts";
import { runJsonTask, runPrettyTask } from "./task-runner.ts";
import type { ParsedArgs } from "../args.ts";
import { resolve } from "node:path";

/**
 * Dynamically import extension factories from file paths. Only works in source
 * mode (Bun natively imports .ts). In compiled binary mode these imports fail
 * gracefully — the user sees a warning and should use the extension's registered
 * CLI subcommand instead (e.g. `pi-agent cli power-tool`).
 *
 * Paths are resolved against cwd (not the CLI's own location), matching how the
 * original pi-agent's `-e` flag works.
 */
async function loadExtensions(paths: string[], cwd: string): Promise<unknown[]> {
	const factories: unknown[] = [];
	for (const p of paths) {
		try {
			// Resolve relative paths against cwd to match pi-agent's -e behavior.
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

/** Apply vault-related flags to the process environment (obsidian reads these). */
export function applyVaultEnv(parsed: ParsedArgs): void {
	if (parsed.vault) process.env.OB_VAULT_PATH = parsed.vault;
	if (parsed.vaultDir) process.env.OB_VAULT_DIR = parsed.vaultDir;
}

/**
 * Read user default provider/model from ~/.pi/agent/settings.json (best-effort,
 * non-fatal). Extracted from `resolveLLMFromArgs` so the workflow command can
 * reuse the SAME settings-read when computing the pi-default model spec — no
 * second reader. Honors PI_CODING_AGENT_DIR (via getAgentDir) just like the
 * inline read did; returns undefined on any read/parse error or missing file.
 *
 * Preserves the original dynamic-`await import(...)` style so module-loading
 * behavior (binary vs source mode) is unchanged.
 */
export async function readUserDefaults(): Promise<{ provider?: string; model?: string } | undefined> {
	try {
		const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
		const { readFileSync, existsSync } = await import("node:fs");
		const { join } = await import("node:path");
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		const s = JSON.parse(readFileSync(settingsPath, "utf8"));
		return { provider: s.defaultProvider, model: s.defaultModel };
	} catch {
		return undefined;
	}
}

/** Build the LLM target from parsed flags + user settings defaults. */
export async function resolveLLMFromArgs(
	parsed: ParsedArgs,
): Promise<ResolvedLLM> {
	return resolveLLM({
		provider: parsed.provider,
		model: parsed.model,
		thinking: parsed.thinking,
		userDefaults: await readUserDefaults(),
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
		console.error("See: pi-agent cli --help");
		process.exit(1);
	}

	const llm = await resolveLLMFromArgs(parsed);

	// If -e was provided, dynamically import extensions (source-mode only).
	const extraFactories =
		parsed.extensionPaths.length > 0
			? await loadExtensions(parsed.extensionPaths, process.cwd())
			: [];

	const { session } = await createSharedSession(llm, {
		tools: parsed.tools,
		excludeTools: applyDryRun(parsed),
		appendSystemPrompt: parsed.appendSystemPrompt,
		extraExtensionFactories: extraFactories.length > 0 ? extraFactories : undefined,
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
