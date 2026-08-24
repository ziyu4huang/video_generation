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
 * `runSessionTurn` is steps 2/4/5 as one unit (the part runPassthrough shares);
 * `runAgentSession` is the full sequence with the standard header. Commands
 * keep their own pre-run setup (input/vault resolution, task building) and
 * hand off here for the run.
 */
import type { ParsedArgs } from "../args.ts";
import {
	applyDryRun,
	createSharedSession,
	modelLabel,
	resolveLLMFromArgs,
	type ResolvedLLM,
} from "./shared.ts";
import { runJsonTask, runPrettyTask } from "./task-runner.ts";

export interface RunAgentSessionOptions {
	/** Resolved tool allowlist (caller applies the `parsed.tools ?? <default>` rule). */
	tools?: string[];
	/**
	 * Default tool allowlist — used when the caller did NOT pre-apply the
	 * `parsed.tools ?? <default>` rule (e.g. zk-card's per-subcommand tool sets).
	 * Mutually exclusive with an explicit `tools`.
	 */
	defaultTools?: string[];
	/** The agent task string. */
	task: string;
	/** Label shown in pretty mode and the model log line. */
	labelName: string;
	/**
	 * Prefixed log style: renders `[<labelPrefix>]  model: …  thinking: …`
	 * instead of the plain two-space-aligned line. Used by commands whose
	 * output is visually grouped under a subcommand tag (zk-card).
	 */
	labelPrefix?: string;
	/** Optional inline extension factory to register (extension sub-commands only). */
	factory?: unknown;
	/** Multiple inline extension factories (e.g. the `agent` command injects several). */
	factories?: unknown[];
}

export interface RunSessionTurnOptions {
	/** Pre-resolved LLM target (each caller resolves before its own preamble). */
	llm: ResolvedLLM;
	/** The agent task string. */
	task: string;
	/** Label runPrettyTask prints under (pretty mode only). */
	labelName: string;
	/** Session tool allowlist (createSharedSession applies the PI_TOOLS rule). */
	tools?: string[];
	/** Effective excludeTools — callers pass applyDryRun(parsed). */
	excludeTools?: string[];
	appendSystemPrompt?: string[];
	extraExtensionFactories?: unknown[];
	/**
	 * Site-specific stderr header, run after session creation and before the
	 * turn. The two callers' bytes differ (runAgentSession always logs the
	 * model line; runPassthrough logs model + prompt in pretty mode only), so
	 * the line itself stays with the caller.
	 */
	header?: (session: unknown) => void;
}

/**
 * The shared run tail: create the shared session, drive exactly one agent turn
 * (NDJSON or pretty per parsed.mode), dispose in a finally so a thrown turn
 * error still releases the session. Extracted from runAgentSession +
 * runPassthrough, whose preambles (task building, -e loading, model-line
 * formats) legitimately differ.
 */
export async function runSessionTurn(
	parsed: ParsedArgs,
	opts: RunSessionTurnOptions,
): Promise<void> {
	const { session } = await createSharedSession(opts.llm, {
		tools: opts.tools,
		excludeTools: opts.excludeTools,
		appendSystemPrompt: opts.appendSystemPrompt,
		extraExtensionFactories: opts.extraExtensionFactories,
	});

	opts.header?.(session);

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

export async function runAgentSession(
	parsed: ParsedArgs,
	opts: RunAgentSessionOptions,
): Promise<void> {
	const llm = await resolveLLMFromArgs(parsed);
	const tools = opts.tools ?? parsed.tools ?? opts.defaultTools;
	// Merge single `factory` + plural `factories` so both the extension
	// sub-command path (single) and the `agent` command (several) work.
	const allFactories = [
		...(opts.factories ?? []),
		...(opts.factory ? [opts.factory] : []),
	];

	await runSessionTurn(parsed, {
		llm,
		task: opts.task,
		labelName: opts.labelName,
		tools,
		excludeTools: applyDryRun(parsed),
		appendSystemPrompt: parsed.appendSystemPrompt,
		extraExtensionFactories: allFactories.length > 0 ? allFactories : undefined,
		header: (session) => {
			const label = modelLabel(session as any, llm);
			if (opts.labelPrefix) {
				console.error(
					`[${opts.labelPrefix}]  model: ${label}  thinking: ${llm.thinkingLevel}`,
				);
			} else {
				console.error(
					`model:  ${label}  [${llm.provider}/${llm.modelId}]  thinking: ${llm.thinkingLevel}`,
				);
			}
			if (parsed.dryRun) {
				console.error("[dry-run] vault writes suppressed — write tools excluded (agent can read + plan only)");
			}
			console.error();
		},
	});
}
