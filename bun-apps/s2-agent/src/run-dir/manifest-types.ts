/**
 * manifest-types.ts — Extension manifest entry parser.
 *
 * The manifest's `extensions` array supports TWO entry formats:
 *   1. Bare string (backward compat): "pi-file2md/extensions/file2md.ts"
 *   2. Declared object: { name, entry, version }
 *
 * The declared format carries per-extension name + version. The thin/full
 * `bundleMode`/`fullReason`/`testGate` fields it once declared died with the
 * FULL bundle mode (deploy-architecture consolidation Phase 1b) — the builder
 * is thin-only and never read them, and the generated manifest (Phase 2a)
 * stopped emitting them; Phase 2b removed them from the type so a manifest
 * cannot declare fields nothing honours.
 */

export interface ExtensionManifestEntry {
	/** Display name (defaults to the last path segment of `entry`). */
	name: string;
	/** Relative path to the entry file (from the bun-apps/ root). */
	entry: string;
	/** Semantic version for changelog/compat tracking. */
	version?: string;
}

/**
 * Parse a manifest entry (bare string or declared object) into a normalized
 * ExtensionManifestEntry. Bare strings are parsed as { entry: <string> }.
 */
export function parseManifestEntry(raw: string | object): ExtensionManifestEntry {
	if (typeof raw === "string") {
		const seg = raw.split("/").pop() ?? raw;
		const name = seg.replace(/\.(ts|js)$/, "").replace(/^index$/, (m) => {
			// "index.ts" → use the parent dir name
			const parts = raw.split("/");
			return parts.length > 1 ? parts[parts.length - 2]! : m;
		});
		return { name, entry: raw };
	}
	if (raw && typeof raw === "object") {
		const obj = raw as Partial<ExtensionManifestEntry>;
		const entry = obj.entry ?? "";
		const seg = entry.split("/").pop() ?? entry;
		const name = obj.name ?? seg.replace(/\.(ts|js)$/, "") ?? entry;
		return {
			name,
			entry,
			version: obj.version,
		};
	}
	throw new Error(`invalid manifest entry: ${JSON.stringify(raw)}`);
}

/**
 * Parse an array of manifest entries (mixed bare strings + declared objects).
 */
export function parseManifestEntries(raw: (string | object)[]): ExtensionManifestEntry[] {
	return raw.map(parseManifestEntry);
}
