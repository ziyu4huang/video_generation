/**
 * manifest-types.ts — Extension manifest schema v2.
 *
 * The manifest's `extensions` array supports TWO entry formats:
 *   1. Bare string (backward compat): "pi-vlm/extensions/pi-vlm.ts"
 *   2. Declared object (v2): { name, entry, bundleMode, fullReason, testGate, version }
 *
 * The declared format lets each extension specify HOW it should be bundled
 * (thin/full), its test gate command, and its version — replacing the hardcoded
 * DEFAULT_FULL set in build-extensions.ts with a declared protocol.
 */

export interface ExtensionManifestEntry {
	/** Display name (defaults to the last path segment of `entry`). */
	name: string;
	/** Relative path to the entry file (from the bun-apps/ root). */
	entry: string;
	/**
	 * Bundle mode: "thin" (default, shared deps external) | "full" (inline all
	 * deps) | "auto" (try thin, fall back to full on verify failure).
	 * Defaults to "thin".
	 */
	bundleMode?: "thin" | "full" | "auto";
	/** Documented reason for requiring FULL mode (when bundleMode is "full"). */
	fullReason?: string;
	/** The shell command that gates this extension's tests. */
	testGate?: string;
	/** Semantic version for changelog/compat tracking. */
	version?: string;
	/** Original raw entry (for lazyExtensions backward compat). */
	raw?: string | object;
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
		return { name, entry: raw, bundleMode: "thin", raw };
	}
	if (raw && typeof raw === "object") {
		const obj = raw as Partial<ExtensionManifestEntry>;
		const entry = obj.entry ?? "";
		const seg = entry.split("/").pop() ?? entry;
		const name = obj.name ?? seg.replace(/\.(ts|js)$/, "") ?? entry;
		return {
			name,
			entry,
			bundleMode: obj.bundleMode ?? "thin",
			fullReason: obj.fullReason,
			testGate: obj.testGate,
			version: obj.version,
			raw,
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
