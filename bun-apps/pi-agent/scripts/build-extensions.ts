/**
 * build-extensions — bundle EVERY manifest extension into a single `.js`
 * loadable via `pi -e <bundle>.js`, for the new bundle-based deploy.
 *
 * Generalizes bun-apps/pi-vlm/scripts/build-bundle.ts: instead of one hardcoded
 * extension it walks run-dir/manifest.json and bundles each entry, defaulting to
 * THIN mode (peer deps external + bare specifiers rewritten to absolute paths)
 * so every extension SHARES one typebox/@earendil-works/* instance via the
 * deployed node_modules. A failing self-verify hard-exits and points at
 * `--full <name>` for the offending extension.
 *
 * WHY THIN (not FULL)
 *   (1) ~270× smaller per extension; (2) multi-extension sharing — all exts
 *   resolve typebox/@earendil-works/* to the SAME absolute path → bun's module
 *   cache dedupes them. FULL inlines a separate copy per extension; (3) version
 *   coherence with the host. Trade-off: baked paths are MACHINE-SPECIFIC, so
 *   rebuild on the deploy host (same machine) — same model as the pi-agent
 *   bundle itself.
 *
 * USAGE
 *   bun scripts/build-extensions.ts                  # bundle all exts THIN
 *   bun scripts/build-extensions.ts --full zai-mcp   # force FULL for one ext
 *   bun scripts/build-extensions.ts --no-verify      # skip self-verify
 *   bun scripts/build-extensions.ts --out-dir <path> # override output dir
 *   bun scripts/build-extensions.ts --force          # ignore the hash cache,
 *                                                    # rebuild every ext unconditionally
 *
 * OUTPUT: <repoRoot>/dist/pi-ext-bundles/<name>.thin.js (or .full.js)
 *
 * HASH CACHE (warm-build skip)
 *   Each successful build writes a `<name>.<thin|full>.hash` sidecar hashed over
 *   the entry's whole package source tree + thin/full flag + THIN_EXTERNALS list
 *   + Bun.version. A warm run whose inputs hash-match skips the build+resolve+
 *   verify stages entirely ("skipped (hash match)"). The OUTDIR is no longer
 *   blanket-wiped — only stale bundles (no matching ext / changed hash) are
 *   removed. `--force` bypasses the cache for the rare false-skip (e.g. a bun
 *   upgrade silently changed codegen — Bun.version is in the hash, so that case
 *   is already covered, but --force is the escape hatch).
 *
 * VERIFY (per extension)
 *   (B) factory test — import() the bundle, invoke default(mockApi), assert it
 *       is a callable factory that runs without throwing. Proves ESM validity +
 *       every baked absolute dep resolves (the THIN correctness gate). Always on
 *       unless --no-verify. Offline, fast. (Tool count is reported, not asserted
 *       — some extensions register on session_start, not synchronously.)
 *   (C) jiti live boot — `bun pi-agent.js -ne -e <bundle> -p "…"`, hard-fail on
 *       a load crash (NameTooLong / failed-to-load — the data-URL wrap a THIN
 *       bundle hits when bare specifiers weren't abs-resolved), soft-warn
 *       otherwise (the -p LLM call may fail for env reasons). The factory test
 *       (B) uses bun's native import() which BYPASSES jiti, so (C) is the only
 *       tier that exercises pi's real loader path. Best-effort.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Anchor module resolution at the WORKSPACE ROOT: bun hoists every dep
// (typebox, @earendil-works/*, @modelcontextprotocol/sdk, …) to
// <repoRoot>/node_modules, but pi-agent itself does NOT depend on typebox
// directly. pi-vlm's build-bundle.ts resolves via its own cwd (pi-vlm has
// typebox as a dep); the generic builder runs from pi-agent/, so it must
// anchor resolution at repoRoot to find the same hoisted deps.
const PI_AGENT_DIR = dirname(import.meta.dir); // bun-apps/pi-agent
const REPO_ROOT = dirname(dirname(PI_AGENT_DIR));
const MANIFEST_PATH = join(PI_AGENT_DIR, "run-dir", "manifest.json");
const PI_AGENT_BUNDLE = join(REPO_ROOT, "dist", "pi-agent", "pi-agent.js");

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
function die(msg: string): never {
	console.error(R(`error: ${msg}`));
	process.exit(1);
}

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.some((a) => a === "-h" || a === "--help")) {
	console.log((await Bun.file(import.meta.path).text()).split("*/")[0].replace(/^\/\*\*?|\*\/?$/gm, "").trim());
	process.exit(0);
}
const NO_VERIFY = argv.includes("--no-verify");
// `--force` — ignore the per-ext hash cache and rebuild unconditionally. Escape
// hatch for a false skip; Bun.version is already in the hash so a bun upgrade
// forces a rebuild anyway, this covers anything else.
const FORCE = argv.includes("--force");
// tier C (jiti live boot) makes a real LLM `-p` call per extension — slow +
// network-dependent. Off by default; the e2e (e2e-extensions.test.ts) covers
// jiti live load more rigorously across cwds. Opt in with --live-verify.
const LIVE_VERIFY = argv.includes("--live-verify");
const outDirIdx = argv.indexOf("--out-dir");
const OUTDIR = outDirIdx >= 0 ? resolve(argv[outDirIdx + 1]) : join(REPO_ROOT, "dist", "pi-ext-bundles");
// `--portable` — FULL-bundle EVERY extension (incl. npm-sourced ones) so the
// result has zero bare specifiers and zero baked repo paths → runs with no
// repo dependency (same machine). Used by `deploy.ts --portable`. Implies FULL
// for all; the per-name `--full <name>` still works for one-off THIN→FULL.
const PORTABLE = argv.includes("--portable");
// `--full <name> [<name> …]` — force FULL for these extension names (last path
// segment without .ts). Everything else bundles THIN.
const fullIdx = argv.indexOf("--full");
const FULL_FOR = new Set<string>(
	fullIdx >= 0 ? argv.slice(fullIdx + 1).filter((a) => !a.startsWith("-")) : [],
);

// ── manifest ────────────────────────────────────────────────────────────────
if (!existsSync(MANIFEST_PATH)) die(`manifest not found: ${MANIFEST_PATH}`);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
	extensions?: string[];
	npmExtensions?: { pkg: string; entry: string }[];
};
// workspace extensions (bun-apps/<rel>) +, in --portable, npm-sourced exts
// resolved from node_modules (so they too become self-contained FULL bundles).
// `pkgDir` (the extension's package root) feeds the hash cache so an edit to a
// sibling source file the entry imports is caught, not just the entry itself.
const exts: { name: string; entry: string; pkgDir: string }[] = [];
for (const rel of manifest.extensions ?? []) {
	const name = basename(rel).replace(/\.ts$/, "");
	const pkgDir = join(REPO_ROOT, "bun-apps", rel.split("/")[0]!);
	exts.push({ name, entry: join(REPO_ROOT, "bun-apps", rel), pkgDir });
}
if (PORTABLE) {
	// These are deps of pi-agent (not the workspace root), so anchor at its pkg.
	// Resolve the package DIR via package.json then join(entry) — mirrors
	// resolve.ts's source-mode npm resolution (subpath resolve hits exports maps).
	const nmRequire = createRequire(join(PI_AGENT_DIR, "package.json"));
	for (const { pkg, entry } of manifest.npmExtensions ?? []) {
		try {
			const pjPath = nmRequire.resolve(`${pkg}/package.json`);
			// Sanitize the scoped name to a flat filename (@juicesharp/x → juicesharp-x)
			// so the outfile isn't a subdir resolve.ts's readdir wouldn't list.
			const name = pkg.replace(/^@/, "").replace(/[\\/]/g, "-");
			exts.push({ name, entry: join(dirname(pjPath), entry), pkgDir: dirname(pjPath) });
		} catch {
			console.error(Y(`· npm ext ${pkg}/${entry} not resolvable in --portable — skipping`));
		}
	}
}
if (exts.length === 0) die("manifest lists no extensions to bundle.");

// Peer deps kept external in THIN mode. Same set as pi-vlm's build-bundle.ts +
// @modelcontextprotocol/sdk (zai-mcp's MCP SDK — kept external so all consumers
// share one instance via the deployed node_modules).
const THIN_EXTERNALS = [
	"typebox",
	"typebox/*",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/*",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-agent-core/*",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-coding-agent/*",
	"@modelcontextprotocol/sdk",
	"@modelcontextprotocol/sdk/*",
];

// node: builtins (bun minify strips the `node:` prefix, so bare forms too) —
// must NOT be rewritten to absolute paths. Covers deep paths like fs/promises
// via isBuiltin() (split on first segment).
const BUILTINS = new Set([
	"fs", "os", "path", "url", "child_process", "http", "https", "crypto", "stream",
	"util", "buffer", "events", "net", "tls", "zlib", "querystring", "string_decoder",
	"assert", "async_hooks", "module", "perf_hooks", "string_decoder", "timers", "worker_threads",
	"process", "tty", "dns", "dgram", "cluster", "readline", "repl", "v8", "vm", "sys",
	"node:process", "node:tty", "node:dns",
]);
function isBuiltin(spec: string): boolean {
	return spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]);
}

function formatSize(bytes: number): string {
	if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
	if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
	return `${bytes} B`;
}

// ── Hash cache helpers ───────────────────────────────────────────────────────
// A build is deterministic given the same bun version + same inputs, so a
// content hash over the INPUTS lets a warm run skip the build entirely. Inputs:
//   • every source file under the entry's package dir (so an edit to a sibling
//     module the entry imports is caught — not just the entry file)
//   • the thin/full flag + THIN_EXTERNALS list (the external config) when thin
//   • the minify config (a constant below) + Bun.version (so a bun upgrade that
//     silently changes codegen forces a rebuild)
const MINIFY_CFG = "whitespace,identifiers,syntax";
// Source globs included in the package hash. Excludes build output, tests,
// type defs, and deps — a change to any of those must NOT force an ext rebuild.
const SOURCE_GLOBS = /\.(ts|mts|cts|js|mjs|cjs|json)$/;

/** Walk a package dir, returning [relpath, content] pairs for source files. */
function collectPackageSources(pkgDir: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const SKIP = new Set(["node_modules", "dist", ".git", "__tests__"]);
	if (!existsSync(pkgDir)) return out;
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (SKIP.has(name)) continue;
				walk(full);
			} else if (st.isFile() && SOURCE_GLOBS.test(name) && !/\.d\.ts$|\.test\.[jt]s$/.test(name)) {
				try {
					out.push([full.slice(pkgDir.length), readFileSync(full, "utf8")]);
				} catch {
					/* unreadable — skip */
				}
			}
		}
	};
	walk(pkgDir);
	return out;
}

/** Hash the inputs that determine an ext bundle's output. Stable across runs. */
function hashExtInputs(opts: { entry: string; pkgDir: string; thin: boolean }): string {
	const h = createHash("sha256");
	h.update(`thin=${opts.thin}\n`);
	h.update(`minify=${MINIFY_CFG}\n`);
	h.update(`bun=${Bun.version}\n`);
	if (opts.thin) h.update(`externals=${THIN_EXTERNALS.join(",")}\n`);
	// entry is inside pkgDir, so it's covered by the tree walk; pin pkgDir identity.
	h.update(`pkgDir=${opts.pkgDir}\n`);
	const sources = collectPackageSources(opts.pkgDir).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	for (const [rel, content] of sources) {
		h.update(`:${rel}\n${content}\n`);
	}
	return h.digest("hex").slice(0, 16);
}

// ── Stage 1: bundle + minify (one extension) ────────────────────────────────
async function stageBundle(opts: { entry: string; outfile: string; thin: boolean }) {
	const { entry, outfile, thin } = opts;
	mkdirSync(dirname(outfile), { recursive: true });
	if (existsSync(outfile)) rmSync(outfile, { recursive: true });
	const { build } = await import("bun");
	const result = await build({
		entrypoints: [entry],
		outdir: dirname(outfile),
		target: "bun",
		format: "esm",
		naming: basename(outfile),
		minify: { whitespace: true, identifiers: true, syntax: true },
		sourcemap: "none",
		splitting: false,
		...(thin ? { external: THIN_EXTERNALS } : {}),
	});
	if (!result.success) {
		for (const l of result.logs) console.error(`    ${l}`);
		throw new Error(`bun build failed for ${entry}`);
	}
}

// ── Stage 1b (thin only): rewrite bare specifiers → absolute file paths ─────
// Lifted from pi-vlm/scripts/build-bundle.ts. THIN leaves typebox/@earendil/* /
// MCP SDK as bare specifiers; jiti (pi's loader) wraps any module with a bare
// specifier in a data:text/javascript;base64 URL that bun rejects with
// NameTooLong. Pre-resolving each bare specifier to its absolute file path at
// build time means the bundle has only abs-path + node: + relative imports →
// jiti loads it natively → no wrapper → no size limit.
// Resolve `spec` as-if-from the extension's own source file (where typebox +
// @earendil-works/* + @modelcontextprotocol/sdk ARE declared deps). bun does NOT
// symlink transitive deps to the workspace root, so anchoring at repoRoot fails
// for typebox (a peer of the extension packages, not a root dep). Anchoring at
// the entry file mirrors pi-vlm's cwd-based resolution.
function makeResolver(entryAbs: string) {
	const r = createRequire(entryAbs);
	return (spec: string): string | null => {
		if (isBuiltin(spec)) return null; // leave builtins
		try {
			return r.resolve(spec);
		} catch {}
		// package main export: bare resolve hits the exports map; go via package.json.
		try {
			const pjPath = r.resolve(`${spec}/package.json`);
			const pj = JSON.parse(readFileSync(pjPath, "utf8"));
			const dir = pjPath.replace(/\/package\.json$/, "");
			const entry = pj.exports?.["."]?.import || pj.exports?.["."] || pj.main || "index.js";
			return `${dir}/${String(entry).replace(/^\.\//, "")}`;
		} catch {}
		return null;
	};
}

function stageResolveExternals(outfile: string, resolveBare: (s: string) => string | null): string[] {
	let code = readFileSync(outfile, "utf8");
	const bare = new Set<string>();
	for (const m of code.matchAll(/(?:from|import\()\s*["']([^"'#.][^"'']*?)["']/g)) {
		bare.add(m[1]);
	}
	const unresolved: string[] = [];
	let resolved = 0;
	for (const spec of [...bare]) {
		const abs = resolveBare(spec);
		if (abs === null) continue; // builtin (isBuiltin) — leave as-is
		if (!abs) {
			unresolved.push(spec);
			continue;
		}
		code = code.replace(
			new RegExp(`(["'])${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g"),
			`"${abs}"`,
		);
		resolved++;
	}
	if (unresolved.length) {
		throw new Error(
			`could not resolve bare specifier(s): ${unresolved.join(", ")} — add to THIN_EXTERNALS or ensure the dep is resolvable from the extension's package`,
		);
	}
	writeFileSync(outfile, code);
	return [...bare].filter((s) => resolveBare(s) !== null);
}

// ── Stage 2 (verify tier B): factory test ───────────────────────────────────
// import() the bundle + invoke default(mockApi). Proves valid loadable ESM +
// every baked absolute dep resolves (thin) + the factory runs. The PRIMARY
// offline correctness gate.
async function liveFactoryTest(
	outfile: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
	let mod: any;
	try {
		mod = await import(pathToFileURL(outfile).href);
	} catch (e: any) {
		return {
			ok: false,
			detail: `import() failed (broken ESM / unresolved abs-path dep): ${String(e?.message || e).slice(0, 200)}`,
		};
	}
	if (typeof mod?.default !== "function") {
		return {
			ok: false,
			detail: `default export is not a factory function (got ${typeof mod?.default})`,
		};
	}
	const tools: any[] = [];
	// A permissive mock: capture registerTool calls, no-op `on`, and return a
	// no-op fn for ANY other ExtensionAPI method (registerCommand, etc.) so a
	// factory that touches secondary surfaces still runs. The point is to prove
	// ESM validity + dep resolution + the factory executes, not to model pi.
	const target = {
		on: () => {}, // session_start handler registration — no-op
		registerTool: (def: any) => tools.push(def),
	};
	const mockApi = new Proxy(target, {
		get(t, prop) {
			if (prop in t) return (t as any)[prop];
			return () => {}; // no-op any other method (registerCommand, …)
		},
	});
	try {
		mod.default(mockApi);
	} catch (e: any) {
		return {
			ok: false,
			detail: `factory threw on invocation (dep load / schema build failed): ${String(e?.message || e).slice(0, 200)}`,
		};
	}
	const names = tools.map((t) => t?.name).filter(Boolean);
	return {
		ok: true,
		detail: `${tools.length} tool(s) registered synchronously (${names.join(",") || "none — maybe on session_start"})`,
	};
}

// ── Stage 2c (verify tier C): jiti live boot ────────────────────────────────
// The only tier exercising pi's jiti loader (bun native import() in tier B
// bypasses it). Catches the data-URL/NameTooLong crash a THIN bundle hits when
// bare specifiers weren't abs-resolved. Hard-fail on a crash signature; the -p
// LLM call may fail for env reasons (soft warn). Best-effort.
async function liveBootTest(
	outfile: string,
): Promise<{ fail?: string; warn?: string; ok?: true; detail: string }> {
	if (!existsSync(PI_AGENT_BUNDLE)) {
		return { warn: true as never, detail: `host bundle not built — run bun scripts/build.ts first` };
	}
	try {
		const proc = Bun.spawn(
			["bun", PI_AGENT_BUNDLE, "-ne", "-e", outfile, "-p", "reply OK"],
			{
				stdout: "pipe",
				stderr: "pipe",
				// Disable the run-dir patch so it doesn't ALSO splice the repo's
				// source extensions (which would double-load and crash with
				// "Tool X conflicts"). We want to load ONLY this bundle in isolation.
				env: { ...process.env, BUN_PI_LOAD_RUN_DIR: "0" },
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const crashSig = /failed to load extension|nametoolong|resolvemessage|resolve error/i;
		if (crashSig.test(stdout + stderr)) {
			return { fail: `live load CRASH (bundle does not load under jiti): ${(stdout + stderr).slice(0, 180)}` };
		}
		if (code !== 0) return { detail: `live load exit ${code} (no crash) — ${stderr.slice(0, 120)}` };
		return { ok: true, detail: `pi-agent booted, bundle loaded under jiti (no crash)` };
	} catch (e: any) {
		return { detail: `live load threw: ${String(e?.message || e).slice(0, 120)}` };
	}
}

async function stageVerify(name: string, outfile: string, thin: boolean) {
	const bytes = Bun.file(outfile).size;
	const failures: string[] = [];
	const warnings: string[] = [];

	// size sanity — the one hard check both modes share. FULL floors low: an ext
	// that barely touches typebox (obsidian/kc use node builtins) is legitimately
	// a small FULL bundle; only typebox+babel-heavy exts reach ~6.8 MB.
	const minBytes = 2_000;
	if (bytes < minBytes) failures.push(`output ${formatSize(bytes)} below ${formatSize(minBytes)} — likely stub/empty`);

	if (thin) {
		// THIN: strict portability gate — every bare specifier must be abs-resolved
		// (else jiti wraps the module in a data:URL → NameTooLong at load).
		const code = readFileSync(outfile, "utf8");
		const bareLeft = [...code.matchAll(/(?:from|import\()\s*["']([^"'#.][^"'']*?)["']/g)]
			.map((m) => m[1])
			.filter((s) => !isBuiltin(s) && !s.startsWith("/"));
		if (bareLeft.length) {
			failures.push(`bare specifier(s) not resolved to abs path: ${[...new Set(bareLeft)].slice(0, 5).join(", ")}`);
		}
		// (B) factory test — THIN bundles are self-contained at the abs-path level,
		// so import() resolves every dep. Hard-fail.
		const factory = await liveFactoryTest(outfile);
		if (!factory.ok) failures.push(`factory: ${factory.detail}`);
		else console.log(`    ${G("✓")} factory: ${factory.detail}`);
	} else {
		// FULL: bun inlines the big shared deps but may LEAVE residuals (node-fetch,
		// ws, native) as bare specifiers resolved at runtime via the host node_modules.
		// So an isolated import() can fail on those residuals — the factory test and
		// bare-specifier scan are NOT reliable gates here. The real gate is the e2e
		// (e2e-extensions DEPLOY-PORTABLE), which runs the FULL bundle with the
		// deployed node_modules. Just sanity-check + report.
		console.log(`    ${D("· FULL bundle — portability validated by the e2e (residual bare specifiers resolve via host node_modules at runtime)")}`);
	}

	// (C) jiti live boot — opt-in (--live-verify). Crash = hard fail, else info.
	if (LIVE_VERIFY) {
		const boot = await liveBootTest(outfile);
		if (boot.fail) failures.push(boot.fail);
		else if (boot.ok) console.log(`    ${G("✓")} ${boot.detail}`);
		else console.log(`    ${Y("·")} ${boot.detail}`);
	}

	for (const w of warnings) console.log(`    ${Y("·")} ${w}`);
	if (failures.length) {
		for (const f of failures) console.error(`    ${R("✗")} ${f}`);
		throw new Error(
			`self-verify FAILED for ${name} (${failures.length}). ` +
				`If it's a hard-to-bundle ext, retry: bun scripts/build-extensions.ts --full ${name}`,
		);
	}
}

// ── Build one extension ─────────────────────────────────────────────────────
// Returns true if the ext was built (or re-verified), false if skipped via the
// hash cache. The hash cache only short-circuits when the bundle AND its .hash
// sidecar both exist and the inputs hash-match — otherwise build fresh and
// (re)write the sidecar after a successful verify.
async function buildOne(spec: { name: string; entry: string; pkgDir: string }): Promise<boolean> {
	const { name, entry, pkgDir } = spec;
	const thin = !PORTABLE && !FULL_FOR.has(name);
	const tag = thin ? "thin" : "full";
	const outfile = join(OUTDIR, `${name}.${tag}.js`);
	const hashFile = join(OUTDIR, `${name}.${tag}.hash`);
	console.log(`${G("▶")} ${name}  ${D(`[${thin ? "THIN" : "FULL"}] ${entry.replace(REPO_ROOT + "/", "")}`)}`);
	if (!existsSync(entry)) throw new Error(`entry not found: ${entry}`);

	// Hash-cache skip: same inputs as last successful build → output is necessarily
	// unchanged (bun's bundling is deterministic per version). Skips build +
	// abs-resolve + verify. --force bypasses; a stale/missing sidecar falls through.
	if (!FORCE) {
		const inputsHash = hashExtInputs({ entry, pkgDir, thin });
		if (existsSync(outfile) && existsSync(hashFile)) {
			const stored = readFileSync(hashFile, "utf8").trim();
			if (stored === inputsHash) {
				console.log(`    ${Y("·")} skipped (hash match)  ${D(formatSize(Bun.file(outfile).size))}`);
				return false;
			}
		}
	}

	await stageBundle({ entry, outfile, thin });
	if (thin) {
		const resolved = stageResolveExternals(outfile, makeResolver(entry));
		console.log(`    ${G("✓")} ${resolved.length} bare specifier(s) abs-resolved`);
	}
	console.log(`    ${G("✓")} ${outfile}  ${D(`(${formatSize(Bun.file(outfile).size)})`)}`);
	if (!NO_VERIFY) await stageVerify(name, outfile, thin);
	// Write the sidecar AFTER verify passed, so a half-built/failed bundle is
	// never marked cache-hot. Re-derive the hash (cheap) rather than capturing
	// it above, so --force (which skipped the derive) still works on the write.
	writeFileSync(hashFile, hashExtInputs({ entry, pkgDir, thin }) + "\n");
	return true;
}

// ── Orchestrate ──────────────────────────────────────────────────────────────
console.log(`${Y("▶ build-extensions")}  ${D(`${exts.length} extension(s) → ${OUTDIR}${PORTABLE ? " [portable FULL]" : ""}`)}`);
mkdirSync(OUTDIR, { recursive: true });
// Stale-entry cleanup: resolve.ts lists every .js in ext-bundles/, so a leftover
// .thin.js next to a .full.js (mode switch) or a renamed/removed ext would
// double-load. Compute the set of expected filenames for THIS run and remove
// any .js/.hash not in it — but DON'T blanket-wipe, or the hash cache is useless.
const expectedFiles = new Set(
	exts.flatMap((spec) => {
		const thin = !PORTABLE && !FULL_FOR.has(spec.name);
		const tag = thin ? "thin" : "full";
		return [`${spec.name}.${tag}.js`, `${spec.name}.${tag}.hash`];
	}),
);
for (const f of readdirSync(OUTDIR)) {
	if (!expectedFiles.has(f)) rmSync(join(OUTDIR, f), { recursive: true, force: true });
}
let failed = 0;
let built = 0;
let skipped = 0;
for (const spec of exts) {
	try {
		const did = await buildOne(spec);
		if (did) built++;
		else skipped++;
	} catch (e: any) {
		console.error(`    ${R("✗")} ${spec.name}: ${String(e?.message || e).slice(0, 200)}`);
		failed++;
	}
}
console.log("");
if (skipped) console.log(D(`  (${built} built, ${skipped} skipped via hash cache)`));
if (failed) {
	console.error(R(`✗ ${failed}/${exts.length} extension(s) failed`));
	console.error(D(`  retry hard-to-bundle exts with --full <name>`));
	process.exit(1);
}
console.log(G(`✓ ${exts.length}/${exts.length} extension(s) bundled → ${OUTDIR}`));
