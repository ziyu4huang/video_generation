import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { broadDeathPct, parseCoverageFloor, parseRunsStats, scanSkills } from "./loop.ts";

describe("parseRunsStats", () => {
	test("spec-format summary rows", () => {
		const stats = parseRunsStats("total 200\ndone 126\nturns 63\nbudget 11");
		assert.deepEqual(stats, { total: 200, done: 126, turns: 63, budget: 11 });
	});
	test("live runs-stats format — summary rows, cohort rows ignored", () => {
		const stats = parseRunsStats(
			[
				"runs-dir: /Users/x/.pi/subagents/runs",
				"total: 200",
				"done: n=149 tokenMedian=14129 turnsMedian=-",
				"turns: n=40 tokenMedian=39670 turnsMedian=5",
				"budget: n=11 tokenMedian=157776 turnsMedian=-",
				"cohort unknown: n=154 done=119 turns=25 budget=10 tokenMedian=14992",
			].join("\n"),
		);
		assert.deepEqual(stats, { total: 200, done: 149, turns: 40, budget: 11 });
	});
	test("no match -> zeros", () => {
		assert.deepEqual(parseRunsStats("runs-dir: /tmp\nnothing matches"), {
			total: 0,
			done: 0,
			turns: 0,
			budget: 0,
		});
	});
});

describe("broadDeathPct", () => {
	test("(turns+budget)/total rounded to 0.1", () => {
		assert.equal(broadDeathPct({ total: 200, done: 126, turns: 63, budget: 11 }), 37);
	});
	test("zeros -> 0", () => {
		assert.equal(broadDeathPct({ total: 0, done: 0, turns: 0, budget: 0 }), 0);
	});
});

describe("parseCoverageFloor", () => {
	test("two src/ rows -> min % Lines", () => {
		const text =
			" src/effort-tool.ts | 90.4 | 100 | 85.1 | 60.0 | 3 |\n src/route-tool.ts | 60.0 | 88.9 | 55.5 | 40 | 9 |";
		assert.equal(parseCoverageFloor(text), 60);
	});
	test("no src/ rows -> null", () => {
		assert.equal(parseCoverageFloor("All files | 71.2 | 90 | 66.6 | 50 | 112 |"), null);
	});
});

describe("scanSkills", () => {
	test("repo skills present, every path ends with SKILL.md", () => {
		// Same repoRoot derivation as loop.ts run(); process.cwd() is not the repo
		// root when bun test runs from bun-apps/s2-agent.
		const repoRoot = join(import.meta.dir, "../../../../..");
		const skills = scanSkills(repoRoot);
		assert.ok(skills.length > 0, `expected >0 skills, got ${skills.length}`);
		assert.ok(skills.every((s) => s.path.endsWith("SKILL.md")));
	});
});
