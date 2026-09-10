/**
 * golden.test.ts — fixtures gate: every authored golden validates against
 * the schema (≥8 answerable + ≥2 unanswerable, anchors in range, numeric
 * quotes carry digits + anchors).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadGolden } from "../src/golden-schema.ts";

const GOLDEN_DIR = join(import.meta.dir, "..", "fixtures", "golden");

describe("golden fixtures", () => {
	test("all 13 papers have a golden file", () => {
		expect(readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json"))).toHaveLength(13);
	});

	test("every golden validates against the schema", () => {
		const failures: string[] = [];
		for (const f of readdirSync(GOLDEN_DIR).sort()) {
			if (!f.endsWith(".json")) continue;
			try {
				loadGolden(JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf8")), f);
			} catch (e) {
				failures.push(`${f}: ${(e as Error).message}`);
			}
		}
		expect(failures).toEqual([]);
	});
});

import { readFileSync } from "node:fs";
