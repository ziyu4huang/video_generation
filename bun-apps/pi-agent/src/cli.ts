#!/usr/bin/env bun
/**
 * pi-agent — thin wrapper around the REAL pi TUI with monkey-patch hooks.
 *
 * What this does:
 *   1. Apply env-gated monkey-patches (default: force pi to load models ONLY
 *      from ~/.pi/agent/models.json).
 *   2. Delegate everything else — argv parsing, TUI, print/rpc mode, sessions,
 *      tools — to the official `main()` from @earendil-works/pi-coding-agent.
 *
 * It is NOT a re-implementation of pi. It IS pi, lightly patched.
 *
 * Usage (after `bun install` at the repo root):
 *   bun ./pi-agent/src/cli.ts                 # interactive TUI
 *   bun ./pi-agent/src/cli.ts -p "hello"      # print mode
 *   bun ./pi-agent/src/cli.ts --list-models   # list (only models.json entries)
 *
 * Toggle the model patch:
 *   BUN_PI_ONLY_MODELS_JSON=0 bun ./pi-agent/src/cli.ts --list-models
 *
 * Debug which patches ran:
 *   BUN_PI_DEBUG_PATCHES=1 bun ./pi-agent/src/cli.ts
 */
import { main } from "@earendil-works/pi-coding-agent";
import { applyPatches } from "./patches/index.ts";
import { runDoctor } from "./doctor.ts";

// Read argv once for the doctor intercept (which runs BEFORE patches). NOTE:
// main() must re-slice process.argv AFTER applyPatches() below — the
// load-run-dir-resources patch splices extension/skill paths into process.argv,
// and a slice captured here (a copy) would miss them, silently dropping every
// run-dir extension. (Regression introduced when this slice moved up for the
// doctor intercept; fixed by re-slicing at the main() call.)
const argv = process.argv.slice(2);

// `doctor` self-check: intercept BEFORE patches/main so the diagnostic runs
// even when patches/deploys are broken. `bun src/cli.ts doctor [--json]` or
// `./run.sh doctor`. Exits 0 (all hard checks pass) or 1 (any fail).
if (argv[0] === "doctor" || argv.includes("--doctor")) {
	// `--smoke`: opt-in runtime check that actually spawns a probe and verifies
	// run-dir extensions load (catches the silent-no-op class the static checks
	// miss). Default doctor stays pure/offline/fast.
	// `--fix`: opt-in auto-remediate (runs `bun install` for unresolvable host
	// deps in a portable/release deploy), then re-checks.
	const report = await runDoctor({
		json: argv.includes("--json"),
		fix: argv.includes("--fix"),
		smoke: argv.includes("--smoke"),
	});
	process.exit(report.ok ? 0 : 1);
}

// Patches MUST be applied before main() constructs ModelRegistry. Among other
// things, this splices run-dir/ extension + skill paths into process.argv.
await applyPatches();

// Re-slice AFTER patches so the run-dir splice (and any other process.argv
// mutation above) reaches main(). main(args) consumes the passed array
// directly — it does NOT re-read process.argv.
await main(process.argv.slice(2));
