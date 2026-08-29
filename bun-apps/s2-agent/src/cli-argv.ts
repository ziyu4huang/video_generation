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
 * True iff argv should route into the `--ext-list` / `ext list` diagnostic —
 * dev-mode parity with the sh launcher's `--ext-list` flag (same JSON payload,
 * sourced from the registry instead of ext/ manifests; see src/ext-list.ts).
 * Only the two leading forms trigger it — same rationale as isDoctorCommand:
 * matching `--ext-list` ANYWHERE in argv would also match a literal prompt
 * string passed to `-p`/`--print` (e.g. `-p "--ext-list"`), silently
 * hijacking it instead of running the prompt.
 */
export function isExtListCommand(argv: string[]): boolean {
	return argv[0] === "--ext-list" || (argv[0] === "ext" && argv[1] === "list");
}

/**
 * True iff argv should route into `ext new <name>` (the scaffold command).
 * Only the two-token `ext new` prefix triggers it — same rationale as
 * isExtDoctorCommand: matching the tokens ANYWHERE would also match a literal
 * prompt string passed to `-p`/`--print`, silently hijacking it.
 */
export function isExtNewCommand(argv: string[]): boolean {
	return argv[0] === "ext" && argv[1] === "new";
}

/**
 * True iff argv should route into the non-interactive CLI namespace
 * (`s2-agent cli <command> …`). Only `argv[0]` triggers it — same contract as
 * isDoctorCommand: matching a `cli` token ANYWHERE would also match a literal
 * prompt (`-p "cli"`) or a flag value, silently hijacking it.
 */
export function isCliCommand(argv: string[]): boolean {
	return argv[0] === "cli";
}

/**
 * True iff argv should route into the non-interactive CLI namespace WITHOUT the
 * leading `cli` token. The develop-pipeline v2 workflow templates spawn
 * `bun bun-apps/s2-agent/src/cli.ts pipeline-gate --tier T1` bare (plan §Task 3,
 * spec §4), and without this branch that argv falls through to pi's own
 * parser, which answers `Error: Unknown option: --tier` — a flag-typo message
 * for what is really a missing routing surface. Only argv[0] triggers it —
 * same contract as isCliCommand/isDoctorCommand, so a literal "pipeline-gate"
 * prompt or flag value is never hijacked. Extend the accepted set here if
 * another command grows a bare-form caller.
 */
export function isBareCliCommand(argv: string[]): boolean {
	return argv[0] === "pipeline-gate";
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

/**
 * Values of every `-e <path>` / `--extension <path>` pair in the PRE-PATCH
 * argv (what the user actually typed — the run-dir splice hasn't run yet at
 * classification time, same contract as userSuppressFlags above).
 */
export function userExtensionPaths(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") out.push(argv[i + 1]!);
	}
	return out;
}

/**
 * Which static extension packages the user's own `-e` paths override. A `-e`
 * path that points INTO a static package's directory (any whole path segment
 * equals the package name, e.g. `-e ~/dev/s2-agent-ext-hermes-memory/
 * extensions/hermes-memory.ts`) means the user wants THAT copy — keeping the
 * baked-in static factory too would register the same tool names twice and
 * crash extension loading with `Tool "<name>" conflicts` (pi does not dedup a
 * static factory against a -e path). cli.ts drops the overridden factories so
 * the user's copy wins. Segment equality (not substring) so
 * `s2-agent-ext-hermes-memory-v2` does not match `s2-agent-ext-hermes-memory`.
 */
export function overriddenStaticExtensions(argv: string[], staticNames: string[]): Set<string> {
	const overridden = new Set<string>();
	for (const p of userExtensionPaths(argv)) {
		const segs = p.split(/[\\/]/);
		for (const name of staticNames) {
			if (segs.includes(name)) overridden.add(name);
		}
	}
	return overridden;
}

/**
 * v2 webui optionality flags (architecture v2 §3.1) — parsed from the PRE-PATCH
 * argv, exactly like userSuppressFlags:
 *  - `--no-webui` — disable the webui extension (sets env WEBUI_DISABLED=1).
 *  - `--webui-port <n>` / `--webui-port=<n>` — pin the webui port (sets env
 *    WEBUI_PORT; the webui port-resolver's strict decimal parse validates it).
 * The webui is ON by default; these are the explicit opt-out / pin seams. The
 * paired `--webui-port <n>` value is consumed here so callers can also strip
 * both tokens from the argv handed to pi (pi records unknown `--` flags as
 * unknownFlags rather than erroring, but our flags must not leak into the
 * upstream parser).
 */
export interface WebuiFlags {
	disabled: boolean;
	/** The raw port string (unvalidated — the webui resolver validates). */
	port: string | null;
	/** argv with every webui flag token (and the paired port value) removed. */
	rest: string[];
}

export function webuiFlags(argv: string[]): WebuiFlags {
	let disabled = false;
	let port: string | null = null;
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--no-webui") {
			disabled = true;
			continue;
		}
		if (a === "--webui-port") {
			const v = argv[i + 1];
			if (v !== undefined && !v.startsWith("-")) {
				port = v;
				i++; // consume the paired value so it is not passed to pi
			}
			continue;
		}
		if (a.startsWith("--webui-port=")) {
			port = a.slice("--webui-port=".length) || null;
			continue;
		}
		rest.push(a);
	}
	return { disabled, port, rest };
}
