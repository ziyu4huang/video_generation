import { describe, expect, test } from "bun:test";
import { route, executeRoute, VERSION } from "./cli.ts";
import { ALL_NAMES } from "./commands.ts";

describe("route — version", () => {
	test("--version flag", () => {
		expect(route(["--version"])).toEqual({ kind: "version" });
	});
	test("-v short flag", () => {
		expect(route(["-v"])).toEqual({ kind: "version" });
	});
	test("version meta token", () => {
		expect(route(["version"])).toEqual({ kind: "version" });
	});
	test("--version mixed with a command still routes to version", () => {
		expect(route(["preflight", "--version"])).toEqual({ kind: "version" });
	});
});

describe("route — help", () => {
	test("no args → root help", () => {
		expect(route([])).toEqual({ kind: "help" });
	});
	test("help token → root help (no target)", () => {
		expect(route(["help"])).toEqual({ kind: "help" });
	});
	test("help <cmd> → help with target", () => {
		expect(route(["help", "preflight"])).toEqual({ kind: "help", target: "preflight" });
	});
	test("<cmd> --help → help targeting that command", () => {
		expect(route(["preflight", "--help"])).toEqual({ kind: "help", target: "preflight" });
	});
	test("-h short flag", () => {
		expect(route(["-h"])).toEqual({ kind: "help" });
	});
});

describe("route — known commands", () => {
	test("every deterministic command name routes to command", () => {
		for (const name of ALL_NAMES) {
			if (name === "agent") continue;
			expect(route([name])).toEqual({ kind: "command", name });
		}
	});
	test("agent routes to command", () => {
		expect(route(["agent", "produce", "x"])).toEqual({ kind: "command", name: "agent" });
	});
	test("global flags before the command do not break routing", () => {
		expect(route(["--model", "sonnet", "preflight"])).toEqual({ kind: "command", name: "preflight" });
	});
	test("command with options still routes by the command name", () => {
		expect(route(["pipeline-show", "--pipeline", "talking-head"])).toEqual({ kind: "command", name: "pipeline-show" });
	});
});

describe("route — agent passthrough", () => {
	test("unknown first positional → agent-passthrough", () => {
		expect(route(["produce", "a", "30s", "ad"])).toEqual({ kind: "agent-passthrough" });
	});
	test("a bare natural-language prompt → agent-passthrough", () => {
		expect(route(["plan", "a", "video"])).toEqual({ kind: "agent-passthrough" });
	});
	test("global flags + unknown positional → agent-passthrough", () => {
		expect(route(["--model", "sonnet", "make", "a", "clip"])).toEqual({ kind: "agent-passthrough" });
	});
});

// ─── CI-safe execution tests (no spawn — run on ALL runners) ────────────────
// These mirror the 8 subprocess tests below, but call executeRoute() directly
// (route → execute → dispatch → stdout) with captured console. CI gets REAL
// execution coverage of the CLI logic; the subprocess tests below stay
// locally-gated to verify the full `bun cli.ts` binary path.
describe("CLI execution (CI-safe, no spawn)", () => {
	function capture() {
		const log = console.log;
		const err = console.error;
		const out: string[] = [];
		const errOut: string[] = [];
		console.log = (...a: unknown[]) => out.push(a.join(" "));
		console.error = (...a: unknown[]) => errOut.push(a.join(" "));
		return {
			stdout: () => out.join("\n"),
			stderr: () => errOut.join("\n"),
			restore() {
				console.log = log;
				console.error = err;
				process.exitCode = 0;
			},
		};
	}

	test("version prints the version line", async () => {
		const cap = capture();
		try {
			await executeRoute(route(["--version"]), ["--version"]);
			expect(cap.stdout().trim()).toBe(`movie-director ${VERSION}`);
		} finally {
			cap.restore();
		}
	});

	test("no args → root help lists the commands", async () => {
		const cap = capture();
		try {
			await executeRoute(route([]), []);
			const out = cap.stdout();
			expect(out).toContain("movie-director");
			expect(out).toContain("preflight");
			expect(out).toContain("pipeline-list");
			expect(out).toContain("agent");
		} finally {
			cap.restore();
		}
	});

	test("help preflight prints the preflight reference block", async () => {
		const cap = capture();
		try {
			await executeRoute(route(["help", "preflight"]), ["help", "preflight"]);
			expect(cap.stdout()).toContain("provider-menu summary");
		} finally {
			cap.restore();
		}
	});

	test("preflight runs dispatch end-to-end and prints JSON", async () => {
		const cap = capture();
		try {
			await executeRoute(route(["preflight"]), ["preflight"]);
			const parsed = JSON.parse(cap.stdout());
			expect(Array.isArray(parsed.capabilities)).toBe(true);
		} finally {
			cap.restore();
		}
	});

	test("pipeline-list lists talking-head", async () => {
		const cap = capture();
		try {
			await executeRoute(route(["pipeline-list"]), ["pipeline-list"]);
			expect(JSON.parse(cap.stdout())).toContain("talking-head");
		} finally {
			cap.restore();
		}
	});

	test("--json wraps pipeline-list in an envelope", async () => {
		const cap = capture();
		try {
			await executeRoute(route(["pipeline-list", "--json"]), ["pipeline-list", "--json"]);
			const parsed = JSON.parse(cap.stdout());
			expect(parsed).toEqual({ ok: true, command: "pipeline-list", result: expect.any(Array) });
		} finally {
			cap.restore();
		}
	});

	test("init-project with no args → exitCode 1 + stderr error", async () => {
		const cap = capture();
		try {
			await executeRoute(route(["init-project"]), ["init-project"]);
			expect(process.exitCode).toBe(1);
			expect(cap.stderr()).toMatch(/projectId|pipeline/i);
		} finally {
			cap.restore();
		}
	});

	test("help <unknown> → exitCode 1 + stderr", async () => {
		const cap = capture();
		try {
			await executeRoute(route(["help", "nosuchcmd"]), ["help", "nosuchcmd"]);
			expect(process.exitCode).toBe(1);
			expect(cap.stderr()).toContain("Unknown command");
		} finally {
			cap.restore();
		}
	});
});

// ─── integration: real CLI runs (safe, no-spawn paths) ──────────────────────

/** Run the CLI as a real subprocess and capture stdout/stderr/exit. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const path = await import("node:path");
	const entry = path.join(import.meta.dir, "cli.ts");
	const proc = Bun.spawn(["bun", entry, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_BIN: "/nonexistent/override" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

// Real-subprocess smoke tests: spawn `bun cli.ts <args>` and capture stdout/exit.
// Gated off CI (portability P2: Bun.spawn is a host-binary coupling) — see
// .github/TEST-PORTABILITY.md. They run locally (verified) but skip on bare
// CI runners, matching gui-movie-director/scripts/check-runtime.test.ts.
describe.skipIf(!!process.env.CI)("CLI integration (subprocess)", () => {
	test("--version prints the version line", async () => {
		const r = await runCli(["--version"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toMatch(/^movie-director\b/);
	});

	test("no args → root help lists the commands", async () => {
		const r = await runCli([]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("movie-director");
		expect(r.stdout).toContain("preflight");
		expect(r.stdout).toContain("pipeline-list");
		expect(r.stdout).toContain("agent");
	});

	test("help preflight prints the preflight reference block", async () => {
		const r = await runCli(["help", "preflight"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("provider-menu summary");
	});

	test("preflight runs dispatch end-to-end and prints JSON", async () => {
		const r = await runCli(["preflight"]);
		expect(r.exitCode).toBe(0);
		const parsed = JSON.parse(r.stdout);
		expect(Array.isArray(parsed.capabilities)).toBe(true);
	});

	test("pipeline-list lists talking-head", async () => {
		const r = await runCli(["pipeline-list"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toContain("talking-head");
	});

	test("--json wraps pipeline-list in an envelope", async () => {
		const r = await runCli(["pipeline-list", "--json"]);
		expect(r.exitCode).toBe(0);
		const parsed = JSON.parse(r.stdout);
		expect(parsed).toEqual({ ok: true, command: "pipeline-list", result: expect.any(Array) });
	});

	test("init-project with no args → exitCode 1 + stderr error", async () => {
		const r = await runCli(["init-project"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toMatch(/projectId|pipeline/i);
	});

	test("help <unknown> → exitCode 1 + stderr", async () => {
		const r = await runCli(["help", "nosuchcmd"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Unknown command");
	});
});
