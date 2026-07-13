/**
 * waypoint-runtime.ts — the REAL producer backing for the run-pipeline driver.
 *
 * Builds the WaypointDeps that the dispatch `run-pipeline` case uses in
 * production: completionFn / agentFn are bounded pi sub-sessions (a toolless
 * one for proposal/script/scene_plan/edit; one with {web_search, fetch_content}
 * for research). validateFn delegates to dispatch("validate-artifact").
 *
 * The session spawn + NDJSON capture here is environment-coupled (like the
 * existing MLX smoke tests) and is validated end-to-end in Phase 6, not by a
 * unit test — the dispatch case's WIRING is unit-tested via injected waypointDeps.
 *
 * Path resolution is inlined (not imported from commands.ts) to avoid a
 * dispatch → waypoint-runtime → commands → dispatch import cycle.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { WaypointDeps } from "./waypoints.ts";

/** Resolve the pi CLI entry (PI_BIN env → the in-repo pi-agent CLI). */
function resolvePiBin(): string {
	const envBin = process.env.PI_BIN;
	if (envBin && existsSync(envBin)) return envBin;
	const repoRoot = join(import.meta.dir, "..", "..", "..");
	const inRepo = join(repoRoot, "bun-apps", "pi-agent", "src", "cli.ts");
	if (existsSync(inRepo)) return inRepo;
	throw new Error(
		`run-pipeline: could not resolve the pi binary for a waypoint session.\n` +
			`  Looked for: PI_BIN env (${envBin ?? "unset"}) and ${inRepo}.\n` +
			`  Set PI_BIN to your pi CLI entry, or run from within the repo.`,
	);
}

/** Resolve the web-access extension path (for the research agent's web_search tool). */
function resolveWebAccessExt(): string {
	const repoRoot = join(import.meta.dir, "..", "..", "..");
	return join(repoRoot, "bun-apps", "pi-agent-ext-web-access", "index.ts");
}

interface BoundedSession {
	system: string;
	user: string;
	model?: string;
	toolset: string[];
}

/**
 * Spawn a bounded, non-interactive pi sub-session and return its final assistant
 * text (the artifact JSON the waypoint then parses + validates). NDJSON event
 * stream via --mode json; the last assistant message text is the result.
 */
export function runBoundedSession(sess: BoundedSession, opts: { spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
	const piBin = resolvePiBin();
	const doSpawn = opts.spawnImpl ?? spawn;
	const argv = ["bun", piBin, "--mode", "json", "--no-extensions"];
	if (sess.model) argv.push("--model", sess.model);
	if (sess.toolset.includes("web_search")) {
		// Load web-access so web_search/fetch_content are available to the agent.
		argv.push("-e", resolveWebAccessExt());
	}
	// Embed the system prompt as a preamble (robust regardless of CLI flags);
	// the user instruction follows a separator.
	argv.push("-p", `${sess.system}\n\n---\n\n${sess.user}`);

	return new Promise((resolve, reject) => {
		const child = doSpawn(argv[0]!, argv.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
			env: opts.env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d.toString()));
		child.stderr?.on("data", (d) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0 && !stdout.trim()) {
				return reject(new Error(`bounded pi session exited ${code}: ${stderr.slice(0, 500)}`));
			}
			resolve(extractFinalAssistantText(stdout));
		});
	});
}

/** Pull the final assistant message text out of a pi --mode json NDJSON stream. */
function extractFinalAssistantText(ndjson: string): string {
	let lastAssistant = "";
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const evt = JSON.parse(trimmed) as { type?: string; role?: string; content?: unknown; text?: string };
			const isAssistant =
				evt.role === "assistant" ||
				evt.type === "assistant" ||
				evt.type === "message" ||
				evt.type === "result";
			if (!isAssistant) continue;
			const text = typeof evt.content === "string" ? evt.content : evt.text;
			if (typeof text === "string" && text.trim()) lastAssistant = text;
		} catch {
			/* not a JSON event line — skip */
		}
	}
	// Fallback: if no structured assistant message parsed, return the tail of the
	// stream (better than empty — the caller validates + retries on parse failure).
	return lastAssistant || ndjson.trim().slice(-2000);
}

export interface RealWaypointOptions {
	model?: string;
	validateFn?: WaypointDeps["validateFn"];
	/** Inject the session runner in tests (otherwise the real spawn). */
	runSession?: (sess: BoundedSession) => Promise<string>;
}

/** Build the production WaypointDeps: bounded pi sessions + dispatch validation. */
export function makeRealWaypointDeps(opts: RealWaypointOptions = {}): WaypointDeps {
	const runSession = opts.runSession ?? ((sess: BoundedSession) => runBoundedSession(sess));
	return {
		completionFn: (system, user, model) => runSession({ system, user, model: model ?? opts.model, toolset: [] }),
		agentFn: (system, user, aOpts) => runSession({ system, user, model: aOpts.model ?? opts.model, toolset: aOpts.toolset }),
		validateFn: opts.validateFn,
	};
}
