// pipeline-gate.test.ts
import { describe, expect, test } from "bun:test";
import {
	parseTierFromMap,
	countOpenQuestions,
	countOpenDecisions,
	ticketRunExpected,
	classifySize,
	runGate,
} from "./pipeline-gate.ts";

const MAP_T2 = `---
effort: x
tier: T2
---
# Wayfinder map
## Not yet specified
<!-- none -->
`;
const MAP_OPEN = `---
tier: T3
---
## Not yet specified
- how do we X?
- who owns Y?
`;

// Mock repo root for classifySize tests
const REPO_ROOT = "/Users/huangziyu/proj/video_generation__memory";

describe("parseTierFromMap", () => {
	test("reads tier from frontmatter", () => {
		expect(parseTierFromMap(MAP_T2)).toBe("T2");
	});
	test("null when absent", () => {
		expect(parseTierFromMap("no frontmatter")).toBe(null);
	});
	test("tier in body text is ignored (frontmatter-only)", () => {
		const bodyTier = `---
title: Test
---
Some text
tier: T3
More text`;
		expect(parseTierFromMap(bodyTier)).toBe(null);
	});
});

describe("countOpenQuestions", () => {
	test("comment-only block is zero", () => {
		expect(countOpenQuestions(MAP_T2)).toBe(0);
	});
	test("counts non-comment lines under Not yet specified", () => {
		expect(countOpenQuestions(MAP_OPEN)).toBe(2);
	});
	test("missing section is zero", () => {
		expect(countOpenQuestions("# just a title")).toBe(0);
	});
});

describe("countOpenDecisions", () => {
	test("unchecked boxes count", () => {
		expect(countOpenDecisions("- [ ] pick A or B\n- [x] done one")).toBe(1);
	});
	test("Not yet specified section counts too", () => {
		expect(countOpenDecisions("## Not yet specified\n- open Q here")).toBe(1);
	});
});

describe("ticketRunExpected", () => {
	test("counts Run:/Expected: pairs", () => {
		const t = ticketRunExpected("### Task 1\n**Run:** bun test x\n**Expected:** PASS\n### Task 2\nno markers");
		expect(t).toEqual({ tasks: 2, missing: 1 });
	});
	test("clamps missing at zero when markers appear before first task", () => {
		const t = ticketRunExpected("**Run:** preamble\n**Expected:** PASS\n### Task 1");
		expect(t).toEqual({ tasks: 1, missing: 0 });
	});
});

describe("classifySize", () => {
	test("3 files one package = T1", () => {
		expect(classifySize(["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent/src/b.ts", "bun-apps/pi-agent/src/c.ts"], REPO_ROOT)).toBe("T1");
	});
	test("5 files one package = T2", () => {
		expect(classifySize(Array.from({ length: 5 }, (_, i) => `bun-apps/pi-agent/src/f${i}.ts`), REPO_ROOT)).toBe("T2");
	});
	test("two packages = T2", () => {
		expect(classifySize(["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent-ext-workflow/src/b.ts"], REPO_ROOT)).toBe("T2");
	});
	test("three packages = T3", () => {
		expect(classifySize(["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent-ext-workflow/src/b.ts", "bun-apps/pi-agent-ext-subagent/src/c.ts"], REPO_ROOT)).toBe("T3");
	});
	test("non-bun-apps paths don't inflate package count", () => {
		expect(classifySize(["bun-apps/pi-agent/src/a.ts", "python/some/file.py", "scripts/deploy.sh"], REPO_ROOT)).toBe("T1");
	});
	test("package dir not on disk = T3", () => {
		expect(classifySize(["bun-apps/pi-agent-ext-newthing/src/index.ts"], REPO_ROOT)).toBe("T3");
	});
});

describe("runGate", () => {
	test("green T2 effort exits 0", () => {
		const r = runGate({
			declaredTier: "T2",
			mapText: MAP_T2,
			specText: "# spec\nall decided",
			ticketTexts: ["### Task 1\n**Run:** x\n**Expected:** y"],
			ledgerText: "| ticket | outcome | sha |\n|---|---|---|\n| 01 | green | abc1234 |",
			changedFiles: ["bun-apps/pi-agent/src/a.ts", "bun-apps/pi-agent/src/b.ts"],
			repoRoot: REPO_ROOT,
		});
		expect(r.exitCode).toBe(0);
		expect(r.checks.every((c) => c.pass)).toBe(true);
	});
	test("open Q in map fails with remedy naming wayfind", () => {
		const r = runGate({
			declaredTier: "T3",
			mapText: MAP_OPEN,
			specText: "# spec",
			ticketTexts: [],
			ledgerText: "",
			changedFiles: ["bun-apps/a/src/x.ts", "bun-apps/b/src/x.ts", "bun-apps/c/src/x.ts"],
			repoRoot: REPO_ROOT,
		});
		expect(r.exitCode).toBe(1);
		const openQ = r.checks.find((c) => c.name === "map-frozen")!;
		expect(openQ.pass).toBe(false);
		expect(openQ.remedy).toContain("wayfind");
	});
	test("tier under-declaration fails", () => {
		const r = runGate({
			declaredTier: "T1",
			mapText: "",
			specText: "",
			ticketTexts: [],
			ledgerText: "",
			changedFiles: ["bun-apps/a/src/x.ts", "bun-apps/b/src/x.ts", "bun-apps/c/src/x.ts"],
			repoRoot: REPO_ROOT,
		});
		expect(r.checks.find((c) => c.name === "tier-match")!.pass).toBe(false);
	});
});
