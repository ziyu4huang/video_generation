#!/usr/bin/env bun
/**
 * check-schema-cost — CLI entry point for the schema-cost regression gate.
 *
 * The logic now lives in
 * `bun-apps/s2-agent-ext-devops/src/schema-cost-check.ts` (`runSchemaCostCheck`),
 * which `runLocalCi` (src/ci-recipe.ts) IMPORTs directly (no subprocess spawn).
 * This file remains as a thin argv-parsing shim so the documented
 * `bun scripts/check-schema-cost.ts` invocation (see .github/CI.md) and manual
 * runs keep working unchanged — it parses CLI args and forwards to the fn.
 *
 * Exit codes:
 *   0  — baseline held, OR inflation within threshold, OR the instrument itself
 *        errored on collection (reported but non-fatal).
 *   1  — only on a hard collection failure (the CLI didn't emit parseable JSON).
 *
 * Usage:
 *   bun scripts/check-schema-cost.ts [--baseline <path>] [--threshold <pct>]
 *   bun scripts/check-schema-cost.ts --live <path>   # skip the spawn, compare a file
 */
import { runSchemaCostCheck } from "../bun-apps/s2-agent-ext-devops/src/schema-cost-check.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

function parseArgs(argv: string[]) {
	const out: { baseline?: string; live?: string; threshold?: number } = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--baseline") out.baseline = argv[++i];
		else if (a === "--live") out.live = argv[++i];
		else if (a === "--threshold") out.threshold = Number(argv[++i]);
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const result = await runSchemaCostCheck({
	repoRoot: REPO_ROOT,
	baseline: args.baseline,
	live: args.live,
	threshold: args.threshold,
});
process.exit(result.exitCode);
