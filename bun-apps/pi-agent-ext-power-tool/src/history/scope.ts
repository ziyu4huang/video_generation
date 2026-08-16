/**
 * Scope resolution — does a session belong to this repo family? PURE.
 *
 * Matching uses the transcript's `cwd` field, NEVER the session directory name:
 * two incompatible cwd encodings coexist on disk
 * (`--Users-…-video_generation__memory--` keeps underscores,
 * `-Users-…-video-generation--embed` converts them to dashes), so decoding
 * directory names would silently drop data at the encoder-version boundary.
 *
 * Scope is the UNION of two rules, because neither alone is sufficient:
 *  - the family prefix keeps DELETED worktrees, which own the history of finished
 *    efforts (`git worktree list` has already forgotten them);
 *  - the live worktree roots keep worktrees living outside the family prefix.
 */

export interface ScopeSpec {
  /** Literal string prefix, e.g. "/Users/me/proj/video_generation". */
  familyPrefix: string;
  /** Absolute worktree roots; a cwd matches a root or any path under it. */
  roots: string[];
}

/**
 * Build a scope from the main worktree path and the live worktree roots.
 *
 * The family prefix is the main worktree path used as a LITERAL string prefix, so
 * `<path>__embed` matches. The tradeoff is deliberate: an unrelated sibling named
 * `<path>_unrelated` would also match. Requiring a `/` boundary instead would drop
 * every `__suffix` worktree, which is the whole population we care about.
 */
export function buildScope(mainWorktree: string, roots: string[]): ScopeSpec {
  return {
    familyPrefix: mainWorktree.replace(/\/+$/, ""),
    roots: roots.map((r) => r.replace(/\/+$/, "")),
  };
}

/** Is this session's cwd inside the scope? */
export function inScope(cwd: string | undefined, scope: ScopeSpec): boolean {
  if (!cwd) return false;
  const p = cwd.replace(/\/+$/, "");
  if (p.startsWith(scope.familyPrefix)) return true;
  return scope.roots.some((r) => p === r || p.startsWith(`${r}/`));
}
