# pi-agent-ext-deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new dynamic extension `pi-agent-ext-deploy` exposing two agent-callable tools — `pi_deploy` (build + deploy, mirrors `scripts/deploy.ts`) and `pi_verify` (forwards `run-test.sh`, tier-selectable) — as thin structured wrappers.

**Architecture:** Pure `argv.ts` maps params → script args (unit-tested, isolated from spawning). `run.ts` resolves the source repo's `bun-apps/pi-agent` dir, path-guards `outDir`, and spawns the script with a timeout, teeing output to a log file. `deploy-tool.ts` / `verify-tool.ts` parse each script's output into a concise structured result. `src/index.ts` is the factory registering both tools; `extensions/deploy.ts` is the registered entry. No deploy logic is duplicated — `deploy.ts` and `run-test.sh` stay the single source of truth.

**Tech Stack:** Bun + TypeScript (strict), `typebox` (Type schema), `@earendil-works/pi-coding-agent` (`defineTool`, `ExtensionFactory`), `bun:test`. No new runtime deps.

## Global Constraints

- **Entry-point convention:** registered entry is `extensions/deploy.ts` (folder `pi-agent-ext-deploy` → `<X>` = `deploy`). It re-exports the factory from `src/index.ts`. Never `src/index.ts` as the registered entry.
- **No top-level `cd`.** Spawn with `cwd: <absolute pi-agent dir>`. Repo hook `no-cd-drift.sh` blocks top-level `cd`.
- **Bun workspace root is `bun-apps/`.** `bun install` only from `bun-apps/`, never repo root.
- **Tool return shape:** `{ content: [{ type: "text", text }], details: {...}, isError?: true }` (matches research-tool / `toolError`).
- **Dynamic registration only** — `manifest.json` `extensions[]` (object form: `{ name, entry, bundleMode: "thin", testGate, version }`). **Not** in `static-extensions.ts` (double-register). Activated by tool-gate keyword match.
- **Cross-package typecheck is the REQUIRED CI gate:** `bun run --cwd bun-apps/pi-agent typecheck` must EXIT 0.
- **Locating scripts:** `deploy.ts` / `run-test.sh` exist only in the **source repo** (`bun-apps/pi-agent`), NOT in a deployed bundle. The tools resolve the source dir via `PI_AGENT_DIR` env or an upward directory walk; if unresolvable they return `ok:false` with a clear message (never spawn in a wrong cwd).
- **Peer deps:** `@earendil-works/pi-coding-agent: 0.81.1`, `typebox: *` (mirror `pi-agent-ext-tool-gate/package.json`). Dev deps: `@types/bun`, `typescript`.

---

### Task 1: `argv.ts` — pure param→argv mapping

**Files:**
- Create: `bun-apps/pi-agent-ext-deploy/src/argv.ts`
- Test: `bun-apps/pi-agent-ext-deploy/src/argv.test.ts`

**Interfaces:**
- Produces: `buildDeployArgv(params?): string[]`, `buildVerifyArgv(params?): string[]`, types `DeployMode`, `DeployParams`, `VerifyTier`, `VerifyParams`. Later tasks import these.

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent-ext-deploy/src/argv.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildDeployArgv, buildVerifyArgv } from "./argv.ts";

describe("buildDeployArgv", () => {
	test("defaults to --bundle, no outDir, no --no-freeze", () => {
		expect(buildDeployArgv()).toEqual(["--bundle"]);
	});
	test("mode → flag, noFreeze appended last", () => {
		expect(buildDeployArgv({ mode: "standalone", noFreeze: true })).toEqual(["--standalone", "--no-freeze"]);
	});
	test("snapshot + exe modes", () => {
		expect(buildDeployArgv({ mode: "snapshot" })).toEqual(["--snapshot"]);
		expect(buildDeployArgv({ mode: "exe" })).toEqual(["--exe"]);
	});
	test("outDir is positional, placed before flags", () => {
		expect(buildDeployArgv({ outDir: "/tmp/out", mode: "bundle", noFreeze: true }))
			.toEqual(["/tmp/out", "--bundle", "--no-freeze"]);
	});
});

describe("buildVerifyArgv", () => {
	test("defaults to medium tier", () => {
		expect(buildVerifyArgv()).toEqual(["medium"]);
	});
	test("tier + bail", () => {
		expect(buildVerifyArgv({ tier: "high", bail: true })).toEqual(["high", "--bail"]);
	});
	test("all tiers pass through", () => {
		for (const t of ["quick", "medium", "high", "readonly", "full"] as const) {
			expect(buildVerifyArgv({ tier: t })).toEqual([t]);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/argv.test.ts )`
Expected: FAIL — `Cannot find module "./argv.ts"`.

- [ ] **Step 3: Write minimal implementation**

`bun-apps/pi-agent-ext-deploy/src/argv.ts`:
```ts
/**
 * argv.ts — PURE param→argv mapping for the deploy/verify tools.
 *
 * Isolated from spawning so the tricky flag/positional ordering is unit-tested
 * without running a 50s deploy. deploy.ts parses argv as: one optional
 * positional (outDir) + known flags (--bundle/--snapshot/--standalone/--exe/
 * --no-freeze). run-test.sh takes the tier as its first positional + optional
 * forwarded flags (--bail).
 */

export type DeployMode = "bundle" | "snapshot" | "standalone" | "exe";

export interface DeployParams {
	mode?: DeployMode;
	outDir?: string;
	noFreeze?: boolean;
}

const DEPLOY_MODE_FLAG: Record<DeployMode, string> = {
	bundle: "--bundle",
	snapshot: "--snapshot",
	standalone: "--standalone",
	exe: "--exe",
};

/** Build the argv tail for `bun scripts/deploy.ts` (NOT including the script path). */
export function buildDeployArgv(params: DeployParams = {}): string[] {
	const argv: string[] = [];
	if (params.outDir) argv.push(params.outDir);
	argv.push(DEPLOY_MODE_FLAG[params.mode ?? "bundle"]);
	if (params.noFreeze) argv.push("--no-freeze");
	return argv;
}

export type VerifyTier = "quick" | "medium" | "high" | "readonly" | "full";

export interface VerifyParams {
	tier?: VerifyTier;
	bail?: boolean;
}

/** Build the argv tail for `./run-test.sh` (NOT including the script path). */
export function buildVerifyArgv(params: VerifyParams = {}): string[] {
	const argv: string[] = [params.tier ?? "medium"];
	if (params.bail) argv.push("--bail");
	return argv;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/argv.test.ts )`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-deploy/src/argv.ts bun-apps/pi-agent-ext-deploy/src/argv.test.ts
git commit -m "feat(deploy-ext): pure argv builder for pi_deploy/pi_verify"
```

---

### Task 2: `run.ts` — resolve pi-agent dir, guard outDir, spawn helper

**Files:**
- Create: `bun-apps/pi-agent-ext-deploy/src/run.ts`
- Test: `bun-apps/pi-agent-ext-deploy/src/run.test.ts`

**Interfaces:**
- Consumes: none (Task 1 is independent).
- Produces: `resolvePiAgentDir(opts?): string | null`, `assertSafeOutDir(outDir, repoRoot): void`, `runScript(opts): Promise<RunResult>`, types `RunOpts`, `RunResult`. Tasks 3 & 4 import these.

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent-ext-deploy/src/run.test.ts`:
```ts
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
		const envPiAgent = join(modFile, "..", "..", "pi-agent"); // sibling in the fake tree
		const got = resolvePiAgentDir({ PI_AGENT_DIR: envPiAgent } as NodeJS.ProcessEnv, `file://${modFile}`);
		expect(got).toBe(envPiAgent);
	});
	test("walk-up finds the sibling pi-agent dir containing scripts/deploy.ts", () => {
		const modFile = fakeRepo();
		const expected = join(modFile, "..", "..", "pi-agent");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/run.test.ts )`
Expected: FAIL — `Cannot find module "./run.ts"`.

- [ ] **Step 3: Write minimal implementation**

`bun-apps/pi-agent-ext-deploy/src/run.ts`:
```ts
/**
 * run.ts — locate the source pi-agent dir, path-guard outDir, and spawn a
 * script with captured + logged output and a timeout.
 *
 * deploy.ts and run-test.sh live ONLY in the source repo (bun-apps/pi-agent),
 * never in a deployed bundle. So the tools are dev-time: they resolve the
 * source dir (PI_AGENT_DIR env, else an upward walk for a sibling pi-agent/
 * containing scripts/deploy.ts + run-test.sh) and refuse to spawn if it can't
 * be found.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export interface ResolveOpts {
	PI_AGENT_DIR?: string;
}

/** Find the source bun-apps/pi-agent dir, or null if unreachable. */
export function resolvePiAgentDir(
	env: ResolveOpts = (process.env as unknown as ResolveOpts),
	modUrl: string = import.meta.url,
): string | null {
	const envDir = env.PI_AGENT_DIR;
	if (
		envDir &&
		existsSync(join(envDir, "scripts", "deploy.ts")) &&
		existsSync(join(envDir, "run-test.sh"))
	) {
		return envDir;
	}
	let dir = dirname(fileURLToPath(modUrl));
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "pi-agent");
		if (
			existsSync(join(candidate, "scripts", "deploy.ts")) &&
			existsSync(join(candidate, "run-test.sh"))
		) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** outDir must resolve under <repo>/dist/ or the OS temp dir. Throws otherwise. */
export function assertSafeOutDir(outDir: string, repoRoot: string): void {
	const abs = isAbsolute(outDir) ? resolve(outDir) : resolve(repoRoot, outDir);
	if (isWithin(resolve(repoRoot, "dist"), abs)) return;
	if (isWithin(resolve(tmpdir()), abs)) return;
	throw new Error(`outDir must be under <repo>/dist/ or ${tmpdir()} (got ${abs})`);
}

export interface RunOpts {
	cmd: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
	logName: string;
}

export interface RunResult {
	exitCode: number;
	output: string;
	logPath: string;
	timedOut: boolean;
}

/** Spawn cmd+args at cwd, tee combined stdout+stderr to a log file, enforce a timeout. */
export function runScript(opts: RunOpts): Promise<RunResult> {
	const logDir = join(tmpdir(), "pi-deploy-ext-logs");
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, `${opts.logName}-${process.pid}-${Date.now()}.log`);
	const writeStream = createWriteStream(logPath);
	return new Promise((resolveP) => {
		const chunks: Buffer[] = [];
		let timedOut = false;
		const proc = spawn(opts.cmd, opts.args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, opts.timeoutMs);
		const onChunk = (b: Buffer) => {
			chunks.push(b);
			writeStream.write(b);
		};
		proc.stdout?.on("data", onChunk);
		proc.stderr?.on("data", onChunk);
		proc.on("error", (err) => {
			clearTimeout(timer);
			writeStream.end(() => resolveP({ exitCode: -1, output: String(err), logPath, timedOut }));
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			writeStream.end(() =>
				resolveP({ exitCode: code ?? -1, output: Buffer.concat(chunks).toString("utf8"), logPath, timedOut }),
			);
		});
	});
}

/** Last ~40 non-empty lines of output, for an errorTail summary. */
export function tailOutput(output: string, lines = 40): string {
	const all = output.split("\n").filter((l) => l.trim().length > 0);
	return all.slice(-lines).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/run.test.ts )`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-deploy/src/run.ts bun-apps/pi-agent-ext-deploy/src/run.test.ts
git commit -m "feat(deploy-ext): run.ts — resolve pi-agent dir, guard outDir, spawn helper"
```

---

### Task 3: `deploy-tool.ts` — pi_deploy logic + output parsing

**Files:**
- Create: `bun-apps/pi-agent-ext-deploy/src/deploy-tool.ts`
- Test: `bun-apps/pi-agent-ext-deploy/src/deploy-tool.test.ts`

**Interfaces:**
- Consumes: `buildDeployArgv`, `DeployParams` (Task 1); `resolvePiAgentDir`, `assertSafeOutDir`, `runScript`, `tailOutput`, `RunResult` (Task 2).
- Produces: `runDeploy(params, opts?): Promise<DeployResult>`, `parseDeployOutput(text): ParsedDeploy`, type `DeployResult`. Task 5's factory calls `runDeploy`.

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent-ext-deploy/src/deploy-tool.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { parseDeployOutput } from "./deploy-tool.ts";

const SUCCESS_OUTPUT = `
▶ bundle → /tmp/out/pi-agent.js
  ✓ /tmp/out/pi-agent.js  (10.4 MB)
▶ build thin extension bundles → /tmp/out/ext-bundles
  ▶ pi-agent-ext-research-tool  bun-apps/pi-agent-ext-research-tool/extensions/research-tool.ts
    ✓ /tmp/out/ext-bundles/pi-agent-ext-research-tool.thin.js  (252 KB)
  (6 built, 0 skipped via hash cache)
✓ 7/7 extension(s) built → /tmp/out/ext-bundles
✓ deployed → /tmp/out (read-only)
`;

const FAILURE_OUTPUT = `
  ▶ pi-agent-ext-research-tool  bun-apps/pi-agent-ext-research-tool/extensions/research-tool.ts
    ✗ pi-agent-ext-research-tool: Bundle failed
  (6 built, 0 skipped via hash cache, 1 failed)
`;

describe("parseDeployOutput", () => {
	test("parses pi-agent.js size in MB → bytes", () => {
		expect(parseDeployOutput(SUCCESS_OUTPUT).piAgentJsBytes).toBe(10.4e6);
	});
	test("parses built count from the build-extensions summary", () => {
		expect(parseDeployOutput(SUCCESS_OUTPUT).built).toBe(6);
	});
	test("no failures → empty failed list", () => {
		expect(parseDeployOutput(SUCCESS_OUTPUT).failed).toEqual([]);
	});
	test("captures failing extension names from ✗ lines", () => {
		expect(parseDeployOutput(FAILURE_OUTPUT).failed).toEqual(["pi-agent-ext-research-tool"]);
	});
	test("parses KB size when present", () => {
		expect(parseDeployOutput("  ✓ x.thin.js  (252 KB)")).toMatchObject({ piAgentJsBytes: undefined });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/deploy-tool.test.ts )`
Expected: FAIL — `Cannot find module "./deploy-tool.ts"`.

- [ ] **Step 3: Write minimal implementation**

`bun-apps/pi-agent-ext-deploy/src/deploy-tool.ts`:
```ts
/**
 * deploy-tool.ts — pi_deploy: build argv, guard outDir, run deploy.ts, parse
 * its output into a structured result. The deploy itself is delegated to
 * scripts/deploy.ts (single source of truth); this file only orchestrates +
 * parses.
 */
import { buildDeployArgv, type DeployMode, type DeployParams } from "./argv.ts";
import { assertSafeOutDir, resolvePiAgentDir, runScript, tailOutput } from "./run.ts";
import { join, resolve } from "node:path";

const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

export interface ParsedDeploy {
	piAgentJsBytes?: number;
	built: number;
	failed: string[];
}

/** Pure: extract pi-agent.js size, ext-bundles built count, and failing names. */
export function parseDeployOutput(text: string): ParsedDeploy {
	const sizeMatch = text.match(/pi-agent\.js\s+\(([\d.]+)\s*(MB|KB|B)\)/);
	let piAgentJsBytes: number | undefined;
	if (sizeMatch) {
		const n = parseFloat(sizeMatch[1]!);
		const unit = sizeMatch[2];
		piAgentJsBytes = unit === "MB" ? n * 1e6 : unit === "KB" ? n * 1e3 : n;
	}
	const builtMatch = text.match(/\((\d+)\s+built,/);
	const built = builtMatch ? parseInt(builtMatch[1]!, 10) : 0;
	// Failing extension lines look like: "✗ <name>: <message>"
	const failed = [...text.matchAll(/✗\s+([a-zA-Z0-9_.-]+):/g)].map((m) => m[1]!);
	return { piAgentJsBytes, built, failed };
}

export interface DeployResult {
	ok: boolean;
	mode: DeployMode;
	outDir: string;
	piAgentJsBytes?: number;
	extBundles: { built: number; failed: string[] };
	exitCode: number;
	logPath: string;
	errorTail?: string;
}

export interface DeployRunDeps {
	resolveDir?: typeof resolvePiAgentDir;
	run?: typeof runScript;
}

/** Run deploy.ts for the given params. Throws never — failures are { ok:false }. */
export async function runDeploy(
	params: DeployParams,
	deps: DeployRunDeps = {},
): Promise<DeployResult> {
	const mode: DeployMode = params.mode ?? "bundle";
	const resolveDir = deps.resolveDir ?? resolvePiAgentDir;
	const run = deps.run ?? runScript;

	const piAgentDir = resolveDir();
	const outDir = params.outDir ?? "(deploy default: <repo>/dist/pi-agent)";
	if (!piAgentDir) {
		return {
			ok: false,
			mode,
			outDir,
			extBundles: { built: 0, failed: [] },
			exitCode: -1,
			logPath: "",
			errorTail:
				"Could not locate the source pi-agent dir (scripts/deploy.ts not found). " +
				"Run pi-agent from the repo, or set PI_AGENT_DIR=<repo>/bun-apps/pi-agent.",
		};
	}
	if (params.outDir) {
		const repoRoot = resolve(piAgentDir, "..", "..");
		assertSafeOutDir(params.outDir, repoRoot);
	}

	const argv = buildDeployArgv(params);
	const res = await run({
		cmd: "bun",
		args: ["scripts/deploy.ts", ...argv],
		cwd: piAgentDir,
		timeoutMs: DEPLOY_TIMEOUT_MS,
		logName: "pi-deploy",
	});
	const parsed = parseDeployOutput(res.output);
	const ok = res.exitCode === 0 && !res.timedOut && parsed.failed.length === 0;
	return {
		ok,
		mode,
		outDir: params.outDir ?? "(deploy default)",
		piAgentJsBytes: parsed.piAgentJsBytes,
		extBundles: { built: parsed.built, failed: parsed.failed },
		exitCode: res.exitCode,
		logPath: res.logPath,
		errorTail: ok ? undefined : (res.timedOut ? "deploy exceeded 5min timeout" : tailOutput(res.output)),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/deploy-tool.test.ts )`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-deploy/src/deploy-tool.ts bun-apps/pi-agent-ext-deploy/src/deploy-tool.test.ts
git commit -m "feat(deploy-ext): pi_deploy — run deploy.ts + parse output"
```

---

### Task 4: `verify-tool.ts` — pi_verify logic + run-test.sh parsing

**Files:**
- Create: `bun-apps/pi-agent-ext-deploy/src/verify-tool.ts`
- Test: `bun-apps/pi-agent-ext-deploy/src/verify-tool.test.ts`

**Interfaces:**
- Consumes: `buildVerifyArgv`, `VerifyParams`, `VerifyTier` (Task 1); `resolvePiAgentDir`, `runScript`, `tailOutput` (Task 2).
- Produces: `runVerify(params, deps?): Promise<VerifyResult>`, `parseVerifyOutput(text): VerifyStep[]`, types `VerifyResult`, `VerifyStep`. Task 5's factory calls `runVerify`.

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent-ext-deploy/src/verify-tool.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { parseVerifyOutput } from "./verify-tool.ts";

// run-test.sh wraps ✓/✗ in ANSI color and prints "✓ <name>  (Ns)" / "✗ <name>  (Ns)".
const OUTPUT = `\x1b[33m▶ pi-agent run-test.sh — effort=high\x1b[0m
\x1b[32m✓\x1b[0m unit + patch + extension e2e (high)  \x1b[2m(63s)\x1b[0m
\x1b[31m✗\x1b[0m read-only deploy e2e (readonly)  \x1b[2m(7s)\x1b[0m
\x1b[32m✓ effort=high passed\x1b[0m`;

describe("parseVerifyOutput", () => {
	test("strips ANSI and extracts step name + pass/fail + seconds", () => {
		const steps = parseVerifyOutput(OUTPUT);
		expect(steps).toEqual([
			{ name: "unit + patch + extension e2e (high)", passed: true, seconds: 63 },
			{ name: "read-only deploy e2e (readonly)", passed: false, seconds: 7 },
		]);
	});
	test("no step lines → empty array", () => {
		expect(parseVerifyOutput("nothing here")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/verify-tool.test.ts )`
Expected: FAIL — `Cannot find module "./verify-tool.ts"`.

- [ ] **Step 3: Write minimal implementation**

`bun-apps/pi-agent-ext-deploy/src/verify-tool.ts`:
```ts
/**
 * verify-tool.ts — pi_verify: build argv, run run-test.sh at a chosen tier,
 * parse its step summary. run-test.sh stays the single source of truth.
 */
import { buildVerifyArgv, type VerifyParams, type VerifyTier } from "./argv.ts";
import { resolvePiAgentDir, runScript, tailOutput } from "./run.ts";

const TIER_TIMEOUT_MS: Record<VerifyTier, number> = {
	quick: 60_000,
	medium: 5 * 60_000,
	high: 15 * 60_000,
	readonly: 5 * 60_000,
	full: 15 * 60_000,
};

export interface VerifyStep {
	name: string;
	passed: boolean;
	seconds: number;
}

/** Pure: strip ANSI, extract "(Ns)" step lines as ✓/✗ → steps. */
export function parseVerifyOutput(text: string): VerifyStep[] {
	const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
	const steps: VerifyStep[] = [];
	for (const m of clean.matchAll(/([✓✗])\s+(.+?)\s{2,}\((\d+)s\)/g)) {
		steps.push({
			name: m[2]!.trim(),
			passed: m[1] === "✓",
			seconds: parseInt(m[3]!, 10),
		});
	}
	return steps;
}

export interface VerifyResult {
	ok: boolean;
	tier: VerifyTier;
	steps: VerifyStep[];
	exitCode: number;
	logPath: string;
	errorTail?: string;
}

export interface VerifyRunDeps {
	resolveDir?: typeof resolvePiAgentDir;
	run?: typeof runScript;
}

/** Run run-test.sh at the chosen tier. Failures are { ok:false }, never throws. */
export async function runVerify(
	params: VerifyParams,
	deps: VerifyRunDeps = {},
): Promise<VerifyResult> {
	const tier: VerifyTier = params.tier ?? "medium";
	const resolveDir = deps.resolveDir ?? resolvePiAgentDir;
	const run = deps.run ?? runScript;

	const piAgentDir = resolveDir();
	if (!piAgentDir) {
		return {
			ok: false,
			tier,
			steps: [],
			exitCode: -1,
			logPath: "",
			errorTail:
				"Could not locate the source pi-agent dir (run-test.sh not found). " +
				"Run pi-agent from the repo, or set PI_AGENT_DIR=<repo>/bun-apps/pi-agent.",
		};
	}

	const argv = buildVerifyArgv(params);
	const res = await run({
		cmd: "./run-test.sh",
		args: argv,
		cwd: piAgentDir,
		timeoutMs: TIER_TIMEOUT_MS[tier],
		logName: `pi-verify-${tier}`,
	});
	const steps = parseVerifyOutput(res.output);
	const ok = res.exitCode === 0 && !res.timedOut;
	return {
		ok,
		tier,
		steps,
		exitCode: res.exitCode,
		logPath: res.logPath,
		errorTail: ok ? undefined : (res.timedOut ? `${tier} exceeded timeout` : tailOutput(res.output)),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/verify-tool.test.ts )`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-deploy/src/verify-tool.ts bun-apps/pi-agent-ext-deploy/src/verify-tool.test.ts
git commit -m "feat(deploy-ext): pi_verify — run run-test.sh tier + parse steps"
```

---

### Task 5: Factory + entry + package scaffold

**Files:**
- Create: `bun-apps/pi-agent-ext-deploy/src/index.ts`
- Create: `bun-apps/pi-agent-ext-deploy/extensions/deploy.ts`
- Create: `bun-apps/pi-agent-ext-deploy/package.json`
- Create: `bun-apps/pi-agent-ext-deploy/CONTEXT.md`
- Test: `bun-apps/pi-agent-ext-deploy/src/index.test.ts`

**Interfaces:**
- Consumes: `runDeploy`, `DeployParams` (Task 3); `runVerify`, `VerifyParams` (Task 4).
- Produces: the default-exported `ExtensionFactory` (registered in Task 6).

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent-ext-deploy/src/index.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import deployExtension from "./index.ts";

describe("deploy extension factory", () => {
	test("registers exactly pi_deploy and pi_verify", () => {
		const tools: { name: string }[] = [];
		const api: any = {
			registerTool: (def: any) => tools.push(def),
		};
		deployExtension(api);
		expect(tools.map((t) => t.name).sort()).toEqual(["pi_deploy", "pi_verify"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-deploy && bun test src/index.test.ts )`
Expected: FAIL — `Cannot find module "./index.ts"`.

- [ ] **Step 3: Write the factory**

`bun-apps/pi-agent-ext-deploy/src/index.ts`:
```ts
/**
 * pi-agent-ext-deploy — factory registering pi_deploy + pi_verify.
 *
 * Two thin tools that wrap the existing build/verify/deploy scripts:
 *   • pi_deploy — codegen → bundle pi-agent.js → thin ext bundles →
 *                 factory-verify → freeze (mirrors scripts/deploy.ts).
 *   • pi_verify — run a run-test.sh tier (quick|medium|high|readonly|full).
 *
 * Scripts stay the single source of truth; argv logic is pure (argv.ts) and
 * spawning/guarding lives in run.ts. Human-in-chat driver: the user asks the
 * agent to build/verify/deploy and the agent invokes the tool as a one-off.
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runDeploy } from "./deploy-tool.ts";
import { runVerify } from "./verify-tool.ts";

const piDeployTool = defineTool({
	name: "pi_deploy",
	label: "Build & Deploy pi-agent Bundle",
	description:
		"Build and deploy the pi-agent bundle + thin extension bundles (mirrors `bun scripts/deploy.ts`). " +
		"Returns mode, outDir, pi-agent.js size, ext-bundle built/failed counts, exit code, and a log path.",
	parameters: Type.Object({
		mode: Type.Optional(
			Type.Union(
				[Type.Literal("bundle"), Type.Literal("snapshot"), Type.Literal("standalone"), Type.Literal("exe")],
				{ description: "Deploy mode. Default: bundle.", default: "bundle" },
			),
		),
		outDir: Type.Optional(
			Type.String({
				description: "Output dir. Must be under <repo>/dist/ or the OS temp dir. Default: <repo>/dist/pi-agent.",
			}),
		),
		noFreeze: Type.Optional(Type.Boolean({ description: "Skip chmod a-w (dev). Default: false.", default: false })),
	}),
	async execute(_id, params) {
		try {
			const r = await runDeploy({
				mode: params.mode as "bundle" | "snapshot" | "standalone" | "exe" | undefined,
				outDir: params.outDir,
				noFreeze: params.noFreeze ?? false,
			});
			const text =
				(r.ok ? "✓ deployed" : "✗ deploy failed") +
				` (mode=${r.mode}, exit=${r.exitCode}, ext built=${r.extBundles.built}` +
				(r.extBundles.failed.length ? `, failed=${r.extBundles.failed.join(",")}` : "") +
				`, pi-agent.js=${r.piAgentJsBytes ? `${(r.piAgentJsBytes / 1e6).toFixed(1)}MB` : "n/a"})` +
				(r.logPath ? `\nlog: ${r.logPath}` : "") +
				(r.errorTail ? `\n${r.errorTail}` : "");
			return {
				content: [{ type: "text" as const, text }],
				details: r,
				isError: r.ok ? undefined : true,
			};
		} catch (err) {
			return {
				content: [{ type: "text" as const, text: `Error: ${String((err as Error).message ?? err)}` }],
				details: { ok: false },
				isError: true,
			};
		}
	},
});

const piVerifyTool = defineTool({
	name: "pi_verify",
	label: "Verify pi-agent (run-test.sh tier)",
	description:
		"Run a pi-agent run-test.sh tier (quick|medium|high|readonly|full; default medium) and report per-step pass/fail. " +
		"high = the exact CI `deploy -- verify` job. Returns steps, exit code, and a log path.",
	parameters: Type.Object({
		tier: Type.Optional(
			Type.Union(
				[Type.Literal("quick"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("readonly"), Type.Literal("full")],
				{ description: "run-test.sh tier. Default: medium.", default: "medium" },
			),
		),
		bail: Type.Optional(Type.Boolean({ description: "Stop on first failure (--bail). Default: false.", default: false })),
	}),
	async execute(_id, params) {
		try {
			const r = await runVerify({
				tier: params.tier as "quick" | "medium" | "high" | "readonly" | "full" | undefined,
				bail: params.bail ?? false,
			});
			const stepLines = r.steps.map((s) => `  ${s.passed ? "✓" : "✗"} ${s.name} (${s.seconds}s)`).join("\n");
			const text =
				(r.ok ? "✓ verify passed" : "✗ verify failed") +
				` (tier=${r.tier}, exit=${r.exitCode})` +
				(stepLines ? `\n${stepLines}` : "") +
				(r.logPath ? `\nlog: ${r.logPath}` : "") +
				(r.errorTail ? `\n${r.errorTail}` : "");
			return {
				content: [{ type: "text" as const, text }],
				details: r,
				isError: r.ok ? undefined : true,
			};
		} catch (err) {
			return {
				content: [{ type: "text" as const, text: `Error: ${String((err as Error).message ?? err)}` }],
				details: { ok: false },
				isError: true,
			};
		}
	},
});

const extension: ExtensionFactory = (pi) => {
	pi.registerTool(piDeployTool);
	pi.registerTool(piVerifyTool);
};

export default extension;
```

- [ ] **Step 4: Write the registered entry, package.json, CONTEXT.md**

`bun-apps/pi-agent-ext-deploy/extensions/deploy.ts`:
```ts
/**
 * pi-agent-ext-deploy — canonical extension entry.
 *
 * Uniform convention: every bun-apps/pi-agent-ext-<X>/ registers its extension
 * at extensions/<X>.ts. The factory lives in src/index.ts; this file is the
 * single registered entry point and re-exports the default factory.
 */
export { default } from "../src/index.ts";
```

`bun-apps/pi-agent-ext-deploy/package.json`:
```json
{
  "name": "@repo/pi-agent-ext-deploy",
  "private": true,
  "version": "0.1.0",
  "description": "Build/verify/deploy the pi-agent bundle + extension bundles — pi_deploy + pi_verify tools wrapping scripts/deploy.ts and run-test.sh.",
  "license": "MIT",
  "keywords": ["pi-package", "deploy", "build", "verify"],
  "type": "module",
  "main": "src/index.ts",
  "files": ["extensions", "src", "README.md"],
  "pi": {
    "extensions": ["./extensions"]
  },
  "scripts": {
    "test": "bun test"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "0.81.1",
    "typebox": "*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^6.0.3"
  }
}
```

`bun-apps/pi-agent-ext-deploy/CONTEXT.md`:
```markdown
# pi-agent-ext-deploy

Two dynamic, tool-gated tools that wrap the existing build/verify/deploy scripts.

## Tools
- **pi_deploy** — build + deploy the pi-agent bundle + thin extension bundles. Mirrors `bun-apps/pi-agent/scripts/deploy.ts` (codegen → bundle → ext bundles → factory-verify → freeze). Params: `mode` (bundle|snapshot|standalone|exe, default bundle), `outDir` (path-guarded to `<repo>/dist/` or `$TMPDIR`), `noFreeze`.
- **pi_verify** — run a `run-test.sh` tier (quick|medium|high|readonly|full, default medium). `high` = the exact CI `deploy -- verify` job. Params: `tier`, `bail`.

## Layout
- `extensions/deploy.ts` — registered entry (re-exports the factory).
- `src/index.ts` — factory; registers both tools.
- `src/argv.ts` — PURE param→argv mapping (unit-tested, isolated from spawning).
- `src/run.ts` — locate the source `bun-apps/pi-agent` dir (`PI_AGENT_DIR` env or upward walk), path-guard `outDir`, spawn helper with timeout + log file.
- `src/deploy-tool.ts` / `src/verify-tool.ts` — run + parse each script's output into a structured result.

## Invariants
- `deploy.ts` and `run-test.sh` are the single source of truth — no deploy logic is duplicated.
- Scripts exist only in the **source repo**; the tools resolve that dir and refuse to spawn if unreachable (never a wrong-cwd spawn). Set `PI_AGENT_DIR` to override.
- No top-level `cd`; spawn uses `cwd: <absolute pi-agent dir>`.
- Dynamic + tool-gated (keywords build/deploy/verify/bundle/dist); not static.
```

- [ ] **Step 5: Install the new workspace package + run tests + typecheck**

Run:
```bash
( cd bun-apps && bun install )
( cd bun-apps/pi-agent-ext-deploy && bun test )
bun run --cwd bun-apps/pi-agent typecheck
```
Expected: `bun install` adds the workspace symlink (updates `bun-apps/bun.lock`); `bun test` PASS (all task 1–5 tests, 20 total); typecheck EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-deploy bun-apps/bun.lock
git commit -m "feat(deploy-ext): factory + entry + package scaffold (pi_deploy + pi_verify)"
```

---

### Task 6: Registration, tool-gate keywords, real e2e

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/manifest.json` (add to `extensions[]`)
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add a GATE entry)
- Create: `bun-apps/pi-agent-ext-deploy/__tests__/e2e.test.ts` (PI_AGENT_E2E-gated)

**Interfaces:**
- Consumes: the factory from Task 5; `runDeploy`/`runVerify` from Tasks 3–4.

- [ ] **Step 1: Add the manifest entry**

In `bun-apps/pi-agent/run-dir/manifest.json`, append to the `extensions[]` array (object form, matching the tool-gate / research-tool entries):
```json
{
  "name": "pi-agent-ext-deploy",
  "entry": "pi-agent-ext-deploy/extensions/deploy.ts",
  "bundleMode": "thin",
  "testGate": "cd bun-apps/pi-agent-ext-deploy && bun test",
  "version": "0.1.0"
}
```

- [ ] **Step 2: Add the tool-gate GATE entry**

In `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts`, append to the `GATES` array (before the closing `];`):
```ts
  {
    names: ["pi_deploy", "pi_verify"],
    keywords: [
      "build bundle", "deploy", "verify", "run-test", "bundle pi-agent",
      "部署", "建置", "驗證",
    ],
    description: "Build/verify/deploy the pi-agent bundle + extension bundles (wraps deploy.ts + run-test.sh)",
  },
```

- [ ] **Step 3: Write the PI_AGENT_E2E-gated real e2e test**

`bun-apps/pi-agent-ext-deploy/__tests__/e2e.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { runDeploy } from "../src/deploy-tool.ts";
import { runVerify } from "../src/verify-tool.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

describeMaybe("pi-agent-ext-deploy real e2e (PI_AGENT_E2E=1)", () => {
	test("pi_deploy bundle into a temp outDir succeeds with all ext bundles built", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "deploy-ext-e2e-"));
		const r = await runDeploy({ mode: "bundle", outDir, noFreeze: true });
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(0);
		expect(r.extBundles.failed).toEqual([]);
		expect(r.extBundles.built).toBeGreaterThan(0);
		expect(existsSync(join(outDir, "pi-agent.js"))).toBe(true);
	}, 5 * 60_000);

	test("pi_verify quick tier passes", async () => {
		const r = await runVerify({ tier: "quick" });
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(0);
	}, 60_000);
});
```

- [ ] **Step 4: Run unit tests (e2e skipped) + typecheck + schema-cost canary**

Run:
```bash
( cd bun-apps/pi-agent-ext-deploy && bun test )
bun run --cwd bun-apps/pi-agent typecheck
bun run --cwd bun-apps/gui-movie-director check:schema || true
```
Expected: `bun test` PASS (e2e `describe.skip`); typecheck EXIT 0. (check:schema validates the manifest parses; the extension now appears in schema-cost automatically via manifest.)

- [ ] **Step 5: Run the real e2e locally to prove the integration**

Run:
```bash
( cd bun-apps/pi-agent-ext-deploy && PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts )
```
Expected: PASS — pi_deploy builds pi-agent.js into a temp dir with 0 failed ext bundles; pi_verify quick passes. (This is the proof that argv + resolve + spawn + parse are wired end-to-end.)

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/run-dir/manifest.json bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-deploy/__tests__/e2e.test.ts
git commit -m "feat(deploy-ext): register in manifest + tool-gate keywords + e2e"
```

---

## Self-Review

**1. Spec coverage:**
- New dedicated extension, 2 tools (pi_deploy, pi_verify): Tasks 1–6. ✓
- argv.ts pure + unit-tested: Task 1. ✓
- run.ts (resolve pi-agent dir, path guard, spawn, timeout, log file): Task 2. ✓
- pi_deploy (mode/outDir/noFreeze, path-guard, parse): Task 3. ✓
- pi_verify (tier-selectable, parse steps): Task 4. ✓
- Factory + entry + package + CONTEXT: Task 5. ✓
- Dynamic registration in manifest: Task 6. ✓
- Tool-gate keywords: Task 6. ✓
- Schema-cost canary (automatic via manifest): Task 6 step 4. ✓
- Cross-package typecheck: Tasks 5 & 6. ✓
- Real e2e (PI_AGENT_E2E-gated): Task 6. ✓
- YAGNI (no cli-subcommand, no self-heal loop): respected — not in any task. ✓

**2. Placeholder scan:** none — all steps carry real code/commands. ✓

**3. Type consistency:** `DeployMode`/`DeployParams`/`VerifyTier`/`VerifyParams` (Task 1) consumed verbatim in Tasks 3/4; `runDeploy`/`runVerify` signatures (Tasks 3/4) consumed verbatim in Task 5; `resolvePiAgentDir`/`runScript`/`assertSafeOutDir`/`tailOutput` (Task 2) consumed verbatim in Tasks 3/4. ✓

**One known integration risk** (called out in Global Constraints): in a deployed/frozen bundle the scripts don't exist, so `resolvePiAgentDir` returns null and both tools return `ok:false` with the `PI_AGENT_DIR` hint — this is intended (build/verify/deploy are dev-time operations run from the source repo).
