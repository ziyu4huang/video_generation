/**
 * deploy-probe-e2e — L1: run the DEPLOYED binary and prove the extensions
 * actually work, offline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The four build gates prove the tree is well-formed; `deploy-e2e.test.ts`
 * proves `--ext-list` reports the right names in both states. Neither starts a
 * session, so neither could see that power-tool's SDK polyfill was dead in every
 * deploy for a week (it printed a warning on every run) or that playwright's
 * `__dirname` pointed at the build machine. Registration is not function.
 *
 * The technique is the one `s2-agent/src/__tests__/e2e-extensions.test.ts`
 * already uses: an import-free `export default (pi) => …` file passed with
 * `-e`, firing on `session_start`, writing a marker line to stderr and exiting
 * there — before any provider call, so the whole tier is offline and
 * deterministic. Executing a tool needs a model and lives in L2
 * (`bun-apps/s2-agent/scripts/run-sh-agent-e2e.sh`).
 *
 * Gated on PI_AGENT_E2E because it builds a deploy (~seconds, but it copies
 * ~13 MB of vendored playwright-core).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runShDeploy } from "../src/deploy/run.ts";
import { shConfig } from "../src/deploy/lib/config.ts";
import { freezeTree, rmTree, unfreezeTree } from "../src/deploy/lib/fs.ts";
import { TOOLS_ACTIVE_PROBE, TOOLS_PROBE_CORE } from "../src/tools-active-probe.ts";

const RUN = process.env.PI_AGENT_E2E === "1";
const describeE2E = RUN ? describe : describe.skip;

const outRoot = mkdtempSync(join(tmpdir(), "sh-probe-"));
/** Per-user state must never land in the operator's real ~/.pi during a test. */
const piHome = join(outRoot, "pi-home");

// Expected loaded set is DERIVED from the registry, not hardcoded:
// #1713 added hyperframes as a third configured extension and every hardcoded
// ["power-tool","task"] / count-2 assertion here went stale the moment it
// merged. The registry is the source of truth for what a deploy must load.
const BUN_APPS_DIR = join(import.meta.dir, "..", "..");

// AGENT-DIR ISOLATION (2026-08-22 fix): the binary derives its agent-dir env
// var from piConfig.name — upstream builds `${APP_NAME.toUpperCase()}_CODING
// _AGENT_DIR` — so with name "s2-agent" it reads `S2-AGENT_CODING_AGENT_DIR`
// (DASH included) and IGNORES plain `PI_CODING_AGENT_DIR`. Every spawn in
// this suite used to set only the inert PI_* name, so probe `-p hi` runs
// wrote 30 throwaway prompt-history dirs into the operator's REAL ~/.pi/agent.
// Derive the name from s2-agent's package.json (the same file the rename
// reads) so a future rename cannot silently break isolation again.
const S2_AGENT_NAME = (
	JSON.parse(readFileSync(join(BUN_APPS_DIR, "s2-agent", "package.json"), "utf8")) as {
		piConfig: { name: string };
	}
).piConfig.name;
const agentDirEnv: Record<string, string> = {
	PI_CODING_AGENT_DIR: piHome,
	[`${S2_AGENT_NAME.toUpperCase()}_CODING_AGENT_DIR`]: piHome,
	// CI boots the deployed binary with the DEEPSEEK provider: the baked
	// default (zai/glm-5.3, BUILTIN_MODEL_DEFAULT) sits on the operator's
	// coding-plan quota, and a provider-init failure there (zai answers 401
	// code:1000 "Authentication Failed" when the plan runs out) would turn the
	// stderr-clean assertion below red for an operator-account reason, not an
	// extension defect. Precedence (src/cli/sessions/shared.ts resolveLLM):
	// explicit flag > PI_PROVIDER/PI_MODEL/PI_THINKING env > settings.json >
	// BUILTIN_MODEL_DEFAULT. PI_MODEL alone is NOT enough — the env value is
	// the model id, provider comes from PI_PROVIDER.
	PI_PROVIDER: "deepseek",
	PI_MODEL: "deepseek-v4-flash-vision-exp",
	PI_THINKING: "off",
};

let target = "";
let binary = "";

const configuredNames = shConfig({ bunAppsDir: BUN_APPS_DIR }).extensions.map((e) => e.name).sort();

// ZERO-Real-~/.pi-pollution guard (2026-08-22): the suite's whole point is
// that per-user writes land under piHome. Snapshot the operator's REAL
// prompt-history dir before the run; afterAll fails the suite if the probe
// created so much as one directory there — the exact defect that accumulated
// 30 junk dirs before the agentDirEnv fix.
const realHistoryRoot = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"prompt-history",
);
const realHistoryBefore: string[] = existsSync(realHistoryRoot)
	? readdirSync(realHistoryRoot).sort()
	: [];

afterAll(() => {
	const after = existsSync(realHistoryRoot) ? readdirSync(realHistoryRoot).sort() : [];
	const added = after.filter((d) => !realHistoryBefore.includes(d));
	// Only NEW dirs are a defect: a concurrent real session may legitimately
	// add one while this suite runs.
	expect(
		added,
		`probe leaked per-user writes into the REAL ${realHistoryRoot} — agent-dir isolation broken`,
	).toEqual([]);
	rmTree(outRoot);
});

interface Run {
	stdout: string;
	stderr: string;
	code: number | null;
}

/**
 * Spawn the deployed binary with a hard timeout. A probe that never fires must
 * fail the assertion, not hang the suite — the timeout is the difference
 * between a red test and a wedged CI run.
 */
async function run(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
	const proc = Bun.spawn([process.execPath, binary, ...argv], {
		cwd: opts.cwd ?? target,
		env: { ...process.env, ...agentDirEnv, ...opts.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => {
		try {
			proc.kill(9);
		} catch {
			/* already exited */
		}
	}, 60_000);
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { stdout, stderr, code: await proc.exited };
	} finally {
		clearTimeout(timer);
	}
}

/** Write a probe next to the deploy and run the binary against it. */
async function probe(name: string, source: string, argv: string[] = []): Promise<Run> {
	const path = join(outRoot, `${name}.ts`);
	writeFileSync(path, source);
	return run(["-e", path, "-p", "hi", ...argv]);
}

/** Every regular file under `dir`, sorted — the frozen-tree write detector. */
function filesIn(dir: string): string[] {
	const r = Bun.spawnSync(["find", dir, "-type", "f"]);
	return r.stdout.toString().trim().split("\n").filter(Boolean).sort();
}

/** The single JSON payload a probe writes, keyed by its marker. */
function payload(r: Run, marker: string): Record<string, unknown> {
	const line = r.stderr.split("\n").find((l) => l.startsWith(marker));
	if (!line) throw new Error(`probe never wrote ${marker}. stderr:\n${r.stderr.slice(0, 2000)}`);
	return JSON.parse(line.slice(marker.length));
}

describeE2E("s2-agent-sh L1 — the deployed binary really runs its extensions", () => {
	beforeAll(async () => {
		const r = await runShDeploy({ outRoot, force: true });
		target = r.target;
		// bun-run bundle: booted through this test process own bun (ticket 02 ships bin/bun).
		binary = join(target, "s2-agent.js");
	}, 300_000);

	test("every expected tool and command is registered, and comes from a deployed extension", async () => {
		const r = await probe(
			"probe-registration",
			`export default (pi) => {
  pi.on("session_start", () => {
    const tools = pi.getAllTools().map((t) => ({ name: t.name, path: String(t.sourceInfo?.path ?? "") }));
    const cmds = pi.getCommands().map((c) => ({ name: c.name, path: String(c.sourceInfo?.path ?? "") }));
    process.stderr.write("[REG]" + JSON.stringify({ tools, cmds }) + "\\n");
    process.exit(0);
  });
};
`,
		);
		const p = payload(r, "[REG]") as { tools: { name: string; path: string }[]; cmds: { name: string; path: string }[] };
		const toolPath = new Map(p.tools.map((t) => [t.name, t.path]));
		const cmdPath = new Map(p.cmds.map((c) => [c.name, c.path]));

		// power-tool's diagnostic surface + task's tools. Names, not counts: a
		// count assertion goes green when one extension gains a tool and another
		// silently stops loading.
		for (const t of ["inspect_tui", "inspect_extensions", "inspect_context", "inspect_hooks", "browser", "webui"]) {
			expect(toolPath.get(t), `tool ${t} missing`).toBe("<inline:power-tool>");
		}
		for (const t of ["todo", "ask_user_question"]) {
			expect(toolPath.get(t), `tool ${t} missing`).toBe("<inline:task>");
		}
		// Commands are the ONLY load proof for a command-bearing extension: an
		// extension can register commands and zero tools.
		for (const c of ["goal", "todos", "response-language"]) {
			expect(cmdPath.get(c), `command /${c} missing`).toBe("<inline:task>");
		}

		// `<inline:` is what pi labels a factory handed to main({extensionFactories}),
		// which is how sh delivers extensions it loaded off disk. It does NOT prove
		// the code came from ext/ — the dual-state gate in deploy-e2e does that
		// by deleting ext/ and watching the count go to zero. Recorded so the
		// marker is not mistaken for a provenance proof it cannot give.
		expect(r.code).toBe(0);
	}, 120_000);

	test("every configured skill reaches the system prompt", async () => {
		const r = await probe(
			"probe-skills",
			`export default (pi) => {
  pi.on("before_agent_start", (event) => {
    const skills = (event && event.systemPromptOptions && event.systemPromptOptions.skills) || [];
    process.stderr.write("[SKILLS]" + JSON.stringify(skills.map((s) => String((s && s.name) || (s && s.filePath) || ""))) + "\\n");
    process.exit(0);
  });
};
`,
		);
		const names = payload(r, "[SKILLS]") as unknown as string[];
		// The full-profile deploy ships skills from their owning extensions:
		// btw -> ext-btw, playwright-cli stays with power-tool (the #1724
		// re-homing), plus the superpowers / wayfind / hermes-memory families.
		// web-access + webui went deploy-excluded 2026-08-24, so webui-audit
		// (the webui ext's skill) no longer reaches the deployed prompt.
		// Spot-check one known skill per owner rather than pinning counts —
		// the #1713 lesson: hardcoded totals go stale the moment a family grows.
		const expected = ["btw", "playwright-cli", "using-superpowers", "devops-workflow"];
		expect(names.length, `skills: ${names.join(" ")}`).toBeGreaterThan(0);
		for (const skill of expected) {
			expect(names, `skill '${skill}' must reach the system prompt`).toContain(skill);
		}
	}, 120_000);

	test("cross-extension state is shared — power-tool's consumer sees task's seams", async () => {
		// The strongest offline signal available. task publishes its widget and
		// goal/plan seams on globalThis; power-tool's inspect_tui reads them from a
		// DIFFERENT ext.cjs. If the two bundles did not share one runtime — or if
		// either inlined its own copy — the seams would be absent here while
		// --ext-list still reported both extensions loaded.
		const r = await probe(
			"probe-seams",
			`export default (pi) => {
  pi.on("session_start", () => {
    const g = globalThis;
    process.stderr.write("[SEAMS]" + JSON.stringify({
      widget: typeof (g.__piCoreTaskStatusWidget && g.__piCoreTaskStatusWidget.inspect),
      goalActive: typeof g.__piGoalActive,
      planPhases: typeof g.__piPlanPhases,
    }) + "\\n");
    process.exit(0);
  });
};
`,
		);
		// __piPlanIncomplete/__piPlanSummary were removed in #1765 (W5 ticket 05);
		// __piPlanPhases stays (alive, /wayfind sync).
		expect(payload(r, "[SEAMS]")).toEqual({
			widget: "function",
			goalActive: "function",
			planPhases: "function",
		});
	}, 120_000);

	test("the ACTIVE toolset keeps the core builtins at request time (the #1946 regression)", async () => {
		// 2026-08-24, PR #1946: two deploys shipped with setActiveTools([]) —
		// read/write/edit/bash gone from the provider request while --ext-list
		// (registration) and even the model call stayed green. The probe reads
		// pi.getActiveTools() at before_agent_start (deferred 250ms so every
		// later-loaded handler — tool-gate is order 190 — has run); see
		// src/tools-active-probe.ts for why an earlier read is a false green.
		const r = await probe("probe-active-tools", TOOLS_ACTIVE_PROBE);
		const p = payload(r, "[TOOLS]") as {
			total: number;
			activeCount: number;
			active: string[];
			missing: string[];
			gateSeam: { activeCount: number; totalCount: number; coreCount: number } | null;
			getActiveTools: boolean;
			getError?: string;
		};
		expect(r.code).toBe(0);
		expect(p.getError).toBeUndefined();
		expect(p.getActiveTools).toBe(true);
		expect(p.activeCount, `active toolset empty (0/${p.total}) — the #1946 wipe class`).toBeGreaterThan(0);
		expect(p.missing, `core builtins missing from the active set: ${p.missing.join(", ")}`).toEqual([]);
		for (const name of TOOLS_PROBE_CORE) {
			expect(p.active, `core builtin '${name}' not in the active set`).toContain(name);
		}
		if (configuredNames.includes("tool-gate")) {
			// tool-gate's own post-gate self-report — the seam the fix reads.
			expect(p.gateSeam, "__piToolGateStatus seam absent with tool-gate loaded").not.toBeNull();
			expect(p.gateSeam?.coreCount).toBeGreaterThanOrEqual(TOOLS_PROBE_CORE.length);
		}
	}, 120_000);

	test("booting prints nothing on stderr", async () => {
		// D1 was visible on every single invocation for a week and nobody noticed,
		// because no gate ever looked at stderr. This is that gate.
		const r = await run(["--ext-list"]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout).skipped).toEqual([]);
	}, 60_000);

	test("s2-agent.sh is executed, not merely present", async () => {
		// It sets `set -euo pipefail`, resolves its own symlink, and exports the
		// per-user state dir before exec. Asserting existsSync proves none of that.
		const proc = Bun.spawn(["bash", join(target, "s2-agent.sh"), "--ext-list"], {
			cwd: target,
			env: { ...process.env, ...agentDirEnv },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(await proc.exited).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout).loaded.sort()).toEqual(configuredNames);
	}, 60_000);

	test("boots from an unrelated cwd with a foreign HOME", async () => {
		// The deploy tree carries no repo path; nothing about the build machine's
		// layout may be required to start it.
		const foreignHome = mkdtempSync(join(tmpdir(), "sh-home-"));
		const r = await run(["--ext-list"], { cwd: "/", env: { HOME: foreignHome } });
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout).loadedCount).toBe(configuredNames.length);
		rmTree(foreignHome);
	}, 60_000);

	test("doctor runs, reports sh mode, and its smoke check passes", async () => {
		const r = await run(["doctor", "--smoke", "--json"]);
		expect(r.code).toBe(0);
		const report = JSON.parse(r.stdout) as {
			mode: string;
			ok: boolean;
			checks: { id: string; status: string; detail?: string }[];
		};
		expect(report.mode).toBe("sh");
		expect(report.ok).toBe(true);
		const smoke = report.checks.find((c) => c.id === "runtime-smoke");
		// matched > 0 is the point: it counts tools the DEPLOYED extensions
		// registered, so a smoke check that spawned but loaded nothing is red.
		expect(smoke?.status).toBe("pass");
		expect(smoke?.detail).toMatch(/matched=[1-9]/);
	}, 180_000);

	test("a REAL session start is clean — no extension complains, nothing writes to the tree", async () => {
		// The gate that was missing. "booting prints nothing on stderr" above runs
		// `--ext-list`, which never fires session_start, so every defect that only
		// shows once extensions actually START was invisible to CI. Two were live
		// when this test was written:
		//
		//   - obsidian probed for `node_modules/@earendil-works/pi-coding-agent`
		//     above its own dir and, finding none in a deploy, printed a red
		//     "missing npm packages" error on every single start (#1738 put it in
		//     the base set; the packages were served by the host all along).
		//   - hermes-memory treated the deploy tree as a project when cwd was
		//     inside it and tried to mkdir `.agents/` into the FROZEN tree.
		//
		// cwd is the deploy tree ON PURPOSE: that is the harshest placement, and
		// the one that proves the read-only invariant under a real session rather
		// than under `doctor --smoke`.
		const before = filesIn(target);
		const r = await probe(
			"probe-session-start",
			`export default (pi) => {
  pi.on("session_start", () => {
    // Give every other extension's handler a turn before deciding it was clean:
    // an immediate exit would race past the very diagnostics under test.
    setTimeout(() => { process.stderr.write("[SESSION-OK]\\n"); process.exit(0); }, 3000);
  });
};
`,
		);
		expect(r.stderr, "the probe never reached session_start").toContain("[SESSION-OK]");
		const noise = r.stderr
			.split("\n")
			.filter((l) => l.trim() !== "" && l !== "[SESSION-OK]");
		expect(noise, `a real session start wrote to stderr:\n${noise.join("\n")}`).toEqual([]);
		expect(filesIn(target), "a session start added files to the frozen tree").toEqual(before);
	}, 180_000);

	test("`cli` and `ext doctor` refuse with a reason instead of an arg error", async () => {
		for (const [argv, needle] of [
			[["cli", "tools-metrics"], "cli"],
			[["ext", "doctor"], "ext doctor"],
		] as const) {
			const r = await run([...argv]);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain(`\`${needle}\` is not part of an sh deploy`);
			expect(r.stderr).not.toContain("Unknown options");
		}
	}, 60_000);

	test("no bundle carries a path from the build machine", async () => {
		// The static half of gate 4, asserted against what actually shipped rather
		// than against the string the build happened to scan. Every configured
		// extension — the set derives from the registry, so a new entry is
		// covered automatically (the #1713 lesson: hardcoded names go stale).
		const home = process.env.HOME ?? "";
		for (const name of configuredNames) {
			const code = readFileSync(join(target, "ext", name, "ext.cjs"), "utf8");
			const hits = [...code.matchAll(/["'`](\/[^"'`\n]{4,}?)["'`]/g)]
				.map((m) => m[1] as string)
				.filter((p) => p.startsWith(`${home}/`) && !p.startsWith(join(home, ".pi")) && !p.startsWith(target));
			expect(hits, `${name}/ext.cjs bakes in ${hits.slice(0, 3).join(", ")}`).toEqual([]);
		}
	}, 30_000);

	test("the vendored dependency ships as a real directory and is required, not imported", async () => {
		const vendored = join(target, "ext", "power-tool", "node_modules", "playwright-core");
		expect(existsSync(join(vendored, "package.json"))).toBe(true);
		const code = readFileSync(join(target, "ext", "power-tool", "ext.cjs"), "utf8");
		// A live `import("playwright-core")` is not routed through the loader's
		// require and resolves against the compiled binary's virtual root:
		// `Cannot find package 'playwright-core' from '/$bunfs/root/s2-agent'`.
		expect(code).not.toContain('import("playwright-core")');
		expect(code).toContain('require("playwright-core")');
	}, 30_000);

	// web-access went deploy-excluded 2026-08-24 — its unpdf-vendoring test
	// ("import.meta.resolve cannot live in a cjs bundle") left with it. The
	// vendor mechanics it locked are still covered by power-tool's
	// playwright-core test above; re-add a web-access variant if it ships again.

	// Ported from the deleted src/__tests__/e2e-readonly.test.ts, which asserted
	// this for the bundle and snapshot modes. The contract is not mode-specific:
	// a deploy is an IMMUTABLE artifact and every per-user write belongs under
	// PI_CODING_AGENT_DIR. What would break it — a patch that caches into the
	// deploy dir, the launcher losing its JITI_FS_CACHE=0 export, an extension
	// resolving a writable path relative to its own dir — is exactly what the
	// sh pipeline's ext-local resolution makes newly possible, so the assertion
	// belongs here now rather than nowhere.
	//
	// MUST stay ahead of the ext/-removal test below, which deliberately
	// unfreezes and renames inside the tree.
	test("the frozen tree takes zero writes while the binary runs", async () => {
		const before = filesIn(target);
		expect(before.length).toBeGreaterThan(0);

		// doctor --smoke is the heaviest read-only path the deploy has: it boots
		// pi, loads every deployed extension, and counts registered tools.
		const r = await run(["doctor", "--json", "--smoke"]);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toMatch(/EACCES|EPERM/);

		const after = filesIn(target);
		expect(after).toEqual(before);
	}, 120_000);

	// ── Offline dist: zero network, zero install ────────────────────────────────
	// Gate 5 makes the tree offline-CONTAINED at build time; these tests prove
	// the runtime half — the binary actually boots and starts a session with
	// ALL networking denied at the syscall level, and the one runtime-install
	// path that existed (hyperframes' package-loader npm bootstrap) is gone.
	const DENY_NETWORK_SBPL = "(version 1)(allow default)(deny network*)";

	test("boots and starts a session with ALL networking denied (sandbox-exec)", async () => {
		// Pre-flight: prove sandbox-exec exists and the profile PARSES before
		// trusting a green boot to mean "no network needed" — a silently broken
		// wrapper would turn this test into a plain boot test.
		expect(process.platform, "sandbox-exec is macOS-only").toBe("darwin");
		const pf = Bun.spawnSync(["sandbox-exec", "-p", DENY_NETWORK_SBPL, "/usr/bin/true"]);
		expect(pf.exitCode, "sandbox-exec pre-flight failed (missing or profile rejected)").toBe(0);

		// s2-agent.sh --ext-list: every extension loads with networking denied.
		const boot = Bun.spawn(["sandbox-exec", "-p", DENY_NETWORK_SBPL, "bash", join(target, "s2-agent.sh"), "--ext-list"], {
			cwd: target,
			env: { ...process.env, ...agentDirEnv },
			stdout: "pipe",
			stderr: "pipe",
		});
		const bootTimer = setTimeout(() => boot.kill(9), 60_000);
		let bootOut = "";
		let bootErr = "";
		try {
			[bootOut, bootErr] = await Promise.all([
				new Response(boot.stdout).text(),
				new Response(boot.stderr).text(),
			]);
		} finally {
			clearTimeout(bootTimer);
		}
		expect(await boot.exited).toBe(0);
		expect(bootErr).toBe("");
		expect(JSON.parse(bootOut).loadedCount).toBe(configuredNames.length);

		// A real session_start under the same denial — booting is weaker than
		// actually starting every extension's session handlers.
		const probePath = join(outRoot, "probe-sandbox-session.ts");
		writeFileSync(
			probePath,
			`export default (pi) => {\n  pi.on("session_start", () => {\n    setTimeout(() => { process.stderr.write("[SESSION-OK]\\n"); process.exit(0); }, 3000);\n  });\n};\n`,
		);
		const session = Bun.spawn(
			["sandbox-exec", "-p", DENY_NETWORK_SBPL, binary, "-e", probePath, "-p", "hi"],
			{
				cwd: target,
				env: { ...process.env, ...agentDirEnv },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const sessionTimer = setTimeout(() => session.kill(9), 60_000);
		let sessionErr = "";
		try {
			await new Response(session.stdout).text();
			sessionErr = await new Response(session.stderr).text();
		} finally {
			clearTimeout(sessionTimer);
		}
		expect(sessionErr, "sandboxed session start never fired").toContain("[SESSION-OK]");
	}, 180_000);

	// REMOVED 2026-08-24: "hyperframes skill helpers resolve from the vendored
	// closure — no npm bootstrap can run" asserted the DEPLOYED hyperframes
	// skill loaders were fail-fast patched and resolved @hyperframes/* + sharp
	// from ext/hyperframes/node_modules. hyperframes is disabled by default
	// (registry entry commented out, pending a proven must-have consumer), so
	// there is no deployed copy to probe. The fail-fast loader PATCH itself
	// (patchOfflinePackageLoadersUnder) still runs for every shipped skills/
	// and copy dir; if hyperframes ships again, restore this test with it.

	test("the core still boots after ext/ is removed entirely", async () => {
		// deploy-e2e asserts this against a frozen tree at deploy time; asserted
		// here too because every OTHER test in this file would still pass if the
		// core had quietly grown a dependency on its extensions.
		const parked = join(target, "ext-parked");
		// The deploy is chmod a-w; unfreeze just long enough to move the directory.
		unfreezeTree(target);
		renameSync(join(target, "ext"), parked);
		try {
			const r = await run(["--ext-list"]);
			expect(r.code).toBe(0);
			expect(JSON.parse(r.stdout).loadedCount).toBe(0);
			expect(r.stderr).toBe("");
		} finally {
			renameSync(parked, join(target, "ext"));
			freezeTree(target);
		}
	}, 60_000);
});
