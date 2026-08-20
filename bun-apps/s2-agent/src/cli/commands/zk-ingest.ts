/**
 * `zk-ingest <jsonl-files...>` — deterministically converge structured
 * .knowledge.jsonl records into the shared Zettelkasten vault.
 *
 * Unlike zk-extract (which drives an LLM subagent to decompose free-form
 * markdown), zk-ingest is a pure deterministic pass: it maps each record 1:1
 * onto a zettel card, dedup'd by canonical record id, cross-linked by shared
 * tags, and indexed by a Knowledge Graph MOC. No model, no network — so it is
 * safe to call from a self-improve workflow's extractKnowledge step without
 * spending GPU or risking LLM drift.
 *
 * Flags:
 *   <jsonl-files...>       one or more .knowledge.jsonl files (records per line)
 *   --source <family>      workflow-jsonl | hermes | auto-memory | generic (default workflow-jsonl)
 *   --source-label <text>  provenance string (default '<source>:<first file basename>')
 *   --folder <name>        convergence folder (default Zettelkasten/knowledge-graph)
 *   --vault <path>         absolute vault path
 *   --vault-dir <name>     vault folder under cwd (default vault)
 *   --dry-run              report only, write nothing
 *   --link-weighting <mode> count | idf (default count). IDF weights cross-links
 *                          by tag rarity (P8, SAG-inspired).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { ingestRecords, formatSummary } from "@repo/s2-agent-ext-knowledge-card/src/ingest.ts";
import {
	parseKnowledgeJsonl,
	adaptGenericMarkdown,
	adaptAutoMemoryMarkdown,
	adaptHermesMarkdown,
} from "@repo/s2-agent-ext-knowledge-card/src/adapters.ts";
import type { KnowledgeRecord, SourceFamily } from "@repo/s2-agent-ext-knowledge-card/src/types.ts";

const KNOWN_SOURCES = new Set<SourceFamily>(["workflow-jsonl", "hermes", "auto-memory", "generic"]);

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

export const zkIngestCommand = {
	name: "zk-ingest",
	summary:
		"converge structured .knowledge.jsonl records into the shared knowledge-graph vault",
	details: `Usage:
  s2-agent cli zk-ingest <jsonl-files...> [options]

Inputs:
  One or more .knowledge.jsonl files. Each non-blank line is one record
  (the 12-key schema produced by the self-improve extractKnowledge step).

Options:
  --source <family>        workflow-jsonl | hermes | auto-memory | generic (default workflow-jsonl)
  --source-label <text>    provenance string (default '<source>:<first file basename>')
  --folder <name>          convergence folder (default Zettelkasten/knowledge-graph)
  --vault <path>           absolute vault path (sets OB_VAULT_PATH)
  --vault-dir <name>       vault folder name under cwd (default vault)
  --dry-run                report what would change, write nothing
  --link-weighting <mode>  count | idf (default count). IDF weights cross-links
                           by tag rarity so specific bridges (pi-obsidian)
                           outrank ubiquitous type-tags (pattern) — P8.
                           Also extracts typed entities as additive frontmatter.

Examples:
  s2-agent cli zk-ingest .claude/workflows/pi-infra-self-improve.knowledge.jsonl
  s2-agent cli zk-ingest .claude/workflows/*.knowledge.jsonl --dry-run
  s2-agent cli zk-ingest flux2.jsonl krea2.jsonl --source-label cross-ext`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const files = parsed.positionals;
		if (files.length === 0) {
			throw new Error("No input files. Usage: zk-ingest <jsonl-files...>");
		}
		const source = (parsed.source ?? "workflow-jsonl") as SourceFamily;
		if (!KNOWN_SOURCES.has(source)) {
			throw new Error(
				`Unknown --source '${source}'. Expected one of: ${[...KNOWN_SOURCES].join(", ")}`,
			);
		}
		const sourceLabel =
			parsed.sourceLabel ??
			`${source}:${files[0]!.split("/").pop()!.replace(/\.knowledge\.jsonl$/, "")}`;
		const vaultPath = resolveVaultPath(parsed, cwd);
		process.env.OB_VAULT_PATH = vaultPath;

		const records: KnowledgeRecord[] = [];
		const parseErrors: { line: number; reason: string }[] = [];
		for (const f of files) {
			const abs = isAbsolute(f) ? f : resolve(cwd, f);
			if (!existsSync(abs)) throw new Error(`Input not found: ${f} (resolved: ${abs})`);
			const content = readFileSync(abs, "utf8");
			if (source === "hermes") {
				// hermes inputs are .md memory files with MANY `§`-separated entries
				// (failures/MEMORY/USER) — adapt to one record per entry.
				const recs = adaptHermesMarkdown(content);
				if (recs.length === 0) {
					parseErrors.push({ line: 0, reason: `${f}: no § entries parsed` });
					continue;
				}
				records.push(...recs);
			} else if (source === "auto-memory") {
				// auto-memory inputs are .md topic files (one memory each), not jsonl.
				const rec = adaptAutoMemoryMarkdown(content);
				if (!rec) {
					parseErrors.push({ line: 0, reason: `${f}: not a memory file (no name/description)` });
					continue;
				}
				records.push(rec);
			} else if (source === "generic") {
				// generic inputs are arbitrary .md files (one record each), not jsonl.
				// Mirrors auto-memory's one-per-file shape; the generic adapter makes
				// best-effort cards from any markdown (frontmatter/H1/tags/callouts),
				// yielding a card for any file with title-able or body content.
				const rec = adaptGenericMarkdown(content, abs);
				if (!rec) {
					parseErrors.push({ line: 0, reason: `${f}: empty / no markdown content` });
					continue;
				}
				records.push(rec);
			} else {
				const { records: rs, parseErrors: pe } = parseKnowledgeJsonl(content);
				records.push(...rs);
				for (const e of pe) parseErrors.push({ line: e.line, reason: `${f}: ${e.reason}` });
			}
		}

		console.error(`vault:  ${vaultPath}`);
		console.error(`source: ${source} (${sourceLabel})`);
		console.error(`inputs: ${files.length} file(s), ${records.length} record(s)`);
		if (parsed.dryRun) console.error("(dry-run — no writes)");
		console.error();

		const summary = await ingestRecords(records, {
			vaultPath,
			source,
			sourceLabel,
			folder: parsed.folder,
			dryRun: parsed.dryRun === true,
			linkWeighting: parsed.linkWeighting === "idf" ? "idf" : "count",
		});
		summary.parseErrors.push(...parseErrors);
		console.log(formatSummary(summary));
	},
};
