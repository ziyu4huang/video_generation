# pi-agent --exe Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four findings from the 2026-07-20 `deploy.ts --exe` review: (1) user `-e` of a static-bundled extension hard-fails with tool conflicts, (2) `doctor --smoke` is skipped in binary mode despite `-e` .ts loading now working there, (3) stale "binary can't load .ts extensions" comments/messages across four files, (4) deploy.ts minor issues (unused `IS_BUNDLE`, no unknown-flag guard).

**Architecture:** All behavior changes are pure-function-first (new helpers in `cli-argv.ts`, modified `smokeMarker`/`runSmokeCheck` in `doctor.ts`) with unit tests, wired into `cli.ts`/`doctor.ts` thin imperative shells — matching the repo's existing pattern. Comment fixes are behavior-neutral. Final task rebuilds the exe and re-runs the live verification matrix from the review.

**Tech Stack:** Bun + TypeScript, `bun:test`. Empirical background (verified 2026-07-20 against a freshly compiled exe): upstream pi-coding-agent 0.80.10's loader (`dist/core/extensions/loader.js:314-321`) loads `-e <path>.ts` in compiled binaries via jiti `virtualModules` + `tryNative: false`; static-factory tools appear as `sourceInfo.path === "<inline:<pkg-name>>"`.

---

## Verified baseline (from the review — expected before-state)

Built via `( cd bun-apps/pi-agent && bun scripts/deploy.ts <out> --exe --no-freeze )`:

| Scenario | Current behavior |
|---|---|
| exe, no flags | 31 tools (7 builtin + 24 from 10 static exts), 4 `--skill` injected |
| exe `-ne` | 7 builtin tools, user `-e` still loads, skills kept |
| exe `-ns` | injected `--skill` count 4 → 0 |
| exe `-ne -e <hermes>.ts` | hermes 6 tools load from disk path |
| exe `-e <hermes>.ts` (no `-ne`) | **exit 1** — `Tool "memory" conflicts` ×6 (static copy vs -e copy) |
| exe `doctor --smoke` | smoke skipped: "binary mode cannot load .ts extensions" |

---

### Task 0: Branch setup

**Files:** none (git only)

- [x] **Step 0.1: Fetch and branch off origin/main** (repo currently on detached HEAD; per project SOP always base on fresh origin/main)

```bash
git -C /Users/huangziyu/proj/video_generation__subagent fetch origin
git -C /Users/huangziyu/proj/video_generation__subagent checkout -b fix/exe-e-flag-review-20260720 origin/main
```

Expected: new branch `fix/exe-e-flag-review-20260720` at origin/main tip.

---

### Task 1: User `-e` overrides the static-bundled copy (no more tool-conflict crash)

A user passing `-e <path>` that points into one of the 10 static extension packages (e.g. a dev checkout of `pi-agent-ext-hermes-memory`) currently crashes with tool-name conflicts unless they also pass `-ne`. Fix: detect the overlap from the pre-patch argv and drop the conflicting static factories, so the user's `-e` copy wins.

**Files:**
- Modify: `bun-apps/pi-agent/src/cli-argv.ts` (add two pure helpers)
- Modify: `bun-apps/pi-agent/src/cli.ts:87-90` (wire the filter)
- Test: `bun-apps/pi-agent/src/cli-argv.test.ts`

- [x] **Step 1.1: Write failing tests** — append to `src/cli-argv.test.ts`:

```ts
import {
	isDoctorCommand,
	isExtDoctorCommand,
	userSuppressFlags,
	userExtensionPaths,
	overriddenStaticExtensions,
} from "./cli-argv.ts";
```

(replace the existing import line), then append:

```ts
describe("userExtensionPaths", () => {
	test("collects -e and --extension values in order", () => {
		expect(userExtensionPaths(["-e", "/a/x.ts", "--extension", "/b/y.ts", "-p", "hi"])).toEqual([
			"/a/x.ts",
			"/b/y.ts",
		]);
	});

	test("empty when no -e present; trailing -e with no value is ignored", () => {
		expect(userExtensionPaths(["-p", "hi"])).toEqual([]);
		expect(userExtensionPaths(["-e"])).toEqual([]);
	});
});

describe("overriddenStaticExtensions", () => {
	const NAMES = ["pi-agent-ext-hermes-memory", "pi-agent-ext-workflow"];

	test("a -e path inside a static package dir overrides that package", () => {
		const argv = ["-e", "/repo/bun-apps/pi-agent-ext-hermes-memory/extensions/hermes-memory.ts"];
		expect(overriddenStaticExtensions(argv, NAMES)).toEqual(new Set(["pi-agent-ext-hermes-memory"]));
	});

	test("unrelated -e paths override nothing", () => {
		expect(overriddenStaticExtensions(["-e", "/tmp/probe.ts"], NAMES)).toEqual(new Set());
	});

	test("matches whole path segments only (no substring false-positives)", () => {
		const argv = ["-e", "/x/pi-agent-ext-hermes-memory-v2/extensions/hm.ts"];
		expect(overriddenStaticExtensions(argv, NAMES)).toEqual(new Set());
	});

	test("multiple -e paths accumulate; windows separators work", () => {
		const argv = [
			"-e", "/a/pi-agent-ext-workflow/extensions/workflow.ts",
			"-e", "C:\\x\\pi-agent-ext-hermes-memory\\extensions\\hm.ts",
		];
		expect(overriddenStaticExtensions(argv, NAMES)).toEqual(
			new Set(["pi-agent-ext-workflow", "pi-agent-ext-hermes-memory"]),
		);
	});
});
```

- [x] **Step 1.2: Run tests, verify they fail**

```bash
( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )
```

Expected: FAIL — `userExtensionPaths` / `overriddenStaticExtensions` not exported.

- [x] **Step 1.3: Implement helpers** — append to `src/cli-argv.ts`:

```ts
/**
 * Values of every `-e <path>` / `--extension <path>` pair in the PRE-PATCH
 * argv (what the user actually typed — the run-dir splice hasn't run yet at
 * classification time, same contract as userSuppressFlags above).
 */
export function userExtensionPaths(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") out.push(argv[i + 1]!);
	}
	return out;
}

/**
 * Which static extension packages the user's own `-e` paths override. A `-e`
 * path that points INTO a static package's directory (any whole path segment
 * equals the package name, e.g. `-e ~/dev/pi-agent-ext-hermes-memory/
 * extensions/hermes-memory.ts`) means the user wants THAT copy — keeping the
 * baked-in static factory too would register the same tool names twice and
 * crash extension loading with `Tool "<name>" conflicts` (pi does not dedup a
 * static factory against a -e path). cli.ts drops the overridden factories so
 * the user's copy wins. Segment equality (not substring) so
 * `pi-agent-ext-hermes-memory-v2` does not match `pi-agent-ext-hermes-memory`.
 */
export function overriddenStaticExtensions(argv: string[], staticNames: string[]): Set<string> {
	const overridden = new Set<string>();
	for (const p of userExtensionPaths(argv)) {
		const segs = p.split(/[\\/]/);
		for (const name of staticNames) {
			if (segs.includes(name)) overridden.add(name);
		}
	}
	return overridden;
}
```

- [x] **Step 1.4: Run tests, verify they pass**

```bash
( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )
```

Expected: PASS (all, including the 4 pre-existing describe blocks).

- [x] **Step 1.5: Wire into cli.ts** — replace `src/cli.ts:74-90` (the block from `// Patches MUST be applied…` to the end of file; keep the block comment about re-slicing) with:

```ts
// Patches MUST be applied before main() constructs ModelRegistry. Among other
// things, this splices run-dir/ extension + skill paths into process.argv.
await applyPatches();

// Re-slice AFTER patches so the run-dir splice (and any other process.argv
// mutation above) reaches main(). main(args) consumes the passed array
// directly — it does NOT re-read process.argv.
//
// `argv` was sliced BEFORE applyPatches(), so this reflects only what the USER
// typed — the deploy modes' self-injected "-ne" (spliced during applyPatches)
// can't turn the static factories off. Upstream pi never gates
// extensionFactories on -ne (resource-loader loads them unconditionally), so
// this gate is what makes `pi-agent -ne` actually mean "no injected extensions".
//
// A user `-e` path pointing into a static package's dir overrides the baked-in
// factory (see overriddenStaticExtensions) — otherwise the two copies register
// the same tool names and extension loading crashes with `Tool conflicts`.
const userNoExtensions = userSuppressFlags(argv).noExtensions;
const overridden = overriddenStaticExtensions(
	argv,
	STATIC_EXTENSION_FACTORIES.map((f) => f.name),
);
const factories = userNoExtensions
	? []
	: STATIC_EXTENSION_FACTORIES.filter((f) => !overridden.has(f.name));
if (!userNoExtensions && overridden.size > 0) {
	console.error(`[pi-agent] static extension(s) overridden by user -e: ${[...overridden].join(", ")}`);
}
await main(process.argv.slice(2), {
	extensionFactories: factories,
});
```

and extend the import at `src/cli.ts:28` to:

```ts
import { isDoctorCommand, isExtDoctorCommand, userSuppressFlags, overriddenStaticExtensions } from "./cli-argv.ts";
```

- [x] **Step 1.6: Run the package test suite**

```bash
( cd bun-apps/pi-agent && bun test )
```

Expected: PASS.

- [x] **Step 1.7: Commit**

```bash
git add bun-apps/pi-agent/src/cli-argv.ts bun-apps/pi-agent/src/cli-argv.test.ts bun-apps/pi-agent/src/cli.ts
git commit -m "feat(pi-agent): user -e path overrides the static-bundled copy of the same extension"
```

---

### Task 2: `doctor --smoke` works in binary (exe) mode

Binary mode CAN load the smoke probe via `-e` (verified empirically against 0.80.10). The marker for "expected extension tools" in binary mode is the static-factory source prefix `"<inline:"`. The spawn must run the exe directly (not `bun <exe>`) and must not use the garbage `$bunfs` selfDir as cwd.

**Files:**
- Modify: `bun-apps/pi-agent/src/doctor.ts` (`smokeMarker`, `defaultSmokeSpawn`, `runSmokeCheck`)
- Test: `bun-apps/pi-agent/src/doctor.test.ts`

- [x] **Step 2.1: Update tests to the new contract** — in `src/doctor.test.ts`:

Replace (around line 170):

```ts
	test("binary → null (smoke skipped)", () => {
		expect(smokeMarker("binary", "/out")).toBeNull();
	});
```

with:

```ts
	test("binary → the static-factory source prefix (tools report path '<inline:<pkg>>')", () => {
		expect(smokeMarker("binary", "/out")).toBe("<inline:");
	});
```

Replace the `"INFO (skip) for binary mode — no spawn"` test (around line 200) with a spawn-based one in the same style as the neighboring runSmokeCheck tests (reuse that test's existing `ctx` helper and injected-spawn pattern):

```ts
	test("binary mode runs the probe (spawn injected) and passes on matched>0", async () => {
		const r = await runSmokeCheck(ctx({ mode: "binary" }), {
			spawn: async () => ({ stderr: "[SMOKE] total=31 matched=24\n", code: 0 }),
		});
		expect(r.status).toBe("pass");
	});
```

- [x] **Step 2.2: Run tests, verify the two rewritten ones fail**

```bash
( cd bun-apps/pi-agent && bun test src/doctor.test.ts )
```

Expected: 2 FAIL (smokeMarker returns null; runSmokeCheck short-circuits to info).

- [x] **Step 2.3: Implement** — in `src/doctor.ts`:

(a) `smokeMarker` (line ~368-380) — new doc + binary branch; return type narrows to `string`:

```ts
/**
 * The marker the smoke probe greps tool sourceInfo.path for, per mode.
 * Pure (no fs).
 *  - source:  the bun-apps dir (selfDir is .../pi-agent/src → ../.. = bun-apps)
 *  - bundle / portable: <selfDir>/ext-bundles
 *  - release: <selfDir>/packages
 *  - binary:  "<inline:" — static-factory tools report sourceInfo.path
 *             "<inline:<pkg-name>>"; the probe itself loading via -e also
 *             proves the upstream jiti binary path works (0.80.10+).
 */
export function smokeMarker(mode: DeployMode, selfDir: string): string {
	if (mode === "binary") return "<inline:";
	if (mode === "source") return resolve(selfDir, "..", "..");
	if (mode === "release") return join(selfDir, "packages");
	return join(selfDir, "ext-bundles"); // bundle + portable
}
```

(b) `defaultSmokeSpawn` (line ~414-427) — add `exeDirect` to the args type and branch the command:

```ts
export async function defaultSmokeSpawn(args: {
	entry: string;
	probe: string;
	cwd: string;
	env: Record<string, string | undefined>;
	timeoutMs?: number;
	/** Binary mode: `entry` IS the compiled exe — spawn it directly, not `bun <entry>`. */
	exeDirect?: boolean;
}): Promise<{ stderr: string; code: number | null }> {
	const timeoutMs = args.timeoutMs ?? 30_000;
	const cmd = args.exeDirect
		? [args.entry, "-e", args.probe, "-p", "hi"]
		: ["bun", args.entry, "-e", args.probe, "-p", "hi"];
	const proc = Bun.spawn(cmd, {
```

(rest of the function body unchanged).

(c) `runSmokeCheck` (line ~468-483) — drop the null-skip, binary-aware cwd + exeDirect:

```ts
export async function runSmokeCheck(ctx: DoctorContext, opts: SmokeOptions = {}): Promise<CheckResult> {
	const id = "runtime-smoke";
	const label = "runtime smoke (extension load)";
	const marker = smokeMarker(ctx.mode, ctx.selfDir);
	// Binary mode: selfDir is the non-existent $bunfs virtual dir — cwd there
	// would fail the spawn. Use the exe's real on-disk dir instead.
	const cwd = ctx.mode === "binary" ? dirname(ctx.entryPath) : ctx.selfDir;
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-smoke-"));
	const probePath = join(dir, "smoke-probe.ts");
	writeFileSync(probePath, SMOKE_PROBE);
	const env = { ...ctx.env, PI_SMOKE_MARKER: marker };
	let result: { stderr: string; code: number | null };
	try {
		result = opts.spawn
			? await opts.spawn({ entry: ctx.entryPath, probe: probePath, cwd, env })
			: await defaultSmokeSpawn({
					entry: ctx.entryPath,
					probe: probePath,
					cwd,
					env,
					timeoutMs: opts.timeoutMs,
					exeDirect: ctx.mode === "binary",
				});
	} finally {
```

Also update the runSmokeCheck doc comment (line ~460-467): change the first bullet `- binary mode → INFO (skipped …)` to `- binary mode → spawns the exe directly; marker "<inline:" counts static-factory tools`.

- [x] **Step 2.4: Run tests, verify pass**

```bash
( cd bun-apps/pi-agent && bun test src/doctor.test.ts )
```

Expected: PASS.

- [x] **Step 2.5: Commit**

```bash
git add bun-apps/pi-agent/src/doctor.ts bun-apps/pi-agent/src/doctor.test.ts
git commit -m "feat(pi-agent): doctor --smoke now runs in compiled-binary mode"
```

---

### Task 3: Fix stale "binary can't load .ts" comments/messages

Behavior-neutral wording fixes. The claim went stale when upstream 0.80.10 added the jiti `virtualModules` binary path (empirically verified: a `-e` probe .ts and hermes-memory both load in the exe).

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/resolve.ts:350-366` (block comment) and `:384` (debug message)
- Modify: `bun-apps/pi-agent/src/ext-doctor.ts:80` (comment)
- Modify: `bun-apps/pi-agent/src/patches/ensure-extension-deps.ts:26` (comment)

- [x] **Step 3.1: resolve.ts block comment** — replace the comment at `run-dir/resolve.ts:350-366` (the block starting `// Compiled-binary mode: \`-e\` extension paths are still a no-op…` down to `…in binary mode.`) with:

```ts
  // Compiled-binary mode: emit NO -e flags — the default extension set ships
  // as STATIC factories instead (src/static-extensions.ts, native in-memory
  // call). Two reasons this stays -e-free even though upstream 0.80.10+ CAN
  // load user `-e <path>.ts` in a compiled binary (jiti virtualModules +
  // tryNative:false — verified live 2026-07-20): (1) the manifest's relative
  // .ts entries don't exist in the $bunfs virtual FS, and (2) import.meta.url
  // is the $bunfs scheme so the absolute-path resolution below would yield
  // garbage (e.g. BUN_APPS_DIR collapsing to "/"). A USER's own -e paths are
  // untouched by this function and load fine.
  //
  // `--skill` paths ARE emitted: @earendil-works/pi-coding-agent's skill
  // reader uses only node:fs — zero jiti — and the embedded-assets patch
  // extracts manifest.binarySkills' directories to a real on-disk dir before
  // this runs. Resolve them against that dir (falling back to the exe's own
  // dir, mirroring how getThemesDir()/getAssetsDir() resolve shipped assets).
```

- [x] **Step 3.2: resolve.ts debug message** — at `run-dir/resolve.ts:384` replace:

```ts
      warn(`compiled-binary mode — extensions can't load here; emitting ${argv.length / 2} --skill flag(s)`);
```

with:

```ts
      warn(`compiled-binary mode — default extensions ship as static factories; emitting ${argv.length / 2} --skill flag(s)`);
```

First check nothing asserts the old string: `grep -rn "can't load here" bun-apps/` — expect only resolve.ts:384. If a test matches it, update the test to the new string.

- [x] **Step 3.3: ext-doctor.ts + ensure-extension-deps.ts comments** — Read the surrounding ~10 lines of each (`src/ext-doctor.ts:80`, `src/patches/ensure-extension-deps.ts:26`), then reword only the stale clause: change claims like "dynamic `-e` extensions can't load in a binary anyway" / "binary mode cannot load .ts extensions at all" to "the binary's default extensions ship as static factories (user `-e` .ts paths do load via upstream's jiti binary path since 0.80.10)". Keep each comment's surrounding rationale intact — the code they justify (skipping manifest resolution / skipping symlink setup in binary mode) is still correct because it concerns the DEFAULT set, not user `-e`.

- [x] **Step 3.4: Run tests + commit**

```bash
( cd bun-apps/pi-agent && bun test )
git add bun-apps/pi-agent/run-dir/resolve.ts bun-apps/pi-agent/src/ext-doctor.ts bun-apps/pi-agent/src/patches/ensure-extension-deps.ts
git commit -m "docs(pi-agent): fix stale 'binary cannot load .ts extensions' comments (0.80.10 jiti binary path)"
```

---

### Task 4: deploy.ts minors — drop unused `IS_BUNDLE`, reject unknown flags

**Files:**
- Modify: `bun-apps/pi-agent/scripts/deploy.ts:62-69`

- [x] **Step 4.1: Edit flag parsing** — replace `scripts/deploy.ts:62-69` (the `// ── Flag parsing` section) with:

```ts
// ── Flag parsing ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--bundle", "--snapshot", "--standalone", "--exe", "--no-freeze"]);
{
	const unknown = argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
	if (unknown.length > 0) {
		console.error(`✗ unknown flag(s): ${unknown.join(", ")}\n  known: ${[...KNOWN_FLAGS].join(", ")}`);
		process.exit(1);
	}
}
const target = argv.find((a) => !a.startsWith("--")) || resolve(process.cwd(), "..", "..", "dist", APP_NAME);
const IS_SNAPSHOT = argv.includes("--snapshot");
const IS_STANDALONE = argv.includes("--standalone");
const IS_EXE = argv.includes("--exe");
const NO_FREEZE = argv.includes("--no-freeze");
```

(This deletes the unused `IS_BUNDLE` const — nothing else references it; verify with `grep -n "IS_BUNDLE" scripts/deploy.ts` → no hits after the edit.)

- [x] **Step 4.2: Verify rejection + normal path still parses**

```bash
( cd bun-apps/pi-agent && bun scripts/deploy.ts /tmp/deploy-flag-test --exee ) ; echo "exit=$?"
```

Expected: `✗ unknown flag(s): --exee`, `exit=1`, and `/tmp/deploy-flag-test` is NOT created.

- [x] **Step 4.3: Commit**

```bash
git add bun-apps/pi-agent/scripts/deploy.ts
git commit -m "fix(deploy): reject unknown --flags; drop unused IS_BUNDLE"
```

---

### Task 5: End-to-end verification on a fresh exe

**Files:** none (build + run only; scratchpad artifacts)

- [x] **Step 5.1: Rebuild the exe**

```bash
( cd bun-apps/pi-agent && bun scripts/deploy.ts "$SCRATCHPAD/dist-exe2" --exe --no-freeze )
```

(`$SCRATCHPAD` = the session scratchpad dir.) Expected: `✓ deployed`.

- [x] **Step 5.2: Re-run the verification matrix** — probe file from the review (`$SCRATCHPAD/probe.ts`, prints `[PROBE] total=N` + `name :: sourceInfo.path` lines at session_start then exits 0). `HM` = `<repo>/bun-apps/pi-agent-ext-hermes-memory/extensions/hermes-memory.ts`.

| # | Command | Expected |
|---|---|---|
| a | `./pi-agent -e probe.ts -p hi` | exit 0, total=31 |
| b | `./pi-agent -ne -e probe.ts -p hi` | exit 0, total=7 (builtins only) |
| c | `BUN_PI_DEBUG_RUN_DIR=1 ./pi-agent -ns -e probe.ts -p hi` | resolved argv `[]` (skills suppressed) |
| d | `./pi-agent -ne -e $HM -e probe.ts -p hi` | exit 0, total=13, hermes tools from disk path |
| e | `./pi-agent -e $HM -e probe.ts -p hi` | **exit 0** (was exit 1) — stderr has `[pi-agent] static extension(s) overridden by user -e: pi-agent-ext-hermes-memory`; hermes tools sourced from the DISK path, no `<inline:pi-agent-ext-hermes-memory>` tools, total=31 |
| f | `./pi-agent doctor --smoke` | runtime-smoke **PASS** with matched>0 (was "smoke skipped") |

- [x] **Step 5.3: Full test suite**

```bash
( cd bun-apps/pi-agent && bun test )
```

Expected: PASS.

- [x] **Step 5.4: Update plan checkboxes + final commit (plan doc)**

```bash
git add docs/superpowers/plans/2026-07-20-exe-e-flag-review-fixes.md
git commit -m "docs(plans): exe -e flag review fixes plan"
```

---

## Self-review notes

- All four review findings map to a task: finding 2 → Task 1, finding 1 → Tasks 2+3, finding 3 → Task 4. Finding 4 (lazy-alias no-op in binary) is deliberately **no action**: `lazyExtensions` is empty today (YAGNI), and Task 3's resolve.ts comment refresh covers the adjacent stale text.
- `overriddenStaticExtensions` naming/signature is consistent between Task 1's test, impl, and cli.ts wiring.
- Task 2's `smokeMarker` return-type narrowing (`string | null` → `string`) removes the only null consumer (the runSmokeCheck skip branch) in the same task — no dangling null-checks.
