#!/usr/bin/env bun
/**
 * pi-agent — thin wrapper around the REAL pi TUI with monkey-patch hooks.
 *
 * What this does:
 *   1. Apply env-gated monkey-patches (default: inject the baked PROVIDERS
 *      catalog from src/pre-load-providers.ts into every ModelRuntime, so no
 *      ~/.pi/agent/models.json is required).
 *   2. Delegate everything else — argv parsing, TUI, print/rpc mode, sessions,
 *      tools — to the official `main()` from @earendil-works/pi-coding-agent.
 *
 * It is NOT a re-implementation of pi. It IS pi, lightly patched.
 *
 * Usage (after `bun install` at the repo root):
 *   bun ./pi-agent/src/cli.ts                 # interactive TUI
 *   bun ./pi-agent/src/cli.ts -p "hello"      # print mode
 *   bun ./pi-agent/src/cli.ts --list-models   # list models (baked PROVIDERS + builtins)
 *
 * Toggle the provider-injection patch:
 *   BUN_PI_PRE_LOAD_PROVIDERS=0 bun ./pi-agent/src/cli.ts --list-models
 *
 * Debug which patches ran:
 *   BUN_PI_DEBUG_PATCHES=1 bun ./pi-agent/src/cli.ts
 */
import { main } from "@earendil-works/pi-coding-agent";
import { applyPatches } from "./patches/index.ts";
import { runDoctor } from "./doctor.ts";
import {
	isDoctorCommand,
	isExtDoctorCommand,
	isCliCommand,
	userSuppressFlags,
	overriddenStaticExtensions,
} from "./cli-argv.ts";
import { STATIC_EXTENSION_FACTORIES } from "./static-extensions.ts";

// Extension loading: handled by the `ensure-extension-deps` patch (see
// src/patches/ensure-extension-deps.ts), which creates repo-root node_modules
// symlinks so Bun NATIVELY imports each extension's .ts graph. That makes
// jiti's `try-native` succeed, so jiti never transforms the graph and the
// >4 KB-module bug never fires. Do NOT re-add `JITI_ESM_EVAL_TEMP_FILE` here:
// under jiti 2.7.0 that temp-file path is broken (`Cannot find module
// .../jiti-esm/binary-*.mjs from ''`), and with it unset you just get the
// `NameTooLong` data-URL error instead — both jiti transform paths are dead;
// the only real fix is to avoid transforming (native load).

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
if (isDoctorCommand(argv)) {
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

// `ext doctor`: per-extension health report (loads every manifest extension,
// checks factory + tools/commands/events + cross-extension conflicts). Offline.
if (isExtDoctorCommand(argv)) {
	const { runExtDoctor } = await import("./ext-doctor.ts");
	const report = await runExtDoctor({ json: argv.includes("--json") });
	process.exit(report.ok ? 0 : 1);
}

// `cli <command>`: the non-interactive CLI namespace (agent commands, pipelines,
// `workflow run`, meta). Intercepted HERE, before applyPatches(), on purpose:
// the CLI curates its extension set per command (docs/adr/0001) and must NOT
// inherit the TUI's run-dir argv splice, provider patch, or static factories.
//
// The import is DYNAMIC so the TUI path never evaluates the CLI subtree — that
// subtree statically pulls flux2/krea2/ltx/movie-director through each
// extension's cli-subcommand.ts, which would otherwise land in every TUI boot.
if (isCliCommand(argv)) {
	try {
		const { runCli } = await import("./cli/dispatch.ts");
		process.exit(await runCli(argv.slice(1)));
	} catch (e: any) {
		// A throw at module-eval time in the CLI subtree lands here rather than
		// as a raw uncaught rejection, so the CLI's error presentation stays
		// uniform whether a command fails or its module fails to load.
		console.error(`error: ${e?.message ?? String(e)}`);
		process.exit(1);
	}
}

// Patches MUST be applied before main() constructs ModelRegistry. Among other
// things, this splices run-dir/ extension + skill paths into process.argv.
await applyPatches();

// Re-slice AFTER patches so the run-dir splice (and any other process.argv
// mutation above) reaches main(). main(args) consumes the passed array
// directly — it does NOT re-read process.argv.
//
// `argv` was sliced BEFORE applyPatches(), so this reflects only what the USER
// typed — the deploy modes' self-injected "-ne" (spliced during applyPatches)
// can't turn the static factories off. Upstream pi never gates
// extensionFactories on -ne (resource-loader loads them unconditionally), so
// this gate is what makes `pi-agent -ne` actually mean "no injected extensions".
//
// A user `-e` path pointing into a static package's dir overrides the baked-in
// factory (see overriddenStaticExtensions) — otherwise the two copies register
// the same tool names and extension loading crashes with `Tool conflicts`.
const userNoExtensions = userSuppressFlags(argv).noExtensions;
const overridden = overriddenStaticExtensions(
	argv,
	STATIC_EXTENSION_FACTORIES.map((f) => f.name),
);
const factories = userNoExtensions
	? []
	: STATIC_EXTENSION_FACTORIES.filter((f) => !overridden.has(f.name));
if (!userNoExtensions && overridden.size > 0) {
	console.error(`[pi-agent] static extension(s) overridden by user -e: ${[...overridden].join(", ")}`);
}
await main(process.argv.slice(2), {
	extensionFactories: factories,
});
