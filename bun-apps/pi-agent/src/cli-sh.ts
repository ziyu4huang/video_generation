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
import { userSuppressFlags } from "./cli-argv.ts";
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

await applyPatches();

// Skills are passed the same way pi accepts them everywhere else: absolute
// --skill paths on the argv it parses.
const mainArgv = [...argv];
for (const p of loaded.skillPaths) mainArgv.push("--skill", p);

await main(mainArgv, {
	extensionFactories: loaded.factories,
});
