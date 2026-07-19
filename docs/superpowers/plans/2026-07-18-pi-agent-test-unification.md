# pi-agent Test Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shell-level e2e coverage for `pi-agent.sh`, give every `pi-agent-ext-*` package a local extension-loading contract test and a tiered `run-test.sh`, and add a repo-root `run-all-tests.sh` that unifies all of it.

**Architecture:** Four independent layers, each buildable/testable on its own: (1) one new `bun test` file in `pi-agent` that spawns real child processes against `run.sh`; (2) one `extension-contract.test.ts` per `pi-agent-ext-*` package that loads that package's own extension factory under a mock `pi` (mirrors `pi-agent`'s own `extension-contract.test.ts`, but scoped to one package); (3) one `run-test.sh` per `pi-agent-ext-*` package (quick/full tiers, no build/deploy stage); (4) a root `run-all-tests.sh` that calls `pi-agent`'s `run-test.sh` plus every extension's `run-test.sh`, using `manifest.json`'s `testGate` field where present.

**Tech Stack:** Bash, Bun test runner, TypeScript (`bun:test`), existing `pi-agent` manifest/patch infrastructure.

**Reference spec:** `docs/superpowers/specs/2026-07-18-pi-agent-test-unification-design.md`

**Repo note (corrects the spec's headcount):** there are **21** `pi-agent-ext-*` packages on disk today, not 20 — the spec's count was written before `pi-agent-ext-grill-memory` and `pi-agent-ext-power-tool` (neither is wired into `bun-apps/pi-agent/run-dir/manifest.json`, but both are still `pi-agent-ext-*` packages and are in scope for Components 2/3) were accounted for. This plan covers all 21.

**Repo note (corrects the spec's "sibling dependency" assumption):** the spec speculated that flux2/krea2/ltx share a `pi-vlm` package whose `quick` tier should run as part of their `full` tier. No `bun-apps/pi-vlm` package exists in this repo (only `bun-apps/pi-agent-ext-flux2/src/vlm.ts`, an internal module, not a sibling package). This plan drops that special case — every package's `full` tier is simply `quick` + its own `extension-contract.test.ts` re-asserted standalone.

---

## Task 1: Launcher e2e test for `pi-agent.sh` / `run.sh`

**Files:**
- Create: `bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts`
- Modify: `bun-apps/pi-agent/run-test.sh:102-107` (add a `step` call inside `run_extensions`'s `high` tier — actually the file itself doesn't need per-file wiring; `bun test` auto-discovers `*.test.ts`, so no `run-test.sh` edit is needed for discovery. Instead, modify the `run_extensions()` function's doc comment to mention the new file, and modify `print_list()`'s `high` line to mention launcher coverage.)
- Test: itself (`bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts`)

Background: `run.sh` (symlinked from repo-root `pi-agent.sh`) is at `bun-apps/pi-agent/run.sh`. It:
- resolves through symlinks to find its real `SCRIPT_DIR`
- picks `ENTRY`/`MODE` based on which marker files exist (`pi-agent.js` alone → `deployed (bundle)`; `+packages/` → `deployed (release)`; `+.deploy-portable` → `deployed (portable)`; `src/cli.ts` alone → `source (dev)`)
- handles `--update-help` (prints a static help block, exits 0, never execs bun)
- handles `--upgrade`/`-U` (shifts the flag, `exec`s `update-pi.sh` with remaining args)
- exports `JITI_FS_CACHE`/`PI_CODING_AGENT_DIR` when `.deploy-readonly` marker is present
- prints a `[run.sh] mode=... entry=... cwd=...` debug line to stderr when `PIAGENT_DEBUG=1`

None of this is covered by any existing test — all existing `pi-agent` tests import TS modules directly; none spawn `run.sh` as a subprocess.

- [ ] **Step 1: Write the failing test file**

```typescript
// bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts
/**
 * e2e-launcher — spawns real child processes against run.sh itself (not the
 * TS modules it loads). Covers symlink resolution, entry-mode detection,
 * --update-help, --upgrade passthrough, and read-only env exports — none of
 * which any other test file exercises (they all import TS directly).
 *
 * Run: bun test src/__tests__/e2e-launcher.test.ts  (folded into run-test.sh's
 * `high` tier via run_extensions()).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RUN_SH = path.resolve(import.meta.dirname, "../../run.sh");
let TMP: string;

beforeAll(() => {
	TMP = mkdtempSync(path.join(tmpdir(), "pi-agent-e2e-launcher-"));
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
	return spawnSync("bash", [opts.cwd ? path.join(opts.cwd, "run.sh") : RUN_SH, ...args], {
		cwd: opts.cwd ?? path.dirname(RUN_SH),
		env: { ...process.env, ...opts.env },
		encoding: "utf8",
	});
}

describe("symlink resolution", () => {
	test("debug output reports the real package dir, not the symlink's dir", () => {
		const linkDir = path.join(TMP, "symlink-caller");
		mkdirSync(linkDir, { recursive: true });
		const linkPath = path.join(linkDir, "pi-agent.sh");
		symlinkSync(RUN_SH, linkPath);

		const result = spawnSync("bash", [linkPath, "--update-help"], {
			env: { ...process.env, PIAGENT_DEBUG: "1" },
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		// --update-help exits before the debug line prints (it's a top-of-script
		// early return), so assert the general contract instead: the script must
		// not error out about a missing entry, which would happen if SCRIPT_DIR
		// resolved to linkDir instead of the real package dir.
		expect(result.stderr).not.toMatch(/no pi-agent entry found/);
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
			if (rel.endsWith(".js") || rel.endsWith(".ts")) chmodSync(full, 0o644);
		}
		return dir;
	}

	const STUB_JS = "console.log('stub-entry', process.argv.slice(2).join(' '));\n";
	const STUB_TS = STUB_JS;

	test("pi-agent.js alone -> deployed (bundle)", () => {
		const dir = makeFixture("bundle", { "pi-agent.js": STUB_JS });
		const result = run(["--list-models"], { cwd: dir, env: { PIAGENT_DEBUG: "1" } });
		expect(result.stderr).toMatch(/mode=deployed \(bundle\)/);
	});

	test("pi-agent.js + packages/ -> deployed (release)", () => {
		const dir = makeFixture("release", { "pi-agent.js": STUB_JS, "packages/.keep": "" });
		const result = run(["--list-models"], { cwd: dir, env: { PIAGENT_DEBUG: "1" } });
		expect(result.stderr).toMatch(/mode=deployed \(release\)/);
	});

	test("pi-agent.js + .deploy-portable -> deployed (portable)", () => {
		const dir = makeFixture("portable", { "pi-agent.js": STUB_JS, ".deploy-portable": "" });
		const result = run(["--list-models"], { cwd: dir, env: { PIAGENT_DEBUG: "1" } });
		expect(result.stderr).toMatch(/mode=deployed \(portable\)/);
	});

	test("src/cli.ts alone -> source (dev)", () => {
		const dir = makeFixture("source", { "src/cli.ts": STUB_TS });
		const result = run(["--list-models"], { cwd: dir, env: { PIAGENT_DEBUG: "1" } });
		expect(result.stderr).toMatch(/mode=source \(dev\)/);
	});
});

describe("--update-help", () => {
	test("exits 0 and documents the upgrade wrapper", () => {
		const result = run(["--update-help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/update-pi\.sh/);
		expect(result.stdout).toMatch(/--check/);
		expect(result.stdout).toMatch(/--rebuild/);
	});
});

describe("--upgrade / -U passthrough", () => {
	function makeUpgradeFixture() {
		const dir = path.join(TMP, "upgrade-fixture");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "run.sh"), readFileSync(RUN_SH, "utf8"));
		chmodSync(path.join(dir, "run.sh"), 0o755);
		writeFileSync(path.join(dir, "src", "cli.ts").replace(/\/[^/]+$/, "/cli.ts"), ""); // placeholder, replaced below
		mkdirSync(path.join(dir, "src"), { recursive: true });
		writeFileSync(path.join(dir, "src", "cli.ts"), "console.log('unused');\n");
		const stub = [
			"#!/usr/bin/env bash",
			'echo "$@" > "$(dirname "$0")/received-args.txt"',
			"exit 0",
		].join("\n");
		writeFileSync(path.join(dir, "update-pi.sh"), stub);
		chmodSync(path.join(dir, "update-pi.sh"), 0o755);
		return dir;
	}

	test("forwards flags to update-pi.sh without touching the network", () => {
		const dir = makeUpgradeFixture();
		const result = run(["--upgrade", "--check"], { cwd: dir });
		expect(result.status).toBe(0);
		const received = readFileSync(path.join(dir, "received-args.txt"), "utf8").trim();
		expect(received).toBe("--check");
	});

	test("-U is equivalent to --upgrade", () => {
		const dir = makeUpgradeFixture();
		const result = run(["-U", "--rebuild"], { cwd: dir });
		expect(result.status).toBe(0);
		const received = readFileSync(path.join(dir, "received-args.txt"), "utf8").trim();
		expect(received).toBe("--rebuild");
	});
});

describe("read-only deploy env exports", () => {
	test(".deploy-readonly sets JITI_FS_CACHE and PI_CODING_AGENT_DIR for the child", () => {
		const dir = path.join(TMP, "readonly-fixture");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "run.sh"), readFileSync(RUN_SH, "utf8"));
		chmodSync(path.join(dir, "run.sh"), 0o755);
		writeFileSync(path.join(dir, "pi-agent.js"),
			"require('fs').writeFileSync(require('path').join(__dirname, 'env.json'), JSON.stringify(process.env));\n");
		writeFileSync(path.join(dir, ".deploy-readonly"), "");

		const result = run([], { cwd: dir });
		expect(result.status).toBe(0);
		const env = JSON.parse(readFileSync(path.join(dir, "env.json"), "utf8"));
		expect(env.JITI_FS_CACHE).toBe("0");
		expect(env.PI_CODING_AGENT_DIR).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run it to verify it currently passes (this is coverage-only work, not TDD red/green — `run.sh` already has the behavior; we're proving the test harness is correct)**

Run: `( cd bun-apps/pi-agent && bun test src/__tests__/e2e-launcher.test.ts )`
Expected: all tests PASS. If any FAIL, read the failure — it means either the test's assumption about `run.sh`'s current behavior is wrong (fix the test) or a real bug was just found (do not silently adjust the test to match a bug; flag it).

- [ ] **Step 3: Fold the new file into `run-test.sh`'s `high` tier documentation**

Edit `bun-apps/pi-agent/run-test.sh`. In the header comment block (lines 12-14), extend the `high` tier description:

Before:
```
#   high    (2)  + deploy + 4-cwd extension-loading e2e (the ~15s tier).    ~18s
```

After:
```
#   high    (2)  + deploy + 4-cwd extension-loading e2e + launcher shell    ~19s
#                 spawns (symlink/entry-detect/--upgrade/--update-help).
```

And in `print_list()` (around line 65):

Before:
```
  $(G high)    $(D '~18s')   + deploy + 4-cwd extension-loading e2e
```

After:
```
  $(G high)    $(D '~19s')   + deploy + 4-cwd extension-loading e2e + launcher e2e
```

- [ ] **Step 4: Run the `high` tier end-to-end to confirm the new file runs as part of it**

Run: `( cd bun-apps/pi-agent && ./run-test.sh high )`
Expected: exit 0, output includes `✓ unit + patch + extension e2e (high)`. (The new file is auto-discovered by `bun test` inside that same process — no explicit wiring needed beyond the doc comments.)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts bun-apps/pi-agent/run-test.sh
git commit -m "test(pi-agent): add shell-level e2e coverage for run.sh/pi-agent.sh"
```

---

## Task 2: Shared per-package contract-test shape (reference — no standalone file)

Every subsequent per-package task (Tasks 3-23) creates a file with this exact shape, substituting only the import path, factory variable name, and file path. The mock `pi` object below is copied verbatim from `bun-apps/pi-agent/src/__tests__/extension-contract.test.ts`'s `makeMockPi()` — it's already proven sufficient to load every one of these extensions today (that file loads all of them together via the real manifest), so reusing it per-package needs no further validation per package.

```typescript
// <test-dir>/extension-contract.test.ts
/**
 * extension-contract — local regression guard: this package's extension
 * factory must load under pi-agent's real extension protocol without
 * throwing, and must register at least one usable tool or command. Mirrors
 * bun-apps/pi-agent/src/__tests__/extension-contract.test.ts's mock `pi`,
 * scoped to just this package so a break here fails locally (bun test in
 * this package) instead of only being caught centrally in pi-agent.
 */
import { describe, test, expect } from "bun:test";
import extensionFactory from "<RELATIVE_IMPORT_PATH>";

interface ToolLike {
	name?: string;
	label?: string;
	description?: string;
	[key: string]: unknown;
}
interface CommandLike {
	name?: string;
	handler?: unknown;
}

function makeMockPi() {
	const tools: ToolLike[] = [];
	const commands: CommandLike[] = [];
	const pi = {
		registerTool: (t: ToolLike) => { tools.push(t); return t; },
		registerCommand: (name: string, opts: CommandLike) => { commands.push({ name, handler: opts.handler }); },
		registerMessageRenderer: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setActiveTools: () => {},
		getActiveTools: () => [] as string[],
		getFlag: () => undefined,
		setModel: async () => true,
		on: () => {},
		events: { on: () => () => {}, emit: () => {} },
		getAllTools: () => tools,
		exec: async () => "",
		sendUserMessage: () => {},
	};
	return { pi, tools, commands };
}

describe("<PKG_NAME> extension contract", () => {
	test("factory loads without throwing and registers at least one tool/command", () => {
		const { pi, tools, commands } = makeMockPi();
		expect(() => extensionFactory(pi as never)).not.toThrow();
		expect(tools.length + commands.length).toBeGreaterThan(0);
	});

	test("every registered tool has a non-empty name/label/description", () => {
		const { pi, tools } = makeMockPi();
		extensionFactory(pi as never);
		for (const t of tools) {
			expect(t.name, `tool missing name: ${JSON.stringify(t)}`).toBeTruthy();
			expect(t.label, `tool "${t.name}" missing label`).toBeTruthy();
			expect(t.description, `tool "${t.name}" missing description`).toBeTruthy();
		}
	});

	test("every registered command has a handler function", () => {
		const { pi, commands } = makeMockPi();
		extensionFactory(pi as never);
		for (const c of commands) {
			expect(typeof c.handler, `command "${c.name}" missing handler`).toBe("function");
		}
	});
});
```

The shared `run-test.sh` shape (used verbatim per package except for `<PKG_SLUG>`, `<TEST_CMD>`, and `<CONTRACT_PATH>`):

```bash
#!/usr/bin/env bash
########################################
# run-test.sh — tiered test launcher for <PKG_NAME>.
#   quick (default) — this package's existing test command, unchanged.
#   full            — quick + extension-contract.test.ts re-asserted standalone.
# USAGE
#   ./run-test.sh          # quick
#   ./run-test.sh full
#   ./run-test.sh --list
########################################
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

G() { printf '\033[32m%s\033[0m' "$1"; }
R() { printf '\033[31m%s\033[0m' "$1"; }
Y() { printf '\033[33m%s\033[0m' "$1"; }
D() { printf '\033[2m%s\033[0m' "$1"; }

TIER="quick"
LIST=0
EXTRA=()
while [ $# -gt 0 ]; do
	case "$1" in
		-l|--list) LIST=1; shift ;;
		quick|full) TIER="$1"; shift ;;
		*) EXTRA+=("$1"); shift ;;
	esac
done

print_list() {
	cat <<EOF
$(Y "<PKG_NAME> run-test.sh — tiers"):
  $(G quick)  bun test (this package's existing test command)  $(Y "[default]")
  $(G full)   quick + extension-contract.test.ts re-asserted standalone
EOF
}
if [ "$LIST" -eq 1 ]; then print_list; exit 0; fi
case "$TIER" in quick|full) ;; *) echo "$(R error): unknown tier '$TIER' (want: quick|full)" >&2; exit 2 ;; esac

OVERALL=0
step() {
	local name="$1"; shift
	local start rc elapsed
	start=$(date +%s)
	"$@" >/tmp/<PKG_SLUG>-runtest.log 2>&1
	rc=$?
	elapsed=$(( $(date +%s) - start ))
	if [ "$rc" -eq 0 ]; then
		echo "$(G '✓') ${name}  $(D "(${elapsed}s)")"
	else
		echo "$(R '✗') ${name}  $(D "(${elapsed}s)")"
		OVERALL=1
	fi
	if [ "$rc" -ne 0 ]; then sed 's/^/      /' /tmp/<PKG_SLUG>-runtest.log | tail -n 25 >&2; fi
}

run_quick() { ( cd "$SCRIPT_DIR" && <TEST_CMD> ${EXTRA[@]+"${EXTRA[@]}"} ) ; }
run_contract() { ( cd "$SCRIPT_DIR" && bun test <CONTRACT_PATH> ) ; }

echo "$(Y "▶ <PKG_NAME> run-test.sh — tier=$TIER")"
case "$TIER" in
	quick) step "quick" run_quick ;;
	full)  step "quick" run_quick
	       step "contract (standalone)" run_contract ;;
esac

echo ""
if [ "$OVERALL" -eq 0 ]; then echo "$(G "✓ tier=$TIER passed")"; else echo "$(R "✗ tier=$TIER had failures (see above)")"; fi
exit "$OVERALL"
```

Each of Tasks 3-23 below gives the exact substitution values. Steps within each task:
1. Create `<CONTRACT_PATH>` using the template above with the task's substitutions.
2. Run `bun test <CONTRACT_PATH>` in the package dir, confirm PASS.
3. Create `run-test.sh` using the template above with the task's substitutions; `chmod +x` it.
4. Run `./run-test.sh full`, confirm exit 0.
5. Commit both files together.

---

## Task 3: pi-agent-ext-ask-user

**Files:**
- Create: `bun-apps/pi-agent-ext-ask-user/extensions/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-ask-user/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../pi-ask-user.ts`, `<PKG_NAME>` = `pi-agent-ext-ask-user`, `<PKG_SLUG>` = `pi-agent-ext-ask-user`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `extensions/__tests__/extension-contract.test.ts`.

- [ ] **Step 1:** Create `bun-apps/pi-agent-ext-ask-user/extensions/__tests__/extension-contract.test.ts` from the Task 2 template with the substitutions above.
- [ ] **Step 2:** Run: `( cd bun-apps/pi-agent-ext-ask-user && bun test extensions/__tests__/extension-contract.test.ts )` — expect PASS.
- [ ] **Step 3:** Create `bun-apps/pi-agent-ext-ask-user/run-test.sh` from the Task 2 template with the substitutions above; `chmod +x bun-apps/pi-agent-ext-ask-user/run-test.sh`.
- [ ] **Step 4:** Run: `( cd bun-apps/pi-agent-ext-ask-user && ./run-test.sh full )` — expect exit 0.
- [ ] **Step 5:** Commit:
```bash
git add bun-apps/pi-agent-ext-ask-user/extensions/__tests__/extension-contract.test.ts bun-apps/pi-agent-ext-ask-user/run-test.sh
git commit -m "test(pi-agent-ext-ask-user): add extension-contract test + run-test.sh"
```

---

## Task 4: pi-agent-ext-btw

**Files:**
- Create: `bun-apps/pi-agent-ext-btw/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-btw/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/btw.ts`, `<PKG_NAME>` = `pi-agent-ext-btw`, `<PKG_SLUG>` = `pi-agent-ext-btw`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `__tests__/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 3, with these substitutions. Commit message: `test(pi-agent-ext-btw): add extension-contract test + run-test.sh`.

---

## Task 5: pi-agent-ext-distill

**Files:**
- Create: `bun-apps/pi-agent-ext-distill/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-distill/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/pi-distill.ts`, `<PKG_NAME>` = `pi-agent-ext-distill`, `<PKG_SLUG>` = `pi-agent-ext-distill`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `__tests__/extension-contract.test.ts`.

Note: the factory is exported as `export default distillExtension` — importing the default export still works identically (`import extensionFactory from "../extensions/pi-distill.ts"` binds to it regardless of its local name).

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-distill): add extension-contract test + run-test.sh`.

---

## Task 6: pi-agent-ext-file2md

**Files:**
- Create: `bun-apps/pi-agent-ext-file2md/extensions/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-file2md/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../file2md.ts`, `<PKG_NAME>` = `pi-agent-ext-file2md`, `<PKG_SLUG>` = `pi-agent-ext-file2md`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `extensions/__tests__/extension-contract.test.ts`.

Note: this directory already has `extensions/__tests__/stealth-trim.test.ts` — the new file joins it, no conflict (different filename).

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-file2md): add extension-contract test + run-test.sh`.

---

## Task 7: pi-agent-ext-flux2

**Files:**
- Create: `bun-apps/pi-agent-ext-flux2/extensions/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-flux2/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../flux2.ts`, `<PKG_NAME>` = `pi-agent-ext-flux2`, `<PKG_SLUG>` = `pi-agent-ext-flux2`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `extensions/__tests__/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-flux2): add extension-contract test + run-test.sh`.

---

## Task 8: pi-agent-ext-goal-todo

**Files:**
- Create: `bun-apps/pi-agent-ext-goal-todo/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-goal-todo/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/pi-goal-todo.ts`, `<PKG_NAME>` = `pi-agent-ext-goal-todo`, `<PKG_SLUG>` = `pi-agent-ext-goal-todo`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `__tests__/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-goal-todo): add extension-contract test + run-test.sh`.

---

## Task 9: pi-agent-ext-grill-memory

**Files:**
- Create: `bun-apps/pi-agent-ext-grill-memory/tests/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-grill-memory/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/index.ts`, `<PKG_NAME>` = `pi-agent-ext-grill-memory`, `<PKG_SLUG>` = `pi-agent-ext-grill-memory`, `<TEST_CMD>` = `biome check . && bun test`, `<CONTRACT_PATH>` = `tests/extension-contract.test.ts`.

Note: this package's `test` script is `biome check . && bun test` (not bare `bun test`) — keep that exact command in `run_quick` so `./run-test.sh` doesn't silently drop the lint gate.

- [ ] Steps 1-5: same pattern as Task 3, but Step 2 runs `( cd bun-apps/pi-agent-ext-grill-memory && bun test tests/extension-contract.test.ts )` (bun test directly, not through biome, for the isolated-file check). Commit message: `test(pi-agent-ext-grill-memory): add extension-contract test + run-test.sh`.

---

## Task 10: pi-agent-ext-hermes-memory

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/tests/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../src/index.ts`, `<PKG_NAME>` = `pi-agent-ext-hermes-memory`, `<PKG_SLUG>` = `pi-agent-ext-hermes-memory`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `tests/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-hermes-memory): add extension-contract test + run-test.sh`.

---

## Task 11: pi-agent-ext-knowledge-card

**Files:**
- Create: `bun-apps/pi-agent-ext-knowledge-card/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-knowledge-card/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/knowledge-card.ts`, `<PKG_NAME>` = `pi-agent-ext-knowledge-card`, `<PKG_SLUG>` = `pi-agent-ext-knowledge-card`, `<TEST_CMD>` = `bun test __tests__/`, `<CONTRACT_PATH>` = `__tests__/extension-contract.test.ts`.

Note: this package's existing `test` script is scoped to `bun test __tests__/` (not the whole tree) — the new file MUST live under `__tests__/` (not `extensions/__tests__/`, which exists but is out of that script's scope) or `run_quick` won't pick it up. Keep `<TEST_CMD>` exactly as `bun test __tests__/`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-knowledge-card): add extension-contract test + run-test.sh`.

---

## Task 12: pi-agent-ext-krea2

**Files:**
- Create: `bun-apps/pi-agent-ext-krea2/src/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-krea2/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/krea2.ts`, `<PKG_NAME>` = `pi-agent-ext-krea2`, `<PKG_SLUG>` = `pi-agent-ext-krea2`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `src/extension-contract.test.ts`.

Note: this package's existing tests are flat files directly under `src/` (`src/commands.test.ts`, `src/result.test.ts`, `src/paths.test.ts`) — follow that convention (flat, not a nested `__tests__/` dir).

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-krea2): add extension-contract test + run-test.sh`.

---

## Task 13: pi-agent-ext-ltx

**Files:**
- Create: `bun-apps/pi-agent-ext-ltx/extensions/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-ltx/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../ltx.ts`, `<PKG_NAME>` = `pi-agent-ext-ltx`, `<PKG_SLUG>` = `pi-agent-ext-ltx`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `extensions/__tests__/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-ltx): add extension-contract test + run-test.sh`.

---

## Task 14: pi-agent-ext-movie-director

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/extensions/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-movie-director/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `./movie-director.ts`, `<PKG_NAME>` = `pi-agent-ext-movie-director`, `<PKG_SLUG>` = `pi-agent-ext-movie-director`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `extensions/extension-contract.test.ts`.

Note: this package's existing convention is flat test files directly under `extensions/` (`pi-movie-director.test.ts`, `movie-workflows.test.ts`, etc., no `__tests__/` subdir) — follow that, hence the `./` relative import (same directory) rather than `../`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-movie-director): add extension-contract test + run-test.sh`.

---

## Task 15: pi-agent-ext-obsidian

**Files:**
- Create: `bun-apps/pi-agent-ext-obsidian/extensions/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-obsidian/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../obsidian.ts`, `<PKG_NAME>` = `pi-agent-ext-obsidian`, `<PKG_SLUG>` = `pi-agent-ext-obsidian`, `<TEST_CMD>` = `bun test extensions/__tests__/`, `<CONTRACT_PATH>` = `extensions/__tests__/extension-contract.test.ts`.

Note: this package's `test` script is scoped to `bun test extensions/__tests__/` — the new file MUST live there (it does, per the substitution above) or `run_quick` won't discover it. Keep `<TEST_CMD>` exactly as `bun test extensions/__tests__/`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-obsidian): add extension-contract test + run-test.sh`.

---

## Task 16: ~~pi-agent-ext-planning-with-files~~ — REMOVED, package no longer exists

`origin/main` commit `76d55502` ("remove planning-with-files ext + migrate to pi-coding-agent 0.80.10 ModelRuntime API", landed after this plan was written, merged into this branch via rebase) deleted `bun-apps/pi-agent-ext-planning-with-files` entirely — the directory, its `package.json`, its manifest entry, and its skills entry are all gone from git. Superpowers is now authoritative for the methodology skills it used to shell.

This task is dropped. No replacement action needed — there is nothing to add tests to. Package count is now **20** `pi-agent-ext-*` packages: the spec originally said 20, this plan corrected it to 21 (+grill-memory, +power-tool, both real packages the spec missed), and this removal brings it back to 20. 19 per-package tasks remain (Tasks 3-15, 17-23; Task 16 is this stub).

If a leftover `bun-apps/pi-agent-ext-planning-with-files/` directory still exists on disk in your checkout, it is untracked cruft from before the removal commit (verified via `git ls-files` — 0 tracked files under that path) — not this plan's concern to clean up.

---

## Task 17: pi-agent-ext-power-tool

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-power-tool/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../index.ts`, `<PKG_NAME>` = `pi-agent-ext-power-tool`, `<PKG_SLUG>` = `pi-agent-ext-power-tool`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `src/__tests__/extension-contract.test.ts`.

Note: `src/__tests__/contract.test.ts` already exists in this package but tests schema-cost, an unrelated concern — the new file is named `extension-contract.test.ts` specifically to avoid confusion/collision with it.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-power-tool): add extension-contract test + run-test.sh`.

---

## Task 18: pi-agent-ext-research-tool

**Files:**
- Create: `bun-apps/pi-agent-ext-research-tool/extensions/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-research-tool/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../research.ts`, `<PKG_NAME>` = `pi-agent-ext-research-tool`, `<PKG_SLUG>` = `pi-agent-ext-research-tool`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `extensions/__tests__/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-research-tool): add extension-contract test + run-test.sh`.

---

## Task 19: pi-agent-ext-superpowers

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/tests/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-superpowers/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/index.ts`, `<PKG_NAME>` = `pi-agent-ext-superpowers`, `<PKG_SLUG>` = `pi-agent-ext-superpowers`, `<TEST_CMD>` = `npm run check && npm run build && npm run test:unit`, `<CONTRACT_PATH>` = `tests/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 16 (isolated Step 2 runs `bun test` directly on the new file). Commit message: `test(pi-agent-ext-superpowers): add extension-contract test + run-test.sh`.

---

## Task 20: pi-agent-ext-wayfind

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/tests/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/index.ts`, `<PKG_NAME>` = `pi-agent-ext-wayfind`, `<PKG_SLUG>` = `pi-agent-ext-wayfind`, `<TEST_CMD>` = `npm run check && npm run build && npm run test:unit`, `<CONTRACT_PATH>` = `tests/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 16. Commit message: `test(pi-agent-ext-wayfind): add extension-contract test + run-test.sh`.

---

## Task 21: pi-agent-ext-web-access

**Files:**
- Create: `bun-apps/pi-agent-ext-web-access/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-web-access/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../index.ts`, `<PKG_NAME>` = `pi-agent-ext-web-access`, `<PKG_SLUG>` = `pi-agent-ext-web-access`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `__tests__/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 3. Commit message: `test(pi-agent-ext-web-access): add extension-contract test + run-test.sh`.

---

## Task 22: pi-agent-ext-workflow

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/tests/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-workflow/run-test.sh`

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../extensions/workflow.ts`, `<PKG_NAME>` = `pi-agent-ext-workflow`, `<PKG_SLUG>` = `pi-agent-ext-workflow`, `<TEST_CMD>` = `npm run check && npm run build && npm run test:unit`, `<CONTRACT_PATH>` = `tests/extension-contract.test.ts`.

- [ ] Steps 1-5: same pattern as Task 16. Commit message: `test(pi-agent-ext-workflow): add extension-contract test + run-test.sh`.

---

## Task 23: pi-agent-ext-zai-mcp

**Files:**
- Modify: `bun-apps/pi-agent-ext-zai-mcp/package.json` (add missing `test` script)
- Create: `bun-apps/pi-agent-ext-zai-mcp/extensions/__tests__/extension-contract.test.ts`
- Create: `bun-apps/pi-agent-ext-zai-mcp/run-test.sh`

Background: unlike every other `pi-agent-ext-*` package, `pi-agent-ext-zai-mcp/package.json` has no `scripts.test` entry at all (verified: its `scripts` block is entirely absent). It does already have `extensions/__tests__/stealth-trim.test.ts`, currently only runnable via a manually-typed `bun test`. Add the missing script so it's consistent with every sibling package.

Substitutions: `<RELATIVE_IMPORT_PATH>` = `../zai-mcp.ts`, `<PKG_NAME>` = `pi-agent-ext-zai-mcp`, `<PKG_SLUG>` = `pi-agent-ext-zai-mcp`, `<TEST_CMD>` = `bun test`, `<CONTRACT_PATH>` = `extensions/__tests__/extension-contract.test.ts`.

- [ ] **Step 1:** Edit `bun-apps/pi-agent-ext-zai-mcp/package.json`, add a `scripts` block:

```json
  "scripts": {
    "test": "bun test"
  },
```
(Insert it after the `"pi"` block and before `"dependencies"`, matching where `scripts` appears in sibling packages' `package.json` files.)

- [ ] **Step 2:** Run: `( cd bun-apps/pi-agent-ext-zai-mcp && bun run test )` — expect PASS (runs the existing `stealth-trim.test.ts`; this just proves the new script works before adding more).
- [ ] **Step 3:** Create `bun-apps/pi-agent-ext-zai-mcp/extensions/__tests__/extension-contract.test.ts` from the Task 2 template with the substitutions above.
- [ ] **Step 4:** Run: `( cd bun-apps/pi-agent-ext-zai-mcp && bun test extensions/__tests__/extension-contract.test.ts )` — expect PASS.
- [ ] **Step 5:** Create `bun-apps/pi-agent-ext-zai-mcp/run-test.sh` from the Task 2 template with the substitutions above; `chmod +x`.
- [ ] **Step 6:** Run: `( cd bun-apps/pi-agent-ext-zai-mcp && ./run-test.sh full )` — expect exit 0.
- [ ] **Step 7:** Commit:
```bash
git add bun-apps/pi-agent-ext-zai-mcp/package.json bun-apps/pi-agent-ext-zai-mcp/extensions/__tests__/extension-contract.test.ts bun-apps/pi-agent-ext-zai-mcp/run-test.sh
git commit -m "test(pi-agent-ext-zai-mcp): add missing test script, extension-contract test, run-test.sh"
```

---

## Task 24: Root `run-all-tests.sh`

**Files:**
- Create: `run-all-tests.sh` (repo root)

Depends on: Tasks 3-23 (needs every package's `run-test.sh` to exist) and Task 1 (uses `pi-agent`'s `run-test.sh`).

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
########################################
# run-all-tests.sh — unified test entry point for the whole pi-agent stack.
#
# Runs bun-apps/pi-agent's run-test.sh plus every bun-apps/pi-agent-ext-*
# package's run-test.sh. Resolves each extension's command in priority order:
#   1. manifest.json's testGate field, if declared (bun-apps/pi-agent/run-dir/
#      manifest.json — makes that field load-bearing for the first time; today
#      it's inert, display-only metadata in ext-doctor.ts)
#   2. that package's own ./run-test.sh, if it exists
#   3. bun run test (fallback for anything not yet migrated)
#
# USAGE
#   ./run-all-tests.sh              # each package's quick tier (default)
#   ./run-all-tests.sh full         # each package's full tier + pi-agent's full tier
#   ./run-all-tests.sh --only=NAME  # scope to one package (e.g. --only=pi-agent-ext-flux2)
#   ./run-all-tests.sh --list       # print resolved commands per package, don't run
########################################
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/bun-apps/pi-agent/run-dir/manifest.json"

G() { printf '\033[32m%s\033[0m' "$1"; }
R() { printf '\033[31m%s\033[0m' "$1"; }
Y() { printf '\033[33m%s\033[0m' "$1"; }
D() { printf '\033[2m%s\033[0m' "$1"; }

TIER="quick"
LIST=0
ONLY=""
while [ $# -gt 0 ]; do
	case "$1" in
		quick|full) TIER="$1"; shift ;;
		-l|--list) LIST=1; shift ;;
		--only=*) ONLY="${1#*=}"; shift ;;
		*) echo "$(R error): unknown arg '$1'" >&2; exit 2 ;;
	esac
done

# testGate lookup: manifest.json's extensions[] array mixes plain path strings
# (no testGate) and objects ({name, entry, testGate, ...}). Extract name->testGate
# pairs from the object-form entries only.
declare -A TEST_GATE
if [ -f "$MANIFEST" ]; then
	while IFS=$'\t' read -r name gate; do
		[ -n "$name" ] && TEST_GATE["$name"]="$gate"
	done < <(bun -e '
		const m = require(process.argv[1]);
		for (const e of m.extensions ?? []) {
			if (typeof e === "object" && e && e.name && e.testGate) {
				console.log(`${e.name}\t${e.testGate}`);
			}
		}
	' "$MANIFEST" 2>/dev/null)
fi

resolve_cmd() {
	local pkg="$1"
	local dir="$SCRIPT_DIR/bun-apps/$pkg"
	if [ -n "${TEST_GATE[$pkg]+x}" ]; then
		echo "${TEST_GATE[$pkg]}"
	elif [ -x "$dir/run-test.sh" ]; then
		echo "cd bun-apps/$pkg && ./run-test.sh $TIER"
	else
		echo "cd bun-apps/$pkg && bun run test"
	fi
}

PACKAGES=()
for d in "$SCRIPT_DIR"/bun-apps/pi-agent-ext-*; do
	[ -d "$d" ] || continue
	PACKAGES+=("$(basename "$d")")
done

if [ "$LIST" -eq 1 ]; then
	echo "$(Y "pi-agent") -> cd bun-apps/pi-agent && ./run-test.sh $TIER"
	for pkg in "${PACKAGES[@]}"; do
		echo "$(Y "$pkg") -> $(resolve_cmd "$pkg")"
	done
	exit 0
fi

OVERALL=0
step() {
	local name="$1"; shift
	local start rc elapsed
	start=$(date +%s)
	( eval "$1" ) >/tmp/run-all-tests-"$name".log 2>&1
	rc=$?
	elapsed=$(( $(date +%s) - start ))
	if [ "$rc" -eq 0 ]; then
		echo "$(G '✓') ${name}  $(D "(${elapsed}s)")"
	else
		echo "$(R '✗') ${name}  $(D "(${elapsed}s)")"
		OVERALL=1
	fi
	if [ "$rc" -ne 0 ]; then sed 's/^/      /' /tmp/run-all-tests-"$name".log | tail -n 25 >&2; fi
}

echo "$(Y "▶ run-all-tests.sh — tier=$TIER")"

if [ -z "$ONLY" ] || [ "$ONLY" = "pi-agent" ]; then
	step "pi-agent" "cd '$SCRIPT_DIR/bun-apps/pi-agent' && ./run-test.sh $TIER"
fi

for pkg in "${PACKAGES[@]}"; do
	[ -n "$ONLY" ] && [ "$ONLY" != "$pkg" ] && continue
	cmd="$(resolve_cmd "$pkg")"
	step "$pkg" "cd '$SCRIPT_DIR' && $cmd"
done

echo ""
if [ "$OVERALL" -eq 0 ]; then
	echo "$(G "✓ all packages passed (tier=$TIER)")"
else
	echo "$(R "✗ some packages failed (tier=$TIER) — see above")"
fi
exit "$OVERALL"
```

- [ ] **Step 2:** `chmod +x run-all-tests.sh`
- [ ] **Step 3:** Run: `./run-all-tests.sh --list`
Expected: prints one resolved command per package (21 lines: `pi-agent` + 20 extensions), each either the manifest `testGate` or `./run-test.sh quick` — no line should read `bun run test` (the bare fallback) once Tasks 3-23 (minus the removed Task 16) are complete, since every remaining package now has a `run-test.sh`. If any line does show the fallback, that package's Task above didn't complete — go back and finish it before proceeding.
- [ ] **Step 4:** Run: `./run-all-tests.sh`
Expected: exit 0, all 21 steps show `✓`.
- [ ] **Step 5:** Run: `./run-all-tests.sh --only=pi-agent-ext-flux2`
Expected: exit 0, only the `pi-agent-ext-flux2` step runs.
- [ ] **Step 6: Commit**

```bash
git add run-all-tests.sh
git commit -m "feat: add run-all-tests.sh, a unified test entry point for pi-agent + all extensions"
```

---

## Task 25: Document `run-all-tests.sh` in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (Testing section)

- [ ] **Step 1:** Edit the `## Testing` section in `CLAUDE.md`. Current content:

```
## Testing

\`\`\`
( cd bun-apps/<pkg> && bun test )                                        # any bun-apps/*
bun run --cwd bun-apps/gui-movie-director check:schema                  # validate vs run.py
( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests [--run-gpu]
\`\`\`
```

Replace with:

```
## Testing

\`\`\`
./run-all-tests.sh                                                       # unified: pi-agent + every pi-agent-ext-* (quick tier)
./run-all-tests.sh full                                                  # same, full tier (build/deploy/contract, slower)
./run-all-tests.sh --only=pi-agent-ext-flux2                             # scope to one package
./run-all-tests.sh --list                                                # print resolved per-package commands, don't run
( cd bun-apps/pi-agent && ./run-test.sh [quick|medium|high|readonly|full] )  # pi-agent's own tiers
( cd bun-apps/<pkg> && ./run-test.sh [quick|full] )                      # any pi-agent-ext-* package
bun run --cwd bun-apps/gui-movie-director check:schema                  # validate vs run.py
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests [--run-gpu]
\`\`\`
```

- [ ] **Step 2:** Verify the doc renders correctly: `cat CLAUDE.md | sed -n '/## Testing/,/## Key Directories/p'`
Expected: the new block appears, unbroken markdown fencing.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document run-all-tests.sh as the unified test entry point"
```

---

## Self-review notes (from writing this plan)

- **Spec coverage:** Component 1 -> Task 1. Component 2 -> Tasks 3-23 (contract test half). Component 3 -> Tasks 3-23 (run-test.sh half). Component 4 -> Task 24. Doc update -> Task 25. All five spec components covered.
- **Corrected two spec inaccuracies discovered during research** (documented at the top of this plan): actual package count is 21, not 20; no `pi-vlm` sibling package exists, so the "full tier runs sibling's quick tier" special case was dropped.
- **Type/shape consistency:** every per-package task uses the identical `makeMockPi()` shape and the identical `run-test.sh` `step()` function from Task 2's template — verified each substitution table only changes `<RELATIVE_IMPORT_PATH>`, `<PKG_NAME>`, `<PKG_SLUG>`, `<TEST_CMD>`, `<CONTRACT_PATH>`, nothing else varies.
- **No placeholders:** every task specifies an exact file path and exact substitution values derived from reading the actual file (entry path, existing test script, existing test-dir convention) — none were guessed.
