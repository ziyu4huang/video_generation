/**
 * validate-next-goal — pins the STRICT handoff format the
 * self-reflect-next-goal skill prescribes (skills/self-reflect-next-goal).
 *
 * Each rule gets the canonical valid fixture and targeted mutations that must
 * fail with the right check name, plus the doctor's pointer/retention logic
 * on a temp output/ dir. The format is the contract between sessions — a
 * check that silently passes on a violation hands the NEXT session a
 * malformed or wrong goal.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { doctorNextGoal, MAX_RETENTION, validateNextGoalFile } from "../src/validate-next-goal.js";

const TMP = mkdtempSync(join(tmpdir(), "next-goal-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** The canonical VALID fixture, written under `dir`; returns its abs path. */
function validFile(dir: string, ts = "20260823-001732", supersedes = "none"): string {
	const file = join(dir, `next-goal-${ts}.md`);
	writeFile(
		file,
		[
			"---",
			`file: ${file}`,
			`created: ${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`,
			`supersedes: ${supersedes}`,
			"---",
			"# Next goal — the title",
			"",
			"## Verified this session",
			"",
			"PR #1 merged (evidence: verify_merge_landed CLEAN).",
			"",
			"## Honest gaps",
			"",
			"- TUI smoke still not run.",
			"",
			"## Immediate steps",
			"",
			"1. Read the spec.",
			"2. Branch, implement, test.",
			"",
			"## Done when",
			"",
			"- [ ] Field exists,",
			"- [ ] tests green.",
			"",
			"## Ranked next goals",
			"",
			"1. **First** — first step.",
			"2. **Second** — first step.",
			"3. **Third** — first step.",
			"",
		].join("\n"),
	);
	return file;
}

/** Write `file`'s fixture transformed by `fn(source)` (keeps the self-reference honest). */
function writeFile(file: string, source: string): void {
	writeFileSync(file, source);
}

function mutate(file: string, fn: (source: string) => string): string {
	return fn(readFileSync(file, "utf8"));
}

function failedChecks(v: ReturnType<typeof validateNextGoalFile>): string[] {
	return v.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe("validateNextGoalFile — strict format", () => {
	test("the canonical fixture passes clean", () => {
		const v = validateNextGoalFile(validFile(TMP));
		expect(v.ok).toBe(true);
		expect(v.checks.filter((c) => !c.ok)).toEqual([]);
	});

	test("filename pattern (sort key for newest-file resolution + pruning)", () => {
		const good = validFile(TMP, "20260823-010101");
		// Same content, off-pattern basename — only the filename check may fire.
		const bad = join(TMP, "next-goal-20260823_010101.md");
		writeFile(bad, mutate(good, (s) => s.replaceAll(good, bad)));
		expect(failedChecks(validateNextGoalFile(bad))).toEqual(["filename"]);
	});

	test("missing frontmatter block", () => {
		const good = validFile(TMP, "20260823-010102");
		const bad = join(TMP, "next-goal-20260823-010103.md");
		writeFile(bad, mutate(good, (s) => s.slice(s.indexOf("# Next goal")) + ""));
		const v = validateNextGoalFile(bad);
		expect(v.ok).toBe(false);
		expect(failedChecks(v)).toContain("frontmatter");
	});

	test("missing frontmatter key", () => {
		const file = validFile(TMP, "20260823-010104");
		writeFile(file, mutate(file, (s) => s.replace(/supersedes: .*\n/, "")));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["frontmatter-keys"]);
	});

	test("self-abs-path: file: must name THIS file's absolute path (the worktree self-reference)", () => {
		const file = validFile(TMP, "20260823-020202");
		writeFile(file, mutate(file, (s) => s.replaceAll(`file: ${file}`, `file: /elsewhere/${basename(file)}`)));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["self-abs-path"]);
	});

	test("created must be filename-derived (date AND time)", () => {
		const file = validFile(TMP, "20260823-030303");
		writeFile(file, mutate(file, (s) => s.replace("created: 2026-08-23 03:03:03", "created: 2026-01-01 03:03:03")));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["created-matches-filename"]);
	});

	test("created: date-only (legacy shape) is NOT enough — time is required", () => {
		const file = validFile(TMP, "20260823-030404");
		writeFile(file, mutate(file, (s) => s.replace("created: 2026-08-23 03:04:04", "created: 2026-08-23")));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["created-matches-filename"]);
	});

	test("supersedes: relative path refused; pruned abs path is a warning, not a failure", () => {
		const rel = validFile(TMP, "20260823-040404", "output/next-goal-20260823-001732.md");
		expect(failedChecks(validateNextGoalFile(rel))).toEqual(["supersedes-abs-path"]);
		const gone = validFile(TMP, "20260823-040405", "/definitely/pruned/next-goal-20260101-000000.md");
		const v = validateNextGoalFile(gone);
		expect(v.ok).toBe(true); // warning only
		expect(v.checks.some((c) => c.name === "supersedes-exists" && c.ok && c.detail)).toBe(true);
	});

	test("unknown frontmatter keys are a violation (strict key set)", () => {
		const file = validFile(TMP, "20260823-050505");
		writeFile(file, mutate(file, (s) => s.replace("supersedes: none", "supersedes: none\nmood: ambitious")));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["frontmatter-unknown-keys"]);
	});

	test("missing section heading", () => {
		const file = validFile(TMP, "20260823-060606");
		writeFile(file, mutate(file, (s) => s.replace("## Honest gaps", "## Reflection")));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["sections-present"]);
	});

	test("sections out of order", () => {
		const file = validFile(TMP, "20260823-060607");
		// Swap the two headings (content rides along) — order breaks, nothing else.
		writeFile(
			file,
			mutate(file, (s) =>
				s
					.replace("## Honest gaps", "@@TMP@@")
					.replace("## Immediate steps", "## Honest gaps")
					.replace("@@TMP@@", "## Immediate steps"),
			),
		);
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["sections-order"]);
	});

	test("Done when with no open checkbox fails (a closed record is not a handoff)", () => {
		const file = validFile(TMP, "20260823-070707");
		writeFile(file, mutate(file, (s) => s.replaceAll("- [ ]", "- [x]")));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["done-when-checkboxes"]);
	});

	test("Ranked next goals: fewer than 3 fails", () => {
		const file = validFile(TMP, "20260823-080808");
		writeFile(file, mutate(file, (s) => s.replace("3. **Third** — first step.\n", "")));
		expect(failedChecks(validateNextGoalFile(file))).toEqual(["ranked-3-to-5"]);
	});
});

describe("doctorNextGoal — pointer + retention", () => {
	function outDir(name: string): string {
		const dir = join(TMP, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	test("healthy: symlink → newest, target valid, retention within cap", () => {
		const dir = outDir("healthy");
		validFile(dir, "20260823-100000");
		const newest = validFile(dir, "20260823-110000", join(dir, "next-goal-20260823-100000.md"));
		symlinkSync("next-goal-20260823-110000.md", join(dir, "LATEST-next-goal.md"));
		const d = doctorNextGoal(dir);
		expect(d.ok).toBe(true);
		expect(d.problems).toEqual([]);
		expect(d.retention).toEqual({ count: 2, overBy: 0 });
		expect(d.validation?.file).toBe(newest);
	});

	test("stale pointer: LATEST not at the newest file", () => {
		const dir = outDir("stale");
		const old = validFile(dir, "20260823-200000");
		validFile(dir, "20260823-210000", old);
		symlinkSync("next-goal-20260823-200000.md", join(dir, "LATEST-next-goal.md"));
		const d = doctorNextGoal(dir);
		expect(d.ok).toBe(false);
		expect(d.problems.join(" ")).toContain("newest file is next-goal-20260823-210000.md");
	});

	test("dangling symlink", () => {
		const dir = outDir("dangling");
		symlinkSync("next-goal-19990101-000000.md", join(dir, "LATEST-next-goal.md"));
		const d = doctorNextGoal(dir);
		expect(d.ok).toBe(false);
		expect(d.problems.join(" ")).toContain("dangles");
	});

	test("missing LATEST symlink", () => {
		const dir = outDir("nolink");
		validFile(dir, "20260823-300000");
		const d = doctorNextGoal(dir);
		expect(d.ok).toBe(false);
		expect(d.problems.join(" ")).toContain("LATEST-next-goal.md is missing");
	});

	test(`retention over cap (> ${MAX_RETENTION} files)`, () => {
		const dir = outDir("retention");
		for (let i = 0; i <= MAX_RETENTION; i++) {
			const hh = String(10 + i).padStart(2, "0");
			validFile(dir, `20260823-${hh}0000`);
		}
		const newest = `next-goal-20260823-${String(10 + MAX_RETENTION).padStart(2, "0")}0000.md`;
		symlinkSync(newest, join(dir, "LATEST-next-goal.md"));
		const d = doctorNextGoal(dir);
		expect(d.ok).toBe(false);
		expect(d.retention).toEqual({ count: MAX_RETENTION + 1, overBy: 1 });
	});
});
