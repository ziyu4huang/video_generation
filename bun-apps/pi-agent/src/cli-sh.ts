#!/usr/bin/env bun
/**
 * cli-sh.ts — the sh-mode entry point: a MINIMAL pi-agent core.
 *
 * Differences from src/cli.ts (which stays the entry for the four legacy
 * deploy modes and for source runs):
 *   • It does NOT import src/static-extensions.ts. Zero extensions are
 *     compiled in; every extension is discovered at runtime under
 *     <exeDir>/ext/<name>/.
 *   • It disables the run-dir resource patch — sh mode owns extension and skill
 *     resolution end to end, and the run-dir resolver's repo-relative view has
 *     no meaning in a versioned deploy dir.
 *
 * Deleting <exeDir>/ext entirely is a supported state: the loader returns empty
 * arrays and pi starts with no extensions.
 */
import { main } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { applyPatches } from "./patches/index.ts";
import { isCliCommand, isDoctorCommand, isExtDoctorCommand, userSuppressFlags } from "./cli-argv.ts";
import { runDoctor } from "./doctor.ts";
import { HOST_API, HOST_MODULE_IDS, hostRequire } from "./sh/host-modules.ts";
import { loadExtensions, type LoadResult } from "./sh/ext-loader.ts";
import { formatExtList } from "./sh/ext-list.ts";

// sh mode resolves its own extensions and skills; the run-dir patch would
// splice build-machine repo paths that do not exist in a deployed tree.
// `??=` so an operator can still force it back on for debugging.
process.env.BUN_PI_LOAD_RUN_DIR ??= "0";

const argv = process.argv.slice(2);

/**
 * The deploy root is the directory holding this executable. In a compiled
 * binary process.execPath IS the deployed pi-agent; running this file from
 * source (`bun src/cli-sh.ts`) would point at bun's own directory instead, so
 * PI_AGENT_SH_EXT_DIR exists as an explicit override for source-mode debugging.
 */
const deployDir = dirname(process.execPath);
const extRoot = process.env.PI_AGENT_SH_EXT_DIR ?? join(deployDir, "ext");

const host = { hostApi: HOST_API, hostModules: HOST_MODULE_IDS };
const suppressed = userSuppressFlags(argv).noExtensions;
const empty: LoadResult = { factories: [], skillPaths: [], loaded: [], skipped: [] };
const loaded = suppressed ? empty : loadExtensions({ extRoot, host, require: hostRequire });

// `--ext-list`: print what was discovered and exit. This is the executable
// proof gate the deploy runs in both states (extensions present / ext removed).
if (argv.includes("--ext-list")) {
	console.log(formatExtList(extRoot, HOST_API, loaded));
	process.exit(0);
}

for (const s of loaded.skipped) {
	console.error(`[pi-agent-sh] skipped extension "${s.name}": ${s.reason}`);
}

// `doctor`: intercepted BEFORE applyPatches() for the same reason src/cli.ts
// does it — the diagnostic has to run when the thing it diagnoses is broken.
// In sh mode it reports mode "sh" and validates the DEPLOYED ext/ tree through
// the same manifest parser the loader uses.
if (isDoctorCommand(argv)) {
	const report = await runDoctor({ json: argv.includes("--json"), smoke: argv.includes("--smoke") });
	process.exit(report.ok ? 0 : 1);
}

// `ext doctor` and `cli <command>` do NOT exist in sh mode, and saying so is the
// whole point of this branch: without it pi's own parser answers
// "Unknown options: --json", which reads like a flag typo rather than a missing
// surface.
//
// They are absent by construction, not by omission. `src/cli/extensions/registry.ts`
// statically imports seven workspace extension packages, so compiling the `cli`
// namespace into this core would compile those extensions in with it — the exact
// opposite of a core that carries none. `ext doctor` reads the repo's run-dir
// manifest, which a deployed tree does not have; `doctor` above covers the same
// ground for the extensions that actually shipped.
if (isExtDoctorCommand(argv) || isCliCommand(argv)) {
	const which = isExtDoctorCommand(argv) ? "ext doctor" : "cli";
	console.error(
		`[pi-agent-sh] \`${which}\` is not part of an sh deploy.\n` +
			`  ${which === "cli" ? "The cli namespace bundles seven extension packages; embedding it would defeat the zero-extension core." : "It reads the repo's run-dir manifest, which a deployed tree does not have."}\n` +
			`  Use \`pi-agent doctor\` here, or one of the legacy deploy modes (bun-apps/pi-agent-ext-devops/scripts/deploy.ts) for the full surface.`,
	);
	process.exit(2);
}

await applyPatches();

// Skills are passed the same way pi accepts them everywhere else: absolute
// --skill paths on the argv it parses.
const mainArgv = [...argv];
for (const p of loaded.skillPaths) mainArgv.push("--skill", p);

await main(mainArgv, {
	extensionFactories: loaded.factories,
});
