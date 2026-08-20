# Deploy Phase 2a — Single Extension Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `deploy-config.yaml` + hand-maintained `run-dir/manifest.json` with ONE registry (`pi-agent.registry.yaml`) that generates the manifest, guarded by a freshness gate.

**Architecture:** `deploy-config.yaml` is renamed to `pi-agent.registry.yaml` and absorbs every manifest array under a deploy-block-presence schema. A pure parser (`run-dir/registry.ts`) is the ONE schema authority — the devops deploy config derives from it. `scripts/regen-manifest.ts` emits `run-dir/manifest.json` (derived, `$generated`-marked); the 12 existing manifest consumers are untouched. `ext new` registers by appending a YAML entry, then runs `regen:manifest` (+ `regen:static` for static). The #1739 chain (`manifest → regen:static → static-extensions.ts`) is preserved verbatim.

**Tech Stack:** Bun (`Bun.YAML.parse`, `bun test`), TypeScript, biome (2-space indent, tabs in JSON output preserved by the emitter).

**Spec:** `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md` § "The registry" (revised 2026-08-20), § "Phasing" Phase 2a.

## Global Constraints

- The deployed core reads `manifest.json` at runtime through the embedded-assets pipeline — it stays JSON, generated, never hand-edited.
- Generated `manifest.json` must be **semantically identical** to today's hand-maintained one, with exactly three deletions: `bundleMode`, `testGate`, `npmExtensions` (verified dead). The 3 bare-string entries (`flux2`, `krea2`, `ltx`) normalise to declared objects — `parseManifestEntry` treats both forms identically.
- Every registry schema violation THROWS (strict parser: unknown key = error, missing `excludeReason` = error) — a config typo must never be a silent no-op.
- `lazyExtensions` survives verbatim (bare-alias `-e` back-compat; different job from registration).
- English for all written output (comments, commits, docs). Biome style: 2-space indent in TS.
- Per-package gates: pi-agent `bun test` + `bun run typecheck`; pi-agent-ext-devops `bun run check` (tsc) + `bun test`. Full `local_ci` before the PR.
- Exclusion reasons come from `docs/deploy.md` § Limits verbatim — do not invent new ones.

---

### Task 1: `run-dir/registry.ts` — the one parser

**Files:**
- Create: `bun-apps/pi-agent/run-dir/registry.ts`
- Test: `bun-apps/pi-agent/run-dir/registry.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; `Bun.YAML.parse`).
- Produces (Task 3, 4, 5 build on these — exact names):

```ts
export interface RegistryDeployBlock {
  order: number;
  copy: string[];        // default []
  vendor: string[];      // default []
  externals: string[];   // default []
  enabled: boolean;      // default true
}
export interface RegistryExt {
  name: string;            // "task"
  package: string;         // "pi-agent-ext-task"
  entry: string;           // package-relative: "extensions/task.ts"
  load: "static" | "dynamic";
  skills: boolean;         // ships <package>/skills → manifest skills[]
  binarySkills: boolean;   // default false → manifest binarySkills[]
  version?: string;        // emitted on dynamic entries when present
  excludeReason?: string;  // REQUIRED when deploy block is absent
  deploy?: RegistryDeployBlock;
}
export interface Registry {
  deploy: { outRoot: string; version: { from: "package.json"; gitSha: boolean }; freeze: boolean; current: boolean };
  hostApi: number;
  hostModules: string[];
  extensions: RegistryExt[];
  lazyExtensions: Record<string, string>;
}
/** Strict parse + validate. Throws Error with the offending key/entry in the message. */
export function parseRegistry(text: string, opts: { bunAppsDir: string }): Registry;
```

- [ ] **Step 1: Write the failing tests** — one describe per rule:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegistry } from "./registry.ts";

/** Build a minimal valid registry with one static-deployed ext + one dynamic-local ext on disk. */
function fixture(): { text: string; bunAppsDir: string } {
  const bunAppsDir = mkdtempSync(join(tmpdir(), "registry-test-"));
  const mk = (pkg: string, entry: string) => {
    mkdirSync(join(bunAppsDir, pkg, "extensions"), { recursive: true });
    writeFileSync(join(bunAppsDir, pkg, "extensions", entry), "export default () => {};");
  };
  mk("pi-agent-ext-task", "task.ts");
  mk("pi-agent-ext-movie-director", "movie-director.ts");
  const text = `
deploy:
  outRoot: ~/proj/dist/pi-agent-sh
  version: { from: package.json, gitSha: true }
  freeze: true
  current: true
hostApi: 2
hostModules: ["@earendil-works/pi-coding-agent"]
extensions:
  - name: task
    package: pi-agent-ext-task
    entry: extensions/task.ts
    load: static
    deploy:
      order: 10
  - name: movie-director
    package: pi-agent-ext-movie-director
    entry: extensions/movie-director.ts
    load: dynamic
    version: "0.1.0"
    excludeReason: bound to this machine's swift CLIs and services
lazyExtensions: {}
`;
  return { text, bunAppsDir };
}

describe("parseRegistry", () => {
  test("parses the fixture", () => {
    const { text, bunAppsDir } = fixture();
    const r = parseRegistry(text, { bunAppsDir });
    expect(r.extensions).toHaveLength(2);
    expect(r.extensions[0]).toMatchObject({ name: "task", load: "static", skills: false, binarySkills: false });
    expect(r.extensions[0]?.deploy).toEqual({ order: 10, copy: [], vendor: [], externals: [], enabled: true });
    expect(r.extensions[1]).toMatchObject({ load: "dynamic", excludeReason: expect.stringContaining("swift") });
    expect(r.hostApi).toBe(2);
  });
  test("unknown TOP key → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("hostApi:", "hostapiX:"), { bunAppsDir })).toThrow(/hostapiX/);
  });
  test("unknown extension key → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("load: static", "loads: static"), { bunAppsDir })).toThrow(/loads/);
  });
  test("no deploy block and no excludeReason → throws", () => {
    const { text, bunAppsDir } = fixture();
    const bad = text.replace(/\n\s*excludeReason: bound[^\n]*/, "");
    expect(() => parseRegistry(bad, { bunAppsDir })).toThrow(/excludeReason/);
  });
  test("duplicate deploy order → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("order: 10", "order: 99"), { bunAppsDir })).not.toThrow();
    const { text: t2, bunAppsDir: d2 } = fixture();
    // add a second ext with the same order via string surgery on the dynamic entry
    const dup = t2.replace("load: dynamic", "load: dynamic\n    deploy:\n      order: 10");
    expect(() => parseRegistry(dup, { d2 } as never)).toThrow(/order/);
  });
  test("entry not on disk → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("extensions/task.ts", "extensions/nope.ts"), { bunAppsDir })).toThrow(/nope/);
  });
  test("load outside {static,dynamic} → throws", () => {
    const { text, bunAppsDir } = fixture();
    expect(() => parseRegistry(text.replace("load: static", "load: eager"), { bunAppsDir })).toThrow(/load/);
  });
});
```

(Fix the `dup` case's `{ d2 } as never` — it must be `{ bunAppsDir: d2 }`; the plan's point is the assertion, keep the call correct.)

- [ ] **Step 2: Run to verify failure** — `( cd bun-apps/pi-agent && bun test run-dir/registry.test.ts )` → FAIL (`Cannot find module './registry.ts'`).
- [ ] **Step 3: Implement `registry.ts`** (~140 lines):

```ts
/**
 * registry.ts — the ONE parser for pi-agent.registry.yaml.
 *
 * The registry replaces both deploy-config.yaml and hand-maintained
 * manifest.json (which becomes a DERIVED artifact — see regen-manifest.ts).
 * Schema authority lives HERE and nowhere else: the devops deploy config
 * derives ShConfig from parseRegistry(), the manifest emitter derives the
 * arrays, and a structural guard forbids a third parser of this shape.
 *
 * Strict on purpose: an unknown key is an error, not a silent no-op — the
 * failure mode this rejects is a registry typo that quietly ships (or drops)
 * an extension.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// interfaces exactly as in the plan's Interfaces block.

const DEPLOY_KEYS = new Set(["outRoot", "version", "freeze", "current"]);
const EXT_KEYS = new Set(["name", "package", "entry", "load", "skills", "binarySkills", "version", "excludeReason", "deploy"]);
const DEPLOY_BLOCK_KEYS = new Set(["order", "copy", "vendor", "externals", "enabled"]);

export function parseRegistry(text: string, opts: { bunAppsDir: string }): Registry {
  const raw = Bun.YAML.parse(text) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("pi-agent.registry.yaml must be a YAML mapping");
  }
  for (const k of Object.keys(raw)) {
    if (k !== "deploy" && k !== "hostApi" && k !== "hostModules" && k !== "extensions" && k !== "lazyExtensions") {
      throw new Error(`unknown registry key "${k}" (known: deploy, hostApi, hostModules, extensions, lazyExtensions)`);
    }
  }
  // … validate deploy block (outRoot string + ~ expansion + absolute; version.from
  // only "package.json"; freeze/current booleans), hostApi integer, hostModules
  // non-empty string array, lazyExtensions Record<string,string> — mirror the
  // strictness of the old parseShConfig (scripts/lib/config.ts) for these keys,
  // then the extensions list:
  //   - name/package/entry required strings; name unique
  //   - load ∈ {static, dynamic}
  //   - skills/binarySkills booleans (default false)
  //   - deploy block: keys ⊆ DEPLOY_BLOCK_KEYS, order REQUIRED unique integer,
  //     copy/vendor/externals string arrays (default []), enabled boolean (default true)
  //   - NO deploy block ⇒ excludeReason REQUIRED non-empty string
  //   - resolve(bunAppsDir, package) must exist; resolve(pkgDir, entry) must exist
  //   - a deploy block does NOT require an excludeReason; if BOTH are present that is legal
  //     (excluded-from-deploy rationale kept for history) — no, simpler: if a deploy
  //     block is present, excludeReason must be ABSENT (they contradict). Throw.
  return { deploy, hostApi, hostModules, extensions, lazyExtensions };
}
```

Fill every `…` with real validation code following the comment spec — no stubs may remain. `expandHome` for `outRoot` (copy the helper from the old `config.ts`).

- [ ] **Step 4: Run tests** — same command → PASS. Also `( cd bun-apps/pi-agent && bun run typecheck )`.
- [ ] **Step 5: Commit** — `feat(registry): parse pi-agent.registry.yaml — the one schema authority`

### Task 2: the manifest emitter

**Files:**
- Create: `bun-apps/pi-agent/run-dir/registry-to-manifest.ts`
- Test: `bun-apps/pi-agent/run-dir/registry-to-manifest.test.ts`

**Interfaces:**
- Consumes: `Registry`, `RegistryExt` from `./registry.ts`.
- Produces:

```ts
export interface ManifestJson {
  $generated: string; // "from pi-agent.registry.yaml by regen:manifest — do not edit"
  extensions: Array<{ name: string; entry: string; version?: string }>; // load:dynamic, bun-apps-relative entries
  skills: string[];            // "<package>/skills" for skills:true
  binarySkills: string[];      // "<package>/skills" for binarySkills:true
  staticExtensions: string[];  // package names for load:static
  lazyExtensions: Record<string, string>;
}
export function buildManifestObject(r: Registry): ManifestJson;
/** Byte-stable serialisation: JSON.stringify(obj, null, "\t") + trailing newline. */
export function manifestText(obj: ManifestJson): string;
```

- [ ] **Step 1: Failing tests** — build a `Registry` literal in-file (no YAML): 3 static (one with skills+binarySkills, one deploy-less with excludeReason) + 2 dynamic; assert `buildManifestObject` emits the exact arrays (staticExtensions order = registry order; skills includes deploy AND non-deploy skill carriers; dynamic entries carry `entry: "<package>/extensions/<x>.ts"` and `version` only when set; `$generated` string present). Assert `manifestText` output ends with `"\n"` and parses back deep-equal. Also assert `binarySkills ⊆ skills`.
- [ ] **Step 2: Run → FAIL** (`Cannot find module`).
- [ ] **Step 3: Implement** — pure functions, no `node:fs`. `buildManifestObject` derives every array from the registry; `manifestText` is exactly `JSON.stringify(obj, null, "\t") + "\n"` (the format `ext new` already writes, so future regens never churn whitespace).
- [ ] **Step 4: Run → PASS** + typecheck.
- [ ] **Step 5: Commit** — `feat(registry): derive manifest.json from the registry`

### Task 3: the real registry file + `regen:manifest` + freshness gate

**Files:**
- Create: `bun-apps/pi-agent/pi-agent.registry.yaml` (content below — the conversion of BOTH current files)
- Create: `bun-apps/pi-agent/scripts/regen-manifest.ts`
- Delete: nothing yet (`deploy-config.yaml` dies in Task 4)
- Modify: `bun-apps/pi-agent/package.json` (add `"regen:manifest": "bun scripts/regen-manifest.ts"`)
- Test: `bun-apps/pi-agent/run-dir/registry-freshness.test.ts`

**Interfaces:**
- Consumes: `parseRegistry`, `buildManifestObject`, `manifestText`.
- Produces: the committed derived `run-dir/manifest.json`; the freshness gate every later task keeps green.

- [ ] **Step 1: Write `pi-agent.registry.yaml`** — carry EVERY comment from `deploy-config.yaml` over; fold the 10 non-deploy extensions in with `excludeReason` from `docs/deploy.md` § Limits. Full skeleton (abbreviated entries marked `…fields as in deploy-config.yaml today…` mean: copy those fields/comments verbatim):

```yaml
# pi-agent.registry.yaml — THE extension registry. One entry per extension;
# adding an extension is ONE edit here + `bun run regen:manifest`
# (+ `regen:static` when load: static). run-dir/manifest.json is DERIVED from
# this file — never edit it directly; the freshness test will go red.
#
# Schema (run-dir/registry.ts is the authority):
#   load: static  → source mode statically imports it (via regen:static codegen)
#   load: dynamic → source mode loads it via -e
#   deploy: block PRESENT → ships in the portable tree (order/copy/vendor/externals)
#   deploy: block ABSENT  → excludeReason is REQUIRED (why it stays local)
deploy:
  outRoot: ~/proj/dist/pi-agent-sh
  version: { from: package.json, gitSha: true }
  freeze: true
  current: true
hostApi: 2
hostModules:
  # …all 7 entries + their comments, verbatim from deploy-config.yaml…
extensions:
  # …the 14 base-set entries from deploy-config.yaml, each gaining `load: static`
  # and their fields moving INTO the deploy: block (order/copy/vendor/externals),
  # plus `skills: true` where the entry had `skills: [skills]`…
  - name: file2md
    package: pi-agent-ext-file2md
    entry: extensions/file2md.ts
    load: static
    excludeReason: mupdf native/wasm + a hard LM Studio localhost dependency — not portable
  - name: movie-director
    package: pi-agent-ext-movie-director
    entry: extensions/movie-director.ts
    load: dynamic
    version: "0.1.0"
    excludeReason: bound to this machine's swift CLIs and services
  # …flux2, krea2, ltx, research-tool, zai-mcp, archify: same shape as
  # movie-director (excludeReason: bound to this machine's swift CLIs and
  # services); devops + tool-gate: excludeReason: repo-internal tooling.
  # devops/… entries keep `version: "0.1.0"` — the current manifest carries it.
lazyExtensions: {}
```

Ordering rule for the file: the 15 `load: static` entries first (registry order = staticExtensions order: task, prompt-history, superpowers, wayfind, hermes-memory, subagent, workflow, btw, web-access, power-tool, webui, hyperframes, obsidian, knowledge-card, file2md), then the 9 `load: dynamic` (tool-gate, devops, flux2, krea2, ltx, research-tool, zai-mcp, movie-director, archify — current manifest order).

- [ ] **Step 2: Write `scripts/regen-manifest.ts`** (mirror `regen-static-extensions.ts`):

```ts
/**
 * regen-manifest.ts — rewrites run-dir/manifest.json from pi-agent.registry.yaml.
 * Run as `bun run regen:manifest` from bun-apps/pi-agent. The manifest is a
 * DERIVED artifact; this script plus the freshness test are the only writers
 * that should ever touch it. Refuses to write an empty manifest (same guard
 * shape as regen-static-extensions.ts).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseRegistry } from "../run-dir/registry.ts";
import { buildManifestObject, manifestText } from "../run-dir/registry-to-manifest.ts";

const pkgDir = join(import.meta.dir, "..");
const registryPath = join(pkgDir, "pi-agent.registry.yaml");
const manifestPath = join(pkgDir, "run-dir", "manifest.json");

const registry = parseRegistry(readFileSync(registryPath, "utf8"), { bunAppsDir: join(pkgDir, "..") });
if (registry.extensions.length === 0) {
  console.error("[regen:manifest] refusing to write: registry has no extensions");
  process.exit(1);
}
writeFileSync(manifestPath, manifestText(buildManifestObject(registry)));
console.log(`[regen:manifest] wrote ${manifestPath} (${registry.extensions.length} extensions)`);
```

- [ ] **Step 3: Add `regen:manifest` to package.json scripts; run it**; commit the regenerated `manifest.json` together with the registry + script. Sanity-diff the new manifest vs git HEAD: the ONLY diffs must be (a) `$generated` key added, (b) `bundleMode`/`testGate` gone, (c) `npmExtensions: []` gone, (d) the 3 bare strings now objects, (e) `lazyExtensions: {}` unchanged.

```bash
git diff HEAD -- bun-apps/pi-agent/run-dir/manifest.json   # eyeball the five expected diff classes
```

- [ ] **Step 4: Failing freshness test, then make it pass** — `run-dir/registry-freshness.test.ts`:

```ts
/**
 * The freshness gate: manifest.json is derived from pi-agent.registry.yaml.
 * RED when someone hand-edits the manifest OR edits the registry without
 * running `bun run regen:manifest`. This is the tripwire that makes the
 * generated file safe to keep.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistry } from "./registry.ts";
import { buildManifestObject, manifestText } from "./registry-to-manifest.ts";

const PKG_DIR = join(import.meta.dir, "..", "..");

describe("manifest.json freshness", () => {
  test("is byte-identical to what the registry generates", () => {
    const registry = parseRegistry(readFileSync(join(PKG_DIR, "pi-agent.registry.yaml"), "utf8"), {
      bunAppsDir: join(PKG_DIR, ".."),
    });
    const committed = readFileSync(join(PKG_DIR, "run-dir", "manifest.json"), "utf8");
    expect(manifestText(buildManifestObject(registry))).toBe(committed);
  });
});
```

Run: `bun test run-dir/registry-freshness.test.ts` → PASS. **Canary both directions**: (1) append a space inside manifest.json → RED, revert; (2) add a dummy registry entry → RED, revert. Record the canary results in the commit message.

- [ ] **Step 5: Full pi-agent gates** — `bun test` (the pre-existing `manifest-consistency.test.ts` must still pass: `parseManifestEntries` accepts the object form; `staticExtensions`/`skills` arrays are unchanged content-wise) + `bun run typecheck` + `( cd bun-apps/pi-agent-ext-devops && bun run check && bun test )` (its deploy fixtures still read `deploy-config.yaml` — untouched until Task 4).
- [ ] **Step 6: Commit** — `feat(registry): pi-agent.registry.yaml + regen:manifest + freshness gate (canary-verified both directions)`

### Task 4: the deploy pipeline reads the registry; deploy-config.yaml dies

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/scripts/lib/config.ts` (derive `ShConfig` from `parseRegistry`)
- Modify: `bun-apps/pi-agent-ext-devops/tests/config.test.ts` (fixtures → registry shape)
- Delete: `bun-apps/pi-agent/deploy-config.yaml`
- Repoint `deploy-config.yaml` string references (26 files; code ones first): `scripts/deploy.ts`, `src/deploy-cli.ts`, `src/doctor.ts` (pi-agent), `extensions/devops.ts`, `tests/deploy-e2e.test.ts`, `tests/deploy-probe-e2e.test.ts`, `bun-apps/tests/dep-guard.test.ts`, `bun-apps/tests/extension-isolation-contract.test.ts`; prose ones (README/docs/SKILL.md/package.json `//deploy` comment/ext-file comments) via `grep -rl deploy-config.yaml`.
- Test: existing `config.test.ts` (updated), plus the deploy e2e suites stay green.

**Interfaces:**
- Consumes: `parseRegistry` from `../../../pi-agent/run-dir/registry.ts` (cross-package relative import — the established pattern, cf. `ext-build.ts` importing `pi-agent/src/sh/ext-loader.ts`).
- Produces: `ShConfig`/`ShExtConfig` UNCHANGED (deploy.ts untouched); the registry is now the only config file.

- [ ] **Step 1: Update `config.test.ts` fixtures first (TDD)** — rewrite each fixture YAML to registry shape (deploy knobs under `deploy:`, ext fields under `deploy:` block); assert `parseShConfig` output is unchanged from the old expectations. Run → FAIL (old parser rejects the new shape).
- [ ] **Step 2: Rewrite `parseShConfig`** to: locate `pi-agent.registry.yaml` (path constant), `parseRegistry(...)` once, then project:
  - `ShConfig.deploy knobs` ← `registry.deploy` + `hostApi`/`hostModules`.
  - `ShConfig.extensions` ← registry extensions WITH a deploy block AND `deploy.enabled !== false`, mapped: `{ name, package, entry, order: d.order, skills: ext.skills ? ["skills"] : [], copy: d.copy, vendor: d.vendor, externals: d.externals, enabled: d.enabled }`, sorted by `order`.
  - The old `expandHome`/key-validation code is DELETED (registry.ts owns it). The file shrinks to the projection + its doc comment.
- [ ] **Step 3: Run devops gates** — `bun run check && bun test` → PASS.
- [ ] **Step 4: Delete `deploy-config.yaml`; repoint all references** — `grep -rl "deploy-config.yaml"` must return only `.planning/` + this plan afterwards. `dep-guard.test.ts` / `extension-isolation-contract.test.ts` derive the base set from the registry file — they keep deriving, from the new path (their read is line-based on the YAML: update the extraction to the new `deploy:`-block shape, preserving each test's existing verdicts).
- [ ] **Step 5: Behavioural proof** — `( cd bun-apps/pi-agent && bun run deploy:sh --out /tmp/registry-2a-check --no-current --force )` succeeds and `--ext-list` (via the deployed binary's doctor or the probe e2e) reports the same 14 extensions as before. Run `bash scripts/check-deploy-e2e.sh` → GREEN.
- [ ] **Step 6: Commit** — `refactor(deploy): deploy pipeline reads pi-agent.registry.yaml; deploy-config.yaml retired`

### Task 5: `ext new` registers into the registry

**Files:**
- Modify: `bun-apps/pi-agent/src/ext-new.ts` (registration block, lines ~296–360)
- Create: `bun-apps/pi-agent/run-dir/registry-insert.ts`
- Test: `bun-apps/pi-agent/run-dir/registry-insert.test.ts`; update `bun-apps/pi-agent/src/__tests__/ext-new*.test.ts` if it asserts manifest writing (check first; adjust to assert registry + regen invocation).

**Interfaces:**
- Consumes: registry file path; `Bun.spawn` regen pattern already in ext-new.
- Produces:

```ts
/** Textually append one extension entry to the registry's extensions list.
 *  Text surgery, NOT YAML re-serialisation — re-serialising would destroy the
 *  comments that carry the exclusion rationale. Returns the new file text. */
export function appendRegistryExtension(text: string, entryYaml: string): string;
```

- [ ] **Step 1: Failing tests for `appendRegistryExtension`**: appends after the LAST `  - name:` entry of the extensions list, keeping `lazyExtensions:` (which follows) intact; 4-space-free 2-space indentation; idempotence NOT required (duplicate-name detection happens before, in ext-new). Fixture = minimal registry text with comments; assert comments above the insertion point survive byte-for-byte.
- [ ] **Step 2: Implement** — find last line matching `/^  - name: /m`, insert `entryYaml` (already 2-space-indented) after its entry's last non-empty line. Run → PASS.
- [ ] **Step 3: Rewire `ext-new.ts`** — replace the manifest read/write block:
  - duplicate check reads the REGISTRY (`parseRegistry`; `package` match)
  - `--register dynamic` appends the entry (name/package/entry/load: dynamic/version/excludeReason placeholder — use `excludeReason: not yet curated for the portable set`) and runs `regen:manifest`
  - `--register static` appends (`load: static`, same excludeReason placeholder) and runs `regen:manifest` THEN `regen:static`
  - error messages say the registry path, not manifest.json
- [ ] **Step 4: Test the scaffold flow end-to-end in a scratch branch**: `bun bun-apps/pi-agent/src/cli.ts ext new probe-2a --no-install` (or however the suite drives it — follow the existing ext-new test) → registry gains the entry, `manifest.json` regenerated, freshness green, (static case) `static-extensions.ts` regenerated. Clean up the probe.
- [ ] **Step 5: Commit** — `feat(ext-new): register into pi-agent.registry.yaml (one edit + regen)`

### Task 6: structural guard, docs, full verification

**Files:**
- Create: `bun-apps/pi-agent/run-dir/single-registry-guard.test.ts`
- Modify: `bun-apps/pi-agent/README.md`, `bun-apps/pi-agent/docs/deploy.md`, `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md`, root `CLAUDE.md` (if it names manifest.json as the registration edit point), `bun-apps/pi-agent/package.json` `//deploy` comment.

**Interfaces:** none (guard + docs).

- [ ] **Step 1: Failing guard test** — `single-registry-guard.test.ts`: walk `bun-apps/**/*.{ts,sh}` (exclusions: node_modules, this test, `registry.ts` itself, `config.ts`, the two derive-tests already allowlisted) and fail if any file OTHER than the allowlist both (a) mentions `pi-agent.registry.yaml` (or parses YAML with extension-list intent) and (b) declares its own extension-schema interface/array. Practical form: forbid `Bun.YAML.parse` on the registry path outside `registry.ts`, asserted by grep:

```ts
const ALLOWED = new Set(["run-dir/registry.ts", "run-dir/registry-to-manifest.ts"]);
// scan repo .ts files for /pi-agent\.registry\.yaml/ mentions; every hit's path
// must be in ALLOWED, a test file, or a doc (ext-new.ts writes, never parses —
// it calls appendRegistryExtension; allow src/ext-new.ts in a WRITERS set).
```

Falsify: add a temporary `Bun.YAML.parse(readFileSync("pi-agent.registry.yaml"))` to any src file → RED; remove.

- [ ] **Step 2: Docs** — deploy.md: registry section (schema, one-entry workflow, excludeReason contract); README + SKILL.md + CLAUDE.md: registration is now ONE registry edit + `regen:manifest` (+ `regen:static`), replacing "manifest.json is the only registration edit point". `//deploy` comment names `pi-agent.registry.yaml`.
- [ ] **Step 3: Full verification**
  - `( cd bun-apps/pi-agent && bun test && bun run typecheck )`
  - `( cd bun-apps/pi-agent-ext-devops && bun run check && bun test )`
  - `bash scripts/check-deploy-e2e.sh`
  - `CI=true bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts` → overall: pass
  - Source-mode boot smoke: `( cd ~/proj/tmp && bun <repo>/bun-apps/pi-agent/src/cli.ts -p hi )` — loads the same extension set as pre-2a (static 15 + dynamic via run-dir).
- [ ] **Step 4: Commit + PR** — `feat(deploy) 2a: one extension registry — pi-agent.registry.yaml generates manifest.json`; PR body cites the spec revision, the canary verifications, and the five expected manifest diff classes.

## Self-review notes

- Spec coverage: registry file ✅(T3) · generator+schema ✅(T1/T2) · freshness gate+@generated+structural guard ✅(T3/T6) · ext new ✅(T5) · dead fields ✅(T3 step 3 diff classes) · lazyExtensions verbatim ✅(T2) · deploy pipeline reads registry ✅(T4) · #1739 chain untouched ✅(T3 regen:static unchanged).
- 2b leftovers deliberately NOT here: removing `bundleMode`/`testGate` from `manifest-types.ts` + `ext-doctor` display (the fields are simply absent from the generated manifest; the TYPE stays permissive until 2b), `deploy:sh`→`deploy` script rename, docs fold.
- Risk: `dep-guard`/`extension-isolation-contract` line-based YAML extraction (T4 step 4) — if their extraction is shape-coupled in a non-obvious way, keep them reading the DERIVED manifest instead (their subject is set membership, not the file) and note it in the PR.
