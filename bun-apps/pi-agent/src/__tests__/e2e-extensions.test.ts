/**
 * e2e-extensions — pi-agent extension loading across source AND deployed-package
 * layouts, from multiple cwds. (Formerly scripts/verify.ts — folded into bun:test
 * so `bun test` is the single entry point, and so it gates behind PI_AGENT_E2E
 * like the other bundle e2e. Run via `./bun-apps/pi-agent/run-test.sh` or
 * `PI_AGENT_E2E=1 bun test`, or directly `bun run verify`.)
 *
 * WHY THIS EXISTS
 *   run-dir/resolve.ts has three modes (source / repo-bundle / deploy-package)
 *   and cwd-coupled bugs that are INVISIBLE when you only test from inside the
 *   artifact or trust the model's `-p` reply. This codifies the method that
 *   catches them: build + deploy a fresh package, run a probe extension
 *   (pi.getAllTools()) across SOURCE (repo + /tmp) and DEPLOY (foreign cwd +
 *   repo), assert ZERO conflict/cannot-find/failed-to-load and matched>0, and
 *   kill the process the instant the probe fires (no model call — fast/offline).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	E2E_ENABLED,
	DEPLOY_ENABLED,
	PI_AGENT_DIR,
	REPO_ROOT,
	SRC_CLI,
	ensureBundle,
} from "./e2e-harness.ts";

// probe: counts tools AND commands whose source path includes $PI_VERIFY_MARKER,
// then writes a [PROBE] line the runner reads. We kill the process the instant it
// fires — no model call, fully offline.
//
// `cmdMatched` covers extensions that register slash commands but NO tools
// (e.g. pi-planning-with-files — 5 /plan-* commands, 0 registerTool calls).
// The tool-only `matched` count alone would never see such an extension, so the
// command count is the load proof for command-only extensions. Commands register
// synchronously in the factory (load time), so they are available at session_start.
const PROBE_TS = `
export default (pi) => {
  pi.on("session_start", () => {
    const tools = pi.getAllTools();
    const marker = process.env.PI_VERIFY_MARKER ?? "";
    let matched = 0;
    for (const t of tools) {
      if (marker && String(t.sourceInfo?.path ?? "").includes(marker)) matched++;
    }
    const cmds = pi.getCommands();
    let cmdMatched = 0;
    for (const c of cmds) {
      if (marker && String(c.sourceInfo?.path ?? "").includes(marker)) cmdMatched++;
    }
    process.stderr.write("[PROBE] total=" + tools.length + " matched=" + matched + " cmdMatched=" + cmdMatched + "\\n");
  });
};
`;

// Skill-load probe: fires on before_agent_start (the ONLY event that carries
// the assembled systemPromptOptions with loaded skills — session_start's ctx
// does not expose getSystemPromptOptions). Asserts a manifest-declared skill
// (pi-planning-with-files) actually loaded end-to-end, closing the gap the
// extension-conversion goal left open (it proved extension injection, not skill
// loading). The skill's filePath/baseDir includes "planning-with-files" in every
// layout (source bun-apps/..., deploy-bundle skills/pi-planning-with-files-...,
// deploy-package packages/pi-planning-with-files/...), so a substring check is
// layout-agnostic. Kills on [PROBE-SKILL] — still before the provider call, so
// offline.
const PROBE_TS_SKILL = `
export default (pi) => {
  pi.on("before_agent_start", (event) => {
    const skills = (event && event.systemPromptOptions && event.systemPromptOptions.skills) || [];
    let skillMatched = 0;
    for (const s of skills) {
      const loc = String((s && s.filePath) || "") + " " + String((s && s.baseDir) || "");
      if (loc.includes("planning-with-files")) skillMatched++;
    }
    process.stderr.write("[PROBE-SKILL] skillMatched=" + skillMatched + " totalSkills=" + skills.length + "\\n");
  });
};
`;

// Regression probe for the extension-load bug under Bun. Root cause: when an
// extension's bare specifiers (@earendil-works/*, typebox) are NOT on the
// node_modules walk-up path, pi's jiti loader falls back from `try-native` to
// transforming the graph, and under Bun + jiti 2.7.0 any transformed module
// >~4 KB fails (NameTooLong data URL, OR — with JITI_ESM_EVAL_TEMP_FILE — a
// temp file that can't be resolved: `Cannot find module .../jiti-esm/* from ''`).
// The real fix is src/patches/ensure-extension-deps.ts: repo-root node_modules
// symlinks make try-native SUCCEED, so jiti never transforms and there is no
// size limit. This single >4 KB probe guards the size path; the FULL graph
// (bare specs + multi-module + >4 KB binary.ts) is covered by
// scripts/verify-extensions.ts, which is the authoritative regression check.
const PROBE_TS_LARGE = "// " + "x".repeat(5000) + "\n" + `
export default (pi) => {
  pi.on("session_start", () => {
    const tools = pi.getAllTools();
    const marker = process.env.PI_VERIFY_MARKER ?? "";
    let matched = 0;
    for (const t of tools) {
      if (marker && String(t.sourceInfo?.path ?? "").includes(marker)) matched++;
    }
    const cmds = pi.getCommands();
    let cmdMatched = 0;
    for (const c of cmds) {
      if (marker && String(c.sourceInfo?.path ?? "").includes(marker)) cmdMatched++;
    }
    process.stderr.write("[PROBE] total=" + tools.length + " matched=" + matched + " cmdMatched=" + cmdMatched + "\\n");
  });
};
`;

interface Scenario {
	name: string;
	cmd: string[];
	cwd: string;
	marker: string;
}
interface Result {
	total: number | null;
	matched: number | null;
	cmdMatched: number | null;
	skillMatched: number | null;
	totalSkills: number | null;
	errors: string[];
}

async function runScenario(s: Scenario): Promise<Result> {
	const errors: string[] = [];
	let total: number | null = null;
	let matched: number | null = null;
	let cmdMatched: number | null = null;
	let skillMatched: number | null = null;
	let totalSkills: number | null = null;
	const proc = Bun.spawn(s.cmd, {
		cwd: s.cwd,
		env: { ...process.env, PI_VERIFY_MARKER: s.marker },
		stderr: "pipe",
		stdout: "pipe",
	});
	const reader = proc.stderr.getReader();
	const dec = new TextDecoder();
	let buf = "";
	// Hard-fail signatures: a real extension load crash / dep resolution failure /
	// tool-name conflict. NOTE: "failed to load locales … falling back" (rpiv's
	// benign i18n fallback) is deliberately NOT matched — it's not an extension
	// load failure. Match "failed to load extension" specifically.
	const ERR = /conflict|cannot find|failed to load extension/i;
	let killed = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const m = line.match(/\[PROBE\] total=(\d+) matched=(\d+) cmdMatched=(\d+)/);
				if (m) {
					total = +m[1];
					matched = +m[2];
					cmdMatched = +m[3];
					try {
						proc.kill();
					} catch {
						/* */
					}
					killed = true;
				} else {
					const sm = line.match(/\[PROBE-SKILL\] skillMatched=(\d+) totalSkills=(\d+)/);
					if (sm) {
						skillMatched = +sm[1];
						totalSkills = +sm[2];
						try {
							proc.kill();
						} catch {
							/* */
						}
						killed = true;
					} else if (ERR.test(line)) {
						errors.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
					}
				}
			}
			if (killed) break;
		}
	} finally {
		try {
			proc.kill();
		} catch {
			/* */
		}
	}
	return { total, matched, cmdMatched, skillMatched, totalSkills, errors };
}

// Shared assertions for one scenario's Result (tool/command probe on
// session_start). Asserts ZERO load errors, the probe extension loaded
// (matched > 0 — tool-bearing extensions), AND command-bearing extensions
// registered (cmdMatched > 0 — covers pi-planning-with-files, which registers
// 5 /plan-* commands but 0 tools).
function assertCleanLoad(r: Result) {
	// ZERO conflict/cannot-find/failed-to-load.
	expect(r.errors).toEqual([]);
	// The probe extension itself was loaded (matched > 0).
	expect(r.matched).not.toBeNull();
	expect(r.matched as number).toBeGreaterThan(0);
	expect(r.total).not.toBeNull();
	// Built-in tool floor (7) plus the matched extension's tools.
	expect(r.total as number).toBeGreaterThanOrEqual(7 + (r.matched as number));
	// Command-bearing extensions registered (cmdMatched > 0). PwF has no tools
	// but 5 commands — without this, a command-only extension could silently
	// fail to load and the tool probe would never notice.
	expect(r.cmdMatched).not.toBeNull();
	expect(r.cmdMatched as number).toBeGreaterThan(0);
}

// Shared assertion for a skill-load scenario's Result (skill probe on
// before_agent_start). Asserts the PwF skill is in systemPromptOptions.skills.
function assertSkillLoaded(r: Result) {
	expect(r.errors).toEqual([]);
	expect(r.skillMatched).not.toBeNull();
	expect(r.skillMatched as number).toBeGreaterThan(0);
	expect(r.totalSkills).not.toBeNull();
	expect(r.totalSkills as number).toBeGreaterThanOrEqual(1);
}

// Run `doctor --json` against an entry (deployed pi-agent.js or SRC_CLI), parse
// the report. Asserts doctor is wired into the bundle (inlined) + runs offline.
// doctor --json pretty-prints (multi-line), so extract the outermost {...}
// rather than assuming one-line JSON.
async function runDoctor(entry: string, cwd: string): Promise<{ mode: string; ok: boolean }> {
	const proc = Bun.spawn(["bun", entry, "doctor", "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`doctor exited ${code}: ${stderr.slice(0, 200)}`);
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`doctor emitted no JSON object: ${stdout.slice(0, 200)}`);
	const report = JSON.parse(stdout.slice(start, end + 1));
	return { mode: report.mode, ok: report.ok };
}

// Run `doctor --smoke --json`: spawns the runtime probe against the entry and
// asserts it reports the run-dir extensions actually loaded (matched > 0). This
// is the safety net for the silent-no-op class (e.g. #182 slice bug) — exercised
// here across every deploy mode so the smokeMarker logic (ext-bundles / packages
// / bun-apps) is verified in CI, not just for source.
async function runDoctorSmoke(entry: string, cwd: string): Promise<{ mode: string; ok: boolean; matched: number }> {
	const proc = Bun.spawn(["bun", entry, "doctor", "--smoke", "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`doctor --smoke exited ${code}: ${stderr.slice(0, 200)}`);
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`doctor --smoke emitted no JSON: ${stdout.slice(0, 200)}`);
	const report = JSON.parse(stdout.slice(start, end + 1));
	const smoke = report.checks.find((c: { id: string }) => c.id === "runtime-smoke");
	const matched = Number(smoke?.detail?.match(/matched=(\d+)/)?.[1] ?? -1);
	return { mode: report.mode, ok: report.ok, matched };
}

// Deploy once into a temp dir via `deploy.ts <flags>`, write the probe, return
// { pkgDir, pkgPiAgent, probePath }. Cleans up on failure.
async function deployPkg(extraFlags: string[]): Promise<{
	pkgDir: string;
	pkgPiAgent: string;
	probePath: string;
}> {
	await ensureBundle(); // bundle is a prerequisite of deploy.ts
	const pkgDir = mkdtempSync(join(tmpdir(), "pi-agent-verify-"));
	// --writable: this harness exercises FUNCTIONALITY (load + probe + cleanup),
	// not the read-only freeze. deploy.ts freezes by default; opting out here
	// keeps rmSync cleanup working. The freeze is covered by e2e-readonly.test.ts.
	const deploy = Bun.spawn(
		["bun", "scripts/deploy.ts", pkgDir, "--no-build", "--writable", ...extraFlags],
		{ cwd: PI_AGENT_DIR, stdout: "inherit", stderr: "inherit" },
	);
	const code = await deploy.exited;
	if (code !== 0) {
		rmSync(pkgDir, { recursive: true, force: true });
		throw new Error(`deploy.ts ${extraFlags.join(" ")} exited ${code}`);
	}
	const pkgPiAgent = join(pkgDir, "pi-agent.js");
	if (!existsSync(pkgPiAgent)) {
		throw new Error(`deployed package missing pi-agent.js at ${pkgPiAgent}`);
	}
	const probePath = join(pkgDir, ".verify-probe.ts");
	writeFileSync(probePath, PROBE_TS);
	return { pkgDir, pkgPiAgent, probePath };
}

// SOURCE mode is identical for both deploy modes — cover it once here.
// Also covers the skill-load assertion (PROBE_TS_SKILL on before_agent_start)
// for SOURCE — proving the manifest's `skills` entry loads the PwF SKILL.md
// end-to-end, not just the extension injection.
describe.skipIf(!E2E_ENABLED || !DEPLOY_ENABLED)("e2e: SOURCE extension loading (reference)", () => {
	let probePath = "";
	let skillProbePath = "";
	beforeAll(() => {
		probePath = join(tmpdir(), `pi-source-probe-${process.pid}.ts`);
		writeFileSync(probePath, PROBE_TS);
		skillProbePath = join(tmpdir(), `pi-source-skill-probe-${process.pid}.ts`);
		writeFileSync(skillProbePath, PROBE_TS_SKILL);
	});
	afterAll(() => {
		if (existsSync(probePath)) rmSync(probePath, { force: true });
		if (existsSync(skillProbePath)) rmSync(skillProbePath, { force: true });
	});
	for (const cwd of [REPO_ROOT, tmpdir()]) {
		test(`SOURCE from ${cwd === REPO_ROOT ? "repo" : "/tmp"}`, async () => {
			const r = await runScenario({
				name: "source",
				cmd: ["bun", SRC_CLI, "-e", probePath, "-p", "hi"],
				cwd,
				marker: join(REPO_ROOT, "bun-apps"),
			});
			assertCleanLoad(r);
		});
	}
	test("SOURCE doctor reports mode=source + ok", async () => {
		const r = await runDoctor(SRC_CLI, REPO_ROOT);
		expect(r.mode).toBe("source");
		expect(r.ok).toBe(true);
	});
	test("SOURCE doctor --smoke spawns the probe + verifies run-dir extensions load", async () => {
		// The static doctor checks can't catch the #182 slice-bug class (every
		// static check green while run-dir extensions silently fail to load).
		// --smoke spawns a real probe; assert ok + matched>0 (it counted run-dir
		// tools, not just builtins).
		const r = await runDoctorSmoke(SRC_CLI, REPO_ROOT);
		expect(r.ok).toBe(true);
		expect(r.matched).toBeGreaterThan(0);
	}, 60_000); // spawns a real session_start (offline, but needs headroom)
	test("SOURCE skill-load: pi-planning-with-files SKILL.md is in systemPromptOptions.skills", async () => {
		// Closes the gap the extension-conversion goal left open: it proved the
		// EXTENSION injects, not that the declared SKILL loads. before_agent_start
		// is the only event carrying the assembled systemPromptOptions.skills.
		const r = await runScenario({
			name: "source-skill",
			cmd: ["bun", SRC_CLI, "-e", skillProbePath, "-p", "hi"],
			cwd: REPO_ROOT,
			marker: join(REPO_ROOT, "bun-apps"),
		});
		assertSkillLoaded(r);
	}, 60_000);
});

// Regression for the extension-load size bug. Source-mode only — independent
// of deploy, so gated on E2E_ENABLED alone (no deploy build required).
describe.skipIf(!E2E_ENABLED)("e2e: SOURCE loads a >4 KB extension module", () => {
	let largeProbePath = "";
	beforeAll(() => {
		largeProbePath = join(tmpdir(), `pi-source-probe-large-${process.pid}.ts`);
		writeFileSync(largeProbePath, PROBE_TS_LARGE);
	});
	afterAll(() => {
		if (existsSync(largeProbePath)) rmSync(largeProbePath, { force: true });
	});
	test("a >4 KB module loads (ensure-extension-deps patch → native load)", async () => {
		const r = await runScenario({
			name: "source-large",
			cmd: ["bun", SRC_CLI, "-e", largeProbePath, "-p", "hi"],
			cwd: REPO_ROOT,
			marker: join(REPO_ROOT, "bun-apps"),
		});
		assertCleanLoad(r);
	});
});

// DEPLOY-PACKAGE mode = `deploy.ts --release` (copies every ext source folder).
describe.skipIf(!E2E_ENABLED || !DEPLOY_ENABLED)("e2e: DEPLOY-PACKAGE (--release) extension loading", () => {
	let pkg = { pkgDir: "", pkgPiAgent: "", probePath: "" };
	beforeAll(async () => {
		pkg = await deployPkg(["--release"]);
		writeFileSync(join(pkg.pkgDir, ".verify-skill-probe.ts"), PROBE_TS_SKILL);
	}, 120_000); // deploys + bun install: needs headroom past the 5s default
	afterAll(() => {
		if (pkg.pkgDir) rmSync(pkg.pkgDir, { recursive: true, force: true });
	});
	for (const cwd of [tmpdir(), REPO_ROOT]) {
		test(`DEPLOY-PACKAGE from ${cwd === REPO_ROOT ? "repo" : "/tmp"}`, async () => {
			const r = await runScenario({
				name: "deploy-pkg",
				cmd: ["bun", pkg.pkgPiAgent, "-e", pkg.probePath, "-p", "hi"],
				cwd,
				marker: pkg.pkgDir,
			});
			assertCleanLoad(r);
		});
	}
	test("DEPLOY-PACKAGE doctor reports mode=release + ok", async () => {
		const r = await runDoctor(pkg.pkgPiAgent, pkg.pkgDir);
		expect(r.mode).toBe("release");
		expect(r.ok).toBe(true);
	});
	test("DEPLOY-PACKAGE doctor --smoke verifies run-dir extensions load (packages marker)", async () => {
		const r = await runDoctorSmoke(pkg.pkgPiAgent, pkg.pkgDir);
		expect(r.ok).toBe(true);
		expect(r.matched).toBeGreaterThan(0);
	}, 60_000);
	test("DEPLOY-PACKAGE skill-load: PwF SKILL.md is in systemPromptOptions.skills", async () => {
		const r = await runScenario({
			name: "deploy-pkg-skill",
			cmd: ["bun", pkg.pkgPiAgent, "-e", join(pkg.pkgDir, ".verify-skill-probe.ts"), "-p", "hi"],
			cwd: pkg.pkgDir,
			marker: pkg.pkgDir,
		});
		assertSkillLoaded(r);
	}, 60_000);
});

// DEPLOY-BUNDLE mode = `deploy.ts` default (pre-bundled ext-bundles/*.thin.js).
// node_modules is NOT copied by default (redundant — everything resolves via
// baked repo .bun-store abs paths; the deploy is same-machine-repo-present).
describe.skipIf(!E2E_ENABLED || !DEPLOY_ENABLED)("e2e: DEPLOY-BUNDLE (default) extension loading", () => {
	let pkg = { pkgDir: "", pkgPiAgent: "", probePath: "" };
	beforeAll(async () => {
		pkg = await deployPkg([]);
		writeFileSync(join(pkg.pkgDir, ".verify-skill-probe.ts"), PROBE_TS_SKILL);
	}, 120_000); // builds 5 ext bundles + deploys: needs headroom past the 5s default
	afterAll(() => {
		if (pkg.pkgDir) rmSync(pkg.pkgDir, { recursive: true, force: true });
	});
	for (const cwd of [tmpdir(), REPO_ROOT]) {
		test(`DEPLOY-BUNDLE from ${cwd === REPO_ROOT ? "repo" : "/tmp"}`, async () => {
			const r = await runScenario({
				name: "deploy-bundle",
				cmd: ["bun", pkg.pkgPiAgent, "-e", pkg.probePath, "-p", "hi"],
				cwd,
				// ext-bundles resolve under pkgDir; npm exts resolve to the repo
				// .bun store (abs paths), so marker=pkgDir counts the bundled exts.
				marker: join(pkg.pkgDir, "ext-bundles"),
			});
			assertCleanLoad(r);
		});
	}
	test("DEPLOY-BUNDLE doctor reports mode=bundle + ok", async () => {
		const r = await runDoctor(pkg.pkgPiAgent, pkg.pkgDir);
		expect(r.mode).toBe("bundle");
		expect(r.ok).toBe(true);
	});
	test("DEPLOY-BUNDLE doctor --smoke verifies run-dir extensions load (ext-bundles marker)", async () => {
		const r = await runDoctorSmoke(pkg.pkgPiAgent, pkg.pkgDir);
		expect(r.ok).toBe(true);
		expect(r.matched).toBeGreaterThan(0);
	}, 60_000);
	test("DEPLOY-BUNDLE skill-load: PwF SKILL.md is in systemPromptOptions.skills", async () => {
		const r = await runScenario({
			name: "deploy-bundle-skill",
			cmd: ["bun", pkg.pkgPiAgent, "-e", join(pkg.pkgDir, ".verify-skill-probe.ts"), "-p", "hi"],
			cwd: pkg.pkgDir,
			marker: join(pkg.pkgDir, "ext-bundles"),
		});
		assertSkillLoaded(r);
	}, 60_000);
});

// DEPLOY-PORTABLE mode = `deploy.ts --portable` (FULL ext bundles incl. npm exts
// + a host node_modules subset). The argv's -e paths all live under pkgDir (no
// repo .bun-store abs paths) — a same-machine-repo-independent deploy. We assert
// both clean load AND that the resolve argv references no path outside pkgDir.
describe.skipIf(!E2E_ENABLED || !DEPLOY_ENABLED)("e2e: DEPLOY-PORTABLE (--portable) extension loading", () => {
	let pkg = { pkgDir: "", pkgPiAgent: "", probePath: "" };
	beforeAll(async () => {
		pkg = await deployPkg(["--portable"]);
		writeFileSync(join(pkg.pkgDir, ".verify-skill-probe.ts"), PROBE_TS_SKILL);
	}, 300_000); // FULL-bundles 13 exts + bun install host subset: needs headroom (observed ~217s under load)
	afterAll(() => {
		if (pkg.pkgDir) rmSync(pkg.pkgDir, { recursive: true, force: true });
	});

	test("portable argv references NO path outside the deploy dir (repo-independent)", async () => {
		// Spawn the DEPLOYED bundle (not the repo one) + capture the run-dir debug.
		const proc = Bun.spawn(["bun", pkg.pkgPiAgent, "--help"], {
			cwd: pkg.pkgDir,
			env: { ...process.env, BUN_PI_DEBUG_RUN_DIR: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		const log = (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, "");
		const block = log.split("run-dir resolved argv:")[1] ?? "";
		const paths = [...block.matchAll(/["']([^"']+\/(ext-bundles|skills|node_modules)\/[^"']+)["']/g)].map((m) => m[1]);
		expect(paths.length).toBeGreaterThan(0);
		// realpath: macOS tmpdir() is /var/... but the fs canonicalizes to /private/var/...
		const canonDir = realpathSync(pkg.pkgDir);
		for (const p of paths) {
			// every resolved -e/--skill path must live inside the deploy dir
			expect(p.startsWith(canonDir)).toBe(true);
		}
	});

	for (const cwd of [tmpdir(), REPO_ROOT]) {
		test(`DEPLOY-PORTABLE from ${cwd === REPO_ROOT ? "repo" : "/tmp"}`, async () => {
			const r = await runScenario({
				name: "deploy-portable",
				cmd: ["bun", pkg.pkgPiAgent, "-e", pkg.probePath, "-p", "hi"],
				cwd,
				marker: join(pkg.pkgDir, "ext-bundles"),
			});
			assertCleanLoad(r);
		});
	}
	test("DEPLOY-PORTABLE doctor reports mode=portable + ok", async () => {
		const r = await runDoctor(pkg.pkgPiAgent, pkg.pkgDir);
		expect(r.mode).toBe("portable");
		expect(r.ok).toBe(true);
	});
	test("DEPLOY-PORTABLE doctor --smoke verifies run-dir extensions load (ext-bundles marker)", async () => {
		const r = await runDoctorSmoke(pkg.pkgPiAgent, pkg.pkgDir);
		expect(r.ok).toBe(true);
		expect(r.matched).toBeGreaterThan(0);
	}, 60_000);
	test("DEPLOY-PORTABLE skill-load: PwF SKILL.md is in systemPromptOptions.skills", async () => {
		const r = await runScenario({
			name: "deploy-portable-skill",
			cmd: ["bun", pkg.pkgPiAgent, "-e", join(pkg.pkgDir, ".verify-skill-probe.ts"), "-p", "hi"],
			cwd: pkg.pkgDir,
			marker: join(pkg.pkgDir, "ext-bundles"),
		});
		assertSkillLoaded(r);
	}, 60_000);
});
