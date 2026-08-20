/**
 * Unit tests for the manifest entry parser.
 *
 * The parser normalizes both bare strings (backward compat) and declared
 * objects into ExtensionManifestEntry. The declared protocol is name/entry/
 * version ONLY — the thin/full bundleMode family died with FULL mode
 * (deploy-architecture consolidation Phase 1b) and was removed from the type
 * in Phase 2b, so a manifest can no longer declare fields nothing honours.
 */
import { describe, expect, test } from "bun:test";
import { parseManifestEntry, parseManifestEntries } from "./manifest-types.ts";

describe("parseManifestEntry", () => {
	test("bare string → { entry } with inferred name", () => {
		const e = parseManifestEntry("pi-file2md/extensions/file2md.ts");
		expect(e.entry).toBe("pi-file2md/extensions/file2md.ts");
		expect(e.name).toBe("file2md");
	});

	test("bare string with index.ts → uses parent dir name", () => {
		const e = parseManifestEntry("pi-agent-ext-web-access/index.ts");
		expect(e.name).toBe("pi-agent-ext-web-access");
		expect(e.entry).toBe("pi-agent-ext-web-access/index.ts");
	});

	test("declared object with all fields", () => {
		const e = parseManifestEntry({
			name: "pi-hermes-memory",
			entry: "pi-hermes-memory/src/index.ts",
			version: "0.80.3",
		});
		expect(e.name).toBe("pi-hermes-memory");
		expect(e.entry).toBe("pi-hermes-memory/src/index.ts");
		expect(e.version).toBe("0.80.3");
	});

	test("declared object infers name from entry when missing", () => {
		const e = parseManifestEntry({ entry: "pi-flux2/extensions/flux2.ts" });
		expect(e.name).toBe("flux2");
	});

	test("retired fields (bundleMode/fullReason/testGate) are dropped, not carried", () => {
		// A stale manifest that still declares them must not resurrect them —
		// nothing downstream honours them, so carrying them through would be a
		// silent lie about the entry's shape.
		const e = parseManifestEntry({
			name: "stale",
			entry: "stale/extensions/stale.ts",
			bundleMode: "full",
			fullReason: "obsolete",
			testGate: "bun test",
		} as object);
		expect(e).not.toHaveProperty("bundleMode");
		expect(e).not.toHaveProperty("fullReason");
		expect(e).not.toHaveProperty("testGate");
	});
});

describe("parseManifestEntries", () => {
	test("mixed bare strings + declared objects", () => {
		const entries = parseManifestEntries([
			"pi-file2md/extensions/file2md.ts",
			{ name: "pi-hermes-memory", entry: "pi-hermes-memory/src/index.ts", version: "0.80.3" },
			"@repo/pi-agent-ext-obsidian/extensions/obsidian.ts",
		]);
		expect(entries).toHaveLength(3);
		expect(entries[0]!.name).toBe("file2md");
		expect(entries[1]!.name).toBe("pi-hermes-memory");
		expect(entries[1]!.version).toBe("0.80.3");
		expect(entries[2]!.name).toBe("obsidian");
	});

	test("empty array", () => {
		expect(parseManifestEntries([])).toEqual([]);
	});
});
