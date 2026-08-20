/**
 * runSchemaCostCheck — schema-cost regression gate (Thrust C, criterion 6).
 *
 * Runs the live schema-cost instrument (`s2-agent cli tools-metrics --schema-cost
 * --json`), compares the aggregate `totalTokens` against a checked-in baseline
 * (`scripts/schema-cost-baseline.json`), and flags inflation > 5%.
 *
 * Per the CI design this is a WARNING, not a block — schema growth is sometimes
 * intentional (a new tool, a richer description). The baseline is the source of
 * truth: a deliberate increase should update the baseline in the same PR via
 *   bun bun-apps/s2-agent/src/cli.ts cli tools-metrics --schema-cost --json \
 *     > scripts/schema-cost-baseline.json
 *
 * Exit semantics (returned as `exitCode`):
 *   0  — baseline held, OR inflation within 5% (warning printed if > 0%), OR the
 *        instrument itself errored on collection (reported but non-fatal here;
 *        the per-tool `errors[]` array is surfaced for visibility).
 *   1  — only on a hard collection failure (the CLI didn't emit parseable JSON).
 *
 * This fn was extracted verbatim from the former standalone script
 * `scripts/check-schema-cost.ts` so `runLocalCi` (src/ci-recipe.ts) can IMPORT it
 * instead of spawning a subprocess — same comparison, same output, same exit
 * semantics. The standalone `scripts/check-schema-cost.ts` remains as a thin
 * argv-parsing shim that forwards here, so the documented `bun scripts/…`
 * invocation (`.github/CI.md`) and manual runs keep working unchanged.
 *
 * Testability: the internal instrument spawn is routed through the injectable
 * `SpawnFn` seam (src/spawn.ts), so this check runs with NO real s2-agent CLI in
 * tests (a recording fake answers the `tools-metrics` call). The default spawn is
 * the live `createLiveSpawn` adapter. A collection failure is reported to stderr
 * and surfaced as `exitCode: 1` — this fn does NOT throw on the realistic
 * failure mode, so `runLocalCi` can treat it as info-only without try/catch.
 */
import { readFileSync } from "node:fs";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";

/** Options for {@link runSchemaCostCheck}. */
export interface SchemaCostCheckOptions {
	/** Absolute repo root — the instrument + baseline resolve under here. */
	repoRoot: string;
	/** Baseline JSON path. Default `${repoRoot}/scripts/schema-cost-baseline.json`. */
	baseline?: string;
	/**
	 * Read "live" data from a JSON file instead of spawning the instrument.
	 * Skips collection entirely (useful for offline / replay / tests).
	 */
	live?: string;
	/** Inflation WARNING threshold, in percent. Default 5. */
	threshold?: number;
	/**
	 * Injectable spawn for the tools-metrics instrument. Default: the live
	 * `createLiveSpawn(repoRoot)` adapter. Tests inject a recording fake.
	 */
	spawn?: SpawnFn;
	/**
	 * Where the human-readable comparison block goes. Default `console.log`
	 * (stdout), which is right for a terminal but WRONG for any caller whose own
	 * stdout is a payload: this function is IMPORTED, not spawned, so its banner
	 * lands in the caller's stdout. That made the devops CLIs emit unparseable
	 * JSON until they started passing a stderr sink here. WARNINGs and collection
	 * errors already go to stderr via console.warn/error and are unaffected.
	 */
	log?: (line: string) => void;
}

/** Result of {@link runSchemaCostCheck}. */
export interface SchemaCostCheckResult {
	/** 0 = within threshold / collection OK; 1 = hard collection failure. */
	exitCode: number;
}

/** JSON.parse against a file path (throws on missing/garbage, like the script did). */
function readJson(path: string): any {
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Run the schema-cost regression check. Prints the comparison block to stdout
 * (and WARNINGs / collection errors to stderr) and returns the exit code. A hard
 * collection failure (non-zero CLI exit OR unparseable stdout) is reported to
 * stderr and returned as `exitCode: 1` — it does NOT throw.
 */
export async function runSchemaCostCheck(opts: SchemaCostCheckOptions): Promise<SchemaCostCheckResult> {
	const root = opts.repoRoot.replace(/\/$/, "");
	const baselinePath = opts.baseline ?? `${root}/scripts/schema-cost-baseline.json`;
	const livePath = opts.live;
	const threshold = opts.threshold ?? 5;
	const log = opts.log ?? ((l: string) => console.log(l));
	const spawn = opts.spawn ?? createLiveSpawn(root);
	const CLI = `${root}/bun-apps/s2-agent/src/cli.ts`;

	/** Spawn the instrument, surface its stderr, parse stdout. Throws on failure. */
	async function collectLive(): Promise<any> {
		const r = await spawn("bun", [CLI, "cli", "tools-metrics", "--schema-cost", "--json"], { cwd: root });
		// Surface the CLI's own stderr — the original script used `stderr: "inherit"`;
		// the SpawnFn captures it, so replay it to keep the diagnostics visible.
		if (r.stderr) process.stderr.write(r.stderr);
		if (r.exitCode !== 0) throw new Error(`schema-cost CLI exited ${r.exitCode}`);
		try {
			return JSON.parse(r.stdout);
		} catch {
			throw new Error(`schema-cost CLI did not emit parseable JSON (exit ${r.exitCode})`);
		}
	}

	// Collect live first. A collection failure short-circuits to exit 1 (the
	// baseline is irrelevant when there is nothing to compare), which also means
	// the collection-failure path never touches the filesystem for the baseline.
	let live: any;
	if (livePath) {
		live = readJson(livePath);
	} else {
		try {
			live = await collectLive();
		} catch (e) {
			console.error(e instanceof Error ? e.message : String(e));
			return { exitCode: 1 };
		}
	}

	const baseline = readJson(baselinePath);
	const baseTotal: number = baseline.totalTokens;
	const liveTotal: number = live.totalTokens;
	const delta = liveTotal - baseTotal;
	const pct = baseTotal > 0 ? (delta / baseTotal) * 100 : 0;
	const over = pct > threshold;

	// Surface any per-tool collection errors for visibility (non-fatal here).
	if (Array.isArray(live.errors) && live.errors.length > 0) {
		console.warn(`⚠ schema-cost collected ${live.errors.length} error(s):`);
		for (const e of live.errors) console.warn(`    - ${e}`);
	}

	log("── schema-cost regression ──────────────────────────────");
	log(`  baseline totalTokens : ${baseTotal}  (${baseline.tools ?? "?"} tools)`);
	log(`  live     totalTokens : ${liveTotal}  (${live.tools ?? "?"} tools)`);
	log(`  delta                : ${delta >= 0 ? "+" : ""}${delta} tokens (${pct.toFixed(2)}%)`);
	log(`  threshold            : +${threshold}% (WARNING only, not a block)`);
	log("───────────────────────────────────────────────────────");

	if (over) {
		console.warn(`⚠ WARNING: aggregate schema cost grew ${pct.toFixed(2)}% (> ${threshold}% threshold).`);
		console.warn("  If intentional, refresh the baseline in this PR:");
		console.warn("    bun bun-apps/s2-agent/src/cli.ts cli tools-metrics --schema-cost --json \\");
		console.warn("      > scripts/schema-cost-baseline.json");
	} else if (delta < 0) {
		log(`✓ schema cost decreased by ${Math.abs(delta)} tokens (baseline still valid).`);
	} else {
		log("✓ schema cost within threshold (baseline held).");
	}

	return { exitCode: 0 };
}
