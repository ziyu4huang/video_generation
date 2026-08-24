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
 *   1. local-LLM round trip  (LM Studio qwen3.8-27b-nothink — also pins the
 *      nothink model-id wiring: thinking-capable ids hang local generation)
 *   2. tool execution        (inspect_context — power-tool's seam reader)
 *   3. file write            (the pi `write` builtin — the exact capability
 *      the #1946 class removed)
 *
 * VERDICT = the ARTIFACT: the model must write inspect-context.md into the
 * tmp cwd whose CONTENT carries inspect_context's stable section markers.
 * Marker-based, never exact-text — model prose varies, section headers do not.
 *
 * FALLBACK (measured, not guessed): if the primary model is absent from the
 * endpoint, or its run exceeds 60s (the operator's too-slow threshold — LM
 * Studio under multi-model contention generates at 10 tok/31.7s, measured
 * 2026-08-23), the run is killed and retried once with
 * deepseek/deepseek-v4-flash-vision-exp (cap 180s). A provider/auth failure on
 * the fallback is a SKIP (classifyRun semantics — same contract as deploy-e2e's
 * model-call probe), never a false FAIL.
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

const PRIMARY_MODEL = "qwen/qwen3.8-27b-nothink";
/** The id LM Studio actually serves (nothink is pi's thinking-off variant). */
const PRIMARY_SERVED_ID = "qwen/qwen3.8-27b";
const FALLBACK_MODEL = "deepseek/deepseek-v4-flash-vision-exp";
const PRIMARY_CAP_MS = 60_000; // the operator's too-slow threshold
const FALLBACK_CAP_MS = 180_000;

const PROMPT =
	"Run the inspect_context tool, then write its complete output to a file named inspect-context.md in the current working directory. Do not ask questions.";

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
	const proc = Bun.spawn(["bash", LAUNCHER, "--model", model, "-p", PROMPT, "--no-session"], {
		cwd,
		env: { ...process.env },
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

/** Is the primary model currently served? (3s bounded; endpoint down → false) */
async function primaryServed(endpoint: string): Promise<boolean> {
	try {
		const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/models`, { signal: AbortSignal.timeout(3_000) });
		if (!res.ok) return false;
		const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
		const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? "")) : [];
		return ids.includes(PRIMARY_SERVED_ID);
	} catch {
		return false;
	}
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

describeE2E("core-tool roundtrip (local LLM → inspect_context → write)", () => {
	test("3-in-1: nothink local model executes inspect_context and writes the report", async () => {
		const endpoint = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234";
		const cwd = mkdtempSync(join(tmpdir(), "e2e-write-"));
		try {
			// Primary lane: only when the model is actually served — an absent
			// model must route to the fallback, never false-fail.
			if (await primaryServed(endpoint)) {
				const r = await runOnce(PRIMARY_MODEL, PRIMARY_CAP_MS, cwd);
				if (!r.timedOut && r.code === 0) {
					assertArtifact(cwd, r, PRIMARY_MODEL);
					return; // GREEN via the local lane — the cheap path the operator wants
				}
				if (smellsLikeProviderFailure(r)) {
					console.error(`[e2e-write] primary ${PRIMARY_MODEL} provider-failed in ${r.ms}ms — falling back`);
				} else {
					console.error(
						`[e2e-write] primary ${PRIMARY_MODEL} too slow or failed (timedOut=${r.timedOut}, exit=${r.code}, ${r.ms}ms) — falling back to ${FALLBACK_MODEL}`,
					);
				}
			} else {
				console.error(`[e2e-write] ${PRIMARY_SERVED_ID} not served at ${endpoint} — going straight to fallback`);
			}

			// Fallback lane.
			const f = await runOnce(FALLBACK_MODEL, FALLBACK_CAP_MS, cwd);
			if (smellsLikeProviderFailure(f)) {
				console.error(`[e2e-write] SKIP: fallback ${FALLBACK_MODEL} provider/auth failed: ${f.stderr.slice(0, 200)}`);
				return;
			}
			expect(f.timedOut, `fallback ${FALLBACK_MODEL} timed out after ${FALLBACK_CAP_MS}ms`).toBe(false);
			expect(f.code, `fallback ${FALLBACK_MODEL} exited nonzero:\n${f.stderr.slice(-400)}`).toBe(0);
			assertArtifact(cwd, f, FALLBACK_MODEL);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 300_000);
});
