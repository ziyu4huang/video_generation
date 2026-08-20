import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverMemoryFiles } from "../commands/memory-to-vault-discover.ts";

describe("discoverMemoryFiles", () => {
	let root: string;
	let memoryDir: string;
	let projectsDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mtv-disc-"));
		memoryDir = join(root, "pi-hermes-memory");
		projectsDir = join(root, "projects-memory");
		mkdirSync(memoryDir, { recursive: true });
		mkdirSync(projectsDir, { recursive: true });
		// global hermes files
		writeFileSync(join(memoryDir, "MEMORY.md"), "entry one §\n");
		writeFileSync(join(memoryDir, "failures.md"), "fail one §\n");
		writeFileSync(join(memoryDir, "USER.md"), "user pref §\n");
		// 2 real project dirs
		for (const p of ["video_generation__memory", "s2-agent"]) {
			const d = join(projectsDir, p);
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, "MEMORY.md"), `${p} lesson §\n`);
		}
		// NOISE: verify + tmp + backup + empty
		mkdirSync(join(projectsDir, "s2-agent-verify-ABC"), { recursive: true });
		writeFileSync(join(projectsDir, "s2-agent-verify-ABC", "MEMORY.md"), "should be excluded §\n");
		mkdirSync(join(projectsDir, "tmp.foo"), { recursive: true });
		writeFileSync(join(projectsDir, "tmp.foo", "MEMORY.md"), "should be excluded §\n");
		mkdirSync(join(projectsDir, "real-but-empty"), { recursive: true });
		writeFileSync(join(projectsDir, "real-but-empty", "MEMORY.md"), ""); // empty → excluded
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("keeps 3 global + real projects, drops verify/tmp/empty", () => {
		const { files } = discoverMemoryFiles({ memoryDir, projectsDir });
		const names = files.map((f) => f.source).sort();
		expect(names).toEqual([
			"hermes:MEMORY.md",
			"hermes:USER.md",
			"hermes:failures.md",
			"project:s2-agent",
			"project:video_generation__memory",
		]);
	});

	test("--only glob restricts projects but keeps all global", () => {
		const { files } = discoverMemoryFiles({ memoryDir, projectsDir, only: "video_generation__*" });
		const names = files.map((f) => f.source).sort();
		expect(names).toEqual([
			"hermes:MEMORY.md",
			"hermes:USER.md",
			"hermes:failures.md",
			"project:video_generation__memory",
		]);
	});

	test("every returned path exists and is non-empty", () => {
		const { files, excluded } = discoverMemoryFiles({ memoryDir, projectsDir });
		for (const f of files) {
			expect(statSync(f.path).size).toBeGreaterThan(0);
		}
		expect(excluded).toBeGreaterThanOrEqual(3); // verify + tmp + empty
	});
});
