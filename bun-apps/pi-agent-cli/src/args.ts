/**
 * pi-TUI-aligned argument parser.
 *
 * Mirrors the flags accepted by the `pi` interactive/print/json CLI so this
 * binary can serve as its own sub-agent target (the pi-obsidian distill/garden
 * tools re-invoke `process.argv[1]` with these exact flags).
 *
 * Supported flags (compatible with `pi --help`):
 *   --provider <name>              Provider name
 *   --model <pattern>              "id", "provider/id", or "provider/id:thinking"
 *   --thinking <level>             off|minimal|low|medium|high|xhigh
 *   --api-key <key>                API key (also resolvable from env)
 *   --system-prompt <text>         (ignored beyond passthrough note)
 *   --append-system-prompt <x>     text OR path to a file (read if it exists)
 *   --mode <mode>                  text (default) | json
 *   --print, -p                    non-interactive: one turn, exit
 *   --verbose, -V                 tool verbosity (repeatable: -VV = debug).
 *                                  Shows tool args (lvl 1) + result preview (lvl 2).
 *                                  Also: --verbose <n>, --debug (=2), env PI_VERBOSE.
 *   --no-session                   ephemeral (in-memory) session
 *   --tools, -t <csv>              tool allowlist
 *   --exclude-tools, -xt <csv>     tool denylist
 *   --extension, -e <path>         (accepted & ignored — pi-obsidian is baked in)
 *   --approve, -a                  (accepted & ignored — self-trusted)
 *   --no-extensions, -ne           (accepted & ignored)
 *   --no-tools, -nt / --no-builtin-tools, -nbt
 *   --vault <path>                 absolute vault path (sets OB_VAULT_PATH)
 *   --vault-dir <name>             vault folder name (sets OB_VAULT_DIR)
 *   --help, -h                     help
 *   --version, -v                  version
 *
 * Everything positional that isn't a flag value is collected as the task/prompt.
 */

import { readFileSync, existsSync } from "node:fs";

export type OutputMode = "text" | "json";

export interface ParsedArgs {
	provider?: string;
	model?: string;
	thinking?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	mode: OutputMode;
	print: boolean;
	noSession: boolean;
	tools?: string[];
	excludeTools?: string[];
	noTools: boolean;
	noBuiltinTools: boolean;
	/** vault resolution (obsidian) */
	vault?: string;
	vaultDir?: string;
	/** zettelkasten target folder (distill) */
	folder?: string;
	maxNotes?: number;
	/** vlm-describe: output root dir (default: ./vlm-out) */
	out?: string;
	/** vlm-describe: rasterization DPI for PDFs (default 150) */
	dpi?: number;
	/** vlm-describe: force a doc profile, skipping the VLM classifier */
	type?: string;
	/** vlm-describe: only process these pages (1-indexed, e.g. "1,3-5") */
	pages?: string;
	/** pdf-to-vault pipeline: stage 1 (vlm) model — the ONLY stage-specific
	 *  model. Stage 2 (distill) reuses the global --model passthrough. */
	vlmModel?: string;
	/** pdf-to-vault pipeline: VLM retries on 429/transient (default 3) */
	retries?: number;
	/** pdf-to-vault pipeline: seconds to wait between retries (default 10) */
	retryWaitSec?: number;
	/** pdf-to-vault pipeline: delete page PNGs after distill */
	deletePng?: boolean;
	/** pdf-to-vault pipeline: force re-run distill stage */
	forceDistill?: boolean;
	/** zk-card: bypass duplicate/backlink safety checks */
	force?: boolean;
	/** zk-card add: read content from file instead of inline text */
	file?: string;
	/** zk-card find: context lines around matches (default 3) */
	contextLines?: number;
	/** zk-card find: titles only, no context (same as contextLines 0) */
	noContext?: boolean;
	/** zk-card find: max results (default 10) */
	limit?: number;
	/** zk-ask: graph hop depth for neighbor expansion (default 2) */
	depth?: number;
	/** zk-ask: max neighbor nodes per seed per hop in graph expansion (default 5) */
	maxNeighbors?: number;
	/** zk-ask: max notes to include in context (default 8) */
	topK?: number;
	/** zk-ask: output assembled context only, skip generation */
	retrieveOnly?: boolean;
	/** zk-ask: summarize each cluster before generating */
	summarize?: boolean;
	/** zk-ask: max tokens per note in full-read tier (default 2000) */
	maxNoteTokens?: number;
	/** zk-ask: skip seed quality gate */
	noRefine?: boolean;
	/** Tool event verbosity: 0=silent (name only), 1=args summary,
	 *  2=debug (full args + result preview). Set by -V/--verbose/--debug or PI_VERBOSE. */
	verbose: number;
	/** positional tokens (the prompt/task) */
	positionals: string[];
	/** indices into the parsed argv parallel to `positionals` (for command dispatch). */
	positionalIndices: number[];
	help: boolean;
	version: boolean;
	/** raw argv after the leading sub-command path (if any) */
	rest: string[];
}

export function emptyParsed(): ParsedArgs {
	return {
		appendSystemPrompt: [],
		mode: "text",
		print: false,
		noSession: false,
		noTools: false,
		noBuiltinTools: false,
		positionals: [],
		positionalIndices: [],
		help: false,
		version: false,
		rest: [],
		// Seed from env so spawned subagents (obsidian_distill/garden re-invoke
		// process.argv[1]) inherit the user's chosen verbosity without extra flags.
		verbose: parseVerboseEnv(),
	};
}

/** Read PI_VERBOSE / BUN_PI_VERBOSE env (0-2). Invalid → 0. */
function parseVerboseEnv(): number {
	const raw = process.env.PI_VERBOSE ?? process.env.BUN_PI_VERBOSE;
	if (!raw) return 0;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 && n <= 2 ? n : 0;
}

/** Split a comma list. */
function csv(val: string): string[] {
	return val
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

/**
 * Fail-fast numeric flag parsing — mirrors --depth / --top-k / --dpi. Bad input
 * throws instead of silently coercing to 0/default, so a typo like `--retries
 * abc` can't quietly disable 429 retries (the old `Number(x) || 0` did exactly
 * that). 0 stays valid where it is semantically meaningful (e.g. --retries 0 =
 * no retries, --context-lines 0 = titles only, --max-notes 0 = unlimited).
 *
 * @param name    flag name for the error message (e.g. "--retries")
 * @param raw     the raw token from argv
 * @param min     inclusive lower bound (default 0)
 * @param integer require an integer value (default true)
 * @param example hint shown in the error message (e.g. "10")
 */
function parseNumericFlag(
	name: string,
	raw: string,
	{ min = 0, integer = true, example = "2" }: {
		min?: number;
		integer?: boolean;
		example?: string;
	} = {},
): number {
	const n = Number(raw);
	const ok =
		Number.isFinite(n) &&
		n >= min &&
		(!integer || Number.isInteger(n));
	if (!ok) {
		const kind = integer ? "an integer" : "a number";
		const bound = min > 0 ? `greater than or equal to ${min}` : "non-negative";
		throw new Error(
			`Invalid ${name} "${raw}" — use ${kind} ${bound} (e.g. ${example}).`,
		);
	}
	return n;
}

/**
 * Parse pi-aligned flags from an argv slice.
 *
 * @param argv   tokens to parse (typically the tail after any sub-command path)
 * @param read   file reader (injectable for tests); defaults to fs.readFileSync
 */
export function parsePiArgs(
	argv: string[],
	read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ParsedArgs {
	const out = emptyParsed();
	out.rest = [...argv];
	let i = 0;

	/** grab the value for a flag, supporting `--flag value` and `--flag=value`. */
	const take = (name: string): string | undefined => {
		const cur = argv[i];
		// `i` is an index into argv; under noUncheckedIndexedAccess argv[i] is
		// `string | undefined`. A missing value here means the flag is at the
		// tail with no following token — treat as no match.
		if (cur === undefined) return undefined;
		if (cur === name) {
			const v = argv[++i];
			return v;
		}
		if (cur.startsWith(name + "=")) {
			return cur.slice(name.length + 1);
		}
		return undefined;
	};

	while (i < argv.length) {
		const a = argv[i];
		// Loop guard guarantees i < argv.length; the explicit undefined check
		// additionally satisfies noUncheckedIndexedAccess (argv[i] is otherwise
		// `string | undefined`) and narrows `a` to `string` for the whole body.
		if (a === undefined) break;

		// value flags (with `=` support)
		const valFlags: Array<keyof ParsedArgs> = [
			"provider",
			"model",
			"thinking",
			"apiKey",
			"systemPrompt",
			"vault",
			"vaultDir",
			"folder",
			"out",
			"type",
			"pages",
			"file",
		];
		let matched: string | undefined;
		for (const key of valFlags) {
			const flagName =
				"--" + key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
			matched = take(flagName);
			if (matched !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(out as any)[key] = matched;
				break;
			}
		}
		if (matched !== undefined) {
			i++;
			continue;
		}

		// --max-notes (non-negative integer; 0 = unlimited hint)
		{
			const mn = take("--max-notes");
			if (mn !== undefined) {
				out.maxNotes = parseNumericFlag("--max-notes", mn, { example: "30" });
				i++;
				continue;
			}
		}

		// --dpi (numeric; must be a positive integer — it feeds rasterization, so a
		// bad value would either silently fall back (Number("abc")||150) or produce a
		// broken render (negative/zero DPI → opaque per-page "unknown error"). Reject
		// it up front like --type / --pages instead. Caught by cli.ts top-level catch.
		{
			const d = take("--dpi");
			if (d !== undefined) {
				const n = Number(d);
				// 4096 DPI is already enormous (a letter page → ~50k px); anything
				// larger is a mistake and would OOM the rasterizer. Reject up front.
				if (!Number.isFinite(n) || n <= 0 || n > 4096) {
					throw new Error(
						`Invalid --dpi "${d}" — use a positive integer between 1 and 4096 (e.g. 150).`,
					);
				}
				out.dpi = n;
				i++;
				continue;
			}
		}

		// pdf-to-vault pipeline flags
		{
			const vm = take("--vlm-model");
			if (vm !== undefined) {
				out.vlmModel = vm;
				i++;
				continue;
			}
		}
		{
			const r = take("--retries");
			if (r !== undefined) {
				out.retries = parseNumericFlag("--retries", r, { example: "3" });
				i++;
				continue;
			}
		}
		{
			const rw = take("--retry-wait");
			if (rw !== undefined) {
				out.retryWaitSec = parseNumericFlag("--retry-wait", rw, { integer: false, example: "10" });
				i++;
				continue;
			}
		}
		if (a === "--delete-png") {
			out.deletePng = true;
			i++;
			continue;
		}
		if (a === "--force-distill") {
			out.forceDistill = true;
			i++;
			continue;
		}
		if (a === "--force") {
			out.force = true;
			i++;
			continue;
		}
		if (a === "--no-context") {
			out.noContext = true;
			i++;
			continue;
		}

		// --context-lines (non-negative integer; 0 = titles only)
		{
			const cl = take("--context-lines");
			if (cl !== undefined) {
				out.contextLines = parseNumericFlag("--context-lines", cl, { example: "3" });
				i++;
				continue;
			}
		}

		// --limit (positive integer; max results)
		{
			const lim = take("--limit");
			if (lim !== undefined) {
				out.limit = parseNumericFlag("--limit", lim, { min: 1, example: "10" });
				i++;
				continue;
			}
		}

		// --depth (non-negative integer)
		{
			const dep = take("--depth");
			if (dep !== undefined) {
				const depN = Number(dep);
				if (!Number.isInteger(depN) || depN < 0)
					throw new Error(
						`Invalid --depth "${dep}" — use a non-negative integer (e.g. 2).`,
					);
				out.depth = depN;
				i++;
				continue;
			}
		}

		// --max-neighbors (non-negative integer)
		{
			const mn = take("--max-neighbors");
			if (mn !== undefined) {
				const mnN = Number(mn);
				if (!Number.isInteger(mnN) || mnN < 0)
					throw new Error(
						`Invalid --max-neighbors "${mn}" — use a non-negative integer (e.g. 5).`,
					);
				out.maxNeighbors = mnN;
				i++;
				continue;
			}
		}

		// --top-k (non-negative integer)
		{
			const tk = take("--top-k");
			if (tk !== undefined) {
				const tkN = Number(tk);
				if (!Number.isInteger(tkN) || tkN < 0)
					throw new Error(
						`Invalid --top-k "${tk}" — use a non-negative integer (e.g. 8).`,
					);
				out.topK = tkN;
				i++;
				continue;
			}
		}

		// --max-note-tokens (non-negative integer)
		{
			const mnt = take("--max-note-tokens");
			if (mnt !== undefined) {
				const mntN = Number(mnt);
				if (!Number.isInteger(mntN) || mntN < 0)
					throw new Error(
						`Invalid --max-note-tokens "${mnt}" — use a non-negative integer (e.g. 2000).`,
					);
				out.maxNoteTokens = mntN;
				i++;
				continue;
			}
		}

		if (a === "--retrieve-only") {
			out.retrieveOnly = true;
			i++;
			continue;
		}
		if (a === "--summarize") {
			out.summarize = true;
			i++;
			continue;
		}
		if (a === "--no-refine") {
			out.noRefine = true;
			i++;
			continue;
		}

		// --append-system-prompt (file or text; repeatable)
		{
			const asp = take("--append-system-prompt");
			if (asp !== undefined) {
				let text = asp;
				try {
					// If it's a path to an existing file, read its contents (pi behavior).
					if (!asp.includes("\n") && asp.length < 4096 && existsSync(asp)) {
						text = read(asp);
					}
				} catch {
					/* keep literal */
				}
				out.appendSystemPrompt.push(text);
				i++;
				continue;
			}
		}

		// --mode text|json
		{
			const m = take("--mode");
			if (m !== undefined) {
				if (m === "json") out.mode = "json";
				else if (m === "text") out.mode = "text";
				else if (m === "rpc") out.mode = "text"; // rpc unsupported → degrade to text
				i++;
				continue;
			}
		}

		// --tools / -t
		{
			const t = take("--tools") ?? take("-t");
			if (t !== undefined) {
				out.tools = csv(t);
				i++;
				continue;
			}
		}

		// --exclude-tools / -xt
		{
			const t = take("--exclude-tools") ?? take("-xt");
			if (t !== undefined) {
				out.excludeTools = csv(t);
				i++;
				continue;
			}
		}

		// booleans
		if (a === "-p" || a === "--print") {
			out.print = true;
			i++;
			continue;
		}
		// --verbose / -V  (repeatable; optional numeric arg: --verbose 2)
		// --debug         (alias for level 2 — full args + result preview)
		if (a === "-V" || a === "--verbose" || /^-V+$/.test(a) || /^--verbose=\d+$/.test(a)) {
			if (a.startsWith("--verbose=")) {
						// --verbose=N  (= form)
						const n = Number(a.slice("--verbose=".length));
						if (Number.isInteger(n) && n >= 0 && n <= 2) out.verbose = n;
						i++;
			} else if (/^-V+$/.test(a) && a.length > 2) {
						// -VV → 2, -VVV → 2 (clamped). Each extra V adds one level.
						out.verbose = Math.min(2, out.verbose + (a.length - 1));
						i++;
			} else {
						// bare -V or --verbose; peek for a following numeric value
						const next = argv[i + 1];
						if (next !== undefined && /^\d+$/.test(next)) {
						const n = Number(next);
						if (Number.isInteger(n) && n >= 0 && n <= 2) out.verbose = n;
						i += 2;
						} else {
						out.verbose = Math.min(2, out.verbose + 1);
						i++;
						}
			}
			continue;
		}
		if (a === "--debug") {
			out.verbose = 2;
			i++;
			continue;
		}
		if (a === "--no-session") {
			out.noSession = true;
			i++;
			continue;
		}
		if (a === "-a" || a === "--approve") {
			i++; // ignored (self-trusted)
			continue;
		}
		if (a === "-e" || a === "--extension") {
			i += 2; // ignored (obsidian baked in)
			continue;
		}
		if (a.startsWith("-e=") || a.startsWith("--extension=")) {
			i++;
			continue;
		}
		if (a === "-ne" || a === "--no-extensions") {
			i++; // ignored
			continue;
		}
		if (a === "-nt" || a === "--no-tools") {
			out.noTools = true;
			i++;
			continue;
		}
		if (a === "-nbt" || a === "--no-builtin-tools") {
			out.noBuiltinTools = true;
			i++;
			continue;
		}
		if (a === "-h" || a === "--help" || a === "help") {
			out.help = true;
			i++;
			continue;
		}
		if (a === "-v" || a === "--version") {
			out.version = true;
			i++;
			continue;
		}

		// unknown `--flag` → skip with its value if it looks like a value flag
		if (a.startsWith("--") && a.length > 2) {
			// best-effort: skip the token (and a following non-flag value)
			i++;
			if (i < argv.length && !argv[i]!.startsWith("-")) i++;
			continue;
		}
		if (a.startsWith("-") && a.length > 1 && a !== "-") {
			i++; // unknown short flag
			continue;
		}

		// positional
		out.positionals.push(a);
		out.positionalIndices.push(i);
		i++;
	}

	return out;
}
