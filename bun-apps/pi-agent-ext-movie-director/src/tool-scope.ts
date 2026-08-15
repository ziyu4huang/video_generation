/**
 * tool-scope.ts — the movie-director agent's write-surface guard.
 *
 * The agent-first thesis puts an unsupervised LLM (gemma-4-12b) in the driver's
 * seat of the `movie` tool. That agent also retains pi-agent's built-in `edit`
 * and `write` tools. During a `movie` run the agent has NO business editing the
 * repo's infra roots — only producing media + checkpoints inside the project
 * workspace. The H-real agent-driven run (#291) bore this out: the agent made
 * one ungrounded edit to `python/mlx-movie-director/app/config.py` on a wrong
 * Python-3.9 diagnosis. It was reverted, but the class recur is what this guard
 * prevents: a denylist enforced at the extension layer via the pi-agent
 * `tool_call` PreToolUse hook (the hook can `block` a call before it executes).
 *
 * This module is pure (no pi-SDK dependency) so it is unit-testable. The
 * extension layer wires `scopeViolationForToolCall` into `pi.on("tool_call", …)`.
 *
 * The denylist is deliberately a list of repo-relative directory prefixes
 * (python/, swift/, mlx-models/, …). Paths are normalized to absolute and
 * matched against `<repoRoot>/<prefix>` so it is immune to `..`, symlinks-ish
 * traversal, and absolute-path end runs. Override the list via the
 * `MD_TOOL_SCOPE_DENY` env var (colon-separated) for one-off runs; set
 * `MD_TOOL_SCOPE_DISABLE=1` to bypass entirely (e.g. the agent-driven receipt
 * harness that PROVES the guard fires).
 */
import { resolve, sep } from "node:path";
import { EXT_ROOT } from "./paths.ts";
import { isMovieActive } from "./session-state.ts";

/** Repo root = the extension's grandparent (this pkg is bun-apps/pi-agent-ext-movie-director). */
export const REPO_ROOT = resolve(EXT_ROOT, "..", "..");

/**
 * Repo-relative directory prefixes the movie-director agent must not edit/write.
 * Every entry is a top-level infra root; the agent's only legitimate writes land
 * in the project workspace under MLX_OUTPUT_DIR (outside this tree) or /tmp.
 */
export const DEFAULT_DENIED_PREFIXES: readonly string[] = [
  "python/", // mlx-movie-director runtime + venvs (the #291 ungrounded edit)
  "swift/", // native director sources
  "mlx-models/", // MLX-owned model tree
  "bun-apps/", // every pi-extension + the GUI (this package included)
  ".claude/", // hooks, workflows, memory, settings
  ".githooks/", // pre-commit guards
  "scripts/", // repo-root automation
];

/** Normalize a colon-separated override string into normalized prefix list. */
function parseOverride(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^[/\\]+/, "").replace(/\\/g, "/").replace(/\/+$/, "") + "/");
}

/** The effective denied-prefix list (override via MD_TOOL_SCOPE_DENY). */
export function deniedPrefixes(env: Record<string, string | undefined> = process.env): readonly string[] {
  return parseOverride(env.MD_TOOL_SCOPE_DENY) ?? DEFAULT_DENIED_PREFIXES;
}

/** Resolve any input path (relative | absolute | cwd-relative) to absolute. */
export function resolveTarget(rawPath: string, cwd: string = process.cwd()): string {
  return resolve(cwd, rawPath);
}

/** True iff `target` (absolute) is `root` or lives beneath it. */
function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * True iff editing/writing `rawPath` violates the movie-director tool scope.
 * Pure + deterministic — the unit-test surface. Resolves `rawPath` against
 * `cwd` (default process.cwd(), which is the repo root for a `movie` run) and
 * checks it against each denied prefix under `repoRoot`.
 */
export function isDeniedEditPath(
  rawPath: string,
  opts: { cwd?: string; repoRoot?: string; env?: Record<string, string | undefined> } = {},
): { denied: boolean; prefix?: string; resolved: string } {
  const env = opts.env ?? process.env;
  if (env.MD_TOOL_SCOPE_DISABLE === "1") return { denied: false, resolved: resolveTarget(rawPath, opts.cwd) };
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const resolved = resolveTarget(rawPath, cwd);
  for (const prefix of deniedPrefixes(env)) {
    if (isWithin(resolved, resolve(repoRoot, prefix))) {
      return { denied: true, prefix, resolved };
    }
  }
  return { denied: false, resolved };
}

/** Extract the target path from an edit or write tool input. */
export function editPathFromToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as Record<string, unknown>).path;
  // edit/write input.path is always a string; guard against malformed input.
  if (typeof path !== "string" || path.length === 0) return undefined;
  // The edit tool also accepts a list of edits; only `path` matters for scope.
  void toolName;
  return path;
}

/** The set of built-in tools whose writes the guard polices. */
export const GUARDED_TOOLS = new Set(["edit", "write"]);

/**
 * Decide whether a `tool_call` event should be blocked. Returns
 * `{ block: true, reason }` when the call targets a denied path, else
 * `undefined` (let it proceed). This is the value the extension's tool_call
 * handler returns verbatim.
 */
export function scopeViolationForToolCall(
  event: { toolName: string; input: unknown },
  opts: { cwd?: string; repoRoot?: string; env?: Record<string, string | undefined> } = {},
): { block: true; reason: string } | undefined {
  // Session gate: the guard constrains the movie-DRIVING agent. In a session
  // with no movie activity there is nothing to guard against, so this is a
  // no-op until markMovieActive() fires (first movie command/host-fn). The
  // MD_TOOL_SCOPE_DISABLE bypass still overrides even when armed. See session-state.ts.
  if (!isMovieActive()) return undefined;
  if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
  const path = editPathFromToolInput(event.toolName, event.input);
  if (path === undefined) return undefined;
  const verdict = isDeniedEditPath(path, opts);
  if (!verdict.denied) return undefined;
  return {
    block: true,
    reason:
      `movie-director tool-scope guard: editing "${verdict.resolved}" is out of scope ` +
      `(matches denied prefix "${verdict.prefix}"). The movie-director agent may only write to ` +
      `the project workspace; ${verdict.prefix} is repo infra it must not touch during a movie run. ` +
      `(Override via MD_TOOL_SCOPE_DENY; bypass via MD_TOOL_SCOPE_DISABLE=1.)`,
  };
}
