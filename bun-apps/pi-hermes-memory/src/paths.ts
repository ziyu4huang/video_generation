import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PROJECTS_MEMORY_DIR } from "./constants.js";

// AGENT_ROOT is a live-binding `let` so tests can redirect it to a tmpdir via
// __setAgentRootForTest (the proven __setVaultResolverForTest pattern). In
// production it is set once at module load and never reassigned, so behavior is
// identical to a `const` outside tests. ESM live bindings guarantee every
// importer (config.ts, memory-store.ts, index-sessions.ts, …) observes the
// test override — the whole agent-root subtree resolves to the tmpdir.
export let AGENT_ROOT = resolveAgentRoot();

// --- test seam (deterministic agent-root injection) --------------------------
// Every hermes test that touches host state must resolve it to a tmpdir, never
// the real ~/.pi/agent (which is under concurrent modification by live sessions
// + self-improve runs — a full overwrite can be silently clobbered, and a crash
// mid-test corrupts real memory). Null = restore the real resolved root.
/** @internal test-only override of the agent root (pass null to restore). */
export function __setAgentRootForTest(root: string | null): void {
	AGENT_ROOT = root ?? resolveAgentRoot();
}

export function resolveAgentRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(expandHome(configured)) : path.join(os.homedir(), ".pi", "agent");
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function normalizeConfiguredMemoryDir(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const expanded = expandHome(trimmed);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(AGENT_ROOT, expanded);
}

function isSafeRelativeDirectory(input: string): boolean {
  const segments = input.split(/[\\/]+/).filter(Boolean);
  return segments.length === 1 && segments[0] !== "." && segments[0] !== "..";
}

export function normalizeProjectsMemoryDir(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const expanded = expandHome(trimmed);
  let relative = expanded;

  if (path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded);
    const relativeToAgentRoot = path.relative(AGENT_ROOT, resolved);
    if (
      relativeToAgentRoot === ""
      || relativeToAgentRoot.startsWith("..")
      || path.isAbsolute(relativeToAgentRoot)
    ) {
      return undefined;
    }
    relative = relativeToAgentRoot;
  }

  const normalized = path.normalize(relative).replace(/^[\\/]+|[\\/]+$/g, "");
  if (!isSafeRelativeDirectory(normalized)) return undefined;
  return normalized;
}

export function resolveProjectsRoot(projectsMemoryDir = DEFAULT_PROJECTS_MEMORY_DIR): string {
  const normalized = normalizeProjectsMemoryDir(projectsMemoryDir) ?? DEFAULT_PROJECTS_MEMORY_DIR;
  return path.join(AGENT_ROOT, normalized);
}
