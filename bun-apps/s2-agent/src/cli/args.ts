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
 *   --extension, -e <path>         load extension factory (source mode only; use subcommands in compiled binary)
 *   --approve, -a                  (accepted & ignored — self-trusted)
 *   --no-extensions, -ne           (accepted & ignored)
 *   --no-tools, -nt / --no-builtin-tools, -nbt
 *   --vault <path>                 absolute vault path (sets OB_VAULT_PATH;
 *                                  missing targets refuse — see vault-paths.ts)
 *   --vault-dir <name>             vault folder name (sets OB_VAULT_DIR)
 *   --help, -h                     help
 *   --version, -v                  version
 *
 * Everything positional that isn't a flag value is collected as the task/prompt.
 *
 * `--` is the standard end-of-options separator: once seen, EVERY subsequent
 * token becomes a positional verbatim (flag-parsing disabled), so an extension
 * sub-command can pass its own flags through — e.g.
 * `flux2 -- t2i --prompt "a red cube"` preserves `--prompt` instead of it being
 * swallowed by the unknown-flag skip. It also protects leading-dash operands in
 * passthrough prompts (`-- "-5 degrees"`).
 *
 * ## Table-driven flags
 *
 * Standard-shape flags (value, numeric, boolean) are declared in tables below —
 * adding one is a single row. Special-shape flags (--verbose with its repeatable
 * + peek-numeric forms, --mode enum, --tools CSV, --scale 0.1–16 range, --note enum, --lang,
 * --append-system-prompt file-or-text, -e/--extension ignored-with-value) stay
 * inline because their handling doesn't fit a uniform pattern.
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
	/** permit seeding a NEW vault tree at the explicit --vault path (zk-ingest /
	 *  zk-query / zk-extract plain resolver; without it a missing explicit path
	 *  is treated as a typo and refused — #2055) */
	vaultCreate?: boolean;
	/** resource tier: tree discriminator slug (resource-ingest / resource-query) */
	tree?: string;
	/** resource-query: retrieval lane — flat KNN (default) | recursive heap descent.
	 *  Carried by the shared --mode flag (text|json|rpc stay the output modes;
	 *  recursive|flat never touch out.mode). */
	retrievalMode?: "recursive" | "flat";
	/** resource-query: score propagation α for the recursive lane (default 0.5) */
	alpha?: number;
	/** resource-query: tree root path for lazy L2 body promotion (--tier 2) */
	root?: string;
	/** Extension file paths accepted by --extension/-e (source mode only). */
	extensionPaths: string[];
	/** zettelkasten target folder (distill) */
	folder?: string;
	maxNotes?: number;
	/** file2md: output root dir (default: ./vlm-out) */
	out?: string;
	/** file2md: raster scale factor for OCR/vision page images (default 2 ≈ 144 dpi) */
	scale?: number;
	/** file2md: force a doc profile, skipping the VLM classifier */
	type?: string;
	/** file2md: only process these pages (1-indexed, e.g. "1,3-5") */
	pages?: string;
	/** file2md: pipeline mode auto|text|ocr|vlm (default auto). */
	extract?: string;
	/** file2md: VLM page-note style summary|verbatim|hybrid (default hybrid). */
	note?: string;
	/** file2md: OCR language + note hint (en | chi_sim | en+chi_sim; default en). */
	lang?: string;
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
	/** memory-to-vault: max parallel distill agents (default 4). */
	concurrency?: number;
	/** memory-to-vault: glob restricting which project dirs to include. */
	only?: string;
	/** memory-to-vault: explicit comma-separated file list (overrides discovery). */
	filesCsv?: string;
	/** memory-to-vault: project memory root (default ~/.pi/agent/projects-memory). */
	projectsDir?: string;
	/** memory-to-vault: global hermes dir (default ~/.pi/agent/pi-hermes-memory). */
	memoryDir?: string;
	/** memory-to-vault: run sample zk_ask queries after build. */
	verify?: boolean;
	/** pipeline-gate: effort directory name (.planning/<effort>) */
	effort?: string;
	/** pipeline-gate: tier declaration (T1|T2|T3) */
	tier?: string;
	/** pipeline-gate: gate phase — entry (pre-execution, skips ledger) | close */
	phase?: string;
	/** dispatch-log: outcome filter (green|red|budget-dead|skipped) */
	outcome?: string;
	/** tools-metrics: only sessions starting on/after (YYYY-MM-DD or ISO) */
	since?: string;
	/** tools-metrics: only sessions starting on/before (YYYY-MM-DD or ISO) */
	until?: string;
	/** tools-metrics: only sessions whose cwd contains this substring (case-insensitive) */
	cwdSubstr?: string;
	/** tools-metrics: tool-name substring filter (csv; empty = all) */
	toolFilter?: string;
	/** tools-metrics: show at most N tools (sorted by calls desc) */
	top?: number;
	/** tools-metrics: add p95/max/mean latency columns */
	details?: boolean;
	/** tools-metrics: schema-cost estimation mode (no session scan) */
	schemaCost?: boolean;
	/** tools-metrics --schema-cost: override extension entry points (csv of .ts paths) */
	ext?: string;
	/** tools-metrics / agent-trends: override the sessions root */
	sessionsDir?: string;
	/** agent-trends: scan every project, not just this repo and its worktrees */
	all?: boolean;
	/** agent-trends: sessions per comparison window (default 200) */
	window?: number;
	/** agent-trends: baseline occurrences required for a verdict (default 10) */
	minEvents?: number;
	/** agent-trends: floor on the percentage-point move counting as a change (default 10) */
	delta?: number;
	/** bench-agent: config ids to run (csv; default = full DEFAULT_CONFIGS matrix) */
	configs?: string;
	/** bench-agent: task ids to run (csv; default = all BENCH_TASKS) */
	tasks?: string;
	/** bench-agent: probe mode instead of the matrix (only: prefill) */
	probe?: string;
	/** bench-agent: dry self-test — fixtures + quality gates only, zero LLM calls */
	dry?: boolean;
	/** bench-agent: per-cell prompt timeout in seconds (default 300) */
	timeoutSec?: number;
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
	/** zk-ingest: source family label (default: workflow-jsonl) */
	source?: string;
	/** zk-ingest: human-readable provenance string */
	sourceLabel?: string;
	/** zk-ingest: report only, write nothing */
	dryRun?: boolean;
	/** resource-ingest: skip L0/L1 tier sidecar generation (L2-only rebuild) */
	noTiers?: boolean;
	/** zk-query: tags to match (csv) */
	tags?: string;
	/** zk-query: .knowledge.jsonl to read active ids from + exclude */
	excludeFromKb?: string;
	/** zk-query: explicit ids to exclude (csv) */
	excludeIds?: string;
	/** zk-query: graph health audit mode */
	health?: boolean;
	/** zk-query: convergence coverage audit (missing / sourceOrphaned per family) */
	coverage?: boolean;
	/** zk-query: auto-heal (with --health) */
	fix?: boolean;
	/** zk-query: merge similarity threshold (default 0.9) */
	threshold?: number;
	/** collect-videos: also pull Bilibili popular feed (bilibili only) */
	popular?: boolean;
	/** collect-videos: proxy URL for Bilibili 412 bypass */
	proxy?: string;
	/** collect-videos: recency in days (youtube only) */
	recency?: number;
	/** collect-videos / import-memory: explicit output path override */
	outputPath?: string;
	/** news: ISO date anchoring the digest issue week (default: today) */
	date?: string;
	/** news: regenerate the scaffold even if the issue file has content */
	overwrite?: boolean;
	/** import-memory: override hermes-memory directory */
	hermesDir?: string;
	/** knowledge-pipeline: reset convergence state before run/dry-run */
	reconverge?: boolean;
	/** organize-vault: explicit vault root path */
	vaultRoot?: string;
	/** Convergence-loop tuning: cross-link weighting (count | idf) — read by zk-ingest. */
	linkWeighting?: string;
	/** Convergence-loop tuning: path to a probe eval JSON ({queries:[{q,expect}]}). */
	probeEval?: string;
	/** Convergence-loop tuning: max heal rounds (default 8). */
	maxRounds?: number;
	/** Convergence-loop tuning: consecutive no-progress rounds before stopping (default 2). */
	consecutiveEmpty?: number;
	/** Convergence-loop tuning: max cross-link neighbours per card (default 20). */
	maxLinks?: number;
	/** Convergence-loop tuning: wiki-aware upsert at ingest. */
	wikiAware?: boolean;
	/** Convergence-loop tuning: skip ingest, only heal + probe. */
	healOnly?: boolean;
	/** Convergence-loop tuning: skip the recall probe. */
	noProbe?: boolean;
	/** Emit JSON output (supported by zk-query, etc.) */
	json?: boolean;
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
		json: false,
		noSession: false,
		noTools: false,
		noBuiltinTools: false,
		extensionPaths: [],
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
 * Fail-fast numeric flag parsing. Bad input throws instead of silently coercing
 * to 0/default, so a typo like `--retries abc` can't quietly disable 429
 * retries (the old `Number(x) || 0` did exactly that). 0 stays valid where it
 * is semantically meaningful (e.g. --retries 0 = no retries, --context-lines 0
 * = titles only, --max-notes 0 = unlimited).
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
		const kind = integer ? "integer" : "number";
		const bound = min > 0 ? `≥ ${min}` : "non-negative";
		throw new Error(
			`Invalid ${name} "${raw}" — expected a ${bound} ${kind} (e.g. ${example}).`,
		);
	}
	return n;
}

// ─── Declarative flag tables ───────────────────────────────────────────────
// The flag definitions live in flag-spec.ts, grouped by the command that owns
// them (GLOBAL pi-compat flags vs zk-ask / zk-card / file2md / …).
// parsePiArgs imports the merged tables + field-name unions and stays the
// single public parser. Adding a standard flag = one row in flag-spec.ts.
// Special-shape flags (--verbose repeatable, --mode enum, --tools CSV,
// --append-system-prompt, --scale, -e, --help, --version, `--`) stay inline below.
import {
	VALUE_FLAGS,
	NUMERIC_FLAGS,
	BOOLEAN_FLAGS,
	IGNORED_BOOL_FLAGS,
	type ValueField,
	type NumericField,
	type BoolField,
} from "./flag-spec.ts";

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
	/** true after a bare `--`: stop flag-parsing, treat the rest as positionals. */
	let rawMode = false;

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

	/**
	 * Assign a table-derived field. The field unions (ValueField/NumericField/
	 * BoolField) constrain which keys are legal; the cast bypasses TS's refusal
	 * to write through a union of keys whose value types differ. The field/value
	 * pairings are statically fixed by the tables above, so this is sound.
	 */
	type Assignable = ValueField | NumericField | BoolField;
	const assign = (field: Assignable, value: string | number | boolean): void => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(out as any)[field] = value;
	};

	while (i < argv.length) {
		const a = argv[i];
		// Loop guard guarantees i < argv.length; the explicit undefined check
		// additionally satisfies noUncheckedIndexedAccess (argv[i] is otherwise
		// `string | undefined`) and narrows `a` to `string` for the whole body.
		if (a === undefined) break;

		// `--` = end-of-options separator. Once seen, disable flag-parsing for the
		// rest of argv: every token becomes a positional verbatim. This lets an
		// extension sub-command pass its own flags through (`flux2 -- t2i --prompt
		// "..."`) and protects leading-dash operands in passthrough prompts.
		if (rawMode) {
			out.positionals.push(a);
			out.positionalIndices.push(i);
			i++;
			continue;
		}
		if (a === "--") {
			rawMode = true;
			i++;
			continue;
		}

		// value flags (`--flag <value>` or `--flag=value`) — table-driven
		let matched: string | undefined;
		for (const { flag, field } of VALUE_FLAGS) {
			matched = take(flag);
			if (matched !== undefined) {
				assign(field, matched);
				break;
			}
		}
		if (matched !== undefined) {
			i++;
			continue;
		}

		// numeric flags — fail-fast via parseNumericFlag (table-driven)
		let numHandled = false;
		for (const { flag, field, ...opts } of NUMERIC_FLAGS) {
			const v = take(flag);
			if (v !== undefined) {
				assign(field, parseNumericFlag(flag, v, opts));
				i++;
				numHandled = true;
				break;
			}
		}
		if (numHandled) continue;

		// --scale (numeric; positive float — it feeds pdfium rasterization for
		// OCR/vision page images. A bad value would silently fall back or produce
		// a broken render; 1 = ~72dpi, 2 (default) ≈ 144dpi, 4 = 288dpi (OCR ~
		// usable to 300dpi for small print). Cap at 16 — beyond that a letter page
		// exceeds 20k px and buys nothing.
		{
			const d = take("--scale");
			if (d !== undefined) {
				const n = Number(d);
				if (!Number.isFinite(n) || n <= 0 || n > 16) {
					throw new Error(
						`Invalid --scale "${d}" — use a positive number between 0.1 and 16 (e.g. 2 for ~144dpi).`,
					);
				}
				out.scale = n;
				i++;
				continue;
			}
		}

		// boolean flags (presence → true; supports aliases) — table-driven
		{
			const hit = BOOLEAN_FLAGS.find((b) => b.flags.includes(a));
			if (hit) {
				assign(hit.field, true);
				i++;
				continue;
			}
		}
		if (IGNORED_BOOL_FLAGS.has(a)) {
			i++; // accepted, no-op (self-trusted / extensions baked in)
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
				else if (m === "recursive" || m === "flat") out.retrievalMode = m; // resource-query lane
				i++;
				continue;
			}
		}

		// --tools / -t  (csv)
		{
			const t = take("--tools") ?? take("-t");
			if (t !== undefined) {
				out.tools = csv(t);
				i++;
				continue;
			}
		}

		// --exclude-tools / -xt  (csv)
		{
			const t = take("--exclude-tools") ?? take("-xt");
			if (t !== undefined) {
				out.excludeTools = csv(t);
				i++;
				continue;
			}
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
		if (a === "-e" || a === "--extension") {
			const val = argv[i + 1];
			if (val && !val.startsWith("-")) {
				out.extensionPaths.push(val);
				i += 2;
			} else {
				i += 1; // no value — skip just the flag
			}
			continue;
		}
		if (a.startsWith("-e=") || a.startsWith("--extension=")) {
			const val = a.slice(a.indexOf("=") + 1);
			if (val) out.extensionPaths.push(val);
			i++;
			continue;
		}
		// `-h` / `--help` are flags and work anywhere. The bare WORD `help` is a
		// sub-command, so it counts only as the FIRST POSITIONAL — not the first
		// argv token, which would break the documented `cli --model x help`.
		//
		// It used to count at any position, which made an ordinary unquoted prompt
		// silently do nothing: `cli -p explain the help system` printed the banner
		// and exited 0. Worse, the token was also dropped from positionals, so even
		// a run that did dispatch would have sent a corrupted prompt. Exit 0 with
		// no output is indistinguishable from success to a scripted caller — the
		// exact silent-success class this namespace guards against elsewhere.
		if (a === "-h" || a === "--help" || (a === "help" && out.positionals.length === 0)) {
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
