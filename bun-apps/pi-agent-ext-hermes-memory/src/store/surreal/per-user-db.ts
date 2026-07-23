import { userInfo } from "node:os";

/**
 * Per-user SurrealDB database name derivation.
 *
 * SurrealDB rejects hyphens in unescaped identifiers
 * (surrealdb/surrealdb#4841), so the default db name uses underscores:
 * `hermes_memory_<sanitized-user>`. This lets one shared local SurrealDB
 * server (127.0.0.1:8000, shared namespace `hermes`) isolate each OS-user's
 * memory/search data in its own database — the per-user discriminator is the
 * OS username, unique on a single machine.
 *
 * The username is sanitized to a valid SurrealDB identifier suffix
 * (`[a-z0-9_]`, lowercased; runs of invalid chars collapse to a single `_`;
 * an empty/odd result falls back to `default`). This keeps the
 * `DEFINE DATABASE` statement (which interpolates the name raw) parse-safe —
 * no backtick-escaping needed anywhere.
 */

const FALLBACK_USER = "default";

/**
 * Lowercase + collapse invalid-char runs to `_`, trimmed. Never empty —
 * yields `default` for an all-invalid/empty input so the db name is always a
 * legal SurrealDB identifier.
 */
export function sanitizeUsername(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned.length > 0 ? cleaned : FALLBACK_USER;
}

/**
 * Current OS username (`os.userInfo().username` — cross-platform, reliable),
 * never empty (falls back to `default` if missing/unreadable).
 */
export function currentUsername(): string {
	try {
		const u = userInfo().username;
		if (typeof u === "string" && u.trim().length > 0) return u.trim();
	} catch {
		// fall through to fallback
	}
	return FALLBACK_USER;
}

/**
 * Default per-user SurrealDB database name: `hermes_memory_<sanitized-user>`.
 */
export function derivePerUserDatabase(): string {
	return `hermes_memory_${sanitizeUsername(currentUsername())}`;
}
