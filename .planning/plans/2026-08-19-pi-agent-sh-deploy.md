# pi-agent-sh Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a second, independent deploy pipeline that produces `~/proj/dist/pi-agent-sh/<version>/` containing a minimal compiled `pi-agent` executable (zero extensions inside) plus separately built extension packages under `ext/<name>/` that the executable discovers at runtime — and still boots normally when `ext/` is deleted.

**Architecture:** The core executable owns pi's runtime; extension bundles are built with `bun build --format=cjs` with pi's runtime marked `--external`, and the core evaluates each bundle with an injected `require` that serves its own embedded modules (measured to preserve module identity, which an on-disk resolve does not). A YAML config (`bun-apps/pi-agent/deploy-config.yaml`) is the single source of truth for what gets built. The existing `deploy.ts` four modes are not touched.

**Tech Stack:** Bun 1.3.14 (`bun build --compile`, `bun build --format=cjs`, `Bun.YAML.parse`, `bun test`), TypeScript, the existing devops CLI conventions (pure-JSON stdout, exit 0/1/2).

**Spec:** `.planning/specs/2026-08-19-pi-agent-sh-deploy-design.md` (reachable as `docs/superpowers/specs/…` — that path is a symlink).

---

## Background the engineer needs

**Repo mechanics (from `CLAUDE.md`, non-negotiable):**
- Never `cd` at the top level of a shell command. Use `( cd <dir> && … )`, `--cwd`, or absolute paths.
- Bun workspace root is `bun-apps/`. Run `bun install` from `bun-apps/` only.
- Every command below is written to run from the repo root `/Users/huangziyu/proj/video_generation__deploy`.

**Key existing files to read before starting:**
- `bun-apps/pi-agent/src/cli.ts` — the legacy entry. Lines 118–185 show the exact order: `applyPatches()` → load factories → re-slice argv → `main(mainArgv, { extensionFactories })`. `cli-sh.ts` mirrors this shape.
- `bun-apps/pi-agent/src/static-extensions.ts` — what `cli-sh.ts` deliberately does NOT import.
- `bun-apps/pi-agent-ext-devops/scripts/deploy.ts` — reference for `resolvePiPkgDir()` (line 250) and the `bun build --compile` invocation (line 368).
- `bun-apps/pi-agent-ext-devops/scripts/lib/codegen.ts` — `stageGeneratePkgDir` / `stageGenerateRunDirBase` / `stageGenerateEmbeddedAssets`, reused unchanged by the sh core build.
- `bun-apps/pi-agent-ext-devops/scripts/lib/build-extensions.ts` — `extractBareSpecifiers(code)` is exported and reused by the sh bare-specifier gate.
- `bun-apps/pi-agent-ext-devops/src/sync-cli.ts` — the devops CLI convention (`--help`, JSON stdout, exit codes) that `deploy-sh-cli.ts` follows.

**Measured facts this plan depends on** (already verified — do not re-litigate, but do not assume anything beyond them):
1. A `bun build --compile` binary can `import()` a disk path at runtime, and runs fine when that path is absent.
2. A disk module resolving its own dependency gets a *different* instance than the binary's embedded copy; host injection gets the *same* instance.
3. `bun build --format=cjs` emits `// @bun @bun-cjs` + `(function(exports, require, module, __filename, __dirname){…})`.
4. `(0, eval)(code)` on that output returns the wrapper function, and calling it with an injected `require` works **inside a compiled binary**.
5. `Bun.YAML.parse` exists.

**The five host modules** (derived by scanning the two MVP extensions' non-test imports):

```
@earendil-works/pi-coding-agent   (51 imports)
@earendil-works/pi-tui            (20)
typebox                           (11)
typebox/value                      (2)
@repo/pi-agent-core-runtime       (10)   ← holds cross-extension singletons
```

Everything else the extensions import (`@repo/pi-agent-core-interface`, `@repo/pi-agent-ext-subagent`, `@repo/pi-agent-ext-power-tool/schema-cost`, `js-yaml`, …) is inlined into the extension bundle by the bundler.

---

## File structure

**New — `bun-apps/pi-agent` (the core side):**

| File | Responsibility |
|---|---|
| `src/sh/host-modules.ts` | `HOST_API`, the static module registry, `hostRequire()` |
| `src/sh/host-modules.test.ts` | tests for the above |
| `src/sh/ext-manifest.ts` | pure `ext.json` parse + validation (no fs) |
| `src/sh/ext-manifest.test.ts` | tests for the above |
| `src/sh/ext-loader.ts` | fs discovery, cjs evaluation, factory/skill collection |
| `src/sh/ext-loader.test.ts` | tests for the above |
| `src/cli-sh.ts` | the sh-mode entry point (compiled into the binary) |
| `src/sh/ext-list.ts` | pure formatter for the `--ext-list` diagnostic |
| `src/sh/ext-list.test.ts` | tests for the above |
| `deploy-config.yaml` | deploy source of truth |

**New — `bun-apps/pi-agent-ext-devops` (the build side):**

| File | Responsibility |
|---|---|
| `scripts/lib/sh-config.ts` | YAML parse + validation → typed `ShConfig` |
| `scripts/lib/sh-version.ts` | version string, target dir, `current` symlink, version listing |
| `scripts/lib/sh-fs.ts` | `freezeTree` / `unfreezeTree` / `rmTree` |
| `scripts/lib/sh-ext-build.ts` | build ONE extension → `ext.cjs` + `ext.json` + skills, plus its two gates |
| `scripts/deploy-sh.ts` | orchestrator: staging → core → extensions → verify → promote |
| `src/deploy-sh-argv.ts` | pure argv parser |
| `src/deploy-sh-cli.ts` | CLI wrapper around the orchestrator |
| `tests/sh-config.test.ts`, `tests/sh-version.test.ts`, `tests/sh-ext-build.test.ts`, `tests/deploy-sh-argv.test.ts`, `tests/deploy-sh-e2e.test.ts` | tests |

**Modified:**
- `bun-apps/pi-agent/package.json` — add `@repo/pi-agent-core-runtime` dependency, move `@earendil-works/pi-tui` from devDependencies to dependencies, add the `deploy:sh` script.
- `bun-apps/pi-agent/CONTEXT.md` and `bun-apps/pi-agent/docs/deploy-sh.md` (new doc) — document the new mode.

---

## Task 1: Host module registry

**Files:**
- Create: `bun-apps/pi-agent/src/sh/host-modules.ts`
- Test: `bun-apps/pi-agent/src/sh/host-modules.test.ts`
- Modify: `bun-apps/pi-agent/package.json`

- [ ] **Step 1: Add the two missing deps**

Edit `bun-apps/pi-agent/package.json`: add `"@repo/pi-agent-core-runtime": "workspace:*"` to `dependencies` (alphabetical, next to `@repo/pi-agent-core-interface` if present — otherwise after `@repo/pi-agent-ext-btw`), and MOVE `"@earendil-works/pi-tui": "0.84.2"` from `devDependencies` into `dependencies` (keep the exact `0.84.2` pin — these four `@earendil-works` packages are pinned in lockstep repo-wide).

Then run:

```bash
bun install --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps
```

Expected: install succeeds, `bun-apps/bun.lock` updated. Never run `npm install`.

- [ ] **Step 2: Write the failing test**

Create `bun-apps/pi-agent/src/sh/host-modules.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { HOST_API, HOST_MODULE_IDS, HostModuleNotFoundError, hostRequire } from "./host-modules.ts";

describe("host-modules", () => {
	test("HOST_API is the integer contract version", () => {
		expect(HOST_API).toBe(1);
	});

	test("exposes exactly the whitelisted specifiers", () => {
		expect([...HOST_MODULE_IDS].sort()).toEqual([
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"@repo/pi-agent-core-runtime",
			"typebox",
			"typebox/value",
		]);
	});

	test("hostRequire returns the host's own module instance", () => {
		const mod = hostRequire("typebox") as { Type: unknown };
		expect(mod.Type).toBeDefined();
		// identity: two calls must hand back the SAME object, not a copy
		expect(hostRequire("typebox")).toBe(mod);
	});

	test("hostRequire on pi-coding-agent exposes defineTool", () => {
		const mod = hostRequire("@earendil-works/pi-coding-agent") as { defineTool: unknown };
		expect(typeof mod.defineTool).toBe("function");
	});

	test("hostRequire throws a typed error for an unknown specifier", () => {
		expect(() => hostRequire("left-pad")).toThrow(HostModuleNotFoundError);
		expect(() => hostRequire("left-pad")).toThrow(/left-pad/);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/host-modules.test.ts
```

Expected: FAIL — `Cannot find module './host-modules.ts'`.

- [ ] **Step 4: Implement**

Create `bun-apps/pi-agent/src/sh/host-modules.ts`:

```ts
/**
 * host-modules.ts — the modules the sh-mode core lends to dynamically loaded
 * extensions.
 *
 * WHY THIS EXISTS: an extension bundle that resolves `@earendil-works/pi-tui`
 * from disk gets a DIFFERENT module instance than the one compiled into this
 * binary (measured). pi-agent-ext-task builds TUI overlays and keybindings
 * against the host's running pi-tui, so a second instance breaks
 * identity-sensitive behavior. Extensions are therefore built with these
 * specifiers marked `--external`, and this registry serves them at load time.
 *
 * Every entry MUST be a static `import * as` — only a literal import is inlined
 * by `bun build --compile`; a dynamic or computed import leaves a runtime
 * resolve that crashes inside the binary's virtual filesystem.
 */
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxValue from "typebox/value";
import * as coreRuntime from "@repo/pi-agent-core-runtime";

/**
 * The host↔extension contract version. Bump ONLY on a breaking change to the
 * loader contract (ext.json shape, require semantics, factory shape). Every
 * ext.json declares the version it was built against; a mismatch skips that
 * extension instead of half-loading it.
 */
export const HOST_API = 1;

const REGISTRY: Readonly<Record<string, unknown>> = Object.freeze({
	"@earendil-works/pi-coding-agent": piCodingAgent,
	"@earendil-works/pi-tui": piTui,
	typebox: typebox,
	"typebox/value": typeboxValue,
	"@repo/pi-agent-core-runtime": coreRuntime,
});

/** Specifiers an extension may require. Also the `--external` set at build time. */
export const HOST_MODULE_IDS: readonly string[] = Object.freeze(Object.keys(REGISTRY));

export class HostModuleNotFoundError extends Error {
	constructor(spec: string) {
		super(
			`[pi-agent-sh] extension required "${spec}", which the host does not provide. ` +
				`Host modules: ${HOST_MODULE_IDS.join(", ")}. ` +
				`Either the extension was built against a different host, or the bundler failed to inline it.`,
		);
		this.name = "HostModuleNotFoundError";
	}
}

/** The `require` handed to every extension bundle. Never touches the filesystem. */
export function hostRequire(spec: string): unknown {
	if (!Object.hasOwn(REGISTRY, spec)) throw new HostModuleNotFoundError(spec);
	return REGISTRY[spec];
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/host-modules.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Typecheck**

```bash
bun run --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent typecheck
```

Expected: no errors. If `typebox/value` or `@repo/pi-agent-core-runtime` has no type declarations, add `// @ts-expect-error — no bundled types` ONLY on that one import line and note it in the file comment; do not add `@ts-nocheck` to the file.

- [ ] **Step 7: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent/src/sh/host-modules.ts bun-apps/pi-agent/src/sh/host-modules.test.ts bun-apps/pi-agent/package.json bun-apps/bun.lock
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(pi-agent): host module registry for sh-mode extension loading"
```

---

## Task 2: ext.json parsing and validation (pure)

**Files:**
- Create: `bun-apps/pi-agent/src/sh/ext-manifest.ts`
- Test: `bun-apps/pi-agent/src/sh/ext-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/src/sh/ext-manifest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseExtManifest } from "./ext-manifest.ts";

const HOST = { hostApi: 1, hostModules: ["typebox", "@earendil-works/pi-tui"] };

function valid(overrides: Record<string, unknown> = {}) {
	return {
		name: "power-tool",
		package: "@repo/pi-agent-ext-power-tool",
		version: "0.1.0",
		hostApi: 1,
		entry: "ext.cjs",
		order: 50,
		enabled: true,
		skills: ["skills"],
		hostModules: ["typebox"],
		builtAt: "2026-08-19T20:13:00Z",
		sourceSha: "520acb928",
		...overrides,
	};
}

describe("parseExtManifest", () => {
	test("accepts a valid manifest", () => {
		const r = parseExtManifest(valid(), "power-tool", HOST);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.manifest.name).toBe("power-tool");
			expect(r.manifest.order).toBe(50);
			expect(r.manifest.skills).toEqual(["skills"]);
		}
	});

	test("defaults enabled/order/skills when absent", () => {
		const m = valid();
		delete (m as Record<string, unknown>).enabled;
		delete (m as Record<string, unknown>).order;
		delete (m as Record<string, unknown>).skills;
		const r = parseExtManifest(m, "power-tool", HOST);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.manifest.enabled).toBe(true);
			expect(r.manifest.order).toBe(100);
			expect(r.manifest.skills).toEqual([]);
		}
	});

	test("rejects a name that disagrees with the directory", () => {
		const r = parseExtManifest(valid({ name: "other" }), "power-tool", HOST);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/name "other" does not match directory "power-tool"/);
	});

	test("rejects a hostApi mismatch", () => {
		const r = parseExtManifest(valid({ hostApi: 2 }), "power-tool", HOST);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/hostApi 2 .* host provides 1/);
	});

	test("rejects a host module the host does not provide", () => {
		const r = parseExtManifest(valid({ hostModules: ["typebox", "left-pad"] }), "power-tool", HOST);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/left-pad/);
	});

	test("rejects an entry that escapes the extension directory", () => {
		for (const entry of ["../evil.cjs", "/abs/evil.cjs", "nested/../../evil.cjs"]) {
			const r = parseExtManifest(valid({ entry }), "power-tool", HOST);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(/entry/);
		}
	});

	test("rejects a skills path that escapes the extension directory", () => {
		const r = parseExtManifest(valid({ skills: ["../../etc"] }), "power-tool", HOST);
		expect(r.ok).toBe(false);
	});

	test("reports disabled as a non-error skip", () => {
		const r = parseExtManifest(valid({ enabled: false }), "power-tool", HOST);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.manifest.enabled).toBe(false);
	});

	test("rejects a non-object payload", () => {
		expect(parseExtManifest(null, "x", HOST).ok).toBe(false);
		expect(parseExtManifest("nope", "x", HOST).ok).toBe(false);
		expect(parseExtManifest([], "x", HOST).ok).toBe(false);
	});

	test("rejects missing required fields", () => {
		for (const field of ["name", "version", "hostApi", "entry"]) {
			const m = valid();
			delete (m as Record<string, unknown>)[field];
			const r = parseExtManifest(m, "power-tool", HOST);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(new RegExp(field));
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/ext-manifest.test.ts
```

Expected: FAIL — `Cannot find module './ext-manifest.ts'`.

- [ ] **Step 3: Implement**

Create `bun-apps/pi-agent/src/sh/ext-manifest.ts`:

```ts
/**
 * ext-manifest.ts — pure parse + validation of an extension package's ext.json.
 *
 * Deliberately fs-free and side-effect-free: the loader reads the file, this
 * decides whether the extension is loadable. Validation happens BEFORE any of
 * the extension's code is evaluated, so an incompatible or hostile manifest
 * never gets to run.
 */

/** Shape written by the deploy and read by the loader. */
export interface ExtManifest {
	name: string;
	package: string;
	version: string;
	hostApi: number;
	entry: string;
	order: number;
	enabled: boolean;
	skills: string[];
	hostModules: string[];
	builtAt?: string;
	sourceSha?: string;
}

export interface HostContract {
	hostApi: number;
	hostModules: readonly string[];
}

export type ParseResult =
	| { ok: true; manifest: ExtManifest }
	| { ok: false; reason: string };

/** A relative path that stays inside the extension dir: no absolute, no `..` segment. */
function isContainedRelPath(p: string): boolean {
	if (typeof p !== "string" || p.length === 0) return false;
	if (p.startsWith("/")) return false;
	return !p.split("/").includes("..");
}

export function parseExtManifest(raw: unknown, dirName: string, host: HostContract): ParseResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "ext.json is not a JSON object" };
	}
	const m = raw as Record<string, unknown>;

	for (const field of ["name", "package", "version", "entry"]) {
		if (typeof m[field] !== "string" || (m[field] as string).length === 0) {
			return { ok: false, reason: `ext.json field "${field}" is missing or not a string` };
		}
	}
	if (typeof m.hostApi !== "number" || !Number.isInteger(m.hostApi)) {
		return { ok: false, reason: `ext.json field "hostApi" is missing or not an integer` };
	}
	if (m.name !== dirName) {
		return { ok: false, reason: `ext.json name "${String(m.name)}" does not match directory "${dirName}"` };
	}
	if (m.hostApi !== host.hostApi) {
		return {
			ok: false,
			reason: `built for hostApi ${m.hostApi}, host provides ${host.hostApi}`,
		};
	}
	if (!isContainedRelPath(m.entry as string)) {
		return { ok: false, reason: `ext.json entry "${String(m.entry)}" must be a relative path inside the extension dir` };
	}

	const skills = m.skills === undefined ? [] : m.skills;
	if (!Array.isArray(skills) || !skills.every((s) => isContainedRelPath(s as string))) {
		return { ok: false, reason: `ext.json skills must be relative paths inside the extension dir` };
	}

	const hostModules = m.hostModules === undefined ? [] : m.hostModules;
	if (!Array.isArray(hostModules) || !hostModules.every((s) => typeof s === "string")) {
		return { ok: false, reason: `ext.json hostModules must be an array of strings` };
	}
	const missing = (hostModules as string[]).filter((s) => !host.hostModules.includes(s));
	if (missing.length > 0) {
		return { ok: false, reason: `requires host module(s) this host does not provide: ${missing.join(", ")}` };
	}

	const order = m.order === undefined ? 100 : m.order;
	if (typeof order !== "number" || !Number.isFinite(order)) {
		return { ok: false, reason: `ext.json order must be a number` };
	}
	const enabled = m.enabled === undefined ? true : m.enabled;
	if (typeof enabled !== "boolean") {
		return { ok: false, reason: `ext.json enabled must be a boolean` };
	}

	return {
		ok: true,
		manifest: {
			name: m.name as string,
			package: m.package as string,
			version: m.version as string,
			hostApi: m.hostApi,
			entry: m.entry as string,
			order,
			enabled,
			skills: skills as string[],
			hostModules: hostModules as string[],
			builtAt: typeof m.builtAt === "string" ? m.builtAt : undefined,
			sourceSha: typeof m.sourceSha === "string" ? m.sourceSha : undefined,
		},
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/ext-manifest.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent/src/sh/ext-manifest.ts bun-apps/pi-agent/src/sh/ext-manifest.test.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(pi-agent): ext.json parse + validation for sh-mode extensions"
```

---

## Task 3: The extension loader

**Files:**
- Create: `bun-apps/pi-agent/src/sh/ext-loader.ts`
- Test: `bun-apps/pi-agent/src/sh/ext-loader.test.ts`

The loader takes an explicit `extRoot` and an injected `require` so it is testable without a compiled binary.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/src/sh/ext-loader.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensions } from "./ext-loader.ts";

const HOST = { hostApi: 1, hostModules: ["typebox"] };
const roots: string[] = [];

function makeRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "sh-ext-"));
	roots.push(dir);
	return dir;
}

/** Write an extension dir whose bundle mimics bun's cjs wrapper shape. */
function writeExt(
	root: string,
	name: string,
	opts: { manifest?: Record<string, unknown>; body?: string; skipBundle?: boolean } = {},
) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const manifest = {
		name,
		package: `@repo/pi-agent-ext-${name}`,
		version: "0.1.0",
		hostApi: 1,
		entry: "ext.cjs",
		hostModules: [],
		...opts.manifest,
	};
	writeFileSync(join(dir, "ext.json"), JSON.stringify(manifest));
	if (!opts.skipBundle) {
		const body =
			opts.body ??
			`module.exports.default = function factory(){ return { name: ${JSON.stringify(name)} }; };`;
		writeFileSync(
			join(dir, "ext.cjs"),
			`// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {\n${body}\n})\n`,
		);
	}
	return dir;
}

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("loadExtensions", () => {
	test("returns nothing when the ext root does not exist", () => {
		const r = loadExtensions({ extRoot: join(makeRoot(), "absent"), host: HOST, require: () => ({}) });
		expect(r.factories).toEqual([]);
		expect(r.skillPaths).toEqual([]);
		expect(r.skipped).toEqual([]);
	});

	test("loads an extension and returns its factory", () => {
		const root = makeRoot();
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.factories).toHaveLength(1);
		expect(r.factories[0]!.name).toBe("alpha");
		expect(typeof r.factories[0]!.factory).toBe("function");
	});

	test("sorts by order then name", () => {
		const root = makeRoot();
		writeExt(root, "charlie", { manifest: { order: 10 } });
		writeExt(root, "alpha", { manifest: { order: 50 } });
		writeExt(root, "bravo", { manifest: { order: 50 } });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["charlie", "alpha", "bravo"]);
	});

	test("ignores a directory with no ext.json without reporting a skip", () => {
		const root = makeRoot();
		mkdirSync(join(root, "not-an-extension"), { recursive: true });
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.skipped).toEqual([]);
	});

	test("skips unparseable ext.json but keeps the rest", () => {
		const root = makeRoot();
		mkdirSync(join(root, "broken"), { recursive: true });
		writeFileSync(join(root, "broken", "ext.json"), "{ not json");
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.skipped.map((s) => s.name)).toEqual(["broken"]);
		expect(r.skipped[0]!.reason).toMatch(/JSON/i);
	});

	test("skips a hostApi mismatch", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { manifest: { hostApi: 99 } });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/hostApi 99/);
	});

	test("skips a disabled extension", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { manifest: { enabled: false } });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/disabled/);
	});

	test("skips when the entry file is missing", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { skipBundle: true });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/entry file/);
	});

	test("skips a bundle that throws at evaluation, keeping the rest", () => {
		const root = makeRoot();
		writeExt(root, "boom", { body: `throw new Error("kaboom");` });
		writeExt(root, "alpha");
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual(["alpha"]);
		expect(r.skipped.map((s) => s.name)).toEqual(["boom"]);
		expect(r.skipped[0]!.reason).toMatch(/kaboom/);
	});

	test("skips a bundle whose default export is not a function", () => {
		const root = makeRoot();
		writeExt(root, "alpha", { body: `module.exports.default = 42;` });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.loaded).toEqual([]);
		expect(r.skipped[0]!.reason).toMatch(/default export/);
	});

	test("passes the injected require through to the bundle", () => {
		const root = makeRoot();
		writeExt(root, "alpha", {
			manifest: { hostModules: ["typebox"] },
			body: `const t = require("typebox"); module.exports.default = () => ({ got: t.marker });`,
		});
		const r = loadExtensions({
			extRoot: root,
			host: HOST,
			require: (spec) => (spec === "typebox" ? { marker: "host" } : (() => { throw new Error("no"); })()),
		});
		expect(r.factories[0]!.factory({} as never)).toEqual({ got: "host" });
	});

	test("returns absolute skill paths that exist", () => {
		const root = makeRoot();
		const dir = writeExt(root, "alpha", { manifest: { skills: ["skills", "gone"] } });
		mkdirSync(join(dir, "skills"), { recursive: true });
		const r = loadExtensions({ extRoot: root, host: HOST, require: () => ({}) });
		expect(r.skillPaths).toEqual([join(dir, "skills")]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/ext-loader.test.ts
```

Expected: FAIL — `Cannot find module './ext-loader.ts'`.

- [ ] **Step 3: Implement**

Create `bun-apps/pi-agent/src/sh/ext-loader.ts`:

```ts
/**
 * ext-loader.ts — discovers and loads sh-mode extension packages from
 * <deployDir>/ext/<name>/.
 *
 * CONTRACT: every failure is local. A missing ext root, a corrupt ext.json, an
 * incompatible hostApi, a throwing bundle — each skips exactly one extension
 * and is reported in `skipped`; the core always boots. Requirement (2) of the
 * design ("deleting ext/ still runs") is this function returning empty arrays.
 *
 * The cjs wrapper: extension bundles are built with `bun build --format=cjs`,
 * whose output is `// @bun @bun-cjs` followed by
 * `(function(exports, require, module, __filename, __dirname){…})`. Evaluating
 * that text yields the wrapper function, which we call with OUR require —
 * verified to work inside a `bun build --compile` binary.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseExtManifest, type ExtManifest, type HostContract } from "./ext-manifest.ts";

/** The shape pi's `main({ extensionFactories })` consumes. */
export interface LoadedExtension {
	name: string;
	factory: (...args: never[]) => unknown;
}

export interface SkippedExtension {
	name: string;
	reason: string;
}

export interface LoadResult {
	factories: LoadedExtension[];
	skillPaths: string[];
	loaded: string[];
	skipped: SkippedExtension[];
}

export interface LoadOptions {
	/** Absolute path to the `ext` directory. */
	extRoot: string;
	host: HostContract;
	/** Module provider handed to each bundle (production: hostRequire). */
	require: (spec: string) => unknown;
}

interface Candidate {
	dir: string;
	manifest: ExtManifest;
}

/** Evaluate a bun cjs bundle and return its module.exports. */
export function evaluateExtModule(
	code: string,
	filename: string,
	dirname: string,
	requireFn: (spec: string) => unknown,
): Record<string, unknown> {
	// Indirect eval keeps the bundle out of this module's scope.
	const wrapper = (0, eval)(code);
	if (typeof wrapper !== "function") {
		throw new Error(
			"bundle is not a cjs wrapper function — expected `bun build --format=cjs` output",
		);
	}
	const mod = { exports: {} as Record<string, unknown> };
	wrapper(mod.exports, requireFn, mod, filename, dirname);
	return mod.exports;
}

export function loadExtensions(opts: LoadOptions): LoadResult {
	const result: LoadResult = { factories: [], skillPaths: [], loaded: [], skipped: [] };
	if (!existsSync(opts.extRoot)) return result;

	// ── Phase 1: read + validate every manifest (no extension code runs yet) ──
	const candidates: Candidate[] = [];
	let entries: string[];
	try {
		entries = readdirSync(opts.extRoot);
	} catch (e) {
		result.skipped.push({ name: "*", reason: `cannot read ext root: ${errMsg(e)}` });
		return result;
	}
	for (const name of entries.sort()) {
		const dir = join(opts.extRoot, name);
		const manifestPath = join(dir, "ext.json");
		// A directory with no ext.json is not an extension — ignore it silently.
		if (!existsSync(manifestPath)) continue;

		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch (e) {
			result.skipped.push({ name, reason: `ext.json is not valid JSON: ${errMsg(e)}` });
			continue;
		}
		const parsed = parseExtManifest(raw, name, opts.host);
		if (!parsed.ok) {
			result.skipped.push({ name, reason: parsed.reason });
			continue;
		}
		if (!parsed.manifest.enabled) {
			result.skipped.push({ name, reason: "disabled in ext.json" });
			continue;
		}
		if (!existsSync(join(dir, parsed.manifest.entry))) {
			result.skipped.push({ name, reason: `entry file not found: ${parsed.manifest.entry}` });
			continue;
		}
		candidates.push({ dir, manifest: parsed.manifest });
	}

	// ── Phase 2: load in (order, name) order ────────────────────────────────
	candidates.sort((a, b) =>
		a.manifest.order !== b.manifest.order
			? a.manifest.order - b.manifest.order
			: a.manifest.name.localeCompare(b.manifest.name),
	);

	for (const { dir, manifest } of candidates) {
		const entryPath = join(dir, manifest.entry);
		try {
			const exports = evaluateExtModule(
				readFileSync(entryPath, "utf8"),
				entryPath,
				dir,
				opts.require,
			);
			const factory = exports.default;
			if (typeof factory !== "function") {
				result.skipped.push({ name: manifest.name, reason: "bundle has no callable default export" });
				continue;
			}
			result.factories.push({ name: manifest.name, factory: factory as LoadedExtension["factory"] });
			result.loaded.push(manifest.name);
			for (const rel of manifest.skills) {
				const abs = join(dir, rel);
				if (existsSync(abs)) result.skillPaths.push(abs);
			}
		} catch (e) {
			result.skipped.push({ name: manifest.name, reason: errMsg(e) });
		}
	}

	return result;
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/ext-loader.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent/src/sh/ext-loader.ts bun-apps/pi-agent/src/sh/ext-loader.test.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(pi-agent): sh-mode extension loader with per-extension failure isolation"
```

---

## Task 4: `--ext-list` diagnostic formatter

**Files:**
- Create: `bun-apps/pi-agent/src/sh/ext-list.ts`
- Test: `bun-apps/pi-agent/src/sh/ext-list.test.ts`

This is the pure half of the deploy's dual-state smoke gate, kept out of `cli-sh.ts` so it is testable.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/src/sh/ext-list.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatExtList } from "./ext-list.ts";
import type { LoadResult } from "./ext-loader.ts";

const empty: LoadResult = { factories: [], skillPaths: [], loaded: [], skipped: [] };

describe("formatExtList", () => {
	test("emits parseable JSON with the counts", () => {
		const r: LoadResult = {
			...empty,
			loaded: ["task", "power-tool"],
			skillPaths: ["/d/ext/power-tool/skills"],
			skipped: [{ name: "old", reason: "built for hostApi 0, host provides 1" }],
		};
		const parsed = JSON.parse(formatExtList("/d/ext", 1, r));
		expect(parsed).toEqual({
			extRoot: "/d/ext",
			hostApi: 1,
			loadedCount: 2,
			loaded: ["task", "power-tool"],
			skillPaths: ["/d/ext/power-tool/skills"],
			skipped: [{ name: "old", reason: "built for hostApi 0, host provides 1" }],
		});
	});

	test("zero extensions is a valid, non-error report", () => {
		const parsed = JSON.parse(formatExtList("/d/ext", 1, empty));
		expect(parsed.loadedCount).toBe(0);
		expect(parsed.loaded).toEqual([]);
		expect(parsed.skipped).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/ext-list.test.ts
```

Expected: FAIL — `Cannot find module './ext-list.ts'`.

- [ ] **Step 3: Implement**

Create `bun-apps/pi-agent/src/sh/ext-list.ts`:

```ts
/**
 * ext-list.ts — the `--ext-list` diagnostic payload.
 *
 * This is what the deploy's dual-state smoke gate asserts on: once with the
 * extensions present (expects them loaded), once with ext/ moved aside
 * (expects loadedCount 0 and exit 0).
 */
import type { LoadResult } from "./ext-loader.ts";

export function formatExtList(extRoot: string, hostApi: number, r: LoadResult): string {
	return JSON.stringify(
		{
			extRoot,
			hostApi,
			loadedCount: r.loaded.length,
			loaded: r.loaded,
			skillPaths: r.skillPaths,
			skipped: r.skipped,
		},
		null,
		2,
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent src/sh/ext-list.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent/src/sh/ext-list.ts bun-apps/pi-agent/src/sh/ext-list.test.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(pi-agent): --ext-list diagnostic payload formatter"
```

---

## Task 5: The sh-mode entry point

**Files:**
- Create: `bun-apps/pi-agent/src/cli-sh.ts`

There is no unit test for this file — it is an entry point whose logic lives in the four tested modules above. Its behavior is covered by the deploy's smoke gate (Task 9) and the e2e test (Task 11).

- [ ] **Step 1: Implement**

Create `bun-apps/pi-agent/src/cli-sh.ts`:

```ts
#!/usr/bin/env bun
/**
 * cli-sh.ts — the sh-mode entry point: a MINIMAL pi-agent core.
 *
 * Differences from src/cli.ts (which stays the entry for the four legacy
 * deploy modes and for source runs):
 *   • It does NOT import src/static-extensions.ts. Zero extensions are
 *     compiled in; every extension is discovered at runtime under
 *     <exeDir>/ext/<name>/.
 *   • It disables the run-dir resource patch — sh mode owns extension and skill
 *     resolution end to end, and the run-dir resolver's repo-relative view has
 *     no meaning in a versioned deploy dir.
 *
 * Deleting <exeDir>/ext entirely is a supported state: the loader returns empty
 * arrays and pi starts with no extensions.
 */
import { main } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { applyPatches } from "./patches/index.ts";
import { userSuppressFlags } from "./cli-argv.ts";
import { HOST_API, HOST_MODULE_IDS, hostRequire } from "./sh/host-modules.ts";
import { loadExtensions } from "./sh/ext-loader.ts";
import { formatExtList } from "./sh/ext-list.ts";

// sh mode resolves its own extensions and skills; the run-dir patch would
// splice build-machine repo paths that do not exist in a deployed tree.
// `??=` so an operator can still force it back on for debugging.
process.env.BUN_PI_LOAD_RUN_DIR ??= "0";

const argv = process.argv.slice(2);

/**
 * The deploy root is the directory holding this executable. In a compiled
 * binary process.execPath IS the deployed pi-agent; running this file from
 * source (`bun src/cli-sh.ts`) would point at bun's own directory instead, so
 * PI_AGENT_SH_EXT_DIR exists as an explicit override for source-mode debugging.
 */
const deployDir = dirname(process.execPath);
const extRoot = process.env.PI_AGENT_SH_EXT_DIR ?? join(deployDir, "ext");

const host = { hostApi: HOST_API, hostModules: HOST_MODULE_IDS };
const suppressed = userSuppressFlags(argv).noExtensions;
const loaded = suppressed
	? { factories: [], skillPaths: [], loaded: [], skipped: [] }
	: loadExtensions({ extRoot, host, require: hostRequire });

// `--ext-list`: print what was discovered and exit. This is the executable
// proof gate the deploy runs in both states (extensions present / ext removed).
if (argv.includes("--ext-list")) {
	console.log(formatExtList(extRoot, HOST_API, loaded));
	process.exit(0);
}

for (const s of loaded.skipped) {
	console.error(`[pi-agent-sh] skipped extension "${s.name}": ${s.reason}`);
}

await applyPatches();

// Skills are passed the same way pi accepts them everywhere else: absolute
// --skill paths on the argv it parses.
const mainArgv = [...argv];
for (const p of loaded.skillPaths) mainArgv.push("--skill", p);

await main(mainArgv, {
	extensionFactories: loaded.factories,
});
```

- [ ] **Step 2: Verify it compiles at all (fast feedback before the real deploy exists)**

```bash
bun build --compile /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent/src/cli-sh.ts \
  --outfile /private/tmp/claude-501/-Users-huangziyu-proj-video-generation--deploy/9b47b5f6-0537-49ee-94c7-4bc20c5e00a0/scratchpad/pi-agent-sh-probe
```

Expected: compile succeeds. Then:

```bash
/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--deploy/9b47b5f6-0537-49ee-94c7-4bc20c5e00a0/scratchpad/pi-agent-sh-probe --ext-list
```

Expected: JSON with `"loadedCount": 0` and exit 0 (there is no `ext/` beside the probe binary). If compilation fails on a missing `src/generated/*` file, that is expected at this stage — Task 9 runs the codegen before compiling; note it and move on.

- [ ] **Step 3: Typecheck**

```bash
bun run --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent/src/cli-sh.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(pi-agent): cli-sh.ts — minimal core entry with runtime extension discovery"
```

---

## Task 6: Deploy config file + parser

**Files:**
- Create: `bun-apps/pi-agent/deploy-config.yaml`
- Create: `bun-apps/pi-agent-ext-devops/scripts/lib/sh-config.ts`
- Test: `bun-apps/pi-agent-ext-devops/tests/sh-config.test.ts`

- [ ] **Step 1: Write the config file**

Create `bun-apps/pi-agent/deploy-config.yaml`:

```yaml
# deploy-config.yaml — source of truth for the pi-agent-sh deploy.
#
# Consumed by bun-apps/pi-agent-ext-devops/scripts/deploy-sh.ts.
# CLI flags override these values; this file never overrides an explicit flag.
#
# hostApi MUST match HOST_API in bun-apps/pi-agent/src/sh/host-modules.ts, and
# hostModules MUST match HOST_MODULE_IDS there — the deploy hard-fails on drift,
# because a config that promises a module the core does not embed produces
# extensions that silently refuse to load.
outRoot: ~/proj/dist/pi-agent-sh
version:
  from: package.json
  gitSha: true
freeze: true
current: true
hostApi: 1
hostModules:
  - "@earendil-works/pi-coding-agent"
  - "@earendil-works/pi-tui"
  - "typebox"
  - "typebox/value"
  - "@repo/pi-agent-core-runtime"
extensions:
  - name: task
    package: pi-agent-ext-task
    entry: extensions/task.ts
    order: 10
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
    order: 50
    skills: [skills]
```

- [ ] **Step 2: Write the failing test**

Create `bun-apps/pi-agent-ext-devops/tests/sh-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseShConfig } from "../scripts/lib/sh-config.ts";

const BUN_APPS = join(import.meta.dir, "..", "..");

const MINIMAL = `
outRoot: ~/proj/dist/pi-agent-sh
hostApi: 1
hostModules: ["typebox"]
extensions:
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
`;

describe("parseShConfig", () => {
	test("parses a minimal config and expands ~", () => {
		const cfg = parseShConfig(MINIMAL, { bunAppsDir: BUN_APPS });
		expect(cfg.outRoot).toBe(join(homedir(), "proj/dist/pi-agent-sh"));
		expect(cfg.hostApi).toBe(1);
		expect(cfg.extensions).toHaveLength(1);
	});

	test("applies defaults", () => {
		const cfg = parseShConfig(MINIMAL, { bunAppsDir: BUN_APPS });
		expect(cfg.freeze).toBe(true);
		expect(cfg.current).toBe(true);
		expect(cfg.version).toEqual({ from: "package.json", gitSha: true });
		expect(cfg.extensions[0]!.order).toBe(100);
		expect(cfg.extensions[0]!.skills).toEqual([]);
	});

	test("rejects an unknown top-level key", () => {
		expect(() => parseShConfig(`${MINIMAL}\nfreze: true\n`, { bunAppsDir: BUN_APPS })).toThrow(
			/unknown config key "freze"/,
		);
	});

	test("rejects an unknown extension key", () => {
		const bad = MINIMAL.replace("entry: extensions/power-tool.ts", "entry: extensions/power-tool.ts\n    skils: [skills]");
		expect(() => parseShConfig(bad, { bunAppsDir: BUN_APPS })).toThrow(/unknown extension key "skils"/);
	});

	test("rejects a package that does not exist under bun-apps", () => {
		const bad = MINIMAL.replace("pi-agent-ext-power-tool", "pi-agent-ext-nope");
		expect(() => parseShConfig(bad, { bunAppsDir: BUN_APPS })).toThrow(/pi-agent-ext-nope/);
	});

	test("rejects an entry file that does not exist", () => {
		const bad = MINIMAL.replace("extensions/power-tool.ts", "extensions/ghost.ts");
		expect(() => parseShConfig(bad, { bunAppsDir: BUN_APPS })).toThrow(/ghost\.ts/);
	});

	test("rejects duplicate extension names", () => {
		const dup = `${MINIMAL}
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
`;
		expect(() => parseShConfig(dup, { bunAppsDir: BUN_APPS })).toThrow(/duplicate extension name/);
	});

	test("rejects an empty extensions list", () => {
		expect(() =>
			parseShConfig(`outRoot: /tmp/x\nhostApi: 1\nhostModules: ["typebox"]\nextensions: []\n`, {
				bunAppsDir: BUN_APPS,
			}),
		).toThrow(/at least one extension/);
	});

	test("the real repo config parses and matches the core's host contract", () => {
		const text = require("node:fs").readFileSync(join(BUN_APPS, "pi-agent", "deploy-config.yaml"), "utf8");
		const cfg = parseShConfig(text, { bunAppsDir: BUN_APPS });
		const { HOST_API, HOST_MODULE_IDS } = require("../../pi-agent/src/sh/host-modules.ts");
		expect(cfg.hostApi).toBe(HOST_API);
		expect([...cfg.hostModules].sort()).toEqual([...HOST_MODULE_IDS].sort());
		expect(cfg.extensions.map((e) => e.name).sort()).toEqual(["power-tool", "task"]);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/sh-config.test.ts
```

Expected: FAIL — `Cannot find module '../scripts/lib/sh-config.ts'`.

- [ ] **Step 4: Implement**

Create `bun-apps/pi-agent-ext-devops/scripts/lib/sh-config.ts`:

```ts
/**
 * sh-config.ts — parse + validate bun-apps/pi-agent/deploy-config.yaml.
 *
 * Strict on purpose: an unknown key is an error, not a silent no-op. A typo in
 * a deploy config that silently does nothing is the failure mode this rejects.
 * Uses Bun.YAML.parse — no dependency needed.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ShExtConfig {
	name: string;
	/** Directory name under bun-apps/, e.g. "pi-agent-ext-power-tool". */
	package: string;
	/** Entry file relative to the package dir, e.g. "extensions/power-tool.ts". */
	entry: string;
	order: number;
	/** Skill dirs relative to the package dir, copied into the deployed ext dir. */
	skills: string[];
	enabled: boolean;
}

export interface ShConfig {
	outRoot: string;
	version: { from: "package.json"; gitSha: boolean };
	freeze: boolean;
	current: boolean;
	hostApi: number;
	hostModules: string[];
	extensions: ShExtConfig[];
}

const TOP_KEYS = new Set(["outRoot", "version", "freeze", "current", "hostApi", "hostModules", "extensions"]);
const EXT_KEYS = new Set(["name", "package", "entry", "order", "skills", "enabled"]);

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function parseShConfig(text: string, opts: { bunAppsDir: string }): ShConfig {
	const raw = Bun.YAML.parse(text) as Record<string, unknown> | null;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("deploy-config.yaml must be a YAML mapping");
	}
	for (const k of Object.keys(raw)) {
		if (!TOP_KEYS.has(k)) throw new Error(`unknown config key "${k}" (known: ${[...TOP_KEYS].join(", ")})`);
	}

	if (typeof raw.outRoot !== "string" || raw.outRoot.length === 0) {
		throw new Error(`config key "outRoot" is required and must be a string`);
	}
	const outRoot = expandHome(raw.outRoot);
	if (!isAbsolute(outRoot)) throw new Error(`outRoot must resolve to an absolute path, got "${outRoot}"`);

	if (typeof raw.hostApi !== "number" || !Number.isInteger(raw.hostApi)) {
		throw new Error(`config key "hostApi" is required and must be an integer`);
	}
	if (!Array.isArray(raw.hostModules) || raw.hostModules.length === 0 || !raw.hostModules.every((m) => typeof m === "string")) {
		throw new Error(`config key "hostModules" is required and must be a non-empty array of strings`);
	}

	const versionRaw = (raw.version ?? {}) as Record<string, unknown>;
	for (const k of Object.keys(versionRaw)) {
		if (k !== "from" && k !== "gitSha") throw new Error(`unknown version key "${k}" (known: from, gitSha)`);
	}
	if (versionRaw.from !== undefined && versionRaw.from !== "package.json") {
		throw new Error(`version.from currently supports only "package.json"`);
	}

	if (!Array.isArray(raw.extensions) || raw.extensions.length === 0) {
		throw new Error(`config key "extensions" must list at least one extension`);
	}

	const seen = new Set<string>();
	const extensions: ShExtConfig[] = raw.extensions.map((e, i) => {
		if (e === null || typeof e !== "object" || Array.isArray(e)) {
			throw new Error(`extensions[${i}] must be a mapping`);
		}
		const ext = e as Record<string, unknown>;
		for (const k of Object.keys(ext)) {
			if (!EXT_KEYS.has(k)) throw new Error(`unknown extension key "${k}" (known: ${[...EXT_KEYS].join(", ")})`);
		}
		for (const field of ["name", "package", "entry"]) {
			if (typeof ext[field] !== "string" || (ext[field] as string).length === 0) {
				throw new Error(`extensions[${i}].${field} is required and must be a string`);
			}
		}
		const name = ext.name as string;
		if (seen.has(name)) throw new Error(`duplicate extension name "${name}"`);
		seen.add(name);

		const pkgDir = resolve(opts.bunAppsDir, ext.package as string);
		if (!existsSync(pkgDir)) throw new Error(`extensions[${i}] package dir not found: ${pkgDir}`);
		const entryAbs = resolve(pkgDir, ext.entry as string);
		if (!existsSync(entryAbs)) throw new Error(`extensions[${i}] entry not found: ${entryAbs}`);

		const skills = ext.skills === undefined ? [] : ext.skills;
		if (!Array.isArray(skills) || !skills.every((s) => typeof s === "string")) {
			throw new Error(`extensions[${i}].skills must be an array of strings`);
		}
		for (const s of skills as string[]) {
			if (!existsSync(resolve(pkgDir, s))) throw new Error(`extensions[${i}] skills dir not found: ${resolve(pkgDir, s)}`);
		}

		const order = ext.order === undefined ? 100 : ext.order;
		if (typeof order !== "number" || !Number.isFinite(order)) {
			throw new Error(`extensions[${i}].order must be a number`);
		}
		const enabled = ext.enabled === undefined ? true : ext.enabled;
		if (typeof enabled !== "boolean") throw new Error(`extensions[${i}].enabled must be a boolean`);

		return { name, package: ext.package as string, entry: ext.entry as string, order, skills: skills as string[], enabled };
	});

	return {
		outRoot,
		version: {
			from: "package.json",
			gitSha: versionRaw.gitSha === undefined ? true : versionRaw.gitSha === true,
		},
		freeze: raw.freeze === undefined ? true : raw.freeze === true,
		current: raw.current === undefined ? true : raw.current === true,
		hostApi: raw.hostApi,
		hostModules: raw.hostModules as string[],
		extensions,
	};
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/sh-config.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent/deploy-config.yaml bun-apps/pi-agent-ext-devops/scripts/lib/sh-config.ts bun-apps/pi-agent-ext-devops/tests/sh-config.test.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(devops): deploy-config.yaml + strict parser for the pi-agent-sh deploy"
```

---

## Task 7: Version, target directory, freeze, `current` symlink

**Files:**
- Create: `bun-apps/pi-agent-ext-devops/scripts/lib/sh-fs.ts`
- Create: `bun-apps/pi-agent-ext-devops/scripts/lib/sh-version.ts`
- Test: `bun-apps/pi-agent-ext-devops/tests/sh-version.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-devops/tests/sh-version.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVersion, listVersions, resolveTargetDir, swapCurrent } from "../scripts/lib/sh-version.ts";
import { freezeTree, unfreezeTree } from "../scripts/lib/sh-fs.ts";

const roots: string[] = [];
function makeRoot(): string {
	const d = mkdtempSync(join(tmpdir(), "sh-ver-"));
	roots.push(d);
	return d;
}
afterEach(() => {
	for (const r of roots.splice(0)) {
		unfreezeTree(r);
		rmSync(r, { recursive: true, force: true });
	}
});

describe("computeVersion", () => {
	test("appends the git short sha when enabled", () => {
		expect(computeVersion({ pkgVersion: "0.1.0", gitSha: "520acb928", useGitSha: true })).toBe("0.1.0+g520acb9");
	});

	test("omits the sha when disabled", () => {
		expect(computeVersion({ pkgVersion: "0.1.0", gitSha: "520acb928", useGitSha: false })).toBe("0.1.0");
	});

	test("omits the sha when git is unavailable", () => {
		expect(computeVersion({ pkgVersion: "0.1.0", gitSha: null, useGitSha: true })).toBe("0.1.0");
	});
});

describe("resolveTargetDir", () => {
	test("returns the version dir under the out root", () => {
		expect(resolveTargetDir("/out", "0.1.0+g520acb9")).toBe("/out/0.1.0+g520acb9");
	});

	test("rejects a version string with a path separator", () => {
		expect(() => resolveTargetDir("/out", "../escape")).toThrow(/version/);
		expect(() => resolveTargetDir("/out", "a/b")).toThrow(/version/);
	});
});

describe("swapCurrent", () => {
	test("creates the symlink when absent", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		swapCurrent(root, "1.0.0");
		expect(readlinkSync(join(root, "current"))).toBe("1.0.0");
	});

	test("repoints an existing symlink", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		mkdirSync(join(root, "2.0.0"));
		swapCurrent(root, "1.0.0");
		swapCurrent(root, "2.0.0");
		expect(readlinkSync(join(root, "current"))).toBe("2.0.0");
		expect(lstatSync(join(root, "current")).isSymbolicLink()).toBe(true);
	});

	test("refuses to replace a real directory named current", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		mkdirSync(join(root, "current"));
		expect(() => swapCurrent(root, "1.0.0")).toThrow(/not a symlink/);
	});

	test("refuses to point at a version that does not exist", () => {
		const root = makeRoot();
		expect(() => swapCurrent(root, "9.9.9")).toThrow(/9\.9\.9/);
	});
});

describe("listVersions", () => {
	test("lists version dirs and the current target", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		mkdirSync(join(root, "2.0.0"));
		swapCurrent(root, "2.0.0");
		expect(listVersions(root)).toEqual({ versions: ["1.0.0", "2.0.0"], current: "2.0.0" });
	});

	test("handles a missing out root", () => {
		expect(listVersions(join(makeRoot(), "absent"))).toEqual({ versions: [], current: null });
	});
});

describe("freezeTree / unfreezeTree", () => {
	test("freeze clears the write bits, unfreeze restores them", () => {
		const root = makeRoot();
		const sub = join(root, "ext", "alpha");
		mkdirSync(sub, { recursive: true });
		const file = join(sub, "ext.cjs");
		writeFileSync(file, "x");

		freezeTree(root);
		expect(statSync(file).mode & 0o222).toBe(0);

		unfreezeTree(root);
		expect(statSync(file).mode & 0o200).not.toBe(0);
		writeFileSync(file, "y"); // must not throw
		expect(existsSync(file)).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/sh-version.test.ts
```

Expected: FAIL — cannot find `sh-version.ts` / `sh-fs.ts`.

- [ ] **Step 3: Implement `sh-fs.ts`**

Create `bun-apps/pi-agent-ext-devops/scripts/lib/sh-fs.ts`:

```ts
/**
 * sh-fs.ts — filesystem helpers for the pi-agent-sh deploy.
 *
 * freeze/unfreeze exist because a deployed tree is chmod a-w by default (a
 * deployed artifact must not be edited in place), and the single-extension
 * rebuild path has to temporarily reopen exactly one subtree.
 */
import { chmodSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, fn: (p: string, isDir: boolean) => void): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const p = join(dir, name);
		// Never follow symlinks — chmod through a link would escape the tree.
		const st = lstatSync(p);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) {
			walk(p, fn);
			fn(p, true);
		} else {
			fn(p, false);
		}
	}
}

/** Clear every write bit in the tree (files first, then dirs, then the root). */
export function freezeTree(root: string): void {
	walk(root, (p) => chmodSync(p, statSync(p).mode & ~0o222));
	chmodSync(root, statSync(root).mode & ~0o222);
}

/** Restore the owner write bit so the tree can be modified or removed. */
export function unfreezeTree(root: string): void {
	try {
		chmodSync(root, statSync(root).mode | 0o200);
	} catch {
		return;
	}
	walk(root, (p) => chmodSync(p, statSync(p).mode | 0o200));
}

/** Remove a tree, unfreezing first so a frozen deploy can be replaced. */
export function rmTree(root: string): void {
	unfreezeTree(root);
	rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 4: Implement `sh-version.ts`**

Create `bun-apps/pi-agent-ext-devops/scripts/lib/sh-version.ts`:

```ts
/**
 * sh-version.ts — version naming, target resolution, and the `current` symlink.
 *
 * The symlink is relative (`current -> 0.1.0+g520acb9`) so the whole out root
 * can be moved without breaking it, and it is swapped via rename() so a reader
 * never observes a missing `current`.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function computeVersion(opts: { pkgVersion: string; gitSha: string | null; useGitSha: boolean }): string {
	if (!opts.useGitSha || !opts.gitSha) return opts.pkgVersion;
	return `${opts.pkgVersion}+g${opts.gitSha.slice(0, 7)}`;
}

export function resolveTargetDir(outRoot: string, version: string): string {
	if (version.includes("/") || version.includes("\\") || version === "." || version === "..") {
		throw new Error(`invalid version string "${version}": must not contain a path separator`);
	}
	return join(outRoot, version);
}

/** Point <outRoot>/current at <version>. The version dir must already exist. */
export function swapCurrent(outRoot: string, version: string): void {
	const target = join(outRoot, version);
	if (!existsSync(target)) throw new Error(`cannot point current at "${version}": ${target} does not exist`);

	const link = join(outRoot, "current");
	if (existsSync(link) || isSymlink(link)) {
		if (!isSymlink(link)) throw new Error(`${link} exists and is not a symlink — refusing to replace it`);
	}
	// Create a temp link then rename over the old one: rename is atomic, so a
	// concurrent reader sees either the old target or the new one, never none.
	const tmp = join(outRoot, `.current-swap-${process.pid}`);
	if (existsSync(tmp) || isSymlink(tmp)) rmSync(tmp, { force: true });
	symlinkSync(version, tmp);
	renameSync(tmp, link);
}

export function listVersions(outRoot: string): { versions: string[]; current: string | null } {
	if (!existsSync(outRoot)) return { versions: [], current: null };
	const versions = readdirSync(outRoot)
		.filter((n) => n !== "current" && !n.startsWith("."))
		.filter((n) => {
			try {
				return lstatSync(join(outRoot, n)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
	const link = join(outRoot, "current");
	const current = isSymlink(link) ? readlinkSync(link) : null;
	return { versions, current };
}

/** Create the out root if needed (deploys must work on a fresh machine). */
export function ensureOutRoot(outRoot: string): void {
	mkdirSync(outRoot, { recursive: true });
}

function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/sh-version.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent-ext-devops/scripts/lib/sh-fs.ts bun-apps/pi-agent-ext-devops/scripts/lib/sh-version.ts bun-apps/pi-agent-ext-devops/tests/sh-version.test.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(devops): version naming, current symlink swap, freeze/unfreeze for pi-agent-sh"
```

---

## Task 8: Build one extension package

**Files:**
- Create: `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.ts`
- Test: `bun-apps/pi-agent-ext-devops/tests/sh-ext-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-devops/tests/sh-ext-build.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtPackage, loadProbe, scanForeignSpecifiers } from "../scripts/lib/sh-ext-build.ts";

const BUN_APPS = join(import.meta.dir, "..", "..");
const HOST_MODULES = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
	"typebox/value",
	"@repo/pi-agent-core-runtime",
];

const dirs: string[] = [];
function makeDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sh-extbuild-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scanForeignSpecifiers", () => {
	test("accepts a bundle that only requires host modules", () => {
		const code = `var a = require("typebox");\nimport x from "@earendil-works/pi-tui";`;
		expect(scanForeignSpecifiers(code, HOST_MODULES)).toEqual([]);
	});

	test("reports a specifier the host does not provide", () => {
		const code = `import x from "left-pad";`;
		expect(scanForeignSpecifiers(code, HOST_MODULES)).toEqual(["left-pad"]);
	});

	test("ignores node builtins and relative paths", () => {
		const code = `import a from "node:fs";\nimport b from "./local.js";\nimport c from "path";`;
		expect(scanForeignSpecifiers(code, HOST_MODULES)).toEqual([]);
	});
});

describe("loadProbe", () => {
	test("accepts a cjs bundle with a callable default export", () => {
		const dir = makeDir();
		const f = join(dir, "ext.cjs");
		writeFileSync(f, `// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {\nmodule.exports.default = () => ({});\n})\n`);
		expect(() => loadProbe(f, HOST_MODULES)).not.toThrow();
	});

	test("rejects a bundle with no default export", () => {
		const dir = makeDir();
		const f = join(dir, "ext.cjs");
		writeFileSync(f, `// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {\nmodule.exports.other = 1;\n})\n`);
		expect(() => loadProbe(f, HOST_MODULES)).toThrow(/default export/);
	});

	test("rejects output that is not a cjs wrapper", () => {
		const dir = makeDir();
		const f = join(dir, "ext.cjs");
		writeFileSync(f, `export default () => ({});`);
		expect(() => loadProbe(f, HOST_MODULES)).toThrow(/cjs wrapper/);
	});
});

describe("buildExtPackage", () => {
	test("builds power-tool into ext.cjs + ext.json + skills", async () => {
		const out = makeDir();
		const res = await buildExtPackage({
			ext: { name: "power-tool", package: "pi-agent-ext-power-tool", entry: "extensions/power-tool.ts", order: 50, skills: ["skills"], enabled: true },
			bunAppsDir: BUN_APPS,
			outDir: join(out, "power-tool"),
			hostApi: 1,
			hostModules: HOST_MODULES,
			sourceSha: "deadbee",
			builtAt: "2026-08-19T00:00:00Z",
		});

		expect(existsSync(join(out, "power-tool", "ext.cjs"))).toBe(true);
		expect(existsSync(join(out, "power-tool", "skills"))).toBe(true);
		const manifest = JSON.parse(readFileSync(join(out, "power-tool", "ext.json"), "utf8"));
		expect(manifest.name).toBe("power-tool");
		expect(manifest.hostApi).toBe(1);
		expect(manifest.entry).toBe("ext.cjs");
		expect(manifest.order).toBe(50);
		expect(manifest.skills).toEqual(["skills"]);
		// only host modules may remain unresolved
		expect(manifest.hostModules.every((m: string) => HOST_MODULES.includes(m))).toBe(true);
		expect(res.bytes).toBeGreaterThan(0);
	}, 120_000);

	test("fails the build when the bundle references a non-host bare specifier", async () => {
		const out = makeDir();
		const pkgDir = join(out, "fake-ext");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-ext", version: "0.0.0", type: "module" }));
		writeFileSync(
			join(pkgDir, "extensions", "fake.ts"),
			`import x from "definitely-not-installed-pkg";\nexport default () => ({ x });\n`,
		);
		await expect(
			buildExtPackage({
				ext: { name: "fake-ext", package: "fake-ext", entry: "extensions/fake.ts", order: 1, skills: [], enabled: true },
				bunAppsDir: out,
				outDir: join(out, "built"),
				hostApi: 1,
				hostModules: HOST_MODULES,
				sourceSha: "deadbee",
				builtAt: "2026-08-19T00:00:00Z",
			}),
		).rejects.toThrow(/definitely-not-installed-pkg/);
	}, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/sh-ext-build.test.ts
```

Expected: FAIL — cannot find `sh-ext-build.ts`.

- [ ] **Step 3: Implement**

Create `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.ts`:

```ts
/**
 * sh-ext-build.ts — build ONE extension package for a pi-agent-sh deploy.
 *
 * Output per extension: <outDir>/{ext.cjs, ext.json, <skills dirs>}.
 *
 * The bundle is cjs with the host module whitelist marked --external, so the
 * core can serve those specifiers from its own embedded copies (see
 * bun-apps/pi-agent/src/sh/host-modules.ts for WHY that matters). Two gates run
 * on every build:
 *   1. scanForeignSpecifiers — nothing outside the whitelist may remain
 *      unresolved, or the extension would fail to load on the user's machine.
 *   2. loadProbe — the emitted bundle is actually loaded the way the runtime
 *      loader loads it. This is what catches a change in bun's cjs output shape
 *      at deploy time instead of at user runtime.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractBareSpecifiers } from "./build-extensions.ts";
import { evaluateExtModule } from "../../../pi-agent/src/sh/ext-loader.ts";
import type { ShExtConfig } from "./sh-config.ts";

export interface BuildExtOptions {
	ext: ShExtConfig;
	/** Absolute path to bun-apps/. */
	bunAppsDir: string;
	/** Absolute path to the extension's output dir (…/ext/<name>). */
	outDir: string;
	hostApi: number;
	hostModules: readonly string[];
	sourceSha: string;
	builtAt: string;
}

export interface BuildExtResult {
	name: string;
	bytes: number;
	hostModules: string[];
}

const BUILTIN_PREFIXES = ["node:", "bun:"];
const BUILTINS = new Set([
	"assert", "async_hooks", "buffer", "child_process", "cluster", "crypto", "dgram", "dns",
	"events", "fs", "http", "http2", "https", "module", "net", "os", "path", "perf_hooks",
	"process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
	"timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

function isBuiltin(spec: string): boolean {
	if (BUILTIN_PREFIXES.some((p) => spec.startsWith(p))) return true;
	return BUILTINS.has(spec.split("/")[0]!);
}

/** Bare specifiers left in the bundle that the host does not provide. */
export function scanForeignSpecifiers(code: string, hostModules: readonly string[]): string[] {
	const foreign = new Set<string>();
	for (const spec of extractBareSpecifiers(code)) {
		if (isBuiltin(spec)) continue;
		if (hostModules.includes(spec)) continue;
		foreign.add(spec);
	}
	return [...foreign];
}

/** Load the built bundle exactly as the runtime loader does. Throws on any problem. */
export function loadProbe(cjsPath: string, hostModules: readonly string[]): void {
	const code = readFileSync(cjsPath, "utf8");
	const stub = (spec: string): unknown => {
		if (!hostModules.includes(spec)) throw new Error(`bundle required non-host module "${spec}"`);
		// A Proxy stands in for the real host module: the probe must not need pi's
		// runtime to be constructible, only to be requirable.
		return new Proxy({}, { get: () => () => undefined });
	};
	const exports = evaluateExtModule(code, cjsPath, join(cjsPath, ".."), stub);
	if (typeof exports.default !== "function") {
		throw new Error(`${cjsPath}: bundle has no callable default export`);
	}
}

export async function buildExtPackage(opts: BuildExtOptions): Promise<BuildExtResult> {
	const pkgDir = resolve(opts.bunAppsDir, opts.ext.package);
	const entryAbs = resolve(pkgDir, opts.ext.entry);
	if (!existsSync(entryAbs)) throw new Error(`entry not found: ${entryAbs}`);

	if (existsSync(opts.outDir)) rmSync(opts.outDir, { recursive: true, force: true });
	mkdirSync(opts.outDir, { recursive: true });

	const cjsPath = join(opts.outDir, "ext.cjs");
	const externalFlags = opts.hostModules.flatMap((m) => ["--external", m]);
	// Subpath imports need their own external pattern: "typebox" does not cover
	// "typebox/value" as a bundler external in every bun version. Derive the
	// package root of each host module ("@scope/name" keeps two segments, a bare
	// name keeps one) and add "<root>/*".
	const packageRoot = (spec: string): string => {
		const parts = spec.split("/");
		return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
	};
	const wildcardFlags = [...new Set(opts.hostModules.map((m) => `${packageRoot(m)}/*`))].flatMap((p) => [
		"--external",
		p,
	]);

	const proc = Bun.spawn(
		[
			"bun", "build", entryAbs,
			"--target=bun",
			"--format=cjs",
			`--outfile=${cjsPath}`,
			"--minify",
			...externalFlags,
			...wildcardFlags,
		],
		{ stdout: "inherit", stderr: "inherit", cwd: pkgDir },
	);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`bun build failed for ${opts.ext.name} (exit ${code})`);

	// ── Gate 1: nothing foreign may remain unresolved ────────────────────────
	const built = readFileSync(cjsPath, "utf8");
	const foreign = scanForeignSpecifiers(built, opts.hostModules);
	if (foreign.length > 0) {
		throw new Error(
			`${opts.ext.name}: bundle references specifier(s) the host does not provide: ${foreign.join(", ")}. ` +
				`Either add them to hostModules (and to src/sh/host-modules.ts) or make the bundler inline them.`,
		);
	}

	// ── Gate 2: it loads the way the runtime loads it ─────────────────────────
	loadProbe(cjsPath, opts.hostModules);

	// ── Skills ───────────────────────────────────────────────────────────────
	for (const rel of opts.ext.skills) {
		cpSync(resolve(pkgDir, rel), join(opts.outDir, rel), { recursive: true, dereference: true });
	}

	// ── Manifest ─────────────────────────────────────────────────────────────
	const usedHostModules = opts.hostModules.filter((m) => built.includes(`"${m}"`));
	const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name?: string; version?: string };
	const manifest = {
		name: opts.ext.name,
		package: pkgJson.name ?? opts.ext.package,
		version: pkgJson.version ?? "0.0.0",
		hostApi: opts.hostApi,
		entry: "ext.cjs",
		order: opts.ext.order,
		enabled: true,
		skills: opts.ext.skills,
		hostModules: usedHostModules,
		builtAt: opts.builtAt,
		sourceSha: opts.sourceSha,
	};
	writeFileSync(join(opts.outDir, "ext.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	return { name: opts.ext.name, bytes: statSync(cjsPath).size, hostModules: usedHostModules };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/sh-ext-build.test.ts
```

Expected: PASS, 8 tests. If the `power-tool` build reports foreign specifiers, that is the gate doing its job: read the list, and for each one decide whether it belongs in the host whitelist (add to BOTH `deploy-config.yaml` and `src/sh/host-modules.ts`, then update `host-modules.test.ts`) or should be inlined (it is a workspace dep — check it is declared in that package's `package.json` and that `bun install` has run).

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.ts bun-apps/pi-agent-ext-devops/tests/sh-ext-build.test.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(devops): build one sh-mode extension package with foreign-specifier + load-probe gates"
```

---

## Task 9: The deploy orchestrator

**Files:**
- Create: `bun-apps/pi-agent-ext-devops/scripts/deploy-sh.ts`

- [ ] **Step 1: Implement**

Create `bun-apps/pi-agent-ext-devops/scripts/deploy-sh.ts`:

```ts
/**
 * deploy-sh.ts — orchestrator for the pi-agent-sh deploy.
 *
 * Produces <outRoot>/<version>/ containing:
 *   pi-agent      minimal compiled core (zero extensions inside)
 *   run.sh        thin launcher
 *   deploy.json   provenance
 *   ext/<name>/   independently built extension packages
 *
 * Everything is staged in <outRoot>/.staging-<version> and only renamed into
 * place after all gates pass, so a failed deploy never leaves a half-written
 * version dir and never repoints `current`.
 *
 * This file deliberately does NOT touch scripts/deploy.ts or any of its four
 * modes.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseShConfig, type ShConfig } from "./lib/sh-config.ts";
import { buildExtPackage } from "./lib/sh-ext-build.ts";
import { computeVersion, ensureOutRoot, resolveTargetDir, swapCurrent } from "./lib/sh-version.ts";
import { freezeTree, rmTree, unfreezeTree } from "./lib/sh-fs.ts";
import { stageGenerateEmbeddedAssets, stageGeneratePkgDir, stageGenerateRunDirBase } from "./lib/codegen.ts";

const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "pi-agent");
const BUN_APPS_DIR = dirname(PI_AGENT_DIR);
const REPO_ROOT = dirname(BUN_APPS_DIR);
const DEFAULT_CONFIG = join(PI_AGENT_DIR, "deploy-config.yaml");

export interface DeployShOptions {
	configPath?: string;
	outRoot?: string;
	version?: string;
	/** Rebuild only these extensions into an EXISTING version dir. */
	onlyExt?: string[];
	freeze?: boolean;
	current?: boolean;
	force?: boolean;
}

export interface DeployShResult {
	version: string;
	target: string;
	extensions: Array<{ name: string; bytes: number }>;
	coreBytes: number;
	currentUpdated: boolean;
	mode: "full" | "ext-only";
}

function run(cmd: string[], cwd: string): string {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) {
		throw new Error(`${cmd.join(" ")} failed (${p.exitCode}): ${p.stderr.toString()}`);
	}
	return p.stdout.toString().trim();
}

function gitShortSha(): string | null {
	try {
		return run(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], REPO_ROOT);
	} catch {
		return null;
	}
}

function resolvePiPkgDir(): string {
	const url = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
	return dirname(new URL(url).pathname);
}

function loadConfig(configPath: string): ShConfig {
	return parseShConfig(readFileSync(configPath, "utf8"), { bunAppsDir: BUN_APPS_DIR });
}

/** The config and the core must agree on the host contract, or every extension silently refuses to load. */
async function assertHostContract(cfg: ShConfig): Promise<void> {
	const { HOST_API, HOST_MODULE_IDS } = await import("../../pi-agent/src/sh/host-modules.ts");
	if (cfg.hostApi !== HOST_API) {
		throw new Error(`deploy-config hostApi ${cfg.hostApi} != core HOST_API ${HOST_API} (src/sh/host-modules.ts)`);
	}
	const missing = cfg.hostModules.filter((m) => !HOST_MODULE_IDS.includes(m));
	const extra = HOST_MODULE_IDS.filter((m) => !cfg.hostModules.includes(m));
	if (missing.length > 0 || extra.length > 0) {
		throw new Error(
			`deploy-config hostModules disagree with core HOST_MODULE_IDS — ` +
				`only in config: [${missing.join(", ")}], only in core: [${extra.join(", ")}]`,
		);
	}
}

/** Compile the minimal core into `outFile`. */
async function buildCore(outFile: string): Promise<number> {
	const piPkgDir = resolvePiPkgDir();
	// Same codegen the --exe mode uses: bake pi's package dir, an EMPTY run-dir
	// base (sh mode resolves nothing from the repo), and embed pi's own
	// theme/assets/export-html so the binary needs no repo on the target machine.
	stageGeneratePkgDir(piPkgDir);
	stageGenerateRunDirBase([]);
	stageGenerateEmbeddedAssets(piPkgDir, BUN_APPS_DIR, [], true);

	const entry = join(PI_AGENT_DIR, "src", "cli-sh.ts");
	const p = Bun.spawn(["bun", "build", "--compile", entry, `--outfile=${outFile}`, "--minify"], {
		cwd: PI_AGENT_DIR,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await p.exited) !== 0) throw new Error("bun build --compile failed for src/cli-sh.ts");
	chmodSync(outFile, 0o755);
	return Bun.file(outFile).size;
}

const RUN_SH = `#!/usr/bin/env bash
# run.sh — launcher for a pi-agent-sh deploy.
#
# The binary beside this script is self-contained: it discovers extensions from
# ./ext/<name>/ at runtime and runs normally when that directory is absent.
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [ -L "\$SOURCE" ]; do
  DIR="\$(cd -P "\$(dirname "\$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="\$(readlink "\$SOURCE")"
  [[ \$SOURCE != /* ]] && SOURCE="\$DIR/\$SOURCE"
done
SCRIPT_DIR="\$(cd -P "\$(dirname "\$SOURCE")" >/dev/null 2>&1 && pwd)"

# The deploy tree is chmod a-w; keep every per-user write under ~/.pi/agent.
export JITI_FS_CACHE="\${JITI_FS_CACHE:-0}"
export PI_CODING_AGENT_DIR="\${PI_CODING_AGENT_DIR:-\$HOME/.pi/agent}"

exec "\$SCRIPT_DIR/pi-agent" "\$@"
`;

/** Run the binary's --ext-list diagnostic and return the parsed payload. */
function extListOf(binary: string): { loadedCount: number; loaded: string[]; skipped: Array<{ name: string; reason: string }> } {
	const p = Bun.spawnSync([binary, "--ext-list"], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) {
		throw new Error(`--ext-list exited ${p.exitCode}: ${p.stderr.toString()}`);
	}
	return JSON.parse(p.stdout.toString());
}

/** Gate 3: extensions load; with ext/ moved aside the core still exits 0 with none. */
function verifyDualState(stageDir: string, expected: string[]): void {
	const binary = join(stageDir, "pi-agent");
	const withExt = extListOf(binary);
	const missing = expected.filter((n) => !withExt.loaded.includes(n));
	if (missing.length > 0) {
		throw new Error(
			`smoke: expected extension(s) not loaded: ${missing.join(", ")}; ` +
				`skipped=${JSON.stringify(withExt.skipped)}`,
		);
	}

	const extDir = join(stageDir, "ext");
	const parked = join(stageDir, ".ext-parked");
	renameSync(extDir, parked);
	try {
		const without = extListOf(binary);
		if (without.loadedCount !== 0) {
			throw new Error(`smoke: core loaded ${without.loadedCount} extension(s) with ext/ removed`);
		}
	} finally {
		renameSync(parked, extDir);
	}
}

export async function runShDeploy(opts: DeployShOptions = {}): Promise<DeployShResult> {
	const configPath = opts.configPath ? resolve(opts.configPath) : DEFAULT_CONFIG;
	if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
	const cfg = loadConfig(configPath);
	await assertHostContract(cfg);

	const outRoot = opts.outRoot ? resolve(opts.outRoot) : cfg.outRoot;
	const pkgVersion = (JSON.parse(readFileSync(join(PI_AGENT_DIR, "package.json"), "utf8")) as { version: string }).version;
	const sha = gitShortSha();
	const version = opts.version ?? computeVersion({ pkgVersion, gitSha: sha, useGitSha: cfg.version.gitSha });
	const target = resolveTargetDir(outRoot, version);
	const freeze = opts.freeze ?? cfg.freeze;
	const wantCurrent = opts.current ?? cfg.current;
	const builtAt = new Date().toISOString();
	const sourceSha = sha ?? "unknown";

	ensureOutRoot(outRoot);

	// ── ext-only rebuild: patch an existing version dir in place ─────────────
	if (opts.onlyExt && opts.onlyExt.length > 0) {
		if (!existsSync(target)) throw new Error(`--ext requires an existing deploy at ${target}`);
		const selected = cfg.extensions.filter((e) => opts.onlyExt!.includes(e.name));
		const unknown = opts.onlyExt.filter((n) => !cfg.extensions.some((e) => e.name === n));
		if (unknown.length > 0) throw new Error(`unknown extension(s) in config: ${unknown.join(", ")}`);

		unfreezeTree(target);
		const built: Array<{ name: string; bytes: number }> = [];
		try {
			for (const ext of selected) {
				const r = await buildExtPackage({
					ext, bunAppsDir: BUN_APPS_DIR, outDir: join(target, "ext", ext.name),
					hostApi: cfg.hostApi, hostModules: cfg.hostModules, sourceSha, builtAt,
				});
				built.push({ name: r.name, bytes: r.bytes });
			}
			verifyDualState(target, cfg.extensions.filter((e) => e.enabled).map((e) => e.name));
		} finally {
			if (freeze) freezeTree(target);
		}
		return { version, target, extensions: built, coreBytes: Bun.file(join(target, "pi-agent")).size, currentUpdated: false, mode: "ext-only" };
	}

	// ── full deploy ──────────────────────────────────────────────────────────
	if (existsSync(target) && !opts.force) {
		throw new Error(`${target} already exists — pass --force to replace it`);
	}
	const stage = join(outRoot, `.staging-${version}`);
	rmTree(stage);
	mkdirSync(join(stage, "ext"), { recursive: true });

	const built: Array<{ name: string; bytes: number }> = [];
	try {
		const coreBytes = await buildCore(join(stage, "pi-agent"));

		for (const ext of cfg.extensions.filter((e) => e.enabled)) {
			const r = await buildExtPackage({
				ext, bunAppsDir: BUN_APPS_DIR, outDir: join(stage, "ext", ext.name),
				hostApi: cfg.hostApi, hostModules: cfg.hostModules, sourceSha, builtAt,
			});
			built.push({ name: r.name, bytes: r.bytes });
		}

		writeFileSync(join(stage, "run.sh"), RUN_SH);
		chmodSync(join(stage, "run.sh"), 0o755);
		writeFileSync(
			join(stage, "deploy.json"),
			`${JSON.stringify({ version, builtAt, sourceSha, bunVersion: Bun.version, configPath, config: cfg }, null, 2)}\n`,
		);

		verifyDualState(stage, cfg.extensions.filter((e) => e.enabled).map((e) => e.name));

		if (existsSync(target)) rmTree(target);
		renameSync(stage, target);
		if (freeze) freezeTree(target);
		let currentUpdated = false;
		if (wantCurrent) {
			swapCurrent(outRoot, version);
			currentUpdated = true;
		}
		return { version, target, extensions: built, coreBytes, currentUpdated, mode: "full" };
	} catch (e) {
		rmTree(stage); // never leave a half-written deploy behind
		throw e;
	}
}
```

- [ ] **Step 2: Smoke-run it against a scratch out root**

```bash
bun -e 'const { runShDeploy } = await import("/Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops/scripts/deploy-sh.ts"); console.log(await runShDeploy({ outRoot: "/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--deploy/9b47b5f6-0537-49ee-94c7-4bc20c5e00a0/scratchpad/sh-out", current: false, freeze: false, force: true }));'
```

Expected: an object with `mode: "full"`, both extensions listed, and a `target` under the scratch dir. Then confirm both states by hand:

```bash
SCRATCH=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--deploy/9b47b5f6-0537-49ee-94c7-4bc20c5e00a0/scratchpad/sh-out
V=$(ls "$SCRATCH" | head -1)
"$SCRATCH/$V/pi-agent" --ext-list
mv "$SCRATCH/$V/ext" "$SCRATCH/$V/ext-off" && "$SCRATCH/$V/pi-agent" --ext-list; mv "$SCRATCH/$V/ext-off" "$SCRATCH/$V/ext"
```

Expected: first call lists `["task","power-tool"]` (order 10 then 50), second reports `"loadedCount": 0` and exits 0.

- [ ] **Step 3: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent-ext-devops/scripts/deploy-sh.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(devops): pi-agent-sh deploy orchestrator with staged promote and dual-state gate"
```

---

## Task 10: CLI surface

**Files:**
- Create: `bun-apps/pi-agent-ext-devops/src/deploy-sh-argv.ts`
- Create: `bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts`
- Test: `bun-apps/pi-agent-ext-devops/tests/deploy-sh-argv.test.ts`
- Modify: `bun-apps/pi-agent/package.json`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-devops/tests/deploy-sh-argv.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseDeployShArgv } from "../src/deploy-sh-argv.ts";

describe("parseDeployShArgv", () => {
	test("no flags means a full deploy", () => {
		const r = parseDeployShArgv([]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.action).toEqual({ kind: "deploy", options: {} });
	});

	test("--list is its own action", () => {
		const r = parseDeployShArgv(["--list"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.action.kind).toBe("list");
	});

	test("--help is its own action", () => {
		const r = parseDeployShArgv(["--help"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.action.kind).toBe("help");
	});

	test("collects repeated --ext", () => {
		const r = parseDeployShArgv(["--ext", "task", "--ext", "power-tool"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.action.kind === "deploy") expect(r.action.options.onlyExt).toEqual(["task", "power-tool"]);
	});

	test("parses value flags in both forms", () => {
		const r = parseDeployShArgv(["--out=/tmp/a", "--version", "9.9.9", "--config=/tmp/c.yaml"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.action.kind === "deploy") {
			expect(r.action.options.outRoot).toBe("/tmp/a");
			expect(r.action.options.version).toBe("9.9.9");
			expect(r.action.options.configPath).toBe("/tmp/c.yaml");
		}
	});

	test("parses negation flags", () => {
		const r = parseDeployShArgv(["--no-freeze", "--no-current", "--force"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.action.kind === "deploy") {
			expect(r.action.options.freeze).toBe(false);
			expect(r.action.options.current).toBe(false);
			expect(r.action.options.force).toBe(true);
		}
	});

	test("rejects an unknown flag", () => {
		const r = parseDeployShArgv(["--nope"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--nope/);
	});

	test("rejects a value flag with no value", () => {
		const r = parseDeployShArgv(["--out"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--out/);
	});

	test("rejects a positional argument", () => {
		const r = parseDeployShArgv(["extra"]);
		expect(r.ok).toBe(false);
	});

	test("rejects --list combined with deploy flags", () => {
		const r = parseDeployShArgv(["--list", "--force"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--list/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/deploy-sh-argv.test.ts
```

Expected: FAIL — cannot find `deploy-sh-argv.ts`.

- [ ] **Step 3: Implement the parser**

Create `bun-apps/pi-agent-ext-devops/src/deploy-sh-argv.ts`:

```ts
/**
 * deploy-sh-argv.ts — pure argv parsing for deploy-sh-cli.
 *
 * Kept separate from the CLI (same split as deploy-argv.ts / deploy-tool.ts) so
 * the flag contract is unit-testable without running a deploy.
 */
import type { DeployShOptions } from "../scripts/deploy-sh.ts";

export type DeployShAction =
	| { kind: "deploy"; options: DeployShOptions }
	| { kind: "list"; outRoot?: string; configPath?: string }
	| { kind: "help" };

export type ParseArgvResult = { ok: true; action: DeployShAction } | { ok: false; error: string };

const VALUE_FLAGS = new Set(["--config", "--out", "--version", "--ext"]);
const BOOL_FLAGS = new Set(["--no-freeze", "--no-current", "--force", "--list", "--help", "--json"]);

export function parseDeployShArgv(argv: string[]): ParseArgvResult {
	const options: DeployShOptions = {};
	const onlyExt: string[] = [];
	let list = false;
	let help = false;
	let sawDeployFlag = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (!token.startsWith("--")) return { ok: false, error: `unexpected argument "${token}" (this CLI takes flags only)` };

		const eq = token.indexOf("=");
		const flag = eq === -1 ? token : token.slice(0, eq);
		let value: string | undefined = eq === -1 ? undefined : token.slice(eq + 1);

		if (VALUE_FLAGS.has(flag)) {
			if (value === undefined) {
				value = argv[++i];
				if (value === undefined || value.startsWith("--")) return { ok: false, error: `flag ${flag} requires a value` };
			}
			if (flag === "--config") options.configPath = value;
			else if (flag === "--out") options.outRoot = value;
			else if (flag === "--version") options.version = value;
			else onlyExt.push(value);
			if (flag !== "--config" && flag !== "--out") sawDeployFlag = true;
			continue;
		}

		if (!BOOL_FLAGS.has(flag)) {
			return { ok: false, error: `unknown flag "${flag}" (known: ${[...VALUE_FLAGS, ...BOOL_FLAGS].join(", ")})` };
		}
		if (value !== undefined) return { ok: false, error: `flag ${flag} takes no value` };
		if (flag === "--list") list = true;
		else if (flag === "--help") help = true;
		else if (flag === "--json") continue; // JSON is always on; accepted for symmetry
		else {
			sawDeployFlag = true;
			if (flag === "--no-freeze") options.freeze = false;
			if (flag === "--no-current") options.current = false;
			if (flag === "--force") options.force = true;
		}
	}

	if (help) return { ok: true, action: { kind: "help" } };
	if (list) {
		if (sawDeployFlag) return { ok: false, error: `--list cannot be combined with deploy flags` };
		return { ok: true, action: { kind: "list", outRoot: options.outRoot, configPath: options.configPath } };
	}
	if (onlyExt.length > 0) options.onlyExt = onlyExt;
	return { ok: true, action: { kind: "deploy", options } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/deploy-sh-argv.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Implement the CLI**

Create `bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts`:

```ts
#!/usr/bin/env bun
/**
 * deploy-sh-cli.ts — CLI for the pi-agent-sh deploy.
 *
 * Convention (shared with the other devops CLIs): stdout is PURE JSON, human
 * text goes to stderr, exit 0 = ok / 1 = failure / 2 = usage error.
 *
 *   bun src/deploy-sh-cli.ts                     # full deploy
 *   bun src/deploy-sh-cli.ts --ext power-tool    # rebuild one extension in place
 *   bun src/deploy-sh-cli.ts --list              # deployed versions + current
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDeployShArgv } from "./deploy-sh-argv.ts";
import { runShDeploy } from "../scripts/deploy-sh.ts";
import { parseShConfig } from "../scripts/lib/sh-config.ts";
import { listVersions } from "../scripts/lib/sh-version.ts";

const BUN_APPS_DIR = resolve(import.meta.dir, "..", "..");
const DEFAULT_CONFIG = join(BUN_APPS_DIR, "pi-agent", "deploy-config.yaml");

const HELP = `deploy-sh-cli — versioned minimal-core deploy for pi-agent

USAGE
  bun src/deploy-sh-cli.ts [flags]

FLAGS
  --config <path>   deploy config (default: bun-apps/pi-agent/deploy-config.yaml)
  --out <dir>       override outRoot from the config
  --version <str>   override the computed <pkgVersion>+g<sha> version
  --ext <name>      rebuild ONLY this extension into the existing version dir
                    (repeatable; fails if that version dir does not exist)
  --force           replace an existing version dir
  --no-freeze       skip chmod a-w on the deployed tree
  --no-current      do not repoint <outRoot>/current
  --list            list deployed versions and the current target
  --help            this text

OUTPUT
  stdout is JSON. Exit 0 = ok, 1 = failure, 2 = usage error.
`;

const parsed = parseDeployShArgv(process.argv.slice(2));
if (!parsed.ok) {
	console.error(parsed.error);
	console.error(HELP);
	process.exit(2);
}

if (parsed.action.kind === "help") {
	console.error(HELP);
	process.exit(0);
}

try {
	if (parsed.action.kind === "list") {
		const configPath = parsed.action.configPath ? resolve(parsed.action.configPath) : DEFAULT_CONFIG;
		const outRoot = parsed.action.outRoot
			? resolve(parsed.action.outRoot)
			: parseShConfig(readFileSync(configPath, "utf8"), { bunAppsDir: BUN_APPS_DIR }).outRoot;
		console.log(JSON.stringify({ ok: true, outRoot, ...listVersions(outRoot) }, null, 2));
		process.exit(0);
	}

	const result = await runShDeploy(parsed.action.options);
	console.log(JSON.stringify({ ok: true, ...result }, null, 2));
	process.exit(0);
} catch (e) {
	const message = e instanceof Error ? e.message : String(e);
	console.log(JSON.stringify({ ok: false, error: message }, null, 2));
	console.error(`✗ ${message}`);
	process.exit(1);
}
```

- [ ] **Step 6: Add the convenience script**

In `bun-apps/pi-agent/package.json`, add to `scripts` (right after the existing `deploy:exe` line):

```json
    "deploy:sh": "bun ../pi-agent-ext-devops/src/deploy-sh-cli.ts"
```

Also extend the existing `"//deploy"` doc string by appending this sentence to it:

```
 A FIFTH, independent pipeline lives at ../pi-agent-ext-devops/src/deploy-sh-cli.ts (`bun run deploy:sh`): versioned minimal-core deploy to ~/proj/dist/pi-agent-sh/<version>/ with extensions as separate packages under ext/ — see docs/deploy-sh.md.
```

- [ ] **Step 7: Verify the CLI end to end**

```bash
bun /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts --help
bun /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts --nope; echo "exit=$?"
bun /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts --list --out /private/tmp/claude-501/-Users-huangziyu-proj-video-generation--deploy/9b47b5f6-0537-49ee-94c7-4bc20c5e00a0/scratchpad/sh-out
```

Expected: help text on stderr exit 0; the unknown flag prints usage and `exit=2`; `--list` prints JSON with the version created in Task 9.

- [ ] **Step 8: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent-ext-devops/src/deploy-sh-argv.ts bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts bun-apps/pi-agent-ext-devops/tests/deploy-sh-argv.test.ts bun-apps/pi-agent/package.json
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "feat(devops): deploy-sh-cli with full/single-ext/list actions"
```

---

## Task 11: End-to-end test

**Files:**
- Create: `bun-apps/pi-agent-ext-devops/tests/deploy-sh-e2e.test.ts`

Gated behind `PI_AGENT_E2E` exactly like the existing `tests/deploy-e2e.test.ts`, because it compiles a binary (slow).

- [ ] **Step 1: Write the test**

Create `bun-apps/pi-agent-ext-devops/tests/deploy-sh-e2e.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShDeploy } from "../scripts/deploy-sh.ts";
import { rmTree } from "../scripts/lib/sh-fs.ts";

const RUN = process.env.PI_AGENT_E2E === "1";
const describeE2E = RUN ? describe : describe.skip;

const outRoot = mkdtempSync(join(tmpdir(), "sh-e2e-"));
afterAll(() => rmTree(outRoot));

function extList(binary: string) {
	const p = Bun.spawnSync([binary, "--ext-list"], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: p.exitCode, payload: JSON.parse(p.stdout.toString()) };
}

describeE2E("pi-agent-sh deploy e2e", () => {
	test("full deploy produces a working core, extensions, and current symlink", async () => {
		const r = await runShDeploy({ outRoot, force: true });
		expect(r.mode).toBe("full");
		expect(r.extensions.map((e) => e.name).sort()).toEqual(["power-tool", "task"]);
		expect(r.currentUpdated).toBe(true);

		expect(existsSync(join(r.target, "pi-agent"))).toBe(true);
		expect(existsSync(join(r.target, "run.sh"))).toBe(true);
		expect(existsSync(join(r.target, "deploy.json"))).toBe(true);
		expect(existsSync(join(r.target, "ext", "power-tool", "ext.json"))).toBe(true);
		expect(existsSync(join(r.target, "ext", "power-tool", "skills"))).toBe(true);
		expect(readlinkSync(join(outRoot, "current"))).toBe(r.version);

		// frozen: no write bits anywhere
		expect(statSync(join(r.target, "ext", "power-tool", "ext.cjs")).mode & 0o222).toBe(0);

		// state 1: extensions load, in config order
		const withExt = extList(join(r.target, "pi-agent"));
		expect(withExt.exitCode).toBe(0);
		expect(withExt.payload.loaded).toEqual(["task", "power-tool"]);
		expect(withExt.payload.skipped).toEqual([]);
	}, 300_000);

	test("the core still runs with ext/ deleted", async () => {
		const version = readlinkSync(join(outRoot, "current"));
		const target = join(outRoot, version);
		const parked = join(target, "ext-parked");
		// unfreeze just enough to move the directory
		const { unfreezeTree, freezeTree } = await import("../scripts/lib/sh-fs.ts");
		unfreezeTree(target);
		renameSync(join(target, "ext"), parked);
		try {
			const without = extList(join(target, "pi-agent"));
			expect(without.exitCode).toBe(0);
			expect(without.payload.loadedCount).toBe(0);
		} finally {
			renameSync(parked, join(target, "ext"));
			freezeTree(target);
		}
	}, 60_000);

	test("single-extension rebuild updates that extension in place", async () => {
		const version = readlinkSync(join(outRoot, "current"));
		const target = join(outRoot, version);
		const before = readFileSync(join(target, "ext", "power-tool", "ext.json"), "utf8");

		const r = await runShDeploy({ outRoot, version, onlyExt: ["power-tool"] });
		expect(r.mode).toBe("ext-only");
		expect(r.extensions.map((e) => e.name)).toEqual(["power-tool"]);

		const after = readFileSync(join(target, "ext", "power-tool", "ext.json"), "utf8");
		expect(JSON.parse(after).name).toBe("power-tool");
		expect(after.length).toBeGreaterThan(0);
		expect(before.length).toBeGreaterThan(0);

		// still frozen and still loading both extensions
		expect(statSync(join(target, "ext", "power-tool", "ext.cjs")).mode & 0o222).toBe(0);
		expect(extList(join(target, "pi-agent")).payload.loaded).toEqual(["task", "power-tool"]);
	}, 180_000);

	test("--ext against a version that does not exist is refused", async () => {
		await expect(runShDeploy({ outRoot, version: "0.0.0-absent", onlyExt: ["power-tool"] })).rejects.toThrow(/existing deploy/);
	});
});
```

- [ ] **Step 2: Run it**

```bash
PI_AGENT_E2E=1 bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/deploy-sh-e2e.test.ts
```

Expected: PASS, 4 tests (several minutes — it compiles the core binary). Also confirm the default (ungated) run skips them:

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops tests/deploy-sh-e2e.test.ts
```

Expected: 4 skipped, 0 failures.

- [ ] **Step 3: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent-ext-devops/tests/deploy-sh-e2e.test.ts
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "test(devops): e2e for the pi-agent-sh deploy (dual-state + single-ext rebuild)"
```

---

## Task 12: Docs and full verification

**Files:**
- Create: `bun-apps/pi-agent/docs/deploy-sh.md`
- Modify: `bun-apps/pi-agent/CONTEXT.md`

- [ ] **Step 1: Write the doc**

Create `bun-apps/pi-agent/docs/deploy-sh.md` containing, in this order:

1. **What it is** — one paragraph: a versioned deploy to `~/proj/dist/pi-agent-sh/<version>/` with a minimal core binary and extensions as separate packages under `ext/`; independent of the four modes in `deploy.ts`.
2. **Layout** — the tree from the design spec (`pi-agent`, `run.sh`, `deploy.json`, `ext/<name>/{ext.json,ext.cjs,skills/}`, `current` symlink).
3. **Commands** —
   ```bash
   bun run --cwd bun-apps/pi-agent deploy:sh                  # full deploy
   bun run --cwd bun-apps/pi-agent deploy:sh --ext power-tool # rebuild one extension in place
   bun run --cwd bun-apps/pi-agent deploy:sh --list           # versions + current
   ~/proj/dist/pi-agent-sh/current/run.sh                     # run it
   ```
4. **The host contract** — why extension bundles are cjs with pi's runtime external, the five host modules, and the rule that adding a host module means editing BOTH `src/sh/host-modules.ts` and `deploy-config.yaml` (the deploy hard-fails on drift).
5. **Adding an extension** — add an entry to `deploy-config.yaml`, run `deploy:sh`; if the build reports foreign specifiers, decide inline-vs-host per the message.
6. **The three gates** — foreign-specifier scan, load probe, dual-state smoke — and what each failure means.
7. **Limits** — MVP ships `task` + `power-tool` only; the other 12 static extensions still require the legacy modes; no automatic cleanup of old version dirs.

- [ ] **Step 2: Add a pointer in CONTEXT.md**

In `bun-apps/pi-agent/CONTEXT.md`, in the section that lists deploy modes/docs, add one line:

```markdown
- `docs/deploy-sh.md` — the pi-agent-sh pipeline: versioned minimal-core deploy with runtime-discovered extension packages (independent of the four `deploy.ts` modes).
```

- [ ] **Step 3: Full verification across both packages**

```bash
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent
bun run --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent typecheck
bun test --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops
bun run --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent-ext-devops typecheck
```

Expected: all green. Any pre-existing failure unrelated to this work must be reported, not silently accepted — check `git stash`-free baseline with `git -C … stash list` only if you suspect contamination.

- [ ] **Step 4: Verify the legacy pipeline is untouched**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy diff --stat origin/main -- bun-apps/pi-agent-ext-devops/scripts/deploy.ts bun-apps/pi-agent/src/cli.ts bun-apps/pi-agent/src/static-extensions.ts bun-apps/pi-agent/run.sh
```

Expected: EMPTY output. If any of those files show up, the change has leaked out of scope — revert that part.

- [ ] **Step 5: Real deploy to the real location**

```bash
bun run --cwd /Users/huangziyu/proj/video_generation__deploy/bun-apps/pi-agent deploy:sh
ls -la ~/proj/dist/pi-agent-sh/
~/proj/dist/pi-agent-sh/current/pi-agent --ext-list
```

Expected: `current` points at `<version>`, and `--ext-list` reports `task` and `power-tool` loaded.

- [ ] **Step 6: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__deploy add bun-apps/pi-agent/docs/deploy-sh.md bun-apps/pi-agent/CONTEXT.md
git -C /Users/huangziyu/proj/video_generation__deploy commit -m "docs(pi-agent): document the pi-agent-sh deploy pipeline"
```

- [ ] **Step 7: Hand back the one thing automation cannot prove**

Report to the user that the automated gates are green and ask them to run the deployed TUI once and confirm `task`'s interactive surface works against the host-injected pi-tui:

```bash
~/proj/dist/pi-agent-sh/current/run.sh
```

Check `/goal`, `todo`, and `ask_user_question`. This is the open item recorded in the design spec — do NOT claim the MVP is complete before it is answered.

---

## Notes for the implementer

- **Do not touch** `scripts/deploy.ts`, `src/cli.ts`, `src/static-extensions.ts`, `run.sh`, or `run-dir/manifest.json`. This pipeline is additive; Task 12 Step 4 enforces that.
- **`bun install` runs from `bun-apps/` only.** Never `npm install`.
- **If a gate fires, read it as a finding, not an obstacle.** The foreign-specifier gate exists because a bundle that resolves pi's runtime from disk gets a second module instance — "just remove the gate" reintroduces exactly the bug this design was built to avoid.
- **Per-package test commands differ across this repo.** For these two packages `bun test` plus `bun run typecheck` is the full gate; do not assume a `check` script covers typechecking.
