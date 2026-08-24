/**
 * session-doctor-cli — pure-logic tests (argv parsing, banner/table parsing,
 * verdict classification). The spawn surface is injected and faked; the two
 * verdict classes pinned here are the failure signatures named by the
 * 2026-08-24 deploy-toolless RCA (all=[] toolless; active=[] wiped).
 */
import { describe, test, expect } from "bun:test";
import {
	parseSessionDoctorArgs,
	parseToolGateBanner,
	parseListModelTable,
	verdictFromProbeRun,
	classifyToolsPayload,
	classifyProviderReadiness,
	isLocalProvider,
	customProviderMap,
} from "../src/session-doctor-cli.ts";
import type { ToolsProbePayload } from "../src/tools-active-probe.js";

describe("parseSessionDoctorArgs", () => {
	test("defaults: dev target, local lm-studio lane", () => {
		const r = parseSessionDoctorArgs([]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.target).toBe("dev");
			expect(r.args.provider).toBe("lm-studio");
			expect(r.args.model).toBe("qwen/qwen3.8-27b");
		}
	});
	test("deploy target + model override", () => {
		const r = parseSessionDoctorArgs(["--target", "deploy", "--provider", "deepseek", "--model", "deepseek-v4-flash"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.target).toBe("deploy");
			expect(r.args.provider).toBe("deepseek");
		}
	});
	test("bad target / unknown flag / missing value are usage errors", () => {
		expect(parseSessionDoctorArgs(["--target", "staging"])).toEqual({ ok: false, message: "--target must be dev|deploy, got 'staging'" });
		expect(parseSessionDoctorArgs(["--wat"])).toEqual({ ok: false, message: "unknown flag: --wat" });
		expect(parseSessionDoctorArgs(["--deploy-root"])).toEqual({ ok: false, message: "--deploy-root needs a value" });
	});
});

describe("parseToolGateBanner", () => {
	test("extracts N/M from a footer line", () => {
		expect(parseToolGateBanner(" 🔧 Tool gate: 26/66 active\n saves ~14056 tok/req")).toEqual({ active: 26, total: 66 });
	});
	test("extracts the wiped signature 0/0", () => {
		expect(parseToolGateBanner("Tool gate: 0/0 active")).toEqual({ active: 0, total: 0 });
	});
	test("null when absent", () => {
		expect(parseToolGateBanner("no banner here")).toBeNull();
	});
});

describe("parseListModelTable", () => {
	test("groups model ids by provider, skipping the header", () => {
		const table = [
			"provider     model                                context  max-out  thinking  images",
			"lm-studio    qwen/qwen3.8-27b                     200K     65.5K    yes       yes",
			"lm-studio    google/gemma-4-12b                   200K     65.5K    yes       yes",
			"zai          glm-5.3                              1M       131.1K   yes       no",
		].join("\n");
		expect(parseListModelTable(table)).toEqual({
			"lm-studio": ["qwen/qwen3.8-27b", "google/gemma-4-12b"],
			zai: ["glm-5.3"],
		});
	});
});

describe("classifyToolsPayload / verdictFromProbeRun", () => {
	const base = { target: "deploy (x)", provider: "lm-studio", model: "qwen/qwen3.8-27b" };
	const payload = (over: Partial<ToolsProbePayload>): ToolsProbePayload => ({
		total: 66,
		matched: 0,
		activeCount: 26,
		active: ["read", "write", "edit", "bash", "grep"],
		missing: [],
		gateSeam: null,
		getActiveTools: true,
		...over,
	});

	test("healthy payload passes with counts; absent gate seam noted as expected (#1952)", () => {
		const r = classifyToolsPayload(payload({}));
		expect(r.verdict).toBe("pass");
		expect(r.note).toContain("active=26/66");
		expect(r.note).toContain("tool-gate off/absent");
	});

	test("total=0 is the TOOLLESS failure class", () => {
		const r = classifyToolsPayload(payload({ total: 0, activeCount: 0, active: [] }));
		expect(r.verdict).toBe("fail");
		expect(r.failureClass).toBe("TOOLLESS");
	});

	test("registered but activeCount=0 is the ACTIVE-SET-WIPED class (#1946)", () => {
		const r = classifyToolsPayload(payload({ activeCount: 0, active: [] }));
		expect(r.verdict).toBe("fail");
		expect(r.failureClass).toBe("ACTIVE-SET-WIPED");
		expect(r.note).toContain("#1946");
	});

	test("missing core builtins is the CORE-BUILTINS-MISSING class (#1952 half-fix)", () => {
		const r = classifyToolsPayload(payload({ missing: ["write", "edit"] }));
		expect(r.verdict).toBe("fail");
		expect(r.failureClass).toBe("CORE-BUILTINS-MISSING");
		expect(r.note).toContain("write, edit");
	});

	test("getActiveTools surface gone / threw = SURFACE-REGRESSED", () => {
		expect(classifyToolsPayload(payload({ getActiveTools: false })).failureClass).toBe("SURFACE-REGRESSED");
		expect(classifyToolsPayload(payload({ getError: "boom" })).failureClass).toBe("SURFACE-REGRESSED");
	});

	test("gate seam reported in the note when present", () => {
		const r = classifyToolsPayload(payload({ gateSeam: { activeCount: 26, totalCount: 66, coreCount: 4 } }));
		expect(r.note).toContain("gate seam 26/66");
	});

	test("verdictFromProbeRun parses the [TOOLS] stderr line end-to-end", () => {
		const stderr = `[TOOLS] ${JSON.stringify(payload({}))}`;
		const r = verdictFromProbeRun(base.target, base.provider, base.model, {
			stdout: "",
			stderr,
			exitCode: 0,
			durationMs: 4000,
		});
		expect(r.verdict).toBe("pass");
		expect(r.activeTools).toEqual(["read", "write", "edit", "bash", "grep"]);
		expect(r.total).toBe(66);
	});

	test("missing [TOOLS] line: fast provider failure = skip, timeout = fail (classifyRun contract)", () => {
		const skip = verdictFromProbeRun(base.target, base.provider, base.model, {
			stdout: "",
			stderr: "Error: provider lm-studio unavailable (ECONNREFUSED)",
			exitCode: 1,
			durationMs: 900,
		});
		expect(skip.verdict).toBe("skip");
		const timeout = verdictFromProbeRun(base.target, base.provider, base.model, {
			stdout: "",
			stderr: "",
			exitCode: 124,
			timedOut: true,
			durationMs: 240_000,
		});
		expect(timeout.verdict).toBe("fail");
		expect(timeout.note).toContain("timed out");
	});
});

describe("--models static readiness", () => {
	const modelsJson = {
		providers: {
			"lm-studio": { baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio" },
			"my-remote": { baseUrl: "https://api.example.com/v1", apiKey: "sk-x" },
			"no-key-remote": { baseUrl: "https://api.example.com/v1" },
		},
	};
	const authJson = { deepseek: { type: "api_key", key: "sk-y" } };

	test("stored credential owns the provider (auth.json entry)", () => {
		expect(classifyProviderReadiness("deepseek", authJson, modelsJson, {})).toEqual({
			ready: true,
			source: "stored-credential",
		});
	});
	test("custom-provider apiKey counts as configured (models.json)", () => {
		expect(classifyProviderReadiness("my-remote", null, modelsJson, {})).toEqual({
			ready: true,
			source: "custom-provider",
		});
	});
	test("provider env key counts as configured", () => {
		expect(classifyProviderReadiness("zai", null, null, { ZAI_API_KEY: "k" })).toEqual({
			ready: true,
			source: "env-key",
		});
		expect(classifyProviderReadiness("anthropic", null, null, { ANTHROPIC_AUTH_TOKEN: "t" })).toEqual({
			ready: true,
			source: "env-key",
		});
	});
	test("no signal anywhere = blocked with a reason", () => {
		const r = classifyProviderReadiness("openai", null, modelsJson, {});
		expect(r.ready).toBe(false);
		if (!r.ready) expect(r.reason).toContain("no-credential");
	});
	test("null/absent state files are tolerated (no throw, no signal)", () => {
		expect(classifyProviderReadiness("openai", null, null, {})).toEqual({
			ready: false,
			reason: expect.stringContaining("no-credential"),
		});
	});

	test("localhost custom providers are identified; remotes are not", () => {
		expect(isLocalProvider(modelsJson, "lm-studio")).toBe(true);
		expect(isLocalProvider(modelsJson, "my-remote")).toBe(false);
		expect(isLocalProvider(null, "lm-studio")).toBe(false);
	});
	test("customProviderMap tolerates non-object input", () => {
		expect(customProviderMap("junk")).toEqual({});
		expect(customProviderMap({ providers: { a: { apiKey: "k" } } })).toEqual({ a: { apiKey: "k" } });
	});
});
