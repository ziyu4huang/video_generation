/**
 * Shared session-run tail used by every agent sub-command.
 *
 * The same 5-step sequence was triplicated across `commands/zk-extract.ts`,
 * `commands/zk-ask.ts`, and `extensions/runner.ts`:
 *
 *   1. resolve the LLM from args (provider/model/thinking + env + fallbacks)
 *   2. create a shared session (pi-obsidian baked in, + an optional extension
 *      factory for extension-backed sub-commands)
 *   3. log the resolved model (stderr, for human orientation)
 *   4. drive one agent turn — pretty or NDJSON depending on --mode
 *   5. dispose the session
 *
 * `runAgentSession` is that sequence. Commands keep their own pre-run setup
 * (input/vault resolution, task building) and hand off here for the run.
 */
import type { ParsedArgs } from "../args.ts";
import { resolveLLMFromArgs } from "./passthrough.ts";
import { createSharedSession, dryRunExclude, modelLabel } from "./shared.ts";
import { runJsonTask, runPrettyTask } from "./task-runner.ts";

export interface RunAgentSessionOptions {
	/** Resolved tool allowlist (caller applies the `parsed.tools ?? <default>` rule). */
	tools: string[];
	/** The agent task string. */
	task: string;
	/** Label shown in pretty mode and the model log line. */
	labelName: string;
	/** Optional inline extension factory to register (extension sub-commands only). */
	factory?: unknown;
	/** Multiple inline extension factories (e.g. the `agent` command injects several). */
	factories?: unknown[];
}

export async function runAgentSession(
	parsed: ParsedArgs,
	opts: RunAgentSessionOptions,
): Promise<void> {
	const llm = await resolveLLMFromArgs(parsed);
	// Merge single `factory` + plural `factories` so both the extension
	// sub-command path (single) and the `agent` command (several) work.
	const allFactories = [
		...(opts.factories ?? []),
		...(opts.factory ? [opts.factory] : []),
	];
	const { session } = await createSharedSession(llm, {
		tools: opts.tools,
		excludeTools: dryRunExclude(parsed),
		appendSystemPrompt: parsed.appendSystemPrompt,
		extraExtensionFactories: allFactories.length > 0 ? allFactories : undefined,
	});

	const label = modelLabel(session, llm);
	console.error(
		`model:  ${label}  [${llm.provider}/${llm.modelId}]  thinking: ${llm.thinkingLevel}`,
	);
	if (parsed.dryRun) {
		console.error("[dry-run] vault writes suppressed — write tools excluded (agent can read + plan only)");
	}
	console.error();

	try {
		if (parsed.mode === "json") {
			await runJsonTask(session, opts.task, parsed.verbose);
		} else {
			await runPrettyTask(session, opts.task, opts.labelName, parsed.verbose);
		}
	} finally {
		session.dispose();
	}
}
