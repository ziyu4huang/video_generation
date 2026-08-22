/**
 * forge-select.test.ts — backend selection policy (REST-first, gh fallback,
 * never anonymous) + remote-URL parsing + the module memo.
 */
import { describe, expect, test } from "bun:test";
import { parseRemoteUrl, selectForgeClient } from "../src/forge/select.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

describe("parseRemoteUrl", () => {
	test("SCP-style ssh", () => {
		expect(parseRemoteUrl("git@github.com:owner/repo.git")).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
	});
	test("https with .git and without", () => {
		expect(parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
		expect(parseRemoteUrl("https://github.com/owner/repo")).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
	});
	test("https with credentials + trailing path junk", () => {
		expect(parseRemoteUrl("https://user:tok@git.example.com/o/r.git")).toEqual({ host: "git.example.com", owner: "o", repo: "r" });
	});
	test("ssh:// with port", () => {
		expect(parseRemoteUrl("ssh://git@git.example.com:2222/o/r.git")).toEqual({ host: "git.example.com", owner: "o", repo: "r" });
	});
	test("host lowercased; unparseable → null", () => {
		expect(parseRemoteUrl("git@GitHub.COM:o/r")?.host).toBe("github.com");
		expect(parseRemoteUrl("")).toBeNull();
		expect(parseRemoteUrl("not a remote at all")).toBeNull();
		expect(parseRemoteUrl("git@github.com")).toBeNull();
	});
});

/** Fake spawn answering per-(cmd,args[0..1]) canned results. */
function fakeSpawn(routes: Array<{ match: (cmd: string, args: string[]) => boolean; result: SpawnResult }>): SpawnFn {
	return async (cmd, args) => {
		const hit = routes.find((r) => r.match(cmd, args));
		return (
			hit?.result ?? { stdout: "", stderr: "no route", exitCode: 1 }
		);
	};
}

const ok = (stdout: string): SpawnResult => ({ stdout, stderr: "", exitCode: 0 });
const fail: SpawnResult = { stdout: "", stderr: "not found", exitCode: 1 };

const remoteOk = (url: string) => fakeSpawn([
	{ match: (c, a) => c === "git" && a[0] === "remote" && a[1] === "get-url", result: ok(`${url}\n`) },
]);

describe("selectForgeClient — backend policy", () => {
	test("1) GITHUB_TOKEN env → github-rest, tokenKind recorded", async () => {
		const s = await selectForgeClient({
			spawn: remoteOk("git@github.com:o/r.git"),
			env: { GITHUB_TOKEN: "env-token" },
		});
		expect(s.backend).toBe("github-rest");
		expect(s.tokenKind).toBe("GITHUB_TOKEN env");
		expect(s.coords).toEqual({ host: "github.com", owner: "o", repo: "r" });
	});

	test("GH_TOKEN is honored too; env token beats gh auth token (no gh spawn needed)", async () => {
		let ghSpawned = false;
		const spawn = remoteOk("https://github.com/o/r.git");
		const wrapped: SpawnFn = async (cmd, args, options) => {
			if (cmd === "gh") ghSpawned = true;
			return spawn(cmd, args, options);
		};
		const s = await selectForgeClient({ spawn: wrapped, env: { GH_TOKEN: "t2" } });
		expect(s.backend).toBe("github-rest");
		expect(s.tokenKind).toBe("GITHUB_TOKEN env");
		expect(ghSpawned).toBe(false);
	});

	test("2) no env token but `gh auth token` answers → github-rest via gh's token", async () => {
		const s = await selectForgeClient({
			spawn: fakeSpawn([
				{ match: (c, a) => c === "git" && a[0] === "remote", result: ok("git@github.com:o/r.git\n") },
				{ match: (c, a) => c === "gh" && a[0] === "auth", result: ok("gh-harvested-token\n") },
			]),
			env: {},
		});
		expect(s.backend).toBe("github-rest");
		expect(s.tokenKind).toBe("gh auth token");
	});

	test("3) no token at all but gh on PATH → gh-cli fallback", async () => {
		const s = await selectForgeClient({
			spawn: fakeSpawn([
				{ match: (c, a) => c === "git" && a[0] === "remote", result: ok("git@github.com:o/r.git\n") },
				// `gh auth token` FAILS (logged out / no token)…
				{ match: (c, a) => c === "gh" && a[0] === "auth", result: fail },
				// …but gh itself is installed (the fallback's probe).
				{ match: (c) => c === "gh", result: ok("gh version 2.0.0\n") },
			]),
			env: {},
		});
		expect(s.backend).toBe("gh-cli");
		expect(s.tokenKind).toBeUndefined();
	});

	test("4) nothing available → throws with remediation", async () => {
		const s = await selectForgeClient({ spawn: remoteOk("git@github.com:o/r.git"), env: {} }).then(
			(r) => r,
			(err: Error) => err,
		);
		expect(s).toBeInstanceOf(Error);
		expect((s as Error).message).toContain("gh auth login");
	});

	test("non-GitHub forge (gitea host) → refused with a pointer to the gitea skeleton", async () => {
		const s = await selectForgeClient({ spawn: remoteOk("https://git.example-gitea.com/o/r.git"), env: { GITHUB_TOKEN: "t" } }).then(
			(r) => r,
			(err: Error) => err,
		);
		expect(s).toBeInstanceOf(Error);
		expect((s as Error).message).toContain("gitea.ts");
	});

	test("unparseable remote URL → throws", async () => {
		const s = await selectForgeClient({ spawn: remoteOk("garbage"), env: {} }).then(
			(r) => r,
			(err: Error) => err,
		);
		expect(s).toBeInstanceOf(Error);
		expect((s as Error).message).toContain("unparseable");
	});

	test("git remote query fails → throws", async () => {
		const s = await selectForgeClient({ spawn: fakeSpawn([{ match: () => true, result: fail }]), env: {} }).then(
			(r) => r,
			(err: Error) => err,
		);
		expect(s).toBeInstanceOf(Error);
		expect((s as Error).message).toContain("origin remote");
	});
});

describe("selectForgeClient — remoteName passthrough", () => {
	test("SelectedForge.remoteName defaults to origin, honors DEVOPS_REMOTE", async () => {
		const s1 = await selectForgeClient({ spawn: remoteOk("https://github.com/o/r.git"), env: { GITHUB_TOKEN: "t" } });
		expect(s1.remoteName).toBe("origin");
		const s2 = await selectForgeClient({
			spawn: remoteOk("https://github.com/o/r.git"),
			env: { GITHUB_TOKEN: "t", DEVOPS_REMOTE: "upstream" },
		});
		expect(s2.remoteName).toBe("upstream");
	});

	test("gh-cli fallback path also carries remoteName", async () => {
		const s = await selectForgeClient({
			spawn: fakeSpawn([
				{ match: (c, a) => c === "git" && a[0] === "remote", result: ok("git@github.com:o/r.git\n") },
				{ match: (c, a) => c === "gh" && a[0] === "auth", result: fail },
				{ match: (c, a) => c === "gh" && a[0] === "--version", result: ok("gh version 2.0.0\n") },
			]),
			env: { DEVOPS_REMOTE: "upstream" },
		});
		expect(s.backend).toBe("gh-cli");
		expect(s.remoteName).toBe("upstream");
	});
});
