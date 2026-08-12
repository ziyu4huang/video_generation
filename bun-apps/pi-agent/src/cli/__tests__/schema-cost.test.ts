/**
 * Unit tests for `schema-cost` — the pure cost estimation + capturing mock API.
 *
 * The factory-capture path is exercised against a SYNTHETIC factory (so the test
 * is hermetic — no real extension loading). The live repo-wide run is covered by
 * the CLI smoke (`bun run src/cli.ts cli tools-metrics --schema-cost`).
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
	estimateToolCost,
	createCapturingApi,
	collectExtensionToolCosts,
	collectBuiltinToolCosts,
	resolveRepoRoot,
	discoverExtensionEntries,
	formatSchemaCostReport,
	formatSchemaCostJson,
} from "../commands/schema-cost.ts";
import { Type } from "typebox";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// A realistic-ish TypeBox schema (nested object + enum + descriptions).
const sampleDef = {
	name: "sample",
	description: "Does a thing.",
	parameters: Type.Object({
		path: Type.String({ description: "file path" }),
		mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
	}),
};

describe("estimateToolCost", () => {
	test("approxTokens = round((descLen + paramsJsonLen) / 4)", () => {
		const c = estimateToolCost(sampleDef, "test");
		expect(c.name).toBe("sample");
		expect(c.source).toBe("test");
		expect(c.descLen).toBe("Does a thing.".length);
		const expectedParams = JSON.stringify(sampleDef.parameters).length;
		expect(c.paramsLen).toBe(expectedParams);
		expect(c.approxTokens).toBe(Math.round(("Does a thing.".length + expectedParams) / 4));
	});

	test("handles a definition with no parameters", () => {
		const c = estimateToolCost({ name: "x", description: "abc" }, "s");
		expect(c.paramsLen).toBe(0);
		expect(c.approxTokens).toBe(Math.round(3 / 4));
	});

	test("handles a non-string description gracefully", () => {
		const c = estimateToolCost({ name: "x", description: 42, parameters: {} }, "s");
		expect(c.descLen).toBe(0);
	});

	test("falls back to '?' name when missing", () => {
		const c = estimateToolCost({ description: "x" }, "s");
		expect(c.name).toBe("?");
	});
});

describe("createCapturingApi", () => {
	test("registerTool captures the definition; other methods are callable no-ops", async () => {
		const sink: unknown[] = [];
		const api = createCapturingApi("my-ext", sink as any);
		// mimic a real factory: registerTool + call unrelated methods
		(api as any).registerTool(sampleDef);
		(api as any).registerTool({ name: "second", description: "y", parameters: Type.Object({}) });
		(api as any).on("session_start", () => {});
		(api as any).defineFlag("flag", { default: true });
		(api as any).someUnknownMethod(1, 2, 3);
		expect(sink.length).toBe(2);
		expect((sink[0] as any).name).toBe("sample");
		expect((sink[1] as any).name).toBe("second");
	});

	test("a factory that registers via the captured api is fully collected", async () => {
		const sink: unknown[] = [];
		const api = createCapturingApi("ext", sink as any);
		const factory = (pi: any) => {
			pi.registerTool({ name: "t1", description: "one", parameters: Type.Object({}) });
			pi.registerTool({ name: "t2", description: "two", parameters: Type.Object({}) });
			pi.on("session_start", () => {});
		};
		factory(api);
		expect(sink.length).toBe(2);
	});

	test("pi.events is undefined so host-fn-bus-guarding factories skip without throwing", () => {
		// knowledge-card + movie-director read `pi.events` (the workflow event bus)
		// and guard `if (!bus) return`. The mock models an ABSENT bus, so events
		// must be undefined — otherwise the guard sees a truthy callable and calls
		// `bus.emit(...)`, which throws (a callable has no `.emit`).
		const sink: unknown[] = [];
		const api = createCapturingApi("ext", sink as any);
		expect((api as any).events).toBeUndefined();
		const factory = (pi: any) => {
			const bus = pi.events;
			if (!bus) return "skipped"; // the no-bus path both extensions take
			bus.emit("workflow:hostfn:v1:register", {}); // would throw pre-fix
			return "emitted";
		};
		expect(factory(api)).toBe("skipped");
	});

	test("registerTool computes hasExecute + schemaValid contract flags", () => {
		const sink: unknown[] = [];
		const api = createCapturingApi("ext", sink as any);
		(api as any).registerTool({
			name: "good",
			description: "x",
			parameters: Type.Object({ a: Type.String() }),
			execute() {},
		});
		(api as any).registerTool({ name: "noexec", description: "y", parameters: Type.Object({}) });
		expect((sink[0] as any).hasExecute).toBe(true);
		expect((sink[0] as any).schemaValid).toBe(true);
		expect((sink[1] as any).hasExecute).toBe(false);
		expect((sink[1] as any).schemaValid).toBe(true);
	});
});

describe("collectExtensionToolCosts", () => {
	test("loads + costs a factory module, and captures a throwing factory as an error", async () => {
		// Merge into one test: bun caches dynamic imports per-process, so two tests
		// each writing+importing a temp .ts can interfere. One test = one sequence.
		const { writeFileSync, unlinkSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const good = join(tmpdir(), `sc-good-${process.pid}-${Date.now()}.ts`);
		const bad = join(tmpdir(), `sc-bad-${process.pid}-${Date.now()}.ts`);
		writeFileSync(good, `const f=(pi)=>{pi.registerTool({name:"tmp",description:"temp tool",parameters:{type:"object"}})};export default f;\n`);
		writeFileSync(bad, `const f=(pi)=>{throw new Error("boom")};export default f;\n`);
		try {
			const ok = await collectExtensionToolCosts([{ source: "good", path: good }]);
			expect(ok.errors.length).toBe(0);
			expect(ok.costs.length).toBe(1);
			expect(ok.costs[0]!.name).toBe("tmp");
			expect(ok.costs[0]!.source).toBe("good");

			const err = await collectExtensionToolCosts([{ source: "boom", path: bad }]);
			expect(err.costs.length).toBe(0);
			expect(err.errors.length).toBe(1);
			expect(err.errors[0]!.source).toBe("boom");
			expect(err.errors[0]!.error).toContain("boom");
		} finally {
			try { unlinkSync(good); } catch {}
			try { unlinkSync(bad); } catch {}
		}
	});
});

describe("collectBuiltinToolCosts", () => {
	test("returns the 4 core coding tools (read/bash/edit/write)", () => {
		const costs = collectBuiltinToolCosts(process.cwd());
		const names = costs.map((c) => c.name).sort();
		expect(names).toEqual(["bash", "edit", "read", "write"]);
		for (const c of costs) expect(c.source).toBe("(builtin)");
	});
});

describe("resolveRepoRoot", () => {
	test("walks up from a nested dir to find the bun-apps root", () => {
		// this test file lives under bun-apps/pi-agent/src/cli/__tests__
		const root = resolveRepoRoot(import.meta.dir);
		const { existsSync } = require("node:fs");
		expect(existsSync(`${root}/bun-apps`)).toBe(true);
	});
});

describe("formatting", () => {
	test("text report includes total + top-3 share + ranked rows", () => {
		const report = {
			tools: [
				{ name: "big", descLen: 100, paramsLen: 300, approxTokens: 100, source: "ext" },
				{ name: "small", descLen: 10, paramsLen: 10, approxTokens: 5, source: "(builtin)" },
			],
			totalTokens: 105,
			builtinCount: 1,
			extensionCount: 1,
			errors: [],
		};
		const lines = formatSchemaCostReport(report).join("\n");
		expect(lines).toContain("105");
		expect(lines).toContain("top 3");
		expect(lines).toContain("big");
		expect(lines).toContain("small");
	});

	test("json report round-trips with ranked tools", () => {
		const report = {
			tools: [{ name: "x", descLen: 4, paramsLen: 4, approxTokens: 2, source: "ext" }],
			totalTokens: 2,
			builtinCount: 0,
			extensionCount: 1,
			errors: [],
		};
		const obj = JSON.parse(formatSchemaCostJson(report));
		expect(obj.totalTokens).toBe(2);
		expect(obj.toolsRanked[0].name).toBe("x");
		expect(obj.toolsRanked[0].approxTokens).toBe(2);
	});
});

describe("discoverExtensionEntries (manifest-derived)", () => {
	// repo root = walk up from the package dir
	const root = resolveRepoRoot(join(import.meta.dir, "..", ".."));

	test("covers every manifest extension and every static extension", () => {
		const sources = new Set(discoverExtensionEntries(root).map((e) => e.source));
		// dynamic manifest.extensions
		for (const s of ["power-tool", "tool-gate", "flux2", "krea2", "ltx", "research-tool", "zai-mcp", "movie-director"]) {
			expect(sources.has(s)).toBe(true);
		}
		// staticExtensions via the extensions/<X>.ts convention
		for (const s of ["core-task", "hermes-memory", "superpowers", "wayfind", "web-access", "obsidian", "btw", "file2md", "workflow", "knowledge-card"]) {
			expect(sources.has(s)).toBe(true);
		}
	});

	test("every derived path exists on disk and is absolute", () => {
		for (const e of discoverExtensionEntries(root)) {
			expect(isAbsolute(e.path)).toBe(true);
			expect(existsSync(e.path)).toBe(true);
		}
	});
});

describe("discoverExtensionEntries (manifest-error handling, audit I-7)", () => {
	const tmpRoots: string[] = [];
	const cleanup = () => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); tmpRoots.length = 0; };
	afterEach(cleanup);

	test("ENOENT (manifest absent, e.g. outside the repo) → extras only, no throw", () => {
		const dir = mkdtempSync(join(tmpdir(), "sc-enonent-"));
		tmpRoots.push(dir);
		// no bun-apps/pi-agent/run-dir/manifest.json → ENOENT swallowed → extras only
		expect(discoverExtensionEntries(dir)).toEqual([]);
	});

	test("malformed manifest (exists but bad JSON) → throws, not a silent false-green", () => {
		const dir = mkdtempSync(join(tmpdir(), "sc-badman-"));
		tmpRoots.push(dir);
		const manifestDir = resolve(dir, "bun-apps/pi-agent/run-dir");
		mkdirSync(manifestDir, { recursive: true });
		writeFileSync(join(manifestDir, "manifest.json"), "{not valid json");
		// A malformed manifest must NOT be swallowed into extras-only (that would
		// undercount loaded tools → false-green). It throws loudly (audit I-7).
		expect(() => discoverExtensionEntries(dir)).toThrow(/unreadable/i);
	});
});
