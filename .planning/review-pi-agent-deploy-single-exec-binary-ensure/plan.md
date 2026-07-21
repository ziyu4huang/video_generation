# Portable workflow-pack discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a portable single-exec `pi-agent-cli` binary resolve and run any user-supplied workflow-pack by NAME from a repo-less machine, by adding two name-resolution tiers (`<cwd>/workflows`, `<binDir>/workflows`) that rank above the existing repo walk-up.

**Architecture:** The workflow-pack resolver (`resolveWorkflowScript` + `listWorkflows`) in `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts` is the single source of truth shared by the headless `workflow run` CLI path and the interactive `workflow` tool. We insert two new resolution tiers — a bare `workflows/` dir in the current working directory, and a `workflows/` dir next to the binary (`dirname(process.execPath)`, verified reliable in `bun --compile`) — between the literal-path branch and the repo walk-up, so "most local wins". The engine itself (`node:vm` execution, self-contained packs) is already portable (proven by the 2026-07-19 build probe); only name-discovery is missing.

**Tech Stack:** TypeScript, Bun, `bun:test`, `node:fs`/`node:path`, `node:vm` (engine, unchanged).

## Global Constraints

- Always **Bun** (never node/npm/yarn). Run tests via `( cd bun-apps/<pkg> && bun test )`.
- **Rebuild before verifying the binary**: edit source, then `bun run --cwd bun-apps/pi-agent-cli build:exe` — a deployed `dist/pi-agent-cli/cli.js` / exe is stale until rebuilt. The exe inlines `@repo/pi-agent-ext-workflow`, so a resolver change requires a rebuild to take effect in the binary.
- `bun install` at the **repo root** (`bun-apps/`) before build/test if node_modules is stale.
- Workflows are **self-contained** (no `import`/`require` — the engine forbids them). A pack is exactly `manifest.json` + one entry `.js`. Do not design for multi-file packs.
- `process.execPath` is the ONLY reliable exe-location primitive in `bun --compile` (`Bun.executable` is `undefined`; `import.meta.url` is a virtual `/$bunfs/root/...` path).

## File Structure

- **Modify** `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts` — widen `ResolvedWorkflow["source"]`; add `binDir` opt to `resolveWorkflowScript` + `listWorkflows`; insert the two new tiers; update the not-found error.
- **Modify** `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts` — unit tests for the cwd + bin tiers and their precedence.
- **Create** `bun-apps/pi-agent-cli/tests/workflow-portable-e2e.test.ts` — compiled-binary foreign-cwd verification (ticket 05).
- **Create** `bun-apps/pi-agent-cli/docs/adr/0008-portable-workflow-pack-discovery.md` — record the precedence decision.
- **Modify** `bun-apps/pi-agent-cli/CONTEXT.md` — glossary entry for the resolution-precedence model.

---

### Task 1: Resolver — add `<cwd>/workflows` + `<binDir>/workflows` name-resolution tiers

The core of the change. Adds two tiers that work without a repo root, ranking above the existing repo walk-up ("most local wins"). TDD: failing unit tests first, then the resolver change.

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts:50` (source type), `:105-175` (`resolveWorkflowScript`), `:167-176` (not-found throw).
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts` (add cases under the existing `describe("resolveWorkflowScript", …)`).

**Interfaces:**
- Consumes: `process.execPath` (for the default `binDir`), `dirname` from `node:path` (already imported).
- Produces: `resolveWorkflowScript` gains an opt `{ binDir?: string }` (default `dirname(process.execPath)`); `ResolvedWorkflow["source"]` gains `"cwd-workflows" | "bin-workflows"`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("resolveWorkflowScript", …)` block in `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts` (the file already imports `mkdtempSync, mkdirSync, writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `resolveWorkflowScript` from `../src/workflow-pack.js`):

```ts
test("resolves a pack from <cwd>/workflows with source cwd-workflows (portable tier)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-wf-cwd-"));
  const echoDir = join(root, "workflows", "echo");
  mkdirSync(echoDir, { recursive: true });
  writeFileSync(join(echoDir, "manifest.json"), JSON.stringify({ name: "echo", description: "cwd", entry: "index.js" }));
  writeFileSync(join(echoDir, "index.js"), `export const meta = { name: "echo", description: "cwd" };\nreturn { tier: "cwd" };\n`);
  const r = resolveWorkflowScript("echo", { cwd: root });
  expect(r.source).toBe("cwd-workflows");
  expect(r.script).toContain("tier: \"cwd\"");
});

test("resolves a pack from <binDir>/workflows with source bin-workflows (injectable binDir)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-cwd2-"));
  const bin = mkdtempSync(join(tmpdir(), "pi-wf-bin-"));
  const echoDir = join(bin, "workflows", "echo");
  mkdirSync(echoDir, { recursive: true });
  writeFileSync(join(echoDir, "manifest.json"), JSON.stringify({ name: "echo", description: "bin", entry: "index.js" }));
  writeFileSync(join(echoDir, "index.js"), `export const meta = { name: "echo", description: "bin" };\nreturn { tier: "bin" };\n`);
  const r = resolveWorkflowScript("echo", { cwd, binDir: bin });
  expect(r.source).toBe("bin-workflows");
  expect(r.script).toContain("tier: \"bin\"");
});

test("cwd tier ranks ABOVE repo .pi/workflows (most local wins)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-wf-prec-"));
  // cwd-tier pack (bare <root>/workflows/echo)
  mkdirSync(join(root, "workflows", "echo"), { recursive: true });
  writeFileSync(join(root, "workflows", "echo", "manifest.json"), JSON.stringify({ name: "echo", description: "cwd", entry: "index.js" }));
  writeFileSync(join(root, "workflows", "echo", "index.js"), `export const meta = { name: "echo", description: "cwd" };\nreturn { tier: "cwd" };\n`);
  // repo-tier pack (<root>/.pi/workflows/echo) — different content to distinguish
  mkdirSync(join(root, ".pi", "workflows", "echo"), { recursive: true });
  writeFileSync(join(root, ".pi", "workflows", "echo", "manifest.json"), JSON.stringify({ name: "echo", description: "repo", entry: "index.js" }));
  writeFileSync(join(root, ".pi", "workflows", "echo", "index.js"), `export const meta = { name: "echo", description: "repo" };\nreturn { tier: "repo" };\n`);
  const r = resolveWorkflowScript("echo", { cwd: root }); // findRepoRoot(root) finds .pi/workflows → repo tiers reachable
  expect(r.source).toBe("cwd-workflows");
  expect(r.script).toContain("tier: \"cwd\"");
});

test("bin tier ranks BELOW cwd tier", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-cwd3-"));
  const bin = mkdtempSync(join(tmpdir(), "pi-wf-bin2-"));
  for (const base of [cwd, bin]) {
    mkdirSync(join(base, "workflows", "echo"), { recursive: true });
    writeFileSync(join(base, "workflows", "echo", "manifest.json"), JSON.stringify({ name: "echo", description: base === cwd ? "cwd" : "bin", entry: "index.js" }));
    writeFileSync(join(base, "workflows", "echo", "index.js"), `export const meta = { name: "echo", description: "${base === cwd ? "cwd" : "bin"}" };\nreturn { tier: "${base === cwd ? "cwd" : "bin"}" };\n`);
  }
  const r = resolveWorkflowScript("echo", { cwd, binDir: bin });
  expect(r.source).toBe("cwd-workflows");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack.test.ts )`
Expected: the 4 new tests FAIL — `source` is `"path"` / `".pi/workflows"` / not-found, because the cwd + bin tiers don't exist yet. Existing resolver tests still PASS.

- [ ] **Step 3: Widen the `source` type + add the `binDir` opt**

In `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts`, change the `ResolvedWorkflow` type (line ~50):

```ts
  source: "path" | "cwd-workflows" | "bin-workflows" | ".pi/workflows" | "package-workflows";
```

Change the `resolveWorkflowScript` signature (line ~105) to accept `binDir`:

```ts
export function resolveWorkflowScript(name: string, opts: { cwd?: string; binDir?: string } & WorkflowPackFs = {}): ResolvedWorkflow {
```

Immediately after the `const cwd = opts.cwd ?? process.cwd();` line, add:

```ts
  const binDir = opts.binDir ?? dirname(process.execPath);
```

(`dirname` is already imported from `node:path` and used by `findRepoRoot`.)

- [ ] **Step 4: Insert the two new tiers + update the not-found error**

In `resolveWorkflowScript`, the structure is currently: literal-path branch → `const names = …` → `const root = findRepoRoot(…)` → repo tiers → throw. Insert the two new tier blocks **between `const names` and `const root`**, and update the final throw. The result of that region:

```ts
  const names = name.endsWith(".js") ? [name] : [`${name}.js`, name];

  // 2. <cwd>/workflows/<name> — portable tier (no repo root needed); a pack
  //    folder wins over a same-name .js. Ranks ABOVE repo tiers ("most local
  //    wins" — Decision: portable-workflow-pack-discovery, ADR 0008).
  const cwdWorkflowsDir = join(cwd, "workflows");
  if (fs.exists(cwdWorkflowsDir)) {
    const pack = tryResolvePack(join(cwdWorkflowsDir, name), fs);
    if (pack) return { ...pack, source: "cwd-workflows" };
    for (const candidate of names) {
      const p = join(cwdWorkflowsDir, candidate);
      if (fs.exists(p) && fs.stat(p)?.isFile()) {
        return { path: p, script: fs.read(p), source: "cwd-workflows" };
      }
    }
  }

  // 3. <binDir>/workflows/<name> — packs shipped next to the binary. binDir
  //    defaults to dirname(process.execPath) (the compiled exe's real location
  //    in `bun --compile`); injectable so tests don't depend on the real exe.
  const binWorkflowsDir = join(binDir, "workflows");
  if (fs.exists(binWorkflowsDir)) {
    const pack = tryResolvePack(join(binWorkflowsDir, name), fs);
    if (pack) return { ...pack, source: "bin-workflows" };
    for (const candidate of names) {
      const p = join(binWorkflowsDir, candidate);
      if (fs.exists(p) && fs.stat(p)?.isFile()) {
        return { path: p, script: fs.read(p), source: "bin-workflows" };
      }
    }
  }

  // 4-5. Name resolution under the repo workflow dirs (walk-up). Per location, a
  //      workflow-pack directory (<name>/manifest.json) wins over a same-name file.
  const root = findRepoRoot(cwd, fs.exists);
  if (root) {
    const piDir = join(root, PI_WORKFLOWS_DIR);
    if (fs.exists(piDir)) {
      const pack = tryResolvePack(join(piDir, name), fs);
      if (pack) return { ...pack, source: ".pi/workflows" };
      for (const candidate of names) {
        const p = join(piDir, candidate);
        if (fs.exists(p) && fs.stat(p)?.isFile()) {
          return { path: p, script: fs.read(p), source: ".pi/workflows" };
        }
      }
    }

    const pkgRoot = join(root, PKG_WORKFLOWS_GLOB);
    if (fs.exists(pkgRoot) && fs.stat(pkgRoot)?.isDirectory()) {
      for (const pkg of fs.readdir(pkgRoot)) {
        const pkgDir = join(pkgRoot, pkg, "workflows");
        if (!fs.exists(pkgDir)) continue;
        const pack = tryResolvePack(join(pkgDir, name), fs);
        if (pack) return { ...pack, source: "package-workflows" };
        for (const candidate of names) {
          const p = join(pkgDir, candidate);
          if (fs.exists(p) && fs.stat(p)?.isFile()) {
            return { path: p, script: fs.read(p), source: "package-workflows" };
          }
        }
      }
    }
  }

  throw new Error(
    `workflow: script "${name}" not found.\n` +
      `Looked for: ${asPath}\n` +
      `  ${join(cwd, "workflows", names[0]!)}\n` +
      `  ${join(binDir, "workflows", names[0]!)}\n` +
      (root
        ? `  ${join(root, PI_WORKFLOWS_DIR, names[0]!)}\n` +
          `  ${join(root, PKG_WORKFLOWS_GLOB, "<pkg>", "workflows", names[0]!)}\n`
        : "") +
      `Pass an absolute path or a name under <cwd>/workflows/, <binDir>/workflows/, .pi/workflows/, or bun-apps/<pkg>/workflows/.`,
  );
}
```

(The repo-tier block body is unchanged — only the surrounding numbering + the new blocks + the throw change.)

- [ ] **Step 5: Run the tests and verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack.test.ts )`
Expected: ALL tests PASS (the 4 new ones + every existing resolver/manifest/model test). If an existing test asserts the OLD not-found message text, update its expectation to include the two new `workflows/` lines.

- [ ] **Step 6: Typecheck + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run typecheck )` (if present; else `bunx tsc --noEmit`).
Expected: no errors.
```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts
git commit -m "feat(workflow-pack): add cwd/bin portable name-resolution tiers above repo walk-up"
```

---

### Task 2: `listWorkflows` — enumerate the two new tiers

So `workflow list` shows packs discoverable via the new portable tiers, not just repo dirs.

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts` (`listWorkflows`, ~line 300-332).
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts`.

**Interfaces:**
- Produces: `listWorkflows(claudeRoot, opts?)` gains `{ cwd?, binDir? }` opts (default `process.cwd()` / `dirname(process.execPath)`); its returned `rows[].source` can now be `"cwd/workflows"` and `"bin/workflows"`.

- [ ] **Step 1: Write the failing test**

Add to the `listWorkflows` describe block (or create one) in `tests/workflow-pack.test.ts`:

```ts
describe("listWorkflows", () => {
  test("enumerates packs in <cwd>/workflows and <binDir>/workflows (portable tiers)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-ls-cwd-"));
    const bin = mkdtempSync(join(tmpdir(), "pi-ls-bin-"));
    // claudeRoot with no repo dirs → only the portable tiers should surface
    const claudeRoot = mkdtempSync(join(tmpdir(), "pi-ls-root-"));
    for (const [base, label] of [[cwd, "cwd"], [bin, "bin"]] as const) {
      mkdirSync(join(base, "workflows", "echo"), { recursive: true });
      writeFileSync(join(base, "workflows", "echo", "manifest.json"), JSON.stringify({ name: "echo", description: label, entry: "index.js" }));
      writeFileSync(join(base, "workflows", "echo", "index.js"), `export const meta = { name: "echo", description: "${label}" };\nreturn {};\n`);
    }
    const { rows } = listWorkflows(claudeRoot, { cwd, binDir: bin });
    const sources = rows.map((r) => r.source);
    expect(sources).toContain("cwd/workflows");
    expect(sources).toContain("bin/workflows");
    expect(rows.find((r) => r.source === "cwd/workflows" && r.name === "echo")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack.test.ts )`
Expected: new test FAILS — `rows` has no `cwd/workflows` / `bin/workflows` entries.

- [ ] **Step 3: Add cwd + bin dirs to `listWorkflows`**

In `src/workflow-pack.ts`, change the `listWorkflows` signature + `dirs` array:

```ts
export function listWorkflows(claudeRoot: string, opts: { cwd?: string; binDir?: string } & WorkflowPackFs = {}): WorkflowListResult {
  const fs = resolveFs(opts);
  const cwd = opts.cwd ?? process.cwd();
  const binDir = opts.binDir ?? dirname(process.execPath);
  const dirs = [
    { label: "cwd/workflows", dir: join(cwd, "workflows") },
    { label: "bin/workflows", dir: join(binDir, "workflows") },
    { label: ".pi/workflows", dir: join(claudeRoot, PI_WORKFLOWS_DIR) },
    ...fs.readdir(join(claudeRoot, PKG_WORKFLOWS_GLOB)).map((pkg) => ({
      label: `bun-apps/${pkg}/workflows`,
      dir: join(claudeRoot, PKG_WORKFLOWS_GLOB, pkg, "workflows"),
    })),
  ];
  // … rest unchanged (the for-loop over `dirs` already handles each entry) …
```

(The existing loop body that iterates `dirs` needs no change — it already handles pack-vs-file + errors generically.)

- [ ] **Step 4: Run the tests and verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack.test.ts )`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts
git commit -m "feat(workflow-pack): listWorkflows enumerates cwd/bin portable tiers"
```

---

### Task 3: Compiled-binary foreign-cwd verification (ticket 05)

The end-to-end proof: a freshly-built portable binary resolves + runs a pack BY NAME from a foreign cwd (no repo ancestry), exercising the new `<cwd>/workflows` tier. This is the verification recipe prototyped by the 2026-07-19 build probe, codified as a repeatable test.

**Files:**
- Create: `bun-apps/pi-agent-cli/tests/workflow-portable-e2e.test.ts`.

**Interfaces:**
- Consumes: the compiled binary at `../../dist/pi-agent-cli/pi-agent-cli` (relative to `bun-apps/pi-agent-cli/`, the `bun test` cwd). Skips if absent (matches the repo's e2e-artifact-gating convention).

- [ ] **Step 1: Rebuild the exe with the resolver change**

Run: `bun run --cwd bun-apps/pi-agent-cli build:exe`
Expected: `✓ …/dist/pi-agent-cli/pi-agent-cli` (the inlined `@repo/pi-agent-ext-workflow` now carries the new tiers). This is mandatory — the test runs the BINARY, not source.

- [ ] **Step 2: Write the test**

Create `bun-apps/pi-agent-cli/tests/workflow-portable-e2e.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dist/pi-agent-cli/pi-agent-cli, resolved from the `bun test` cwd (bun-apps/pi-agent-cli).
const EXE = join(process.cwd(), "..", "..", "dist", "pi-agent-cli", "pi-agent-cli");

/**
 * End-to-end portable-binary proof (ticket 05). Runs the COMPILED exe from a
 * FOREIGN cwd (mkdtemp under /tmp — no .pi/workflows or bun-apps ancestry, so
 * findRepoRoot returns undefined) and asserts name-resolution via the new
 * <cwd>/workflows tier works. Skipped when the exe isn't built — run
 * `bun run --cwd bun-apps/pi-agent-cli build:exe` first.
 */
describe.skipIf(!existsSync(EXE))("compiled pi-agent-cli: portable workflow-pack run", () => {
  function makePack(dir: string, desc: string): void {
    mkdirSync(join(dir, "workflows", "echo"), { recursive: true });
    writeFileSync(join(dir, "workflows", "echo", "manifest.json"), JSON.stringify({ name: "echo", description: desc, entry: "index.js" }));
    writeFileSync(join(dir, "workflows", "echo", "index.js"), `export const meta = { name: "echo", description: "${desc}" };\nreturn { tier: "${desc}" };\n`);
  }

  it("resolves + runs a pack BY NAME from a foreign cwd via <cwd>/workflows (source cwd-workflows)", async () => {
    const foreign = mkdtempSync(join(tmpdir(), "pi-portable-"));
    makePack(foreign, "portable");
    const proc = Bun.spawn([EXE, "workflow", "run", "echo", "--dry-run"], { cwd: foreign, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(code).toBe(0);
    expect(out).toContain("cwd-workflows"); // the receipt prints `(source: cwd-workflows)`
    expect(err).toBe("");
  });

  it("runs a pack via absolute path from a foreign cwd (baseline, source path)", async () => {
    const foreign = mkdtempSync(join(tmpdir(), "pi-portable-abs-"));
    const packDir = mkdtempSync(join(tmpdir(), "pi-portable-pack-"));
    makePack(packDir, "abspath");
    // Pass the PACK dir (where manifest.json lives), not packDir (its parent) —
    // resolver branch 1 needs a dir containing manifest.json.
    const proc = Bun.spawn([EXE, "workflow", "run", join(packDir, "workflows", "echo"), "--dry-run"], { cwd: foreign, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(out).toContain("source: path");
  });
});
```

- [ ] **Step 3: Run the test and verify it passes**

Run: `( cd bun-apps/pi-agent-cli && bun test tests/workflow-portable-e2e.test.ts )`
Expected: 2 tests PASS (not skipped — the exe exists from Step 1). Receipt lines: `✓ echo — agents=0 (source: cwd-workflows) → object {tier}` and `… (source: path) …`.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-cli/tests/workflow-portable-e2e.test.ts
git commit -m "test(pi-agent-cli): compiled-binary portable workflow-pack e2e (foreign cwd)"
```

---

### Task 4: Record the decision — ADR 0008 + CONTEXT.md glossary entry

The precedence ("cwd/bin above repo", most-local-wins) is surprising and a real trade-off (three alternatives were rejected — see ticket 04). Record it so a future reader doesn't re-litigate it.

**Files:**
- Create: `bun-apps/pi-agent-cli/docs/adr/0008-portable-workflow-pack-discovery.md`.
- Modify: `bun-apps/pi-agent-cli/CONTEXT.md`.

- [ ] **Step 1: Write ADR 0008**

Create `bun-apps/pi-agent-cli/docs/adr/0008-portable-workflow-pack-discovery.md`:

```markdown
# ADR 0008 — Portable workflow-pack discovery (cwd/bin tiers above repo)

- Status: proposed
- Date: 2026-07-19

## Context

A portable single-exec `pi-agent-cli` binary (built via `bun scripts/build.ts
--compile`) must run a user-supplied workflow-pack by NAME on a machine without
this repo. The resolver's existing name-resolution walks UP from cwd for a repo
root (`.pi/workflows/` or `bun-apps/`); on a repo-less machine `findRepoRoot`
returns undefined, so only an absolute path works — name-resolution fails.

The engine itself is already portable: the resolver + `node:vm` engine are
inlined into the compile build, packs are self-contained (`manifest.json` + one
entry, no imports), and a foreign-cwd real run was verified end-to-end
(2026-07-19 build probe: `echo` pack, `agents=1 1232ms`, exit 0, pi-default
model). Only name-discovery was missing.

## Decision

Add two name-resolution tiers that need no repo root, ranking ABOVE the repo
walk-up ("most local wins"):

1. absolute path (literal file/dir — unchanged)
2. `<cwd>/workflows/<name>` — a bare `workflows/` dir in the current working dir
3. `<binDir>/workflows/<name>` — a `workflows/` dir next to the binary, where
   `binDir = dirname(process.execPath)` (the reliable exe-location primitive in
   `bun --compile`; `Bun.executable` is undefined, `import.meta.url` is virtual)
4. `<repoRoot>/.pi/workflows/<name>` (existing)
5. `<repoRoot>/bun-apps/<pkg>/workflows/<name>` (existing)

A pack folder wins over a same-name `.js` at every tier. cwd-local and
binary-bundled packs therefore shadow repo packs even when cwd is inside a repo.

## Alternatives considered

- **`~/.pi/workflows` (mirror of `.pi/agents` + `~/.pi/agents`):** rejected —
  user preferred location-coupled discovery (cwd / next-to-binary) over a
  home-dir user library.
- **absolute-path-only:** rejected — too bare ergonomically; `workflow run echo`
  must work with zero config.
- **new tiers as fallback (below repo):** rejected — would not let cwd/bin-dir
  shadow repo packs; "most local wins" was chosen explicitly.

## Consequences

- `ResolvedWorkflow["source"]` gains `"cwd-workflows" | "bin-workflows"`.
- `resolveWorkflowScript` + `listWorkflows` gain an injectable `binDir` opt
  (default `dirname(process.execPath)`) for hermetic tests.
- The change lives in the engine (`pi-agent-ext-workflow/src/workflow-pack.ts`),
  the single source of truth shared by the headless CLI and any future
  interactive `workflow` tool.
```

- [ ] **Step 2: Add the glossary entry to CONTEXT.md**

In `bun-apps/pi-agent-cli/CONTEXT.md`, add (in the appropriate terms section) a one-line glossary entry — no implementation detail:

```markdown
- **Workflow-pack resolution precedence**: the order `workflow run <name>` looks
  for a pack — absolute path → `<cwd>/workflows` → `<binDir>/workflows` → repo
  `.pi/workflows` → repo `bun-apps/<pkg>/workflows`. "Most local wins": cwd-local
  and binary-bundled packs shadow repo packs. See ADR 0008.
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-cli/docs/adr/0008-portable-workflow-pack-discovery.md bun-apps/pi-agent-cli/CONTEXT.md
git commit -m "docs(pi-agent-cli): ADR 0008 + glossary for portable workflow-pack discovery"
```

---

## Self-Review

**1. Spec coverage** (map destination + tickets 04/05):
- "portable binary resolves a user-supplied pack by name, repo-less" → Task 1 (cwd + bin tiers). ✓
- "general — any conforming pack" → tiers read any `manifest.json` + self-contained entry (format unchanged). ✓
- "headless `workflow run` (Path A)" → resolver is shared by the CLI path; no Path B work. ✓
- "verified by a real e2e run from a foreign cwd" → Task 3 (compiled exe + foreign cwd + name-resolution). ✓ (dry-run for the automated gate; the 2026-07-19 probe already did the real `agent()` run.)
- ticket 04 implementation notes (engine change in `workflow-pack.ts`, `listWorkflows`, error msg, `process.execPath`, ADR) → Tasks 1, 2, 4. ✓
- ticket 05 (representative pack, assertions, test location) → Task 3 (`echo` pack, exit-0 + source assertions, `pi-agent-cli/tests/`). ✓

**2. Placeholder scan:** every code step shows actual code; the only "…" is in Task 2 Step 3 marking the unchanged loop body (not a placeholder — it's an existing unchanged region). No TBD/TODO/"add error handling". ✓

**3. Type consistency:** `source` literals `"cwd-workflows"` / `"bin-workflows"` are identical in the type (Task 1 Step 3), the resolver returns (Task 1 Step 4), the tests (Task 1 Step 1), and the ADR. `binDir` opt name is consistent across `resolveWorkflowScript` + `listWorkflows`. ✓

## Execution Handoff

Plan saved to `.planning/review-pi-agent-deploy-single-exec-binary-ensure/plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task (1→2→3→4), two-stage review between tasks. Best for isolation + fast iteration.

**2. Inline Execution** — execute tasks in this session via executing-plans, batch execution with checkpoints.

Which approach?

When Task 3 lands (the verification test passes), close wayfinder ticket **05** (`/wayfind sync` or manual: set `status: closed`, add a Resolution pointing at `tests/workflow-portable-e2e.test.ts`). Tickets 01–04 are already closed. The map is then fully resolved.
