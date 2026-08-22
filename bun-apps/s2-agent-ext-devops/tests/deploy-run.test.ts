import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiAgentDir } from "../src/deploy-run.ts";

/** Build a fake repo tree so resolvePiAgentDir's walk can be tested in isolation. */
function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "deploy-ext-repo-"));
	// mirror layout: deploy library in
	// <root>/bun-apps/s2-agent-ext-devops/src/deploy/run.ts, runnable entries
	// in scripts/run-test.sh; the resolver returns the sibling
	// <root>/bun-apps/s2-agent dir.
	const piAgent = join(root, "bun-apps", "s2-agent");
	mkdirSync(piAgent, { recursive: true });
	const devopsPkg = join(root, "bun-apps", "s2-agent-ext-devops");
	mkdirSync(join(devopsPkg, "scripts"), { recursive: true });
	writeFileSync(join(devopsPkg, "scripts", "run-test.sh"), "# fake");
	mkdirSync(join(devopsPkg, "src", "deploy"), { recursive: true });
	writeFileSync(join(devopsPkg, "src", "deploy", "run.ts"), "// fake");
	// the deploy-run module now lives at
	// <root>/bun-apps/s2-agent-ext-devops/src/deploy-run.ts
	const extDir = join(root, "bun-apps", "s2-agent-ext-devops", "src");
	mkdirSync(extDir, { recursive: true });
	const modFile = join(extDir, "deploy-run.ts");
	writeFileSync(modFile, "// fake module");
	return modFile;
}

describe("resolvePiAgentDir", () => {
	test("PI_AGENT_DIR env override wins when it points at a real s2-agent dir", () => {
		const modFile = fakeRepo();
		// modFile is `<root>/bun-apps/s2-agent-ext-devops/src/deploy-run.ts`;
		// three ".." drop deploy-run.ts + src + s2-agent-ext-devops, landing at
		// `<root>/bun-apps`, where the sibling s2-agent/ lives.
		const envPiAgent = join(modFile, "..", "..", "..", "s2-agent");
		const got = resolvePiAgentDir({ PI_AGENT_DIR: envPiAgent }, `file://${modFile}`);
		expect(got).toBe(envPiAgent);
	});
	test("walk-up finds the sibling s2-agent dir next to s2-agent-ext-devops/src/deploy", () => {
		const modFile = fakeRepo();
		const expected = join(modFile, "..", "..", "..", "s2-agent");
		const got = resolvePiAgentDir({}, `file://${modFile}`);
		expect(got).toBe(expected);
	});
	test("returns null when no s2-agent dir is reachable", () => {
		const nowhere = mkdtempSync(join(tmpdir(), "deploy-ext-empty-"));
		const modFile = join(nowhere, "ext", "deploy.ts");
		mkdirSync(join(nowhere, "ext"), { recursive: true });
		writeFileSync(modFile, "// x");
		expect(resolvePiAgentDir({}, `file://${modFile}`)).toBeNull();
	});
});
