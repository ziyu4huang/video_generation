/**
 * Scope-entry matching for verify_merge_landed's expectedScope.
 *
 * Semantics (explicit, replaces the old literal `startsWith`):
 *   `x/**` → directory prefix `x/`, any depth below it
 *   `x/*`  → exactly one path segment below `x/`
 *   `x/`   → directory prefix (same as `x/**`)
 *   `x`    → the exact file `x`, OR any path under `x/` — but NOT a
 *            pseudo-prefix sibling (`bun-apps/foo` must not match
 *            `bun-apps/foo-bar/…`; the old startsWith did — false-CLEAN risk).
 *
 * No glob library: these four forms cover every real call-site usage.
 */
export function matchesScope(path: string, entry: string): boolean {
	if (entry.endsWith("/**")) {
		return path.startsWith(entry.slice(0, -2));
	}
	if (entry.endsWith("/*")) {
		const dir = entry.slice(0, -1); // "x/*" → "x/"
		if (!path.startsWith(dir)) return false;
		return !path.slice(dir.length).includes("/");
	}
	if (entry.endsWith("/")) {
		return path.startsWith(entry);
	}
	return path === entry || path.startsWith(`${entry}/`);
}
