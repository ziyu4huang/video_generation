/**
 * The freshness gate: manifest.json is derived from pi-agent.registry.yaml.
 * RED when someone hand-edits the manifest OR edits the registry without
 * running `bun run regen:manifest`. This is the tripwire that makes the
 * generated file safe to keep.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistry } from "./registry.ts";
import { buildManifestObject, manifestText } from "./registry-to-manifest.ts";

const PKG_DIR = join(import.meta.dir, "..");

describe("manifest.json freshness", () => {
	test("is byte-identical to what the registry generates", () => {
		const registry = parseRegistry(readFileSync(join(PKG_DIR, "pi-agent.registry.yaml"), "utf8"), {
			bunAppsDir: join(PKG_DIR, ".."),
		});
		const committed = readFileSync(join(PKG_DIR, "run-dir", "manifest.json"), "utf8");
		expect(manifestText(buildManifestObject(registry))).toBe(committed);
	});
});
