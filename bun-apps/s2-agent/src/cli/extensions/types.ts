/**
 * The "extension → sub-command" contract.
 *
 * A workspace extension that wants to be invocable as a top-level CLI
 * sub-command (alongside `zk-extract`, `file2md`, …) exports a spec
 * shaped like `ExtensionSubcommandSpec`. `registry.ts` collects these specs,
 * and `runner.ts` turns each into a `Command` whose `run()` is the standard
 * "resolve LLM → build task → createSharedSession(tools + factory) → run one
 * turn" pipeline — the same pipeline `commands/zk-extract.ts` runs by hand.
 *
 * Why: before this, every sub-command was a bespoke `commands/<x>.ts` that
 * re-implemented that pipeline and imported `*_TOOLS` + a task builder from
 * the extension package. Adding a new extension sub-command meant editing
 * three places. Now an extension only exports one spec; adding it to the CLI
 * is a single import line in `registry.ts`.
 *
 * The extension's own `ExtensionFactory` is injected through the already-plumbed
 * `extraExtensionFactories` seam (sessions/shared.ts), which was wired but
 * unused before this change.
 */

/**
 * Input a generic extension task builder needs. Intentionally narrower than
 * `ParsedArgs`: an extension sub-command turns the user's positional request
 * into a prompt string, and CLI-level concerns (model, tools, mode) are
 * handled by the runner, not the task builder. Keeping this minimal lets an
 * extension package type its spec without importing `ParsedArgs` (which would
 * create a reverse workspace dependency on s2-agent).
 */
export interface SubcommandTaskInput {
	positionals: string[];
}

export type TaskBuilder = (input: SubcommandTaskInput) => string;

export interface ExtensionSubcommandSpec {
	/** Sub-command token (no spaces, must not start with `-`). */
	name: string;
	/** One-line summary shown in root `help`. */
	summary: string;
	/** Full usage text shown by `help <name>`. */
	details: string;
	/**
	 * The extension's `ExtensionFactory` (its default export). Injected into the
	 * session via `extraExtensionFactories` so the extension's tools register.
	 * Typed `unknown` here to avoid importing the SDK type from this leaf file.
	 */
	factory: unknown;
	/**
	 * Curated tool allowlist active for this command. The user can override with
	 * `--tools`. `validateToolNames()` fails fast on a typo'd name, so a spec
	 * that names a tool the factory does not register is caught at run time.
	 */
	tools: string[];
	/** Build the agent task string from parsed args (positionals, flags). */
	task: TaskBuilder;
}
