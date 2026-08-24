/**
 * The single-registry guard (post-retirement form): the retired registry YAML
 * filename must NEVER reappear in bun-apps/ or scripts/.
 *
 * Phase 2a collapsed three registration files into one registry; ticket 04
 * retired the YAML itself (the typed src/registry-config.ts is the only
 * registry). What this test blocks is a resurrection: a doc string or a
 * comment telling a future maintainer to edit that YAML file is how a
 * parallel registry re-appears, silently diverging from the TS authority.
 * The name is assembled from parts so this file does not match its own scan.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SCAN_ROOTS = ["bun-apps", "scripts"];

// Assembled, not literal, so the scan below does not hit this file itself.
const RETIRED_NAME = "s2-agent.registry." + "yaml";

function collectTextFiles(dir: string, acc: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) collectTextFiles(p, acc);
		else if (name.endsWith(".ts") || name.endsWith(".md") || name.endsWith(".json")) acc.push(p);
	}
	return acc;
}

describe("single registry guard", () => {
	test("the retired registry YAML filename never reappears in code or docs", () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of collectTextFiles(join(REPO_ROOT, root))) {
				if (readFileSync(file, "utf8").includes(RETIRED_NAME)) {
					offenders.push(relative(REPO_ROOT, file));
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
