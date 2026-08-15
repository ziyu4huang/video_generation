/**
 * Tests for src/ci-matrix.ts — the `tests` matrix reader that makes the CI
 * workflow the source of truth for a package's test command.
 *
 * Two halves:
 *  - `parseCiMatrix` against synthetic YAML (shape handling + degradation), and
 *  - `readCiMatrix` against THIS repo's real .github/workflows/ci.yml.disabled,
 *    which is what pins the property that actually matters: the special rows
 *    (--isolate, `&& bun run qa`, build-first) are read verbatim, so local_ci
 *    cannot substitute a generic `bun run test` for them.
 */
import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseCiMatrix, readCiMatrix, CI_WORKFLOW_PATH } from "../src/ci-matrix.js";

/** This repo's root, from bun-apps/pi-agent-ext-devops/tests/. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

describe("parseCiMatrix", () => {
	test("maps every include row to package → test-cmd", () => {
		const yaml = [
			"jobs:",
			"  tests:",
			"    strategy:",
			"      matrix:",
			"        include:",
			'          - { package: pkg-a, test-cmd: "bun test" }',
			'          - { package: pkg-b, test-cmd: "bun test --isolate" }',
		].join("\n");
		expect(parseCiMatrix(yaml)).toEqual({ "pkg-a": "bun test", "pkg-b": "bun test --isolate" });
	});

	test("ignores a job whose matrix has no include list (determinism-spotcheck shape)", () => {
		const yaml = [
			"jobs:",
			"  tests:",
			"    strategy:",
			"      matrix:",
			"        package:",
			"          - pkg-a",
		].join("\n");
		expect(parseCiMatrix(yaml)).toEqual({});
	});

	test("degrades to {} on garbage / missing keys rather than throwing", () => {
		expect(parseCiMatrix("")).toEqual({});
		expect(parseCiMatrix("jobs: {}")).toEqual({});
		expect(parseCiMatrix("\t\tnot: [valid: yaml")).toEqual({});
	});

	test("skips malformed rows but keeps the well-formed ones", () => {
		const yaml = [
			"jobs:",
			"  tests:",
			"    strategy:",
			"      matrix:",
			"        include:",
			'          - { package: pkg-a, test-cmd: "bun test" }',
			"          - { package: pkg-no-cmd }",
		].join("\n");
		expect(parseCiMatrix(yaml)).toEqual({ "pkg-a": "bun test" });
	});
});

describe("readCiMatrix — against this repo's real workflow", () => {
	test("reads every row, including the ones a generic derivation would get wrong", async () => {
		const matrix = await readCiMatrix(REPO_ROOT);
		expect(Object.keys(matrix).length).toBeGreaterThanOrEqual(28);
		// The rows whose command is NOT `bun run test` — the whole reason this exists.
		expect(matrix["pi-agent-ext-file2md"]).toBe("bun test --isolate");
		expect(matrix["pi-agent-ext-archify"]).toBe("bun test --isolate");
		expect(matrix["pi-agent-ext-tool-gate"]).toBe("bun test && bun run qa");
		// src-entry since the 2026-08-15 migration (tickets 02/04): generic chain,
		// no build prefix. Asserting these guards the rows against quiet re-widening.
		expect(matrix["pi-agent-ext-workflow"]).toBe("bun run test");
		expect(matrix["pi-agent-ext-webui"]).toBe("bun test");
		expect(matrix["pi-agent-ext-knowledge-card"]).toContain("--isolate");
		expect(matrix["pi-agent-ext-knowledge-card"]).toContain("toolWiring.test.mjs");
	});

	test("a missing workflow yields {} (generic derivation everywhere), never a throw", async () => {
		expect(await readCiMatrix("/definitely/not/a/repo")).toEqual({});
	});

	test("CI_WORKFLOW_PATH points at the file that actually exists", async () => {
		expect(await Bun.file(`${REPO_ROOT}/${CI_WORKFLOW_PATH}`).exists()).toBe(true);
	});
});
