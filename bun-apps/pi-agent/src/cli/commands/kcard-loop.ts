/**
 * `kcard-loop <sources...>` — the headless knowledge-card CONVERGENCE LOOP.
 *
 * Wraps `runConvergenceLoop` from `@repo/pi-agent-ext-knowledge-card/src/loop.ts`
 * (the deterministic core both this CLI and the `kcard-converge-loop` saved
 * workflow use). Ingests the given sources → heals the graph until stable →
 * (optional) recall probe → emits a receipt. No LLM, no subagent — safe to call
 * from a self-improve workflow's shell-out or a cron job.
 *
 * Sources: each positional is either `<family>:<path>` (mixed sources in one
 * invocation) or a bare path (uses `--source` as the family for all of them).
 * `<family>` ∈ workflow-jsonl | hermes | auto-memory | generic.
 *
 * Flags:
 *   <sources...>              files/dirs to converge (family:path OR bare path)
 *   --source <family>         default family for bare positionals (workflow-jsonl)
 *   --vault <path>            absolute vault path
 *   --vault-dir <name>        vault folder under cwd (default vault)
 *   --folder <name>           convergence folder (default Zettelkasten/knowledge-graph)
 *   --max-rounds <n>          max heal rounds (default 8)
 *   --consecutive-empty <n>   no-progress rounds before stopping (default 2)
 *   --max-links <n>           max cross-link neighbours per card (default 20)
 *   --link-weighting <mode>   count | idf (default count)
 *   --wiki-aware              upsert into existing canonical cards on high similarity
 *   --probe-eval <path>       recall probe set ({queries:[{q,expect}]}) — opt-in
 *   --no-probe                skip the probe (ignored if no --probe-eval given)
 *   --heal-only               skip ingest; heal + probe only
 *   --dry-run                 report only (ingest dry-run), write nothing
 *   --json                    emit the receipt as JSON
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import {
	runConvergenceLoop,
	type ConvergeReceipt,
	type SourceInput,
	type ProbeQuery,
} from "@repo/pi-agent-ext-knowledge-card/src/loop.ts";
import type { SourceFamily } from "@repo/pi-agent-ext-knowledge-card/src/ingest.ts";

const KNOWN_FAMILIES: ReadonlySet<SourceFamily> = new Set([
	"workflow-jsonl",
	"hermes",
	"auto-memory",
	"generic",
]);

function resolveVaultPath(parsed: ParsedArgs, cwd: string): string {
	const explicit = parsed.vault ?? process.env.OB_VAULT_PATH;
	if (explicit) {
		const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
		return abs;
	}
	const dir = parsed.vaultDir ?? process.env.OB_VAULT_DIR ?? "vault";
	const abs = resolve(cwd, dir);
	if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
	return abs;
}

/**
 * Parse positionals into typed sources. Each positional may be `<family>:<path>`
 * (mixed families) or a bare path (uses `defaultFamily`). Returns [] if a
 * `--heal-only` run has no positional sources.
 */
function parseSources(parsed: ParsedArgs, cwd: string, defaultFamily: SourceFamily): SourceInput[] {
	const out: SourceInput[] = [];
	for (const raw of parsed.positionals) {
		const colon = raw.indexOf(":");
		// Only treat a leading `<known-family>:` prefix as a family split — paths
		// with a colon later (rare) are left intact.
		if (colon > 0) {
			const maybeFamily = raw.slice(0, colon) as SourceFamily;
			if (KNOWN_FAMILIES.has(maybeFamily)) {
				const path = raw.slice(colon + 1);
				out.push({ path: isAbsolute(path) ? path : resolve(cwd, path), family: maybeFamily });
				continue;
			}
		}
		out.push({ path: isAbsolute(raw) ? raw : resolve(cwd, raw), family: defaultFamily });
	}
	return out;
}

/** Load the probe eval JSON (`{queries:[{q,expect,...}]}`). Returns [] if absent/empty. */
function loadProbeEval(evalPath: string, cwd: string): ProbeQuery[] {
	const abs = isAbsolute(evalPath) ? evalPath : resolve(cwd, evalPath);
	if (!existsSync(abs)) {
		console.error(`kcard-loop: --probe-eval not found: ${evalPath} (resolved: ${abs}) — probe skipped.`);
		return [];
	}
	try {
		const parsed = JSON.parse(readFileSync(abs, "utf8")) as { queries?: Array<{ q?: string; expect?: string }> };
		return (parsed.queries ?? [])
			.filter((q) => q && typeof q.q === "string" && typeof q.expect === "string")
			.map((q) => ({ q: q.q!, expect: q.expect! }));
	} catch (e) {
		console.error(`kcard-loop: --probe-eval parse failed: ${(e as Error).message} — probe skipped.`);
		return [];
	}
}

/** Human-readable receipt summary (mirrors formatSummary's tone). */
function formatReceipt(r: ConvergeReceipt): string {
	const probe =
		r.probeTotal != null
			? `\n  probe:           ${r.probeHits ?? 0}/${r.probeTotal} hit (${((r.probeHitRate ?? 0) * 100).toFixed(0)}% @ top-4)`
			: "";
	return [
		`kcard-loop receipt`,
		`  sources ingested: ${r.sourcesIngested}`,
		`  cards:            ${r.created} created · ${r.updated} updated · ${r.unchanged} unchanged`,
		`  dead links:       ${r.deadLinksBefore} → ${r.deadLinksAfter}`,
		`  moc missing:      ${r.mocMissingBefore} → ${r.mocMissingAfter}`,
		`  heal rounds:      ${r.rounds}${r.truncated ? " (TRUNCATED at maxRounds)" : ""}`,
		`  converged:        ${r.converged}${probe}`,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Lean projection of the receipt for the `--json` machine path. The full
 * `ConvergeReceipt.health` carries `deadLinks`/`orphans` ARRAYS (file paths)
 * which bloat the JSON (measured 86% of the payload on a 539-card vault with 39
 * orphans) and can blow a shell-capture / small-model parse budget when piped
 * through a workflow agent's Bash. JSON consumers want counts + the scalar
 * fields; the arrays stay available via `zk-query --health` or the library.
 */
export function slimReceiptForJson(r: ConvergeReceipt): Record<string, unknown> {
	return {
		converged: r.converged,
		truncated: r.truncated,
		sourcesIngested: r.sourcesIngested,
		created: r.created,
		updated: r.updated,
		unchanged: r.unchanged,
		deadLinksBefore: r.deadLinksBefore,
		deadLinksAfter: r.deadLinksAfter,
		mocMissingBefore: r.mocMissingBefore,
		mocMissingAfter: r.mocMissingAfter,
		rounds: r.rounds,
		probeHits: r.probeHits,
		probeTotal: r.probeTotal,
		probeHitRate: r.probeHitRate,
		health: {
			ok: r.health.ok,
			cardCount: r.health.cardCount,
			deadLinks: r.health.deadLinks.length,
			mocMissing: r.health.mocMissing,
			mocStale: r.health.mocStale,
			orphans: r.health.orphans.length,
		},
	};
}

/**
 * Pure receipt builder — does NOT touch stdout. Imported by the test suite so we
 * can assert the receipt without capturing console.log.
 */
export async function runConvergenceFromArgs(
	parsed: ParsedArgs,
	cwd = process.cwd(),
): Promise<ConvergeReceipt> {
	const vaultPath = resolveVaultPath(parsed, cwd);
	process.env.OB_VAULT_PATH = vaultPath;

	const defaultFamily = (parsed.source ?? "workflow-jsonl") as SourceFamily;
	if (!KNOWN_FAMILIES.has(defaultFamily)) {
		throw new Error(
			`Unknown --source '${parsed.source}'. Expected one of: ${[...KNOWN_FAMILIES].join(", ")}`,
		);
	}

	const sources = parsed.healOnly ? [] : parseSources(parsed, cwd, defaultFamily);
	if (!parsed.healOnly && sources.length === 0) {
		throw new Error("No sources. Usage: kcard-loop <sources...>  (or pass --heal-only)");
	}

	const probeQueries =
		parsed.noProbe || !parsed.probeEval ? [] : loadProbeEval(parsed.probeEval, cwd);

	const linkWeighting = parsed.linkWeighting === "idf" ? "idf" : "count";

	return runConvergenceLoop({
		sources,
		vaultPath,
		folder: parsed.folder,
		probeQueries,
		maxRounds: parsed.maxRounds,
		consecutiveEmpty: parsed.consecutiveEmpty,
		maxLinks: parsed.maxLinks,
		linkWeighting,
		wikiAware: parsed.wikiAware === true,
	});
}

export const kcardLoopCommand = {
	name: "kcard-loop",
	summary: "converge sources into the knowledge graph: ingest → heal-until-dry → (optional) recall probe",
	details: `Usage:
  pi-agent cli kcard-loop <sources...> [options]
  pi-agent cli kcard-loop --heal-only [options]

Sources:
  Each positional is either "<family>:<path>" (mix families in one run) or a
  bare path (uses --source as the family). <family> ∈
  workflow-jsonl | hermes | auto-memory | generic. Directories expand per family.

Options:
  --source <family>        default family for bare positionals (workflow-jsonl)
  --vault <path>           absolute vault path (sets OB_VAULT_PATH)
  --vault-dir <name>       vault folder name under cwd (default vault)
  --folder <name>          convergence folder (default Zettelkasten/knowledge-graph)
  --max-rounds <n>         max heal rounds (default 8)
  --consecutive-empty <n>  no-progress rounds before stopping (default 2)
  --max-links <n>          max cross-link neighbours per card (default 20)
  --link-weighting <mode>  count | idf (default count). IDF weights cross-links
                           by tag rarity (P8). Also respected by zk-ingest.
  --wiki-aware             upsert into an existing canonical card on high similarity
  --probe-eval <path>      recall probe set ({queries:[{q,expect}]}) — opt-in.
                           scripts/real-retrieval-eval.json is the repo's 50-query set.
  --no-probe               skip the probe (no-op if no --probe-eval given)
  --heal-only              skip ingest; heal + probe only
  --dry-run                report only, write nothing (ingest dry-run)
  --json                   emit the receipt as JSON

Exit code:
  0 if the graph converged (healthy), 1 otherwise.

Examples:
  pi-agent cli kcard-loop workflow-jsonl:a.knowledge.jsonl generic:./md --json
  pi-agent cli kcard-loop *.knowledge.jsonl --probe-eval scripts/real-retrieval-eval.json
  pi-agent cli kcard-loop --heal-only --vault ./vault --probe-eval scripts/real-retrieval-eval.json`,
	async run(parsed: ParsedArgs): Promise<void> {
		const receipt = await runConvergenceFromArgs(parsed);
		if (parsed.json) {
			console.log(JSON.stringify(slimReceiptForJson(receipt), null, 2));
		} else {
			console.error(formatReceipt(receipt));
		}
		if (!receipt.converged) process.exitCode = 1;
	},
};
