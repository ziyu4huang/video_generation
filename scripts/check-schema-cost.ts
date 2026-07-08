/**
 * check-schema-cost — schema-cost regression gate (Thrust C, criterion 6).
 *
 * Runs the live schema-cost instrument (`pi-agent-cli tools-metrics --schema-cost
 * --json`), compares the aggregate `totalTokens` against a checked-in baseline
 * (`scripts/schema-cost-baseline.json`), and flags inflation > 5%.
 *
 * Per the CI design this is a WARNING, not a block — schema growth is sometimes
 * intentional (a new tool, a richer description). The baseline is the source of
 * truth: a deliberate increase should update the baseline in the same PR via
 *   bun bun-apps/pi-agent-cli/src/cli.ts tools-metrics --schema-cost --json \
 *     > scripts/schema-cost-baseline.json
 *
 * Exit codes:
 *   0  — baseline held, OR inflation within 5% (warning printed if > 0%), OR the
 *        instrument itself errored on collection (reported but non-fatal here;
 *        the per-tool `errors[]` array is surfaced for visibility).
 *   1  — only on a hard collection failure (the CLI didn't emit parseable JSON).
 *
 * Usage:
 *   bun scripts/check-schema-cost.ts [--baseline <path>] [--threshold <pct>]
 *   bun scripts/check-schema-cost.ts --live <path>   # skip the spawn, compare a file
 */
import { readFileSync } from "node:fs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_BASELINE = `${REPO_ROOT}scripts/schema-cost-baseline.json`;
const CLI = `${REPO_ROOT}bun-apps/pi-agent-cli/src/cli.ts`;

function parseArgs(argv: string[]) {
	const out: { baseline: string; live?: string; threshold: number } = {
		baseline: DEFAULT_BASELINE,
		threshold: 5,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--baseline") out.baseline = argv[++i];
		else if (a === "--live") out.live = argv[++i];
		else if (a === "--threshold") out.threshold = Number(argv[++i]);
	}
	return out;
}

function readJson(path: string): any {
	return JSON.parse(readFileSync(path, "utf8"));
}

async function collectLive(): Promise<any> {
	const proc = Bun.spawn(["bun", CLI, "tools-metrics", "--schema-cost", "--json"], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "inherit",
	});
	const stdout = await new Response(proc.stdout).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`schema-cost CLI exited ${code}`);
	try {
		return JSON.parse(stdout);
	} catch (e) {
		throw new Error(`schema-cost CLI did not emit parseable JSON (exit ${code})`);
	}
}

const args = parseArgs(process.argv.slice(2));
const baseline = readJson(args.baseline);
const live = args.live ? readJson(args.live) : await collectLive();

const baseTotal: number = baseline.totalTokens;
const liveTotal: number = live.totalTokens;
const delta = liveTotal - baseTotal;
const pct = baseTotal > 0 ? (delta / baseTotal) * 100 : 0;
const over = pct > args.threshold;

// Surface any per-tool collection errors for visibility (non-fatal here).
if (Array.isArray(live.errors) && live.errors.length > 0) {
	console.warn(`⚠ schema-cost collected ${live.errors.length} error(s):`);
	for (const e of live.errors) console.warn(`    - ${e}`);
}

console.log("── schema-cost regression ──────────────────────────────");
console.log(`  baseline totalTokens : ${baseTotal}  (${baseline.tools ?? "?"} tools)`);
console.log(`  live     totalTokens : ${liveTotal}  (${live.tools ?? "?"} tools)`);
console.log(`  delta                : ${delta >= 0 ? "+" : ""}${delta} tokens (${pct.toFixed(2)}%)`);
console.log(`  threshold            : +${args.threshold}% (WARNING only, not a block)`);
console.log("───────────────────────────────────────────────────────");

if (over) {
	console.warn(
		`⚠ WARNING: aggregate schema cost grew ${pct.toFixed(2)}% (> ${args.threshold}% threshold).`,
	);
	console.warn(
		"  If intentional, refresh the baseline in this PR:",
	);
	console.warn("    bun bun-apps/pi-agent-cli/src/cli.ts tools-metrics --schema-cost --json \\");
	console.warn("      > scripts/schema-cost-baseline.json");
} else if (delta < 0) {
	console.log(`✓ schema cost decreased by ${Math.abs(delta)} tokens (baseline still valid).`);
} else {
	console.log("✓ schema cost within threshold (baseline held).");
}
