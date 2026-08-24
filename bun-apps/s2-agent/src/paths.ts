/**
 * paths.ts — the shared path-resolution leaf (effort 2026-08-24-s2-agent-simplify
 * ticket 02).
 *
 * ONE definition each of the three tiny resolvers that were copy-pasted across
 * patches, cli commands, and session helpers before this file existed:
 *
 *   - `resolveAgentDir` — the pi agent state dir ($PI_CODING_AGENT_DIR →
 *     ~/.pi/agent). Semantically equal to pi's own `getAgentDir()` (verified
 *     against pi-coding-agent 0.84.2 dist/config.js: env ?? homedir join, no
 *     mkdir side effect) minus its `~`-prefix expansion — env values are
 *     absolute paths in every real caller.
 *   - `readAgentSettings` — the best-effort `settings.json` read (undefined on
 *     any error) every settings consumer used to carry as a private copy.
 *   - `findRepoRoot` — ascend to the dir containing `bun-apps/` (the marker the
 *     repo-root walk has ALWAYS keyed on — see cli/commands/doctor.ts and
 *     schema-cost.ts; doctor.test pins it). Returns undefined when no ancestor
 *     matches; callers that need a string apply their own fallback
 *     (schema-cost falls back to the input dir).
 *
 * LEAF CONSTRAINTS: node builtins only (node:fs / node:path / node:os) — no
 * @earendil-works, no workspace imports, no import-time side effects. This is
 * what makes it safe to import from patches that run BEFORE
 * ensure-extension-deps materializes the repo-root symlinks (the exact
 * ordering trap default-model-env's header documents), and why it must never
 * grow an SDK dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The env slice `resolveAgentDir` reads. Accepts `process.env` verbatim or any
 * partial env record (tests pass `{ PI_CODING_AGENT_DIR: <tmpdir> }`).
 */
export type AgentDirEnv = Record<string, string | undefined> & { PI_CODING_AGENT_DIR?: string };

/** Resolve the pi agent state dir: $PI_CODING_AGENT_DIR → ~/.pi/agent. */
export function resolveAgentDir(env: AgentDirEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Best-effort read of the user settings file (<agentDir>/settings.json).
 * Non-fatal: returns undefined on any read/parse error or missing file.
 */
export function readAgentSettings(
	env: AgentDirEnv = process.env,
): Record<string, unknown> | undefined {
	try {
		const settingsPath = join(resolveAgentDir(env), "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Walk up from `start` to the nearest dir containing a `bun-apps/` subdir (the
 * repo root). `exists` is injectable so doctor's pure-check tests can pass a
 * fake fs. Returns undefined at the fs root when no ancestor matches — callers
 * that cannot tolerate undefined apply their own fallback.
 */
export function findRepoRoot(
	start: string,
	exists: (p: string) => boolean = existsSync,
): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (exists(join(dir, "bun-apps"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
