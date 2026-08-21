/**
 * remote.test.ts — remote-name resolution order (DEVOPS_REMOTE env >
 * git config devops.remote > "origin") + its consumption by forge selection.
 */
import { describe, expect, test } from "bun:test";
import { resolveRemoteName } from "../src/remote.js";
import { selectForgeClient } from "../src/forge/select.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const ok = (stdout: string): SpawnResult => ({ stdout, stderr: "", exitCode: 0 });
const fail: SpawnResult = { stdout: "", stderr: "", exitCode: 1 };

function spawnWith(gitConfig: SpawnResult): SpawnFn {
	return async (cmd, args) => {
		if (cmd === "git" && args[0] === "config") return gitConfig;
		return fail;
	};
}

describe("resolveRemoteName", () => {
	test("DEVOPS_REMOTE env wins", async () => {
		expect(await resolveRemoteName(spawnWith(ok("should-not-win\n")), { DEVOPS_REMOTE: "upstream" })).toBe("upstream");
	});

	test("git config devops.remote next", async () => {
		expect(await resolveRemoteName(spawnWith(ok("myremote\n")), {})).toBe("myremote");
	});

	test("defaults to origin when neither is set", async () => {
		expect(await resolveRemoteName(spawnWith(fail), {})).toBe("origin");
	});

	test("blank env value is ignored", async () => {
		expect(await resolveRemoteName(spawnWith(ok("cfg\n")), { DEVOPS_REMOTE: "   " })).toBe("cfg");
	});
});

describe("forge selection uses the resolved remote", () => {
	test("DEVOPS_REMOTE=upstream queries THAT remote's URL", async () => {
		const calls: string[] = [];
		const spawn: SpawnFn = async (cmd, args) => {
			calls.push([cmd, ...args].join(" "));
			if (cmd === "git" && args[0] === "config") return fail;
			if (cmd === "git" && args[0] === "remote" && args[2] === "upstream") return ok("git@github.com:o/via-upstream.git\n");
			if (cmd === "gh" && args[0] === "auth") return ok("tok\n");
			return fail;
		};
		const s = await selectForgeClient({ spawn, env: { DEVOPS_REMOTE: "upstream", GITHUB_TOKEN: "t" } });
		expect(s.coords.repo).toBe("via-upstream");
		expect(calls).toContain("git remote get-url upstream");
		expect(calls).not.toContain("git remote get-url origin");
	});
});
