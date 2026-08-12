/**
 * args.ts — self-contained argument parser for the movie-director CLI.
 *
 * Deliberately dependency-free of pi-agent (the workspace dep direction is
 * pi-agent → movie-director, never the reverse). It splits argv into:
 *
 *   • the first positional (the command — `preflight`, `generate`, `agent`, …),
 *     left for `cli.ts` to route against the known command table.
 *   • the remaining positionals.
 *   • an `options` record built from two sources:
 *       - `--options '<JSON>'`  — a JSON blob merged verbatim (escape hatch for
 *         nested/complex values like editDecisions).
 *       - loose `--key value` / `--key=value` / `--flag` flags, value-coerced
 *         (number / boolean / JSON / string) so `--frames 200` → 200 and
 *         `--humanApproved` → true. These map straight onto `dispatch()` opts.
 *   • global flags (--json, --verbose, --model, --provider, --thinking,
 *     --mode, --dry-run, --help, --version) peeled off and never treated as
 *     dispatch options.
 *   • `--` end-of-options separator: everything after becomes positional
 *     verbatim (protects leading-dash operands in an `agent` prompt).
 *
 * Value-coercion rule for loose flags (try JSON.parse first — handles numbers,
 * booleans, arrays, objects, quoted strings; fall back to the raw string):
 *   --frames 200            → 200          (number)
 *   --humanApproved true    → true         (boolean)
 *   --pipeline talking-head → "talking-head" (string)
 *   --status in_progress    → "in_progress" (string — JSON parse fails, falls back)
 *
 * The "consume next token as value" rule: the next token is consumed as the
 * value UNLESS it starts with `-` (or there is no next token → boolean true).
 * So `--humanApproved --pipeline foo` → { humanApproved: true, pipeline: "foo" }.
 * Negative numbers / dash-leading values use the `=` form: `--offset=-5`.
 */

export interface ParsedArgs {
	/** Tokens before `--` that were not flags or flag-values. */
	positionals: string[];
	/** Loose `--key value` / `--key=value` / `--flag` → coerced dispatch options. */
	options: Record<string, unknown>;
	/** Tokens after a `--` separator (verbatim, for an agent prompt). */
	doubleDash: string[];
	/** Global flags. */
	json: boolean;
	verbose: number;
	help: boolean;
	version: boolean;
	dryRun: boolean;
	model?: string;
	provider?: string;
	thinking?: string;
	mode?: string;
}

/** Global value-flags (consume the next token as their value). */
const GLOBAL_VALUE_FLAGS = new Set([
	"--model",
	"--provider",
	"--thinking",
	"--mode",
	"--options",
]);

/** Global boolean flags (no value). */
const GLOBAL_BOOL_FLAGS = new Set([
	"--json",
	"--verbose",
	"--dry-run",
	"--help",
	"--version",
]);

/** Parse an argv array into the structured ParsedArgs shape. Pure + total. */
export function parseArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = {
		positionals: [],
		options: {},
		doubleDash: [],
		json: false,
		verbose: 0,
		help: false,
		version: false,
		dryRun: false,
	};

	let i = 0;
	let sawDoubleDash = false;

	while (i < argv.length) {
		const tok = argv[i]!;

		// `--` → everything after is positional verbatim.
		if (tok === "--") {
			sawDoubleDash = true;
			out.doubleDash = argv.slice(i + 1);
			break;
		}

		// Once we've passed `--` we never get here (break above), but keep the
		// guard explicit so the loop invariant is self-documenting.
		if (sawDoubleDash) {
			out.doubleDash.push(tok);
			i++;
			continue;
		}

		// Boolean short-stack: -V, -VV, -h, -v, -Vh … each char is a bool flag.
		if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1) {
			let handled = true;
			for (const ch of tok.slice(1)) {
				if (ch === "V") out.verbose += 1;
				else if (ch === "h") out.help = true;
				else if (ch === "v") out.version = true;
				else {
					handled = false;
					break;
				}
			}
			if (handled) {
				i++;
				continue;
			}
			// Unknown short flag → treat the whole token as a positional so a
			// bare `-` (stdin marker) or a stray flag doesn't crash the parser.
			out.positionals.push(tok);
			i++;
			continue;
		}

		// Long flag: split on the first `=` for the --key=value form.
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const key = eq === -1 ? tok : tok.slice(0, eq);
			const inlineValue = eq === -1 ? undefined : tok.slice(eq + 1);

			// Global value-flags.
			if (GLOBAL_VALUE_FLAGS.has(key)) {
				const raw = inlineValue ?? argv[i + 1];
				if (raw === undefined) {
					// missing value — leave the flag's effect unset; cli.ts will
					// surface a usage error if the command needs it.
					i++;
					continue;
				}
				applyGlobalValueFlag(out, key, raw);
				i += inlineValue !== undefined ? 1 : 2;
				continue;
			}

			// Global boolean flags.
			if (GLOBAL_BOOL_FLAGS.has(key)) {
				if (key === "--json") out.json = true;
				else if (key === "--verbose") out.verbose += 1;
				else if (key === "--dry-run") out.dryRun = true;
				else if (key === "--help") out.help = true;
				else if (key === "--version") out.version = true;
				i++;
				continue;
			}

			// Loose flag → dispatch option. Strip the leading `--`.
			const optKey = key.slice(2);
			if (!optKey) {
				// bare `--` already handled above; defensive no-op.
				i++;
				continue;
			}
			let value: unknown;
			let consumed: number;
			if (inlineValue !== undefined) {
				value = coerceValue(inlineValue);
				consumed = 1;
			} else {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("-")) {
					value = coerceValue(next);
					consumed = 2;
				} else {
					value = true; // boolean flag form: --humanApproved
					consumed = 1;
				}
			}
			mergeOption(out.options, optKey, value);
			i += consumed;
			continue;
		}

		// Positional (doesn't start with `-`).
		out.positionals.push(tok);
		i++;
	}

	return out;
}

/** Apply a recognized global value-flag (--model, --options, …). */
function applyGlobalValueFlag(out: ParsedArgs, key: string, raw: string): void {
	switch (key) {
		case "--model":
			out.model = raw;
			break;
		case "--provider":
			out.provider = raw;
			break;
		case "--thinking":
			out.thinking = raw;
			break;
		case "--mode":
			out.mode = raw;
			break;
		case "--options": {
			// Merge a JSON object into the options record. A non-object JSON
			// value (string/number/array) is ignored — options is always an
			// object keyed by option name.
			const parsed = tryJson(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
					out.options[k] = v;
				}
			}
			break;
		}
	}
}

/**
 * Coerce a raw string value to its typed form: JSON.parse first (numbers,
 * booleans, arrays, objects, quoted strings), then fall back to the raw string.
 * `in_progress` stays a string (not a valid JSON token); `200` → 200; `true` →
 * true; `["a","b"]` → array.
 */
export function coerceValue(raw: string): unknown {
	const parsed = tryJson(raw);
	if (parsed !== undefined) return parsed;
	return raw;
}

/** JSON.parse with a defined sentinel for "not JSON" (null IS valid JSON). */
function tryJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * Merge a coerced value into the options record under `key`. No deep-merge — a
 * later `--key` wins (last-write), matching how every flag on a command line is
 * read top-to-bottom. (Deep-merge of nested objects is what `--options` is for,
 * applied before loose flags so loose flags still win on conflicts.)
 */
function mergeOption(opts: Record<string, unknown>, key: string, value: unknown): void {
	opts[key] = value;
}
