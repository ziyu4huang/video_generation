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
