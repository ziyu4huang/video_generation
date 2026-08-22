#!/usr/bin/env bun
/**
 * backfill-summaries.mjs — one-shot schema-v2 (D0/D4) migration: stamp
 * `summary:` frontmatter (the L0 abstract) on existing ACTIVE cards in the
 * convergence folder.
 *
 * Deterministic by default (clamped first sentence — same helper the ingest
 * path uses, so backfill and fresh ingest agree byte-for-byte). `--llm` opts
 * into the LLM condense for over-budget bodies (SUMMARY_BODY_BUDGET); offline
 * runs must NOT pass it.
 *
 * Idempotent: a card that already has a non-empty `summary` is skipped, so a
 * second run stamps 0 cards. Receipt written to
 * output/backfill-summaries/receipt-<ISO>.json — including `stamped`, the
 * count that doubles as the expected re-embed burst (the semantic cache
 * fingerprints by mtime; only stamped files get a new mtime).
 *
 * Usage:
 *   bun scripts/backfill-summaries.mjs --vault <vaultRoot> [--folder Zettelkasten/knowledge-graph] [--dry-run] [--llm]
 *
 * Exit 0 on success (including "nothing to do"), 1 on bad args / missing vault.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";
import { cardAnatomy, clampSummary, yamlScalar } from "../src/card-format.ts";
import { condenseSummary, firstSentenceSummary, SUMMARY_BODY_BUDGET } from "../src/extractor.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const vault = opt("--vault");
if (!vault || !existsSync(vault)) {
	console.error("usage: bun scripts/backfill-summaries.mjs --vault <vaultRoot> [--folder <folder>] [--dry-run] [--llm]");
	process.exit(1);
}
const folder = opt("--folder", "Zettelkasten/knowledge-graph");
const dryRun = flag("--dry-run");
const useLlm = flag("--llm");

const dir = join(vault, folder);
if (!existsSync(dir)) {
	console.error(JSON.stringify({ ok: false, error: `folder not found: ${folder}` }));
	process.exit(1);
}

const receipt = {
	task: "backfill-summaries",
	date: new Date().toISOString(),
	vault,
	folder,
	dryRun,
	llm: useLlm,
	total: 0,
	active: 0,
	alreadySummarized: 0,
	stamped: 0,
	skipped: 0,
	/** Files whose mtime changed — the expected semantic re-embed burst size. */
	reEmbedBurst: 0,
	overBudget: 0,
	failures: [],
};

for (const name of readdirSync(dir).sort()) {
	if (!name.endsWith(".md")) continue;
	receipt.total++;
	const abs = join(dir, name);
	let raw;
	try {
		raw = readFileSync(abs, "utf8");
	} catch {
		receipt.failures.push({ file: name, reason: "unreadable" });
		continue;
	}
	const { data } = parseFrontmatter(raw);
	if (!data || !Array.isArray(data.tags)) continue; // not a card
	const status = typeof data.status === "string" ? data.status.trim() : "active";
	if (status !== "active") continue; // superseded/retired cards keep their shape
	receipt.active++;
	if (typeof data.summary === "string" && data.summary.trim()) {
		receipt.alreadySummarized++;
		continue;
	}

	// Abstract material = the 核心想法 body (cardAnatomy), not the H1/section
	// headers — matches what the ingest path summarises. Legacy human-authored
	// notes (English `## Core Idea` headers, no record_type) have no 核心想法
	// section: fall back to the whole body — firstSentenceSummary strips the
	// headings, so the abstract still lands on prose.
	let bodyProse = cardAnatomy(raw).body;
	if (!bodyProse.trim()) {
		// Legacy fallback: whole body minus frontmatter, minus heading LINES
		// (they are labels — "# Title" / "## Core Idea" — not abstract prose).
		bodyProse = raw
			.replace(/^---\n[\s\S]*?\n---/, "")
			.replace(/^#{1,6}\s+.*$/gm, "");
	}
	let summary = firstSentenceSummary(bodyProse);
	if (useLlm && bodyProse.length > SUMMARY_BODY_BUDGET) {
		receipt.overBudget++;
		const condensed = await condenseSummary(bodyProse);
		if (condensed) summary = condensed;
	}
	if (!summary) {
		receipt.skipped++;
		continue;
	}
	summary = clampSummary(summary);

	if (dryRun) {
		receipt.stamped++;
		continue;
	}
	const summaryLine = `summary: ${yamlScalar(summary)}`;
	// Anchor: after `record_type:` when present (zk cards), else just before
	// the closing fence (legacy notes).
	const out = /^summary:.*$/m.test(raw)
		? raw.replace(/^summary:.*$/m, summaryLine)
		: /^record_type:.*$/m.test(raw)
			? raw.replace(/^(record_type:.*)$/m, `$1\n${summaryLine}`)
			: raw.replace(/\n---\n/, `\n${summaryLine}\n---\n`);
	if (out === raw) {
		receipt.skipped++;
		continue;
	}
	const before = statSync(abs).mtimeMs;
	writeFileSync(abs, out, "utf8");
	if (statSync(abs).mtimeMs !== before) receipt.reEmbedBurst++;
	receipt.stamped++;
}

const outDir = "output/backfill-summaries";
if (!dryRun) {
	mkdirSync(outDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	writeFileSync(join(outDir, `receipt-${ts}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify(receipt, null, 2));
