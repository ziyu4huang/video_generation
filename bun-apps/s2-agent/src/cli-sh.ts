#!/usr/bin/env bun
/**
 * cli-sh.ts — the sh-mode entry point: a MINIMAL s2-agent core.
 *
 * Differences from src/cli.ts (the source-mode entry):
 *   • It does NOT import src/static-extensions.ts. Zero extensions are
 *     compiled in; every extension is discovered at runtime under
 *     <deployDir>/ext/<name>/ — the dir holding this artifact (compiled
 *     binary or bun-run bundle; see deployRoot below).
 *   • It disables the run-dir resource patch — sh mode owns extension and skill
 *     resolution end to end, and the run-dir resolver's repo-relative view has
 *     no meaning in a versioned deploy dir.
 *
 * Deleting <exeDir>/ext entirely is a supported state: the loader returns empty
 * arrays and pi starts with no extensions.
 */
import "./sh/scrub-inherited-package-dir.ts"; // FIRST — must precede any pi module init
import { main } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { deployRoot } from "./mode.ts";
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
 * The deploy root is the directory holding this artifact. In a compiled
 * binary process.execPath IS the deployed s2-agent; in a bun-run bundle the
 * entry's own import.meta.url IS the bundle's real path (deployRoot handles
 * both). Running this file from source (`bun src/cli-sh.ts`) resolves to
 * src/ — meaningless as a deploy root — so PI_AGENT_SH_EXT_DIR exists as an
 * explicit override for source-mode debugging.
 */
const deployDir = deployRoot(import.meta.url);
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
	console.error(`[s2-agent-sh] skipped extension "${s.name}": ${s.reason}`);
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
		`[s2-agent-sh] \`${which}\` is not part of an sh deploy.\n` +
			`  ${which === "cli" ? "The cli namespace bundles seven extension packages; embedding it would defeat the zero-extension core." : "It reads the repo's run-dir manifest, which a deployed tree does not have."}\n` +
			`  Use \`s2-agent doctor\` here, or run s2-agent from source (bun bun-apps/s2-agent/src/cli.ts) for the full surface.`,
	);
	process.exit(2);
}

await applyPatches();

// Re-slice AFTER patches, same as src/cli.ts does at its own main() call: the
// default-model-env patch splices the built-in default (zai/glm-5.3) into
// process.argv at import time DURING applyPatches(), and main(args) consumes
// only the array it is handed — it does NOT re-read process.argv. The `argv`
// sliced at the top of this file predates the splice (it must: the doctor /
// cli intercepts above judge what the USER typed), so building mainArgv from
// it silently dropped the built-in default and pi's provider-order fallback
// (deepseek precedes zai) picked the wrong model. Regression-tested by
// src/__tests__/cli-sh-main-argv.test.ts.
const mainArgv = process.argv.slice(2);

// Skills are passed the same way pi accepts them everywhere else: absolute
// --skill paths on the argv it parses.
for (const p of loaded.skillPaths) mainArgv.push("--skill", p);

await main(mainArgv, {
	extensionFactories: loaded.factories,
});
