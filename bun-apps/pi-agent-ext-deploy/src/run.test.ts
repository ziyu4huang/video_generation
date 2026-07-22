import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiAgentDir, assertSafeOutDir } from "./run.ts";

/** Build a fake repo tree so resolvePiAgentDir's walk can be tested in isolation. */
function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "deploy-ext-repo-"));
	// mirror layout: <root>/bun-apps/pi-agent/{scripts/deploy.ts,run-test.sh}
	const piAgent = join(root, "bun-apps", "pi-agent");
	mkdirSync(join(piAgent, "scripts"), { recursive: true });
	writeFileSync(join(piAgent, "scripts", "deploy.ts"), "// fake");
	writeFileSync(join(piAgent, "run-test.sh"), "# fake");
	// the extension lives at <root>/bun-apps/pi-agent-ext-deploy/extensions/deploy.ts
	const extDir = join(root, "bun-apps", "pi-agent-ext-deploy", "extensions");
	mkdirSync(extDir, { recursive: true });
	const modFile = join(extDir, "deploy.ts");
	writeFileSync(modFile, "// fake ext");
	return modFile;
}

describe("resolvePiAgentDir", () => {
	test("PI_AGENT_DIR env override wins when it points at a real pi-agent dir", () => {
		const modFile = fakeRepo();
		// modFile is `<root>/bun-apps/pi-agent-ext-deploy/extensions/deploy.ts`;
		// three ".." drop deploy.ts + extensions + pi-agent-ext-deploy, landing at
		// `<root>/bun-apps`, where the sibling pi-agent/ lives.
		const envPiAgent = join(modFile, "..", "..", "..", "pi-agent");
		const got = resolvePiAgentDir({ PI_AGENT_DIR: envPiAgent } as NodeJS.ProcessEnv, `file://${modFile}`);
		expect(got).toBe(envPiAgent);
	});
	test("walk-up finds the sibling pi-agent dir containing scripts/deploy.ts", () => {
		const modFile = fakeRepo();
		const expected = join(modFile, "..", "..", "..", "pi-agent");
		const got = resolvePiAgentDir({}, `file://${modFile}`);
		expect(got).toBe(expected);
	});
	test("returns null when no pi-agent dir is reachable", () => {
		const nowhere = mkdtempSync(join(tmpdir(), "deploy-ext-empty-"));
		const modFile = join(nowhere, "ext", "deploy.ts");
		mkdirSync(join(nowhere, "ext"), { recursive: true });
		writeFileSync(modFile, "// x");
		expect(resolvePiAgentDir({}, `file://${modFile}`)).toBeNull();
	});
});

describe("assertSafeOutDir", () => {
	const repo = mkdtempSync(join(tmpdir(), "deploy-ext-repoguard-"));
	test("accepts a path under <repo>/dist/", () => {
		expect(() => assertSafeOutDir(join(repo, "dist", "pi-agent"), repo)).not.toThrow();
		expect(() => assertSafeOutDir("dist/out", repo)).not.toThrow(); // repo-relative
	});
	test("accepts a path under the OS temp dir", () => {
		expect(() => assertSafeOutDir(join(tmpdir(), "deploy-ext-x"), repo)).not.toThrow();
	});
	test("rejects the source tree and arbitrary absolute paths", () => {
		expect(() => assertSafeOutDir(join(repo, "bun-apps"), repo)).toThrow();
		expect(() => assertSafeOutDir("/etc/pi-agent", repo)).toThrow();
	});
});
