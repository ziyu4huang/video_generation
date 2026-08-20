# Phase D Implementation Plan — ext scaffold (`ext new`) + static-extensions codegen

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut new-extension friction from ~9 manual touchpoints to `ext new <name> → implement → done`, and make `run-dir/manifest.json` the single edit point for the static-extension registration surface.

**Architecture:** Two PRs. **PR A (D2, first — PR B depends on it):** a pure generator `buildStaticExtensionsSource()` emits `src/static-extensions.ts` from `manifest.staticExtensions[]`; a `regen:static` script writes it; the existing `manifest-consistency.test.ts` gains a byte-exact drift tripwire. **PR B (D1):** a top-level `ext new <name>` command (follows the `ext doctor` two-token intercept precedent in `cli-argv.ts`/`cli.ts`) that scaffolds a convention-complete package and optionally registers it (dynamic manifest entry, or static + auto-regen).

**Tech Stack:** Bun + TypeScript (bun-apps workspace), bun:test. No new dependencies.

**Spec:** `.planning/pi-agent-optimization/spec.md` §Phase D, **as amended below** (ground-truth correction, same shape as the Phase B amendment).

## Spec amendment (2026-08-20, ground truth from exploration)

D2's four codegen targets, re-audited:
- `schema-cost.ts` `EXTRA_ENTRIES` — **already manifest-derived** (`discoverExtensionEntries()`, #675); EXTRA_ENTRIES is `[]`. No work.
- `ensure-extension-deps` probe list — **already auto-discovers** every `@repo/*` dir from disk; `run-dir/deps-probe.ts` is already manifest-driven. No work.
- `src/static-extensions.ts` — **the one real remaining drift surface** (15 imports + 15 rows hand-maintained beside `manifest.staticExtensions[]`). This is PR A.
- `src/cli/extensions/registry.ts` `EXTENSION_SPECS` — **NOT derivable** (which packages export subcommand specs, symbol names, and the `extensions/cli-subcommand.ts` sub-path are not in the manifest; generating them would need new manifest fields that duplicate what already lives single-sourced in the ext packages). Deliberately stays hand-written; the file is 49 lines and content is single-sourced in the ext packages already.

## Global Constraints

- NEVER top-level `cd` — use `( cd <dir> && ... )` or `--cwd`. (no-cd-drift.sh blocks it.)
- Written output (comments, docs, commits) in English; chat replies zh-TW.
- Bun workspace: `bun install` from `bun-apps/` only; never commit `package-lock.json`.
- All git phases through the devops chain (`prepare-cli` → `local-ci-cli` → `pr-finish-cli`); `.planning/` artifacts committed.
- local_ci ≤ 5 minutes (hard user rule).
- Biome is opt-in per package — scaffolded packages ship NO `biome.json` (6 existing pkgs have one; new ones adopt it deliberately later).
- Peer pin: `@earendil-works/pi-coding-agent` `0.84.2`.

---

# PR A — static-extensions codegen (D2)

Branch: `static-ext-codegen`. All paths relative to repo root unless noted.

## Design

`bun-apps/pi-agent/src/static-extensions-gen.ts` — pure module:

```ts
export interface StaticExtGenInput {
	/** Ordered package dir names, e.g. "task", "obsidian" — manifest.staticExtensions verbatim. */
	staticExtensions: string[];
}
export function buildStaticExtensionsSource(input: StaticExtGenInput): string;
```

Output format (byte-exact contract):
1. The CURRENT 87-line doc-block header of `static-extensions.ts`, embedded VERBATIM in the generator as a template string (history/invariant docs are load-bearing; the generator is now their home).
2. One banner line inserted after the header, before the first import:
   `// AUTO-GENERATED from run-dir/manifest.json staticExtensions[] — do not edit; run `bun run regen:static` (bun-apps/pi-agent).`
3. One import per entry, in manifest order, binding name `<camel(suffix)>Extension` (e.g. `taskExtension`, `knowledgeCardExtension`; `camel` = kebab→camelCase). Import path stays RELATIVE literal `../../pi-agent-ext-<dir>/extensions/<suffix>.ts` (bypasses exports maps; bun build --compile inlines literals — invariant documented in the header).
4. `export const STATIC_EXTENSION_FACTORIES = [...]` — one `{ name: "pi-agent-ext-<suffix>", factory: <binding> }` row per entry, manifest order, tab indentation.
5. Per-row comments preserved via a `ROW_COMMENTS: Record<string, string>` map INSIDE the generator keyed by suffix (`task`, `obsidian`, `subagent`, `power-tool`, `webui`, `hyperframes`, plus Group A/B markers folded into the `task` and `obsidian` entries' comments verbatim from the current file). A suffix missing from the map emits a bare row — adding an extension never requires touching the generator's cosmetics.

NOTE: this renames one local binding (`coreTaskExtension` → `taskExtension`). Only `STATIC_EXTENSION_FACTORIES` is imported externally (verified by exploration); Task A2 step 3 greps to confirm zero other references before the rewrite lands.

### Task A1: pure generator + unit tests

**Files:**
- Create: `bun-apps/pi-agent/src/static-extensions-gen.ts`
- Test: `bun-apps/pi-agent/src/__tests__/static-extensions-gen.test.ts`

**Interfaces:**
- Produces: `buildStaticExtensionsSource({ staticExtensions: string[] }): string` (PR B's scaffold spawns the regen script, not this module directly; the drift tripwire in A3 imports it).

- [ ] **Step 1: Write the failing tests** — fixture input `["task", "prompt-history", "subagent", "workflow"]` (2 commented rows, 2 bare) asserting:
  - output starts with the verbatim header's first line `/**` and contains `AUTO-GENERATED` banner;
  - import lines exactly `import taskExtension from "../../pi-agent-ext-task/extensions/task.ts";` etc., in input order;
  - rows exactly `\t{ name: "pi-agent-ext-task", factory: taskExtension },`;
  - ROW_COMMENTS text lands on its row; unknown suffixes emit bare rows;
  - output ends with `];\n` and contains each binding exactly twice (import + row);
  - deterministic: two calls return identical strings.

```ts
import { test, expect } from "bun:test";
import { buildStaticExtensionsSource } from "../static-extensions-gen.ts";

test("generates header + banner + ordered imports + rows", () => {
	const src = buildStaticExtensionsSource({ staticExtensions: ["task", "prompt-history", "subagent", "workflow"] });
	expect(src.startsWith("/**")).toBe(true);
	expect(src).toContain("// AUTO-GENERATED from run-dir/manifest.json staticExtensions[]");
	expect(src).toContain('import taskExtension from "../../pi-agent-ext-task/extensions/task.ts";');
	expect(src).toContain('import workflowExtension from "../../pi-agent-ext-workflow/extensions/workflow.ts";');
	expect(src).toContain('\t{ name: "pi-agent-ext-task", factory: taskExtension },');
	// ROW_COMMENTS from the current file survive on their rows:
	expect(src).toContain("must\n\t// load before workflow");
	// unknown suffix → bare row, no crash:
	const bare = buildStaticExtensionsSource({ staticExtensions: ["brand-new"] });
	expect(bare).toContain('\t{ name: "pi-agent-ext-brand-new", factory: brandNewExtension },');
	// determinism:
	expect(buildStaticExtensionsSource({ staticExtensions: ["task"] })).toBe(
		buildStaticExtensionsSource({ staticExtensions: ["task"] }),
	);
});
```

- [ ] **Step 2: Run to verify failure** — `bun test --cwd bun-apps/pi-agent static-extensions-gen` → FAIL (module not found).
- [ ] **Step 3: Implement** — copy the 87-line header from `bun-apps/pi-agent/src/static-extensions.ts:1-87` verbatim into the generator; implement mapping + ROW_COMMENTS per Design. Export nothing else.
- [ ] **Step 4: Run to verify pass** — same command → PASS.
- [ ] **Step 5: Commit** — `feat(pi-agent): pure static-extensions source generator`

### Task A2: regen script + rewrite the real file

**Files:**
- Create: `bun-apps/pi-agent/scripts/regen-static-extensions.ts`
- Modify: `bun-apps/pi-agent/package.json` (scripts), `bun-apps/pi-agent/src/static-extensions.ts` (regenerated)

**Interfaces:**
- Consumes: `buildStaticExtensionsSource` (A1).
- Produces: `bun run regen:static` (PR B Task B3 spawns it after appending to `manifest.staticExtensions`).

- [ ] **Step 1: Write the script** — read `run-dir/manifest.json` (import JSON), `buildStaticExtensionsSource({ staticExtensions: manifest.staticExtensions })`, `writeFileSync` over `src/static-extensions.ts`. Refuse (exit 1, no write) if `staticExtensions` is empty or missing — a manifest typo must never blank the file.
- [ ] **Step 2: Wire the script** — pi-agent package.json: `"regen:static": "bun scripts/regen-static-extensions.ts"`.
- [ ] **Step 3: Pre-rewrite safety grep** — `grep -rn "coreTaskExtension" bun-apps/ --include='*.ts' --include='*.mjs'` must show ONLY `static-extensions.ts` + `pi-agent-ext-task`'s own files (local-binding rename is then safe). If an external importer exists, add an export alias in ext-task instead of renaming — stop and adjust.
- [ ] **Step 4: Regenerate + verify gates** — `bun run --cwd bun-apps/pi-agent regen:static`; then:
  - `( cd bun-apps/pi-agent && bun run typecheck )` → clean (binding rename type-checked);
  - `( cd bun-apps/pi-agent && bun test src/static-extensions.test.ts run-dir/manifest-consistency.test.ts )` → PASS (set+order equality with manifest still holds — generator preserves order);
  - `( cd bun-apps/pi-agent && bun test )` → PASS (extension-shortcut-guard, cli-intercept-order, e2e-extensions consume STATIC_EXTENSION_FACTORIES).
- [ ] **Step 5: Commit** — `feat(pi-agent): static-extensions.ts becomes generated from manifest (regen:static)`

### Task A3: byte-exact drift tripwire

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/manifest-consistency.test.ts` (append one test)

- [ ] **Step 1: Write the failing test** — import `buildStaticExtensionsSource` + `manifest.json`; assert `readFileSync("src/static-extensions.ts", "utf8") === buildStaticExtensionsSource({ staticExtensions: manifest.staticExtensions })`. Comment: "editing static-extensions.ts by hand is the drift this catches — the manifest is the only edit point; run `bun run regen:static`."
- [ ] **Step 2: Run** — `bun test --cwd bun-apps/pi-agent manifest-consistency` → PASS (A2 already regenerated; this test proves it stays that way).
- [ ] **Step 3: Spec amendment** — edit `.planning/pi-agent-optimization/spec.md` Phase D: append the amendment paragraph from this plan's "Spec amendment" section.
- [ ] **Step 4: Full gates + PR** — `( cd bun-apps/pi-agent && bun run test && bun run typecheck )`; devops chain `local-ci-cli` → `pr-finish-cli` (PR A). Expected-scope globs: `bun-apps/pi-agent/**` and `.planning/pi-agent-optimization/**`.

---

# PR B — `ext new` scaffold command (D1)

Branch: `ext-new-scaffold` (off latest main after PR A merges). All paths relative to repo root unless noted.

## Design

Command surface (follows the `ext doctor` two-token intercept — `src/cli-argv.ts:18`, `src/cli.ts:92` — top-level, BEFORE `applyPatches()`, never inside the heavy `cli` subtree):

```
bun bun-apps/pi-agent/src/cli.ts ext new <name> [--lib] [--register dynamic|static|none] [--no-install]
```

- `<name>`: kebab-case suffix, `^[a-z][a-z0-9-]*$` (no `pi-agent-ext-` prefix — the tool adds it). Reject reserved dir names and an existing `bun-apps/pi-agent-ext-<name>/`.
- `--lib`: generate the lib-face layout (`src/index.ts` impl + 1-line re-export shim at the entry, `main: "./src/index.ts"`) — the power-tool/hermes-memory shape. Default: in-file impl entry (prompt-history shape).
- `--register`: `dynamic` (default) → append object entry to `manifest.extensions[]`; `static` → append to `manifest.staticExtensions[]` + run `bun run regen:static`; `none` → scaffold only.
- `--no-install`: skip `bun install --cwd bun-apps`.

### Task B1: pure scaffold builder

**Files:**
- Create: `bun-apps/pi-agent/src/ext-new.ts` (pure parts: `parseExtNewArgs`, `buildScaffoldFiles`, `validateName`)
- Test: `bun-apps/pi-agent/src/__tests__/ext-new.test.ts`

**Interfaces:**
- Consumes: nothing from PR A (registration string constants only).
- Produces:
  - `parseExtNewArgs(argv: string[]): { name: string; libFace: boolean; register: "dynamic" | "static" | "none"; install: boolean; outRoot: string }` (`outRoot` defaults to `bun-apps/`, overridable via hidden `--out-root <dir>` for tests); throws on unknown flag / missing name.
  - `buildScaffoldFiles(name: string, opts: { libFace: boolean }): Record<string, string>` — path (relative to the new package dir) → content.

- [ ] **Step 1: Write the failing tests** (arg parsing: defaults, `--lib`, `--register static`, `--no-install`, `--out-root`, throws on `--bogus` / missing name / bad name casing `My-Ext` / `pi-agent-ext-` prefix supplied). File-set assertions: default = `["package.json", "tsconfig.json", "README.md", "extensions/<name>.ts", "extensions/__tests__/entry-smoke.test.ts"]`; `--lib` adds `src/index.ts` and swaps the entry for the shim. Content spot-assertions: package.json `name === "@repo/pi-agent-ext-<name>"`, `pi.extensions === ["./extensions"]`, peer pin `0.84.2`, scripts `test`/`typecheck`; tsconfig `include` covers `extensions/**/*.ts` + `src/**/*.ts` (extension-entry-typechecked guard requires it); entry mentions `BUN_PI_<NAME_SNAKE>`; shim is exactly `export { default } from "../src/index.ts";` after its doc comment.
- [ ] **Step 2: Run to verify failure** — `bun test --cwd bun-apps/pi-agent ext-new` → FAIL.
- [ ] **Step 3: Implement** with these verbatim templates (substitute `<name>`, `<NAME_SNAKE>` = upper-snake, `<camel>` = camelCase):

`package.json` (default; `--lib` inserts `"main": "./src/index.ts",` and an `"."` export):
```json
{
	"name": "@repo/pi-agent-ext-<name>",
	"private": true,
	"version": "0.1.0",
	"description": "Pi extension: <name> (scaffolded by `pi-agent ext new` — replace with a real description).",
	"license": "MIT",
	"keywords": ["pi-package", "<name>"],
	"type": "module",
	"exports": {
		"./extensions/*": "./extensions/*",
		"./src/*": "./src/*",
		"./src/*.js": "./src/*.ts"
	},
	"pi": { "extensions": ["./extensions"] },
	"scripts": { "test": "bun test", "typecheck": "tsc --noEmit" },
	"peerDependencies": { "@earendil-works/pi-coding-agent": "0.84.2" },
	"devDependencies": { "@types/bun": "^1.3.14", "typescript": "^7.0.2" }
}
```

`tsconfig.json` (both variants):
```json
{
	"compilerOptions": {
		"target": "ESNext",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"moduleDetection": "force",
		"allowImportingTsExtensions": true,
		"types": ["bun"],
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"resolveJsonModule": true,
		"noEmit": true
	},
	"include": ["src/**/*.ts", "extensions/**/*.ts"]
}
```

`extensions/<name>.ts` (default in-file):
```ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * <name> — canonical registration entry (impl in-file). If the package grows a
 * lib face, move the impl to src/index.ts and reduce this file to a 1-line
 * re-export shim (see CLAUDE.md "Extension packages"). Self-gate:
 * BUN_PI_<NAME_SNAKE>=0 disables the extension entirely.
 */
const extension: ExtensionFactory = (pi) => {
	if (process.env.BUN_PI_<NAME_SNAKE> === "0") return;
	// TODO: subscribe to pi.on(...) / register tools.
};

export default extension;
```

`extensions/<name>.ts` (`--lib` shim) + `src/index.ts`:
```ts
/**
 * <name> — canonical registration entry. The implementation lives in
 * src/index.ts (also the package.json `main` lib face); this file is the
 * single registered entry point and re-exports the default factory.
 */
export { default } from "../src/index.ts";
```
```ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Self-gate: BUN_PI_<NAME_SNAKE>=0 disables the extension entirely. */
const extension: ExtensionFactory = (pi) => {
	if (process.env.BUN_PI_<NAME_SNAKE> === "0") return;
	// TODO: subscribe to pi.on(...) / register tools.
};

export default extension;
```

`extensions/__tests__/entry-smoke.test.ts` (the mockPi/captureTools harness from the stealth-trim family, minus tool assertions the scaffold can't satisfy yet):
```ts
/**
 * entry-smoke — the factory loads, is callable, and honors its self-gate.
 * When the extension registers tools, tighten this into a stealth-trim guard
 * (short routing description, no promptSnippet/promptGuidelines) — see
 * pi-agent-ext-flux2/extensions/__tests__/stealth-trim.test.ts.
 */
import { test, expect } from "bun:test";
import extensionFactory from "../<name>.ts";

function captureTools() {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (t: Record<string, unknown>) => { tools[t.name as string] = t; },
		on(_event: string, _handler: (...args: unknown[]) => void) {},
		getActiveTools: () => [] as string[],
		setActiveTools: (_tools: string[]) => {},
	};
	extensionFactory(mockPi as never);
	return tools;
}

test("factory loads and self-gates on BUN_PI_<NAME_SNAKE>=0", () => {
	expect(() => captureTools()).not.toThrow();
	const prev = process.env.BUN_PI_<NAME_SNAKE>;
	process.env.BUN_PI_<NAME_SNAKE> = "0";
	try {
		expect(() => captureTools()).not.toThrow();
	} finally {
		if (prev === undefined) delete process.env.BUN_PI_<NAME_SNAKE>;
		else process.env.BUN_PI_<NAME_SNAKE> = prev;
	}
});
```

`README.md`: name, one-line description, `bun test` / `bun run typecheck`, registration note (where it was registered), self-gate env name.

- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(pi-agent): pure scaffold builder for ext new`

### Task B2: CLI intercept wiring

**Files:**
- Modify: `bun-apps/pi-agent/src/cli-argv.ts` (add `isExtNewCommand`)
- Modify: `bun-apps/pi-agent/src/cli.ts` (intercept branch beside the `ext doctor` one, ~line 92)
- Test: extend `bun-apps/pi-agent/src/__tests__/ext-new.test.ts` + the existing cli-argv test file if present (else same file)

- [ ] **Step 1: Failing test** — `isExtNewCommand(["ext", "new", "foo"]) === true`; `["ext", "doctor"]`, `["ext"]`, `["new"]` → false (same contract as `isExtDoctorCommand`).
- [ ] **Step 2: Verify fail** → FAIL.
- [ ] **Step 3: Implement** — `export function isExtNewCommand(argv: string[]): boolean { return argv[0] === "ext" && argv[1] === "new"; }` with the same only-argv[0] doc rationale; in `cli.ts` beside the ext-doctor branch: `if (isExtNewCommand(argv)) { const { runExtNew } = await import("./ext-new.ts"); process.exitCode = await runExtNew(argv.slice(2)); return; }` (before `applyPatches()` — scaffold writes must not run patches).
- [ ] **Step 4: Verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(pi-agent): ext new argv intercept`

### Task B3: writer + registration + install

**Files:**
- Modify: `bun-apps/pi-agent/src/ext-new.ts` (add `runExtNew(argv): Promise<number>`)
- Modify: `bun-apps/pi-agent/run-dir/manifest.json` (at runtime, not committed)
- Test: extend `bun-apps/pi-agent/src/__tests__/ext-new.test.ts`

**Interfaces:**
- Consumes: `bun run --cwd bun-apps/pi-agent regen:static` (PR A) when `--register static`.
- Produces: `runExtNew` — writes files under `<outRoot>/pi-agent-ext-<name>/`, edits the manifest, installs, prints next steps; returns exit code.

- [ ] **Step 1: Failing integration test** (no real bun-apps mutation): spawn the command with `--out-root <tmpdir>` + `--register none` + `--no-install`:
  ```ts
  test("ext new end-to-end scaffolds a loadable package into a temp root", async () => {
	  const tmp = mkdtempSync(join(tmpdir(), "ext-new-"));
	  const proc = Bun.spawn(["bun", "src/cli.ts", "ext", "new", "smoke-test-ext", "--out-root", tmp, "--register", "none", "--no-install"], { cwd: PI_AGENT_DIR, stdout: "pipe", stderr: "pipe" });
	  const code = await proc.exited;
	  expect(code).toBe(0);
	  expect(existsSync(join(tmp, "pi-agent-ext-smoke-test-ext/package.json"))).toBe(true);
  });
  ```
- [ ] **Step 2: Verify fail** → FAIL (`runExtNew` not exported yet).
- [ ] **Step 3: Implement `runExtNew`:**
  1. `parseExtNewArgs`; validate name + target dir absence (exit 1 with clear message).
  2. Write `buildScaffoldFiles` output.
  3. Registration:
     - `dynamic`: read `run-dir/manifest.json`, push `{ "name": "pi-agent-ext-<name>", "entry": "pi-agent-ext-<name>/extensions/<name>.ts", "bundleMode": "thin", "testGate": "bun test --cwd bun-apps/pi-agent-ext-<name>", "version": "0.1.0" }` onto `extensions`, write back `JSON.stringify(manifest, null, "\t") + "\n"` (note: one-time whole-file normalization — mixed object/bare-string entries and key order are preserved by JS object semantics; call this out in the PR body).
     - `static`: append `<name>` to `staticExtensions`, write back the same way, then spawn `bun run --cwd bun-apps/pi-agent regen:static` (fail → exit 1, tell the user to run it manually).
     - `none`: skip.
     - Never both lists (double-registration invariant; the consistency test enforces it anyway).
  4. Unless `--no-install`: spawn `bun install --cwd bun-apps` (inherit stdio).
  5. Print next steps: package dir, `bun test --cwd bun-apps/pi-agent-ext-<name>`, `bun run --cwd bun-apps/pi-agent-ext-<name> typecheck`, and for `none` the manual registration pointers (manifest object entry vs staticExtensions + regen:static).
- [ ] **Step 4: Verify pass** → PASS; also run the full-loop manually once and DELETE the result:
  `bun bun-apps/pi-agent/src/cli.ts ext new scaffold-check --register dynamic` → confirm manifest gained the entry → `( cd bun-apps/scaffold… )` n/a → `( cd bun-apps/pi-agent-ext-scaffold-check && bun run test && bun run typecheck )` → green → `git checkout -- bun-apps/pi-agent/run-dir/manifest.json && rm -rf bun-apps/pi-agent-ext-scaffold-check`.
- [ ] **Step 5: Commit** — `feat(pi-agent): ext new writes, registers, and installs a new extension package`

### Task B4: docs + PR

- [ ] **Step 1: Docs** — CLAUDE.md §"Extension packages": add one line at the top of the section: "Scaffold a new package with `bun bun-apps/pi-agent/src/cli.ts ext new <name>` (`--lib` for a src/index.ts lib face; `--register dynamic|static|none` — default dynamic) — then implement." Nothing else changes (the section's rules stay: the scaffold bakes them in).
- [ ] **Step 2: Full gates** — `( cd bun-apps/pi-agent && bun run test && bun run typecheck )`; `bun run test:ext-entry` from `bun-apps/` (scaffold did not create a package in-tree, but the guard must stay green); devops chain `local-ci-cli` → `pr-finish-cli` (PR B). Expected-scope: `bun-apps/pi-agent/**`, `CLAUDE.md`, `.planning/pi-agent-optimization/**`.

---

## Verification (whole Phase D)

1. `( cd bun-apps/pi-agent && bun run test && bun run typecheck )` green on both PRs.
2. Drift proof (PR A): edit `static-extensions.ts` by hand → `manifest-consistency` fails; `bun run regen:static` restores green.
3. Full-loop proof (PR B Task B3 step 4): `ext new scaffold-check --register dynamic` produces a package whose own `bun run test` + `typecheck` pass, manifest gains the entry, then cleaned up.
4. local_ci pass, ≤5 min, on both PRs (deploy-sensitive gate in ci-recipe does NOT trigger — no deploy-surface paths touched; manifest.json IS in the sensitive set, so PR B's committed diff must NOT include manifest.json changes — only runtime edits, verified by Task B3's cleanup).
5. Independent SDD reviewer on each PR; fix loop ≤5 rounds.

## Out of scope (explicit)

- `EXTENSION_SPECS` codegen (not derivable — see amendment); `deploy-config.yaml` (separate portable profile); biome adoption for scaffolded pkgs; C3 stealth-trim shared helper (Phase C class — abandoned); renaming `manifest.json` bare-string `extensions[]` entries to object form (cosmetic; `parseManifestEntry` already normalizes).
