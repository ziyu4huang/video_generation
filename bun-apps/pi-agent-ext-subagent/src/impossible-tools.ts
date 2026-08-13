/**
 * #03 impossible-tool preflight — pure helper.
 *
 * Motivation (run mslovsnn, 927k tok): a dispatched subagent lacked the `memory`
 * tool, so instead of failing fast it reverse-engineered the hermes store
 * bootstrap and wrote+ran a temp script. A declaration-based preflight (the
 * dispatcher lists the tools the task needs) catches this BEFORE spawn: if a
 * required tool is absent from the child's allowlist — or present but denied by
 * `excludeTools` — the dispatch aborts with a clear error instead of burning a
 * runaway loop.
 *
 * Pure + dependency-free so it is unit-testable in isolation and reusable from
 * BOTH the singular (`subagent`) and plural (`subagents`) dispatch surfaces.
 */

/**
 * Return the subset of `required` tools the child CANNOT use, or `undefined`
 * when the requirement is satisfiable (or there is no requirement to check).
 *
 * A required tool is MISSING when it is NOT in `resolved` (the child's concrete
 * allowlist) OR it IS in `resolved` but denied by `exclude` (post-exclusion it
 * is unavailable). When `resolved` is `undefined` the child inherits a default
 * set we cannot enumerate, so a miss cannot be confirmed → return `undefined`
 * (never false-abort on an unverifiable requirement). Returns `undefined` (not
 * `[]`) on success so callers can branch with a plain truthiness check.
 */
export function missingRequiredTools(
  required: string[] | undefined,
  resolved: string[] | undefined,
  exclude: string[] | undefined,
): string[] | undefined {
  if (!required || required.length === 0) return undefined;
  if (!resolved) return undefined;
  const denied = exclude ? new Set(exclude) : null;
  const missing = required.filter((name) => !resolved.includes(name) || (denied?.has(name) ?? false));
  return missing.length > 0 ? missing : undefined;
}
