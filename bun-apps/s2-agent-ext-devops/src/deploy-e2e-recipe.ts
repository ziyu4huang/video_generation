/**
 * deploy-e2e-recipe — prove a DEPLOYED s2-agent-sh tree actually works.
 *
 * WHY THIS EXISTS
 * ---------------
 * The deploy gates (scripts/deploy.ts) verify the STAGED tree before the
 * rename/freeze/`current` swap: `--ext-list` boots, extensions load, the tree
 * is offline-contained and relocatable. Nothing after the swap re-boots the
 * FINAL frozen tree, and nothing anywhere places a model call through the
 * deployed `s2-agent.sh` launcher — the invocation a human actually uses. The deeper E2E
 * suites (tests/deploy-e2e.test.ts, tests/deploy-probe-e2e.test.ts,
 * s2-agent run-test tiers) are PI_AGENT_E2E-gated and never run in CI, so in
 * practice the live dist goes unverified between manual runs. This recipe is
 * the cheap, always-runnable layer: three bounded probes against a deployed
 * version dir, spawn-injectable, provider-tolerant.
 *
 * THE THREE PROBES
 *   boot       `s2-agent.sh --help` — the core boots from the frozen tree.
 *   ext-load   `s2-agent.sh --ext-list` — every extension enabled in
 *              deploy.json reports loaded (same contract as deploy Gate 3,
 *              but against the FINAL tree).
 *   model-call `s2-agent.sh -p 'Reply with exactly: ok' --no-session` — a real
 *              one-shot model call through the deployed launcher. A FAST
 *              provider/auth failure (≤10s, provider-smelling output) is a
 *              SKIP, never a FAIL — the hang detector must not fail on
 *              missing credentials (semantics lifted from oneshot-smoke).
 *
 * INTERACTIVE SUBCOMMANDS ARE DELIBERATELY NOT PROBED
 *   `s2-agent auth` with no subcommand opens an interactive TUI and blocks
 *   forever when stdout is not a TTY (upstream pi-coding-agent behavior,
 *   observed 2026-08-22 against 0.1.0+gdc14025). Every probe here is
 *   non-interactive and bounded by timeoutMs.
 *
 * SEAMS
 *   `classifyRun` is REUSED from oneshot-smoke (pure) so the two gates can
 *   never disagree about what a timeout / fast provider failure means. The
 *   spawn surface is the shared `SpawnFn`; tests inject a recording fake and
 *   never place a real model call.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { classifyRun } from "./oneshot-smoke.js";
import type { SpawnFn } from "./spawn.js";

/**
 * Wall-clock caps (ms). Boot and ext-load stay TIGHT — neither places a model
 * call, so anything past 60s really is a wedge. The model call gets contention
 * headroom: measured 2026-08-23 on this machine, LM Studio with several large
 * models resident (qwen 27b ×2 + gemma 12b + 3 embedders) generated 10 tokens
 * in 31.7s and the same one-shot completed in ~3–4 min uncapped — a 120s cap
 * turns that environment into a false FAIL, so the cap sits above the measured
 * ceiling at 300s.
 */
export const BOOT_CAP_MS = 60_000;
export const EXT_LIST_CAP_MS = 60_000;
export const MODEL_CALL_CAP_MS = 300_000;

/** Default chat-endpoint base for the contention precheck (LM Studio). */
export const DEFAULT_MODEL_ENDPOINT = "http://127.0.0.1:1234";

/** Resolve the precheck endpoint: env override first (baseUrl alias included). */
export function resolveModelEndpoint(env: Record<string, string | undefined> = process.env): string {
	return env.LMSTUDIO_BASE_URL ?? DEFAULT_MODEL_ENDPOINT;
}

/** Model ids that are embedding servers, not chat models — never contention. */
const EMBEDDING_ID_RE = /embed|bge/i;
/** "27b" / "12b" in a model id, parsed as a parameter count. */
const PARAMS_B_RE = /(\d+(?:\.\d+)?)\s*b\b/i;
/** ≥ this many billion params counts as a LARGE chat model. */
const LARGE_MODEL_MIN_B = 7;

/**
 * Contention precheck (pure): given `/v1/models` ids, warn when MORE THAN ONE
 * large chat model is resident — the measured condition under which even a
 * 300s model-call cap can be exceeded. Returns null when quiet.
 */
export function modelContentionWarning(modelIds: string[], capMs: number = MODEL_CALL_CAP_MS): string | null {
	const large = modelIds.filter((id) => {
		if (EMBEDDING_ID_RE.test(id)) return false;
		const m = id.match(PARAMS_B_RE);
		return m !== null && Number.parseFloat(m[1]) >= LARGE_MODEL_MIN_B;
	});
	if (large.length > 1) {
		return `model endpoint lists ${large.length} large chat models resident (${large.join(", ")}) — generation may be slow enough to exceed even the ${Math.round(capMs / 1000)}s model-call cap; consider unloading the extras in LM Studio before deploying/probing`;
	}
	return null;
}

/** The one-shot prompt; the reply content is irrelevant, the round-trip is. */
export const DEPLOY_E2E_PROMPT = "Reply with exactly: ok";

/** Fetch seam for the contention precheck — narrow so tests inject a plain fn. */
export type ModelsFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ProbeVerdict = "pass" | "skip" | "fail";

export interface DeployE2eProbe {
	id: "boot" | "ext-load" | "model-call";
	verdict: ProbeVerdict;
	ms: number;
	note: string;
	/** Multi-line diagnostics on FAIL (captured tail). */
	detail?: string;
}

export interface DeployE2eOutcome {
	/** The version dir the probes ran against (absolute). */
	versionDir: string;
	/** deploy.json's version string (e.g. "0.1.0+gdc14025"). */
	version: string;
	sourceSha: string;
	probes: DeployE2eProbe[];
	/** Non-fatal environment notes (e.g. multi-model contention on the endpoint). */
	warnings: string[];
	/** fail > skip > pass — any probe fail fails the run. */
	verdict: ProbeVerdict;
	note: string;
	durationMs: number;
}

/** The subset of deploy.json this recipe consumes. */
interface DeployJson {
	version: string;
	sourceSha: string;
	config: { extensions: Array<{ name: string; enabled: boolean }> };
}

/**
 * Parse + validate a deploy.json. Pure. Returns the enabled extension names
 * (order-insensitive — matching is set membership, like deploy Gate 3).
 */
export function parseDeployJson(raw: string): { ok: true; value: DeployJson; enabled: string[] } | { ok: false; message: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, message: "deploy.json is not valid JSON" };
	}
	const d = parsed as Partial<DeployJson>;
	if (typeof d.version !== "string" || typeof d.sourceSha !== "string" || !Array.isArray(d.config?.extensions)) {
		return { ok: false, message: "deploy.json missing version/sourceSha/config.extensions" };
	}
	const enabled: string[] = [];
	for (const e of d.config.extensions) {
		if (typeof e?.name !== "string") return { ok: false, message: "deploy.json extension entry without a name" };
		if (e.enabled !== false) enabled.push(e.name);
	}
	return { ok: true, value: d as DeployJson, enabled };
}

/** The `--ext-list` payload (same shape scripts/deploy.ts parses). */
export interface ExtListPayload {
	loadedCount: number;
	loaded: string[];
	skipped: Array<{ name: string; reason: string }>;
}

export function parseExtListPayload(stdout: string): { ok: true; value: ExtListPayload } | { ok: false; message: string } {
	try {
		const v = JSON.parse(stdout) as Partial<ExtListPayload>;
		if (!Array.isArray(v.loaded) || typeof v.loadedCount !== "number") {
			return { ok: false, message: "--ext-list payload missing loaded/loadedCount" };
		}
		return { ok: true, value: v as ExtListPayload };
	} catch {
		return { ok: false, message: "--ext-list stdout is not JSON" };
	}
}

/** Resolve `<deployRoot>/current` to the version dir it points at (null if absent). */
export function resolveCurrentVersionDir(deployRoot: string): string | null {
	try {
		return realpathSync(join(deployRoot, "current"));
	} catch {
		return null;
	}
}

function tail(stdout: string, stderr: string): string {
	const out = `${stdout}\n${stderr}`.trim();
	return out.length > 1500 ? `…${out.slice(-1500)}` : out;
}

function worst(verdicts: ProbeVerdict[]): ProbeVerdict {
	if (verdicts.includes("fail")) return "fail";
	if (verdicts.includes("skip")) return "skip";
	return "pass";
}

export interface DeployE2eOptions {
	/** The deployed version dir (NOT the deploy root — resolve `current` first). */
	versionDir: string;
	spawn: SpawnFn;
	/** Injectable clock (default Date.now). */
	now?: () => number;
	/** Skip the model-call probe (offline contexts; overall verdict can still pass). */
	skipModelCall?: boolean;
	/**
	 * Chat-endpoint base for the contention precheck (GET `<endpoint>/v1/models`
	 * before the model-call probe; a >1-large-model listing becomes a warning).
	 * The recipe does NOT default this — callers (CLIs) pass `resolveModelEndpoint()`
	 * so unit tests, which inject everything, never touch the network. `null` and
	 * `undefined` both mean "no precheck".
	 */
	modelEndpoint?: string | null;
	/** Injectable fetch for the precheck (default: global fetch). Just the surface used. */
	fetchImpl?: ModelsFetch;
}

/**
 * Run the three probes against one deployed version dir. Never throws — every
 * failure (missing tree, unreadable deploy.json, probe fail) is a structured
 * FAIL outcome so callers can JSON-serialize it blindly.
 */
export async function runDeployE2e(opts: DeployE2eOptions): Promise<DeployE2eOutcome> {
	const now = opts.now ?? Date.now;
	const startedAt = now();
	const probes: DeployE2eProbe[] = [];

	// Tree preconditions: deploy.json readable (it also supplies the expected
	// extension set) and the launcher present. Both are structured FAILs, not
	// throws. The launcher is s2-agent.sh (the run.sh shim was dropped in
	// ticket 05).
	let enabled: string[] = [];
	let version = basename(opts.versionDir);
	let sourceSha = "";
	try {
		const p = parseDeployJson(await readFile(join(opts.versionDir, "deploy.json"), "utf8"));
		if (!p.ok) return failFast(opts.versionDir, `deploy.json unreadable: ${p.message}`, startedAt, now);
		enabled = p.enabled;
		version = p.value.version;
		sourceSha = p.value.sourceSha;
	} catch (e) {
		return failFast(opts.versionDir, `deploy.json unreadable: ${(e as Error).message}`, startedAt, now);
	}
	if (!(await Bun.file(join(opts.versionDir, "s2-agent.sh")).exists())) {
		return failFast(opts.versionDir, "s2-agent.sh missing from the version dir", startedAt, now);
	}

	// ── boot probe ──────────────────────────────────────────────────────────
	{
		const t0 = now();
		const r = await opts.spawn("./s2-agent.sh", ["--help"], { cwd: opts.versionDir, timeoutMs: BOOT_CAP_MS });
		const ms = now() - t0;
		probes.push(
			r.exitCode === 0 && !r.timedOut
				? { id: "boot", verdict: "pass", ms, note: `--help exited 0` }
				: {
						id: "boot",
						verdict: "fail",
						ms,
						note: `--help ${r.timedOut ? `timed out after ${BOOT_CAP_MS}ms` : `exited ${r.exitCode}`}`,
						detail: tail(r.stdout, r.stderr),
					},
		);
	}

	// ── ext-load probe ──────────────────────────────────────────────────────
	{
		const t0 = now();
		const r = await opts.spawn("./s2-agent.sh", ["--ext-list"], { cwd: opts.versionDir, timeoutMs: EXT_LIST_CAP_MS });
		const ms = now() - t0;
		if (r.timedOut || r.exitCode !== 0) {
			probes.push({
				id: "ext-load",
				verdict: "fail",
				ms,
				note: `--ext-list ${r.timedOut ? `timed out after ${EXT_LIST_CAP_MS}ms` : `exited ${r.exitCode}`}`,
				detail: tail(r.stdout, r.stderr),
			});
		} else {
			const p = parseExtListPayload(r.stdout);
			if (!p.ok) {
				probes.push({ id: "ext-load", verdict: "fail", ms, note: p.message, detail: tail(r.stdout, r.stderr) });
			} else {
				const missing = enabled.filter((n) => !p.value.loaded.includes(n));
				const skippedNote = p.value.skipped.length
					? `; skipped=${JSON.stringify(p.value.skipped)}`
					: "";
				probes.push(
					missing.length
						? {
								id: "ext-load",
								verdict: "fail",
								ms,
								note: `extension(s) not loaded: ${missing.join(", ")}${skippedNote}`,
								detail: `loaded=[${p.value.loaded.join(", ")}]`,
							}
						: { id: "ext-load", verdict: "pass", ms, note: `${p.value.loadedCount} extension(s) loaded${skippedNote}` },
				);
			}
		}
	}

	// ── model-call probe ────────────────────────────────────────────────────
	const warnings: string[] = [];
	let modelCallSkippedByCaller = false;
	if (opts.skipModelCall) {
		// Recorded as a skip probe for the report, but NOT allowed to degrade
		// the overall verdict — the caller asked for two probes, two probes ran.
		modelCallSkippedByCaller = true;
		probes.push({ id: "model-call", verdict: "skip", ms: 0, note: "skipped by caller (--skip-model-call)" });
	} else {
		// Contention precheck: >1 large chat model resident on the endpoint is
		// the measured condition (2026-08-23) under which generation is slow
		// enough to blow past even the 300s cap. Best-effort and bounded — a
		// down/unreachable endpoint just yields no warning (the probe itself
		// will classify whatever follows).
		if (opts.modelEndpoint) {
			try {
				const res = await (opts.fetchImpl ?? fetch)(`${opts.modelEndpoint.replace(/\/+$/, "")}/v1/models`, {
					signal: AbortSignal.timeout(3_000),
				});
				if (res.ok) {
					const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
					const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? "")) : [];
					const w = modelContentionWarning(ids);
					if (w) warnings.push(w);
				}
			} catch {
				// endpoint down/unreachable — not this recipe's failure to report
			}
		}
		const t0 = now();
		const r = await opts.spawn("./s2-agent.sh", ["-p", DEPLOY_E2E_PROMPT, "--no-session"], {
			cwd: opts.versionDir,
			timeoutMs: MODEL_CALL_CAP_MS,
		});
		const ms = now() - t0;
		const c = classifyRun({ ...r, durationMs: ms });
		// A timeout here is NOT automatically a hang: distinguish slow from hung
		// in the note so the next reader unloads LM Studio models before hunting
		// a surrealdb wedge (root cause #2 vs #1 in BOOT_HANG_DIAGNOSTIC).
		const note =
			c.reason === "timeout"
				? `timeout after ${Math.round(MODEL_CALL_CAP_MS / 1000)}s — SLOW generation under model-endpoint contention is as likely as a hang; if a direct curl to the endpoint answers, unload the extra models and rerun`
				: `${c.reason}${c.detail ? ` — ${firstLine(c.detail)}` : ""}`;
		probes.push({
			id: "model-call",
			verdict: c.verdict,
			ms,
			note,
			detail:
				c.verdict === "fail"
					? [c.detail, ...warnings.map((w) => `Precheck: ${w}`)].filter(Boolean).join("\n")
					: undefined,
		});
	}

	const verdict = worst(
		probes.filter((p) => !(modelCallSkippedByCaller && p.id === "model-call")).map((p) => p.verdict),
	);
	return {
		versionDir: opts.versionDir,
		version,
		sourceSha,
		probes,
		warnings,
		verdict,
		note: `${verdict} (${probes.map((p) => `${p.id}:${p.verdict}`).join(" ")})`,
		durationMs: now() - startedAt,
	};
}

function firstLine(s: string): string {
	return s.split("\n")[0] ?? "";
}

function failFast(versionDir: string, message: string, startedAt: number, now: () => number): DeployE2eOutcome {
	return {
		versionDir,
		version: basename(versionDir),
		sourceSha: "",
		probes: [],
		warnings: [],
		verdict: "fail",
		note: `fail (${message})`,
		durationMs: now() - startedAt,
	};
}
