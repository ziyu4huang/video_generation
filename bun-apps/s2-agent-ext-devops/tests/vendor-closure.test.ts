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
import { collectVendorClosure, vendorClosure } from "../scripts/lib/vendor-closure.ts";

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
		writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
		return pkgDir;
	};
	const entries = new Map(pkgs.map((p) => [p.name, storeEntry(p)]));
	for (const pkg of pkgs) {
		const storeNodeModules = join(farm, ".bun", `${pkg.name}@${pkg.version}`, "node_modules");
		for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
			const entry = entries.get(dep);
			if (entry) symlinkSync(entry, join(storeNodeModules, dep), "dir");
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

	test("an unresolvable HARD dep throws — a half-shipped closure would dangle at runtime", () => {
		const ws = fixtureWorkspace(
			[{ name: "root-pkg", version: "1.0.0", dependencies: { "not-installed": "*" } }],
			["root-pkg"],
		);
		expect(() =>
			collectVendorClosure({ roots: ["root-pkg"], resolveFrom: ws, platform: "darwin", arch: "arm64" }),
		).toThrow(/not-installed/);
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
});
