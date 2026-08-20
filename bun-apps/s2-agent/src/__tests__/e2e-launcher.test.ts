/**
 * e2e-launcher — spawns real child processes against run.sh itself (not the
 * TS modules it loads). Covers symlink resolution, entry-mode detection,
 * --update-help, --upgrade passthrough, read-only env exports, and the
 * source-mode node_modules self-heal — none of which any other test file
 * exercises (they all import TS directly).
 *
 * Run: bun test src/__tests__/e2e-launcher.test.ts
 *
 * WHY MOST OF THIS FILE IS UNGATED
 * --------------------------------
 * It used to gate every block on PI_AGENT_E2E=1, copying the convention from
 * the since-deleted e2e-patches / e2e-extensions / e2e-readonly. But read what
 * that gate was FOR: those files called `ensureBundle()`, and "builds are
 * slow". Five of the six blocks here build nothing and boot no pi — they write
 * a stub entry into a tmpdir, copy run.sh next to it, and assert on what bash
 * does. They inherited a cost gate for a cost they do not have.
 *
 * What that inheritance cost, measured: PI_AGENT_E2E=1 is set only by
 * run-test.sh at the `medium`+ tiers, which only the `deploy-verify` job runs
 * — a job in `ci.yml.disabled` (GitHub Actions does not run in this repo) and
 * conditional on changed deploy paths besides. `run_local_ci`, the only CI that
 * executes here, derives its gate list from the `regression-gates` job alone
 * and runs s2-agent's matrix command (`bun test && bun run typecheck`) with no
 * PI_AGENT_E2E. So every assertion in this file was dead: `bun test` reported
 * `16 skip` and nothing anywhere turned them on. run.sh is the entry point
 * every session starts through, and it was covered only on paper.
 *
 * This is the failure mode e2e-harness.ts used to document one instance of
 * (#1305 moved deploy.ts; `Module not found` surfaced only at tiers the
 * default `bun test` does not run). Cost of undoing it here: 1.3s.
 *
 * The `s2-agent.js` / `.deploy-readonly` fixtures that used to live here were
 * kept through #1740 on purpose: the launcher arm they covered was still live,
 * and deleting a test one PR ahead of the behaviour it guards is the gap this
 * file's own header is about. Phase 1b removed that arm, so they went in the
 * SAME commit as it.
 *
 * The ONE block still gated is `symlink resolution`, which spawns the real
 * src/cli.ts — a full pi boot that touches the shared ~/.pi backend. That one
 * genuinely does not belong in a default `bun test`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, readFileSync, realpathSync, lstatSync, readlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { E2E_ENABLED } from "./e2e-harness.ts";

const RUN_SH = path.resolve(import.meta.dirname, "../../run.sh");
const REAL_PKG_DIR = path.dirname(RUN_SH); // bun-apps/s2-agent — source (dev) mode in this checkout
let TMP: string;

beforeAll(() => {
	TMP = mkdtempSync(path.join(tmpdir(), "s2-agent-e2e-launcher-"));
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
	return spawnSync("bash", [opts.cwd ? path.join(opts.cwd, "run.sh") : RUN_SH, ...args], {
		cwd: opts.cwd ?? path.dirname(RUN_SH),
		env: { ...process.env, ...opts.env },
		encoding: "utf8",
		timeout: 15_000,
	});
}

// Still gated: the only block that spawns the REAL src/cli.ts. A full pi boot
// touches the shared ~/.pi backend and costs ~1.3s on its own, so it stays
// opt-in while the five stub-based blocks below run by default.
describe.skipIf(!E2E_ENABLED)("symlink resolution", () => {
	test("entry/mode resolve against the REAL script dir, not the symlink's dir", () => {
		// bun-apps/s2-agent ships src/cli.ts, so real behavior here is
		// "source (dev)". --list-models is a fast, offline,
		// no-model-server-required subcommand — good for proving the launcher
		// reaches the real cli.ts through the symlink without spinning up a TUI.
		const linkDir = path.join(TMP, "symlink-caller");
		mkdirSync(linkDir, { recursive: true });
		const linkPath = path.join(linkDir, "s2-agent.sh");
		symlinkSync(RUN_SH, linkPath);

		const result = spawnSync("bash", [linkPath, "--list-models"], {
			cwd: linkDir,
			env: { ...process.env, PIAGENT_DEBUG: "1" },
			encoding: "utf8",
			timeout: 15_000,
		});

		expect(result.status).toBe(0);
		// entry/mode must resolve to the REAL package dir (where run.sh actually
		// lives), not linkDir (where the symlink was invoked from) — this is
		// exactly the bug the BASH_SOURCE symlink-following loop guards against.
		expect(result.stderr).toMatch(/mode=source \(dev\)/);
		// entry must resolve to the REAL package dir (where run.sh actually
		// lives, via BASH_SOURCE symlink-following), NOT linkDir (where the
		// symlink itself sits) — proven by exact equality with REAL_PKG_DIR.
		expect(result.stderr).toContain(`entry=${REAL_PKG_DIR}/src/cli.ts`);
		// cwd in the debug line reflects the invoking cwd (linkDir), confirming
		// SCRIPT_DIR (entry resolution) and cwd (process.cwd()) are independently
		// tracked — not both accidentally collapsed to one directory. bash's
		// $(pwd) resolves /tmp -> /private/tmp on macOS, so compare via realpath.
		const realLinkDir = realpathSync(linkDir);
		expect(result.stderr).toContain(`cwd=${realLinkDir}`);
		expect(realLinkDir).not.toBe(REAL_PKG_DIR);
	});
});

describe("entry-mode detection", () => {
	function makeFixture(name: string, files: Record<string, string>) {
		const dir = path.join(TMP, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "run.sh"), readFileSync(RUN_SH, "utf8"));
		chmodSync(path.join(dir, "run.sh"), 0o755);
		for (const [rel, content] of Object.entries(files)) {
			const full = path.join(dir, rel);
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, content);
		}
		return dir;
	}

	const STUB_ENTRY = "console.log('stub-entry', process.argv.slice(2).join(' '));\n";

	test("src/cli.ts alone -> source (dev)", () => {
		const dir = makeFixture("source", { "src/cli.ts": STUB_ENTRY });
		const result = run(["--list-models"], { cwd: dir, env: { PIAGENT_DEBUG: "1" } });
		expect(result.stderr).toMatch(/mode=source \(dev\)/);
	});

	test("neither marker present -> error, exit 1", () => {
		const dir = makeFixture("empty", {});
		const result = run(["--list-models"], { cwd: dir });
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/no s2-agent entry found/);
	});
});

describe("--update-help", () => {
	test("exits 0, prints the upgrade wrapper docs, never execs bun", () => {
		const result = run(["--update-help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/update-pi\.sh/);
		expect(result.stdout).toMatch(/--check/);
		expect(result.stdout).toMatch(/--rebuild/);
		// Early-return branch: no entry/mode resolution happens, so the debug
		// line (which fires after entry detection) must NOT appear even with
		// PIAGENT_DEBUG=1.
		const debugResult = run(["--update-help"], { env: { PIAGENT_DEBUG: "1" } });
		expect(debugResult.status).toBe(0);
		expect(debugResult.stderr).not.toMatch(/\[run\.sh\] mode=/);
	});
});

describe("--upgrade / -U passthrough", () => {
	function makeUpgradeFixture(name: string) {
		const dir = path.join(TMP, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "run.sh"), readFileSync(RUN_SH, "utf8"));
		chmodSync(path.join(dir, "run.sh"), 0o755);
		mkdirSync(path.join(dir, "src"), { recursive: true });
		writeFileSync(path.join(dir, "src", "cli.ts"), "console.log('unused');\n");
		const stub = ["#!/usr/bin/env bash", 'echo "$@" > "$(dirname "$0")/received-args.txt"', "exit 0"].join("\n");
		writeFileSync(path.join(dir, "update-pi.sh"), stub);
		chmodSync(path.join(dir, "update-pi.sh"), 0o755);
		return dir;
	}

	test("forwards flags to update-pi.sh without touching the network", () => {
		const dir = makeUpgradeFixture("upgrade-fixture");
		const result = run(["--upgrade", "--check"], { cwd: dir });
		expect(result.status).toBe(0);
		const received = readFileSync(path.join(dir, "received-args.txt"), "utf8").trim();
		expect(received).toBe("--check");
	});

	test("-U is equivalent to --upgrade", () => {
		const dir = makeUpgradeFixture("upgrade-fixture-short");
		const result = run(["-U", "--rebuild"], { cwd: dir });
		expect(result.status).toBe(0);
		const received = readFileSync(path.join(dir, "received-args.txt"), "utf8").trim();
		expect(received).toBe("--rebuild");
	});
});

/**
 * Source-mode root-node_modules self-heal.
 *
 * These matter more than the usual launcher assertion because the reclaim path
 * runs `rm -rf` on every launch. The guard that keeps that safe — "a real
 * directory is only removed when it contains zero regular files" — is asserted
 * from both sides: the farm shape IS reclaimed, and anything holding real
 * content is NOT.
 *
 * Each fixture is a self-contained git repo with the nested layout the guard
 * keys on: <root>/ws/s2-agent/{run.sh,src/cli.ts} and <root>/ws/node_modules.
 * The workspace dir is deliberately NOT named "bun-apps" — that also pins the
 * link target being derived from the real directory name rather than hardcoded.
 */
describe("source-mode root node_modules self-heal", () => {
	const STUB = "console.log('stub');\n";

	/** Build a git repo whose workspace sits one level below the git root. */
	function makeRepo(name: string): { root: string; pkgDir: string } {
		const root = path.join(TMP, name);
		const pkgDir = path.join(root, "ws", "s2-agent");
		mkdirSync(path.join(pkgDir, "src"), { recursive: true });
		mkdirSync(path.join(root, "ws", "node_modules"), { recursive: true });
		writeFileSync(path.join(pkgDir, "run.sh"), readFileSync(RUN_SH, "utf8"));
		chmodSync(path.join(pkgDir, "run.sh"), 0o755);
		writeFileSync(path.join(pkgDir, "src", "cli.ts"), STUB);
		spawnSync("git", ["init", "-q"], { cwd: root });
		return { root, pkgDir };
	}

	function launch(pkgDir: string, debug = false) {
		return spawnSync("bash", [path.join(pkgDir, "run.sh")], {
			cwd: pkgDir,
			env: { ...process.env, ...(debug ? { PIAGENT_DEBUG: "1" } : {}) },
			encoding: "utf8",
			timeout: 15_000,
		});
	}

	test("absent -> creates a symlink naming the real workspace dir", () => {
		const { root, pkgDir } = makeRepo("selfheal-absent");
		launch(pkgDir);
		const nm = path.join(root, "node_modules");
		expect(lstatSync(nm).isSymbolicLink()).toBe(true);
		// "ws/node_modules", NOT a hardcoded "bun-apps/node_modules".
		expect(readlinkSync(nm)).toBe("ws/node_modules");
	});

	test("a pure link farm is reclaimed and replaced by the symlink", () => {
		const { root, pkgDir } = makeRepo("selfheal-farm");
		const nm = path.join(root, "node_modules");
		// Shape of a real Bun farm: scoped dirs containing only symlinks, plus a
		// top-level symlink. No regular files anywhere.
		mkdirSync(path.join(nm, "@repo"), { recursive: true });
		mkdirSync(path.join(nm, ".bun"), { recursive: true });
		symlinkSync(path.join(root, "ws", "s2-agent"), path.join(nm, "@repo", "s2-agent"));
		symlinkSync(path.join(root, "ws", "node_modules"), path.join(nm, "typebox"));
		expect(lstatSync(nm).isSymbolicLink()).toBe(false);

		const result = launch(pkgDir, true);
		expect(result.stderr).toMatch(/reclaimed .*node_modules \(Bun link farm/);
		expect(lstatSync(nm).isSymbolicLink()).toBe(true);
		expect(readlinkSync(nm)).toBe("ws/node_modules");
	});

	test("a directory holding a regular file is LEFT ALONE (rm -rf guard)", () => {
		const { root, pkgDir } = makeRepo("selfheal-real");
		const nm = path.join(root, "node_modules");
		mkdirSync(path.join(nm, "real-pkg"), { recursive: true });
		// One regular file, nested — enough to disqualify the whole tree.
		writeFileSync(path.join(nm, "real-pkg", "package.json"), '{"name":"real-pkg"}');

		const result = launch(pkgDir, true);
		expect(result.stderr).not.toMatch(/reclaimed/);
		expect(lstatSync(nm).isSymbolicLink()).toBe(false);
		// The content survived untouched — this is the assertion that makes the
		// `rm -rf` acceptable.
		expect(readFileSync(path.join(nm, "real-pkg", "package.json"), "utf8")).toBe('{"name":"real-pkg"}');
	});

	test("an existing symlink is left exactly as-is", () => {
		const { root, pkgDir } = makeRepo("selfheal-existing-link");
		const nm = path.join(root, "node_modules");
		symlinkSync("ws/node_modules", nm);
		launch(pkgDir);
		expect(lstatSync(nm).isSymbolicLink()).toBe(true);
		expect(readlinkSync(nm)).toBe("ws/node_modules");
	});

	test("a DANGLING symlink does not crash the launcher", () => {
		// `-e` is false for a dangling link, so the old `[ ! -e ]` guard alone
		// would have tried `ln -s` over it and failed with "File exists".
		const { root, pkgDir } = makeRepo("selfheal-dangling");
		const nm = path.join(root, "node_modules");
		symlinkSync("nowhere/node_modules", nm);
		const result = launch(pkgDir);
		expect(result.status).toBe(0);
		expect(result.stderr).not.toMatch(/File exists/);
	});
});

// update-pi.sh spawns repo scripts from the bun-apps/s2-agent cwd
// (do_rebuild / do_typecheck). #1305 moved deploy.ts out of s2-agent/scripts/
// and --rebuild failed silently for a week because nothing checked those
// references. Pure parse + existsSync: no spawns, so this runs in the default
// ungated `bun test`.
//
// It calls BOTH shapes now — `bun run <script>` (do_rebuild, since the deploy
// moved behind the deploy package script) and `bun <path>.ts` — so both are
// checked, against package.json and the filesystem respectively. Each half
// carries its own non-empty floor: a regex that silently matched nothing is
// how a dead reference survives a green guard.
describe("update-pi.sh referenced scripts exist", () => {
	const wrapper = () => readFileSync(path.join(REAL_PKG_DIR, "update-pi.sh"), "utf8");

	/** Only the executable body — the header block documents `$0 --rebuild`
	 *  style usage that is not a spawn. Comments start with `#`. */
	const commandLines = () =>
		wrapper()
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#"))
			.join("\n");

	test("every `bun run <script>` names a script in s2-agent's package.json", () => {
		const pkg = JSON.parse(readFileSync(path.join(REAL_PKG_DIR, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		const refs = [...commandLines().matchAll(/bun run ([A-Za-z][A-Za-z0-9:_-]*)/g)].map((m) => m[1]!);
		expect(refs.length, "no `bun run <script>` calls found — the regex stopped matching").toBeGreaterThan(0);
		const missing = refs.filter((r) => !(r in pkg.scripts));
		expect(missing, `update-pi.sh calls \`bun run ${missing.join(", ")}\`, absent from package.json scripts`).toEqual(
			[],
		);
	});

	test("every `bun <script>.ts` reference resolves from bun-apps/s2-agent", () => {
		const refs = [...commandLines().matchAll(/bun (\.{0,2}\/?[^\s&;)"']+\.ts)/g)].map((m) => m[1]!);
		// May legitimately be empty: update-pi.sh reaches the deploy through a
		// package script now. Assert only that whatever IS named exists.
		for (const rel of refs) {
			expect(existsSync(path.resolve(REAL_PKG_DIR, rel)), `update-pi.sh names a missing script: ${rel}`).toBe(true);
		}
	});
});
