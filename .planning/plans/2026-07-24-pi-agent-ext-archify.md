# pi-agent-ext-archify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `bun-apps/pi-agent-ext-archify/` — a self-contained pi extension that lets the pi agent author typed-JSON-IR technical diagrams and render them to validated HTML, vendoring archify@2.12.0 as a pinned local snapshot.

**Architecture:** Vendor-copy archify's `.mjs` renderers + 6 JSON schemas + CLI bin + full `SKILL.md` into `vendored/` (zero reference back to `../archify`). A TypeScript extension (`extensions/archify.ts`) registers three tools (`archify_render`, `archify_validate`, `archify_delta`) that shell out to the **local** `bun vendored/bin/archify.mjs`. A condensed ~3 KB skill (`skills/archify/SKILL.md`) carries base IR-authoring curriculum and points at the vendored `SKILL.md`/schemas for on-demand depth. Tests are Bun-only (golden snapshot + wrapper tests); archify's own `node --test` suite is NOT vendored.

**Tech Stack:** TypeScript (strict, `module:Preserve`, bun types), TypeBox (`typebox`), `@earendil-works/pi-coding-agent` + `pi-ai` + `pi-tui` peer deps, Bun runtime, vendored archify `.mjs` (dep-light; only `ajv` as a devDep for the codegen drift gate).

## Global Constraints

- **Self-contained (hard constraint):** the package has ZERO reference back to `/Users/huangziyu/proj/archify`. Everything (renderers, schemas, bin, full `SKILL.md`, sample IRs, golden reference HTML) lives under `bun-apps/pi-agent-ext-archify/`. Render/validate/delta shell out to the package-local `vendored/bin/archify.mjs`, never `../archify`.
- **Vendor source:** `/Users/huangziyu/proj/archify/archify/` (archify@2.12.0, MIT). Copy a frozen snapshot; do not symlink/submodule.
- **Vendored layout must mirror archify's internal layout** (`bin/`, `renderers/`, `schemas/` as siblings under `vendored/`) so archify's `import.meta.url`/`__dirname` relative path resolution keeps working.
- **Single runtime:** Bun only. No `node` dependency in CI. `bun` is on PATH in CI and locally.
- **Registration:** dynamic/opt-in via `run-dir/manifest.json` (`extensions[]` object + `skills[]`); NOT `staticExtensions[]`, NOT `binarySkills[]`, no CLI subcommand.
- **Test gate:** `cd bun-apps/pi-agent-ext-archify && bun test` (CI matrix `test-cmd: "bun test"`). Required check from day 1.
- **Repo conventions:** biome `format`→`check` before push; enumerate exact `git add` paths (never `-A`); squash-merge only.
- **Manifest testGate:** `cd bun-apps/pi-agent-ext-archify && bun test`.

### Decisions this plan implements (from the wayfinder map)

`.planning/2026-07-23-try-to-convert-archify-into-bun-apps-pi-agen-ext/map.md` — all 7 tickets resolved. Read it for rationale. Key outputs: vendored `.mjs` runs clean under Bun (01); deploy needs `exports`/`files` for `vendored/` + `import` JSON schemas (02); dynamic registration (03); Bun-only testing with a re-implemented golden snapshot (04); cwd default output, `outputPath`→`meta.output`→fallback slug (05); ~3 KB condensed skill (06); required-from-day-1 CI, auto-routed (07).

---

## File Structure

**Create** (under `bun-apps/pi-agent-ext-archify/`):
- `package.json` — workspace package, `exports`/`files` incl. `vendored/`, peerDeps, `ajv` devDep.
- `tsconfig.json` — strict (mirror research-tool).
- `.gitignore` — `node_modules/`, build artifacts.
- `README.md` — what the extension does.
- `extensions/archify.ts` — **single registration entry**; factory registers 3 tools.
- `lib/run.ts` — `runArchify()` spawnSync wrapper (local `bun vendored/bin/archify.mjs`) + temp-IR helper + BIN path resolver.
- `lib/output-path.ts` — `resolveOutputPath()` (param → `meta.output` → fallback slug).
- `lib/render.ts` — `archify_render` tool.
- `lib/validate.ts` — `archify_validate` tool.
- `lib/delta.ts` — `archify_delta` tool.
- `vendored/` — `bin/archify.mjs`, `renderers/`, `schemas/`, `delta/architecture-delta.mjs`, `assets/template.html`, `scripts/{generate-validators,check-render-output}.mjs`, `SKILL.md`, `LICENSE`, `VERSION`, `README.md` (~1.4M).
- `skills/archify/SKILL.md` — condensed ~3 KB skill.
- `__tests__/output-path.test.ts`, `__tests__/run.test.ts`, `__tests__/validate.test.ts`, `__tests__/render.test.ts`, `__tests__/delta.test.ts`, `__tests__/validators-drift.test.ts`.
- `__tests__/fixtures/mini.architecture.json`, `__tests__/fixtures/mini.architecture.v2.json`, `__tests__/fixtures/mini.architecture.html` (golden reference, generated in Task 4).

**Modify:**
- `bun-apps/pi-agent/run-dir/manifest.json` — add `extensions[]` object + `skills[]` entry.
- `.github/workflows/ci.yml` — add matrix row.
- `.github/CI.md` — add to required `contexts[]` + bump counts.

---

## Task 1: Scaffold package + vendor-copy archify snapshot

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/package.json`, `tsconfig.json`, `.gitignore`, `README.md`
- Create: `bun-apps/pi-agent-ext-archify/extensions/archify.ts` (minimal loadable factory)
- Create: `bun-apps/pi-agent-ext-archify/vendored/{bin/archify.mjs, renderers/, schemas/, assets/, delta/architecture-delta.mjs, scripts/generate-validators.mjs + check-render-output.mjs, SKILL.md, LICENSE, VERSION, README.md}`

**Interfaces:**
- Produces: a loadable package whose factory exports default; the vendored bin invokable as `bun <pkg>/vendored/bin/archify.mjs render architecture <ir> <out>`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@repo/pi-agent-ext-archify",
  "private": true,
  "version": "0.1.0",
  "description": "Pi extension: author typed-JSON-IR technical diagrams and render them to validated, self-contained HTML. Vendors archify@2.12.0.",
  "license": "MIT",
  "keywords": ["pi-package", "archify", "diagrams", "architecture", "visualization"],
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "exports": {
    "./extensions/*": "./extensions/*",
    "./lib/*": "./lib/*",
    "./vendored/*": "./vendored/*"
  },
  "files": [
    "extensions",
    "lib",
    "vendored",
    "skills",
    "README.md"
  ],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  },
  "dependencies": {},
  "peerDependencies": {
    "@earendil-works/pi-ai": "0.81.1",
    "@earendil-works/pi-coding-agent": "0.81.1",
    "@earendil-works/pi-tui": "0.81.1",
    "typebox": "*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "ajv": "^8.17.1",
    "typescript": "^6.0.3"
  }
}
```

> `exports`/`files` include `vendored/` per map decision 02 (THIN bundling follows ESM imports; `--snapshot` copies everything; either way `vendored/` must be declared so deploy captures it).

- [ ] **Step 2: Create `tsconfig.json`** (mirror `pi-agent-ext-research-tool/tsconfig.json`)

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "allowJs": true,
    "types": ["bun"],
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["lib/**/*.ts", "extensions/**/*.ts", "__tests__/**/*.ts"]
}
```

- [ ] **Step 3: Create `.gitignore` and `README.md`**

`.gitignore`:
```
node_modules/
```

`README.md`:
```markdown
# pi-agent-ext-archify

A pi agent extension that lets the agent author typed-JSON-IR technical diagrams
(architecture / workflow / sequence / data-flow / lifecycle) and render them to
self-contained, validated HTML.

Vendors archify@2.12.0 (MIT, https://github.com/tt-a1i/archify) as a pinned local
snapshot under `vendored/`. No dependency on the upstream source after vendor-copy.

**Tools:** `archify_render`, `archify_validate`, `archify_delta`.
**Skill:** `archify` (condensed; loads vendored depth on demand).
```

- [ ] **Step 4: Create minimal `extensions/archify.ts`** (registers nothing yet; just loadable)

```typescript
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * pi-agent-ext-archify — typed-JSON-IR diagram authoring + rendering.
 *
 * Tools registered in later tasks: archify_render, archify_validate, archify_delta.
 * Vendored archify@2.12.0 runtime + skill live under ./vendored (self-contained).
 */
const extension: ExtensionFactory = (_pi) => {
  // Tools registered in Tasks 3-5.
};

export default extension;
```

- [ ] **Step 5: Vendor-copy archify's runtime + skill subset into `vendored/`**

Run from repo root (exact paths; do NOT use `cp -R` of the whole repo):

```bash
cd /Users/huangziyu/proj/video_generation__archify
SRC=/Users/huangziyu/proj/archify/archify
DST=bun-apps/pi-agent-ext-archify/vendored
mkdir -p "$DST/bin" "$DST/scripts" "$DST/delta"   # do NOT pre-create $DST/assets here — BSD `cp -R` nests the source INTO a pre-existing dir; the `cp -R` below creates vendored/assets flat (mirrors renderers/ & schemas/).
cp "$SRC/bin/archify.mjs"        "$DST/bin/archify.mjs"
cp -R "$SRC/renderers"           "$DST/renderers"
cp -R "$SRC/schemas"             "$DST/schemas"
cp -R "$SRC/assets"              "$DST/assets"               # template.html — loadDiagram reads it on EVERY render/compare (renderers/shared/cli.mjs:21)
cp    "$SRC/delta/architecture-delta.mjs" "$DST/delta/architecture-delta.mjs"
cp    "$SRC/scripts/generate-validators.mjs" "$DST/scripts/generate-validators.mjs"
cp    "$SRC/scripts/check-render-output.mjs" "$DST/scripts/check-render-output.mjs"  # bin invokes it on render/compare (the "N/N checks" receipt)
cp    "$SRC/SKILL.md"            "$DST/SKILL.md"
cp    "$SRC/LICENSE"             "$DST/LICENSE"
printf 'archify@2.12.0 (MIT, https://github.com/tt-a1i/archify)\nvendored snapshot — self-contained, do not edit vendored source here; re-sync by re-copying from upstream.\n' > "$DST/VERSION"
cat > "$DST/README.md" <<'EOF'
# vendored/ — archify runtime snapshot

Vendored snapshot of **archify@2.12.0** (MIT). Self-contained — no reference to any sibling archify checkout at runtime.

- `bin/archify.mjs` is the **hand-written ESM CLI entry** (npm `bin` convention + `#!/usr/bin/env node` shebang) — **not a build artifact**. archify is plain ESM `.mjs`; there is no `.ts`→`.mjs` build step.
- The **only machine-generated** file is `renderers/shared/generated-validators.mjs` (ajv codegen from `schemas/`, regenerated via `scripts/generate-validators.mjs --check`).
- Layout mirrors archify's own tree: `bin/` + `renderers/` + `schemas/` + `delta/` + `assets/` + `scripts/` are siblings under `vendored/`, because both `bin/archify.mjs` and `renderers/shared/cli.mjs` (`loadDiagram`) resolve them via `skillRoot`. **Do not rename `bin/` or `assets/`** — `loadDiagram` reads `assets/template.html` on every render/compare; renaming breaks it.

Re-sync: re-copy from upstream archify@2.12.0. Do not edit vendored source here.
EOF
```

> **Do NOT** copy archify's `test/` (716K), `examples/` (2.6M), `package.json`, `package-lock.json`, the browser-launching `bin/preview.mjs`/`bin/open-artifact.mjs`, or `scripts/render-examples.mjs` (only the `examples` command uses it). The set above (~1.4M, dominated by the 568K `assets/template.html`) is the **runtime subset** for render/validate/compare — not a full clone of the ~3.4M codebase.

> **Vendor note (investigated 2026-07-24):** `bin/archify.mjs` is a hand-written **thin CLI dispatcher** (not generated — no build step writes to `bin/`). It locates renderers via `skillRoot/renderers/<type>/render-<type>.mjs` and `spawnSync`s them as subprocesses (under Bun → spawns `bun`). The renderers are **argv-scripts with zero exports** — they parse `process.argv` at module top-level via `shared/cli.mjs`'s `loadDiagram` — so in-process `import { render }` is impossible without refactoring all 5 renderers + `shared/cli.mjs` (the deep TS rewrite ruled out in map decision Q1). `delta/architecture-delta.mjs` is `import()`ed by bin for `compare` (Task 5). `assets/template.html` is read by `loadDiagram` (cli.mjs:21) on every render/compare, and `scripts/check-render-output.mjs` is invoked by bin to emit the "N/N checks" receipt on render/compare — both vendored. **Subprocess via the vendored bin is the correct, Bun-proven path (all three commands verified rendering/validating/comparing) — do not rewrite bin.**

- [ ] **Step 6: Verify vendored bin renders + compares under Bun**

```bash
cd /Users/huangziyu/proj/video_generation__archify
# render probe (bin dispatcher → renderers/architecture; loadDiagram reads assets/template.html):
bun bun-apps/pi-agent-ext-archify/vendored/bin/archify.mjs render architecture \
  /Users/huangziyu/proj/archify/archify/examples/web-app.architecture.json /tmp/archify-vendor-probe.html
ls -la /tmp/archify-vendor-probe.html   # expect ~591 KB
# validate probe (--json; confirms generated-validators.mjs + schemas load):
bun bun-apps/pi-agent-ext-archify/vendored/bin/archify.mjs validate architecture \
  /Users/huangziyu/proj/archify/archify/examples/web-app.architecture.json --json | head -c 200 ; echo
# compare/delta probe (bin → delta/architecture-delta.mjs + check-render-output; confirms both vendored):
bun bun-apps/pi-agent-ext-archify/vendored/bin/archify.mjs compare architecture \
  /Users/huangziyu/proj/archify/archify/examples/web-app.architecture.json \
  /Users/huangziyu/proj/archify/archify/examples/web-app.architecture.json /tmp/archify-delta-probe.html
ls -la /tmp/archify-delta-probe.html   # expect ~1.6 MB
```

Expected: render HTML ~591 KB; validate JSON `"ok":true` + a `checks[]` array; compare HTML ~1.6 MB + "N/N checks". If `render` ENOENTs on `assets/template.html`, the `assets/` dir was not vendored. If `compare` ENOENTs on `scripts/check-render-output.mjs` or `delta/architecture-delta.mjs`, that file was not vendored. If `render`/`compare` error on renderer path resolution, the vendored layout does not mirror archify's (`bin/` + `renderers/` + `assets/` must be siblings under `vendored/`).

- [ ] **Step 7: Install deps + typecheck the skeleton**

```bash
cd /Users/huangziyu/proj/video_generation__archify/bun-apps
bun install                                                   # links the new workspace package
cd bun-apps/pi-agent-ext-archify
bun run typecheck                                             # tsc --noEmit
```

Expected: typecheck passes (empty factory). `bun install` from `bun-apps/` (never repo root).

- [ ] **Step 8: Commit**

```bash
cd /Users/huangziyu/proj/video_generation__archify
git add bun-apps/pi-agent-ext-archify/package.json \
        bun-apps/pi-agent-ext-archify/tsconfig.json \
        bun-apps/pi-agent-ext-archify/.gitignore \
        bun-apps/pi-agent-ext-archify/README.md \
        bun-apps/pi-agent-ext-archify/extensions/archify.ts \
        bun-apps/pi-agent-ext-archify/vendored \
        bun-apps/bun.lock
git commit -m "feat(archify): scaffold pi-agent-ext-archify + vendor archify@2.12.0 snapshot"
```

---

## Task 2: Output-path resolver (pure, TDD)

**Files:**
- Create: `lib/output-path.ts`
- Test: `__tests__/output-path.test.ts`

**Interfaces:**
- Produces: `resolveOutputPath(opts: { cwd: string; outputPath?: string; metaOutput?: string; diagramType: string; exists?: (p: string) => boolean }): string`

- [ ] **Step 1: Write the failing test**

`__tests__/output-path.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { resolveOutputPath } from "../lib/output-path.ts";

describe("resolveOutputPath", () => {
  it("honors explicit outputPath (absolute)", () => {
    expect(resolveOutputPath({ cwd: "/work", outputPath: "/tmp/x.html", diagramType: "architecture" }))
      .toBe("/tmp/x.html");
  });
  it("honors explicit outputPath (cwd-relative)", () => {
    expect(resolveOutputPath({ cwd: "/work", outputPath: "out/x.html", diagramType: "architecture" }))
      .toBe("/work/out/x.html");
  });
  it("falls back to meta.output (cwd-relative) when no outputPath", () => {
    expect(resolveOutputPath({ cwd: "/work", metaOutput: "my-map.html", diagramType: "architecture" }))
      .toBe("/work/my-map.html");
  });
  it("falls back to <diagram_type>.html when neither given", () => {
    expect(resolveOutputPath({ cwd: "/work", diagramType: "workflow" })).toBe("/work/workflow.html");
  });
  it("uses collision-safe slug when default exists", () => {
    expect(resolveOutputPath({ cwd: "/work", diagramType: "architecture", exists: () => true }))
      .toMatch(/^\/work\/architecture-[0-9a-z]{6}\.html$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/output-path.test.ts
```
Expected: FAIL — `Cannot find module '../lib/output-path.ts'`.

- [ ] **Step 3: Implement `lib/output-path.ts`**

```typescript
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export interface ResolveOutputPathOpts {
  cwd: string;
  outputPath?: string;
  metaOutput?: string;
  diagramType: string;
  /** Test seam: defaults to a real fs existence check via Bun. */
  exists?: (absPath: string) => boolean;
}

/** Resolve the destination HTML path: outputPath param → IR meta.output → <type>.html (collision-safe). */
export function resolveOutputPath(opts: ResolveOutputPathOpts): string {
  const { cwd, diagramType } = opts;
  const named = opts.outputPath ?? opts.metaOutput;
  if (named) return isAbsolute(named) ? named : join(cwd, named);
  const exists = opts.exists ?? existsSync;
  const base = join(cwd, `${diagramType}.html`);
  if (!exists(base)) return base;
  const suffix = createHash("sha256").update(`${Date.now()}`).digest("hex").slice(0, 6);
  return join(cwd, `${diagramType}-${suffix}.html`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/output-path.test.ts
```
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/lib/output-path.ts bun-apps/pi-agent-ext-archify/__tests__/output-path.test.ts
git commit -m "feat(archify): output-path resolver (param → meta.output → fallback slug)"
```

---

## Task 3: Subprocess helper + `archify_validate` tool

**Files:**
- Create: `lib/run.ts`
- Create: `lib/validate.ts`
- Modify: `extensions/archify.ts` (register validate tool)
- Test: `__tests__/run.test.ts`, `__tests__/validate.test.ts`, `__tests__/fixtures/mini.architecture.json`

**Interfaces:**
- Produces: `runArchify(args, cwd)` → `{stdout, stderr, status}`; `archifyValidate` tool registered as `archify_validate`.

- [ ] **Step 1: Create the minimal valid architecture fixture**

`__tests__/fixtures/mini.architecture.json`:
```json
{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": { "title": "Mini", "output": "mini.html" },
  "components": [
    { "id": "client", "type": "frontend", "label": "Client", "pos": [40, 40], "size": [120, 60] },
    { "id": "server", "type": "backend", "label": "Server", "pos": [260, 40], "size": [120, 60] },
    { "id": "db", "type": "database", "label": "DB", "pos": [480, 40], "size": [120, 60] }
  ],
  "connections": [
    { "id": "c1", "from": "client", "to": "server" },
    { "id": "c2", "from": "server", "to": "db", "label": "SQL" }
  ]
}
```

- [ ] **Step 2: Write failing test for `runArchify`**

`__tests__/run.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { runArchify } from "../lib/run.ts";

const fixture = join(import.meta.dir, "fixtures/mini.architecture.json");

describe("runArchify", () => {
  it("validate returns structured JSON on a valid IR (--json)", () => {
    const r = runArchify(["validate", "architecture", fixture, "--json"], import.meta.dir);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe("validate");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/run.test.ts
```
Expected: FAIL — `Cannot find module '../lib/run.ts'`.

- [ ] **Step 4: Implement `lib/run.ts`**

```typescript
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Absolute path to the package-local vendored archify CLI. */
export const VENDORED_BIN = join(PKG_ROOT, "vendored/bin/archify.mjs");

export interface ArchifyResult { stdout: string; stderr: string; status: number | null }

/** Run the local vendored archify CLI under Bun. Never shells out to ../archify. */
export function runArchify(args: string[], cwd: string): ArchifyResult {
  const r = spawnSync("bun", [VENDORED_BIN, ...args], { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/** Write an IR object to a temp file, run fn(irPath), then clean up. */
export function withTempIr<T>(ir: unknown, fn: (irPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "archify-ir-"));
  const irPath = join(dir, "ir.json");
  try {
    writeFileSync(irPath, JSON.stringify(ir));
    return fn(irPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Run `run.test.ts` — verify pass**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/run.test.ts
```
Expected: PASS.

- [ ] **Step 6: Write failing test for the validate tool**

`__tests__/validate.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { archifyValidate } from "../lib/validate.ts";

const validIr = {
  schema_version: 1, diagram_type: "architecture",
  meta: { title: "Mini" },
  components: [{ id: "a", type: "backend", label: "A", pos: [0, 0], size: [10, 10] }],
  connections: [],
};
const invalidIr = { schema_version: 1, diagram_type: "architecture", meta: {}, components: [] };

describe("archify_validate", () => {
  it("accepts a valid IR", async () => {
    const res = await archifyValidate({ ir: validIr }, { cwd: import.meta.dir });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("valid");
  });
  it("reports diagnostics for an invalid IR (missing meta.title)", async () => {
    const res = await archifyValidate({ ir: invalidIr }, { cwd: import.meta.dir });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("title");
  });
});
```

- [ ] **Step 7: Run to verify it fails**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/validate.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `lib/validate.ts`**

```typescript
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runArchify, withTempIr } from "./run.ts";

export const validateParams = Type.Object({
  ir: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "The diagram IR as a JSON object. Omit if passing irPath." })),
  irPath: Type.Optional(
    Type.String({ description: "Path to an IR .json file (absolute or cwd-relative). Used if `ir` is omitted." })),
  type: Type.Optional(
    Type.String({ description: "Diagram type: architecture|workflow|sequence|dataflow|lifecycle. Inferred from ir.diagram_type if omitted." })),
});

export interface ValidateCtx { cwd: string }

/** Pure entry point reused by tests (no defineTool wrapper). */
export async function archifyValidate(params: { ir?: unknown; irPath?: string; type?: string }, ctx: ValidateCtx) {
  const type = params.type ?? (params.ir as { diagram_type?: string } | undefined)?.diagram_type;
  if (!type) return err("diagram type could not be determined; pass `type` or set ir.diagram_type.");
  const run = (irPath: string) => runArchify(["validate", type, irPath, "--json"], ctx.cwd);
  const { stdout, status } = params.irPath
    ? run(params.irPath)
    : withTempIr(params.ir ?? {}, run);
  if (status !== 0) return err(`archify validate failed (exit ${status}).\n${stdout}`);
  // archify validate --json emits { ok, error?, diagnostics?: [...] } — NOT `errors`.
  const report = JSON.parse(stdout) as { ok?: boolean; error?: string; diagnostics?: unknown[] };
  const ok = report.ok === true;
  return {
    content: [{ type: "text" as const, text: ok ? `IR is valid (${type}).` : `IR has ${report.diagnostics?.length ?? 1} issue(s):\n${report.error ?? stdout}` }],
    details: { type, valid: ok, report },
    ...(ok ? {} : { isError: true }),
  };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message }, isError: true };
}

export const validateTool = defineTool({
  name: "archify_validate",
  label: "Archify Validate",
  description:
    "Validate a typed-JSON-IR diagram against its schema BEFORE rendering. Pass `ir` (the JSON object) or `irPath`. " +
    "Returns validation diagnostics. Always validate before archify_render; never deliver unvalidated IR.",
  parameters: validateParams,
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyValidate(params, { cwd: ctx.cwd });
  },
});
```

- [ ] **Step 9: Register the tool in `extensions/archify.ts`**

Replace the factory body:
```typescript
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateTool } from "../lib/validate.ts";

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(validateTool);
};

export default extension;
```

- [ ] **Step 10: Run validate test + typecheck — verify pass**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/validate.test.ts && bun run typecheck
```
Expected: PASS + typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/lib/run.ts \
        bun-apps/pi-agent-ext-archify/lib/validate.ts \
        bun-apps/pi-agent-ext-archify/extensions/archify.ts \
        bun-apps/pi-agent-ext-archify/__tests__/run.test.ts \
        bun-apps/pi-agent-ext-archify/__tests__/validate.test.ts \
        bun-apps/pi-agent-ext-archify/__tests__/fixtures/mini.architecture.json
git commit -m "feat(archify): subprocess helper + archify_validate tool"
```

---

## Task 4: `archify_render` tool + golden snapshot

**Files:**
- Create: `lib/render.ts`
- Modify: `extensions/archify.ts` (register render tool)
- Test: `__tests__/render.test.ts`
- Create: `__tests__/fixtures/mini.architecture.html` (golden reference, generated in Step 4)

**Interfaces:**
- Produces: `archifyRender` tool registered as `archify_render`. Writes HTML to the resolved output path, returns the absolute path.

- [ ] **Step 1: Write failing test (golden snapshot)**

`__tests__/render.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { archifyRender } from "../lib/render.ts";

const fixtureIr = join(import.meta.dir, "fixtures/mini.architecture.json");
const referenceHtml = join(import.meta.dir, "fixtures/mini.architecture.html");

const normalize = (s: string) => s.replace(/\r\n?/g, "\n");

describe("archify_render (golden snapshot)", () => {
  it("renders the fixture IR to HTML matching the checked-in reference", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-render-"));
    const res = await archifyRender({ irPath: fixtureIr }, { cwd: outDir });
    expect(res.isError).toBeFalsy();
    const out = res.details!.path as string;
    const fresh = normalize(await Bun.file(out).text());
    const ref = normalize(await Bun.file(referenceHtml).text());
    expect(fresh).toBe(ref);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/render.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/render.ts`**

```typescript
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { runArchify, withTempIr } from "./run.ts";
import { resolveOutputPath } from "./output-path.ts";

export interface RenderCtx { cwd: string }

/** Pure entry point: resolves output, runs vendored `render`, returns the absolute HTML path. */
export async function archifyRender(params: { ir?: unknown; irPath?: string; outputPath?: string }, ctx: RenderCtx) {
  const irPathGiven = params.irPath ? (isAbsolute(params.irPath) ? params.irPath : join(ctx.cwd, params.irPath)) : null;
  const irMetaOutput = (params.ir as { meta?: { output?: string } } | undefined)?.meta?.output;
  const type = (params.ir as { diagram_type?: string } | undefined)?.diagram_type ?? "architecture";
  const outPath = resolveOutputPath({ cwd: ctx.cwd, outputPath: params.outputPath, metaOutput: irMetaOutput, diagramType: type });

  const status = irPathGiven
    ? runArchify(["render", type, irPathGiven, outPath], ctx.cwd).status
    : withTempIr(params.ir ?? {}, (irPath) => runArchify(["render", type, irPath, outPath], ctx.cwd).status);

  if (status !== 0) {
    return { content: [{ type: "text" as const, text: `Error: archify render failed (exit ${status}). Validate the IR first with archify_validate.` }], details: { error: "render failed", status }, isError: true };
  }
  return {
    content: [{ type: "text" as const, text: `Rendered ${type} diagram → ${outPath}` }],
    details: { path: outPath, type },
  };
}

export const renderTool = defineTool({
  name: "archify_render",
  label: "Archify Render",
  description:
    "Render a typed-JSON-IR diagram to a self-contained HTML file (inline SVG, theme toggle, export menu). " +
    "Pass `ir` (JSON object) or `irPath`. Optional `outputPath` (absolute or cwd-relative); default honors ir.meta.output else <cwd>/<type>.html. " +
    "Validate first with archify_validate. Returns the absolute output path.",
  parameters: Type.Object({
    ir: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Diagram IR as a JSON object." })),
    irPath: Type.Optional(Type.String({ description: "Path to an IR .json file (absolute or cwd-relative)." })),
    outputPath: Type.Optional(Type.String({ description: "Output HTML path (absolute or cwd-relative). Default: ir.meta.output else <cwd>/<type>.html." })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyRender(params, { cwd: ctx.cwd });
  },
});
```

- [ ] **Step 4: Generate the golden reference HTML (checked-in fixture)**

```bash
cd bun-apps/pi-agent-ext-archify
bun vendored/bin/archify.mjs render architecture __tests__/fixtures/mini.architecture.json __tests__/fixtures/mini.architecture.html
ls -la __tests__/fixtures/mini.architecture.html   # expect ~577 KB
```

> This file is the golden reference. It is deterministic (renderer is deterministic; CRLF normalized in the test). Commit it.

- [ ] **Step 5: Register render tool in `extensions/archify.ts`**

```typescript
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateTool } from "../lib/validate.ts";
import { renderTool } from "../lib/render.ts";

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(validateTool);
  pi.registerTool(renderTool);
};

export default extension;
```

- [ ] **Step 6: Run render test + typecheck — verify pass**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/render.test.ts && bun run typecheck
```
Expected: PASS (fresh render byte-matches the reference, CRLF-normalized).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/lib/render.ts \
        bun-apps/pi-agent-ext-archify/extensions/archify.ts \
        bun-apps/pi-agent-ext-archify/__tests__/render.test.ts \
        bun-apps/pi-agent-ext-archify/__tests__/fixtures/mini.architecture.html
git commit -m "feat(archify): archify_render tool + golden snapshot fixture"
```

---

## Task 5: `archify_delta` tool (architecture-only)

**Files:**
- Create: `lib/delta.ts`
- Modify: `extensions/archify.ts` (register delta tool)
- Test: `__tests__/delta.test.ts`, `__tests__/fixtures/mini.architecture.v2.json`

**Interfaces:**
- Produces: `archifyDelta` tool registered as `archify_delta`. Architecture-only (archify `compare` requires `type === 'architecture'`).

- [ ] **Step 1: Create the v2 fixture (base + one added component)**

`__tests__/fixtures/mini.architecture.v2.json` — copy `mini.architecture.json` and add a 4th component `{ "id": "cache", "type": "database", "label": "Cache", "pos": [480, 160], "size": [120, 60] }` plus a connection `{ "id": "c3", "from": "server", "to": "cache", "label": "read" }`.

```json
{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": { "title": "Mini v2", "output": "mini-v2.html" },
  "components": [
    { "id": "client", "type": "frontend", "label": "Client", "pos": [40, 40], "size": [120, 60] },
    { "id": "server", "type": "backend", "label": "Server", "pos": [260, 40], "size": [120, 60] },
    { "id": "db", "type": "database", "label": "DB", "pos": [480, 40], "size": [120, 60] },
    { "id": "cache", "type": "database", "label": "Cache", "pos": [480, 160], "size": [120, 60] }
  ],
  "connections": [
    { "id": "c1", "from": "client", "to": "server" },
    { "id": "c2", "from": "server", "to": "db", "label": "SQL" },
    { "id": "c3", "from": "server", "to": "cache", "label": "read" }
  ]
}
```

- [ ] **Step 2: Write failing test**

`__tests__/delta.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { archifyDelta } from "../lib/delta.ts";

const base = join(import.meta.dir, "fixtures/mini.architecture.json");
const head = join(import.meta.dir, "fixtures/mini.architecture.v2.json");

describe("archify_delta", () => {
  it("produces a before/delta/after HTML for two architecture IRs", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-delta-"));
    const res = await archifyDelta({ basePath: base, headPath: head }, { cwd: outDir });
    expect(res.isError).toBeFalsy();
    const out = res.details!.path as string;
    const html = await Bun.file(out).text();
    expect(html.length).toBeGreaterThan(10_000);
    expect(out).toMatch(/\.html$/);
  });
  it("rejects non-architecture types (archify compare is architecture-only)", async () => {
    const res = await archifyDelta({ basePath: base, headPath: head, type: "workflow" }, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/delta.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/delta.ts`**

```typescript
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { runArchify } from "./run.ts";
import { resolveOutputPath } from "./output-path.ts";

export interface DeltaCtx { cwd: string }

/** archify `compare` is architecture-only (bin/archify.mjs rejects type !== 'architecture'). */
export async function archifyDelta(params: { basePath: string; headPath: string; outputPath?: string; type?: string }, ctx: DeltaCtx) {
  const type = params.type ?? "architecture";
  if (type !== "architecture") {
    return { content: [{ type: "text" as const, text: "Error: archify_delta is architecture-only (archify compare requires type 'architecture')." }], details: { error: "non-architecture delta unsupported", type }, isError: true };
  }
  const base = isAbsolute(params.basePath) ? params.basePath : join(ctx.cwd, params.basePath);
  const head = isAbsolute(params.headPath) ? params.headPath : join(ctx.cwd, params.headPath);
  const outPath = resolveOutputPath({ cwd: ctx.cwd, outputPath: params.outputPath, diagramType: "architecture-delta" });
  const { status } = runArchify(["compare", "architecture", base, head, outPath], ctx.cwd);
  if (status !== 0) {
    return { content: [{ type: "text" as const, text: `Error: archify compare failed (exit ${status}). Ensure both IRs are valid architecture diagrams.` }], details: { error: "compare failed", status }, isError: true };
  }
  return { content: [{ type: "text" as const, text: `Rendered architecture delta → ${outPath}` }], details: { path: outPath, type: "architecture-delta" } };
}

export const deltaTool = defineTool({
  name: "archify_delta",
  label: "Archify Delta",
  description:
    "Compare two architecture IR snapshots and render a before/delta/after HTML (merge-review). " +
    "Architecture-only. Pass `basePath` + `headPath` (absolute or cwd-relative). Optional `outputPath`. Returns the absolute output path.",
  parameters: Type.Object({
    basePath: Type.String({ description: "Base (before) architecture IR .json path." }),
    headPath: Type.String({ description: "Head (after) architecture IR .json path." }),
    outputPath: Type.Optional(Type.String({ description: "Output HTML path. Default: <cwd>/architecture-delta.html." })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyDelta(params, { cwd: ctx.cwd });
  },
});
```

- [ ] **Step 5: Register delta tool in `extensions/archify.ts`**

```typescript
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateTool } from "../lib/validate.ts";
import { renderTool } from "../lib/render.ts";
import { deltaTool } from "../lib/delta.ts";

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(validateTool);
  pi.registerTool(renderTool);
  pi.registerTool(deltaTool);
};

export default extension;
```

- [ ] **Step 6: Run delta test + typecheck — verify pass**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/delta.test.ts && bun run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/lib/delta.ts \
        bun-apps/pi-agent-ext-archify/extensions/archify.ts \
        bun-apps/pi-agent-ext-archify/__tests__/delta.test.ts \
        bun-apps/pi-agent-ext-archify/__tests__/fixtures/mini.architecture.v2.json
git commit -m "feat(archify): archify_delta tool (architecture before/delta/after)"
```

---

## Task 6: `check:validators` drift gate under Bun

**Files:**
- Test: `__tests__/validators-drift.test.ts`

- [ ] **Step 1: Write the drift test**

`__tests__/validators-drift.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GEN = join(PKG_ROOT, "vendored/scripts/generate-validators.mjs");

describe("check:validators (vendored snapshot not drifted)", () => {
  it("generate-validators --check reports no drift", () => {
    const r = spawnSync("bun", [GEN, "--check"], { cwd: PKG_ROOT, encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("drift");
  });
});
```

- [ ] **Step 2: Run + verify pass**

```bash
cd bun-apps/pi-agent-ext-archify && bun test __tests__/validators-drift.test.ts
```
Expected: PASS (the vendored `generated-validators.mjs` matches the vendored schemas).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/__tests__/validators-drift.test.ts
git commit -m "test(archify): check:validators drift gate under bun"
```

---

## Task 7: Condensed `archify` skill (~3 KB)

**Files:**
- Create: `bun-apps/pi-agent-ext-archify/skills/archify/SKILL.md`

- [ ] **Step 1: Write the condensed skill**

`skills/archify/SKILL.md`:
```markdown
---
name: archify
description: Author typed-JSON-IR technical diagrams (architecture / workflow / sequence / data-flow / lifecycle) and render them to self-contained, validated HTML. Use archify_validate before archify_render; use archify_delta to review architecture changes. Accept Mermaid input or repository evidence when asked. Loads deep IR-authoring guidance on demand from the vendored SKILL.md + schemas.
---

# Archify (condensed)

Author a typed-JSON-IR diagram, validate it, render it to a self-contained HTML artifact.

## Choose a type

- **architecture** — components + connections topology (services, data stores, boundaries).
- **workflow** — steps / branches / decisions (approval, CI/CD).
- **sequence** — temporal messages between actors (API call sequences, request lifecycles).
- **dataflow** — pipeline transforms (ETL/ELT, data lineage).
- **lifecycle** — states + transitions (state machines).

## IR skeleton (common to all types)

\`\`\`json
{ "schema_version": 1, "diagram_type": "<type>",
  "meta": { "title": "...", "subtitle": "...", "output": "<file>.html" },
  "<type-specific arrays>": [ ... ] }
\`\`\`

Shared vocabulary:
- `componentType` ∈ {frontend, backend, database, cloud, security, messagebus, external}
- `variant` ∈ {default, emphasis, security, dashed}
- `id` = `^[a-zA-Z][a-zA-Z0-9_-]*$`

## Layout essentials

1. **Cardinal rule:** set semantic `type` + `variant` on components/connections — the renderer maps these to theme colors. **Never invent inline colors.**
2. **Placement:** lay components left→right along the primary request path; group related ones with `boundaries`.

## Minimal example (architecture)

See the worked architecture IR (3 components, 2 connections) — copy + edit it. Components need `pos` + `size`; connections reference component `id`s via `from`/`to`.

## The loop

1. **`archify_validate`** the IR against its schema → fix any diagnostics.
2. **`archify_render`** the validated IR → HTML (default honors `meta.output`, else `<cwd>/<type>.html`).
3. For change review: **`archify_delta`** two architecture IR snapshots → before/delta/after HTML (architecture-only).

**Validate before render. Never deliver unvalidated IR.**

## On-demand depth (read these LOCAL vendored paths when needed)

- Layout craft / design system / self-review / delivery gate → `vendored/SKILL.md` (§ Layout principles, § Architecture Mode).
- Per-mode deep vocabulary (workflow/sequence/dataflow/lifecycle) → `vendored/SKILL.md` (§ Renderer Modes + each mode's section).
- Mermaid input → `vendored/SKILL.md` (§ Mermaid as an Input Dialect).
- Map real code (repository evidence) → `vendored/SKILL.md` (§ Optional verified repository evidence).
- Full field vocabulary per type → `vendored/schemas/<type>.schema.json` + `vendored/schemas/common.schema.json`.

> Everything above is LOCAL to this package (`vendored/`). Never reference the upstream archify source.
```

> Target size ~3 KB. Verify: `wc -c skills/archify/SKILL.md` ≈ 3000–3500.

- [ ] **Step 2: Verify size + frontmatter parses**

```bash
cd bun-apps/pi-agent-ext-archify && wc -c skills/archify/SKILL.md   # expect ~3000–3500
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/skills/archify/SKILL.md
git commit -m "feat(archify): condensed ~3KB authoring skill (on-demand vendored depth)"
```

---

## Task 8: Register in `run-dir/manifest.json` + full-suite + load probe

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/manifest.json`

**Interfaces:**
- Produces: extension discoverable as `pi-agent-ext-archify` with 3 tools + 1 skill.

- [ ] **Step 1: Add the `extensions[]` object + `skills[]` entry**

In `bun-apps/pi-agent/run-dir/manifest.json`, append to the `extensions` array (after the `pi-agent-ext-deploy` object):

```json
    {
      "name": "pi-agent-ext-archify",
      "entry": "pi-agent-ext-archify/extensions/archify.ts",
      "bundleMode": "thin",
      "testGate": "cd bun-apps/pi-agent-ext-archify && bun test",
      "version": "0.1.0"
    }
```

And append `"pi-agent-ext-archify/skills"` to the `skills` array (do NOT add to `binarySkills[]`).

- [ ] **Step 2: Run the full package test suite**

```bash
cd bun-apps/pi-agent-ext-archify && bun test
```
Expected: all tests PASS (output-path, run, validate, render, delta, validators-drift).

- [ ] **Step 3: Load probe — extension registers 3 tools + skill**

```bash
cd bun-apps/pi-agent && bun run scripts/probe-extensions.ts 2>/dev/null || \
  echo "(if no probe script, run: bun --eval '...') — alternatively rely on the CI extension-contract check"
```
> Verify (by whatever the repo's load-probe mechanism is) that `archify_render`, `archify_validate`, `archify_delta` register with no tool-name conflicts, and the `archify` skill is discoverable. The CI `extension-contract` job enforces this on PR.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent/run-dir/manifest.json
git commit -m "feat(archify): register pi-agent-ext-archify (3 tools + skill, dynamic/opt-in)"
```

---

## Task 9: CI wiring (matrix + CI.md + branch protection)

**Files:**
- Modify: `.github/workflows/ci.yml` (matrix `include`)
- Modify: `.github/CI.md` (required `contexts[]` + counts)

> The actual file edits land here (the package now exists). Branch-protection is a server-side `gh api` call (documented in CI.md; run after the first green PR).

- [ ] **Step 1: Add the matrix row in `.github/workflows/ci.yml`**

In the `tests.matrix.include` list (with the uniform `bun test` entries), add:
```yaml
          - { package: pi-agent-ext-archify, test-cmd: "bun test" }
```

> Routing is automatic — `scripts/ci-changed-packages.sh` globs `bun-apps/*/package.json`; no edit to that script.

- [ ] **Step 2: Update `.github/CI.md`**

In the `required_status_checks.contexts` JSON block, add `"test · pi-agent-ext-archify"`. Bump the doc's "24 required" → "25 required" and "matrix of 22" → "matrix of 23" (search-and-replace the counts; verify against the actual matrix length).

- [ ] **Step 3: Verify CI YAML validity + matrix count locally**

```bash
cd /Users/huangziyu/proj/video_generation__archify
bunx actionlint .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"
grep -c "package:" .github/workflows/ci.yml   # confirm the new entry is present
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/CI.md
git commit -m "ci(archify): add pi-agent-ext-archify to test matrix + required checks"
```

- [ ] **Step 5: Branch protection (run AFTER the first PR is green — server-side)**

```bash
# GET current rule, add "test · pi-agent-ext-archify" to contexts[], PUT the FULL body back.
gh api repos/ziyu4huang/video_generation/branches/main/protection > /tmp/bp.json
# (edit /tmp/bp.json: required_status_checks.contexts += "test · pi-agent-ext-archify")
gh api -X PUT repos/ziyu4huang/video_generation/branches/main/protection --input /tmp/bp.json
```
> The granular `.../required_status_checks` sub-endpoint 404s on this repo; PUT the complete protection object. Preserve `enforce_admins`, `required_pull_request_reviews`, etc.

---

## Self-Review (run after writing — already applied)

1. **Spec coverage:** every map decision maps to a task — vendor snapshot + self-contained (T1), output resolution (T2/05), validate (T3), render + golden (T4), delta architecture-only (T5), check:validators (T4-decision-04), condensed skill (T6/06), dynamic registration (T8/03), CI required-from-day-1 (T9/07). ✓
2. **Placeholder scan:** no TBD/TODO; every code step shows the code; fixtures are concrete. ✓
3. **Type consistency:** `runArchify(args, cwd)` signature consistent across run/validate/render/delta; `resolveOutputPath` opts consistent; `ArchifyResult`/`ValidateCtx`/`RenderCtx`/`DeltaCtx` named consistently. ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-pi-agent-ext-archify.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
