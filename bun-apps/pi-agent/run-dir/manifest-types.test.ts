/**
 * Unit tests for the manifest schema v2 parser.
 *
 * The parser normalizes both bare strings (backward compat) and declared
 * objects into ExtensionManifestEntry. This is the foundation of the extension
 * protocol v2 — bundleMode/fullReason/testGate are declared, not hardcoded.
 */
import { describe, expect, test } from "bun:test";
import { parseManifestEntry, parseManifestEntries } from "./manifest-types.ts";

describe("parseManifestEntry", () => {
	test("bare string → { entry, bundleMode: thin }", () => {
		const e = parseManifestEntry("pi-file2md/extensions/pi-file2md.ts");
		expect(e.entry).toBe("pi-file2md/extensions/pi-file2md.ts");
		expect(e.name).toBe("pi-file2md");
		expect(e.bundleMode).toBe("thin");
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
			bundleMode: "full",
			fullReason: "native addon + deep imports",
			testGate: "cd bun-apps/pi-hermes-memory && bun test",
			version: "0.80.3",
		});
		expect(e.name).toBe("pi-hermes-memory");
		expect(e.entry).toBe("pi-hermes-memory/src/index.ts");
		expect(e.bundleMode).toBe("full");
		expect(e.fullReason).toBe("native addon + deep imports");
		expect(e.testGate).toContain("bun test");
		expect(e.version).toBe("0.80.3");
	});

	test("declared object defaults bundleMode to thin", () => {
		const e = parseManifestEntry({ entry: "some/path.ts" });
		expect(e.bundleMode).toBe("thin");
	});

	test("declared object infers name from entry when missing", () => {
		const e = parseManifestEntry({ entry: "pi-flux2/extensions/pi-flux2.ts" });
		expect(e.name).toBe("pi-flux2");
	});
});

describe("parseManifestEntries", () => {
	test("mixed bare strings + declared objects", () => {
		const entries = parseManifestEntries([
			"pi-file2md/extensions/pi-file2md.ts",
			{ name: "pi-hermes-memory", entry: "pi-hermes-memory/src/index.ts", bundleMode: "full" },
			"@repo/pi-agent-ext-obsidian/extensions/obsidian.ts",
		]);
		expect(entries).toHaveLength(3);
		expect(entries[0]!.bundleMode).toBe("thin");
		expect(entries[1]!.bundleMode).toBe("full");
		expect(entries[1]!.name).toBe("pi-hermes-memory");
		expect(entries[2]!.name).toBe("obsidian");
	});

	test("empty array", () => {
		expect(parseManifestEntries([])).toEqual([]);
	});
});
