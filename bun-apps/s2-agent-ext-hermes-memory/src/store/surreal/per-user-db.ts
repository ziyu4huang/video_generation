/**
 * Per-user SurrealDB namespace + database naming.
 *
 * The naming helpers MOVED to @repo/s2-agent-core-interface (kcard-parity D4,
 * ticket 07 build — knowledge-card needs the same namespace derivation and the
 * dep-guard tier rule forbids a kcard→hermes edge). This module re-exports the
 * canonical implementations so hermes's public surface is unchanged.
 */
export {
	sanitizeUsername,
	currentUsername,
	derivePerUserNamespace,
} from "@repo/s2-agent-core-interface";

/**
 * Clean, semantic database name used inside every per-user namespace. Kept
 * constant (not user-encoded) so the database name means "memory store",
 * while the namespace carries the user identity.
 */
export const DEFAULT_SURREAL_DATABASE = "memory";
