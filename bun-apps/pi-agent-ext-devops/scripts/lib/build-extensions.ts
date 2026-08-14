/**
 * build-extensions — thin-only extension builder for deploy scripts.
 *
 * Exports a single async function `buildExtensions(targetDir)` that reads
 * run-dir/manifest.json, builds a thin bundle for each extension entry, and
 * writes the output to `targetDir/<name>.thin.js` with a `<name>.thin.hash`
 * sidecar for warm-build caching.
 *
 * Thin mode keeps peer deps external (typebox, @earendil-works/*,
 * @modelcontextprotocol/sdk) and rewrites every bare specifier to an absolute
 * file path, so the bundle loads without a co-located node_modules. Every
 * bundle is verified via a factory test (import() + default(mockApi)) to
 * prove ESM validity and dep resolution.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { parseManifestEntries } from "../../../pi-agent/run-dir/manifest-types.ts";
import { hashExtInputs } from "./ext-hash.ts";

// ── Path anchors ────────────────────────────────────────────────────────────
const PI_AGENT_DIR = resolve(dirname(import.meta.dir), "..", "..", "pi-agent"); // scripts/lib → pi-agent-ext-devops → bun-apps → sibling pi-agent
const REPO_ROOT = dirname(dirname(PI_AGENT_DIR)); // bun-apps/pi-agent → bun-apps → repo root
const BUN_APPS_DIR = dirname(PI_AGENT_DIR); // bun-apps/pi-agent → bun-apps
const MANIFEST_PATH = join(PI_AGENT_DIR, "run-dir", "manifest.json");

// ── Constants ────────────────────────────────────────────────────────────────
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

const MINIFY_CFG = "whitespace,identifiers,syntax";

// ── Stage 1: bundle + minify ────────────────────────────────────────────────
async function stageBundle(entry: string, outfile: string): Promise<void> {
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
		external: THIN_EXTERNALS,
	});
	if (!result.success) {
		for (const l of result.logs) console.error(`    ${l}`);
		throw new Error(`bun build failed for ${entry}`);
	}
}

// ── Stage 1b: rewrite bare specifiers → absolute file paths ─────────────────
function makeResolver(entryAbs: string, repoRoot: string) {
	const cwd = dirname(entryAbs);
	return (spec: string): string | undefined => {
		if (isBuiltin(spec)) return undefined;
		try {
			return Bun.resolveSync(spec, cwd);
		} catch {}
		try {
			return Bun.resolveSync(spec, repoRoot);
		} catch {}
		try {
			const r = createRequire(entryAbs);
			const pjPath = r.resolve(`${spec}/package.json`);
			const pj = JSON.parse(readFileSync(pjPath, "utf8"));
			const dir = pjPath.replace(/\/package\.json$/, "");
			const entry = pj.exports?.["."]?.import || pj.exports?.["."] || pj.main || "index.js";
			return `${dir}/${String(entry).replace(/^\.\//, "")}`;
		} catch {}
		return "";
	};
}

function isValidModuleSpec(s: string): boolean {
	if (s.length < 2) return false;
	if (/[\s(){}=;<>+]/.test(s)) return false;
	return true;
}

// The `from` / `import(` alternation matches ESM import + re-export forms.
// The `(?<![\w$-])` lookbehind on `from` is REQUIRED: without it the regex
// also matches the `from` that is merely the TAIL of a larger token — most
// painfully the string `"sql-delete-from"` (from is-unsafe's SQL-injection
// catalog, a transitive dep of fast-xml-parser). There `from` is followed by
// the string's closing `"`, so the regex captured ",description:" as a bogus
// bare specifier and aborted the deploy. A real `from` keyword is never
// preceded by a word char or `-` (minified `export{a}from"x"` → preceded by
// `}`; `import a from"x"` → preceded by a space), so the lookbehind rejects
// only the false positives. `import(` needs no anchor (the `(` disambiguates).
const BARE_SPEC_RE =
	/(?:((?<![\w$-])from|import\()\s*)(["'])([^"'#.][^"'']*?)\2/g;

/**
 * Scan bundled code for ESM bare specifiers (`from "x"`, `import("x")`,
 * re-export `}from"x"`) that must be abs-resolved or marked external. Pure +
 * exported so the notoriously fragile regex is unit-testable. Returns the
 * de-duplicated specifiers in first-seen order; template-concat and obviously
 * invalid specs are filtered here so callers see only plausible specifiers.
 */
export function extractBareSpecifiers(code: string): string[] {
	const bare = new Set<string>();
	for (const m of code.matchAll(BARE_SPEC_RE)) {
		const spec = m[3];
		if (spec.includes("${") || spec.includes(" + ")) continue;
		if (!isValidModuleSpec(spec)) continue;
		bare.add(spec);
	}
	return [...bare];
}

function stageResolveExternals(outfile: string, resolveBare: (s: string) => string | undefined): string[] {
	let code = readFileSync(outfile, "utf8");
	const bare = new Set(extractBareSpecifiers(code));
	const unresolved: string[] = [];
	let resolved = 0;
	for (const spec of [...bare]) {
		const abs = resolveBare(spec);
		if (abs === undefined) continue;
		if (!abs) {
			unresolved.push(spec);
			continue;
		}
		const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		code = code.replace(
			new RegExp(`(((?<![\\w$-])from|import\\()\\s*)(["'])${esc}\\3`, "g"),
			`$1"${abs}"`,
		);
		resolved++;
	}
	if (unresolved.length) {
		throw new Error(
			`could not resolve bare specifier(s): ${unresolved.join(", ")} — add to THIN_EXTERNALS or ensure the dep is resolvable from the extension's package`,
		);
	}
	writeFileSync(outfile, code);
	return [...bare].filter((s) => resolveBare(s) !== undefined);
}

// ── Stage 2 (verify): factory test ──────────────────────────────────────────
async function factoryTest(
	outfile: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
	// Resolve symlinks (macOS /tmp → /private/tmp) to avoid bun import() ambiguity
	const importPath = realpathSync(outfile);
	let mod: any;
	try {
		mod = await import(importPath);
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
	const deepCallable = (): any =>
		new Proxy(function () {}, {
			get(_t, prop) {
				if (typeof prop === "symbol" || prop === "then") return undefined;
				return deepCallable();
			},
			apply: () => deepCallable(),
		});
	const target = {
		on: () => {},
		registerTool: (def: any) => tools.push(def),
		events: {
			on: () => () => {},
			emit: () => {},
		},
	};
	const mockApi = new Proxy(target, {
		get(t, prop) {
			if (typeof prop === "symbol" || prop === "then") return undefined;
			if (prop in t) return (t as any)[prop];
			return deepCallable();
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

// ── Build one extension ─────────────────────────────────────────────────────
async function buildOne(
	spec: { name: string; entry: string; pkgDir: string },
	targetDir: string,
): Promise<boolean> {
	const { name, entry, pkgDir } = spec;
	const outfile = join(targetDir, `${name}.thin.js`);
	const hashFile = join(targetDir, `${name}.thin.hash`);
	console.log(`  ▶ ${name}  ${entry.replace(REPO_ROOT + "/", "")}`);
	if (!existsSync(entry)) throw new Error(`entry not found: ${entry}`);

	// Hash-cache skip
	const inputsHash = hashExtInputs({
		entry,
		pkgDir,
		thin: true,
		workspaceRoot: BUN_APPS_DIR,
		minifyCfg: MINIFY_CFG,
		thinExternals: THIN_EXTERNALS,
		bunVersion: Bun.version,
	});
	if (existsSync(outfile) && existsSync(hashFile)) {
		const stored = readFileSync(hashFile, "utf8").trim();
		if (stored === inputsHash) {
			console.log(`    · skipped (hash match)  ${formatSize(Bun.file(outfile).size)}`);
			return false;
		}
	}

	await stageBundle(entry, outfile);
	const resolved = stageResolveExternals(outfile, makeResolver(entry, REPO_ROOT));
	console.log(`    ✓ ${resolved.length} bare specifier(s) abs-resolved`);
	console.log(`    ✓ ${outfile}  (${formatSize(Bun.file(outfile).size)})`);

	// Verify
	const factory = await factoryTest(outfile);
	if (!factory.ok) {
		throw new Error(`self-verify FAILED for ${name}: ${factory.detail}`);
	}
	console.log(`    ✓ factory: ${factory.detail}`);

	writeFileSync(hashFile, inputsHash + "\n");
	return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Copy each extension's `vendored/` tree (if present) into `<targetDir>/vendored/`
 * so the bundled thin file can resolve it at runtime via run.ts's walk-up probe.
 * Today only archify ships a vendored/ tree; if a second extension later adds
 * one, extend to a per-extension subdir + name-aware probe (see design §A2).
 */
export function stageVendoredAssets(
	exts: { name: string; pkgDir: string }[],
	targetDir: string,
): void {
	let firstOwner: string | null = null;
	for (const spec of exts) {
		const vendoredSrc = join(spec.pkgDir, "vendored");
		if (!existsSync(vendoredSrc)) continue;
		const dest = join(targetDir, "vendored");
		if (firstOwner !== null) {
			console.warn(`    ⚠ vendored/ collision: ${spec.name} overwrites ${firstOwner}'s tree at ${dest}`);
		} else {
			firstOwner = spec.name;
		}
		cpSync(vendoredSrc, dest, { recursive: true, force: true });
		console.log(`    ✓ vendored/ (from ${spec.name}) → ${dest}`);
	}
}

/**
 * Build thin bundles for every extension in run-dir/manifest.json.
 *
 * @param targetDir — Output directory for the bundled .js and .hash files.
 * @returns `{ count }` where `count` is the total number of extensions
 *          successfully processed (including hash-cache-skipped ones).
 *          Throws if the manifest cannot be read or if any extension fails.
 */
export async function buildExtensions(targetDir: string): Promise<{ count: number }> {
	if (!existsSync(MANIFEST_PATH)) {
		throw new Error(`manifest not found: ${MANIFEST_PATH}`);
	}
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
		extensions?: (string | Record<string, unknown>)[];
	};
	const entries = parseManifestEntries(manifest.extensions ?? []);
	if (entries.length === 0) {
		throw new Error("manifest lists no extensions to build");
	}

	// Resolve extensions: name, entry (absolute), pkgDir
	const exts: { name: string; entry: string; pkgDir: string }[] = [];
	const usedNames = new Set<string>();
	for (const entry of entries) {
		const rel = entry.entry;
		const pkgSeg = rel.split("/")[0]!;
		let name = entry.name || basename(rel).replace(/\.ts$/, "");
		if (name === "index" || usedNames.has(name)) name = pkgSeg;
		while (usedNames.has(name)) name = `${pkgSeg}-${name}`;
		usedNames.add(name);
		const pkgDir = join(BUN_APPS_DIR, pkgSeg);
		exts.push({ name, entry: join(BUN_APPS_DIR, rel), pkgDir });
	}

	// Stale cleanup: remove .js / .hash files not matching current manifest
	mkdirSync(targetDir, { recursive: true });
	const expectedFiles = new Set(
		exts.flatMap((spec) => [`${spec.name}.thin.js`, `${spec.name}.thin.hash`]),
	);
	if (exts.some((spec) => existsSync(join(spec.pkgDir, "vendored")))) {
		expectedFiles.add("vendored");
	}
	if (existsSync(targetDir)) {
		for (const f of readdirSync(targetDir)) {
			if (!expectedFiles.has(f)) {
				rmSync(join(targetDir, f), { recursive: true, force: true });
			}
		}
	}

	// Build
	console.log(`▶ build-extensions  ${exts.length} extension(s) → ${targetDir}`);
	let built = 0;
	let skipped = 0;

	const errors: string[] = [];

	for (const spec of exts) {
		try {
			const did = await buildOne(spec, targetDir);
			if (did) built++;
			else skipped++;
		} catch (e: any) {
			const msg = `${spec.name}: ${String(e?.message || e).slice(0, 300)}`;
			console.error(`    ✗ ${msg}`);
			errors.push(msg);
		}
	}

	console.log(
		`  (${built} built, ${skipped} skipped via hash cache${errors.length ? `, ${errors.length} failed` : ""})`,
	);

	if (errors.length) {
		throw new Error(`${errors.length}/${exts.length} extension(s) failed to build:\n  ${errors.join("\n  ")}`);
	}

	// Runs after the errors.length throw above: a partial build (some ext failed)
	// aborts before staging, so a half-built target never ships a vendored/ tree.
	stageVendoredAssets(exts, targetDir);

	console.log(`✓ ${exts.length}/${exts.length} extension(s) built → ${targetDir}`);
	return { count: built + skipped };
}
