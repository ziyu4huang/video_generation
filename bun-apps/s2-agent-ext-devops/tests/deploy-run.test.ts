import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiAgentDir } from "../src/deploy-run.ts";

/** Build a fake repo tree so resolvePiAgentDir's walk can be tested in isolation. */
function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "deploy-ext-repo-"));
	// mirror layout: deploy library in
	// <root>/bun-apps/s2-agent-ext-devops/src/deploy/run.ts, runnable entries
	// in scripts/run-test.ts; the resolver returns the sibling
	// <root>/bun-apps/s2-agent dir.
	const piAgent = join(root, "bun-apps", "s2-agent");
	mkdirSync(piAgent, { recursive: true });
	const devopsPkg = join(root, "bun-apps", "s2-agent-ext-devops");
	mkdirSync(join(devopsPkg, "scripts"), { recursive: true });
	writeFileSync(join(devopsPkg, "scripts", "run-test.ts"), "# fake");
	mkdirSync(join(devopsPkg, "src", "deploy"), { recursive: true });
	writeFileSync(join(devopsPkg, "src", "deploy", "run.ts"), "// fake");
	return root;
}

describe("resolvePiAgentDir", () => {
	test("PI_AGENT_DIR env override wins when it points at a real s2-agent dir", () => {
		const root = fakeRepo();
		const envPiAgent = join(root, "bun-apps", "s2-agent");
		const got = resolvePiAgentDir({ PI_AGENT_DIR: envPiAgent });
		expect(got).toBe(envPiAgent);
	});
	test("walk-up from an explicit start dir finds the sibling s2-agent", () => {
		const root = fakeRepo();
		// A start dir anywhere under the source package (where the #pi/ext-dir
		// rung lands in source mode) resolves to bun-apps/s2-agent.
		const got = resolvePiAgentDir({}, join(root, "bun-apps", "s2-agent-ext-devops", "src"));
		expect(got).toBe(join(root, "bun-apps", "s2-agent"));
	});
	test("the default ladder resolves from THIS source tree (the #pi/ext-dir rung)", () => {
		// No startDir: the resolver falls to require("#pi/ext-dir"), which in
		// source mode yields this package's root — so the real repo must
		// resolve. (In a deployed bundle that rung is the ext/<name>/ dir and
		// the walk returns null — covered by the startDir null test below.)
		const got = resolvePiAgentDir({});
		expect(got).toBe(join(import.meta.dir, "..", "..", "s2-agent"));
	});
	test("a start dir with no reachable s2-agent returns null (the dist shape)", () => {
		const nowhere = mkdtempSync(join(tmpdir(), "deploy-ext-empty-"));
		const extDir = join(nowhere, "ext", "devops");
		mkdirSync(extDir, { recursive: true });
		expect(resolvePiAgentDir({}, extDir)).toBeNull();
	});
	test("dist-hosted ext-dir rung falls through to the CWD rung (session sitting in a source worktree)", () => {
		// The 2026-08-29 failure shape: a session launched from a deployed dist
		// gets an #pi/ext-dir inside the dist tree (walk finds nothing) — but
		// its cwd IS a source worktree. The cwd rung must rescue it.
		const root = fakeRepo();
		const nowhere = mkdtempSync(join(tmpdir(), "deploy-ext-empty-"));
		const distExtDir = join(nowhere, "ext", "devops");
		mkdirSync(distExtDir, { recursive: true });
		const prevCwd = process.cwd();
		try {
			process.chdir(root); // cwd = a source worktree ROOT (one level above bun-apps)
			const got = resolvePiAgentDir({}, undefined, { extDirStart: () => distExtDir });
			// macOS: chdir resolves /var → /private/var, so compare realpaths.
			expect(got && realpathSync(got)).toBe(realpathSync(join(root, "bun-apps", "s2-agent")));
		} finally {
			process.chdir(prevCwd);
		}
	});
	test("both rungs failing returns null (dist tree, empty cwd)", () => {
		const nowhere = mkdtempSync(join(tmpdir(), "deploy-ext-empty-"));
		const distExtDir = join(nowhere, "ext", "devops");
		mkdirSync(distExtDir, { recursive: true });
		const empty = mkdtempSync(join(tmpdir(), "deploy-ext-empty-cwd-"));
		const prevCwd = process.cwd();
		try {
			process.chdir(empty);
			const got = resolvePiAgentDir({}, undefined, { extDirStart: () => distExtDir });
			expect(got).toBeNull();
		} finally {
			process.chdir(prevCwd);
		}
	});
	test("a start dir AT the repo root resolves via the bun-apps base rung", () => {
		// The walk's each-rung base set is {dir, dir/bun-apps}: a cwd at the
		// repo ROOT (not inside bun-apps) still resolves.
		const root = fakeRepo();
		expect(resolvePiAgentDir({}, root)).toBe(join(root, "bun-apps", "s2-agent"));
	});
});
