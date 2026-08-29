/**
 * standalone-shim.ts — build <dist>/ext/ext-standalone.mjs (ext-standalone-import t02).
 *
 * The shim is the dist's OUT-OF-PROCESS consumption surface: one ESM bundle
 * that inlines the full host registry + the real ext-loader semantics, so an
 * external bun script can require() it and drive the shipped ext.cjs tools
 * (see s2-agent src/sh/standalone.ts — the entry — and the effort map D1-D6).
 *
 * Build shape mirrors the core (bun build --target=bun --minify, ESM): in an
 * ESM bun bundle `import.meta.dir` is the bundle's REAL runtime path — the
 * shim self-locates its ext root exactly like the deployed core does —
 * whereas a cjs bundle would fold `__dirname` to build-machine paths (map D4).
 *
 * Caching mirrors the core's `.cores` pattern (core-cache.ts): hash the BUILD
 * INPUTS (src tree + resolved pi-coding-agent version + Bun.version + entry +
 * flags), reuse the cached file, hardlink it into the staging tree. The entry
 * string differs from the core's, so the two never collide in one .cores dir;
 * pruneOrphanCores' nlink accounting covers shim entries identically.
 *
 * Gates (prefix "s", the ext gate family's functions applied to this artifact):
 *   s1  DROPPED by design (map D8): a static-specifier regex scan over a
 *       bundle that inlines pi-coding-agent drowns in string-literal false
 *       positives (`'import … from "typebox/schema"'` doc templates, error
 *       messages naming "undici"). The CORE bundle is not specifier-gated
 *       for the same reason. The s2 import probe is the stronger proof: it
 *       resolves every STATIC import for real, from the staged location,
 *       where no node_modules exists.
 *   s1b scanUnroutableDynamicImports — a bare DYNAMIC import is invisible to
 *       s2 (it may sit in a lazy branch), so it is still scanned; the only
 *       allow-listed survivors are Bun's native compat modules (verified
 *       2026-08-29: node-fetch/ws/undici all resolve from an EMPTY dir under
 *       bare bun — no node_modules, no cache walk).
 *   s2  import probe — the staged file is actually imported and its contract
 *       (callable loadExt/listExts) asserted. ESM, so this is a real `import`
 *       (the cjs loadProbe's evaluateExtModule does not apply).
 *   s4  scanForeignPaths — no build-machine path may survive (relocatability).
 * Gates run on the STAGED file every deploy — cache hits included — because
 * the text scans are cheap and the file the user gets is what must be clean.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeCoreHash, ensureCachedCore, linkCore } from "./core-cache.ts";
import { scanUnroutableDynamicImports } from "./ext-build.ts";
import { scanBinaryForeignPaths } from "./offline-gate.ts";

/** The shim's name inside the version dir's ext/ root (sibling of the ext dirs). */
export const STANDALONE_SHIM_FILENAME = "ext-standalone.mjs";

/** Same depth spelling as ext-build.ts's PI_AGENT_DIR (src/deploy/lib → bun-apps). */
const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "..", "..", "s2-agent");

/** The shim's source entry, relative to the s2-agent package dir. */
const STANDALONE_ENTRY = "src/sh/standalone.ts";

const SHIM_FLAGS = ["--target=bun", "--minify"];

export interface StandaloneShimResult {
	bytes: number;
	cached: boolean;
}

/**
 * Bun ships these as NATIVE compat modules — a dynamic import of one resolves
 * on any bun with zero node_modules (measured 2026-08-29 from an empty dir).
 * Everything else left as a bare dynamic import cannot resolve beside the
 * shim and fails gate s1b.
 */
const BUN_NATIVE_COMPAT = ["node-fetch", "ws", "undici"];

/** Gate s1b body — a bare dynamic import outside the native set cannot resolve beside the bundle. */
function gateDynamicImports(code: string): void {
	const unroutable = scanUnroutableDynamicImports(code).filter((spec) => !BUN_NATIVE_COMPAT.includes(spec));
	if (unroutable.length > 0) {
		throw new Error(
			`standalone shim: native dynamic import(s) that cannot resolve beside the bundle: ${unroutable.join(", ")}.`,
		);
	}
}

/**
 * Gate s4 body — the Gate-5b scanner (scanBinaryForeignPaths) with its bun
 * install-cache allowlist, exactly as the production CORE bundle is treated:
 * bun's cjs interop rebinds `var __dirname` of inlined packages (photon-node,
 * measured 2026-08-29 — present in the deployed core too) to the build cache
 * path; those folds are inert strings, allowlisted with a printed warning.
 * A raw scanForeignPaths here would be STRICTER than the core's own gate and
 * false-red on the same bytes the core ships.
 */
function gateForeignPaths(shimPath: string, deployRoot: string): void {
	const r = scanBinaryForeignPaths(shimPath, deployRoot);
	if (r.foreign.length > 0) {
		throw new Error(
			`standalone shim: bundle bakes in build-machine path(s): ${r.foreign.slice(0, 5).join(", ")} — the tree must be relocatable.`,
		);
	}
	if (r.allowed.length > 0) {
		process.stderr.write(
			`standalone shim: allowlisted baked cache path(s) (inert, same class as the core bundle): ${r.allowed.length}\n`,
		);
	}
}

/**
 * The gates over a STAGED shim file (s1b/s4), composed. Exported for unit
 * tests — the poisoned-fixture acceptance lives here, not only inside a full
 * build. (Static specifiers are NOT scanned — see the s1 DROPPED note, map D8.)
 */
export function gateStandaloneShim(shimPath: string, deployRoot: string): void {
	gateDynamicImports(readFileSync(shimPath, "utf8"));
	gateForeignPaths(shimPath, deployRoot);
}

/**
 * Gate s2 — import the staged shim and assert the consumption contract. The
 * entry is side-effect-free by design (its header contract), so importing it
 * in the deploy process is safe; the path is unique per staging dir, so ESM's
 * path-keyed import cache cannot hand us a stale probe.
 */
export async function probeStandaloneShimImport(shimPath: string): Promise<void> {
	// pathToFileURL, never the bare path: a win32 `C:\…` absolute path is not a
	// valid import specifier (the same lesson as run.ts's resolvePiPkgDir).
	const exports = (await import(pathToFileURL(shimPath).href)) as Record<string, unknown>;
	for (const name of ["loadExt", "listExts"]) {
		if (typeof exports[name] !== "function") {
			throw new Error(`${shimPath}: shim does not export a callable ${name}()`);
		}
	}
}

async function bundleShim(target: string): Promise<void> {
	const p = Bun.spawn(
		["bun", "build", join(PI_AGENT_DIR, STANDALONE_ENTRY), `--outfile=${target}`, ...SHIM_FLAGS],
		{ stdout: "pipe", stderr: "inherit", cwd: PI_AGENT_DIR },
	);
	// Same discipline as buildCore: bun's build report is human progress, and
	// deploy-cli promises stdout is pure JSON — re-emit the child's report on stderr.
	const report = new Response(p.stdout)
		.text()
		.then((t) => {
			if (t) process.stderr.write(t);
		});
	const code = await p.exited;
	await report;
	if (code !== 0) throw new Error(`bun build failed for the standalone shim (exit ${code})`);
}

/**
 * Build (or cache-hit) the standalone shim into `outFile` and gate it.
 * Mirrors buildCore's freeze/non-freeze split: freeze goes through .cores,
 * non-freeze builds a private copy (hardlinks share an inode with the cache).
 */
export async function buildStandaloneShim(opts: {
	/** Destination: <stage>/ext/ext-standalone.mjs. */
	outFile: string;
	/** The deploy outRoot owning the .cores cache. */
	outRoot: string;
	freeze: boolean;
	/** The staging tree root — Gate s4's deploy-tree exemption base. */
	deployRoot: string;
	/** Per-gate timing callback (deploy report gate matrix). */
	onGate?: (id: string, ms: number) => void;
}): Promise<StandaloneShimResult> {
	const timed = async (id: string, run: () => Promise<void> | void): Promise<void> => {
		const t0 = performance.now();
		await run();
		opts.onGate?.(id, performance.now() - t0);
	};

	let cached = false;
	// The caller names the destination; guaranteeing its parent is ours (the
	// deploy pre-creates <stage>/ext, but the cache-hit link below must not
	// depend on that ordering).
	mkdirSync(resolve(opts.outFile, ".."), { recursive: true });
	if (opts.freeze) {
		const piPkgVersion = (
			JSON.parse(
				readFileSync(Bun.resolveSync("@earendil-works/pi-coding-agent/package.json", PI_AGENT_DIR), "utf8"),
			) as { version: string }
		).version;
		const hash = computeCoreHash({
			piAgentDir: PI_AGENT_DIR,
			piPkgVersion,
			bunVersion: Bun.version,
			entry: STANDALONE_ENTRY,
			flags: SHIM_FLAGS,
		});
		const entry = await ensureCachedCore({
			outRoot: opts.outRoot,
			hash,
			build: async (target) => {
				await bundleShim(target);
			},
		});
		cached = entry.cached;
		linkCore(entry.cacheFile, opts.outFile);
	} else {
		await bundleShim(opts.outFile);
	}

	const code = readFileSync(opts.outFile, "utf8");
	await timed("s1b", () => gateDynamicImports(code));
	await timed("s4", () => gateForeignPaths(opts.outFile, opts.deployRoot));
	await timed("s2", () => probeStandaloneShimImport(opts.outFile));

	return { bytes: statSync(opts.outFile).size, cached };
}
