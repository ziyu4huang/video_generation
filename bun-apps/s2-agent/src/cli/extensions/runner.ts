/**
 * Generic runner for extension-backed sub-commands.
 *
 * Turns an `ExtensionSubcommandSpec` into a `Command.run`: build the task from
 * parsed args, pick the tool allowlist (user `--tools` overrides the spec's
 * curated default), then hand off to the shared `runAgentSession` tail — which
 * creates a session with pi-obsidian baked in PLUS the extension's own factory
 * (via the previously-unused `extraExtensionFactories` seam) and drives one turn.
 *
 * `validateToolNames()` (called inside createSharedSession) fails fast if the
 * spec names a tool the loaded factories do not register — so a misconfigured
 * spec is reported immediately instead of silently starting with zero tools.
 */
import type { ParsedArgs } from "../args.ts";
import { runAgentSession } from "../sessions/run-agent-session.ts";
import type { ExtensionSubcommandSpec } from "./types.ts";

/** Return a `Command.run` for the given extension sub-command spec. */
export function runExtensionSubcommand(spec: ExtensionSubcommandSpec) {
	return async (parsed: ParsedArgs): Promise<void> => {
		await runAgentSession(parsed, {
			tools: parsed.tools ?? spec.tools,
			task: spec.task(parsed),
			labelName: spec.name,
			factory: spec.factory,
		});
	};
}
