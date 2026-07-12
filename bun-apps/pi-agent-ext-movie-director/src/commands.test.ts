import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ALL_COMMANDS,
	ALL_NAMES,
	COMMAND_NAMES,
	DETERMINISTIC_COMMANDS,
	agentCommand,
	buildAgentArgv,
	buildAgentTask,
	findCommand,
	resolveExtensionPath,
	resolvePiBin,
} from "./commands.ts";
import { COMMANDS, commandReferenceBlock } from "./dispatch.ts";
import { parseArgs } from "./args.ts";

// ─── command table structure ────────────────────────────────────────────────

describe("command table", () => {
	test("exposes exactly the 18 dispatch commands + agent", () => {
		const names = DETERMINISTIC_COMMANDS.map((c) => c.name);
		expect(names).toEqual([...COMMANDS]);
		expect(ALL_NAMES.has("agent")).toBe(true);
		expect(ALL_COMMANDS.length).toBe(18 + 1);
	});

	test("every command has a non-empty name, summary, details, and run", () => {
		for (const c of ALL_COMMANDS) {
			expect(c.name.length).toBeGreaterThan(0);
			expect(c.summary.length).toBeGreaterThan(5);
			expect(c.details.length).toBeGreaterThan(20);
			expect(typeof c.run).toBe("function");
		}
	});

	test("each deterministic command's details equals its dispatch reference block", () => {
		for (const c of DETERMINISTIC_COMMANDS) {
			expect(c.details).toBe(commandReferenceBlock(c.name));
		}
	});

	test("findCommand resolves known + returns undefined for unknown", () => {
		expect(findCommand("preflight")?.name).toBe("preflight");
		expect(findCommand("agent")?.name).toBe("agent");
		expect(findCommand("nope")).toBeUndefined();
	});

	test("agent command is the last entry and named 'agent'", () => {
		expect(agentCommand.name).toBe("agent");
		expect(ALL_COMMANDS[ALL_COMMANDS.length - 1]).toBe(agentCommand);
	});
});

// ─── deterministic command execution (no-LLM, no-spawn subset) ───────────────

describe("deterministic command.run (end-to-end via dispatch)", () => {
	// Restore exitCode around each run — printDispatchResult sets it on error.
	function capture() {
		const orig = process.exitCode;
		process.exitCode = undefined as unknown as number;
		const log = console.log;
		const err = console.error;
		const out: string[] = [];
		const errOut: string[] = [];
		console.log = (...a: unknown[]) => out.push(a.join(" "));
		console.error = (...a: unknown[]) => errOut.push(a.join(" "));
		return {
			out, errOut,
			restore() {
				console.log = log;
				console.error = err;
				process.exitCode = orig;
			},
		};
	}

	test("preflight prints the provider-menu summary JSON", async () => {
		const cap = capture();
		try {
			await findCommand("preflight")!.run(parseArgs([]));
			const parsed = JSON.parse(cap.out.join("\n"));
			expect(Array.isArray(parsed.capabilities)).toBe(true);
			expect(parsed.composition_runtimes).toBeDefined();
		} finally {
			cap.restore();
		}
	});

	test("pipeline-list lists the bundled manifests", async () => {
		const cap = capture();
		try {
			await findCommand("pipeline-list")!.run(parseArgs([]));
			const parsed = JSON.parse(cap.out.join("\n"));
			expect(parsed).toContain("talking-head");
		} finally {
			cap.restore();
		}
	});

	test("pipeline-show forwards --pipeline as an option", async () => {
		const cap = capture();
		try {
			await findCommand("pipeline-show")!.run(parseArgs(["--pipeline", "talking-head"]));
			const parsed = JSON.parse(cap.out.join("\n"));
			expect(parsed.name).toBe("talking-head");
			expect(Array.isArray(parsed.stages)).toBe(true);
		} finally {
			cap.restore();
		}
	});

	test("missing required field → exitCode 1 + stderr error (no throw)", async () => {
		const cap = capture();
		try {
			// init-project requires projectId + pipeline; omitting both → {ok:false}.
			await findCommand("init-project")!.run(parseArgs([]));
			expect(process.exitCode).toBe(1);
			expect(cap.errOut.join(" ")).toMatch(/projectId|pipeline/i);
		} finally {
			cap.restore();
		}
	});

	test("--json wraps the result in an {ok, command, result} envelope", async () => {
		const cap = capture();
		try {
			await findCommand("pipeline-list")!.run(parseArgs(["--json"]));
			const parsed = JSON.parse(cap.out.join("\n"));
			expect(parsed).toEqual({ ok: true, command: "pipeline-list", result: expect.any(Array) });
		} finally {
			cap.restore();
		}
	});

	test("--options JSON merge is forwarded (init-project via --options)", async () => {
		const cap = capture();
		try {
			await findCommand("init-project")!.run(
				parseArgs(["--options", '{"projectId":"cli-t","pipeline":"talking-head"}']),
			);
			const parsed = JSON.parse(cap.out.join("\n"));
			expect(parsed.projectId).toBe("cli-t");
			expect(parsed.projectDir).toContain("cli-t");
		} finally {
			cap.restore();
		}
	});
});

// ─── agent command helpers (pure, no spawn) ─────────────────────────────────

describe("agent command — pure helpers", () => {
	test("buildAgentTask folds positionals+doubleDash into the request", () => {
		const t = buildAgentTask(parseArgs(["agent", "produce", "a", "30s", "ad"]));
		expect(t).toContain("produce a 30s ad");
		expect(t).toContain("Use the movie tool");
	});

	test("buildAgentTask with no request → the infer-intent prompt", () => {
		const t = buildAgentTask(parseArgs(["agent"]));
		expect(t).toContain("Ask or infer");
	});

	test("buildAgentTask respects -- verbatim tokens", () => {
		const t = buildAgentTask(parseArgs(["agent", "--", "compose", "--plan", "x.json"]));
		expect(t).toContain("compose --plan x.json");
	});

	test("buildAgentArgv forwards globals + extension + prompt", () => {
		const argv = buildAgentArgv(parseArgs(["--model", "sonnet", "--provider", "lm-studio", "agent", "hi"]), {
			piBin: "/p/pi-cli.ts",
			extPath: "/e/pi-movie-director.ts",
		});
		expect(argv[0]).toBe("bun");
		expect(argv[1]).toBe("/p/pi-cli.ts");
		expect(argv).toContain("--model");
		expect(argv).toContain("sonnet");
		expect(argv).toContain("--provider");
		expect(argv).toContain("-e");
		expect(argv).toContain("/e/pi-movie-director.ts");
		expect(argv).toContain("-p");
		// the prompt token references the task builder output
		const promptIdx = argv.indexOf("-p");
		expect(argv[promptIdx + 1]).toContain("hi");
	});

	test("resolvePiBin prefers PI_BIN when it exists", () => {
		const prev = process.env.PI_BIN;
		process.env.PI_BIN = "/custom/pi";
		try {
			expect(resolvePiBin({ exists: () => true })).toBe("/custom/pi");
		} finally {
			if (prev === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = prev;
		}
	});

	test("resolvePiBin falls back to the in-repo binary (injected exists)", () => {
		const prev = process.env.PI_BIN;
		delete process.env.PI_BIN;
		try {
			const bin = resolvePiBin({
				exists: (p) => p.endsWith(join("bun-apps", "pi-agent", "src", "cli.ts")),
				dir: join(import.meta.dir, "..", "src"),
			});
			expect(bin).toContain("pi-agent");
			expect(bin).toContain("cli.ts");
		} finally {
			if (prev !== undefined) process.env.PI_BIN = prev;
		}
	});

	test("resolveExtensionPath points at the extension factory", () => {
		const ext = resolveExtensionPath({
			exists: () => true,
			dir: join(import.meta.dir, "..", "src"),
		});
		expect(ext).toContain("pi-movie-director.ts");
	});

	test("resolvePiBin throws a clear error when nothing resolves", () => {
		const prev = process.env.PI_BIN;
		delete process.env.PI_BIN;
		try {
			expect(() => resolvePiBin({ exists: () => false })).toThrow(/PI_BIN/);
		} finally {
			if (prev !== undefined) process.env.PI_BIN = prev;
		}
	});
});
