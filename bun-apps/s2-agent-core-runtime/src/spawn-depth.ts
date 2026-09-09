/**
 * Spawn-depth ambient scope (self-arc-19 t03 — nested-spawn depth cap).
 *
 * A spawned child receives the PARENT's spawn_subagent definition through the
 * extensionTools bridge — the same ToolDefinition closure, executed inside the
 * child's async subtree (exactly the fork-child situation, fork-transcript.ts).
 * There is no per-child options object that closure could read, so "how deep
 * am I?" travels as an ambient async scope: every dispatch wraps its spawn in
 * runWithSpawnDepth(depth+1, cap), and AsyncLocalStorage propagates the scope
 * through the awaits covering the child's whole in-process lifetime — so a
 * grandchild's spawn site reads its own depth off the store.
 *
 * Distinct from the fork guard on purpose: the fork scope (fork-transcript.ts)
 * answers "am I a fork child?" and forbids nested forks entirely; this scope
 * answers "how deep is my spawn tree?" and enforces a numeric cap. A fork
 * dispatch sets BOTH (the fork child runs at depth 1 like any child).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_MAX_SPAWN_DEPTH = 2;

interface SpawnDepthScope {
  depth: number;
  maxDepth: number;
}

const spawnDepthScope = new AsyncLocalStorage<SpawnDepthScope>();

/** The caller's spawn depth (root session = 0) and its subtree's cap. */
export function currentSpawnScope(): SpawnDepthScope {
  return spawnDepthScope.getStore() ?? { depth: 0, maxDepth: DEFAULT_MAX_SPAWN_DEPTH };
}

/** Run `fn` (a child's entire spawn) inside a depth+1 scope. `maxDepth`
 *  defaults to the inherited cap; an agentType def's `maxDepth` frontmatter
 *  overrides it for that def's subtree. */
export function runWithSpawnDepth<T>(fn: () => T, opts?: { maxDepth?: number }): T {
  const parent = currentSpawnScope();
  return spawnDepthScope.run({ depth: parent.depth + 1, maxDepth: opts?.maxDepth ?? parent.maxDepth }, fn);
}

/** True when spawning ONE level deeper would exceed the active cap. */
export function spawnDepthExceeded(): boolean {
  const { depth, maxDepth } = currentSpawnScope();
  return depth + 1 > maxDepth;
}
