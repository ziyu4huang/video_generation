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
 *   boot           `<launcher> --help` — the core boots from the frozen tree
 *                  (s2-agent.sh; `cmd /c s2-agent.cmd` on win32 trees — t06).
 *   ext-load       `<launcher> --ext-list` — every extension enabled in
 *                  deploy.json reports loaded (same contract as deploy Gate 3,
 *                  but against the FINAL tree). Registration only — blind to
 *                  the #1946 class, which is what tools-probe covers.
 *   cwd-independence  re-runs `--ext-list` with cwd OUTSIDE the tree and
 *                  requires the SAME loaded set — the AGENTS.md promise that
 *                  the tree works from any cwd (absolute-path invocation from
 *                  scratch dirs), encoded as a probe 2026-08-29.
 *   tools-probe    `<launcher> -e <probe> -p hi --no-session` — a real
 *                  headless session whose probe asserts the ACTIVE toolset
 *                  still contains the core builtins (read/write/edit/bash)
 *                  when the request would go out. The #1946 regression
 *                  (tool-gate setActiveTools([])) shipped TWO toolless deploys
 *                  past boot + ext-load + model-call; only the active set
 *                  observes it. Offline (exits at before_agent_start); a FAST
 *                  provider/auth failure is a SKIP, never a FAIL.
 *   providers-catalog  `<launcher> --list-models` TWICE under a scratch
 *                  agent-dir — patch ON vs OFF (BUN_PI_PRE_LOAD_PROVIDERS=0).
 *                  Verifies the pre-load-providers ModelRuntime.create wrap is
 *                  alive in the FINAL tree: every baked PROVIDERS pair must
 *                  list, and the ON run must contribute ≥1 pair the OFF run
 *                  lacks (immune to models.json duplication — the exact
 *                  accident that masked the pre-0.80 loadModels death).
 *                  Offline, ~1s.
 *   model-call     `<launcher> -p 'Reply with exactly: ok' --no-session` — a
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
 *   vision-call    executes the DEPLOYED file2md bundle's `vision_ask` tool on
 *                  a fixture image whose large text is known ("FILE2MD E2E
 *                  OCR") and asserts the DEFAULT vision lane
 *                  (capabilities.vision → model-tiers.json) actually processes
 *                  the image: the reply must contain text that is only knowable
 *                  by looking at the picture. This is the #1981 follow-up —
 *                  the default vision lane moved to bonsai-27b:off with the
 *                  lane's end-to-end health explicitly unverified, and the
 *                  failure mode is SILENT: an unresolvable lane falls back to a
 *                  text model that returns nothing for an image (measured
 *                  2026-08-24: "Subagent produced no assistant output" in
 *                  0.3s). A provider-down smell is a SKIP (same contract as
 *                  model-call); a wrong/empty answer is a FAIL. Skipped when
 *                  file2md is not in the deploy set or --skip-model-call.
 *   file2md-ocr    executes the DEPLOYED file2md bundle's OCR on a fixture —
 *                  no model; proves the shipped wasm/lang assets resolve.
 *   tool-gate-fire executes the DEPLOYED tool-gate bundle's matcher on a
 *                  fixture gate family — no model; proves the shipped bytes
 *                  gate at session start and fire on a keyword prompt.
 *   standalone-import  runs the AGENTS.md quickstart VERBATIM from a scratch
 *                  dir (no repo/workspace) against a fixture git repo with
 *                  the DEPLOYED bin/bun, cross-checks file2md THROUGH the
 *                  shim, and re-runs the shim's s1b/s4 gates. Skip on
 *                  pre-t02 trees (no ext/ext-standalone.mjs).
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
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { hostTargetName } from "./deploy/lib/targets.js";
import { isTargetSubrootName } from "./deploy/lib/version.js";
import { executeExtTool } from "./deploy/lib/ext-build.js";
import { runToolGateFireProbe } from "./tool-gate-fire-probe.js";
import { F2MD_E2E_OCR_B64 } from "./deploy/f2md-e2e-fixture.js";
import { standaloneImportProbe } from "./deploy/lib/standalone-import-probe.ts";
import { classifyRun } from "./oneshot-smoke.js";
import { parseToolsProbeLine, TOOLS_ACTIVE_PROBE } from "./tools-active-probe.js";
import { modelContentionWarning, resolveModelEndpoint, type ModelsFetch } from "./model-endpoint.js";
import { PROVIDERS } from "../../s2-agent/src/pre-load-providers.ts";
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
export const PROVIDERS_LIST_CAP_MS = 60_000;
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
 * vision-call CAP (ms). The real path is patches (~2s) + one vision inference
 * through the deployed bundle; measured 2026-08-24 on this machine against
 * deployed 0.7.2: full vision_ask round trip 34.2s cold (bonsai-27b:off, image
 * + answer "FILE2MD E2E OCR"), with the model itself answering image asks in
 * 3.4–3.8s warm. 120s = contention headroom, same posture as MODEL_CALL_CAP.
 */
export const VISION_CALL_CAP_MS = 120_000;

/**
 * The pass assertion for the vision-call probe: the fixture image's large text
 * (uppercase, whitespace-collapsed). A model that never saw the image cannot
 * produce this string — that is the whole point of the probe.
 */
export const VISION_FIXTURE_NEEDLE = "FILE2MD E2E OCR";

/** The question handed to the deployed bundle's vision_ask tool. */
export const VISION_ASK_QUESTION =
	"What is the large bold text in this image? Reply with the exact text only, nothing else.";

/**
 * The vision-call probe's injectable seam (DeployE2eOptions.visionAsk). The
 * default implementation runs the DEPLOYED file2md bundle for real (patches +
 * network); unit tests inject fakes and never touch either.
 */
export interface VisionAskOutcome {
	ok: boolean;
	/** The model's reply (already extracted from the tool result). */
	reply: string;
	error?: string;
}

/** Provider-down smells that downgrade the vision probe to SKIP (never fail). */
export function visionErrorIsProviderDown(error: string): boolean {
	// Deliberately NARROW: this regex also sees free-form model/tool reply
	// text, and a loose pattern (an earlier draft carried "not configured")
	// could SKIP a genuine lane failure phrased like a refusal. Only transport
	// / auth smells belong here.
	return /connection refused|econnrefused|fetch failed|timed out|timeout|etimedout|401|403|no api key|econnreset/i.test(
		error,
	);
}

/**
 * Read an ext.json and merge its module-allowlist arrays (hostModules +
 * vendored + runtimeExternals) — the surface evaluateExtTool accepts. Shared
 * by the vision-call, file2md-ocr, and tool-gate-fire probes.
 */
export function readExtHostModules(extJsonPath: string): string[] {
	const extJson = JSON.parse(readFileSync(extJsonPath, "utf8")) as {
		hostModules?: string[];
		vendored?: string[];
		runtimeExternals?: string[];
	};
	return [...(extJson.hostModules ?? []), ...(extJson.vendored ?? []), ...(extJson.runtimeExternals ?? [])];
}

/** Normalize a VLM reply for the needle assertion (case + whitespace + quotes). */
export function normalizeVisionReply(reply: string): string {
	return reply
		.toUpperCase()
		.replace(/[“”"'`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Run the deployed file2md bundle's vision_ask tool on one image — the DEFAULT
 * visionAsk seam. In-process (no launcher spawn): evaluates the deployed
 * ext.cjs the same way the runtime loader does and executes the tool, which
 * internally resolves capabilities.vision → model-tiers.json → a real model
 * call with the image attached. The s2-agent patch set must be applied first —
 * without it the runtime model registrations (bonsai-27b) are invisible to the
 * registry and the lane silently falls back to a text model (measured
 * 2026-08-24: "requested model … unavailable" → empty output). Patches rewrite
 * process.argv; callers must capture their own argv before this runs.
 */
export async function runDeployedVisionAsk(
	ctx: { versionDir: string; hostModules: readonly string[] },
	imagePath: string,
): Promise<VisionAskOutcome> {
	const patchesPath = resolve(import.meta.dir, "..", "..", "s2-agent", "src", "patches", "index.ts");
	const { applyPatches } = (await import(patchesPath)) as { applyPatches: () => Promise<unknown[]> };
	await applyPatches();
	const r = (await executeExtTool(join(ctx.versionDir, "ext", "file2md", "ext.cjs"), "vision_ask", {
		image: imagePath,
		question: VISION_ASK_QUESTION,
	}, ctx.hostModules)) as {
		isError?: boolean;
		content?: Array<{ type: string; text?: string }>;
		details?: { reply?: string; error?: string };
	};
	const reply = r.content?.map((c) => c.text ?? "").join("\n").trim() ?? "";
	if (r.isError || !reply) {
		return { ok: false, reply, error: r.details?.error ?? reply ?? "vision_ask returned no text" };
	}
	return { ok: true, reply };
}

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

/** A deterministic one-shot lane: provider + model id (thinking forced off). */
export interface E2EModelPin {
	provider: string;
	model: string;
}

/** `<provider>/<model-id>` for display (same shape the operator wrote). */
export function pinLabel(pin: E2EModelPin): string {
	return `${pin.provider}/${pin.model}`;
}

/** The env that carries the pin (shared surface for both CLIs). */
export const VERIFY_E2E_MODEL_ENV = "VERIFY_E2E_MODEL";

/**
 * Resolve the model-call lane pin from the environment. Pure.
 *
 * `VERIFY_E2E_MODEL=provider/model-id` (first-slash split — a multi-segment
 * model id like `openrouter/qwen/qwen3-235b` keeps its inner slashes) pins
 * the one-shot spawns (model-call + tools-probe) to that lane via the D8 env
 * form — PI_PROVIDER/PI_MODEL/PI_THINKING=off, the same precedence the
 * deploy-probe-e2e suite uses (explicit flag > env > settings.json > baked
 * default; PI_MODEL alone is NOT enough, provider comes from PI_PROVIDER).
 *
 * WHY: the predecessor's measured blocker (2026-08-29) — unpinned, the
 * one-shot rides whatever lane the deployed tree defaults to (LM Studio
 * bonsai-27b here), whose cold-start (~36s) straddles the 35s budget with NO
 * contention warning (1 resident model), making every budget verdict a
 * coin flip between fail and luck. Pinned to a light lane (deepseek flash:
 * measured 15.5s wall through the deployed launcher, 2026-08-29) the budget
 * is deterministic again and keeps its #1976 teeth.
 *
 * Returns null when unset/empty (default lane — behavior unchanged), or a
 * usage error the caller surfaces as a warning before running unpinned.
 */
export function resolveE2eModelPin(
	env: Record<string, string | undefined> = process.env,
): { ok: true; pin: E2EModelPin } | { ok: false; message: string } | null {
	const raw = (env[VERIFY_E2E_MODEL_ENV] ?? "").trim();
	if (raw === "") return null;
	const slash = raw.indexOf("/");
	const provider = slash > 0 ? raw.slice(0, slash).trim() : "";
	const model = slash > 0 ? raw.slice(slash + 1).trim() : "";
	if (!provider || !model) {
		return {
			ok: false,
			message: `${VERIFY_E2E_MODEL_ENV}="${raw}" is not provider/model-id — PI_MODEL alone is not enough (provider comes from PI_PROVIDER); running unpinned on the default lane`,
		};
	}
	return { ok: true, pin: { provider, model } };
}

/** The spawn env that carries a pin (the D8 form). Exported for tests/docs. */
export function pinSpawnEnv(pin: E2EModelPin): Record<string, string> {
	return { PI_PROVIDER: pin.provider, PI_MODEL: pin.model, PI_THINKING: "off" };
}

/**
 * The (provider, model-id) pairs the baked catalog (s2-agent §1 PROVIDERS)
 * must surface. Catalog-true — derived from the source of truth, so a new
 * lane in pre-load-providers.ts is automatically covered by the probe.
 */
export function bakedModelPairs(
	providers: Record<string, { models: Array<{ id: string }> }> = PROVIDERS,
): Array<{ provider: string; model: string }> {
	return Object.entries(providers).flatMap(([provider, entry]) =>
		entry.models.map((m) => ({ provider, model: m.id })),
	);
}

/**
 * Parse `--list-models` tabular stdout into provider → model-id set. Pure.
 * Row shape: `<provider>  <model-id>  <context> <max-out> <thinking> <images>`;
 * the header row (first column "provider") and blank lines are skipped.
 */
export function parseListModelsRows(stdout: string): Map<string, Set<string>> {
	const rows = new Map<string, Set<string>>();
	for (const line of stdout.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 2 || cols[0] === "provider" || cols[0] === "") continue;
		const [provider, model] = cols;
		if (!rows.has(provider)) rows.set(provider, new Set());
		rows.get(provider)!.add(model);
	}
	return rows;
}

/**
 * Dummy env values for every `$VAR`-referenced apiKey in the baked catalog
 * (see providersProbeEnv for why). Catalog-true: derived from PROVIDERS, so a
 * new env-keyed lane is covered automatically. A literal-string apiKey (the
 * local-server lm-studio form) contributes nothing — it needs no env.
 */
export function dummyEnvForBakedCatalog(
	providers: Record<string, { apiKey: unknown }> = PROVIDERS,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const entry of Object.values(providers)) {
		const m = typeof entry.apiKey === "string" ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry.apiKey) : null;
		if (m) env[m[1]] = "e2e-dummy-key";
	}
	return env;
}

/**
 * The per-run agent-dir env for the providers-catalog probe: a SCRATCH dir so
 * the listing cannot be satisfied by ~/.pi/agent/models.json residue. Sets the
 * DASHED derived name (upstream builds `${piConfig.name.toUpperCase()_
 * CODING_AGENT_DIR}`; bash cannot export it but spawn env can — deploy script
 * precedent) derived from the deployed tree's own package.json when it
 * carries piConfig, plus the upstream PI_ spelling for pre-rename trees.
 */
function providersProbeEnv(scratchDir: string, versionDir: string): Record<string, string> {
	const env: Record<string, string> = { PI_CODING_AGENT_DIR: scratchDir };
	// Seed dummy values for every `$VAR`-referenced apiKey in the baked
	// catalog. MEASURED GAP (first crossos exposure, run 33385015007
	// 2026-08-31): env-keyed baked providers (deepseek `$DEEPSEEK_API_KEY`,
	// zai …) never list on runners — no stored credential → not "available" —
	// so 10/14 baked pairs failed the probe on BOTH matrix rows while the
	// same tree was green on this machine (keys in the ambient env). The
	// probe's contract is the ModelRuntime.create WRAP (registration), not
	// ambient credentials: a dummy key marks the provider configured exactly
	// like the literal-key lm-studio entry, and --list-models never calls the
	// network — the dummy value is inert.
	for (const [name, value] of Object.entries(dummyEnvForBakedCatalog())) env[name] = value;
	try {
		const pkg = JSON.parse(readFileSync(join(versionDir, "package.json"), "utf8")) as {
			piConfig?: { name?: string };
		};
		if (pkg.piConfig?.name) env[`${pkg.piConfig.name.toUpperCase()}_CODING_AGENT_DIR`] = scratchDir;
	} catch {
		// pre-t0x trees without a readable package.json — the hardcoded fallback
		// covers the s2-agent rename (the name this repo ships as today).
		env["S2-AGENT_CODING_AGENT_DIR"] = scratchDir;
	}
	return env;
}

export type ProbeVerdict = "pass" | "skip" | "fail";

export interface DeployE2eProbe {
	id:
		| "boot"
		| "ext-load"
		| "cwd-independence"
		| "tools-probe"
		| "providers-catalog"
		| "model-call"
		| "vision-call"
		| "file2md-ocr"
		| "tool-gate-fire"
		| "standalone-import";
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
	/** Target runtime facts (crossos t05+); absent on pre-t05 trees. */
	runtime?: { platform?: string; arch?: string };
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

/**
 * Resolve `<deployRoot>/current` to the version dir it points at (null if
 * absent). crossos t05 (D6): the HOST target's subroot is preferred — the
 * verification tooling must follow NEW deploys, not a stale pre-t05 flat
 * link — then the legacy flat layout, and only then another target's
 * subroot (a cross-only outRoot resolves something rather than nothing;
 * callers that cannot boot it check isNonHostTree first).
 */
export function resolveCurrentVersionDir(deployRoot: string): string | null {
	const tryDir = (d: string): string | null => {
		try {
			return realpathSync(join(d, "current"));
		} catch {
			return null;
		}
	};
	if (!existsSync(deployRoot)) return null;
	const hostName = hostTargetName();
	const hostHit = tryDir(join(deployRoot, hostName));
	if (hostHit) return hostHit;
	const direct = tryDir(deployRoot); // pre-t05 flat layout
	if (direct) return direct;
	const subroots = readdirSync(deployRoot)
		.filter((n) => isTargetSubrootName(n) && n !== hostName)
		.sort();
	for (const name of subroots) {
		const hit = tryDir(join(deployRoot, name));
		if (hit) return hit;
	}
	return null;
}

/**
 * Does this deployed tree belong to a NON-host target (crossos t05)? Its
 * bun binary cannot execute here, so boot-style verification must SKIP it
 * (deploy-cli and verify-deploy-e2e-cli share this test). deploy.json
 * carries the target's runtime facts; absent/unreadable = pre-t05 host
 * tree.
 */
export function isNonHostTree(versionDir: string): boolean {
	try {
		const dj = JSON.parse(readFileSync(join(versionDir, "deploy.json"), "utf8")) as {
			runtime?: { platform?: string; arch?: string };
		};
		if (!dj.runtime?.platform || !dj.runtime?.arch) return false;
		return dj.runtime.platform !== process.platform || dj.runtime.arch !== process.arch;
	} catch {
		return false;
	}
}

/**
 * Launcher invocation for the tree's target platform (crossos t06). A win32
 * tree boots through `s2-agent.cmd` — a `.cmd` cannot be exec'd directly from
 * a spawn (CreateProcess only runs it through a shell), so the command is
 * `cmd /c s2-agent.cmd`. Everything else uses the sh launcher verbatim. The
 * platform comes from deploy.json's runtime facts; absent (pre-t05 tree) → sh.
 */
export function launcherInvocation(platform: string | undefined): {
	file: string;
	command: string;
	prefix: string[];
} {
	if (platform === "win32") return { file: "s2-agent.cmd", command: "cmd", prefix: ["/c", "s2-agent.cmd"] };
	return { file: "s2-agent.sh", command: "./s2-agent.sh", prefix: [] };
}

function tail(stdout: string, stderr: string): string {
	const out = `${stdout}\n${stderr}`.trim();
	return out.length > 1500 ? `…${out.slice(-1500)}` : out;
}

/**
 * win32 launcher-chain layer diagnosis (crossos follow-through 2026-08-28):
 * the first windows E2E run had `cmd /c s2-agent.cmd --ext-list` exit 0 with
 * BOTH streams empty — while the deploy's own gates (which spawn bin\bun.exe
 * directly) passed on the same machine, so the output vanished somewhere in
 * the cmd→powershell→bun chain with no local repro. On a win32 ext-load
 * failure, re-run the SAME args through each layer independently and append
 * per-layer exit/output summaries, so one remote CI failure carries its own
 * measurement of WHICH layer dropped the output.
 */
async function win32LayerDiag(
	spawn: import("./spawn.js").SpawnFn,
	versionDir: string,
	args: string[],
): Promise<{ summary: string; isBunShellChildBug: boolean; isTrueUnknown: boolean }> {
	const bunExe = join(versionDir, "bin", "bun.exe");
	const core = join(versionDir, "s2-agent.js");
	const layers: Array<[string, string, string[]]> = [
		["bun-direct", bunExe, [core, ...args]],
		["ps1-direct", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(versionDir, "s2-agent.ps1"), ...args]],
		["cmd-shim", "cmd", ["/c", "s2-agent.cmd", ...args]],
		// cmd.exe's OWN output, no script involved — isolates "cmd loses
		// everything" from "the .cmd script's child loses everything".
		["cmd-echo", "cmd", ["/c", "echo diag-cmd-echo-marker"]],
		// cmd wrapping bun DIRECTLY (no .cmd file) — isolates the script from
		// the cmd-wrapping.
		["cmd-bun", "cmd", ["/c", bunExe, core, ...args]],
	];
	const parts: string[] = [];
	const stdoutBytes: Record<string, number> = {};
	for (const [label, cmd, argv] of layers) {
		try {
			const r = await spawn(cmd, argv, { cwd: versionDir, timeoutMs: 30_000 });
			const head = `${r.stdout}${r.stderr}`.trim().replace(/\s+/g, " ").slice(0, 220);
			stdoutBytes[label] = r.stdout.length;
			parts.push(`${label}: exit ${r.exitCode}${r.timedOut ? " TIMEOUT" : ""}, ${r.stdout.length}B stdout — ${head || "<no output>"}`);
		} catch (e) {
			parts.push(`${label}: spawn error ${(e as Error).message}`);
		}
	}
	// cmd REDIRECTING bun's output to a file — a real file handle created by
	// cmd's `>` vs the inherited pipe: separates "bun cannot write through
	// cmd's inherited handles" from "bun cannot write at all as cmd's child".
	try {
		const outFile = join(tmpdir(), `diag-bun-out-${process.pid}.txt`);
		const r = await spawn(
			"cmd",
			["/c", bunExe, core, ...args, ">", outFile],
			{ cwd: versionDir, timeoutMs: 30_000 },
		);
		let fileNote = "output file missing";
		try {
			const bytes = (await Bun.file(outFile).arrayBuffer()).byteLength;
			fileNote = `${bytes}B in file`;
		} catch {
			/* keep "missing" */
		}
		parts.push(`cmd-bun-file: exit ${r.exitCode}, pipe stdout ${r.stdout.length}B — ${fileNote}`);
	} catch (e) {
		parts.push(`cmd-bun-file: spawn error ${(e as Error).message}`);
	}
	// Non-detached control: the SpawnFn timeout path spawns detached:true,
	// which on Windows hands the child its own console — one candidate for
	// where the output goes. Bun.spawn is not detached.
	try {
		const p = Bun.spawn(["cmd", "/c", "echo", "diag-bunspawn-marker"], {
			cwd: versionDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await Bun.readableStreamToText(p.stdout);
		await p.exited;
		parts.push(`cmd-echo-bunspawn(not detached): ${out.length}B stdout — ${out.trim() || "<no output>"}`);
	} catch (e) {
		parts.push(`cmd-echo-bunspawn: error ${(e as Error).message}`);
	}
	// ── no-console-spawn workaround probes (win32-launcher-stdout ticket 02) ──
	// Ticket 01's verdict closed the bun-upgrade path; the standing hypothesis
	// is that bun.exe, when its spawn carries a console, writes via
	// WriteConsole and never touches the stdio handles (consistent with
	// cmd-bun 0B and cmd-bun-file 0B — even a real `>` file handle got
	// nothing). The workaround candidate: the .cmd/.ps1 entry spawns bun with
	// NO console (CREATE_NO_WINDOW / DETACHED class) and RELAYS its captured
	// handles. These probes prove or refute that BEFORE any shipped shim is
	// rewritten: `ps1-nw-relay` is the mechanism in isolation, and
	// `cmd-ps1-nw-relay` is the full launcher-shaped chain (cmd → powershell
	// relay → no-console bun) the shipped .cmd would delegate to. The two
	// `*-echo` controls prove PowerShell's OWN writes flow at each layer —
	// the relay is only viable if its re-emitted output survives the pipe.
	// Paths travel via env vars (no quoting inside the script — spaces in
	// the version dir stay one argv entry end to end).
	const diagDir = mkdtempSync(join(tmpdir(), "s2-e2e-nwdiag-"));
	try {
		const relayScript = join(diagDir, "diag-nw-relay.ps1");
		writeFileSync(
			relayScript,
			[
				"# diag-nw-relay.ps1 - spawn bun with CREATE_NO_WINDOW (no console), relay captured handles",
				"$psi = New-Object System.Diagnostics.ProcessStartInfo",
				"$psi.FileName = $env:DIAG_BUN",
				"$psi.Arguments = '\"' + $env:DIAG_CORE + '\" ' + $env:DIAG_ARGS",
				"$psi.WorkingDirectory = $env:DIAG_CWD",
				"$psi.UseShellExecute = $false",
				"$psi.CreateNoWindow = $true",
				"$psi.RedirectStandardOutput = $true",
				"$psi.RedirectStandardError = $true",
				"$p = [System.Diagnostics.Process]::Start($psi)",
				"$out = $p.StandardOutput.ReadToEnd()",
				"$err = $p.StandardError.ReadToEnd()",
				"$p.WaitForExit()",
				"[Console]::Out.Write($out)",
				"[Console]::Error.Write($err)",
				"exit $p.ExitCode",
				"",
			].join("\n"),
		);
		// The file-handle twin of the relay: Start-Process with -RedirectStandardOutput
		// (a REAL file created by the parent, not an inherited pipe) — parallels the
		// cmd-bun-file measurement above and distinguishes "pipe handle" from "any
		// redirected handle" in the no-console child.
		const fileScript = join(diagDir, "diag-nw-file.ps1");
		writeFileSync(
			fileScript,
			[
				"# diag-nw-file.ps1 - no-console bun via Start-Process, stdout redirected to a file",
				"$out = Join-Path $env:DIAG_TMP ('diag-nw-out-' + $PID + '.txt')",
				"$p = Start-Process -FilePath $env:DIAG_BUN -ArgumentList @('\"' + $env:DIAG_CORE + '\"', $env:DIAG_ARGS) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -WorkingDirectory $env:DIAG_CWD",
				"$bytes = (Get-Item $out -ErrorAction SilentlyContinue).Length",
				"Write-Output ('nw-file: ' + $bytes + 'B, exit ' + $p.ExitCode)",
				"exit $p.ExitCode",
				"",
			].join("\n"),
		);
		const relayEnv = {
			DIAG_BUN: bunExe,
			DIAG_CORE: core,
			DIAG_ARGS: args.join(" "),
			DIAG_CWD: versionDir,
			DIAG_TMP: diagDir,
		};
		const relayLayers: Array<[string, string, string[]]> = [
			["ps1-nw-relay", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", relayScript]],
			[
				"cmd-ps1-nw-relay",
				"cmd",
				["/c", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", relayScript],
			],
			["ps1-nw-file", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileScript]],
			["ps1-echo", "powershell.exe", ["-NoProfile", "-Command", "Write-Output diag-ps1-echo-marker"]],
			[
				"cmd-ps1-echo",
				"cmd",
				["/c", "powershell.exe", "-NoProfile", "-Command", "Write-Output diag-ps1-echo-marker"],
			],
		];
		for (const [label, cmd, argv] of relayLayers) {
			try {
				const r = await spawn(cmd, argv, { cwd: versionDir, timeoutMs: 60_000, env: relayEnv });
				const head = `${r.stdout}${r.stderr}`.trim().replace(/\s+/g, " ").slice(0, 220);
				stdoutBytes[label] = r.stdout.length;
				parts.push(`${label}: exit ${r.exitCode}${r.timedOut ? " TIMEOUT" : ""}, ${r.stdout.length}B stdout — ${head || "<no output>"}`);
			} catch (e) {
				parts.push(`${label}: spawn error ${(e as Error).message}`);
			}
		}
		parts.push(`relay-route (cmd→ps1 no-console spawn of bun): ${isNoConsoleRelayWorkaround(stdoutBytes) ? "WORKS" : "BROKEN"}`);
		// ── bun-relay probes (ticket 02 diag iteration 2) ──
		// Iteration 1 on windows-latest (run 33385015007, 2026-08-31) REFUTED
		// the powershell relay: powershell.exe loses its OWN Write-Output under
		// the piped spawn (ps1-echo 0B), so no ps1-shaped chain can re-emit
		// anything. The surviving lanes: node→bun (bun-direct >0B) and cmd's
		// OWN writes (cmd-echo, cmd-echo-bunspawn >0B). The unmeasured parent
		// that could bridge them: BUN itself. A bun -e relay spawns the core
		// DIRECTLY (the proven bun-direct lane, now with bun as the parent)
		// and either re-emits via its own stdout or writes the captured bytes
		// to a file ITSELF (its own fs write, not a cmd `>` handle — the
		// cmd-bun-file 0B result does not apply). `cmd-bun-relay-file` is the
		// shipped-shim candidate chain: .cmd → bun relay (stdout dead, alive
		// otherwise) → direct core spawn captured → file → cmd `type`s it.
		const relayJs = join(diagDir, "diag-bun-relay.js");
		writeFileSync(
			relayJs,
			[
				`// diag-bun-relay.js - spawn the core DIRECTLY (bun as parent), relay via`,
				`// stdout (RELAY_MODE=pipe) or a self-written file (RELAY_MODE=file).`,
				`// Plain JS on purpose: bun parses .js WITHOUT TypeScript syntax, so no`,
				`// non-null "!" assertions (iteration-2 receipt: exit 1 "Unexpected !").`,
				`const args = (process.env.DIAG_ARGS || "").split(" ").filter(Boolean);`,
				`const p = Bun.spawn([process.env.DIAG_BUN, process.env.DIAG_CORE].concat(args), {`,
				`	cwd: process.env.DIAG_CWD,`,
				`	stdout: "pipe",`,
				`	stderr: "pipe",`,
				`});`,
				`const out = await Bun.readableStreamToText(p.stdout);`,
				`const err = await Bun.readableStreamToText(p.stderr);`,
				`const code = await p.exited;`,
				`if (process.env.RELAY_MODE === "file") {`,
				`	await Bun.write(process.env.DIAG_OUT, out);`,
				`} else {`,
				`	process.stdout.write(out);`,
				`	process.stderr.write(err);`,
				`}`,
				`process.exit(code);`,
				``,
			].join("\n"),
		);
		// cmd /c bun -e "console.log(...)" — is bun-as-cmd's-child silence about
		// bun.exe itself, or the core bundle? One marker line, no bundle.
		try {
			const label = "cmd-bun-echo";
			const r = await spawn("cmd", ["/c", bunExe, "-e", "console.log('diag-bun-echo-marker')"], {
				cwd: versionDir,
				timeoutMs: 60_000,
			});
			const head = `${r.stdout}${r.stderr}`.trim().replace(/\s+/g, " ").slice(0, 220);
			stdoutBytes[label] = r.stdout.length;
			parts.push(`${label}: exit ${r.exitCode}${r.timedOut ? " TIMEOUT" : ""}, ${r.stdout.length}B stdout — ${head || "<no output>"}`);
		} catch (e) {
			parts.push(`cmd-bun-echo: spawn error ${(e as Error).message}`);
		}
		for (const [label, cmd, argv, env, probeFile] of [
			[
				"bun-relay-pipe",
				bunExe,
				[relayJs],
				{ RELAY_MODE: "pipe" },
				null as string | null,
			],
			[
				"cmd-bun-relay-pipe",
				"cmd",
				["/c", bunExe, relayJs],
				{ RELAY_MODE: "pipe" },
				null,
			],
			[
				"cmd-bun-relay-file",
				"cmd",
				["/c", bunExe, relayJs],
				{ RELAY_MODE: "file", DIAG_OUT: join(diagDir, "relay-out.txt") },
				join(diagDir, "relay-out.txt"),
			],
		] as Array<[string, string, string[], Record<string, string>, string | null]>) {
			try {
				const r = await spawn(cmd, argv, { cwd: versionDir, timeoutMs: 60_000, env: { ...relayEnv, ...env } });
				const head = `${r.stdout}${r.stderr}`.trim().replace(/\s+/g, " ").slice(0, 220);
				stdoutBytes[label] = r.stdout.length;
				// File mode: the receipt is the file the RELAY wrote (its stdout as
				// cmd's child is expected dead) — report its byte count + head.
				let fileNote = "";
				if (probeFile) {
					try {
						const txt = await Bun.file(probeFile).text();
						stdoutBytes[`${label}-file`] = txt.length;
						fileNote = `, relay file ${txt.length}B — ${txt.trim().replace(/\s+/g, " ").slice(0, 120) || "<empty file>"}`;
					} catch {
						fileNote = ", relay file MISSING";
					}
				}
				parts.push(`${label}: exit ${r.exitCode}${r.timedOut ? " TIMEOUT" : ""}, ${r.stdout.length}B stdout${fileNote} — ${head || "<no output>"}`);
			} catch (e) {
				parts.push(`${label}: spawn error ${(e as Error).message}`);
			}
		}
		parts.push(
			`bun-relay-route (cmd→bun relay→direct core spawn): ${
				isBunRelayWorkaround(stdoutBytes) ? "WORKS" : "BROKEN"
			}`,
		);
		// ── shipped-relay isolation probes (ticket 02, iterations 4-5 follow-up) ──
		// Runs 33387224763/33388084709: the shipped .cmd still delivers 0B
		// although the diag relay (env-forced file mode) delivers 1288B. Three
		// decisive measurements: (1) the SHIPPED relay file, run as cmd's child
		// with preset S2_RELAY_OUT — isolates the relay's own branch logic from
		// the .cmd glue; (2) bun's isTTY truth in this spawn shape, written to a
		// FILE (its stdout is dead here) — the relay branches on
		// stdout.isTTY && stdin.isTTY, and iteration-4's empty output suggests
		// that check lies in the console-attached piped shape; (3) cmd's `type`
		// of a marker file — the .cmd's re-emission glue itself.
		const shippedRelay = join(versionDir, "s2-agent-relay.js");
		const shippedOut = join(diagDir, "shipped-relay-out.txt");
		const shippedErr = join(diagDir, "shipped-relay-err.txt");
		const ttyProbeFile = join(diagDir, "tty-truth.txt");
		try {
			const r = await spawn("cmd", ["/c", bunExe, shippedRelay, ...args], {
				cwd: versionDir,
				timeoutMs: 60_000,
				env: { DIAG_BUN: bunExe, DIAG_CORE: core, DIAG_ARGS: args.join(" "), DIAG_CWD: versionDir, S2_RELAY_OUT: shippedOut, S2_RELAY_ERR: shippedErr },
			});
			const outBytes = await Bun.file(shippedOut)
				.text()
				.catch(() => null);
			const errBytes = await Bun.file(shippedErr)
				.text()
				.catch(() => null);
			stdoutBytes["cmd-shipped-relay-file"] = outBytes?.length ?? 0;
			parts.push(
				`cmd-shipped-relay: exit ${r.exitCode}, pipe ${r.stdout.length}B — out file ${outBytes?.length ?? -1}B (${outBytes ? "written" : "MISSING"}), err file ${errBytes?.length ?? -1}B (${errBytes ? "written" : "MISSING"})`,
			);
		} catch (e) {
			parts.push(`cmd-shipped-relay: spawn error ${(e as Error).message}`);
		}
		try {
			await spawn(
				"cmd",
				[
					"/c",
					bunExe,
					"-e",
					`Bun.write(${JSON.stringify(ttyProbeFile)}, "stdout.isTTY=" + process.stdout.isTTY + " stdin.isTTY=" + process.stdin.isTTY)`,
				],
				{ cwd: versionDir, timeoutMs: 60_000 },
			);
			const truth = await Bun.file(ttyProbeFile).text();
			parts.push(`bun-isTTY-truth (cmd child, file-reported): ${truth.trim()}`);
		} catch (e) {
			parts.push(`bun-isTTY-truth: spawn error ${(e as Error).message}`);
		}
		const typeMarker = join(diagDir, "type-marker.txt");
		writeFileSync(typeMarker, "diag-cmd-type-marker\n");
		try {
			const r = await spawn("cmd", ["/c", "type", typeMarker], { cwd: versionDir, timeoutMs: 60_000 });
			stdoutBytes["cmd-type"] = r.stdout.length;
			parts.push(`cmd-type: exit ${r.exitCode}, ${r.stdout.length}B stdout — ${r.stdout.trim() || "<no output>"}`);
		} catch (e) {
			parts.push(`cmd-type: spawn error ${(e as Error).message}`);
		}
	} finally {
		rmSync(diagDir, { recursive: true, force: true });
	}
	// The measured upstream signature (windows-latest, bun 1.4.0 = latest as
	// of 2026-08-28, identical under `bun-version: latest`): bun.exe delivers
	// full output when spawned directly, cmd.exe's own echo flows, but bun as
	// cmd's or powershell's child delivers ZERO bytes — pipe, file redirect,
	// everything — while exiting 0. No matching upstream issue exists
	// (searched 2026-08-29 — bun#12108 is batch termination, a different
	// bug; filing deliberately skipped, win32-launcher-stdout D5). Since t02
	// the shipped shims carry the stdout relay (s2-agent-relay.js), so this
	// signature on a launcher probe is a REAL DEFECT (the relay is broken or
	// missing) — FAIL. The ONLY remaining skip is the true unknown: even
	// bun-direct dead means the environment cannot verify the runtime at all.
	return {
		summary: `win32 layer diag:\n  ${parts.join("\n  ")}`,
		isBunShellChildBug: isBunShellChildSignature(stdoutBytes),
		isTrueUnknown: (stdoutBytes["bun-direct"] ?? 0) === 0,
	};
}

/**
 * Pure signature check for the no-console relay workaround (ticket 02): the
 * full launcher-shaped chain (cmd → powershell relay → CREATE_NO_WINDOW bun)
 * delivers bun's bytes while the direct .cmd shim still loses them — i.e.
 * rewriting the shipped shims around the relay would make the launcher speak.
 */
export function isNoConsoleRelayWorkaround(bytes: Record<string, number>): boolean {
	return (bytes["cmd-ps1-nw-relay"] ?? 0) > 0 && (bytes["cmd-shim"] ?? -1) === 0;
}

/**
 * Pure signature check for the bun-relay workaround (ticket 02, diag
 * iteration 2): a bun -e relay as cmd's child spawns the core DIRECTLY (the
 * proven bun-direct lane) and writes the captured bytes to a file itself —
 * nonzero relay-file bytes while the direct .cmd shim still loses them.
 */
export function isBunRelayWorkaround(bytes: Record<string, number>): boolean {
	return (bytes["cmd-bun-relay-file-file"] ?? 0) > 0 && (bytes["cmd-shim"] ?? -1) === 0;
}

/** Pure signature check for the bun-as-shell-child output loss (see win32LayerDiag). */
export function isBunShellChildSignature(bytes: Record<string, number>): boolean {
	return (
		(bytes["bun-direct"] ?? 0) > 0 &&
		(bytes["cmd-echo"] ?? 0) > 0 &&
		(bytes["cmd-bun"] ?? -1) === 0 &&
		(bytes["cmd-shim"] ?? -1) === 0
	);
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
	/**
	 * Injectable vision-call seam. Default: runDeployedVisionAsk — the real
	 * deployed-bundle vision_ask (applies the s2-agent patch set + places a
	 * REAL model call). Unit tests inject fakes; a tree without file2md in its
	 * deploy set skips the probe and never reaches this seam.
	 */
	visionAsk?: (imagePath: string) => Promise<VisionAskOutcome>;
	/**
	 * Injectable vision-call deadline (default VISION_CALL_CAP_MS). Exists so
	 * unit tests can exercise the timeout path without waiting 120s.
	 */
	visionCallCapMs?: number;
	/**
	 * Pin the one-shot spawns (model-call + tools-probe) to ONE lane via the
	 * D8 env form (PI_PROVIDER/PI_MODEL/PI_THINKING=off) — `resolveE2eModelPin`
	 * from `VERIFY_E2E_MODEL`. Pinned, the one-shot runtime budget is
	 * DETERMINISTIC: a breach on a pinned light lane is the #1976 class, and
	 * the contention precheck (which polls the DEFAULT local endpoint, not the
	 * pinned lane) neither runs nor downgrades a breach. Unset (the default):
	 * the one-shot rides the tree's default lane, behavior unchanged.
	 */
	modelPin?: E2EModelPin;
}

/**
 * Run the probes against one deployed version dir. Never throws — every
 * failure (missing tree, unreadable deploy.json, probe fail) is a structured
 * FAIL outcome so callers can JSON-serialize it blindly.
 */
export async function runDeployE2e(opts: DeployE2eOptions): Promise<DeployE2eOutcome> {
	const now = opts.now ?? Date.now;
	const startedAt = now();
	const probes: DeployE2eProbe[] = [];

	// Tree preconditions: deploy.json readable (it also supplies the expected
	// extension set and the tree's target platform) and the launcher present.
	// Both are structured FAILs, not throws. The launcher is s2-agent.sh
	// (the run.sh shim was dropped in ticket 05) except on win32 trees, which
	// boot s2-agent.cmd through cmd /c (crossos t06).
	let enabled: string[] = [];
	let version = basename(opts.versionDir);
	let sourceSha = "";
	let launcher = launcherInvocation(undefined);
	try {
		const p = parseDeployJson(await readFile(join(opts.versionDir, "deploy.json"), "utf8"));
		if (!p.ok) return failFast(opts.versionDir, `deploy.json unreadable: ${p.message}`, startedAt, now);
		enabled = p.enabled;
		version = p.value.version;
		sourceSha = p.value.sourceSha;
		launcher = launcherInvocation(p.value.runtime?.platform);
	} catch (e) {
		return failFast(opts.versionDir, `deploy.json unreadable: ${(e as Error).message}`, startedAt, now);
	}
	// This recipe PIPES every launcher spawn — so it declares that to the
	// shipped win32 stdout relay (S2_RELAY_FORCE=file; bun's isTTY cannot
	// detect the piped shape, measured run 33388819180 — the consumer knows).
	// POSIX launchers ignore the var.
	const launcherEnv: Record<string, string> | undefined =
		launcher.file === "s2-agent.cmd" ? { S2_RELAY_FORCE: "file" } : undefined;
	if (!(await Bun.file(join(opts.versionDir, launcher.file)).exists())) {
		return failFast(opts.versionDir, `${launcher.file} missing from the version dir`, startedAt, now);
	}
	// win32 boot chain: the .cmd entry invokes bun directly, but the .ps1
	// twin still ships for PowerShell-native users — a tree missing it is
	// incompletely shipped, and the check names it before anything else can.
	if (launcher.file === "s2-agent.cmd" && !(await Bun.file(join(opts.versionDir, "s2-agent.ps1")).exists())) {
		return failFast(opts.versionDir, "s2-agent.ps1 missing from the version dir", startedAt, now);
	}

	// ── boot probe ──────────────────────────────────────────────────────────
	{
		const t0 = now();
		const r = await opts.spawn(launcher.command, [...launcher.prefix, "--help"], { cwd: opts.versionDir, timeoutMs: BOOT_CAP_MS, env: launcherEnv });
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
	// cwd-independence (next block) re-runs --ext-list from OUTSIDE the tree
	// and compares against this run's loaded set — captured on success.
	let extLoadLoaded: string[] | null = null;
	{
		const t0 = now();
		const r = await opts.spawn(launcher.command, [...launcher.prefix, "--ext-list"], { cwd: opts.versionDir, timeoutMs: EXT_LIST_CAP_MS, env: launcherEnv });
		const ms = now() - t0;
		if (r.timedOut || r.exitCode !== 0) {
			const diag =
				process.platform === "win32" ? await win32LayerDiag(opts.spawn, opts.versionDir, ["--ext-list"]) : null;
			probes.push({
				id: "ext-load",
				verdict: diag?.isTrueUnknown ? "skip" : "fail",
				ms,
				note:
					diag?.isTrueUnknown
						? "--ext-list unverifiable in THIS environment: even bun-direct (the lane the deploy gates prove) delivers no output — see layer diag"
						: `--ext-list ${r.timedOut ? `timed out after ${EXT_LIST_CAP_MS}ms` : `exited ${r.exitCode}`}`,
				detail: `${tail(r.stdout, r.stderr)}${diag ? `\n${diag.summary}` : ""}`,
			});
		} else {
			const p = parseExtListPayload(r.stdout);
			if (!p.ok) {
				const diag =
					process.platform === "win32" ? await win32LayerDiag(opts.spawn, opts.versionDir, ["--ext-list"]) : null;
				probes.push({
					id: "ext-load",
					verdict: diag?.isTrueUnknown ? "skip" : "fail",
					ms,
					note: diag?.isTrueUnknown
						? "--ext-list stdout empty via the launcher AND via bun-direct — this environment cannot verify the runtime at all; see layer diag"
						: p.message,
					detail: `${tail(r.stdout, r.stderr)}${diag ? `\n${diag.summary}` : ""}`,
				});
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
				if (!missing.length) extLoadLoaded = p.value.loaded;
			}
		}
	}

	// ── cwd-independence probe ──────────────────────────────────────────────
	// The outRoot AGENTS.md promises the tree works from ANY cwd (agents and
	// bun scripts invoke the launcher / ext-standalone by absolute path from
	// scratch dirs — manually verified 2026-08-29, then encoded here). boot
	// and ext-load above prove loading from the tree's OWN dir only; this
	// probe re-runs --ext-list with cwd OUTSIDE the tree and requires the
	// SAME loaded set. A tree whose discovery depends on cwd (baked builder
	// paths, relative ext resolution) fails HERE, not in a user's script.
	{
		const t0 = now();
		const outsideDir = mkdtempSync(join(tmpdir(), "s2-e2e-cwd-"));
		// Invoke by ABSOLUTE path — the way a real consumer does from another
		// directory. launcher.command is relative ("./s2-agent.sh"; win32
		// prefix carries "s2-agent.cmd"), which only resolves with cwd inside
		// the tree — absolutizing is part of the contract under test, not a
		// workaround: AGENTS.md's quickstart uses the absolute path.
		const foreignCommand = launcher.command.startsWith(".") ? join(opts.versionDir, launcher.command) : launcher.command;
		const foreignPrefix = launcher.prefix.map((a) => (a === "s2-agent.cmd" ? join(opts.versionDir, a) : a));
		try {
			const r = await opts.spawn(foreignCommand, [...foreignPrefix, "--ext-list"], {
				cwd: outsideDir,
				timeoutMs: EXT_LIST_CAP_MS,
				env: launcherEnv,
			});
			const ms = now() - t0;
			const p = r.timedOut || r.exitCode !== 0 ? null : parseExtListPayload(r.stdout);
			if (extLoadLoaded === null) {
				probes.push({
					id: "cwd-independence",
					verdict: "skip",
					ms,
					note: "ext-load itself did not pass cleanly — no in-tree set to compare against",
					detail: tail(r.stdout, r.stderr),
				});
			} else if (!p?.ok) {
				// ext-load passed in-tree but the foreign-cwd run errors: that
				// IS the cwd-dependence bug this probe exists to catch.
				probes.push({
					id: "cwd-independence",
					verdict: "fail",
					ms,
					note: `--ext-list from a foreign cwd ${r.timedOut ? `timed out after ${EXT_LIST_CAP_MS}ms` : `failed (exit ${r.exitCode})`}`,
					detail: tail(r.stdout, r.stderr),
				});
			} else {
				const same =
					extLoadLoaded.length === p.value.loaded.length && [...p.value.loaded].sort().join(",") === [...extLoadLoaded].sort().join(",");
				probes.push(
					same
						? { id: "cwd-independence", verdict: "pass", ms, note: `same ${p.value.loadedCount} extension(s) loaded from a foreign cwd` }
						: {
								id: "cwd-independence",
								verdict: "fail",
								ms,
								note: `loaded set differs by cwd (in-tree vs foreign): [${extLoadLoaded.join(", ")}] vs [${p.value.loaded.join(", ")}]`,
							},
				);
			}
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
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
				const tpEnv = { ...launcherEnv, ...(opts.modelPin ? pinSpawnEnv(opts.modelPin) : undefined) };
			const r = await opts.spawn(launcher.command, [...launcher.prefix, "-e", probePath, "-p", "hi", "--no-session"], {
				cwd: opts.versionDir,
				timeoutMs: TOOLS_PROBE_CAP_MS,
				// undefined (not {}) when empty — the recording fakes and the
				// "no spawn env anywhere" contract distinguish the two.
				env: Object.keys(tpEnv).length ? tpEnv : undefined,
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
				if (process.platform === "win32" && tpVerdict === "fail") {
					const diag = await win32LayerDiag(opts.spawn, opts.versionDir, ["--help"]);
					tpDetail += `\n${diag.summary}`;
					if (diag.isTrueUnknown) {
						// The probe's [TOOLS] marker travels on stderr — with even
						// bun-direct dead, this environment cannot verify the runtime
						// at all. Anything less is a real defect (the shipped relay
						// should have carried it) and stays a FAIL.
						tpVerdict = "skip";
						tpNote = "probe output unverifiable in this environment (see layer diag)";
					}
				}
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

	// ── providers-catalog probe ──────────────────────────────────────────────
	// The pre-load-providers patch (s2-agent patches/pre-load-providers.ts — the
	// ModelRuntime.create wrap) is the ONLY thing that surfaces the baked
	// PROVIDERS catalog (lm-studio + the deepseek/zai overrides) with NO
	// ~/.pi/agent/models.json. Its historical failure shape: pre-0.80 the hook
	// target (ModelRegistry.loadModels) vanished upstream, the wrap installed a
	// method nobody called, and everything stayed green only because models.json
	// happened to duplicate the catalog. NOTHING re-verifies the wrap against the
	// FINAL frozen tree — boot/ext-load/tools-probe never list models. This probe
	// does: `--list-models` TWICE under a scratch agent-dir, patch ON (default)
	// vs patch OFF (BUN_PI_PRE_LOAD_PROVIDERS=0). The OFF run MEASURES what
	// ambient sources (pi-ai builtin catalog + any models.json residue) provide,
	// so (a) a dead wrap fails on missing baked pairs, and (b) a fully duplicated
	// catalog cannot mask it — the ON run must contribute at least one pair the
	// OFF run lacks (the patch's own work). Measured grounding 2026-08-29: dev
	// patch ON = 4 lm-studio lanes vs OFF = 2 (models.json residue) on this
	// machine; deploy current shows all 4 incl. the baked-only prism-ml/bonsai-27b.
	{
		const t0 = now();
		const scratchDir = mkdtempSync(join(tmpdir(), "s2-e2e-providers-"));
		let pcVerdict: ProbeVerdict = "fail";
		let pcNote = "";
		let pcDetail: string | undefined;
		try {
			const agentEnv = providersProbeEnv(scratchDir, opts.versionDir);
			const on = await opts.spawn(launcher.command, [...launcher.prefix, "--list-models"], {
				cwd: opts.versionDir,
				timeoutMs: PROVIDERS_LIST_CAP_MS,
				env: { ...agentEnv, ...launcherEnv },
			});
			const off = await opts.spawn(launcher.command, [...launcher.prefix, "--list-models"], {
				cwd: opts.versionDir,
				timeoutMs: PROVIDERS_LIST_CAP_MS,
				env: { ...agentEnv, ...launcherEnv, BUN_PI_PRE_LOAD_PROVIDERS: "0" },
			});
			const onRows = on.exitCode === 0 && !on.timedOut ? parseListModelsRows(on.stdout) : null;
			const offRows = off.exitCode === 0 && !off.timedOut ? parseListModelsRows(off.stdout) : null;
			if (onRows === null) {
				pcNote = `patch-on --list-models ${on.timedOut ? `timed out after ${PROVIDERS_LIST_CAP_MS}ms` : `exited ${on.exitCode}`}`;
				pcDetail = tail(on.stdout, on.stderr);
			} else if (offRows === null) {
				pcNote = `patch-off baseline --list-models ${off.timedOut ? `timed out after ${PROVIDERS_LIST_CAP_MS}ms` : `exited ${off.exitCode}`} — the diff needs it`;
				pcDetail = tail(off.stdout, off.stderr);
			} else {
				const baked = bakedModelPairs();
				const listed = (p: { provider: string; model: string }) => onRows.get(p.provider)?.has(p.model) ?? false;
				const ambient = (p: { provider: string; model: string }) => offRows.get(p.provider)?.has(p.model) ?? false;
				const missing = baked.filter((p) => !listed(p));
				const patchOnly = baked.filter((p) => listed(p) && !ambient(p));
				if (missing.length) {
					pcNote = `${missing.length}/${baked.length} baked catalog pair(s) missing from --list-models (e.g. ${missing
						.slice(0, 3)
						.map((p) => `${p.provider}/${p.model}`)
						.join(", ")}) — the ModelRuntime.create wrap is not registering the baked PROVIDERS (the pre-0.80 loadModels precedent: hook target gone upstream?)`;
					pcDetail = tail(on.stdout, on.stderr);
				} else if (patchOnly.length === 0) {
					pcNote = `patch contributes nothing — the patch-OFF baseline already lists every baked pair (models.json duplication masking a dead wrap: the exact pre-0.80 accident this probe exists for; remove the duplication from personal config)`;
					pcDetail = tail(off.stdout, off.stderr);
				} else {
					pcVerdict = "pass";
					pcNote = `${baked.length} baked catalog pair(s) listed; ${patchOnly.length} patch-only (e.g. ${patchOnly[0].provider}/${patchOnly[0].model}) — ModelRuntime.create wrap alive in the shipped tree`;
				}
			}
		} catch (e) {
			pcNote = `execution failed: ${e instanceof Error ? e.message : String(e)}`;
			pcDetail = pcNote;
		} finally {
			try {
				rmSync(scratchDir, { recursive: true, force: true });
			} catch {
				/* */
			}
		}
		probes.push({ id: "providers-catalog", verdict: pcVerdict, ms: now() - t0, note: pcNote, detail: pcDetail });
	}
	}

	// ── model-call probe ────────────────────────────────────────────────────
	const warnings: string[] = [];
	let modelCallSkippedByCaller = false;
	// Set when the vision probe was excluded by environment, not by outcome —
	// not-applicable skips must not degrade the overall verdict (see worst()).
	let visionSkippedNotApplicable = false;
	if (opts.skipModelCall) {
		// Recorded as a skip probe for the report, but NOT allowed to degrade
		// the overall verdict — the caller asked for two probes, two probes ran.
		modelCallSkippedByCaller = true;
		probes.push({ id: "model-call", verdict: "skip", ms: 0, note: "skipped by caller (--skip-model-call flag or S2_AGENT_E2E_SKIP_MODEL_CALL=1)" });
	} else {
		// Contention precheck: >1 large chat model resident on the endpoint is
		// the measured condition (2026-08-23) under which generation is slow
		// enough to blow past even the 300s cap. Best-effort and bounded — a
		// down/unreachable endpoint just yields no warning (the probe itself
		// will classify whatever follows). SKIPPED when a lane pin is active:
		// the precheck polls the DEFAULT local endpoint (LM Studio), which a
		// pinned remote lane never touches — its warning would be about a lane
		// the one-shot does not use, and the skip-downgrade it buys would turn
		// the pinned budget deterministic gate back into a coin flip.
		if (opts.modelEndpoint && !opts.modelPin) {
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
		const r = await opts.spawn(launcher.command, [...launcher.prefix, "-p", DEPLOY_E2E_PROMPT, "--no-session"], {
			cwd: opts.versionDir,
			timeoutMs: MODEL_CALL_CAP_MS,
			env: opts.modelPin ? pinSpawnEnv(opts.modelPin) : undefined,
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
		// When a lane pin is active there is exactly one explanation for a
		// breach on a light lane — the #1976 serialization class — so the note
		// names the lane (receipt: the reader sees WHICH lane was measured).
		const laneNote = opts.modelPin ? ` — lane ${pinLabel(opts.modelPin)} (pinned via ${VERIFY_E2E_MODEL_ENV})` : "";
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
		// Appended last so EVERY outcome (pass note, breach note, timeout note)
		// carries the lane receipt when a pin measured it.
		if (laneNote) note += laneNote;
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

	// ── vision-call probe ────────────────────────────────────────────────────
	// The default vision lane's health is otherwise INVISIBLE to this recipe:
	// model-call proves a TEXT round-trip only, and a broken lane fails
	// silently (unresolvable capability → text-model fallback → empty output
	// for an image, measured 2026-08-24). Only an image whose content is
	// knowable solely by SEEING it proves the lane processes images. Skipped
	// with the same contract as model-call when the caller opts out.
	if (!enabled.includes("file2md")) {
		visionSkippedNotApplicable = true;
		probes.push({ id: "vision-call", verdict: "skip", ms: 0, note: "file2md not in deploy set" });
	} else if (modelCallSkippedByCaller) {
		visionSkippedNotApplicable = true;
		probes.push({ id: "vision-call", verdict: "skip", ms: 0, note: "skipped by caller (--skip-model-call flag or S2_AGENT_E2E_SKIP_MODEL_CALL=1)" });
	} else {
		const t0 = now();
		const workDir = mkdtempSync(join(tmpdir(), "vision-e2e-"));
		let vVerdict: ProbeVerdict = "fail";
		let vNote = "";
		let vDetail: string | undefined;
		try {
			const fixturePath = join(workDir, "vision-e2e.png");
			writeFileSync(fixturePath, Buffer.from(F2MD_E2E_OCR_B64, "base64"));
			const hostModules = readExtHostModules(join(opts.versionDir, "ext", "file2md", "ext.json"));
			const ask =
				opts.visionAsk ?? ((imagePath: string) => runDeployedVisionAsk({ versionDir: opts.versionDir, hostModules }, imagePath));
			// In-process work has no spawn timeout — race a deadline instead.
			// A breach is a SKIP (slow generation under contention is as likely
			// as a wedge; same posture as the model-call timeout). The losing
			// side is abandoned, not canceled: the timer is cleared when ask()
			// wins, and a late rejection from a timed-out ask() is swallowed so
			// it can never surface as an unhandled rejection in a host process.
			const capMs = opts.visionCallCapMs ?? VISION_CALL_CAP_MS;
			let timedOut = false;
			let raceTimer: ReturnType<typeof setTimeout> | undefined;
			const r = await Promise.race([
				ask(fixturePath).catch((e: unknown): VisionAskOutcome => {
					if (timedOut) return { ok: false, reply: "", error: e instanceof Error ? e.message : String(e) };
					throw e;
				}),
				new Promise<VisionAskOutcome>((res) => {
					raceTimer = setTimeout(() => {
						timedOut = true;
						res({ ok: false, reply: "", error: `vision_ask exceeded ${Math.round(capMs / 1000)}s` });
					}, capMs);
				}),
			]);
			if (!timedOut && raceTimer !== undefined) clearTimeout(raceTimer);
			if (timedOut) {
				vVerdict = "skip";
				vNote = `vision_ask exceeded ${Math.round(capMs / 1000)}s — SLOW generation under model contention is as likely as a wedge (the ask is abandoned; the fixture dir below may already be gone)`;
			} else if (r.ok && normalizeVisionReply(r.reply).includes(VISION_FIXTURE_NEEDLE)) {
				vVerdict = "pass";
				vNote = `default vision lane read the fixture image ("${VISION_FIXTURE_NEEDLE}") — reply: ${r.reply.slice(0, 120)}`;
			} else if (!r.ok && r.error !== undefined && visionErrorIsProviderDown(r.error)) {
				vVerdict = "skip";
				vNote = `provider down — ${r.error.slice(0, 200)}`;
			} else {
				vNote = !r.ok
					? `default vision lane failed on an image ask — ${r.error?.slice(0, 200) ?? "unknown error"} (an empty/no-output result is the measured signature of a silent text-model fallback: the image never reached a vision model)`
					: `default vision lane answered but did NOT read the image — reply lacked "${VISION_FIXTURE_NEEDLE}": ${normalizeVisionReply(r.reply).slice(0, 200)}`;
				vDetail = `reply: ${r.reply.slice(0, 500)}${r.error ? `\nerror: ${r.error.slice(0, 500)}` : ""}`;
			}
		} catch (e) {
			vNote = `execution failed: ${e instanceof Error ? e.message : String(e)}`;
			vDetail = vNote;
		} finally {
			try {
				rmSync(workDir, { recursive: true, force: true });
			} catch {
				/* */
			}
		}
		probes.push({ id: "vision-call", verdict: vVerdict, ms: now() - t0, note: vNote, detail: vDetail });
	}

	// ── file2md-ocr probe ───────────────────────────────────────────────────
	// A REAL OCR run through the DEPLOYED bundle and the deployed vendored
	// assets — no model, no agent loop (executeExtTool evaluates ext.cjs with
	// the runtime loader; `#pi/ext-dir` serves the deployed ext dir so the
	// wasm + vendored npm lang data resolve inside the frozen tree). A broken
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
			await executeExtTool(
				join(opts.versionDir, "ext", "file2md", "ext.cjs"),
				"file2md",
				{ input: fixturePath, out: outDir, mode: "ocr", lang: "en" },
				readExtHostModules(join(opts.versionDir, "ext", "file2md", "ext.json")),
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
			const r = await runToolGateFireProbe(
				join(opts.versionDir, "ext", "tool-gate", "ext.cjs"),
				readExtHostModules(join(opts.versionDir, "ext", "tool-gate", "ext.json")),
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

	// ── standalone-import probe ──────────────────────────────────────────────
	// ext-standalone-import t04: the dist's standalone consumption surface,
	// proven the way a real consumer uses it — the AGENTS.md quickstart run
	// from a scratch dir (no repo/workspace) against a fixture git repo with
	// the DEPLOYED bin/bun, a file2md cross-check THROUGH the shim, and the
	// shim's text gates re-run at probe time. Skip on pre-t02 trees (no shim).
	probes.push(await standaloneImportProbe(opts.versionDir));

	const verdict = worst(
		probes
			.filter((p) => {
				if (modelCallSkippedByCaller && p.id === "model-call") return false;
				if (visionSkippedNotApplicable && p.id === "vision-call") return false;
				// Not-applicable skips are inconclusive, not a degraded verdict.
				if (p.id === "file2md-ocr" && p.verdict === "skip") return false;
				if (p.id === "tool-gate-fire" && p.verdict === "skip") return false;
				if (p.id === "standalone-import" && p.verdict === "skip") return false;
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
