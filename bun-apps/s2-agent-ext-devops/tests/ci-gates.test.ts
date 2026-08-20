/**
 * Tests for src/ci-gates.ts — the `regression-gates` job reader that makes the
 * CI workflow the source of truth for WHICH gates run_local_ci runs.
 *
 * WHY THIS EXISTS
 *   run_local_ci used to carry a hand-written gate list (`BLOCKING_GATES_V1` = 2
 *   files, `STRICT_AUDIT_GATES` = 4). The real job has 14 steps, 8 of which
 *   run_local_ci never ran — `test:deps`, `test:adr`, `test:seam`, `test:routing`,
 *   `test:config-parity`, `test:ci-workflow`, `test:scripts`, and the --strict
 *   portability audit. Since `merge_pr_after_local_ci` gates the squash-merge on
 *   run_local_ci, a PR that broke any of those structural guards merged green.
 *   Two of the hand-written entries (check-workflow-patterns.mjs,
 *   verify-skills.ts) are in NO workflow step at all — drift in both
 *   directions, which is exactly what scripts/ci-local.sh's "NO COPY OF THE
 *   MATRIX" rule exists to prevent. This module applies that same rule to the
 *   gates.
 *
 * The degradation contract is the OPPOSITE of readCiMatrix's. A matrix that
 * fails to parse degrades to {} because a package with no row still runs its
 * generic `bun run test`. A gate list that fails to parse must NEVER degrade to
 * [] — zero gates reads as "all gates passed", the precise false-green this
 * whole file exists to stop. So every failure surfaces as `error`.
 */
import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseCiGates, readCiGates, LOCAL_ONLY_AUDITS } from "../src/ci-gates.js";
import { CI_WORKFLOW_PATH } from "../src/ci-matrix.js";

/** This repo's root, from bun-apps/s2-agent-ext-devops/tests/. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

const yaml = (...lines: string[]) => lines.join("\n");

describe("parseCiGates", () => {
	test("reads each run: step with its working-directory, skipping uses: steps", () => {
		const out = parseCiGates(
			yaml(
				"jobs:",
				"  regression-gates:",
				"    steps:",
				"      - uses: actions/checkout@v4",
				"      - name: File-size guard",
				"        run: bash scripts/ci-file-size-guard.sh",
				"      - name: Dep-direction guard",
				"        working-directory: bun-apps",
				"        run: bun run test:deps",
			),
		);
		expect(out.error).toBeUndefined();
		expect(out.gates).toEqual([
			{ name: "File-size guard", cwd: ".", run: "bash scripts/ci-file-size-guard.sh" },
			{ name: "Dep-direction guard", cwd: "bun-apps", run: "bun run test:deps" },
		]);
	});

	test("collapses a multi-line run: block into one shell command", () => {
		const out = parseCiGates(
			yaml(
				"jobs:",
				"  regression-gates:",
				"    steps:",
				"      - name: Two-liner",
				"        run: |",
				"          bun run a",
				"          bun run b",
			),
		);
		expect(out.gates).toHaveLength(1);
		expect(out.gates[0].run).toBe("bun run a bun run b");
	});

	test("a step with an `if:` is an ERROR, not a silent skip", () => {
		// Evaluating a GitHub expression is out of scope; guessing its truth value
		// would silently run or skip the wrong gate set. Refuse instead.
		const out = parseCiGates(
			yaml(
				"jobs:",
				"  regression-gates:",
				"    steps:",
				"      - name: Conditional",
				"        if: github.ref == 'refs/heads/main'",
				"        run: bash scripts/x.sh",
			),
		);
		expect(out.gates).toEqual([]);
		expect(out.error).toContain("if:");
	});

	test("a missing regression-gates job is an ERROR, never an empty pass", () => {
		const out = parseCiGates(yaml("jobs:", "  tests: {}"));
		expect(out.gates).toEqual([]);
		expect(out.error).toBeTruthy();
	});

	test("a job with zero run: steps is an ERROR", () => {
		const out = parseCiGates(yaml("jobs:", "  regression-gates:", "    steps:", "      - uses: actions/checkout@v4"));
		expect(out.gates).toEqual([]);
		expect(out.error).toContain("ZERO");
	});

	test("garbage YAML is an ERROR, never an empty pass", () => {
		for (const src of ["", "\t\tnot: [valid: yaml", "jobs: {}"]) {
			const out = parseCiGates(src);
			expect(out.gates).toEqual([]);
			expect(out.error, `expected an error for ${JSON.stringify(src)}`).toBeTruthy();
		}
	});

	test("an unnamed step still parses (named by its command)", () => {
		const out = parseCiGates(yaml("jobs:", "  regression-gates:", "    steps:", "      - run: bash scripts/x.sh"));
		expect(out.error).toBeUndefined();
		expect(out.gates).toHaveLength(1);
		expect(out.gates[0].name).toBe("bash scripts/x.sh");
	});
});

describe("readCiGates — against this repo's real workflow", () => {
	test("reads every gate step the regression-gates job actually runs", async () => {
		const { gates, error } = await readCiGates(REPO_ROOT);
		expect(error).toBeUndefined();
		expect(gates.length).toBeGreaterThanOrEqual(14);
		const runs = gates.map((g) => g.run);
		// The eight the hand-written list missed — the whole reason this exists.
		for (const cmd of [
			"bun run test:deps",
			"bun run test:adr",
			"bun run test:seam",
			"bun run test:routing",
			"bun run test:config-parity",
			"bun run test:ci-workflow",
			"bun run test:scripts",
			"bash scripts/test-portability-audit.sh --strict",
		]) {
			expect(runs, `gate missing: ${cmd}`).toContain(cmd);
		}
		// …and the two the hand-written list already had.
		expect(runs).toContain("bash scripts/ci-file-size-guard.sh");
		expect(runs).toContain("bash scripts/check-lockfile-duplicate-versions.sh");
	});

	test("carries each gate's working-directory (bun-apps rows would fail at the repo root)", async () => {
		const { gates } = await readCiGates(REPO_ROOT);
		const deps = gates.find((g) => g.run === "bun run test:deps");
		expect(deps?.cwd).toBe("bun-apps");
		const fileSize = gates.find((g) => g.run === "bash scripts/ci-file-size-guard.sh");
		expect(fileSize?.cwd).toBe(".");
	});

	test("a missing workflow is an ERROR, never an empty gate set", async () => {
		const { gates, error } = await readCiGates("/definitely/not/a/repo");
		expect(gates).toEqual([]);
		expect(error).toBeTruthy();
	});
});

describe("LOCAL_ONLY_AUDITS — the drift guard in the other direction", () => {
	test("each one exists on disk", async () => {
		for (const file of LOCAL_ONLY_AUDITS) {
			expect(await Bun.file(`${REPO_ROOT}/scripts/${file}`).exists(), `missing scripts/${file}`).toBe(true);
		}
	});

	test("none of them appears in the workflow — that is what makes them local-only", async () => {
		// If CI ever grows a step for one of these, it belongs in the derived gate
		// set and must come OUT of this list, or run_local_ci runs it twice and the
		// `strict` flag stops meaning "CI's gates plus the ones CI has no home for".
		const src = await Bun.file(`${REPO_ROOT}/${CI_WORKFLOW_PATH}`).text();
		for (const file of LOCAL_ONLY_AUDITS) {
			expect(src.includes(file), `scripts/${file} IS in the workflow — move it out of LOCAL_ONLY_AUDITS`).toBe(false);
		}
	});
});
