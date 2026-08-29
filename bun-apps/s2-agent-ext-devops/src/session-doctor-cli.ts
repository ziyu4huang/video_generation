#!/usr/bin/env bun
/**
 * session-doctor-cli — prove an s2-agent session (dev OR deploy) actually has
 * its tool surface, and list the models you can actually use.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every s2-agent-sh deploy between #1921 and #1946 booted a TOOLLESS session:
 * the model's API request carried `tools: []`, no tool call ever executed, and
 * all five deploy e2e gates stayed green (boot/ext-load/model-call never
 * assert tool registration). The bug was caught only by a manual tmux +
 * logging-proxy loop (2026-08-24). This CLI hardens that loop into a one-line
 * devops tool that runs against BOTH targets:
 *
 *   dev    — `bun bun-apps/s2-agent/src/cli.ts` (source tree)
 *   deploy — `<deployRoot>/<target>/current/s2-agent.sh` (the frozen dist
 *   launcher; `<target>` = host platform name, resolved target-first)
 *
 * The default check is the tool-surface probe — the SAME probe deploy-e2e's
 * `tools-probe`, deploy-probe-e2e, and `doctor --smoke` use
 * (`src/tools-active-probe.ts`, the ONE-probe doctrine): it reads the ACTIVE
 * set at `before_agent_start` (AFTER tool-gate's session_start — a
 * session_start read is a false green, see the probe header) and asserts the
 * core builtins are active. The verdict discriminates the failure classes the
 * 2026-08-24 RCAs (#1946 + its #1952 completion) named:
 *   - `total=0`           → toolless session (nothing registered)
 *   - `activeCount=0`     → active set wiped (`setActiveTools([])`, #1946)
 *   - `missing≠[]`        → core builtins dropped (#1952's half-fix class)
 *
 * Default model is the LOCAL lane (lm-studio qwen3.8-27b) so the doctor never
 * depends on a paid API key; override with --provider/--model.
 *
 * `--models` answers "which models can I ACTUALLY use": it runs `--list-models`
 * (the full baked catalog — mostly providers with no key on this machine) and
 * filters it through a STATIC readiness pass — stored credentials
 * (`~/.pi/agent/auth.json`), custom providers (`~/.pi/agent/models.json` with
 * an apiKey), provider env keys, and a reachability probe for localhost
 * servers. It deliberately does NOT shell `auth check --provider <id>`: that
 * path is slow (>120s for the full set) and its output interleaves extension
 * banners, which is exactly how v1 of this filter mis-parsed every provider
 * as not_ready. `--tui` boots the target in a REAL pty (tmux), answers the
 * trust prompt, and asserts the interactive-boot surface the headless probe
 * cannot see: footer render + the REQUESTED model lane (settings
 * defaultProvider would otherwise hijack it). The `Tool gate: N/M` banner is
 * reported when present but NOT required — tool-gate is default-off since
 * #1952 (2026-08-24), so its absence is expected on current builds; a 0/0
 * banner when it IS shown is a fail.
 *
 * Exit 0 pass · 1 fail · 2 usage error.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shConfig } from "./deploy/lib/config.ts";
import { resolveCurrentVersionDir } from "./deploy-e2e-recipe.js";
import { createLiveSpawn, withDefaultTimeout, type SpawnFn } from "./spawn.js";
import { TOOLS_ACTIVE_PROBE, parseToolsProbeLine, type ToolsProbePayload } from "./tools-active-probe.js";
import { classifyRun } from "./oneshot-smoke.js";
import { defaultRepoRoot, type CliResult, emit, helpRequested, jsonResult, usageError } from "./cli-common.js";

export const SESSION_DOCTOR_CLI_USAGE = [
	"usage: session-doctor-cli.ts [--target dev|deploy] [--deploy-root <path>]",
	"                              [--provider <name>] [--model <id>]",
	"                              [--models] [--tui]",
	"",
	"Tool-surface check (default): boots the target with the shared",
	"tools-active probe (deploy-e2e's tools-probe, ONE-probe doctrine) and",
	"asserts core builtins are ACTIVE at before_agent_start — the check whose",
	"absence let a toolless deploy ship (#1921→#1946→#1952, 2026-08-24).",
	"Works on dev (source tree) and deploy (frozen dist) targets.",
	"",
	"  --target dev|deploy     dev: bun bun-apps/s2-agent/src/cli.ts (default)",
	"                          deploy: <deploy-root>/<target>/current/s2-agent.sh launcher",
	"  --deploy-root <path>    default: outRoot from s2-agent src/registry-config.ts",
	"  --provider <name>       default lm-studio (the local lane)",
	"  --model <id>            default qwen/qwen3.8-27b",
	"  --models                instead of the tool check: list models FILTERED to",
	"                          usable providers — stored credential / custom",
	"                          provider apiKey / env key, and localhost servers",
	"                          probed for reachability (no key ⇒ hidden)",
	"  --tui                   boot the target in a REAL pty (tmux): trust-prompt",
	"                          + footer + the REQUESTED model lane; tool-gate",
	"                          banner reported when present (optional — the ext",
	"                          is default-off since #1952; 0/0 shown = fail)",
	"",
	"Exit 0 pass · 1 fail · 2 usage error.",
].join("\n");

export interface ParsedSessionDoctorArgs {
	target: "dev" | "deploy";
	deployRoot?: string;
	provider: string;
	model: string;
	models?: boolean;
	tui?: boolean;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseSessionDoctorArgs(
	argv: string[],
): { ok: true; args: ParsedSessionDoctorArgs } | { ok: false; message: string } {
	let target: "dev" | "deploy" = "dev";
	let deployRoot: string | undefined;
	let provider = "lm-studio";
	let model = "qwen/qwen3.8-27b";
	let models: boolean | undefined;
	let tui: boolean | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--target") {
			const v = argv[++i];
			if (v !== "dev" && v !== "deploy") return { ok: false, message: `--target must be dev|deploy, got '${v}'` };
			target = v;
		} else if (a === "--deploy-root") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--deploy-root needs a value" };
			deployRoot = v;
		} else if (a === "--provider") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--provider needs a value" };
			provider = v;
		} else if (a === "--model") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--model needs a value" };
			model = v;
		} else if (a === "--models") {
			models = true;
		} else if (a === "--tui") {
			tui = true;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" };
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	return { ok: true, args: { target, deployRoot, provider, model, models, tui } };
}

/**
 * The probe is SHARED with deploy-e2e / deploy-probe-e2e / doctor --smoke
 * (`tools-active-probe.ts`) — see its header for the ordering contract (a
 * session_start read is a FALSE GREEN: `-e` probes load before tool-gate, so
 * the probe reads at `before_agent_start` + an unawaited 250ms defer). Keep
 * this file on that probe; do not grow a private one.
 */


/** Parse `🔧 Tool gate: N/M active` from a pane/log capture. */
export function parseToolGateBanner(text: string): { active: number; total: number } | null {
	const m = text.match(/Tool gate:\s*(\d+)\/(\d+)\s*active/);
	if (!m) return null;
	return { active: Number(m[1]), total: Number(m[2]) };
}

/** Parse a `--list-models` table into provider → model ids. */
export function parseListModelTable(text: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const line of text.split("\n")) {
		// Columns are separated by 2+ spaces: "provider  model  context  …"
		const cols = line.trim().split(/\s{2,}/);
		if (cols.length < 2) continue;
		const [provider, model] = cols;
		if (!provider || !model || provider === "provider") continue;
		(out[provider] ??= []).push(model);
	}
	return out;
}

/** Registry outRoot — the same default deploy-cli deploys into. */
function defaultDeployRoot(): string {
	const bunAppsDir = resolve(import.meta.dir, "..", "..");
	return shConfig({ bunAppsDir }).outRoot;
}

export interface SessionDoctorDeps {
	spawn?: SpawnFn;
	/** Repo root (cwd for both targets). Default: two levels above this package. */
	repoRoot?: string;
	deployRoot?: string;
	/** Agent state dir for --models readiness (auth.json / models.json). */
	agentDir?: string;
	/** Fetch impl for the localhost reachability probe. */
	fetchImpl?: typeof fetch;
}

interface TargetCmd {
	cmd: string;
	args: string[];
	cwd: string;
	label: string;
}

function resolveTarget(target: "dev" | "deploy", repoRoot: string, deployRoot: string): TargetCmd {
	if (target === "dev") {
		return {
			cmd: "bun",
			args: [join(repoRoot, "bun-apps", "s2-agent", "src", "cli.ts")],
			cwd: repoRoot,
			label: `dev (${join("bun-apps", "s2-agent", "src", "cli.ts")})`,
		};
	}
	const versionDir = resolveCurrentVersionDir(deployRoot);
	if (!versionDir) {
		throw new Error(`no 'current' under ${deployRoot} — nothing deployed, or the symlink is broken`);
	}
	// The LAUNCHER, not the bare bundle: it exports the agent-dir env vars
	// (S2-AGENT_CODING_AGENT_DIR) the bundle derives its per-user state from.
	return {
		cmd: join(versionDir, "s2-agent.sh"),
		args: [],
		cwd: repoRoot,
		label: `deploy (${versionDir})`,
	};
}

/** Write the SHARED tools-active probe to a fresh temp file; returns its path. */
function writeProbe(): string {
	const dir = join(tmpdir(), "session-doctor-probe");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const probePath = join(dir, "tools-probe.ts");
	writeFileSync(probePath, TOOLS_ACTIVE_PROBE);
	return probePath;
}

export interface ToolSurfaceOutcome {
	verdict: "pass" | "fail" | "skip";
	target: string;
	provider: string;
	model: string;
	/** From the [TOOLS] payload: active names (null = probe never reported). */
	activeTools: string[] | null;
	/** Registered tool count (getAllTools().length; null = never reported). */
	total: number | null;
	/** Core builtins absent from the active set (null = never reported). */
	missing: string[] | null;
	/** tool-gate self-report seam (null = ext absent/off — expected, #1952). */
	gateSeam: { activeCount: number; totalCount: number; coreCount: number } | null;
	note: string;
	warnings: string[];
	/** Last non-empty child output lines, only on probe-never-fired outcomes. */
	outputTail?: string[];
}

/**
 * Classify a parsed [TOOLS] payload. Pure — pinned by tests. The classes map
 * to the two RCAs: #1946 (`setActiveTools([])` wipe) and #1952 (builtin-union
 * half-fix: core builtins dropped while the active set stays non-empty).
 */
export function classifyToolsPayload(p: ToolsProbePayload): { verdict: "pass" | "fail"; note: string; failureClass?: string } {
	const seam = p.gateSeam ? `; gate seam ${p.gateSeam.activeCount}/${p.gateSeam.totalCount}, core ${p.gateSeam.coreCount}` : "";
	if (p.getActiveTools === false) {
		return { verdict: "fail", failureClass: "SURFACE-REGRESSED", note: `ExtensionAPI no longer exposes getActiveTools — the active set is unreadable${seam}` };
	}
	if (p.getError !== undefined) {
		return { verdict: "fail", failureClass: "SURFACE-REGRESSED", note: `getActiveTools() threw: ${p.getError}${seam}` };
	}
	if (p.total === 0) {
		return { verdict: "fail", failureClass: "TOOLLESS", note: `TOOLLESS SESSION: zero tools REGISTERED (getAllTools()=[]) — every tool call would silently die${seam}` };
	}
	if (p.activeCount === 0) {
		return { verdict: "fail", failureClass: "ACTIVE-SET-WIPED", note: `ACTIVE SET WIPED: ${p.total} registered but zero active — the #1946 setActiveTools([]) class${seam}` };
	}
	if (p.missing.length > 0) {
		return { verdict: "fail", failureClass: "CORE-BUILTINS-MISSING", note: `CORE BUILTINS MISSING: ${p.missing.join(", ")} not active (active=${p.activeCount}/${p.total} registered) — the #1952 half-fix class${seam}` };
	}
	return { verdict: "pass", note: `pass (active=${p.activeCount}/${p.total} registered; core builtins present${p.gateSeam ? seam : "; gate seam absent (tool-gate off/absent — expected since #1952)"})` };
}

/** The default tool-surface check over a captured probe run. Pure — testable. */
export function verdictFromProbeRun(
	target: string,
	provider: string,
	model: string,
	run: { stdout: string; stderr: string; exitCode: number; timedOut?: boolean; durationMs: number },
): ToolSurfaceOutcome {
	const base = { target, provider, model };
	const parsed = parseToolsProbeLine(run.stderr);
	if (!parsed.ok) {
		// Same skip contract as deploy-e2e: reaching before_agent_start
		// requires model resolution, so a FAST provider/auth failure is a
		// skip, not a fail (classifyRun is the shared authority).
		const c = classifyRun({ exitCode: run.exitCode, timedOut: run.timedOut === true, stdout: run.stdout, stderr: run.stderr, durationMs: run.durationMs });
		const tail = (run.stdout + "\n" + run.stderr).split("\n").filter((l) => l.trim() && !l.includes("[hermes-memory]")).slice(-5);
		return {
			...base,
			verdict: c.verdict === "skip" ? "skip" : "fail",
			activeTools: null,
			total: null,
			missing: null,
			gateSeam: null,
			note:
				c.verdict === "skip"
					? `probe never fired — ${c.reason}: ${c.detail?.split("\n")[0] ?? ""}`
					: `${parsed.message} (exit ${run.exitCode}${run.timedOut ? ", timed out — provider down or boot hang" : ""})`,
			warnings: [],
			outputTail: tail,
		};
	}
	const v = parsed.value;
	const c = classifyToolsPayload(v);
	return {
		...base,
		verdict: c.verdict,
		activeTools: v.active,
		total: v.total,
		missing: v.missing,
		gateSeam: v.gateSeam,
		note: c.note,
		warnings: [],
	};
}

/**
 * Provider → API-key env vars. Vendored from pi-ai's canonical map
 * (`dist/env-api-keys.js` — the package exports map is closed, so it cannot
 * be imported) with the same special cases. When pi-ai adds a provider, add
 * the row here in the same change.
 */
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	"github-copilot": ["COPILOT_GITHUB_TOKEN"],
	"ant-ling": ["ANT_LING_API_KEY"],
	"qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
	"qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
	"qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	google: ["GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY"], // ADC-based vertex auth is NOT detected here
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	xai: ["XAI_API_KEY"],
	radius: ["RADIUS_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	zai: ["ZAI_API_KEY"],
	"zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	huggingface: ["HF_TOKEN"],
	fireworks: ["FIREWORKS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	baseten: ["BASETEN_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	"xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	"xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};

export type ReadinessCheck =
	| { ready: true; source: "stored-credential" | "custom-provider" | "env-key" | "local-server" }
	| { ready: false; reason: string };

/** Extract `{provider: {baseUrl, apiKey}}` from a parsed models.json (or null). */
export function customProviderMap(modelsJson: unknown): Record<string, { baseUrl?: string; apiKey?: string }> {
	if (typeof modelsJson !== "object" || modelsJson === null) return {};
	const providers = (modelsJson as { providers?: unknown }).providers;
	if (typeof providers !== "object" || providers === null) return {};
	return providers as Record<string, { baseUrl?: string; apiKey?: string }>;
}

/**
 * Static readiness for ONE provider — pure over (parsed auth.json, parsed
 * models.json, env), mirroring resolveProviderAuth's precedence: a stored
 * credential owns the provider, then the custom-provider apiKey, then ambient
 * env keys. Localhost providers are exempt from the credential requirement
 * (they are authenticated by reachability; see probeLocalServer).
 */
export function classifyProviderReadiness(
	provider: string,
	authJson: unknown,
	modelsJson: unknown,
	env: Record<string, string | undefined>,
): ReadinessCheck {
	if (typeof authJson === "object" && authJson !== null && provider in (authJson as object)) {
		return { ready: true, source: "stored-credential" };
	}
	const custom = customProviderMap(modelsJson)[provider];
	if (custom && typeof custom.apiKey === "string" && custom.apiKey.length > 0) {
		return { ready: true, source: "custom-provider" };
	}
	const envKeys = PROVIDER_ENV_KEYS[provider];
	if (envKeys?.some((k) => !!(env[k] && env[k]!.length > 0))) {
		return { ready: true, source: "env-key" };
	}
	return { ready: false, reason: "no-credential (no stored key, custom apiKey, or env key)" };
}

/** Localhost / loopback custom provider — readiness = the server answers. */
export function isLocalProvider(modelsJson: unknown, provider: string): boolean {
	const baseUrl = customProviderMap(modelsJson)[provider]?.baseUrl;
	return typeof baseUrl === "string" && /:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(baseUrl);
}

/** GET `<baseUrl>/models` — an OpenAI-compatible liveness probe (2s budget). */
export async function probeLocalServer(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const url = `${baseUrl.replace(/\/$/, "")}/models`;
	try {
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

/** The `--models` action: catalog filtered to statically-ready providers. */
export async function runModelsAction(
	target: TargetCmd,
	spawn: SpawnFn,
	deps: Pick<SessionDoctorDeps, "agentDir" | "fetchImpl"> = {},
): Promise<CliResult> {
	const list = await spawn(target.cmd, [...target.args, "--list-models"], { cwd: target.cwd, timeoutMs: 60_000 });
	if (list.exitCode !== 0) {
		return jsonResult(1, { verdict: "fail", note: `--list-models exited ${list.exitCode}: ${list.stderr.slice(0, 300)}` });
	}
	const catalog = parseListModelTable(list.stdout);
	const agentDir = deps.agentDir ?? join(homedir(), ".pi", "agent");
	const readJson = (name: string): unknown => {
		try {
			return JSON.parse(readFileSync(join(agentDir, name), "utf8"));
		} catch {
			return null; // absent/unparsable state = no signal from that source
		}
	};
	const authJson = readJson("auth.json");
	const modelsJson = readJson("models.json");
	const fetchImpl = deps.fetchImpl ?? fetch;

	const ready: Record<string, string[]> = {};
	const sources: Record<string, string> = {};
	const blocked: Record<string, string> = {};
	for (const provider of Object.keys(catalog).sort()) {
		const local = isLocalProvider(modelsJson, provider);
		if (local) {
			const baseUrl = customProviderMap(modelsJson)[provider]!.baseUrl!;
			if (await probeLocalServer(baseUrl, fetchImpl)) {
				ready[provider] = catalog[provider];
				sources[provider] = "local-server (reachable)";
			} else {
				blocked[provider] = `unreachable (GET ${baseUrl}/models failed — is the local server up?)`;
			}
			continue;
		}
		const check = classifyProviderReadiness(provider, authJson, modelsJson, process.env);
		if (check.ready) {
			ready[provider] = catalog[provider];
			sources[provider] = check.source;
		} else {
			blocked[provider] = check.reason;
		}
	}
	return jsonResult(0, {
		verdict: "pass",
		target: target.label,
		agentDir,
		ready,
		sources,
		blocked,
		note: `${Object.keys(ready).length} provider(s) usable, ${Object.keys(blocked).length} hidden (no key / unreachable)`,
	});
}

export async function runSessionDoctorCli(argv: string[], deps: SessionDoctorDeps = {}): Promise<CliResult> {
	const parsed = parseSessionDoctorArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: SESSION_DOCTOR_CLI_USAGE };
		return usageError(parsed.message, SESSION_DOCTOR_CLI_USAGE);
	}
	const { target: targetKind, provider, model } = parsed.args;
	const repoRoot = deps.repoRoot ?? defaultRepoRoot();
	const deployRoot = parsed.args.deployRoot ?? deps.deployRoot ?? defaultDeployRoot();

	let target: TargetCmd;
	try {
		target = resolveTarget(targetKind, repoRoot, deployRoot);
	} catch (e) {
		return jsonResult(1, { verdict: "fail", note: e instanceof Error ? e.message : String(e) });
	}
	const spawn = withDefaultTimeout(deps.spawn ?? createLiveSpawn(repoRoot), 180_000);

	if (parsed.args.models) return runModelsAction(target, spawn, deps);
	if (parsed.args.tui) return runTuiAction(target, provider, model, spawn);

	const probePath = writeProbe();
	const t0 = Date.now();
	const run = await spawn(
		// Same invocation shape as deploy-e2e's tools-probe: -p hi reaches
		// before_agent_start; --no-session leaves no session litter.
		target.cmd,
		[...target.args, "-e", probePath, "-p", "hi", "--no-session", "--provider", provider, "--model", model],
		{ cwd: target.cwd, timeoutMs: 240_000 },
	);
	const outcome = verdictFromProbeRun(target.label, provider, model, {
		stdout: run.stdout,
		stderr: run.stderr,
		exitCode: run.exitCode,
		timedOut: run.timedOut === true,
		durationMs: Date.now() - t0,
	});
	return jsonResult(outcome.verdict === "fail" ? 1 : 0, outcome);
}

/**
 * The `--tui` action: boot the target in a REAL pty (tmux) and assert the
 * interactive-boot surface the headless probe cannot see — the trust prompt,
 * the footer render, and the REQUESTED model lane (passing --provider
 * explicitly; the settings defaultProvider would otherwise hijack it).
 *
 * Banner TIMING (tool-gate.ts scheduleToolGateBanner): when the ext IS
 * enabled it renders 5s AFTER session_start and auto-dismisses 8s later —
 * the poll loop keeps ~16s of post-footer patience before settling. Since
 * #1952 the ext is default-off, so an absent banner is a PASS.
 */
async function runTuiAction(
	target: TargetCmd,
	provider: string,
	model: string,
	spawn: SpawnFn,
): Promise<CliResult> {
	const session = `s2doctor-${process.pid}`;
	const tmux = async (...args: string[]) =>
		spawn("tmux", args, { timeoutMs: 30_000 });
	const kill = async () => {
		await tmux("kill-session", "-t", session).catch(() => undefined);
	};
	// --provider is passed EXPLICITLY: the user's defaultProvider would
	// otherwise hijack the model selection (see pi-settings-default-model).
	const cmd = [target.cmd, ...target.args, "--provider", provider, "--model", model].join(" ");
	await tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", cmd);
	try {
		// Trust prompt: answer it (first-run in a fresh agent dir). Sending
		// Enter on a pane that doesn't show the prompt is a no-op.
		let pane = "";
		let sawFooter = false;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			const cap = await tmux("capture-pane", "-t", session, "-p");
			pane = cap.stdout;
			if (/Trust project folder\?/.test(pane)) {
				await tmux("send-keys", "-t", session, "Enter");
			}
			// Footer rendered = interactive boot completed. Keep polling a bit
			// for the (optional) tool-gate banner, then settle on the footer.
			if (/Tool gate:/.test(pane)) break;
			if (pane.includes(model)) sawFooter = true;
			if (sawFooter && i > 8) break; // ~16s of extra patience post-footer
		}
		if (!pane.includes(model)) {
			return jsonResult(1, {
				verdict: "fail",
				target: target.label,
				provider,
				model,
				note: `TUI never rendered the requested model lane '${model}' within 120s — boot failure or a defaultProvider hijack`,
				paneTail: pane.split("\n").filter((l) => l.trim()).slice(-5),
			});
		}
		const banner = parseToolGateBanner(pane);
		if (banner && (banner.active === 0 || banner.total === 0)) {
			return jsonResult(1, {
				verdict: "fail",
				target: target.label,
				provider,
				model,
				banner,
				note: `fail (tool gate ${banner.active}/${banner.total} — the 0/0 toolless-boot signature)`,
			});
		}
		return jsonResult(0, {
			verdict: "pass",
			target: target.label,
			provider,
			model,
			banner,
			note: `pass (TUI booted in a real pty; model lane '${model}' rendered${banner ? `; tool gate ${banner.active}/${banner.total} active` : "; no tool-gate banner — expected, the ext is default-off since #1952"})`,
		});
	} finally {
		await kill();
	}
}

if (import.meta.main) emit(await runSessionDoctorCli(Bun.argv.slice(2)));
