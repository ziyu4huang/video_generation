/**
 * CI-workflow reference guard — the EXECUTOR for a class of rot that has no other one.
 *
 * THE PATTERN THIS EXISTS TO BREAK
 *   A thing gets moved, and a reference to its old location survives because
 *   nothing ever executes that reference. Dead references inside *code* are caught
 *   by typecheck and tests. Dead references inside a DISABLED workflow, an unrun
 *   shell script, or a doc have no executor, so they rot silently and detonate on
 *   the day someone re-enables CI. Confirmed instances, all found in one day:
 *     - `changed_packages` shelled out to scripts/ci-changed-packages.sh — deleted
 *       (ported to bun-apps/s2-agent-ext-devops/src/changed-packages.ts).
 *     - the matrix carried a row for s2-agent-ext-picker — package deleted.
 *     - s2-agent-core-runtime was created by #1251 and never entered the
 *       matrix, so its 10 test files silently left CI the moment they moved.
 *
 * WHAT IS ASSERTED
 *   1. Every `tests` matrix row names a real `bun-apps/<pkg>/` directory.
 *   2. Every script path the workflow shells out to resolves on disk (and every
 *      LOCAL `uses:` action has an action.yml).
 *   3. Every `bun-apps/*` workspace package has a matrix row — a NEW package
 *      cannot be invisible to CI.
 *   4. The `determinism-spotcheck` matrix and the package list inside
 *      scripts/test-determinism-spotcheck.sh name the same real packages.
 *   5. run-test.sh's `full`-tier sibling list names real packages.
 *   6. Every `--flag` a shell script passes to deploy.ts is one deploy.ts knows.
 *
 * WHY 4-6 EXIST (shell scripts, not the workflow)
 *   The same rot lives in shell. Three confirmed instances, none of which the
 *   workflow scanner above can see, because the reference is a bare NAME rather
 *   than a path:
 *     - run-test.sh's `full` tier looped over `pi-obsidian` / `pi-knowledge-card`
 *       — directories that have never existed — and a skip-if-absent branch
 *       swallowed both, so a 3-package baseline tested 1 and reported green.
 *     - (historical) verify-deploy.sh step 5 called `deploy.ts --verify --writable`; deploy.ts
 *       rejects unknown flags, so the documented full run exited 1 on step 5's
 *       first command every time it has ever been run. (verify-deploy.sh has
 *       since been unified into the `devops-verify-deploy` bin —
 *       bun-apps/s2-agent-ext-devops/src/verify-deploy-cli.ts — which is a .ts
 *       bin, outside this file's shell-script scanner, so it is pinned directly
 *       by the dedicated test below.)
 *     - the spot-check package list is duplicated between ci.yml.disabled and
 *       test-determinism-spotcheck.sh; a name in one and not the other either
 *       never runs (matrix-only) or exits 2 (script-only).
 *
 * ONE PARSER, NOT TWO
 *   The matrix is read by shelling out to `scripts/ci-local.sh --tsv` — the local
 *   runner's OWN parse of the workflow. This file deliberately carries no copy of
 *   the matrix and no second matrix parser: a second hand-maintained copy is the
 *   exact failure mode being guarded against. A side effect worth having: this
 *   also proves ci-local.sh's parser still works, and assertion 0 below cross-
 *   checks its row count against an independent YAML parse of the same file, so
 *   a parser that silently starts dropping rows is caught too.
 *
 * PORTABILITY-GUARDED: this test spawns `bash` to run a committed repo script
 * (scripts/ci-local.sh). bash + a committed script are present on every CI runner
 * and dev machine — not a machine-coupled host-binary probe.
 *
 * Run: bun run test:ci-workflow   (from bun-apps/)
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BUN_APPS = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(BUN_APPS, "..");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml.disabled");
const CI_LOCAL = join(REPO_ROOT, "scripts", "ci-local.sh");
const SPOTCHECK = join(REPO_ROOT, "scripts", "test-determinism-spotcheck.sh");
const RUN_TEST = join(BUN_APPS, "s2-agent-ext-devops", "scripts", "run-test.sh");

interface MatrixRow {
	pkg: string;
	cmd: string;
}

/** The matrix, via ci-local.sh's parser — the single source of truth. */
function readMatrix(): MatrixRow[] {
	const r = spawnSync("bash", [CI_LOCAL, "--tsv"], { encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`ci-local.sh --tsv exited ${r.status}: ${(r.stderr ?? "").trim()}`);
	}
	return (r.stdout ?? "")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => {
			const tab = l.indexOf("\t");
			return { pkg: l.slice(0, tab), cmd: l.slice(tab + 1) };
		});
}

/** Every `bun-apps/<dir>` that is a real workspace package (has a package.json). */
function workspacePackages(): string[] {
	return readdirSync(BUN_APPS, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name !== "node_modules")
		.filter((e) => existsSync(join(BUN_APPS, e.name, "package.json")))
		.map((e) => e.name)
		.sort();
}

const WORKFLOW_SRC = readFileSync(WORKFLOW, "utf8");
// biome-ignore lint/suspicious/noExplicitAny: a workflow YAML has no static shape.
const WORKFLOW_DOC = Bun.YAML.parse(WORKFLOW_SRC) as any;

/**
 * A whole token that is a path ending in an executable-script extension. The
 * negative lookahead stops `package.json` from matching as `package.js`.
 */
const SCRIPT_PATH_RE = /^((?:\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.(?:sh|ts|mjs|cjs|js))(?![A-Za-z0-9])$/;

/** Interpreters whose arguments are script paths we must be able to resolve. */
const RUNNERS = new Set(["bash", "sh", "bun", "node", "npx"]);

/**
 * Paths a run block may legitimately name that are NOT expected to exist in a
 * checkout: build artifacts a prior step produces, and scratch under /tmp.
 */
function isBuildArtifactOrScratch(p: string): boolean {
	return /(^|\/)dist\//.test(p) || p.startsWith("/tmp/");
}

/**
 * Split a `run:` block into individual commands. Newlines plus the shell's
 * command separators AND substitution openers — `json=$(bun x.ts --all)` must
 * yield a command whose first word is the runner `bun`, not `json=$(bun`.
 */
function splitCommands(body: string): string[] {
	return body.split(/\n|&&|\|\||\||;|\$\(|`|\{/);
}

/** Strip shell quoting / stray grouping punctuation from one word. */
function cleanToken(t: string): string {
	return t.replace(/^["'()]+/, "").replace(/["'();]+$/, "");
}

/**
 * Script paths a single command genuinely INVOKES. Only two positions count:
 * the command word itself (`./run-test.sh high`) and the arguments of a known
 * interpreter (`bash scripts/x.sh`, `bun test scripts/x.test.ts`). A filename
 * merely MENTIONED inside an `echo`/comment is prose, not a reference — e.g.
 * compile-verify's `echo "expected resolve.ts to emit …"`.
 */
function invokedPaths(command: string): string[] {
	const words = command.trim().split(/\s+/).map(cleanToken).filter((w) => w !== "");
	// Skip `VAR=value` prefixes so `CI=true bash x.sh` still finds its runner.
	let i = 0;
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
	const head = words[i];
	if (head === undefined) return [];
	if (RUNNERS.has(head)) {
		return words.slice(i + 1).filter((w) => SCRIPT_PATH_RE.test(w));
	}
	return SCRIPT_PATH_RE.test(head) ? [head] : [];
}

interface Reference {
	job: string;
	step: string;
	/** Path as written in the workflow. */
	raw: string;
	/** Resolved absolute path. */
	abs: string;
}

/** Every script path referenced by a `run:` block, resolved via working-directory. */
function scriptReferences(): Reference[] {
	const refs: Reference[] = [];
	for (const [job, def] of Object.entries<Record<string, unknown>>(WORKFLOW_DOC.jobs)) {
		const steps = (def.steps ?? []) as Array<Record<string, unknown>>;
		for (const step of steps) {
			if (typeof step.run !== "string") continue;
			const wd = (step["working-directory"] as string | undefined) ?? ".";
			const name = (step.name as string | undefined) ?? (step.id as string | undefined) ?? "<unnamed>";
			const body = step.run
				// `${{ … }}` expressions are GitHub template text, not paths
				// (e.g. `github.event.pull_request.base.sha` looks like a .sh path).
				.replace(/\$\{\{[^}]*\}\}/g, " ")
				// `#` comment lines are prose about code, not executed references.
				.split("\n")
				.filter((l) => !/^\s*#/.test(l))
				.join("\n");
			for (const command of splitCommands(body)) {
				for (const raw of invokedPaths(command)) {
					if (isBuildArtifactOrScratch(raw)) continue;
					refs.push({ job, step: name, raw, abs: resolve(REPO_ROOT, wd, raw) });
				}
			}
		}
	}
	return refs;
}

/** Every LOCAL (`./…`) composite action the workflow `uses:`. */
function localActionReferences(): Reference[] {
	const refs: Reference[] = [];
	for (const [job, def] of Object.entries<Record<string, unknown>>(WORKFLOW_DOC.jobs)) {
		const steps = (def.steps ?? []) as Array<Record<string, unknown>>;
		for (const step of steps) {
			const uses = step.uses as string | undefined;
			if (typeof uses !== "string" || !uses.startsWith("./")) continue;
			refs.push({ job, step: "uses", raw: uses, abs: resolve(REPO_ROOT, uses) });
		}
	}
	return refs;
}

describe("ci.yml.disabled — parser agreement", () => {
	test("ci-local.sh --tsv parses the same number of rows as a raw YAML parse", () => {
		const include = WORKFLOW_DOC.jobs?.tests?.strategy?.matrix?.include;
		expect(Array.isArray(include)).toBe(true);
		expect(readMatrix().length).toBe(include.length);
	});
});

describe("ci.yml.disabled — every matrix row points at a real package", () => {
	test("no DEAD matrix row (the s2-agent-ext-picker class)", () => {
		const dead = readMatrix()
			.filter((r) => !existsSync(join(BUN_APPS, r.pkg, "package.json")))
			.map((r) => r.pkg);
		expect(
			dead,
			`DEAD MATRIX ROW(S) in .github/workflows/ci.yml.disabled: ${dead.join(", ")} — ` +
				"the tests matrix lists package(s) with no bun-apps/<pkg>/package.json. " +
				"A deleted package left its row behind (s2-agent-ext-picker did exactly this). " +
				"Remove the row from the workflow AND from the package list in .github/CI.md.",
		).toEqual([]);
	});
});

describe("ci.yml.disabled — every referenced path resolves", () => {
	// Vacuity guard: a scanner that silently matches NOTHING would pass the
	// "nothing is missing" assertion below forever. Pin a floor + a few known
	// references so a regex/tokenizer regression fails loudly instead of quietly.
	test("the scanner actually finds the workflow's script references", () => {
		const found = scriptReferences().map((r) => r.raw);
		expect(found.length).toBeGreaterThanOrEqual(8);
		// run-test.sh used to be pinned here. Its ONLY reference was the
		// deploy-verify job, which ran run-test.sh's `high` + `readonly` tiers;
		// that job was deleted with the four legacy deploy modes it built. So
		// run-test.sh is now referenced by NO workflow job — it is a local /
		// pi_verify tool only. That is a statement of fact, not a gap to fill:
		// the job never executed here anyway (GitHub Actions is disabled in this
		// repo, and local_ci reads regression-gates alone).
		for (const expected of [
			"bun-apps/s2-agent-ext-devops/src/changed-packages-cli.ts",
			"scripts/ci-file-size-guard.sh",
			"scripts/check-schema-cost.ts",
			"scripts/check-deploy-e2e.sh",
			"bun-apps/s2-agent/run-dir/check-deps.ts",
		]) {
			expect(found).toContain(expected);
		}
		// …and it does NOT mistake prose for a reference (the tokenizer trap the
		// since-deleted compile-verify job used to exercise: `echo "expected
		// resolve.ts to emit …"` / `test -f bun-apps/package.json`).
		expect(found).not.toContain("resolve.ts");
		expect(found.some((f) => f.endsWith("package.js"))).toBe(false);
	});

	test("every script the workflow shells out to exists (the ci-changed-packages.sh class)", () => {
		const missing = scriptReferences().filter((r) => !existsSync(r.abs));
		const detail = missing.map((r) => `${r.raw} (job "${r.job}", step "${r.step}")`);
		expect(
			detail,
			`BROKEN SCRIPT REFERENCE(S) in .github/workflows/ci.yml.disabled: ${detail.join("; ")} — ` +
				"the workflow shells out to path(s) that do not exist on disk. Nothing executes a " +
				"disabled workflow, so this rots silently until CI is re-enabled " +
				"(scripts/ci-changed-packages.sh was deleted and the job kept calling it for months). " +
				"Re-point the step at the code's current home, or restore the file.",
		).toEqual([]);
	});

	test("every local `uses:` composite action has an action.yml", () => {
		const missing = localActionReferences().filter(
			(r) => !existsSync(join(r.abs, "action.yml")) && !existsSync(join(r.abs, "action.yaml")),
		);
		const detail = missing.map((r) => `${r.raw} (job "${r.job}")`);
		expect(detail, `BROKEN LOCAL ACTION REFERENCE(S): ${detail.join("; ")}`).toEqual([]);
	});
});

// ── shell-script references (assertions 4-6) ────────────────────────────────

/**
 * The spot-check script's OWN package list, obtained by executing it — same
 * "one parser, not two" rule as readMatrix(). Passing an unknown package makes
 * it exit 2 after printing `unknown package 'x'. Known: a b c`; that error path
 * runs no tests, so this is cheap. A name chosen to never be a real package.
 */
function spotcheckScriptPackages(): string[] {
	const r = spawnSync("bash", [SPOTCHECK, "__guard_probe_not_a_package__"], { encoding: "utf8" });
	if (r.status !== 2) {
		throw new Error(
			`test-determinism-spotcheck.sh should exit 2 on an unknown package, got ${r.status}. ` +
				"Its unknown-package error path is how this guard reads the list — keep it, " +
				`including the \`Known: <names>\` line. stderr: ${(r.stderr ?? "").trim()}`,
		);
	}
	const line = (r.stderr ?? "").split("\n").find((l) => l.includes("Known:"));
	if (line === undefined) throw new Error(`no "Known:" line in spot-check stderr: ${(r.stderr ?? "").trim()}`);
	return line.slice(line.indexOf("Known:") + "Known:".length).trim().split(/\s+/).filter((s) => s !== "");
}

/** The `determinism-spotcheck` job's matrix package list, from the workflow. */
function spotcheckMatrixPackages(): string[] {
	const pkgs = WORKFLOW_DOC.jobs?.["determinism-spotcheck"]?.strategy?.matrix?.package;
	if (!Array.isArray(pkgs)) throw new Error("determinism-spotcheck job has no strategy.matrix.package list");
	return pkgs as string[];
}

/** run-test.sh's `full`-tier sibling list, obtained by executing it. */
function runTestSiblings(): string[] {
	const r = spawnSync("bash", [RUN_TEST, "--list-siblings"], { encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`run-test.sh --list-siblings exited ${r.status}: ${(r.stderr ?? "").trim()}`);
	}
	return (r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Every committed shell script that could reference a package or a script flag. */
function shellScripts(): string[] {
	const out: string[] = [];
	const scriptsDir = join(REPO_ROOT, "scripts");
	for (const e of readdirSync(scriptsDir)) if (e.endsWith(".sh")) out.push(join(scriptsDir, e));
	const hooks = join(REPO_ROOT, ".githooks");
	if (existsSync(hooks)) for (const e of readdirSync(hooks)) out.push(join(hooks, e));
	for (const pkg of workspacePackages()) {
		for (const e of readdirSync(join(BUN_APPS, pkg))) {
			if (e.endsWith(".sh")) out.push(join(BUN_APPS, pkg, e));
		}
	}
	return out.sort();
}


interface HookRef {
	hook: string;
	line: number;
	raw: string;
	abs: string;
}

/**
 * Every repo script a git hook shells out to. Hooks are the one place where a
 * dead path is BOTH invisible and load-bearing: nothing imports them, nothing
 * tests them, and the failure surfaces as "your push mysteriously did nothing"
 * or "your push is mysteriously blocked". pre-push now delegates the whole
 * regression-gates job to scripts/ci-local.sh, so that path has to stay real.
 */
function hookReferences(): HookRef[] {
	const dir = join(REPO_ROOT, ".githooks");
	if (!existsSync(dir)) return [];
	const refs: HookRef[] = [];
	for (const name of readdirSync(dir)) {
		const file = join(dir, name);
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((raw, i) => {
				const line = raw.replace(/#.*$/, "");
				for (const p of invokedPaths(line)) {
					refs.push({ hook: name, line: i + 1, raw: p, abs: resolve(REPO_ROOT, p) });
				}
			});
	}
	return refs;
}

describe(".githooks — every script a hook shells out to exists", () => {
	test("no hook calls a path that has moved", () => {
		const missing = hookReferences().filter((r) => !existsSync(r.abs));
		const detail = missing.map((r) => `${r.raw} (.githooks/${r.hook}:${r.line})`);
		expect(
			detail,
			`BROKEN HOOK REFERENCE(S): ${detail.join("; ")} — a git hook shells out to a path that ` +
				"does not exist. Nothing imports or tests a hook, so this rots invisibly and then " +
				"surfaces as a push that mysteriously does nothing (or is mysteriously blocked). " +
				"pre-push delegates the whole regression-gates job to scripts/ci-local.sh; if that " +
				"script moves, repoint the hook.",
		).toEqual([]);
	});

	// Vacuity guard: a hook directory that stopped being scanned, or a scanner
	// that matched nothing, would pass the assertion above forever.
	test("the scanner finds the hooks' real references", () => {
		const found = hookReferences().map((r) => r.raw);
		expect(found).toContain("scripts/ci-local.sh");
		expect(found).toContain("scripts/test-portability-audit.sh");
	});
});

describe("determinism-spotcheck — the workflow matrix and the script agree", () => {
	test("both lists name the same packages (neither can drift alone)", () => {
		const matrix = [...spotcheckMatrixPackages()].sort();
		const script = [...spotcheckScriptPackages()].sort();
		expect(
			script,
			"DETERMINISM SPOT-CHECK LIST DRIFT — the `package` matrix in " +
				".github/workflows/ci.yml.disabled and the ENTRIES list in " +
				`scripts/test-determinism-spotcheck.sh disagree. matrix=[${matrix.join(", ")}] ` +
				`script=[${script.join(", ")}]. CI passes one matrix name per job as the script's ` +
				"only argument: a matrix-only name exits 2 (\"unknown package\") and a script-only " +
				"name never runs in CI at all. Add the package to BOTH.",
		).toEqual(matrix);
	});

	test("every spot-checked package is a real workspace package", () => {
		const dead = spotcheckMatrixPackages().filter((p) => !existsSync(join(BUN_APPS, p, "package.json")));
		expect(dead, `DEAD determinism-spotcheck package(s): ${dead.join(", ")}`).toEqual([]);
	});

	// Vacuity guard: an empty-vs-empty comparison would pass forever.
	test("the lists are non-empty and include the known flake-prone packages", () => {
		const matrix = spotcheckMatrixPackages();
		expect(matrix.length).toBeGreaterThanOrEqual(3);
		expect(matrix).toContain("s2-agent-ext-workflow");
	});
});

describe("run-test.sh — the `full`-tier sibling list names real packages", () => {
	test("every sibling resolves to bun-apps/<pkg>/package.json (the pi-obsidian class)", () => {
		const siblings = runTestSiblings();
		const dead = siblings.filter((p) => !existsSync(join(BUN_APPS, p, "package.json")));
		expect(
			dead,
			`DEAD SIBLING PACKAGE(S) in bun-apps/s2-agent-ext-devops/scripts/run-test.sh SIBLING_PKGS: ${dead.join(", ")} — ` +
				"the `full` tier loops over bare package NAMES, so nothing typechecks them. This list " +
				"read `pi-obsidian` / `pi-knowledge-card` (the real dirs are `s2-agent-ext-*`) and a " +
				"skip-if-absent branch swallowed both, so a 3-package baseline silently tested 1 while " +
				"reporting green. Fix the name, or drop the package from SIBLING_PKGS.",
		).toEqual([]);
	});

	// Vacuity guard: `--list-siblings` printing nothing would pass the above.
	test("the sibling list is non-empty", () => {
		expect(runTestSiblings().length).toBeGreaterThanOrEqual(3);
	});
});

describe("ci.yml.disabled — every workspace package is in the matrix", () => {
	test("no package is invisible to CI (the s2-agent-core-runtime class)", () => {
		const inMatrix = new Set(readMatrix().map((r) => r.pkg));
		const uncovered = workspacePackages().filter((p) => !inMatrix.has(p));
		expect(
			uncovered,
			`WORKSPACE PACKAGE(S) MISSING FROM THE CI MATRIX: ${uncovered.join(", ")} — ` +
				"bun-apps/<pkg>/package.json exists but the tests matrix in " +
				".github/workflows/ci.yml.disabled has no row for it, so its tests never run in CI. " +
				"This is how s2-agent-core-runtime's 10 test files silently left CI when #1251 " +
				"extracted them into a new package. Add a `- { package: <pkg>, test-cmd: \"…\" }` row " +
				"(and list it in .github/CI.md).",
		).toEqual([]);
	});
});
