/**
 * cli-runtime-spawn — REAL-subprocess smokes for both invocation runtimes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The unit suites inject every seam (fake SpawnFn, fake GhClient), so a CLI
 * that only fails as a real process — a bad import, a top-level await that
 * throws, a stdout/stderr contract violation under bun's runner, a bin entry
 * that doesn't parse — stays green forever. These tests spawn the CLIs the
 * way the two real consumers do:
 *
 *   claude-code / plain sessions:  bun bun-apps/s2-agent-ext-devops/src/<X>-cli.ts
 *   s2-agent wrapper runtime:      bun bun-apps/s2-agent/src/cli.ts --help
 *
 * The s2-agent probe is the cheap boot form (no model, no session): it proves
 * the wrapper still boots with this package's current code wired in — the
 * same shape as the dist E2E's boot probe, one layer down.
 *
 * Bounded: every spawn gets a hard timeout so a hang fails a test in seconds
 * instead of stalling `bun test` (the bun-1.4 stderr note is why we read both
 * pipes, never stdout alone).
 *
 * PORTABILITY P2 (host-binary spawn): gated off CI via describe.skipIf, the
 * same convention as s2-agent-ext-movie-director cli.test.ts and
 * gui-movie-director check-runtime.test.ts — runs on every local `bun test`,
 * skips on bare CI runners. See .github/TEST-PORTABILITY.md.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PKG = resolve(import.meta.dir, "..");
const REPO = resolve(PKG, "..", "..");
/** Every CLI fallback — discovered from package.json's bin map, not hand-copied
 * (a hand-copied list goes stale the moment a CLI is added, which is exactly
 * how a broken bin would ship). */
const BINS = ((await Bun.file(join(PKG, "package.json")).json()) as { bin: Record<string, string> }).bin;

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
	const r = spawnSync(cmd, args, {
		cwd: opts.cwd ?? PKG,
		encoding: "utf8",
		timeout: opts.timeoutMs ?? 60_000,
	});
	return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!!process.env.CI)("claude-code runtime: every bin CLI spawns and honors the shared contract", () => {
	for (const [name, rel] of Object.entries(BINS)) {
		test(`${name} (${rel}): --help exits 0, usage on stderr, NOTHING on stdout`, () => {
			const r = run("bun", [join(PKG, rel), "--help"], { cwd: REPO });
			expect(r.code).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr.toLowerCase()).toContain("usage");
		});
	}

	test("the bin map covers every src/*-cli.ts (no unregistered CLI escapes the loop)", async () => {
		const dir = await Array.fromAsync(new Bun.Glob("*-cli.ts").scan({ cwd: join(PKG, "src") }));
		const binFiles = [...new Set(Object.values(BINS))].map((p) => p.replace("./src/", ""));
		expect(dir.sort()).toEqual(binFiles.sort());
	});
});

describe.skipIf(!!process.env.CI)("claude-code runtime: verify-deploy-e2e-cli end-to-end against a stub deploy", () => {
	// A stub s2-agent.sh that answers all three probes offline — this exercises the
	// REAL CLI process: argv parse → deploy.json read → current resolve →
	// three real child spawns → JSON serialization → exit code.
	const root = mkdtempSync(join(tmpdir(), "deploy-e2e-spawn-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const VERSION = "0.1.0+gstub0000";
	const versionDir = join(root, VERSION);

	test("healthy stub tree: exit 0, verdict pass, pure JSON on stdout", () => {
		mkdirSync(versionDir, { recursive: true });
		writeFileSync(
			join(versionDir, "s2-agent.sh"),
			[
				"#!/usr/bin/env bash",
				'case "$1" in',
				"  --help) echo 'usage: stub'; exit 0;;",
				"  --ext-list) echo '{\"loadedCount\":2,\"loaded\":[\"stub-a\",\"stub-b\"],\"skipped\":[]}'; exit 0;;",
				"  -p) echo ok; exit 0;;",
				"esac",
				"exit 1",
				"",
			].join("\n"),
		);
		chmodSync(join(versionDir, "s2-agent.sh"), 0o755);
		writeFileSync(
			join(versionDir, "deploy.json"),
			JSON.stringify({
				version: VERSION,
				sourceSha: "stub0000",
				config: { extensions: [{ name: "stub-a", enabled: true }, { name: "stub-b", enabled: true }] },
			}),
		);
		symlinkSync(VERSION, join(root, "current"), "dir");

		const r = run("bun", [join(PKG, "src/verify-deploy-e2e-cli.ts"), "--deploy-root", root], { cwd: REPO });
		expect(r.code).toBe(0);
		const payload = JSON.parse(r.stdout);
		expect(payload.verdict).toBe("pass");
		expect(payload.probes.map((p: { id: string; verdict: string }) => `${p.id}:${p.verdict}`)).toEqual([
			"boot:pass",
			"ext-load:pass",
			"model-call:pass",
			"file2md-ocr:skip",
			"tool-gate-fire:skip",
		]);
	});

	test("an ext the stub does NOT load: exit 1, verdict fail", () => {
		// Same tree, but the caller declares a third enabled ext deploy.json
		// never reports — the drift case deploy Gate 3 exists for.
		writeFileSync(
			join(versionDir, "deploy.json"),
			JSON.stringify({
				version: VERSION,
				sourceSha: "stub0000",
				config: { extensions: [{ name: "stub-a", enabled: true }, { name: "stub-c", enabled: true }] },
			}),
		);
		const r = run("bun", [join(PKG, "src/verify-deploy-e2e-cli.ts"), "--deploy-root", root], { cwd: REPO });
		expect(r.code).toBe(1);
		const payload = JSON.parse(r.stdout);
		expect(payload.verdict).toBe("fail");
		expect(payload.probes.find((p: { id: string }) => p.id === "ext-load").note).toContain("stub-c");
	});

	test("no current: exit 1 with the structured fail", () => {
		const empty = mkdtempSync(join(tmpdir(), "deploy-e2e-empty2-"));
		try {
			const r = run("bun", [join(PKG, "src/verify-deploy-e2e-cli.ts"), "--deploy-root", empty], { cwd: REPO });
			expect(r.code).toBe(1);
			expect(JSON.parse(r.stdout).note).toContain("current");
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!!process.env.CI)("s2-agent runtime: the wrapper still boots with this package wired in", () => {
	test(
		"bun bun-apps/s2-agent/src/cli.ts --help exits 0 (cheap boot, no model)",
		() => {
			const r = run("bun", [join(REPO, "bun-apps/s2-agent/src/cli.ts"), "--help"], { cwd: REPO });
			expect(r.code).toBe(0);
			expect(r.stdout.toLowerCase()).toContain("usage");
		},
		// Explicit 30s harness budget: bun's default per-test timeout is 5s,
		// but this probe boots the whole s2-agent CLI (all static extensions
		// imported) — ~3.2s in isolation, and local-ci runs packages in
		// parallel, so 5s flakes under load. The intent is "wrapper boots",
		// not a perf gate; the spawn's own 60s cap still bounds a hang.
		30_000,
	);
});
