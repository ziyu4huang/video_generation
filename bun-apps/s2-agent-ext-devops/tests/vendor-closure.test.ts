/**
 * vendor-closure — transitive-dependency vendoring for the sh deploy.
 *
 * `vendor:` used to copy ONE package verbatim, which only works for
 * self-contained packages (playwright-core, unpdf). hyperframes' helper
 * packages (@hyperframes/producer → puppeteer, 12× @fontsource, …) need their
 * whole dependency closure shipped beside them, resolved through the
 * workspace's isolated linker (symlinks into the .bun store), with
 * platform-mismatched optionals (sharp's non-darwin-arm64 @img/*) pruned.
 *
 * The fixtures here mirror that layout: a fake workspace whose node_modules
 * entries are SYMLINKS into a store dir, so the walker must resolve through
 * them (and the copier must dereference, not copy the link).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectVendorClosure, isRuntimeDeadFile, vendorClosure } from "../src/deploy/lib/vendor-closure.ts";

const dirs: string[] = [];
function makeDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sh-vendor-closure-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface PkgJson {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	os?: string[];
	cpu?: string[];
	libc?: string[];
	/** Extra files written into the package dir, as relative path → contents. */
	files?: Record<string, string>;
}

/**
 * Build a fake isolated-linker workspace, mirroring bun's real layout:
 *   <ws>/node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/   real files (store)
 *   <ws>/node_modules/.bun/<parent>@<ver>/node_modules/<dep> -> symlink into
 *     <dep>'s own store entry — a package's dependency set is a row of links,
 *     so resolution from the parent's store dir lands in each dep's REAL dir.
 *   <ws>/node_modules/<pkg> -> symlink into the store        (link farm)
 */
function fixtureWorkspace(pkgs: PkgJson[], roots: string[] = []): string {
	const ws = makeDir();
	const farm = join(ws, "node_modules");
	mkdirSync(farm, { recursive: true });
	const storeEntry = (pkg: PkgJson): string => {
		const pkgDir = join(farm, ".bun", `${pkg.name}@${pkg.version}`, "node_modules", pkg.name);
		mkdirSync(pkgDir, { recursive: true });
		const { files, ...manifest } = pkg;
		writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		for (const [rel, contents] of Object.entries(files ?? {})) {
			mkdirSync(join(pkgDir, rel, ".."), { recursive: true });
			writeFileSync(join(pkgDir, rel), contents);
		}
		return pkgDir;
	};
	const entries = new Map(pkgs.map((p) => [p.name, storeEntry(p)]));
	// Link a dep into its parent's store row. A SCOPED dep name lives one dir
	// deeper (@scope/name), and the real @scope dir must exist first — bun's
	// own layout has it as a real dir of links, so mirror that.
	const linkDep = (storeNodeModules: string, dep: string): void => {
		const entry = entries.get(dep);
		if (!entry) return;
		const linkPath = join(storeNodeModules, dep);
		mkdirSync(join(linkPath, ".."), { recursive: true });
		symlinkSync(entry, linkPath, "dir");
	};
	for (const pkg of pkgs) {
		const storeNodeModules = join(farm, ".bun", `${pkg.name}@${pkg.version}`, "node_modules");
		for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
			linkDep(storeNodeModules, dep);
		}
	}
	for (const root of roots) {
		const entry = entries.get(root);
		if (entry) symlinkSync(entry, join(farm, root), "dir");
	}
	return ws;
}

function specNames(nodes: Array<{ spec: string }>): string[] {
	return nodes.map((n) => n.spec).sort();
}

describe("collectVendorClosure", () => {
	test("walks transitive deps through the symlinked store, skipping builtins and terminating cycles", () => {
		const ws = fixtureWorkspace(
			[
				{ name: "root-pkg", version: "1.0.0", dependencies: { "dep-a": "*", "node:fs": "*" } },
				// dep-a → dep-b → dep-a: a cycle must terminate via the visited set.
				{ name: "dep-a", version: "1.0.0", dependencies: { "dep-b": "*" } },
				{ name: "dep-b", version: "2.0.0", dependencies: { "dep-a": "*" } },
			],
			["root-pkg"],
		);

		const nodes = collectVendorClosure({
			roots: ["root-pkg"],
			resolveFrom: ws,
			platform: "darwin",
			arch: "arm64",
		});
		expect(specNames(nodes)).toEqual(["dep-a", "dep-b", "root-pkg"]);
	});

	test("an unresolvable OPTIONAL dep is pruned, not an error", () => {
		const ws = fixtureWorkspace(
			[{ name: "root-pkg", version: "1.0.0", optionalDependencies: { "not-installed": "*" } }],
			["root-pkg"],
		);
		const nodes = collectVendorClosure({ roots: ["root-pkg"], resolveFrom: ws, platform: "darwin", arch: "arm64" });
		expect(specNames(nodes)).toEqual(["root-pkg"]);
		expect(nodes[0]!.pruned).toContain("not-installed");
	});

	test("an optional dep with mismatched os/cpu is pruned; a matching one ships", () => {
		const ws = fixtureWorkspace(
			[
				{
					name: "root-pkg",
					version: "1.0.0",
					optionalDependencies: { "sharp-linux-x64": "*", "sharp-darwin-arm64": "*" },
				},
				{ name: "sharp-linux-x64", version: "0.1.0", os: ["linux"], cpu: ["x64"] },
				{ name: "sharp-darwin-arm64", version: "0.1.0", os: ["darwin"], cpu: ["arm64"] },
			],
			["root-pkg"],
		);
		const nodes = collectVendorClosure({ roots: ["root-pkg"], resolveFrom: ws, platform: "darwin", arch: "arm64" });
		expect(specNames(nodes)).toEqual(["root-pkg", "sharp-darwin-arm64"]);
		expect(nodes[0]!.pruned).toContain("sharp-linux-x64");
	});

	test("an optional dep with mismatched libc is pruned; the matching one ships", () => {
		// os/cpu are IDENTICAL on both — libc is the only thing separating them,
		// which is exactly why @img/sharp-libvips-linuxmusl-x64 (~16MB) used to
		// ride along on a glibc host.
		const ws = fixtureWorkspace(
			[
				{
					name: "root-pkg",
					version: "1.0.0",
					optionalDependencies: { "libvips-musl-x64": "*", "libvips-glibc-x64": "*" },
				},
				{ name: "libvips-musl-x64", version: "0.1.0", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
				{ name: "libvips-glibc-x64", version: "0.1.0", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
			],
			["root-pkg"],
		);
		const nodes = collectVendorClosure({
			roots: ["root-pkg"],
			resolveFrom: ws,
			platform: "linux",
			arch: "x64",
			libc: "glibc",
		});
		expect(specNames(nodes)).toEqual(["libvips-glibc-x64", "root-pkg"]);
		expect(nodes[0]!.pruned).toContain("libvips-musl-x64");
	});

	test("libc: null disables the filter — both variants ship", () => {
		const ws = fixtureWorkspace(
			[
				{
					name: "root-pkg",
					version: "1.0.0",
					optionalDependencies: { "libvips-musl-x64": "*", "libvips-glibc-x64": "*" },
				},
				{ name: "libvips-musl-x64", version: "0.1.0", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
				{ name: "libvips-glibc-x64", version: "0.1.0", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
			],
			["root-pkg"],
		);
		const nodes = collectVendorClosure({
			roots: ["root-pkg"],
			resolveFrom: ws,
			platform: "linux",
			arch: "x64",
			libc: null,
		});
		expect(specNames(nodes)).toEqual(["libvips-glibc-x64", "libvips-musl-x64", "root-pkg"]);
	});

	test("a package with NO libc field ships on every host", () => {
		const ws = fixtureWorkspace(
			[
				{ name: "root-pkg", version: "1.0.0", optionalDependencies: { "portable-dep": "*" } },
				{ name: "portable-dep", version: "0.1.0", os: ["linux"], cpu: ["x64"] },
			],
			["root-pkg"],
		);
		const nodes = collectVendorClosure({
			roots: ["root-pkg"],
			resolveFrom: ws,
			platform: "linux",
			arch: "x64",
			libc: "musl",
		});
		expect(specNames(nodes)).toEqual(["portable-dep", "root-pkg"]);
	});

	test("an unresolvable HARD dep throws — a half-shipped closure would dangle at runtime", () => {
		const ws = fixtureWorkspace(
			[{ name: "root-pkg", version: "1.0.0", dependencies: { "not-installed": "*" } }],
			["root-pkg"],
		);
		expect(() =>
			collectVendorClosure({ roots: ["root-pkg"], resolveFrom: ws, platform: "darwin", arch: "arm64" }),
		).toThrow(/not-installed/);
	});

	test("exclude drops a dep and its subtree, recorded as excluded (not pruned)", () => {
		// The shipped shape: producer declares @fontsource/* but never resolves
		// them; the font packages' own deps must not ride along either.
		const ws = fixtureWorkspace(
			[
				{
					name: "producer",
					version: "1.0.0",
					dependencies: { "@fontsource/inter": "*", "@fontsource/montserrat": "*", puppeteer: "*" },
				},
				{ name: "@fontsource/inter", version: "5.2.8", dependencies: { "font-dep-only": "*" } },
				{ name: "@fontsource/montserrat", version: "5.2.8" },
				{ name: "font-dep-only", version: "1.0.0" },
				{ name: "puppeteer", version: "1.0.0" },
			],
			["producer"],
		);
		const outDir = makeDir();
		const nodes = vendorClosure({
			roots: ["producer"],
			resolveFrom: ws,
			outDir,
			platform: "darwin",
			arch: "arm64",
			exclude: ["@fontsource/*"],
		});

		// The fonts and their transitive dep are gone; everything else ships.
		expect(specNames(nodes)).toEqual(["producer", "puppeteer"]);
		expect(nodes[0]!.excluded).toContain("@fontsource/inter");
		expect(nodes[0]!.excluded).toContain("@fontsource/montserrat");
		// An exclusion is an operator decision, a prune a platform one — the
		// two must stay separable for Gate 5d and the ext.json manifest.
		expect(nodes[0]!.pruned).toEqual([]);
		expect(existsSync(join(outDir, "node_modules", "@fontsource"))).toBe(false);
		expect(existsSync(join(outDir, "node_modules", "font-dep-only"))).toBe(false);
		expect(existsSync(join(outDir, "node_modules", "puppeteer"))).toBe(true);
	});

	test("exclude also applies to optional deps and to exact (non-pattern) names", () => {
		const ws = fixtureWorkspace(
			[
				{
					name: "root-pkg",
					version: "1.0.0",
					optionalDependencies: { "heavy-optional": "*" },
					dependencies: { "exact-drop": "*" },
				},
				{ name: "heavy-optional", version: "1.0.0", os: ["darwin"], cpu: ["arm64"] },
				{ name: "exact-drop", version: "1.0.0" },
			],
			["root-pkg"],
		);
		const nodes = collectVendorClosure({
			roots: ["root-pkg"],
			resolveFrom: ws,
			platform: "darwin",
			arch: "arm64",
			exclude: ["heavy-optional", "exact-drop"],
		});
		expect(specNames(nodes)).toEqual(["root-pkg"]);
		expect([...nodes[0]!.excluded].sort()).toEqual(["exact-drop", "heavy-optional"]);
	});

	test("excluding a ROOT throws — vendor and vendorExclude contradict each other", () => {
		const ws = fixtureWorkspace([{ name: "root-pkg", version: "1.0.0" }], ["root-pkg"]);
		expect(() =>
			collectVendorClosure({
				roots: ["root-pkg"],
				resolveFrom: ws,
				platform: "darwin",
				arch: "arm64",
				exclude: ["root-pkg"],
			}),
		).toThrow(/root "root-pkg" is also in exclude/);
	});
});

describe("vendorClosure", () => {
	test("copies the whole closure as REAL files under outDir/node_modules, dereferencing store symlinks", () => {
		const ws = fixtureWorkspace(
			[
				{ name: "root-pkg", version: "1.0.0", dependencies: { "dep-a": "*" } },
				{ name: "dep-a", version: "1.0.0" },
			],
			["root-pkg"],
		);
		const outDir = makeDir();
		const nodes = vendorClosure({ roots: ["root-pkg"], resolveFrom: ws, outDir, platform: "darwin", arch: "arm64" });

		expect(specNames(nodes)).toEqual(["dep-a", "root-pkg"]);
		for (const name of ["root-pkg", "dep-a"]) {
			const dir = join(outDir, "node_modules", name);
			expect(existsSync(join(dir, "package.json"))).toBe(true);
			// The output must be a real directory, not a copy of the store symlink.
			expect(lstatSync(dir).isSymbolicLink()).toBe(false);
		}
		const manifest = JSON.parse(readFileSync(join(outDir, "node_modules", "root-pkg", "package.json"), "utf8"));
		expect(manifest.name).toBe("root-pkg");
	});

	test("prunes sourcemaps and typings while keeping code, licenses and data", () => {
		const ws = fixtureWorkspace(
			[
				{
					name: "root-pkg",
					version: "1.0.0",
					files: {
						"dist/index.js": "module.exports = 1;\n//# sourceMappingURL=index.js.map\n",
						"dist/index.js.map": '{"version":3}',
						"dist/index.d.ts": "export declare const x: number;",
						"dist/index.d.ts.map": '{"version":3}',
						"dist/index.mjs.map": '{"version":3}',
						"dist/styles.css.map": '{"version":3}',
						"dist/index.d.mts": "export declare const x: number;",
						"LICENSE": "MIT",
						"README.md": "# root-pkg",
						// A .node binary and a data file must survive untouched.
						"build/native.node": "\0binary",
						"data/tiles.map.json": "{}",
					},
				},
			],
			["root-pkg"],
		);
		const outDir = makeDir();
		vendorClosure({ roots: ["root-pkg"], resolveFrom: ws, outDir, platform: "darwin", arch: "arm64" });
		const dir = join(outDir, "node_modules", "root-pkg");

		for (const gone of [
			"dist/index.js.map",
			"dist/index.d.ts",
			"dist/index.d.ts.map",
			"dist/index.mjs.map",
			"dist/styles.css.map",
			"dist/index.d.mts",
		]) {
			expect(existsSync(join(dir, gone))).toBe(false);
		}
		for (const kept of ["dist/index.js", "LICENSE", "README.md", "build/native.node", "data/tiles.map.json"]) {
			expect(existsSync(join(dir, kept))).toBe(true);
		}
		// The package must still be resolvable — gates 5c/5d read package.json.
		expect(existsSync(join(dir, "package.json"))).toBe(true);
	});
});

describe("isRuntimeDeadFile", () => {
	test("matches sourcemaps and declaration files only", () => {
		for (const dead of [
			"a/index.js.map",
			"a/index.mjs.map",
			"a/index.cjs.map",
			"a/index.ts.map",
			"a/index.d.ts.map",
			"a/styles.css.map",
			"a/index.d.ts",
			"a/index.d.mts",
			"a/index.d.cts",
		]) {
			expect(isRuntimeDeadFile(dead)).toBe(true);
		}
		for (const live of [
			"a/index.js",
			"a/index.ts",
			"a/native.node",
			"a/LICENSE",
			"a/README.md",
			"a/package.json",
			// Not a sourcemap: a data file that merely ends in ".map".
			"a/world.map",
			"a/tiles.map.json",
			// A directory named like a map file must not be pruned wholesale.
			"a/index.d.ts.map.d",
		]) {
			expect(isRuntimeDeadFile(live)).toBe(false);
		}
	});
});
