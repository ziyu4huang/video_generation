/**
 * `completions <shell>` — generate shell completion scripts.
 *
 * The completed binary is `pi-agent` (there is no standalone CLI binary any
 * more), so every generated script registers against `pi-agent` and treats the
 * CLI's own commands as a SECOND-level token behind the `cli` namespace:
 *
 *   pi-agent cli zk-ask "…"
 *   pi-agent cli pipeline pdf-to-vault paper.pdf
 *
 * Unlike other commands, this is handled INLINE in dispatch.ts (like `list` /
 * `list-tools`) rather than via a `run()` function. The reason: it needs the
 * COMMANDS / PIPELINES arrays from dispatch.ts, and a dynamic `import("../dispatch.ts")`
 * inside a `run()` creates a circular-dependency hang. Handling it inline lets
 * dispatch.ts pass its own arrays directly.
 *
 * This module exports only the generator functions + metadata; dispatch.ts calls
 * `printCompletions(shell, commands, pipelines)`.
 */

/** The completed binary. */
const BIN = "pi-agent";

/**
 * Root subcommand tokens `pi-agent` intercepts before pi's own argv parsing.
 * Kept in sync with src/cli-argv.ts: isCliCommand (`cli`), isDoctorCommand
 * (`doctor`) and isExtDoctorCommand (`ext doctor`). Anything else falls through
 * to upstream pi / the interactive TUI and is deliberately NOT completed here.
 */
const ROOT_COMMANDS = ["cli", "doctor", "ext"];

/** Sub-tokens of the `ext` root command that pi-agent itself handles. */
const EXT_SUBCOMMANDS = ["doctor"];

/** Meta commands the CLI dispatches inline (not present in the COMMANDS array). */
const META_COMMANDS = ["pipeline", "workflow", "list", "list-tools", "version", "help"];

/** Knowledge-pipeline sub-commands, offered alongside the named pipelines. */
const PIPELINE_SUBCOMMANDS = ["status", "run", "dry-run", "lint"];

/** `workflow` sub-commands. */
const WORKFLOW_SUBCOMMANDS = ["run", "list"];

const GLOBAL_FLAGS = [
	"--model", "--provider", "--thinking", "--api-key", "--mode",
	"-p", "--print", "--no-session", "--tools", "-t", "--exclude-tools", "-xt",
	"-V", "--verbose", "--debug", "--vault", "--vault-dir", "--folder",
	"--out", "-e", "--extension", "-a", "--approve", "--help", "-h",
];

type Shell = "bash" | "zsh" | "fish";

function isShell(s: string): s is Shell {
	return s === "bash" || s === "zsh" || s === "fish";
}

function genBash(commands: string[], pipelines: string[]): string {
	const allNames = [...commands, ...META_COMMANDS];
	const lines = [
		`# ${BIN} bash completion`,
		`# Run: eval "$(${BIN} cli completions bash)"`,
		"_pi_agent() {",
		"  local cur prev words cword",
		"  _init_completion || return",
		`  local roots="${ROOT_COMMANDS.join(" ")}"`,
		`  local cmds="${allNames.join(" ")}"`,
		`  local pipes="${[...pipelines, ...PIPELINE_SUBCOMMANDS].join(" ")}"`,
		"  if [[ $cword -eq 1 ]]; then",
		'    COMPREPLY=($(compgen -W "$roots" -- "$cur"))',
		"    return",
		"  fi",
		'  if [[ ${words[1]} == "ext" ]]; then',
		"    if [[ $cword -eq 2 ]]; then",
		`      COMPREPLY=($(compgen -W "${EXT_SUBCOMMANDS.join(" ")}" -- "$cur"))`,
		"    fi",
		"    return",
		"  fi",
		// Everything below is the `cli` namespace; other roots take no arguments
		// we can complete.
		'  if [[ ${words[1]} != "cli" ]]; then',
		"    return",
		"  fi",
		"  if [[ $cword -eq 2 ]]; then",
		'    COMPREPLY=($(compgen -W "$cmds" -- "$cur"))',
		"    return",
		"  fi",
		'  if [[ $prev == "pipeline" ]]; then',
		'    COMPREPLY=($(compgen -W "$pipes" -- "$cur"))',
		"    return",
		"  fi",
		'  if [[ $prev == "workflow" ]]; then',
		`    COMPREPLY=($(compgen -W "${WORKFLOW_SUBCOMMANDS.join(" ")}" -- "$cur"))`,
		"    return",
		"  fi",
		`  COMPREPLY=($(compgen -W "${GLOBAL_FLAGS.join(" ")}" -- "$cur"))`,
		"}",
		`complete -F _pi_agent ${BIN}`,
	];
	return lines.join("\n") + "\n";
}

function genZsh(commands: string[], pipelines: string[]): string {
	const allNames = [...commands, ...META_COMMANDS];
	const lines = [
		`# ${BIN} zsh completion`,
		`# Run: eval "$(${BIN} cli completions zsh)"`,
		"",
		"_pi-agent() {",
		"  local state line curcontext=\"$curcontext\"",
		"  _arguments -C \\",
		"    '1: :->root' \\",
		"    '*::arg:->args'",
		"  case $state in",
		"    root)",
		`      _values 'root command' ${ROOT_COMMANDS.map((r) => `'${r}'`).join(" ")}`,
		"      ;;",
		"    args)",
		// `*::arg:->args` re-slices $words, so words[1] is the root token.
		"      case ${words[1]} in",
		"        cli)",
		"          if (( CURRENT == 2 )); then",
		"            _values 'command' \\",
		...allNames.slice(0, -1).map((c) => `              '${c}' \\`),
		`              '${allNames[allNames.length - 1]}'`,
		"          else",
		"            case ${words[2]} in",
		"              pipeline)",
		`                _values 'pipeline' ${[...pipelines, ...PIPELINE_SUBCOMMANDS].map((p) => `'${p}'`).join(" ")}`,
		"                ;;",
		"              workflow)",
		`                _values 'sub-command' ${WORKFLOW_SUBCOMMANDS.map((w) => `'${w}'`).join(" ")}`,
		"                ;;",
		"            esac",
		"          fi",
		"          ;;",
		"        ext)",
		`          _values 'sub-command' ${EXT_SUBCOMMANDS.map((e) => `'${e}'`).join(" ")}`,
		"          ;;",
		"      esac",
		"      ;;",
		"  esac",
		"}",
		"",
		`compdef _pi-agent ${BIN}`,
	];
	return lines.join("\n") + "\n";
}

function genFish(commands: string[], pipelines: string[]): string {
	const allCmds = [...commands, ...META_COMMANDS];
	const lines = [
		`# ${BIN} fish completion`,
		`# Run: ${BIN} cli completions fish > ~/.config/fish/completions/${BIN}.fish`,
		"",
	];
	for (const r of ROOT_COMMANDS) {
		lines.push(`complete -c ${BIN} -n "__fish_use_subcommand" -a '${r}'`);
	}
	for (const e of EXT_SUBCOMMANDS) {
		lines.push(`complete -c ${BIN} -n "__fish_seen_subcommand_from ext" -a '${e}'`);
	}
	for (const c of allCmds) {
		lines.push(`complete -c ${BIN} -n "__fish_seen_subcommand_from cli" -a '${c}'`);
	}
	for (const p of [...pipelines, ...PIPELINE_SUBCOMMANDS]) {
		lines.push(
			`complete -c ${BIN} -n "__fish_seen_subcommand_from cli; and __fish_seen_subcommand_from pipeline" -a '${p}'`,
		);
	}
	for (const w of WORKFLOW_SUBCOMMANDS) {
		lines.push(
			`complete -c ${BIN} -n "__fish_seen_subcommand_from cli; and __fish_seen_subcommand_from workflow" -a '${w}'`,
		);
	}
	for (const f of GLOBAL_FLAGS) {
		// `-s` for single-dash short flags, `-l` for `--long` ones; emitting a
		// short flag as `-l p` would advertise a `--p` that does not exist.
		const spec = f.startsWith("--") ? `-l '${f.slice(2)}'` : `-s '${f.slice(1)}'`;
		lines.push(
			`complete -c ${BIN} -n "__fish_seen_subcommand_from cli" ${spec} -d 'global flag'`,
		);
	}
	return lines.join("\n") + "\n";
}

/**
 * Print a completion script for the given shell. Called inline from dispatch.ts
 * (avoids the circular-import hang a `run()` + dynamic import would cause).
 */
export function printCompletions(
	shell: string,
	commands: string[],
	pipelines: string[],
): void {
	if (!isShell(shell)) {
		throw new Error(`Unsupported shell "${shell}". Choose: bash, zsh, fish`);
	}
	switch (shell) {
		case "bash":
			process.stdout.write(genBash(commands, pipelines));
			break;
		case "zsh":
			process.stdout.write(genZsh(commands, pipelines));
			break;
		case "fish":
			process.stdout.write(genFish(commands, pipelines));
			break;
	}
}

export const completionsMeta = {
	summary: "generate shell completion script (bash | zsh | fish)",
	details: `Usage:
  pi-agent cli completions <shell>

Generates a shell completion script for the \`pi-agent\` binary: its root
subcommands (${ROOT_COMMANDS.join(" / ")}), the CLI commands and pipelines under
\`pi-agent cli …\`, and the global flags. Printed to stdout — eval it or save it
to your shell's completion dir.

Shells: bash, zsh, fish

Setup examples:
  # bash (add to ~/.bashrc)
  eval "$(pi-agent cli completions bash)"

  # zsh (save to a completion dir in $fpath — the file MUST be named _pi-agent)
  pi-agent cli completions zsh > ~/.zsh/completions/_pi-agent

  # fish
  pi-agent cli completions fish > ~/.config/fish/completions/pi-agent.fish`,
};
