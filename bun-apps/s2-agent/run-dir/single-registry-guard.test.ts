/**
 * The single-registry guard: s2-agent.registry.yaml has ONE parser.
 *
 * Phase 2a collapsed three registration files into one registry whose schema
 * authority is run-dir/registry.ts. The drift this test blocks is a THIRD
 * registry reappearing: some future file reading the registry path with its
 * own YAML.parse + its own schema (the way deploy-config.yaml and
 * manifest.json used to coexist), quietly diverging from parseRegistry's
 * validation. Mentions alone are fine — docs, comments, and writers that
 * never parse (ext-new.ts, config.ts's projection) reference the path by
 * name. What is forbidden is MENTION + OWN PARSE outside the authority.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SCAN_ROOTS = ["bun-apps", "scripts"];

/** The one file allowed to both reference and parse the registry. */
const AUTHORITY = "bun-apps/s2-agent/run-dir/registry.ts";

function collectTs(dir: string, acc: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) collectTs(p, acc);
		else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) acc.push(p);
	}
	return acc;
}

describe("single registry guard", () => {
	test("only run-dir/registry.ts both mentions and parses s2-agent.registry.yaml", () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of collectTs(join(REPO_ROOT, root))) {
				const text = readFileSync(file, "utf8");
				if (!text.includes("s2-agent.registry.yaml")) continue;
				if (!/YAML\.parse/.test(text)) continue; // mention without parse is fine
				const rel = relative(REPO_ROOT, file);
				if (rel !== AUTHORITY) offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
