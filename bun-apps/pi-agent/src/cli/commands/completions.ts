/**
 * `completions <shell>` — generate shell completion scripts.
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
	const allNames = [...commands, "pipeline", "workflow", "list", "list-tools", "version", "help"];
	const lines = [
		"# bun-pi-agent-cli bash completion",
		"_bun_pi_agent_cli() {",
		"  local cur prev words cword",
		"  _init_completion || return",
		`  local cmds="${allNames.join(" ")}"`,
		`  local pipes="${pipelines.join(" ")} status run dry-run lint"`,
		"  if [[ $cword -eq 1 ]]; then",
		'    COMPREPLY=($(compgen -W "$cmds" -- "$cur"))',
		"    return",
		"  fi",
		'  if [[ $prev == "pipeline" ]]; then',
		'    COMPREPLY=($(compgen -W "$pipes" -- "$cur"))',
		"    return",
		"  fi",
		'  if [[ $prev == "workflow" ]]; then',
		'    COMPREPLY=($(compgen -W "run list" -- "$cur"))',
		"    return",
		"  fi",
		`  COMPREPLY=($(compgen -W "${GLOBAL_FLAGS.join(" ")}" -- "$cur"))`,
		"}",
		"complete -F _bun_pi_agent_cli bun-pi-agent-cli",
	];
	return lines.join("\n") + "\n";
}

function genZsh(commands: string[], pipelines: string[]): string {
	const lines = [
		"# bun-pi-agent-cli zsh completion",
		"# Run: eval \"$(bun-pi-agent-cli completions zsh)\"",
		"",
		"_bun-pi-agent-cli() {",
		"  local state line curcontext=\"$curcontext\"",
		"  _arguments -C \\",
		"    '1: :->command' \\",
		"    '*::arg:->args'",
		"  case $state in",
		"    command)",
		"      _values 'command' \\",
		...commands.map((c) => `        '${c}' \\`),
		"        'pipeline' 'workflow' 'list' 'list-tools' 'version' 'help'",
		"      ;;",
		"    args)",
		"      case ${words[1]} in",
		"        pipeline)",
		`          _values 'pipeline' ${pipelines.map((p) => `'${p}'`).join(" ")} status run dry-run lint`,
		"          ;;",
		"        workflow)",
		"          _values 'sub-command' run list",
		"          ;;",
		"      esac",
		"      ;;",
		"  esac",
		"}",
		"",
		"compdef _bun-pi-agent-cli bun-pi-agent-cli",
	];
	return lines.join("\n") + "\n";
}

function genFish(commands: string[], pipelines: string[]): string {
	const allCmds = [...commands, "pipeline", "workflow", "list", "list-tools", "version", "help"];
	const lines = [
		"# bun-pi-agent-cli fish completion",
		"# Run: bun-pi-agent-cli completions fish > ~/.config/fish/completions/bun-pi-agent-cli.fish",
		"",
	];
	for (const c of allCmds) {
		lines.push(`complete -c bun-pi-agent-cli -n "__fish_use_subcommand" -a '${c}'`);
	}
	for (const p of pipelines) {
		lines.push(`complete -c bun-pi-agent-cli -n "__fish_seen_subcommand_from pipeline" -a '${p}'`);
	}
	lines.push(`complete -c bun-pi-agent-cli -n "__fish_seen_subcommand_from pipeline" -a 'status'`);
	lines.push(`complete -c bun-pi-agent-cli -n "__fish_seen_subcommand_from pipeline" -a 'run'`);
	lines.push(`complete -c bun-pi-agent-cli -n "__fish_seen_subcommand_from pipeline" -a 'dry-run'`);
	lines.push(`complete -c bun-pi-agent-cli -n "__fish_seen_subcommand_from pipeline" -a 'lint'`);
	lines.push(`complete -c bun-pi-agent-cli -n "__fish_seen_subcommand_from workflow" -a 'run'`);
	lines.push(`complete -c bun-pi-agent-cli -n "__fish_seen_subcommand_from workflow" -a 'list'`);
	for (const f of GLOBAL_FLAGS) {
		lines.push(`complete -c bun-pi-agent-cli -l '${f.replace(/^--?/, "")}' -d 'global flag'`);
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
  bun-pi-agent-cli completions <shell>

Generates a shell completion script for the CLI's sub-commands, pipelines, and
global flags. Print to stdout — eval it or save to your shell's completion dir.

Shells: bash, zsh, fish

Setup examples:
  # bash (add to ~/.bashrc)
  eval "$(bun-pi-agent-cli completions bash)"

  # zsh (save to a completion dir in $fpath)
  bun-pi-agent-cli completions zsh > ~/.zsh/completions/_bun-pi-agent-cli

  # fish
  bun-pi-agent-cli completions fish > ~/.config/fish/completions/bun-pi-agent-cli.fish`,
};
