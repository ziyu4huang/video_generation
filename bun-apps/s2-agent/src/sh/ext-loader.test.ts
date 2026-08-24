import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extRequire, loadExtensions } from "./ext-loader.ts";

const HOST = { hostApi: 1, hostModules: ["typebox"] };
const roots: string[] = [];

function makeRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "sh-ext-"));
	roots.push(dir);
	return dir;
}

/** Write an extension dir whose bundle mimics bun's cjs wrapper shape. */
function writeExt(
	root: string,
	name: string,
	opts: { manifest?: Record<string, unknown>; body?: string; skipBundle?: boolean } = {},
) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const manifest = {
		name,
		package: `@repo/s2-agent-ext-${name}`,
		version: "0.1.0",
		hostApi: 1,
		entry: "ext.cjs",
		hostModules: [],
		...opts.manifest,
	};
	writeFileSync(join(dir, "ext.json"), JSON.stringify(manifest));
	if (!opts.skipBundle) {
		const body =
			opts.body ?? `module.exports.default = function factory(){ return { name: ${JSON.stringify(name)} }; };`;
		writeFileSync(
			join(dir, "ext.cjs"),
			`// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {\n${body}\n})\n`,
		);
	}
	return dir;
}

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("extRequire.resolve", () => {
	test("resolves <pkg>/package.json and the vendored entry from the ext dir", () => {
		const dir = makeRoot();
		mkdirSync(join(dir, "node_modules", "tess-pkg", "dist"), { recursive: true });
		writeFileSync(
			join(dir, "node_modules", "tess-pkg", "package.json"),
			JSON.stringify({ name: "tess-pkg", main: "./dist/lib.js" }),
		);
		writeFileSync(join(dir, "node_modules", "tess-pkg", "dist", "lib.js"), "module.exports = {}");
		const req = extRequire(dir, () => {
			throw new Error("host require must not be consulted for resolve");
		});
		expect(req.resolve("tess-pkg/package.json")).toBe(join(dir, "node_modules", "tess-pkg", "package.json"));
		expect(req.resolve("tess-pkg")).toBe(join(dir, "node_modules", "tess-pkg", "dist", "lib.js"));
	});

	test("scoped packages resolve their own node_modules dir", () => {
		const dir = makeRoot();
		mkdirSync(join(dir, "node_modules", "@tess", "data"), { recursive: true });
		writeFileSync(
			join(dir, "node_modules", "@tess", "data", "package.json"),
			JSON.stringify({ name: "@tess/data", main: "index.js" }),
		);
		const req = extRequire(dir, () => {
			throw new Error("host require must not be consulted for resolve");
		});
		expect(req.resolve("@tess/data/package.json")).toBe(join(dir, "node_modules", "@tess", "data", "package.json"));
	});

	test("builtin specifiers and unknown packages behave like require.resolve", () => {
		const dir = makeRoot();
		const req = extRequire(dir, () => {
			throw new Error("host require must not be consulted for resolve");
		});
		expect(req.resolve("node:fs")).toBe("node:fs");
		expect(() => req.resolve("not-there/package.json")).toThrow();
	});
});

describe("loadExtensions", () => {
	test("returns nothing when the ext root does not exist", () => {
		const r = loadExtensions({ extRoot: join(makeRoot(), "absent"), host: HOST, require: () => ({}) });
		expect(r.factories).toEqual([]);
		expect(r.skillPaths).toEqual([]);
		expect(r.skipped).toEqual([]);
	});

	test("loads an extension and returns its factory", () => {
		const root = makeRoot();
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.factories).toHaveLength(1);
		expect(r.factories[0]!.name).toBe("alpha");
		expect(typeof r.factories[0]!.factory).toBe("function");
	});

	test("sorts by order then name", () => {
		const root = makeRoot();
		writeExt(root, "charlie", { manifest: { order: 10 } });
		writeExt(root, "alpha", { manifest: { order: 50 } });
		writeExt(root, "bravo", { manifest: { order: 50 } });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["charlie", "alpha", "bravo"]);
	});

	test("ignores a directory with no ext.json without reporting a skip", () => {
		const root = makeRoot();
		mkdirSync(join(root, "not-an-extension"), { recursive: true });
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.skipped).toEqual([]);
	});

	test("skips unparseable ext.json but keeps the rest", () => {
		const root = makeRoot();
		mkdirSync(join(root, "broken"), { recursive: true });
		writeFileSync(join(root, "broken", "ext.json"), "{ not json");
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.skipped.map((s) => s.name)).toEqual(["broken"]);
		expect(r.skipped[0]!.reason).toMatch(/JSON/i);
	});

	test("skips a hostApi mismatch", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { manifest: { hostApi: 99 } });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/hostApi 99/);
	});

	test("skips a disabled extension", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { manifest: { enabled: false } });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/disabled/);
	});

	test("skips when the entry file is missing", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { skipBundle: true });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/entry file/);
	});

	test("skips a bundle that throws at evaluation, keeping the rest", () => {
		const root = makeRoot();
		writeExt(root, "boom", { body: `throw new Error("kaboom");` });
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.skipped.map((s) => s.name)).toEqual(["boom"]);
		expect(r.skipped[0]!.reason).toMatch(/kaboom/);
	});

	test("skips a bundle whose default export is not a function", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { body: `module.exports.default = 42;` });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/default export/);
	});

	test("passes the injected require through to the bundle", () => {
		const root = makeRoot();
		writeExt(root, "alpha", {
			manifest: { hostModules: ["typebox"] },
			body: `const t = require("typebox"); module.exports.default = () => ({ got: t.marker });`,
		});
		const r = loadExtensions({
			extRoot: root,
			host: HOST,
			require: (spec) => {
				if (spec === "typebox") return { marker: "host" };
				throw new Error(`no host module ${spec}`);
			},
		});
		// The loader types factory as pi's ExtensionFactory (void-returning); this
		// fixture returns a value so the injected require is observable.
		const probe = r.factories[0]!.factory as unknown as () => { got: string };
		expect(probe()).toEqual({ got: "host" });
	});

	test("returns absolute skill paths that exist", () => {
		const root = makeRoot();
		const dir = writeExt(root, "alpha", { manifest: { skills: ["skills", "gone"] } });
		mkdirSync(join(dir, "skills"), { recursive: true });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.skillPaths).toEqual([join(dir, "skills")]);
	});
});

describe("extRequire", () => {
	const dirs: string[] = [];
	// Rooted INSIDE the repo, not tmpdir(): in Bun 1.3.14, a createRequire
	// rooted outside the project that then RESOLVES a module poisons the
	// process's dynamic import — every later `await import(<abs .ts>)` in the
	// same test run dies with "Cannot find module … from ''". These tests call
	// that fallback require, so a tmpdir fixture made schema-cost.test.ts
	// (a dynamic-import test) fail whenever both files ran in one `bun test`.
	// A repo-rooted dir exercises the same extRequire logic without the bug.
	// CI-visible failure mode if this regresses: full-suite `bun test` red on
	// collectExtensionToolCosts while each file passes alone.
	const makeExt = (): string => {
		const d = mkdtempSync(join(import.meta.dir, ".extreq-"));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	test("serves host modules unchanged", () => {
		const host = (spec: string) => {
			if (spec === "hosted") return { from: "host" };
			throw new Error(`no host module "${spec}"`);
		};
		expect(extRequire(makeExt(), host)("hosted")).toEqual({ from: "host" });
	});

	test("falls back to the extension's own node_modules", () => {
		const dir = makeExt();
		const pkg = join(dir, "node_modules", "vendored-thing");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vendored-thing", main: "index.js" }));
		writeFileSync(join(pkg, "index.js"), "module.exports = { from: 'vendored' };");
		const host = (spec: string) => {
			throw new Error(`no host module "${spec}"`);
		};
		expect(extRequire(dir, host)("vendored-thing")).toEqual({ from: "vendored" });
	});

	test("the host wins over a vendored copy — a shadowed runtime would split singletons", () => {
		const dir = makeExt();
		const pkg = join(dir, "node_modules", "shared-runtime");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "shared-runtime", main: "index.js" }));
		writeFileSync(join(pkg, "index.js"), "module.exports = { from: 'vendored' };");
		const host = (spec: string) => (spec === "shared-runtime" ? { from: "host" } : (() => { throw new Error("x"); })());
		expect(extRequire(dir, host)("shared-runtime")).toEqual({ from: "host" });
	});

	test("reports the HOST's error when neither can serve it", () => {
		const host = (spec: string) => {
			throw new Error(`host does not provide "${spec}"`);
		};
		expect(() => extRequire(makeExt(), host)("nowhere")).toThrow(/host does not provide "nowhere"/);
	});

	test("resolves a vendored package through its exports map (require → default)", () => {
		const dir = makeExt();
		const pkg = join(dir, "node_modules", "mapped-thing");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "mapped-thing",
				exports: {
					".": {
						import: { types: "./x.d.mts", default: "./x.mjs" },
						require: { types: "./x.d.cts", default: "./x.cjs" },
					},
				},
			}),
		);
		writeFileSync(join(pkg, "x.mjs"), "export const from = 'esm';");
		writeFileSync(join(pkg, "x.cjs"), "module.exports = { from: 'cjs' };");
		const host = (spec: string) => {
			throw new Error(`no host module "${spec}"`);
		};
		expect(extRequire(dir, host)("mapped-thing")).toEqual({ from: "cjs" });
	});

	test("serves the extension's own dir under the reserved #pi/ext-dir spec", () => {
		const root = makeRoot();
		const dir = writeExt(root, "selfie", {
			body: `module.exports.default = function factory() { return { dir: require("#pi/ext-dir") }; };`,
		});
		const result = loadExtensions({ extRoot: root, host: HOST, require: (s) => {
			throw new Error(`no host module "${s}"`);
		} });
		expect(result.loaded).toEqual(["selfie"]);
		const out = (result.factories[0]!.factory as unknown as () => { dir: string })();
		expect(out.dir).toBe(dir);
	});
});
