/**
 * Declarative flag specifications for the `s2-agent cli` namespace, grouped by the command that
 * owns them. Imported by `args.ts`'s `parsePiArgs` (the unified public parser).
 *
 * WHY A SEPARATE MODULE
 *   args.ts used to inline all ~40 flag rows in three flat tables, mixing
 *   GLOBAL pi-compatible flags (model/provider/mode/…) with flags only one
 *   command reads (--depth is zk-ask-only; --retries is pdf-to-vault-only).
 *   Co-locating each command's flags here makes OWNERSHIP explicit, shrinks the
 *   parser module, and gives a reusable `FlagSpec` contract a future command
 *   could parse its own slice from (incremental per-command delegation, instead
 *   of a big-bang rewrite that would churn 30+ tests + every command for zero
 *   behavior change).
 *
 * `parsePiArgs` stays the single parser: it imports the merged VALUE_FLAGS /
 * NUMERIC_FLAGS / BOOLEAN_FLAGS + the field-name unions, so every existing call
 * site (30+ tests, all commands) keeps working unchanged. Adding a standard flag
 * = add ONE row to the relevant owner group below.
 *
 * Flags whose handling doesn't fit the uniform table shape (--verbose repeatable,
 * --mode enum, --tools CSV, --append-system-prompt file-or-text, --scale range,
 * -e/--extension, --help, --version, the `--` separator) stay INLINE in the
 * parse loop in args.ts.
 */

// ── field-name unions (the legal ParsedArgs keys each table may write) ──────
// Co-located with the tables so a flag's row + its field name live together.

export type NumericField =
	| "maxNotes" | "contextLines" | "retries" | "retryWaitSec" | "limit"
	| "depth" | "maxNeighbors" | "topK" | "maxNoteTokens" | "threshold"
	| "recency"
	| "maxRounds" | "consecutiveEmpty" | "maxLinks"
	| "concurrency"
	| "top" | "window" | "minEvents" | "delta"
	| "alpha"
	| "timeoutSec";

export type ValueField =
	| "provider" | "model" | "thinking" | "apiKey" | "systemPrompt"
	| "vault" | "vaultDir" | "folder" | "out" | "type" | "pages" | "file" | "tree"
	| "extract" | "note" | "lang"
	| "vlmModel" | "source" | "sourceLabel"
	| "tags" | "excludeFromKb" | "excludeIds"
	| "proxy" | "outputPath" | "hermesDir" | "vaultRoot" | "order" | "date"
	| "linkWeighting" | "probeEval"
	| "only" | "filesCsv" | "projectsDir" | "memoryDir"
	| "effort" | "tier" | "outcome" | "phase"
	| "since" | "until" | "cwdSubstr" | "toolFilter" | "sessionsDir" | "ext"
	| "root"
	| "configs" | "tasks" | "probe";

export type BoolField =
	| "retrieveOnly" | "summarize" | "noRefine" | "force" | "noContext"
	| "forceDistill" | "deletePng" | "noSession" | "print" | "noTools"
	| "noBuiltinTools" | "dryRun" | "health" | "fix" | "json" | "noTiers"
	| "vaultCreate"
	| "save"
	| "popular" | "coverage" | "overwrite"
	| "wikiAware" | "healOnly" | "noProbe"
	| "verify" | "reconverge"
	| "details" | "schemaCost" | "all"
	| "dry";

// ── spec row shapes ─────────────────────────────────────────────────────────

export interface ValueFlagSpec {
	flag: string;
	field: ValueField;
}

export interface NumericFlagSpec {
	flag: string;
	field: NumericField;
	min?: number;
	integer?: boolean;
	example?: string;
}

export interface BoolFlagSpec {
	/** All accepted spellings (the canonical long form + aliases). */
	flags: string[];
	field: BoolField;
}

// ════════════════════════════════════════════════════════════════════════════
// VALUE FLAGS  (--flag <value>  |  --flag=value)
// ════════════════════════════════════════════════════════════════════════════

// ── GLOBAL — pi-compatible; apply to passthrough + every command ────────────
const GLOBAL_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--provider", field: "provider" },
	{ flag: "--model", field: "model" },
	{ flag: "--thinking", field: "thinking" },
	{ flag: "--api-key", field: "apiKey" },
	{ flag: "--system-prompt", field: "systemPrompt" },
	{ flag: "--vault", field: "vault" },
	{ flag: "--vault-dir", field: "vaultDir" },
];

// ── knowledge commands (zk-extract / zk-card / zk-ask) — shared target folder ─
const KNOWLEDGE_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--folder", field: "folder" }, // shared: zk-extract, zk-card, zk-ask
];

// ── zk-card — content source ────────────────────────────────────────────────
const ZK_CARD_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--file", field: "file" },
];

// ── zk-ingest — provenance labels ───────────────────────────────────────────
const ZK_INGEST_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--source", field: "source" },
	{ flag: "--source-label", field: "sourceLabel" },
];

// ── resource tier (resource-ingest / resource-query) — tree discriminator ───
const RESOURCE_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--tree", field: "tree" }, // filter/scope by tree slug (default: basename of the ingested root)
	{ flag: "--root", field: "root" }, // resource-query: tree root path for lazy L2 body promotion (--tier 2)
];

// ── resource tier (resource-query) — recursive lane tuning ───────────────────
const RESOURCE_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--alpha", field: "alpha", min: 0, integer: false, example: "0.5" }, // score propagation α (≤1 validated in-command)
];

// ── resource tier (resource-ingest) — semantic tier pass ────────────────────
const RESOURCE_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--no-tiers"], field: "noTiers" }, // skip L0/L1 sidecar generation (L2-only rebuild)
];

// ── zk-query — graph-health filters ─────────────────────────────────────────
const ZK_QUERY_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--tags", field: "tags" },
	{ flag: "--exclude-from-kb", field: "excludeFromKb" },
	{ flag: "--exclude-ids", field: "excludeIds" },
];

// ── file2md / pdf-to-vault — output + doc profile (shared) ─────────────
const VLM_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--out", field: "out" }, // shared: file2md, pdf-to-vault
	{ flag: "--type", field: "type" }, // shared
	{ flag: "--pages", field: "pages" }, // shared
	{ flag: "--extract", field: "extract" }, // file2md (auto|text|ocr|vlm)
	{ flag: "--note", field: "note" }, // file2md (summary|verbatim|hybrid)
	{ flag: "--lang", field: "lang" }, // file2md (en|chi_sim|en+chi_sim)
];

// ── pdf-to-vault — stage-1 model ────────────────────────────────────────────
const PDF_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--vlm-model", field: "vlmModel" },
];

// ── zk-ingest — convergence-loop tuning (link-weighting read by zk-ingest; ──
// probe-eval parsed for pipeline consumers) ─────────────────────────────────
const KCARD_LOOP_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--link-weighting", field: "linkWeighting" }, // also fixes zk-ingest's latent gap (flag was documented but never parsed)
	{ flag: "--probe-eval", field: "probeEval" },
];

// ── research-tool (collect-videos / import-memory / organize-vault) ──────────
const RESEARCH_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--proxy", field: "proxy" }, // collect-videos
	{ flag: "--output-path", field: "outputPath" }, // shared: collect-videos, import-memory
	{ flag: "--hermes-dir", field: "hermesDir" }, // import-memory
	{ flag: "--vault-root", field: "vaultRoot" }, // organize-vault
	{ flag: "--order", field: "order" }, // collect-videos
	{ flag: "--date", field: "date" }, // news: anchor the issue week (ISO yyyy-mm-dd)
];

// ── memory-to-vault — discovery scope ────────────────────────────────────────
const MEMORY_TO_VAULT_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--only", field: "only" },
	{ flag: "--files", field: "filesCsv" },
	{ flag: "--projects-dir", field: "projectsDir" },
	{ flag: "--memory-dir", field: "memoryDir" },
];

// ── pipeline-gate — tier/effort selector ──────────────────────────────────────
const PIPELINE_GATE_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--effort", field: "effort" },
	{ flag: "--tier", field: "tier" },
	{ flag: "--phase", field: "phase" },
];

// ── dispatch-log — outcome filter ────────────────────────────────────────────────
const DISPATCH_LOG_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--outcome", field: "outcome" },
];

// ── meta commands (tools-metrics / agent-trends) — session-log analysis ──────
// Migrated from hand-rolled takeFlag/hasFlag/flag/has/num rest-parsers
// (ticket 04): field names mirror the local variables the commands read.
const META_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--since", field: "since" }, // tools-metrics: sessions starting on/after
	{ flag: "--until", field: "until" }, // tools-metrics: sessions starting on/before
	{ flag: "--cwd", field: "cwdSubstr" }, // tools-metrics: cwd substring filter
	{ flag: "--tool", field: "toolFilter" }, // tools-metrics: tool-name substrings (csv)
	{ flag: "--sessions-dir", field: "sessionsDir" }, // shared: tools-metrics, agent-trends
	{ flag: "--ext", field: "ext" }, // tools-metrics --schema-cost: entry overrides (csv)
];

// ── bench-agent — GLM speed/effectiveness benchmark ─────────────────────────
const BENCH_VALUE_FLAGS: readonly ValueFlagSpec[] = [
	{ flag: "--configs", field: "configs" }, // csv subset of DEFAULT_CONFIGS ids (default: all)
	{ flag: "--tasks", field: "tasks" }, // csv subset of BENCH_TASKS ids (default: all)
	{ flag: "--probe", field: "probe" }, // probe mode instead of the matrix (only: prefill)
];

/** All value flags (merged, order-independent). */
export const VALUE_FLAGS: readonly ValueFlagSpec[] = [
	...MEMORY_TO_VAULT_VALUE_FLAGS,
	...GLOBAL_VALUE_FLAGS,
	...KNOWLEDGE_VALUE_FLAGS,
	...ZK_CARD_VALUE_FLAGS,
	...ZK_INGEST_VALUE_FLAGS,
	...RESOURCE_VALUE_FLAGS,
	...ZK_QUERY_VALUE_FLAGS,
	...VLM_VALUE_FLAGS,
	...PDF_VALUE_FLAGS,
	...RESEARCH_VALUE_FLAGS,
	...KCARD_LOOP_VALUE_FLAGS,
	...PIPELINE_GATE_VALUE_FLAGS,
	...DISPATCH_LOG_VALUE_FLAGS,
	...META_VALUE_FLAGS,
	...BENCH_VALUE_FLAGS,
];

// ════════════════════════════════════════════════════════════════════════════
// NUMERIC FLAGS  (--flag <n>, fail-fast validated via parseNumericFlag)
// ════════════════════════════════════════════════════════════════════════════

// ── zk-extract — note budget ────────────────────────────────────────────────
const ZK_EXTRACT_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--max-notes", field: "maxNotes", example: "30" },
];

// ── zk-card — find result shaping ───────────────────────────────────────────
const ZK_CARD_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--context-lines", field: "contextLines", example: "3" },
	{ flag: "--limit", field: "limit", min: 1, example: "10" },
];

// ── zk-ask — graph-RAG tuning ───────────────────────────────────────────────
const ZK_ASK_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--depth", field: "depth", example: "2" },
	{ flag: "--max-neighbors", field: "maxNeighbors", example: "5" },
	{ flag: "--top-k", field: "topK", example: "8" },
	{ flag: "--max-note-tokens", field: "maxNoteTokens", example: "2000" },
];

// ── pdf-to-vault — VLM retry policy ─────────────────────────────────────────
const PDF_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--retries", field: "retries", example: "3" },
	{ flag: "--retry-wait", field: "retryWaitSec", integer: false, example: "10" },
];

// ── zk-query — merge similarity threshold ───────────────────────────────────
const ZK_QUERY_NUM_FLAGS: readonly NumericFlagSpec[] = [
	// threshold is a 0..1 fraction, NOT an integer (pre-existing bug: rejected 0.85/0.9 from CLI).
	{ flag: "--threshold", field: "threshold", integer: false, example: "0.9" },
];

// ── zk-ingest — convergence-loop tuning: heal-loop budgets ────────────────
const KCARD_LOOP_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--max-rounds", field: "maxRounds", example: "8" },
	{ flag: "--consecutive-empty", field: "consecutiveEmpty", example: "2" },
	{ flag: "--max-links", field: "maxLinks", example: "20" },
];

// ── research-tool (collect-videos) — recency window ─────────────────────────
const RESEARCH_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--recency", field: "recency", example: "30" },
];

// ── memory-to-vault — parallelism ───────────────────────────────────────────
const MEMORY_TO_VAULT_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--concurrency", field: "concurrency", min: 1, example: "4" },
];

// ── meta commands (tools-metrics / agent-trends) — shaping + window tuning ───
// agent-trends' old num() silently fell back to the default on invalid input;
// these rows fail fast via parseNumericFlag instead (documented in ticket 04).
const META_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--top", field: "top", min: 1, example: "20" }, // tools-metrics
	{ flag: "--window", field: "window", min: 1, example: "200" }, // agent-trends
	{ flag: "--min-events", field: "minEvents", min: 1, example: "10" }, // agent-trends
	{ flag: "--delta", field: "delta", min: 1, integer: false, example: "10" }, // agent-trends (pp floor)
];

// ── bench-agent — per-cell prompt timeout ───────────────────────────────────
const BENCH_NUM_FLAGS: readonly NumericFlagSpec[] = [
	{ flag: "--timeout-sec", field: "timeoutSec", min: 10, example: "300" },
];

/** All numeric flags (merged). */
export const NUMERIC_FLAGS: readonly NumericFlagSpec[] = [
	...MEMORY_TO_VAULT_NUM_FLAGS,
	...ZK_EXTRACT_NUM_FLAGS,
	...ZK_CARD_NUM_FLAGS,
	...ZK_ASK_NUM_FLAGS,
	...PDF_NUM_FLAGS,
	...ZK_QUERY_NUM_FLAGS,
	...RESEARCH_NUM_FLAGS,
	...KCARD_LOOP_NUM_FLAGS,
	...META_NUM_FLAGS,
	...RESOURCE_NUM_FLAGS,
	...BENCH_NUM_FLAGS,
];

// ════════════════════════════════════════════════════════════════════════════
// BOOLEAN FLAGS  (presence → true; supports aliases)
// ════════════════════════════════════════════════════════════════════════════

// ── GLOBAL — pi-compatible; apply to passthrough + every command ────────────
const GLOBAL_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--no-session"], field: "noSession" },
	{ flags: ["-p", "--print"], field: "print" },
	{ flags: ["-nt", "--no-tools"], field: "noTools" },
	{ flags: ["-nbt", "--no-builtin-tools"], field: "noBuiltinTools" },
	{ flags: ["--dry-run"], field: "dryRun" }, // globalized: suppresses vault writes
];

// ── vault resolution (zk-ingest / zk-query / zk-extract) — explicit seed ─────
const VAULT_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--vault-create"], field: "vaultCreate" },
];

// ── zk-ask — RAG output control ─────────────────────────────────────────────
const ZK_ASK_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--retrieve-only"], field: "retrieveOnly" },
	{ flags: ["--summarize"], field: "summarize" },
	{ flags: ["--no-refine"], field: "noRefine" },
];

// ── zk-card — safety bypass + find shaping ──────────────────────────────────
const ZK_CARD_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--force"], field: "force" },
	{ flags: ["--no-context"], field: "noContext" },
];

// ── pdf-to-vault — distill stage control ────────────────────────────────────
const PDF_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--force-distill"], field: "forceDistill" },
	{ flags: ["--delete-png"], field: "deletePng" },
];

// ── zk-query — graph health + output ────────────────────────────────────────
const ZK_QUERY_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--health"], field: "health" },
	// --fix / --json are shared beyond zk-query: doctor reads fix+json,
	// tools-metrics + agent-trends read json (ticket 04 moved them off rest-scan).
	{ flags: ["--fix"], field: "fix" },
	{ flags: ["--coverage"], field: "coverage" },
	{ flags: ["--json"], field: "json" },
];

// ── knowledge-pipeline — operational surface ────────────────────────────────
const KNOWLEDGE_PIPELINE_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--save"], field: "save" },
	{ flags: ["--reconverge"], field: "reconverge" },
];

// ── zk-ingest — convergence-loop tuning: ingest/heal/probe switches ────────
const KCARD_LOOP_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--wiki-aware"], field: "wikiAware" },
	{ flags: ["--heal-only"], field: "healOnly" },
	{ flags: ["--no-probe"], field: "noProbe" },
];

// ── research-tool (collect-videos / news) ───────────────────────────────────
const RESEARCH_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--popular"], field: "popular" },
	{ flags: ["--overwrite"], field: "overwrite" }, // news: regenerate a filled issue's scaffold
];

// ── memory-to-vault — post-build verification ───────────────────────────────
const MEMORY_TO_VAULT_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--verify"], field: "verify" },
];

// ── meta commands (tools-metrics / agent-trends) — mode switches ─────────────
const META_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--details"], field: "details" }, // tools-metrics: latency detail columns
	{ flags: ["--schema-cost"], field: "schemaCost" }, // tools-metrics: schema-cost mode
	{ flags: ["--all"], field: "all" }, // agent-trends: scan every project
];

// ── bench-agent — dry self-test ─────────────────────────────────────────────
const BENCH_BOOL_FLAGS: readonly BoolFlagSpec[] = [
	{ flags: ["--dry"], field: "dry" }, // fixtures + gates only, canned outputs, zero LLM calls
];

/** All boolean flags (merged). */
export const BOOLEAN_FLAGS: readonly BoolFlagSpec[] = [
	...MEMORY_TO_VAULT_BOOL_FLAGS,
	...RESOURCE_BOOL_FLAGS,
	...GLOBAL_BOOL_FLAGS,
	...VAULT_BOOL_FLAGS,
	...ZK_ASK_BOOL_FLAGS,
	...ZK_CARD_BOOL_FLAGS,
	...PDF_BOOL_FLAGS,
	...ZK_QUERY_BOOL_FLAGS,
	...KNOWLEDGE_PIPELINE_BOOL_FLAGS,
	...RESEARCH_BOOL_FLAGS,
	...KCARD_LOOP_BOOL_FLAGS,
	...META_BOOL_FLAGS,
	...BENCH_BOOL_FLAGS,
];

/** Ignored boolean flags (pi-compat no-ops; self-trusted / extensions baked in). */
export const IGNORED_BOOL_FLAGS: ReadonlySet<string> = new Set([
	"-a",
	"--approve",
	"-ne",
	"--no-extensions",
]);
