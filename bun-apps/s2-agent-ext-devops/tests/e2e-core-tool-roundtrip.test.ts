/**
 * e2e-core-tool-roundtrip — L2: a REAL model round trip that EXECUTES core
 * tools and writes a verifiable artifact (the user's 3-in-1 check, hardened).
 *
 * WHY THIS EXISTS
 * ---------------
 * The offline layers prove the ACTIVE toolset is right (deploy-e2e's
 * tools-probe) and that extensions register (deploy-probe-e2e's probes) — but
 * #1946 shipped two toolless deploys past a boot gate, an ext-load gate AND a
 * bare model-call gate, because "Reply with exactly: ok" exercises no tool.
 * This suite closes the loop end-to-end through the DEV launcher:
 *
 *   1. model round trip       (deepseek/deepseek-v4-flash-vision-exp — the
 *      ONLY lane since the 2026-08-24 operator directive: LM Studio is
 *      banished from E2E/CI; under multi-model contention it generated at
 *      10 tok/31.7s (measured 2026-08-23) and a 68-tool context pushed a
 *      simple 3-in-1 past the 300s watchdog — the run-too-long class)
 *   2. tool execution        (inspect_context — power-tool's seam reader)
 *   3. file write            (the pi `write` builtin — the exact capability
 *      the #1946 class removed)
 *
 * VERDICT = the ARTIFACT: the model must write inspect-context.md into the
 * tmp cwd whose CONTENT carries inspect_context's stable section markers.
 * Marker-based, never exact-text — model prose varies, section headers do not.
 *
 * A provider/auth failure is a SKIP (classifyRun semantics — same contract as
 * deploy-e2e's model-call probe), never a false FAIL; anything else that goes
 * wrong (timeout, nonzero exit, missing/short/marker-less artifact) FAILS.
 *
 * Gated on PI_AGENT_E2E like the other real-session suites; wired into
 * scripts/check-deploy-e2e.sh so local_ci's regression-gates lane runs it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = process.env.PI_AGENT_E2E === "1";
const describeE2E = RUN ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const LAUNCHER = join(REPO_ROOT, "s2-agent.sh");

// AGENT-DIR ISOLATION (2026-08-24): a successful round trip makes the DEV
// launcher write prompt-history under its per-user agent dir — the REAL
// ~/.pi/agent unless redirected. deploy-probe-e2e (which runs CONCURRENTLY
// inside this gate's single `bun test` invocation) snapshots the real
// prompt-history root and fails on any dir added during its window, so an
// unisolated successful run here is a flaky cross-suite failure AND a real
// per-user write. Same fix as deploy-probe-e2e (2026-08-22): derive the
// agent-dir env name from s2-agent's package.json — the binary reads
// `S2-AGENT_CODING_AGENT_DIR` (DASH included) and IGNORES plain PI_*.
const S2_AGENT_NAME = (
	JSON.parse(readFileSync(join(REPO_ROOT, "bun-apps", "s2-agent", "package.json"), "utf8")) as {
		piConfig: { name: string };
	}
).piConfig.name;
const isolatedAgentDirEnv = (piHome: string): Record<string, string> => ({
	PI_CODING_AGENT_DIR: piHome,
	[`${S2_AGENT_NAME.toUpperCase()}_CODING_AGENT_DIR`]: piHome,
});

/** The ONLY lane (2026-08-24 operator directive): deepseek flash-vision — LM
 * Studio is banished from E2E/CI entirely (multi-model contention generated at
 * 10 tok/31.7s measured 2026-08-23, and a 68-tool context under it pushed a
 * simple 3-in-1 past the 300s watchdog — the exact run-too-long class the
 * directive targets). A provider/auth failure on this lane is a SKIP
 * (classifyRun semantics), never a false FAIL. */
const PRIMARY_MODEL = "deepseek/deepseek-v4-flash-vision-exp";
const PRIMARY_CAP_MS = 90_000; // flash-vision completes the 3-in-1 well under 60s; 90s = slow-network headroom

// Prompt shape matters (measured 2026-08-24): a bare "write its complete
// output" occasionally made the model NARRATE the plan ("Now I'll write the
// complete output to inspect-context.md …") and end the turn without ever
// calling `write` — exit 0, no artifact. The explicit "call the write tool
// FIRST / do not print the report in your reply" shape closes that mode, and
// the one artifact-retry below absorbs the residual flake.
const PROMPT =
	"Run the inspect_context tool, then CALL the write tool to save its report to a file named inspect-context.md in the current working directory. Use the write tool in this turn — do not just describe what you will write. Do not print the whole report in your reply. Do not ask questions.";

/** Stable section markers of inspect_context's report (src/tools/inspect-context.ts). */
const CONTENT_MARKERS = ["Inspect Context", "Token budget", "System prompt text"];

interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	ms: number;
}

/** Spawn the dev launcher headless with a hard kill cap. */
async function runOnce(model: string, capMs: number, cwd: string): Promise<RunResult> {
	const t0 = Date.now();
	// Isolated per-run agent dir: per-user writes (prompt-history) land in the
	// run's tmp cwd tree, never the operator's ~/.pi (see AGENT-DIR ISOLATION
	// above). Auth flows through env keys (DEEPSEEK_API_KEY / ZAI_API_KEY),
	// the same contract check-deploy-e2e.sh guarantees for the probe suites.
	const proc = Bun.spawn(["bash", LAUNCHER, "--model", model, "-p", PROMPT, "--no-session"], {
		cwd,
		env: { ...process.env, ...isolatedAgentDirEnv(join(cwd, "pi-home")) },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => {
		try {
			proc.kill(9);
		} catch {
			/* already exited */
		}
	}, capMs);
	let stdout = "";
	let stderr = "";
	try {
		[stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
	} finally {
		clearTimeout(timer);
	}
	const code = await proc.exited;
	return { stdout, stderr, code, timedOut: code === null || code < 0, ms: Date.now() - t0 };
}

/** Fast provider/auth failure detection (mirrors oneshot-smoke's shape). */
function smellsLikeProviderFailure(r: RunResult): boolean {
	const text = `${r.stdout}\n${r.stderr}`;
	return r.code !== 0 && !r.timedOut && r.ms <= 10_000 && /provider|api.?key|auth|no matching/i.test(text);
}

function assertArtifact(cwd: string, r: RunResult, model: string): void {
	const path = join(cwd, "inspect-context.md");
	if (!existsSync(path)) {
		throw new Error(
			`model ${model} finished but wrote no inspect-context.md (exit=${r.code}, ${r.ms}ms).\n` +
				`stdout tail: ${r.stdout.slice(-400)}\nstderr tail: ${r.stderr.slice(-400)}`,
		);
	}
	const content = readFileSync(path, "utf8");
	expect(content.length, "written report is suspiciously short").toBeGreaterThan(400);
	for (const marker of CONTENT_MARKERS) {
		expect(content, `report missing inspect_context section '${marker}'`).toContain(marker);
	}
}

describeE2E("core-tool roundtrip (model → inspect_context → write)", () => {
	test("3-in-1: deepseek flash-vision executes inspect_context and writes the report", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "e2e-write-"));
		try {
			let r = await runOnce(PRIMARY_MODEL, PRIMARY_CAP_MS, cwd);
			// Artifact-retry (once): an exit-0 run that wrote nothing is the
			// narrate-but-don't-write flake, not a tool failure — one immediate
			// retry is far cheaper than a false FAIL.
			if (!r.timedOut && r.code === 0 && !existsSync(join(cwd, "inspect-context.md"))) {
				console.error(`[e2e-write] primary ${PRIMARY_MODEL} finished (${r.ms}ms) but wrote no artifact — retrying once`);
				r = await runOnce(PRIMARY_MODEL, PRIMARY_CAP_MS, cwd);
			}
			if (!r.timedOut && r.code === 0) {
				assertArtifact(cwd, r, PRIMARY_MODEL);
				return; // GREEN — the fast remote lane the operator wants
			}
			if (smellsLikeProviderFailure(r)) {
				console.error(`[e2e-write] SKIP: ${PRIMARY_MODEL} provider/auth failed: ${r.stderr.slice(0, 200)}`);
				return;
			}
			expect(r.timedOut, `${PRIMARY_MODEL} timed out after ${PRIMARY_CAP_MS}ms`).toBe(false);
			expect(r.code, `${PRIMARY_MODEL} exited nonzero:\n${r.stderr.slice(-400)}`).toBe(0);
			assertArtifact(cwd, r, PRIMARY_MODEL);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 300_000);
});
