import { userInfo } from "node:os";

/**
 * Per-user SurrealDB namespace + database naming.
 *
 * The per-user discriminator lives at the NAMESPACE level (SurrealDB's
 * tenancy/isolation boundary): each OS user gets their own namespace
 * `user_<sanitized-user>`, and within it uses a single clean, semantic
 * database name (`memory`). This is cleaner than encoding the user in the
 * database name and matches SurrealDB's intended namespace>database layering.
 *
 * SurrealDB rejects hyphens in unescaped identifiers
 * (surrealdb/surrealdb#4841) — the same rule applies to namespace names — so
 * the username is sanitized to a valid SurrealDB identifier suffix
 * (`[a-z0-9_]`, lowercased; runs of invalid chars collapse to a single `_`;
 * an empty/odd result falls back to `default`). This keeps the
 * `DEFINE NAMESPACE` statement (which interpolates the name raw) parse-safe —
 * no backtick-escaping needed anywhere.
 *
 * One shared local SurrealDB server (127.0.0.1:8000) isolates each OS-user's
 * memory/search data in its own namespace; the per-user discriminator is the
 * OS username, unique on a single machine.
 */

const FALLBACK_USER = "default";

/**
 * Clean, semantic database name used inside every per-user namespace. Kept
 * constant (not user-encoded) so the database name means "memory store",
 * while the namespace carries the user identity.
 */
export const DEFAULT_SURREAL_DATABASE = "memory";

/**
 * Lowercase + collapse invalid-char runs to `_`, trimmed. Never empty —
 * yields `default` for an all-invalid/empty input so the namespace name is
 * always a legal SurrealDB identifier.
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
 * Default per-user SurrealDB namespace: `user_<sanitized-user>`. The user
 * identity is carried by the namespace (the isolation boundary), not the
 * database name.
 */
export function derivePerUserNamespace(): string {
	return `user_${sanitizeUsername(currentUsername())}`;
}
