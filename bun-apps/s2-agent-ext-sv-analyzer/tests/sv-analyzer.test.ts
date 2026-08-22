/**
 * s2-agent-ext-sv-analyzer tests.
 *
 * Two layers:
 *   1. Factory contract — the extension registers exactly the two tools when
 *      enabled and nothing when `BUN_PI_SV_ANALYZER=0` (mirrors the workspace
 *      extension-isolation-contract assertions, runnable without that suite).
 *   2. WASM end-to-end — drive the shipped `wasm/sv-analyzer.wasm` through
 *      `node:wasi` (the same binary the DSH plugin ships), asserting the
 *      version/analyze/ast ops and the source-resolution + render guards.
 *
 * The wasm is a REGENERATED build artifact (gitignored, never committed —
 * same policy as dsh-plugin/sv-analyzer/plugin/wasm/): dsh-plugin/sv-analyzer/build.sh
 * mirrors it here. The wasm-dependent layers skip when it is absent (a fresh
 * clone runs build.sh first); when present they drive it and fail on staleness.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import entry, { default as extFactory } from "../extensions/sv-analyzer.ts";
import {
	createAnalyzerService,
	defaultWasmPath,
	HINT_AST,
	renderJson,
	resolveCode,
	shExtDir,
} from "../src/analyzer.ts";

const PKG_ROOT = join(import.meta.dir, "..");
const WASM = join(PKG_ROOT, "wasm", "sv-analyzer.wasm");

// The canonical self-test fixture lives with the Rust core (single source of
// truth) — the extension's test reads it read-only; it never ships in a deploy.
const COUNTER = readFileSync(
	join(import.meta.dir, "..", "..", "..", "dsh-plugin", "sv-analyzer", "examples", "counter.sv"),
	"utf8",
);

/** Recording pi mock — same shape as the workspace isolation contract's. */
function recordingPi(): { pi: any; count: () => number } {
	let calls = 0;
	const bump = () => {
		calls++;
	};
	const pi: any = {
		on: bump,
		registerTool: bump,
		registerCommand: bump,
		registerKeybinding: bump,
		registerRenderer: bump,
		sendUserMessage: () => {},
		notify: () => {},
		setStatus: () => {},
		getAllTools: () => [],
		getCommands: () => [],
		getAllToolDefinitions: () => [],
		appendEntry: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	return { pi, count: () => calls };
}

describe("factory contract", () => {
	it("ships a default factory", () => {
		expect(typeof entry).toBe("function");
		expect(extFactory).toBe(entry);
	});

	it("registers the two tools when enabled", () => {
		const saved = process.env.BUN_PI_SV_ANALYZER;
		delete process.env.BUN_PI_SV_ANALYZER;
		try {
			const { pi, count } = recordingPi();
			entry(pi);
			expect(count()).toBe(2);
		} finally {
			if (saved === undefined) delete process.env.BUN_PI_SV_ANALYZER;
			else process.env.BUN_PI_SV_ANALYZER = saved;
		}
	});

	it("registers nothing when BUN_PI_SV_ANALYZER=0", () => {
		const saved = process.env.BUN_PI_SV_ANALYZER;
		process.env.BUN_PI_SV_ANALYZER = "0";
		try {
			const { pi, count } = recordingPi();
			entry(pi);
			expect(count()).toBe(0);
		} finally {
			if (saved === undefined) delete process.env.BUN_PI_SV_ANALYZER;
			else process.env.BUN_PI_SV_ANALYZER = saved;
		}
	});

	it("enabled registration is IO-free (no wasm load at factory time)", () => {
		const saved = process.env.BUN_PI_SV_ANALYZER;
		delete process.env.BUN_PI_SV_ANALYZER;
		try {
			const { pi } = recordingPi();
			// If the factory eagerly compiled the wasm, this would take seconds
			// and touch disk; it must return immediately.
			const t0 = performance.now();
			entry(pi);
			expect(performance.now() - t0).toBeLessThan(1000);
		} finally {
			if (saved === undefined) delete process.env.BUN_PI_SV_ANALYZER;
			else process.env.BUN_PI_SV_ANALYZER = saved;
		}
	});
});

// The wasm is gitignored/regenerated (see header) — both layers below need it,
// so they skip on a fresh clone until dsh-plugin/sv-analyzer/build.sh has run.
describe.skipIf(!existsSync(WASM))("#pi/ext-dir resolution", () => {
	it("shExtDir() resolves to the package root with the wasm beside it", () => {
		const dir = shExtDir();
		expect(dir).toBeString();
		const candidate = defaultWasmPath(dir as string);
		expect(existsSync(candidate)).toBe(true);
	});
});

describe.skipIf(!existsSync(WASM))("wasm end-to-end (node:wasi, same binary as the DSH plugin)", () => {
	it("ships a wasm that answers version", async () => {
		expect(existsSync(WASM)).toBe(true);
		const service = createAnalyzerService({ wasmPath: WASM });
		const analyzer = await service.getAnalyzer();
		const res = await analyzer.call({ op: "version" });
		expect(res.ok).toBe(true);
		const data = res.data as { plugin?: string; grammars?: unknown[] };
		expect(typeof data.plugin).toBe("string");
		expect(Array.isArray(data.grammars)).toBe(true);
	});

	it("analyze: parses counter.sv into design units", async () => {
		const service = createAnalyzerService({ wasmPath: WASM });
		const data = (await service.runAnalyzer(
			"analyze",
			{ code: COUNTER, dialect: "auto" },
			undefined,
			undefined,
		)) as {
			parse_ok: boolean;
			error_count: number;
			design_units: Array<{ name: string; ports: Array<{ name: string; direction: string }> }>;
		};
		expect(data.parse_ok).toBe(true);
		expect(data.error_count).toBe(0);
		const names = data.design_units.map((u) => u.name);
		expect(names).toContain("counter");
		expect(names).toContain("reg_sync");
		const counter = data.design_units.find((u) => u.name === "counter");
		expect(counter?.ports.some((p) => p.name === "clk" && p.direction === "input")).toBe(true);
	});

	it("ast: returns a slim parse-tree payload", async () => {
		const service = createAnalyzerService({ wasmPath: WASM });
		const data = (await service.runAnalyzer(
			"ast",
			{ code: "module m(input a); endmodule", dialect: "auto" },
			undefined,
			undefined,
		)) as { parse_ok: boolean; ast?: { type?: string } };
		expect(data.parse_ok).toBe(true);
		expect(data.ast).toBeDefined();
	});

	it("reports syntax issues on broken source (parse_ok=false)", async () => {
		const service = createAnalyzerService({ wasmPath: WASM });
		const data = (await service.runAnalyzer(
			"analyze",
			{ code: "module broken(input a); output b); endmodule", dialect: "systemverilog" },
			undefined,
			undefined,
		)) as { parse_ok: boolean; error_count: number };
		expect(data.parse_ok).toBe(false);
		expect(data.error_count).toBeGreaterThanOrEqual(1);
	});
});

describe("source + render guards", () => {
	it("resolveCode: rejects a non-HDL file path", () => {
		expect(() => resolveCode({ file: "notes.md" }, undefined, "sv_analyze")).toThrow(/\.v\/\.sv\/\.vh\/\.svh/);
	});

	it("resolveCode: rejects a missing file", () => {
		expect(() => resolveCode({ file: "nope.sv" }, { cwd: "/definitely/not/here" }, "sv_analyze")).toThrow(
			/file not found/,
		);
	});

	it("resolveCode: reads a real file relative to ctx.cwd", () => {
		const code = resolveCode(
			{ file: "counter.sv" },
			{ cwd: join(PKG_ROOT, "..", "..", "dsh-plugin", "sv-analyzer", "examples") },
			"sv_analyze",
		);
		expect(code).toContain("module counter");
	});

	it("resolveCode: inline code wins over an empty file", () => {
		const code = resolveCode({ code: "module inline; endmodule", file: "" }, undefined, "sv_analyze");
		expect(code).toContain("module inline");
	});

	it("renderJson: pretty by default, capped at 256 KiB", () => {
		const small = renderJson({ a: 1 });
		expect(small).toContain('"a": 1');
		const huge = renderJson({ big: "x".repeat(300_000) });
		expect(huge.length).toBeLessThanOrEqual(256 * 1024 + 200);
		expect(huge).toContain("render truncated");
	});

	it("renderJson: default hint tells sv_analyze callers to drop include_ast", () => {
		const huge = renderJson({ big: "x".repeat(300_000) });
		expect(huge).toContain("sv_analyze without include_ast");
	});

	it("renderJson: sv_ast hint never mentions include_ast (no such param there)", () => {
		const huge = renderJson({ big: "x".repeat(300_000) }, HINT_AST);
		expect(huge).toContain("sv_analyze for a summarized design view");
		expect(huge).not.toContain("include_ast");
	});
});
