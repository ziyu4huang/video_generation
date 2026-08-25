/**
 * `pipeline-gate` — mechanical handoff-contract checks for the develop-pipeline
 * v2 tier system (spec: .planning/2026-08-20-develop-pipeline-v2/spec.md §4).
 * Pure text scanning, no LLM, no network. Checks by declared tier:
 *
 *   tier-match     declared tier vs mechanical size of the change (all tiers)
 *   map-frozen     map.md "## Not yet specified" block has no open lines (T2/T3)
 *   spec-settled   spec.md has no unchecked decisions / open section (T2/T3)
 *   tickets-runnable  every task has Run: and Expected: markers (T2/T3)
 *   ledger-complete dispatch ledger exists with outcome+sha rows (T2/T3, close only)
 *
 * Phases: `--phase entry` (pre-execution bootstrap: everything above EXCEPT
 * ledger-complete — the ledger only exists after the Report phase) and
 * `--phase close` (default: all five). Without the entry phase the gate
 * dead-locks a fresh effort: it demands a ledger that execution has not yet
 * produced.
 *
 * Red output names the broken contract, the stage to return to, and what to
 * backfill ("fog flows left"). Exits 0 green / 1 red / 2 usage.
 */
import { readFileSync, readdirSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { gitLines } from "../git.ts";
import { findRepoRoot } from "../../paths.ts";

export type Tier = "T1" | "T2" | "T3";

export interface GateCheck {
	name: string;
	pass: boolean;
	detail: string;
	/** What to do when red — names the stage to return to. */
	remedy: string;
}

/** `tier: T<n>` from map.md frontmatter; null when absent. */
export function parseTierFromMap(mapText: string): Tier | null {
	// Extract frontmatter (between leading --- and ---)
	const frontmatterMatch = mapText.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return null;
	const frontmatter = frontmatterMatch[1];
	const m = frontmatter.match(/^tier:\s*(T[123])\s*$/m);
	return (m?.[1] as Tier) ?? null;
}

/** Non-comment, non-empty lines under `## Not yet specified` (the wayfind
 * open-Q block convention; `<!-- ... -->` marks a closed block). */
export function countOpenQuestions(mapText: string): number {
	return countSectionLines(mapText, "Not yet specified");
}

/** Unchecked `- [ ]` boxes anywhere + open lines under Not yet specified. */
export function countOpenDecisions(specText: string): number {
	const boxes = (specText.match(/^\s*-\s\[\s\]\s/gm) ?? []).length;
	return boxes + countSectionLines(specText, "Not yet specified");
}

function countSectionLines(text: string, heading: string): number {
	const re = new RegExp(`^##\\s+${heading}\\s*$`, "m");
	const m = text.match(re);
	if (!m || m.index === undefined) return 0;
	const after = text.slice(m.index).split("\n").slice(1);
	let n = 0;
	for (const line of after) {
		if (line.startsWith("## ")) break;
		const t = line.trim();
		if (t.length > 0 && !t.startsWith("<!--")) n++;
	}
	return n;
}

/** Tasks (### Task) vs tasks carrying both Run:/Expected: markers. Fenced
 * code blocks are stripped first (embedded test fixtures legitimately contain
 * example task blocks, some intentionally non-runnable); markers count in
 * either the bold (`**Run:**`) or plain line-start (`Run:`) form — superpowers
 * plans write the plain form in their step lists. */
export function ticketRunExpected(text: string): { tasks: number; missing: number } {
	const stripped = text.split("```").filter((_, i) => i % 2 === 0).join("\n");
	const tasks = stripped.split("\n").filter((l) => /^###\s+Task\b/.test(l)).length;
	const runnable = stripped.split(/^(?=###\s+Task\b)/m).filter(
		(block) =>
			(/\*\*Run:\*\*/.test(block) || /^\s*Run:/m.test(block)) &&
			(/\*\*Expected:\*\*/.test(block) || /^\s*Expected:/m.test(block)),
	).length;
	return { tasks, missing: Math.max(0, tasks - runnable) };
}

/** Get known bun-apps packages from the filesystem (directories under bun-apps/
 * excluding node_modules). Used by classifySize to detect new packages. */
function getKnownPackages(repoRoot: string): Set<string> {
	const bunAppsDir = join(repoRoot, "bun-apps");
	if (!existsSync(bunAppsDir)) return new Set();
	const dirs = readdirSync(bunAppsDir, { withFileTypes: true }) as Dirent[];
	return new Set(
		dirs
			.filter((d) => d.isDirectory() && d.name !== "node_modules")
			.map((d) => `bun-apps/${d.name}`),
	);
}

/** Mechanical size rules (spec §1): ≥3 packages or a new bun-apps/<pkg>/
 * directory → T3; ≥4 files, 2 packages, or exports-facing files → T2; else T1. */
export function classifySize(changedFiles: string[], repoRoot: string): Tier {
	const pkgs = new Set(
		changedFiles
			.filter((f) => f.startsWith("bun-apps/"))
			.map((f) => f.split("/").slice(0, 2).join("/")),
	);
	if (pkgs.size >= 3) return "T3";
	const known = getKnownPackages(repoRoot);
	for (const p of pkgs) if (!known.has(p)) return "T3";
	if (pkgs.size === 2) return "T2";
	if (changedFiles.length >= 4) return "T2";
	if (changedFiles.some((f) => /(^|\/)(index|extensions\/[^/]+)\.ts$/.test(f))) return "T2";
	return "T1";
}

const ORDER: Tier[] = ["T1", "T2", "T3"];

export interface GateInput {
	declaredTier: Tier;
	mapText: string;
	specText: string;
	ticketTexts: string[];
	ledgerText: string;
	changedFiles: string[];
	repoRoot: string;
	/** Gate phase: "entry" skips ledger-complete (pre-execution bootstrap),
	 * "close" (default) runs all checks including the ledger. */
	phase?: "entry" | "close";
}

export interface GateResult {
	checks: GateCheck[];
	exitCode: 0 | 1;
}

/** Run all checks for the declared tier. Pure — callers feed file contents.
 * `phase: "entry"` omits ledger-complete: the dispatch ledger is produced by
 * execution (Report phase), so demanding it before execution always fails. */
export function runGate(input: GateInput): GateResult {
	const { declaredTier, mapText, specText, ticketTexts, ledgerText, changedFiles, repoRoot } = input;
	const phase = input.phase ?? "close";
	const checks: GateCheck[] = [];

	const size = classifySize(changedFiles, repoRoot);
	checks.push({
		name: "tier-match",
		pass: ORDER.indexOf(size) <= ORDER.indexOf(declaredTier),
		detail: `declared ${declaredTier}, mechanical size ${size} over ${changedFiles.length} files`,
		remedy: "re-tier the effort: bump the map.md frontmatter tier and backfill the left-side artifacts that tier requires",
	});

	if (declaredTier !== "T1") {
		const openQ = countOpenQuestions(mapText);
		checks.push({
			name: "map-frozen",
			pass: openQ === 0,
			detail: `${openQ} open question(s) in map.md`,
			remedy: "return to wayfind grill — resolve the open Qs before executing past them",
		});
		const openD = countOpenDecisions(specText);
		checks.push({
			name: "spec-settled",
			pass: openD === 0,
			detail: `${openD} open decision(s) in spec.md`,
			remedy: "return to wayfind to-spec — settle every decision before planning",
		});
		const missing = ticketTexts.reduce((n, t) => n + ticketRunExpected(t).missing, 0);
		checks.push({
			name: "tickets-runnable",
			pass: missing === 0,
			detail: `${missing} task(s) missing Run:/Expected: markers`,
			remedy: "return to superpowers writing-plans — every task needs a Run: and an Expected:",
		});
		if (phase === "close") {
			const ledgerRows = ledgerText.split("\n").filter((l) => /^\|/.test(l) && /\b(green|red|budget-dead|skipped)\b/.test(l));
			const badRows = ledgerRows.filter((l) => !/[0-9a-f]{7,40}/.test(l));
			checks.push({
				name: "ledger-complete",
				pass: ledgerRows.length > 0 && badRows.length === 0,
				detail: `${ledgerRows.length} ledger row(s), ${badRows.length} missing outcome or SHA`,
				remedy: "finish the dispatch ledger (workflow Report phase) — every row needs an outcome and a commit SHA",
			});
		}
	}

	return { checks, exitCode: checks.every((c) => c.pass) ? 0 : 1 };
}

function readOr(path: string, fallback: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return fallback;
	}
}

function changedFilesSinceBase(repoRoot: string): { files: string[]; error: string | null } {
	// gitLines returns null on any failure (round-2 ticket 05) — the gate rows
	// keep distinguishing "git error" from "no changed files".
	// Get committed files
	const committed = gitLines(repoRoot, ["diff", "--name-only", "origin/main...HEAD"]);
	if (committed === null) {
		return { files: [], error: "git error" };
	}

	// Get uncommitted files (working tree)
	const porcelain = gitLines(repoRoot, ["status", "--porcelain"]);
	if (porcelain === null) {
		return { files: [], error: "git status error" };
	}

	// Parse porcelain output: XY filename
	// X = staged, Y = unstaged. We want any file that's modified (M), added (A), etc.
	const uncommitted = porcelain
		.map((line) => {
			const parts = line.split(/\s+/);
			return parts[parts.length - 1]; // Last part is the filename
		})
		.filter(Boolean);

	// Merge and dedupe
	return { files: Array.from(new Set([...committed, ...uncommitted])), error: null };
}

/** Ticket/plan texts for an effort dir — globs both tickets/*.md and plans/*.md
 * (superpowers plan files carry the same ### Task + Run:/Expected: markers),
 * deduped. Missing dirs contribute nothing. */
export function readTicketTexts(effortDir: string): string[] {
	return Array.from(
		new Set([
			...new Bun.Glob("tickets/*.md").scanSync({ cwd: effortDir }),
			...new Bun.Glob("plans/*.md").scanSync({ cwd: effortDir }),
		]),
	).map((f) => readOr(join(effortDir, f), ""));
}

async function run(repoRoot: string, parsed: import("../args.ts").ParsedArgs): Promise<void> {
	const effort = parsed.effort;
	const tierArg = parsed.tier;
	if (!effort && !tierArg) {
		console.log("usage: s2-agent cli pipeline-gate --effort <name> [--phase entry|close] [--tier T1]   (T1: --tier replaces the missing map.md declaration)");
		process.exitCode = 2;
		return;
	}
	// Validate tierArg against allowed values
	if (tierArg && !["T1", "T2", "T3"].includes(tierArg)) {
		console.log("usage: --tier must be T1, T2, or T3");
		process.exitCode = 2;
		return;
	}
	const phaseArg = parsed.phase ?? "close";
	if (phaseArg !== "entry" && phaseArg !== "close") {
		console.log("usage: --phase must be entry or close");
		process.exitCode = 2;
		return;
	}
	const effortDir = effort ? join(repoRoot, ".planning", effort) : "";
	const declaredTier = (tierArg as Tier)
		?? parseTierFromMap(readOr(join(effortDir, "map.md"), ""));
	if (!declaredTier) {
		console.log("pipeline-gate: no tier declaration found (map.md frontmatter or --tier)");
		process.exitCode = 2;
		return;
	}
	// Tickets can live under tickets/ (ticket dispatch) or plans/ (superpowers
	// plan files with ### Task blocks) — readTicketTexts scans both, deduped.
	const tickets = effort ? readTicketTexts(effortDir) : [];
	const filesResult = changedFilesSinceBase(repoRoot);
	if (filesResult.error) {
		console.log("RED pipeline-gate: cannot determine change size (git error)");
		process.exitCode = 1;
		return;
	}

	const result = runGate({
		declaredTier,
		mapText: effort ? readOr(join(effortDir, "map.md"), "") : "",
		specText: effort ? readOr(join(effortDir, "spec.md"), "") : "",
		ticketTexts: tickets,
		ledgerText: effort ? readOr(join(effortDir, "dispatch-ledger.md"), "") : "",
		changedFiles: filesResult.files,
		repoRoot,
		phase: phaseArg,
	});
	for (const c of result.checks) {
		console.log(`${c.pass ? "PASS" : "RED "} ${c.name}: ${c.detail}`);
		if (!c.pass) console.log(`      -> ${c.remedy}`);
	}
	process.exitCode = result.exitCode;
}

export const pipelineGateCommand = {
	name: "pipeline-gate",
	summary: "mechanical tier/handoff-contract checks (pipeline v2)",
	details: `Usage:
  s2-agent cli pipeline-gate --effort <name> [--phase entry|close]
  s2-agent cli pipeline-gate --tier T1

Checks the develop-pipeline v2 handoff contracts for an effort: tier
declaration vs mechanical change size (anti-drift), map.md frozen, spec
settled, every ticket/plan task has Run:/Expected:, dispatch ledger
complete. Tickets are scanned under both tickets/ and plans/. Phases:
--phase entry runs everything except ledger-complete (the pre-execution
bootstrap gate — the ledger only exists after the Report phase);
--phase close (default) runs all checks. Pure text scanning, no LLM.
Exits 0 green, 1 red (with the stage to return to), 2 usage error. T1
efforts have no effort folder — pass --tier T1 explicitly.`,
	run: async (parsed: import("../args.ts").ParsedArgs) => {
		await run(findRepoRoot(import.meta.dir) ?? import.meta.dir, parsed);
	},
};
