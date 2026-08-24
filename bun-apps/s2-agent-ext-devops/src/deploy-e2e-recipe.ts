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
 * the cheap, always-runnable layer: bounded probes against a deployed
 * version dir, spawn-injectable, provider-tolerant.
 *
 * THE PROBES
 *   boot           `s2-agent.sh --help` — the core boots from the frozen tree.
 *   ext-load       `s2-agent.sh --ext-list` — every extension enabled in
 *                  deploy.json reports loaded (same contract as deploy Gate 3,
 *                  but against the FINAL tree). Registration only — blind to
 *                  the #1946 class, which is what tools-probe covers.
 *   tools-probe    `s2-agent.sh -e <probe> -p hi --no-session` — a real
 *                  headless session whose probe asserts the ACTIVE toolset
 *                  still contains the core builtins (read/write/edit/bash)
 *                  when the request would go out. The #1946 regression
 *                  (tool-gate setActiveTools([])) shipped TWO toolless deploys
 *                  past boot + ext-load + model-call; only the active set
 *                  observes it. Offline (exits at before_agent_start); a FAST
 *                  provider/auth failure is a SKIP, never a FAIL.
 *   model-call     `s2-agent.sh -p 'Reply with exactly: ok' --no-session` — a
 *                  real one-shot model call through the deployed launcher. A
 *                  FAST provider/auth failure (≤10s, provider-smelling output)
 *                  is a SKIP, never a FAIL — the hang detector must not fail on
 *                  missing credentials (semantics lifted from oneshot-smoke).
 *                  The SAME probe carries two REGRESSION BUDGETS: one-shot wall
 *                  time under ONESHOT_RUNTIME_BUDGET_MS (35s; baseline p95
 *                  10.99s measured 2026-08-24 — the #1976 36.6s class must
 *                  fail, contention downgrades to skip) and hermes-memory
 *                  startup round-trips under HERMES_STARTUP_ROUNDTRIP_CAP
 *                  (150; parsed from the slow-startup stderr banner, measured
 *                  103–114 dirty-vault / 26 clean).
 *   file2md-ocr    executes the DEPLOYED file2md bundle's OCR on a fixture —
 *                  no model; proves the shipped wasm/lang assets resolve.
 *   tool-gate-fire executes the DEPLOYED tool-gate bundle's matcher on a
 *                  fixture gate family — no model; proves the shipped bytes
 *                  gate at session start and fire on a keyword prompt.
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
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { executeExtTool } from "./deploy/lib/ext-build.js";
import { runToolGateFireProbe } from "./tool-gate-fire-probe.js";
import { F2MD_E2E_OCR_B64 } from "./deploy/f2md-e2e-fixture.js";
import { classifyRun } from "./oneshot-smoke.js";
import { parseToolsProbeLine, TOOLS_ACTIVE_PROBE } from "./tools-active-probe.js";
import { modelContentionWarning, resolveModelEndpoint, type ModelsFetch } from "./model-endpoint.js";
import type { SpawnFn } from "./spawn.js";

// Re-exported for compatibility: these moved to src/model-endpoint.ts
// (2026-08-23) so oneshot-smoke can share them without an import cycle.
export { DEFAULT_MODEL_ENDPOINT, modelContentionWarning, resolveModelEndpoint } from "./model-endpoint.js";
export type { ModelsFetch } from "./model-endpoint.js";

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
export const TOOLS_PROBE_CAP_MS = 60_000;
export const MODEL_CALL_CAP_MS = 300_000;

/**
 * One-shot RUNTIME BUDGET — the regression gate for startup/shutdown
 * serialization (the 36.6s→~5s #1976 class). Baseline measured 2026-08-24 on
 * this machine against deployed 0.7.1+gd6f3c0c: 8 runs of
 * `./s2-agent.sh -p 'Reply with exactly: ok' --no-session` → 10.97–10.99s
 * wall (p95 10.99s, ±0.02s), including the model round-trip. 35s = 3.2×
 * headroom for normal model variance while sitting BELOW the 36.6s #1976
 * regression — that class must FAIL here, not merely look slow. A breach
 * with >1 large resident chat model (the contention precheck) is a SKIP:
 * the environment is the suspect, not the tree.
 */
export const ONESHOT_RUNTIME_BUDGET_MS = 35_000;

/**
 * hermes-memory STARTUP ROUND-TRIP CAP. Measured 2026-08-24 on this machine
 * (deployed 0.7.1+gd6f3c0c, perf.jsonl): syncMarkdownMemories does 26
 * round-trips with a clean vault (610ms, below the extension's own 50-RT
 * breach threshold — no banner) and 103–114 with a dirty vault (breach
 * banner). 150 sits above the dirty-vault ceiling to catch a ≥2× drift;
 * once the batching fix lands (successor goal "hermes-memory startup perf")
 * the banner disappears entirely and this cap goes quiet. Parsed from the
 * `[hermes-memory] slow startup.<op>: N HTTP round-trips` stderr banner the
 * extension already emits on breach.
 */
export const HERMES_STARTUP_ROUNDTRIP_CAP = 150;

/**
 * Parse hermes-memory startup round-trip counts out of a probe's captured
 * stderr. Pure. Returns the MAX round-trip count across `slow startup.*`
 * banner lines (the extension prints one line per breaching op), or null
 * when no startup banner fired — no banner means every startup op stayed
 * under the extension's own thresholds (50 RT / 2000ms), which is a pass.
 * ms-breach lines carry no round-trip count and are ignored here; the wall
 * budget above is what catches a slow-but-chatty-less startup.
 */
export function parseHermesStartupRoundTrips(stderr: string): number | null {
	const clean = stderr.replace(/\x1b\[[0-9;]*m/g, "");
	const re = /\[hermes-memory\] slow startup\.[\w.]+: (\d+) HTTP round-trips/g;
	let max: number | null = null;
	for (const m of clean.matchAll(re)) {
		const n = Number(m[1]);
		if (max === null || n > max) max = n;
	}
	return max;
}

/** The one-shot prompt; the reply content is irrelevant, the round-trip is. */
export const DEPLOY_E2E_PROMPT = "Reply with exactly: ok";

export type ProbeVerdict = "pass" | "skip" | "fail";

export interface DeployE2eProbe {
	id: "boot" | "ext-load" | "tools-probe" | "model-call" | "file2md-ocr" | "tool-gate-fire";
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

	// ── tools-probe ──────────────────────────────────────────────────────────
	// The #1946 class in one sentence: tool-gate's setActiveTools([]) wiped the
	// ACTIVE toolset while ext-load above (registration) stayed green AND a
	// toolless model still answers the model-call probe below ("Reply with
	// exactly: ok" needs no tools). This probe boots a REAL headless session and
	// asserts the core builtins are active when the request would go out — the
	// only observation point for every mutator that runs at session_start /
	// before_agent_start. A mutator acting later (e.g. before_provider_request)
	// is NOT observed here; that residual window is accepted and documented.
	// Runs unconditionally — not gated on tool-gate being in the deploy set:
	// without tool-gate nothing calls setActiveTools and the default active set
	// is all tools, so the core assertion still holds and still guards.
	{
		const t0 = now();
		let tpNote = "";
		let tpDetail: string | undefined;
		let tpVerdict: ProbeVerdict = "fail";
		const workDir = mkdtempSync(join(tmpdir(), "tools-probe-"));
		try {
			const probePath = join(workDir, "tools-probe.ts");
			writeFileSync(probePath, TOOLS_ACTIVE_PROBE);
			const r = await opts.spawn("./s2-agent.sh", ["-e", probePath, "-p", "hi", "--no-session"], {
				cwd: opts.versionDir,
				timeoutMs: TOOLS_PROBE_CAP_MS,
			});
			const ms = now() - t0;
			const p = parseToolsProbeLine(r.stderr);
			if (!p.ok) {
				// Marker absent: reaching before_agent_start requires model
				// resolution, so a FAST provider/auth failure is the same SKIP
				// contract as model-call (classifyRun reused — the gates can
				// never disagree about what that means). Timeouts still FAIL.
				const c = classifyRun({ ...r, durationMs: ms });
				tpVerdict = c.verdict === "skip" ? "skip" : "fail";
				tpNote =
					c.verdict === "skip"
						? `probe never fired — ${c.reason}${c.detail ? ` — ${firstLine(c.detail)}` : ""}`
						: `${p.message}${r.timedOut ? ` (timed out after ${TOOLS_PROBE_CAP_MS}ms)` : ` (exit ${r.exitCode})`}`;
				tpDetail = tail(r.stdout, r.stderr);
			} else {
				const v = p.value;
				const gate = v.gateSeam
					? `; gate seam ${v.gateSeam.activeCount}/${v.gateSeam.totalCount}, core ${v.gateSeam.coreCount}`
					: "; gate seam absent";
				if (!v.getActiveTools || v.getError !== undefined) {
					tpNote = `active-set read failed${v.getError ? `: ${v.getError}` : ""}${
						v.getActiveTools === false ? " — ExtensionAPI no longer exposes getActiveTools" : ""
					}`;
					tpDetail = JSON.stringify(v);
				} else if (v.activeCount === 0) {
					tpNote = `active toolset is EMPTY (0/${v.total} registered) — the #1946 setActiveTools([]) class`;
					tpDetail = JSON.stringify(v);
				} else if (v.missing.length) {
					tpNote = `active toolset missing core builtins: ${v.missing.join(", ")} (active=${v.activeCount}/${v.total} registered)`;
					tpDetail = `active=[${v.active.join(", ")}] gateSeam=${JSON.stringify(v.gateSeam)}`;
				} else {
					tpVerdict = "pass";
					tpNote = `core tools active (${v.activeCount}/${v.total} active${gate})`;
				}
			}
		} catch (e) {
			tpNote = `execution failed: ${e instanceof Error ? e.message : String(e)}`;
			tpDetail = tpNote;
		} finally {
			try {
				rmSync(workDir, { recursive: true, force: true });
			} catch {
				/* */
			}
		}
		probes.push({ id: "tools-probe", verdict: tpVerdict, ms: now() - t0, note: tpNote, detail: tpDetail });
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
		// ── one-shot runtime budget + hermes round-trip cap ──────────────────
		// The one-shot's wall time IS the startup/shutdown serialization
		// signal (a trivial prompt is ~11s on a healthy tree; the #1976 class
		// inflated it to 36.6s at 14% CPU). A completed run slower than the
		// budget FAILS — unless the contention precheck fired, in which case
		// slow generation is as likely as slow startup and the breach is
		// inconclusive (SKIP). The hermes banner round-trip cap applies
		// regardless of how the call classified: the banner proves the
		// startup path ran, so a round-trip regression is tree-side even
		// when the provider itself was down.
		const hermesRt = parseHermesStartupRoundTrips(`${r.stdout}\n${r.stderr}`);
		let verdict = c.verdict;
		const budgetS = Math.round(ONESHOT_RUNTIME_BUDGET_MS / 1000);
		let note =
			c.reason === "timeout"
				? `timeout after ${Math.round(MODEL_CALL_CAP_MS / 1000)}s — SLOW generation under model-endpoint contention is as likely as a hang; if a direct curl to the endpoint answers, unload the extra models and rerun`
				: `${c.reason}${c.detail ? ` — ${firstLine(c.detail)}` : ""}`;
		if (c.verdict === "pass" || c.verdict === "skip") {
			note += ` — wall ${(ms / 1000).toFixed(1)}s (budget ${budgetS}s)`;
		}
		if (c.verdict === "pass" && ms > ONESHOT_RUNTIME_BUDGET_MS) {
			if (warnings.length > 0) {
				verdict = "skip";
				note = `one-shot wall ${(ms / 1000).toFixed(1)}s exceeds the ${budgetS}s budget under model contention — inconclusive, not a tree regression`;
			} else {
				verdict = "fail";
				note = `one-shot wall ${(ms / 1000).toFixed(1)}s exceeds the ${budgetS}s budget (baseline p95 10.99s measured 2026-08-24 on 0.7.1+gd6f3c0c) — startup/shutdown serialization regression (the #1976 class)`;
			}
		}
		if (hermesRt !== null && hermesRt > HERMES_STARTUP_ROUNDTRIP_CAP) {
			verdict = "fail";
			note = `hermes-memory startup made ${hermesRt} HTTP round-trips (cap ${HERMES_STARTUP_ROUNDTRIP_CAP}; measured 103–114 dirty-vault / 26 clean on 2026-08-24) — ${note}`;
		}
		probes.push({
			id: "model-call",
			verdict,
			ms,
			note,
			detail:
				verdict === "fail"
					? [c.detail, ...warnings.map((w) => `Precheck: ${w}`)].filter(Boolean).join("\n")
					: undefined,
		});
	}

	// ── file2md-ocr probe ───────────────────────────────────────────────────
	// A REAL OCR run through the DEPLOYED bundle and the deployed vendored
	// assets — no model, no agent loop (executeExtTool evaluates ext.cjs with
	// the runtime loader; `#pi/ext-dir` serves the deployed ext dir so the
	// wasm + copied traineddata resolve inside the frozen tree). A broken
	// asset layout fails here, not on a user machine.
	if (!enabled.includes("file2md")) {
		probes.push({ id: "file2md-ocr", verdict: "skip", ms: 0, note: "file2md not in deploy set" });
	} else {
		const t0 = now();
		let ocrDetail: string | undefined;
		let ocrVerdict: ProbeVerdict = "fail";
		let ocrNote = "";
		const workDir = mkdtempSync(join(tmpdir(), "f2md-e2e-"));
		const fixturePath = join(workDir, "f2md-e2e.png");
		const outDir = join(workDir, "out");
		try {
			writeFileSync(fixturePath, Buffer.from(F2MD_E2E_OCR_B64, "base64"));
			const extJson = JSON.parse(
				readFileSync(join(opts.versionDir, "ext", "file2md", "ext.json"), "utf8"),
			) as {
				hostModules?: string[];
				vendored?: string[];
				runtimeExternals?: string[];
			};
			await executeExtTool(
				join(opts.versionDir, "ext", "file2md", "ext.cjs"),
				"file2md",
				{ input: fixturePath, out: outDir, mode: "ocr", lang: "en" },
				[...(extJson.hostModules ?? []), ...(extJson.vendored ?? []), ...(extJson.runtimeExternals ?? [])],
			);
			const pageMd = readFileSync(join(outDir, "f2md-e2e", "pages", "page-001.md"), "utf8");
			if (pageMd.includes("FILE2MD E2E OCR") && pageMd.includes("provenance: ocr")) {
				ocrVerdict = "pass";
				ocrNote = "deployed bundle OCR'd the fixture (provenance: ocr)";
			} else {
				ocrNote = "OCR ran but the page md lacks the fixture text or provenance";
				ocrDetail = pageMd.slice(0, 500);
			}
		} catch (e) {
			ocrNote = `execution failed: ${e instanceof Error ? e.message : String(e)}`;
			ocrDetail = `${ocrNote}\n(expected page: ${join(outDir, "f2md-e2e", "pages", "page-001.md")})`;
		}
		probes.push({ id: "file2md-ocr", verdict: ocrVerdict, ms: now() - t0, note: ocrNote, detail: ocrDetail });
	}

	// ── tool-gate-fire probe ─────────────────────────────────────────────────
	// The shipped matcher's recall is the reversal's standing portability
	// caveat: the dist carries tool-gate WITHOUT its repo-side recall corpus /
	// gate-recall probes. This probe executes the DEPLOYED ext/tool-gate
	// bundle (runtime loader, host modules served for real — no model, no
	// agent loop) and drives a session_start → before_agent_start cycle over a
	// fixture gate family: gated OFF at start, fires on a keyword prompt,
	// enable_tool registered, BUN_PI_TOOL_GATE=0 guards. The full corpus still
	// stays repo-side — this is the smoke layer.
	if (!enabled.includes("tool-gate")) {
		probes.push({ id: "tool-gate-fire", verdict: "skip", ms: 0, note: "tool-gate not in deploy set" });
	} else {
		const t0 = now();
		let tgNote = "";
		let tgDetail: string | undefined;
		let tgVerdict: ProbeVerdict = "fail";
		try {
			const extJson = JSON.parse(
				readFileSync(join(opts.versionDir, "ext", "tool-gate", "ext.json"), "utf8"),
			) as {
				hostModules?: string[];
				vendored?: string[];
				runtimeExternals?: string[];
			};
			const r = await runToolGateFireProbe(
				join(opts.versionDir, "ext", "tool-gate", "ext.cjs"),
				[...(extJson.hostModules ?? []), ...(extJson.vendored ?? []), ...(extJson.runtimeExternals ?? [])],
			);
			tgVerdict = r.ok ? "pass" : "fail";
			tgNote = r.ok ? "deployed matcher gates + fires (offline, no model)" : r.note;
			tgDetail = r.detail;
		} catch (e) {
			tgNote = `execution failed: ${e instanceof Error ? e.message : String(e)}`;
			tgDetail = tgNote;
		}
		probes.push({ id: "tool-gate-fire", verdict: tgVerdict, ms: now() - t0, note: tgNote, detail: tgDetail });
	}

	const verdict = worst(
		probes
			.filter((p) => {
				if (modelCallSkippedByCaller && p.id === "model-call") return false;
				// Not-applicable skips are inconclusive, not a degraded verdict.
				if (p.id === "file2md-ocr" && p.verdict === "skip") return false;
				if (p.id === "tool-gate-fire" && p.verdict === "skip") return false;
				return true;
			})
			.map((p) => p.verdict),
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
