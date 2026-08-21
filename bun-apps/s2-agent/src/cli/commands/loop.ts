/**
 * `loop status` — report-only self-improvement drift report for the solution
 * extensions (wayfind + superpowers + subagent). Five signals, PASS/DRIFT,
 * ALWAYS exit 0: fixes are gated human/agent actions (#1616 lesson).
 *
 *   1. dispatch death rate — runs-stats census vs #1681 bar (broad < 15%)
 *   2. skill line counts — superpowers + wayfind skills vs 300-line bar
 *   3. duplicate-skill scan — stray dispatch-budget-rebalance refs in skills/
 *   4. schema-cost canary — wayfind/superpowers rows present (0 rows = DRIFT,
 *      the round-2 regression class)
 *   5. wayfind coverage floor — min % Lines across src/ (bun test --coverage)
 *
 * Parsers are exported pure for unit tests; live spawns only in run().
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunsStats {
	total: number;
	done: number;
	turns: number;
	budget: number;
}

/** Parse runs-stats.ts stdout summary rows ("total: 200", "done: n=149 …",
 * "done 126"). Line-start anchored so cohort rows ("cohort x: n=154 done=119 …")
 * don't poison the counts; returns zeros when nothing matches. */
export function parseRunsStats(text: string): RunsStats {
	const out: RunsStats = { total: 0, done: 0, turns: 0, budget: 0 };
	const row = /^\s*(total|done|turns|budget)\b[^0-9]*?(\d+)/i;
	for (const line of text.split("\n")) {
		const m = line.match(row);
		if (!m) continue;
		const n = Number(m[2]);
		const k = m[1].toLowerCase() as keyof RunsStats;
		if (k === "total") out.total = Math.max(out.total, n);
		else {
			out[k] = n;
			out.total = Math.max(out.total, n);
		}
	}
	if (out.total === 0) out.total = out.done + out.turns + out.budget;
	return out;
}

export function broadDeathPct(s: RunsStats): number {
	return s.total === 0 ? 0 : Math.round(((s.turns + s.budget) / s.total) * 1000) / 10;
}

export interface SkillFile {
	path: string;
	lines: number;
}

/** Scan both packages' skills/<name>/SKILL.md files and return them with line counts. */
export function scanSkills(repoRoot: string): SkillFile[] {
	const dirs = [
		join(repoRoot, "bun-apps/s2-agent-ext-superpowers/skills"),
		join(repoRoot, "bun-apps/s2-agent-ext-wayfind/skills"),
	];
	const files: SkillFile[] = [];
	for (const dir of dirs) {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const p = join(dir, name, "SKILL.md");
			try {
				files.push({ path: p.slice(repoRoot.length + 1), lines: readFileSync(p, "utf8").split("\n").length });
			} catch {
				// skill dir without SKILL.md — skip
			}
		}
	}
	return files;
}

/** Min % Lines across wayfind src/ files from `bun test --coverage` table rows
 * like ` src/effort-tool.ts | 90.4 | ...`. Returns null when unparseable. */
export function parseCoverageFloor(text: string): number | null {
	let min = Number.POSITIVE_INFINITY;
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*(src\/[^\s|]+\.ts)\s*\|\s*([\d.]+)/);
		if (m) min = Math.min(min, Number(m[2]));
	}
	return Number.isFinite(min) ? min : null;
}

function row(label: string, drift: boolean, detail: string): string {
	return `${drift ? "DRIFT" : "PASS"}  ${label}: ${detail}`;
}

/** Spawn and capture BOTH streams: bun ≥1.4 routes `bun test` output (incl.
 * the coverage table) to stderr, so a stdout-only capture sees nothing. */
export function run(cwd: string, cmd: string[]): string {
	const r = Bun.spawnSync(cmd, { cwd });
	return `${r.stdout ? r.stdout.toString() : ""}\n${r.stderr ? r.stderr.toString() : ""}`;
}

export async function loopStatus(repoRoot: string, args: string[]): Promise<number> {
	if (args[0] !== "status") {
		console.log("usage: s2-agent.sh loop status   (report-only drift report; always exits 0)");
		return 0;
	}
	const lines: string[] = [];
	// 1. death rate
	const statsText = run(repoRoot, ["bun", "bun-apps/s2-agent-ext-subagent/scripts/runs-stats.ts"]);
	const stats = parseRunsStats(statsText);
	lines.push(
		row(
			"death-rate (broad)",
			broadDeathPct(stats) >= 15 || stats.total < 30,
			`${broadDeathPct(stats)}% of ${stats.total} runs (bar <15%, #1681; <30 runs = too-early)`,
		),
	);
	// 2. skill line counts
	const skills = scanSkills(repoRoot);
	const worst = skills.slice().sort((a, b) => b.lines - a.lines)[0];
	lines.push(
		row("skill-lines", (worst?.lines ?? 0) > 300, `max ${worst?.lines ?? 0} (${worst?.path ?? "none"}) of ${skills.length} skills (bar <=300)`),
	);
	// 3. duplicate-skill scan
	const dupHit = skills.some((s) => s.path.includes("dispatch-budget-rebalance"));
	lines.push(row("duplicate-scan", dupHit, dupHit ? "dispatch-budget-rebalance still present in skills/" : "no dispatch-budget-rebalance skill dir (merged)"));
	// 4. schema-cost canary
	// `schema-cost` is NOT a top-level CLI command — bare `cli.ts schema-cost`
	// falls through to the pi LLM passthrough, and the canary then greps an LLM
	// chat reply for 0 rows (the "0 = canary regression" DRIFT). The real
	// surface is the tools-metrics mode.
	const schema = run(repoRoot, [
		"bun",
		"bun-apps/s2-agent/src/cli.ts",
		"cli",
		"tools-metrics",
		"--schema-cost",
	]);
	const canaryRows = (schema.match(/wayfind|superpowers/gi) ?? []).length;
	lines.push(row("schema-cost-canary", canaryRows === 0, `${canaryRows} rows mention wayfind/superpowers (0 = canary regression)`));
	// 5. wayfind coverage floor
	const cov = run(join(repoRoot, "bun-apps/s2-agent-ext-wayfind"), ["bun", "test", "--coverage"]);
	const floor = parseCoverageFloor(cov);
	lines.push(row("wayfind-coverage-floor", floor === null, floor === null ? "unparseable coverage output" : `min ${floor}% across src/`));
	console.log(lines.join("\n"));
	return 0;
}

export const loopCommand = {
	name: "loop",
	summary: "report-only self-improve drift report",
	details: `Usage:
  s2-agent.sh loop status

Prints five PASS/DRIFT drift signals for the solution extensions (wayfind +
superpowers + subagent): dispatch death rate, skill line counts, duplicate
skill scan, schema-cost canary, wayfind coverage floor. Report-only: ALWAYS
exits 0 — fixes are gated human/agent actions (#1616 lesson).`,
	run: async (parsed: import("../args.ts").ParsedArgs) => {
		await loopStatus(join(import.meta.dir, "../../../../.."), parsed.positionals);
	},
};
