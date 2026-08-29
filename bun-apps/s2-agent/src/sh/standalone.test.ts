import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExts, loadExt } from "./standalone.ts";

/**
 * standalone.ts contract tests against a fixture dist tree. The fixture
 * bundles mimic bun's cjs wrapper shape (same as ext-loader.test.ts), so
 * evaluateExtModule exercises the real load path — including `#pi/ext-dir`
 * and host/vendored require routing — without a deploy present.
 */

const roots: string[] = [];

function makeDist(): string {
	const dir = mkdtempSync(join(tmpdir(), "sh-standalone-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Write <dist>/ext/<name>/{ext.json, ext.cjs} in the deployed layout. */
function writeExt(
	dist: string,
	name: string,
	opts: { manifest?: Record<string, unknown>; body?: string; skipManifest?: boolean; skipBundle?: boolean } = {},
) {
	const dir = join(dist, "ext", name);
	mkdirSync(dir, { recursive: true });
	if (!opts.skipManifest) {
		const manifest = {
			name,
			package: `@repo/s2-agent-ext-${name}`,
			version: "0.1.0",
			hostApi: 2,
			entry: "ext.cjs",
			hostModules: ["typebox"],
			...opts.manifest,
		};
		writeFileSync(join(dir, "ext.json"), JSON.stringify(manifest));
	}
	if (!opts.skipBundle) {
		const body =
			opts.body ??
			`module.exports.default = function factory(api) {
	api.registerTool({ name: "echo", execute: (sid, params) => ({ ok: true, sid, params }) });
};`;
		writeFileSync(
			join(dir, "ext.cjs"),
			`// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {\n${body}\n})\n`,
		);
	}
	return dir;
}

describe("listExts", () => {
	test("enumerates ext.json-bearing dirs sorted, ignores the shim file and non-ext dirs", () => {
		const dist = makeDist();
		writeExt(dist, "zeta");
		writeExt(dist, "alpha");
		// The shim's own bundle file at the ext root must be ignored (a FILE, no ext.json).
		writeFileSync(join(dist, "ext", "ext-standalone.mjs"), "export const x = 1;");
		// A dir without ext.json is not an extension (runtime loader's rule).
		mkdirSync(join(dist, "ext", "not-an-ext"), { recursive: true });
		const names = listExts({ distRoot: dist }).map((e) => e.name);
		expect(names).toEqual(["alpha", "zeta"]);
		expect(listExts({ distRoot: dist })[0]!.manifest.package).toBe("@repo/s2-agent-ext-alpha");
	});

	test("unparseable ext.json is skipped in the listing (best-effort), not fatal", () => {
		const dist = makeDist();
		writeExt(dist, "good");
		const dir = writeExt(dist, "bad");
		writeFileSync(join(dir, "ext.json"), "{not json");
		expect(listExts({ distRoot: dist }).map((e) => e.name)).toEqual(["good"]);
	});

	test("missing ext root returns [] (no throw)", () => {
		const dist = makeDist();
		expect(listExts({ distRoot: dist })).toEqual([]);
	});
});

describe("loadExt", () => {
	test("registers tools, executes one, serves #pi/ext-dir and host modules", async () => {
		const dist = makeDist();
		writeExt(dist, "probe", {
			body: `module.exports.default = function factory(api) {
	api.registerTool({
		name: "selfreport",
		execute: () => ({
			extDir: require("#pi/ext-dir"),
			typeboxIsHost: typeof require("typebox").String === "function",
			nonHostThrows: (() => { try { require("left-pad"); return false; } catch { return true; } })(),
		}),
	});
};`,
		});
		const ext = loadExt("probe", { distRoot: dist });
		expect(ext.name).toBe("probe");
		expect(ext.manifest.hostApi).toBe(2);
		const names = ext.tools().map((t) => t.name);
		expect(names).toEqual(["selfreport"]);
		const out = (await ext.tool("selfreport").execute("sid-probe", {})) as Record<string, unknown>;
		expect(out.extDir).toBe(join(dist, "ext", "probe"));
		expect(out.typeboxIsHost).toBe(true);
		expect(out.nonHostThrows).toBe(true);
	});

	test("entry comes from the manifest when it is not ext.cjs", () => {
		const dist = makeDist();
		const dir = writeExt(dist, "customentry", { manifest: { entry: "bundle.cjs" } });
		rmSync(join(dir, "ext.cjs"));
		writeFileSync(
			join(dir, "bundle.cjs"),
			`(function(exports, require, module) { module.exports.default = (api) => api.registerTool({ name: "t", execute: () => 1 }); })\n`,
		);
		expect(loadExt("customentry", { distRoot: dist }).tool("t").name).toBe("t");
	});

	test("unknown ext throws naming the dir and the available exts", () => {
		const dist = makeDist();
		writeExt(dist, "alpha");
		try {
			loadExt("nope", { distRoot: dist });
			throw new Error("unreachable");
		} catch (e) {
			expect(e instanceof Error).toBe(true);
			const msg = (e as Error).message;
			expect(msg).toContain('loadExt("nope")');
			expect(msg).toContain(join(dist, "ext", "nope"));
			expect(msg).toContain("alpha");
		}
	});

	test("missing ext.json / invalid JSON / missing entry each throw naming the ext", () => {
		const dist = makeDist();
		writeExt(dist, "nomatch", { skipManifest: true });
		writeExt(dist, "badjson", { manifest: undefined, body: undefined });
		writeFileSync(join(dist, "ext", "badjson", "ext.json"), "{oops");
		writeExt(dist, "noentry", { skipBundle: true });
		for (const name of ["nomatch", "badjson", "noentry"]) {
			try {
				loadExt(name, { distRoot: dist });
				throw new Error(`loadExt(${name}) should have thrown`);
			} catch (e) {
				expect((e as Error).message).toContain(name);
			}
		}
	});

	test("bundle with no callable default throws", () => {
		const dist = makeDist();
		writeExt(dist, "nodefault", {
			body: `module.exports.probes = 1;`,
		});
		try {
			loadExt("nodefault", { distRoot: dist });
			throw new Error("unreachable");
		} catch (e) {
			expect((e as Error).message).toContain("no callable default export");
			expect((e as Error).message).toContain("nodefault");
		}
	});

	test("factory registering zero tools throws (lazy registration unsupported standalone)", () => {
		const dist = makeDist();
		writeExt(dist, "lazy", {
			body: `module.exports.default = function factory(api) { api.on("session_start", () => {}); };`,
		});
		try {
			loadExt("lazy", { distRoot: dist });
			throw new Error("unreachable");
		} catch (e) {
			expect((e as Error).message).toContain("registered no tools");
		}
	});

	test("malformed registered tool throws at load", () => {
		const dist = makeDist();
		writeExt(dist, "malformed", {
			body: `module.exports.default = function factory(api) { api.registerTool({ name: 42 }); };`,
		});
		expect(() => loadExt("malformed", { distRoot: dist })).toThrow("malformed tool");
	});

	test("tool() for an unregistered name throws listing what IS registered", () => {
		const dist = makeDist();
		writeExt(dist, "one");
		const ext = loadExt("one", { distRoot: dist });
		try {
			ext.tool("missing");
			throw new Error("unreachable");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain('"missing"');
			expect(msg).toContain('"one"');
			expect(msg).toContain("echo");
		}
	});

	test("tools() returns a copy — mutating it does not affect tool()", () => {
		const dist = makeDist();
		writeExt(dist, "one");
		const ext = loadExt("one", { distRoot: dist });
		ext.tools().pop();
		expect(ext.tools()).toHaveLength(1);
		expect(ext.tool("echo").name).toBe("echo");
	});
});
