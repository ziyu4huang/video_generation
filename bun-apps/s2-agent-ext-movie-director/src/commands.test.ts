import { describe, expect, test, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { COMMANDS, commandReferenceBlock, dispatch, type DispatchDeps } from "./dispatch.ts";
import { parseArgs } from "./args.ts";

// Belt-and-suspenders guard: printDispatchResult sets process.exitCode = 1 on
// the error path. If any test forgets to reset it (or a future command leaks
// it), bun test on ubuntu exits 1 despite 0 failures (the PR #522 CI bug).
// This afterAll ensures a clean exitCode after every test in this file.
afterAll(() => {
	process.exitCode = 0;
});

// ─── command table structure ────────────────────────────────────────────────

describe("command table", () => {
	test("exposes exactly the dispatch commands + agent", () => {
		const names = DETERMINISTIC_COMMANDS.map((c) => c.name);
		expect(names).toEqual([...COMMANDS]);
		expect(ALL_NAMES.has("agent")).toBe(true);
		expect(ALL_COMMANDS.length).toBe(COMMANDS.length + 1);
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
		process.exitCode = 0;
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
				process.exitCode = 0;
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
			extPath: "/e/movie-director.ts",
		});
		expect(argv[0]).toBe("bun");
		expect(argv[1]).toBe("/p/pi-cli.ts");
		expect(argv).toContain("--model");
		expect(argv).toContain("sonnet");
		expect(argv).toContain("--provider");
		expect(argv).toContain("-e");
		expect(argv).toContain("/e/movie-director.ts");
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
				exists: (p) => p.endsWith(join("bun-apps", "s2-agent", "src", "cli.ts")),
				dir: join(import.meta.dir, "..", "src"),
			});
			expect(bin).toContain("s2-agent");
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
		expect(ext).toContain("movie-director.ts");
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

// ─── dispatch captions forwarding (Issue A: compose-motion dropped captions) ─
// The `compose` case always forwarded captions, but compose-motion omitted the
// param entirely — the underlying composeMotion() fully supports it. These
// tests prove dispatch forwards the coerced {srtPath, burn} object through to
// the composer via dependency injection (fake spawnImpl — no real ffmpeg).
describe("dispatch captions forwarding (compose-motion)", () => {
	// Minimal fake spawn: ffprobe returns a 2s clip; ffmpeg writes the output
	// path as a placeholder so composeMotion's existsSync checks pass. Matches
	// the pattern in compose_motion.test.ts.
	function fakeSpawn() {
		return async (cmd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
			if (cmd === "ffprobe") {
				if (argv.includes("-show_streams")) {
					return {
						code: 0,
						stdout: JSON.stringify({
							format: { duration: "2.0", format_name: "mov,mp4" },
							streams: [
								{ codec_type: "video", codec_name: "h264", width: 320, height: 180, avg_frame_rate: "30/1" },
								{ codec_type: "audio", codec_name: "aac" },
							],
						}),
						stderr: "",
					};
				}
				return { code: 0, stdout: "2.0\n", stderr: "" };
			}
			// ffmpeg: write the last-arg output path so existsSync passes.
			const out = argv[argv.length - 1];
			if (out) writeFileSync(out, "x");
			return { code: 0, stdout: "", stderr: "" };
		};
	}

	test("forwards captions {srtPath, burn:true} to composeMotion", async () => {
		const dir = mkdtempSync(join(tmpdir(), "md-dispatch-cap-"));
		try {
			const img = join(dir, "a.png");
			writeFileSync(img, "x");
			const srt = join(dir, "caps.srt");
			writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
			const edit = {
				version: "1.0",
				cuts: [{ id: "a", source: img, in_seconds: 0, out_seconds: 2, animation: "ken-burns" }],
				transition: "none",
			};
			// Override pre-compose enforcement so the gate doesn't block the test.
			const res = await dispatch("compose-motion", {
				editDecisions: edit,
				workDir: dir,
				output: join(dir, "out.mp4"),
				width: 320,
				height: 180,
				fps: 10,
				captions: { srtPath: srt, burn: true },
				overridePreCompose: true,
			}, { composeMotionDeps: { spawnImpl: fakeSpawn() } } as DispatchDeps);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const report = JSON.parse(res.text);
			// The captions sub-pass ran: either burned (drawtext/libass) or sidecar'd.
			// On this machine ffmpeg lacks drawtext/subtitles → sidecar note.
			// The KEY assertion: the report acknowledges captions were processed
			// (not silently dropped). The note text comes from motionCaptionNote().
			const captionAck = report.verification_notes?.some((n: string) =>
				n.includes("caption") || n.includes("srt")) ?? false;
			const captionWarn = report.warnings?.some((w: string) =>
				w.includes("caption") || w.includes("srt")) ?? false;
			expect(captionAck || captionWarn).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("omits captions cleanly when not passed (no crash, no caption notes)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "md-dispatch-nocap-"));
		try {
			const img = join(dir, "a.png");
			writeFileSync(img, "x");
			const edit = {
				version: "1.0",
				cuts: [{ id: "a", source: img, in_seconds: 0, out_seconds: 2, animation: "ken-burns" }],
				transition: "none",
			};
			const res = await dispatch("compose-motion", {
				editDecisions: edit,
				workDir: dir,
				output: join(dir, "out.mp4"),
				width: 320,
				height: 180,
				fps: 10,
				overridePreCompose: true,
			}, { composeMotionDeps: { spawnImpl: fakeSpawn() } } as DispatchDeps);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const report = JSON.parse(res.text);
			const hasCaptionNote = report.verification_notes?.some((n: string) =>
				n.includes("caption") || n.includes("srt")) ?? false;
			expect(hasCaptionNote).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── dispatch compose-hyperframes (agent-facing wiring for compose:hyperframes) ─
// renderHyperframes()'s own logic is fully covered by hyperframes_native.test.ts
// (18 tests). These cover only what the dispatch case adds on top of it: the
// missing-editDecisions error contract and pre-compose gate enforcement — the
// same posture as compose-remotion, which has no dispatch-level render test
// either (would require a real hyperframes binary).
describe("dispatch compose-hyperframes", () => {
	test("requires editDecisions.cuts", async () => {
		const res = await dispatch("compose-hyperframes", {});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toBe("compose-hyperframes requires {editDecisions:{version,cuts:[...]}}");
	});

	test("refuses to render on a pre-compose fail verdict (never reaches renderHyperframes)", async () => {
		const res = await dispatch("compose-hyperframes", { editDecisions: { version: "1.0", cuts: [] } });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain("GATE VIOLATION: pre-compose failed");
	});
});

describe("evaluate-lipsync", () => {
	test("requires videoPath", async () => {
		const res = await dispatch("evaluate-lipsync", {});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain("videoPath");
	});

	test("adequate verdict -> lesson.target=memory", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{
				videoPath: "/fake/shot.mp4",
				seed: 501,
				identityRef: "kai_source.png",
				voice: "am_michael",
			},
			{
				runPyLipsyncImpl: async () => ({
					ok: true,
					metrics: { verdict: "adequate", pearson_r: 0.55, mouth_ratio_std: 0.056 },
					error: null,
					stderrTail: "",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.text);
		expect(parsed.lesson.target).toBe("memory");
		expect(parsed.lesson.category).toBe("insight");
		expect(parsed.metrics.verdict).toBe("adequate");
	});

	test("inadequate verdict -> lesson.target=failure", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{
				videoPath: "/fake/shot.mp4",
				seed: 601,
				identityRef: "dov_source_v3.png",
				voice: "am_onyx",
			},
			{
				runPyLipsyncImpl: async () => ({
					ok: true,
					metrics: {
						verdict: "inadequate",
						pearson_r: -0.35,
						mouth_ratio_std: 0.018,
						caveat: "anti-phase",
					},
					error: null,
					stderrTail: "",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.text);
		expect(parsed.lesson.target).toBe("failure");
		expect(parsed.lesson.reason).toBe("anti-phase");
	});

	test("prefers metrics.note over metrics.caveat as the lesson reason when both/either are present", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{ videoPath: "/fake/shot.mp4", identityRef: "dov_source_v3.png", voice: "am_onyx" },
			{
				runPyLipsyncImpl: async () => ({
					ok: true,
					metrics: {
						verdict: "no_face",
						note: "No face detected in any sampled frame.",
						caveat: "should not be used, note takes priority",
					},
					error: null,
					stderrTail: "",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.text);
		expect(parsed.lesson.reason).toBe("No face detected in any sampled frame.");
	});

	test("a non-numeric seed does not leak NaN into the persisted lesson", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{ videoPath: "/fake/shot.mp4", seed: "not-a-number", identityRef: "kai_source.png", voice: "am_michael" },
			{
				runPyLipsyncImpl: async () => ({
					ok: true,
					metrics: { verdict: "adequate", pearson_r: 0.5, mouth_ratio_std: 0.04 },
					error: null,
					stderrTail: "",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.text);
		expect(parsed.lesson.content).not.toContain("NaN");
	});

	test("a numeric-string seed is coerced and included in the lesson", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{ videoPath: "/fake/shot.mp4", seed: "501", identityRef: "kai_source.png", voice: "am_michael" },
			{
				runPyLipsyncImpl: async () => ({
					ok: true,
					metrics: { verdict: "adequate", pearson_r: 0.5, mouth_ratio_std: 0.04 },
					error: null,
					stderrTail: "",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.text);
		expect(parsed.lesson.content).toContain("seed=501");
	});

	test("failure error includes stderrTail when present", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{ videoPath: "/fake/shot.mp4" },
			{
				runPyLipsyncImpl: async () => ({
					ok: false,
					metrics: null,
					error: "lipsync_metrics exited 1",
					stderrTail: "Traceback (most recent call last): boom",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain("exited 1");
		expect(res.error).toContain("Traceback");
	});

	test("propagates a runPyLipsync failure as {ok:false}", async () => {
		const res = await dispatch(
			"evaluate-lipsync",
			{ videoPath: "/fake/shot.mp4" },
			{
				runPyLipsyncImpl: async () => ({
					ok: false,
					metrics: null,
					error: "lipsync_metrics exited 1",
					stderrTail: "Traceback...",
				}),
			} as DispatchDeps,
		);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain("exited 1");
	});
});
