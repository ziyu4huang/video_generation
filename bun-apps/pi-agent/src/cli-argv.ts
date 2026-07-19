/**
 * cli-argv — pure argv-classification helpers for cli.ts's pre-patch
 * intercepts (doctor / ext doctor). Extracted so the decision logic is
 * testable without executing cli.ts's side effects (applyPatches, main()).
 */

/**
 * True iff argv should route into `doctor` mode. Only the documented `doctor`
 * subcommand (argv[0]) triggers it — matching a `--doctor` flag ANYWHERE in
 * argv would also match a literal prompt string passed to `-p`/`--print`
 * (e.g. `-p "--doctor"`), silently hijacking it instead of running the prompt.
 */
export function isDoctorCommand(argv: string[]): boolean {
	return argv[0] === "doctor";
}

/** True iff argv should route into `ext doctor` mode. */
export function isExtDoctorCommand(argv: string[]): boolean {
	return argv[0] === "ext" && argv[1] === "doctor";
}

/**
 * User-passed suppression flags, read from the PRE-PATCH argv (the slice
 * cli.ts captures before applyPatches() splices run-dir `-e`/`--skill` paths
 * in). This is what distinguishes a USER's `-ne` from the `-ne` that deploy
 * layouts self-inject inside resolveRunDirArgv() — at classification time the
 * injected tokens don't exist yet.
 *
 * Upstream pi treats these tokens as flags wherever they appear in argv
 * (dist/cli/args.js), so a plain includes() mirrors pi exactly.
 */
export interface UserSuppressFlags {
	noExtensions: boolean;
	noSkills: boolean;
}

export function userSuppressFlags(argv: string[]): UserSuppressFlags {
	return {
		noExtensions: argv.includes("-ne") || argv.includes("--no-extensions"),
		noSkills: argv.includes("-ns") || argv.includes("--no-skills"),
	};
}
