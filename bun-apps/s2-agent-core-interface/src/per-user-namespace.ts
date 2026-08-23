/**
 * Per-user SurrealDB namespace naming (moved from hermes-memory per kcard-parity
 * D4's deferred plan — "per-user naming helpers move when ticket 02's build
 * needs them"; ticket 07's build is the consumer that needed them). hermes
 * re-exports these so its public surface is unchanged; knowledge-card imports
 * them directly instead of a forbidden hermes edge.
 *
 * The per-user discriminator lives at the NAMESPACE level (SurrealDB's
 * tenancy/isolation boundary): each OS user gets their own namespace
 * `user_<sanitized-user>`; each consumer then uses its own semantic database
 * name inside it (hermes: `memory`; kcard: `context_db` per D6).
 *
 * SurrealDB rejects hyphens in unescaped identifiers
 * (surrealdb/surrealdb#4841) — the same rule applies to namespace names — so
 * the username is sanitized to a valid SurrealDB identifier suffix
 * (`[a-z0-9_]`, lowercased; runs of invalid chars collapse to a single `_`;
 * an empty/odd result falls back to `default`). This keeps the
 * `DEFINE NAMESPACE` statement (which interpolates the name raw) parse-safe —
 * no backtick-escaping needed anywhere.
 */
import { userInfo } from "node:os";

const FALLBACK_USER = "default";

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
