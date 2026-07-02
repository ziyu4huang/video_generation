/**
 * Generic runner for extension-backed sub-commands.
 *
 * This is the `run()` body that `commands/zk-extract.ts` and `commands/zk-ask.ts`
 * each implement by hand, factored out so any `ExtensionSubcommandSpec` can
 * reuse it. The flow:
 *
 *   1. resolve the LLM from args (provider/model/thinking + env + fallbacks)
 *   2. let the spec build the agent task string from parsed args
 *   3. create a shared session with pi-obsidian baked in PLUS the extension's
 *      own factory (via the previously-unused `extraExtensionFactories` seam),
 *      curating the spec's tool allowlist (user `--tools` overrides)
 *   4. drive one agent turn (pretty or NDJSON)
 *
 * `validateToolNames()` (called inside createSharedSession) fails fast if the
 * spec names a tool the loaded factories do not register — so a misconfigured
 * spec is reported immediately instead of silently starting with zero tools.
 */
import type { ParsedArgs } from "../args.ts";
import { resolveLLMFromArgs } from "../sessions/passthrough.ts";
import { createSharedSession, modelLabel } from "../sessions/shared.ts";
import { runJsonTask, runPrettyTask } from "../sessions/task-runner.ts";
import type { ExtensionSubcommandSpec } from "./types.ts";

/** Return a `Command.run` for the given extension sub-command spec. */
export function runExtensionSubcommand(spec: ExtensionSubcommandSpec) {
	return async (parsed: ParsedArgs): Promise<void> => {
		const llm = await resolveLLMFromArgs(parsed);
		const task = spec.task(parsed);
		const tools = parsed.tools ?? spec.tools;

		const { session } = await createSharedSession(llm, {
			tools,
			excludeTools: parsed.excludeTools,
			appendSystemPrompt: parsed.appendSystemPrompt,
			extraExtensionFactories: [spec.factory],
		});

		const label = modelLabel(session, llm);
		console.error(
			`model:  ${label}  [${llm.provider}/${llm.modelId}]  thinking: ${llm.thinkingLevel}`,
		);
		console.error();

		try {
			if (parsed.mode === "json") {
				await runJsonTask(session, task, parsed.verbose);
			} else {
				await runPrettyTask(session, task, spec.name, parsed.verbose);
			}
		} finally {
			session.dispose();
		}
	};
}
