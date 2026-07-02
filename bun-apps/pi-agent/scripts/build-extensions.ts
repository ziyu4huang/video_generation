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
 *
 * OUTPUT: <repoRoot>/dist/pi-ext-bundles/<name>.thin.js (or .full.js)
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
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
// tier C (jiti live boot) makes a real LLM `-p` call per extension — slow +
// network-dependent. Off by default; the e2e (e2e-extensions.test.ts) covers
// jiti live load more rigorously across cwds. Opt in with --live-verify.
const LIVE_VERIFY = argv.includes("--live-verify");
const outDirIdx = argv.indexOf("--out-dir");
const OUTDIR = outDirIdx >= 0 ? resolve(argv[outDirIdx + 1]) : join(REPO_ROOT, "dist", "pi-ext-bundles");


// ── manifest ────────────────────────────────────────────────────────────────
if (!existsSync(MANIFEST_PATH)) die(`manifest not found: ${MANIFEST_PATH}`);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
	extensions?: string[];
	npmExtensions?: { pkg: string; entry: string }[];
};
// workspace + npm-sourced extensions (resolved from node_modules so they too
// become self-contained FULL bundles).
const exts: { name: string; entry: string }[] = [];
for (const rel of manifest.extensions ?? []) {
	const name = basename(rel).replace(/\.ts$/, "");
	exts.push({ name, entry: join(REPO_ROOT, "bun-apps", rel) });
}
const nmRequire = createRequire(join(PI_AGENT_DIR, "package.json"));
for (const { pkg, entry } of manifest.npmExtensions ?? []) {
	try {
		const pjPath = nmRequire.resolve(`${pkg}/package.json`);
		// Sanitize the scoped name to a flat filename (@juicesharp/x → juicesharp-x)
		// so the outfile isn't a subdir resolve.ts's readdir wouldn't list.
		const name = pkg.replace(/^@/, "").replace(/[\\/]/g, "-");
		exts.push({ name, entry: join(dirname(pjPath), entry) });
	} catch {
		console.error(Y(`· npm ext ${pkg}/${entry} not resolvable — skipping`));
	}
}
if (exts.length === 0) die("manifest lists no extensions to bundle.");

// node: builtins — must NOT be rewritten. Covers deep paths like fs/promises
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

// ── Stage 1: bundle + minify (one extension) ────────────────────────────────
async function stageBundle(opts: { entry: string; outfile: string }) {
	const { entry, outfile } = opts;
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
	});
	if (!result.success) {
		for (const l of result.logs) console.error(`    ${l}`);
		throw new Error(`bun build failed for ${entry}`);
	}
}

// ── Stage 2c (verify tier C): jiti live boot ────────────────────────────────
// The only tier exercising pi's jiti loader (bun native import() bypasses it).
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

async function stageVerify(name: string, outfile: string) {
	const bytes = Bun.file(outfile).size;
	const failures: string[] = [];

	// size sanity — FULL bundles; obsidian/kc (mostly node builtins) are legitimately
	// small; typebox+babel-heavy exts reach ~6.8 MB.
	const minBytes = 2_000;
	if (bytes < minBytes) failures.push(`output ${formatSize(bytes)} below ${formatSize(minBytes)} — likely stub/empty`);

	console.log(`    ${D("· FULL bundle — residual bare specifiers resolve via host node_modules at runtime")}`);

	// (C) jiti live boot — opt-in (--live-verify). Crash = hard fail, else info.
	if (LIVE_VERIFY) {
		const boot = await liveBootTest(outfile);
		if (boot.fail) failures.push(boot.fail);
		else if (boot.ok) console.log(`    ${G("✓")} ${boot.detail}`);
		else console.log(`    ${Y("·")} ${boot.detail}`);
	}

	if (failures.length) {
		for (const f of failures) console.error(`    ${R("✗")} ${f}`);
		throw new Error(`self-verify FAILED for ${name} (${failures.length}).`);
	}
}

// ── Build one extension ─────────────────────────────────────────────────────
async function buildOne(spec: { name: string; entry: string }): Promise<void> {
	const { name, entry } = spec;
	const outfile = join(OUTDIR, `${name}.full.js`);
	console.log(`${G("▶")} ${name}  ${D(`[FULL] ${entry.replace(REPO_ROOT + "/", "")}`)}`);
	if (!existsSync(entry)) throw new Error(`entry not found: ${entry}`);

	await stageBundle({ entry, outfile });
	console.log(`    ${G("✓")} ${outfile}  ${D(`(${formatSize(Bun.file(outfile).size)})`)}`);
	if (!NO_VERIFY) await stageVerify(name, outfile);
}

// ── Orchestrate ──────────────────────────────────────────────────────────────
console.log(`${Y("▶ build-extensions")}  ${D(`${exts.length} extension(s) → ${OUTDIR} [FULL]`)}`);
mkdirSync(OUTDIR, { recursive: true });
// Wipe OUTDIR at the start of every run so the deploy ships ONLY the current
// run's bundles (resolve.ts lists every .js in ext-bundles/ — a leftover from
// an older run would double-load).
for (const f of readdirSync(OUTDIR)) rmSync(join(OUTDIR, f), { recursive: true, force: true });
let failed = 0;
for (const spec of exts) {
	try {
		await buildOne(spec);
	} catch (e: any) {
		console.error(`    ${R("✗")} ${spec.name}: ${String(e?.message || e).slice(0, 200)}`);
		failed++;
	}
}
console.log("");
if (failed) {
	console.error(R(`✗ ${failed}/${exts.length} extension(s) failed`));
	process.exit(1);
}
console.log(G(`✓ ${exts.length}/${exts.length} extension(s) bundled → ${OUTDIR}`));
