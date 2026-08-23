# pi-agent Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 8 CONFIRMED correctness bugs found in a full-directory code review of `bun-apps/pi-agent` (2026-07-18), each with a regression test that fails on current code and passes after the fix.

**Architecture:** Each task is an independent, surgical fix to one bug. Several fixes extract previously-inline logic (a monkey-patch's side effect, a build script's hashing, a shell script's JSON construction, a CLI's argv classification) into small pure/testable units — not a redesign, just enough separation to unit-test the specific defect. No task depends on another; they can be done in any order, but Task 1 touches a second package (`pi-agent-cli`) so do it first while context is freshest.

**Tech Stack:** Bun, TypeScript, `bun:test`, bash.

**Out of scope (flagged, not actioned):** three code smells from the review are explicitly excluded here because fixing them safely requires a larger, riskier refactor than this plan's bite-sized/low-risk bar allows — each needs its own follow-up plan:
- Divergent Change between `src/doctor.ts` and `src/ext-doctor.ts` (two independent report-shape/print implementations) — unifying them touches `pi-agent-cli/src/commands/doctor.ts` too (it re-exports `doctor.ts`'s types), widening blast radius beyond a single package.
- Duplicated "mock pi + extension-protocol contract check" logic across `scripts/verify-extensions.ts`, `src/__tests__/extension-contract.test.ts`, and the inline `PROBE_TS` canary in `scripts/deploy.ts` — three independently-evolved implementations; consolidating risks subtly changing what each one actually catches.
- `src/patches/footer-extension-status-notify.ts` being kept despite its own header calling it redundant — the codebase's own comment already documents a deliberate decision to retain it (removal is "cross-package churn" against a "harmless idempotent patch"); reversing that decision isn't this plan's call to make.

---

### Task 1: Stop `pre-load-providers.ts` from monkey-patching `ModelRegistry` as an import side effect

**Files:**
- Modify: `bun-apps/pi-agent/src/pre-load-providers.ts` (strip the patch, add `registerAllProviders`)
- Create: `bun-apps/pi-agent/src/patches/pre-load-providers-patch.ts` (the actual monkey-patch, moved here)
- Modify: `bun-apps/pi-agent/src/patches/index.ts:148` (import path for the patch)
- Modify: `bun-apps/pi-agent/src/index.ts` (drop the risky namespace re-export)
- Modify: `bun-apps/pi-agent-cli/src/sessions/shared.ts` (use the new shared helper instead of a duplicated loop)
- Test: `bun-apps/pi-agent/src/pre-load-providers.test.ts`
- Create: `bun-apps/pi-agent/src/__tests__/fixtures/check-pre-load-providers-pure.ts` (subprocess fixture)

**Bug:** `src/index.ts:21` does `export * as providers from "./pre-load-providers.ts";`. That file's *current* top-level code (line 117) unconditionally does `Proto.loadModels = function (...) { ... }` — a real monkey-patch — as an ES-module evaluation side effect. `bun-apps/pi-agent-cli/src/sessions/shared.ts:43` imports `{ PROVIDERS, resolveApiKey }` from `@repo/pi-agent` specifically *to avoid* pi-agent's `main()`-oriented pre-load-providers patch (see its own comment: "rather than via pi-agent's main()-oriented pre-load-providers monkey-patch ... wrong for this entry point"). But importing any named export from a module evaluates that module's entire top level — so importing `PROVIDERS` still applies the patch. Every `new ModelRegistry(...)` in `pi-agent-cli` then double-registers every provider: once via the now-patched `loadModels()`, once via `shared.ts`'s own explicit loop right after.

**Fix:** Split the file into a pure data/helper module (no side effects) and a separate patch module that's only ever reached through `applyPatches()`. Also replace the two independent "loop over PROVIDERS and call registerProvider" implementations (`pre-load-providers.ts` and `shared.ts`) with one shared `registerAllProviders()` helper.

- [ ] **Step 1: Write the failing purity regression test**

Create `bun-apps/pi-agent/src/__tests__/fixtures/check-pre-load-providers-pure.ts`:

```ts
/**
 * Fixture for pre-load-providers.test.ts's side-effect regression test. Runs in
 * its own subprocess (fresh module cache) so no other test file's import of the
 * patch module can taint the result. Imports ONLY ../../pre-load-providers.ts,
 * then reports whether ModelRegistry.prototype.loadModels was touched.
 */
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const before = (ModelRegistry.prototype as any).loadModels;
await import("../../pre-load-providers.ts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const after = (ModelRegistry.prototype as any).loadModels;

console.log(JSON.stringify({ unchanged: after === before }));
```

Add to `bun-apps/pi-agent/src/pre-load-providers.test.ts` (append at the end of the file):

```ts
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("module purity (no ModelRegistry side effects)", () => {
  test("importing pre-load-providers.ts does not patch ModelRegistry.prototype.loadModels", () => {
    const fixture = join(import.meta.dir, "__tests__", "fixtures", "check-pre-load-providers-pure.ts");
    const proc = spawnSync("bun", [fixture], { encoding: "utf8", cwd: import.meta.dir });
    expect(proc.status).toBe(0);
    const result = JSON.parse(proc.stdout.trim());
    expect(result.unchanged).toBe(true);
  });
});

describe("registerAllProviders", () => {
  test("calls registerProvider exactly once per PROVIDERS entry", () => {
    const calls: Array<[string, unknown]> = [];
    const fakeRegistry = { registerProvider: (name: string, config: unknown) => calls.push([name, config]) };
    registerAllProviders(fakeRegistry, {});
    expect(calls.length).toBe(Object.keys(PROVIDERS).length);
    expect(calls.map(([name]) => name).sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  test("resolves apiKey and zeroes cost for every registered model", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: Array<[string, any]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRegistry = { registerProvider: (name: string, config: any) => calls.push([name, config]) };
    registerAllProviders(fakeRegistry, {});
    for (const [, config] of calls) {
      expect(typeof config.apiKey).toBe("string");
      for (const m of config.models) {
        expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      }
    }
  });
});
```

Update the top import of `pre-load-providers.test.ts` to also pull in `registerAllProviders`:

```ts
import { PROVIDERS, resolveApiKey, registerAllProviders } from "./pre-load-providers.ts";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent && bun test src/pre-load-providers.test.ts )`
Expected: FAIL — `registerAllProviders` is not exported yet (import error), and even once stubbed, the purity test fails because the current file patches the prototype at module scope.

- [ ] **Step 3: Rewrite `src/pre-load-providers.ts` as a pure data/helper module**

Replace the entire contents of `bun-apps/pi-agent/src/pre-load-providers.ts` with:

```ts
/**
 * pre-load-providers — the baked LLM provider catalog + pure helpers to
 * register it onto a ModelRegistry.
 *
 * HOW TO ADD A PROVIDER
 * ---------------------
 * Add an entry to PROVIDERS below. Run `bun src/cli.ts --list-models` to verify.
 * No other file needs to change.
 *
 * API KEY
 * -------
 *   apiKey: "literal-string"         — hardcode (OK for local servers with fake keys)
 *   apiKey: { env: "MY_API_KEY" }   — read from environment variable at runtime
 *
 * SIDE-EFFECT-FREE BY DESIGN
 * ---------------------------
 * This module has NO top-level side effects — importing PROVIDERS / resolveApiKey /
 * registerAllProviders from anywhere (including pi-agent-cli, via `@repo/pi-agent`)
 * must never monkey-patch anything. The actual ModelRegistry.prototype.loadModels
 * patch lives in `./patches/pre-load-providers-patch.ts` and is applied ONLY via
 * applyPatches() (env-gated, main()-oriented). A prior version patched the
 * prototype right here at module scope, which meant ANY import of this file —
 * even just `{ PROVIDERS }` — applied the patch as an ES-module evaluation side
 * effect, double-registering every provider for pi-agent-cli's programmatic
 * session builder (which explicitly imports PROVIDERS to AVOID that patch; see
 * bun-apps/pi-agent-cli/src/sessions/shared.ts). Keep it that way.
 */

// ─── Provider config ──────────────────────────────────────────────────────────

export type ApiKey = string | { env: string };

interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean };
}

interface ProviderEntry {
  baseUrl: string;
  api: string;
  apiKey: ApiKey;
  models: ModelEntry[];
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const PROVIDERS: Record<string, ProviderEntry> = {

  "lm-studio": {
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    apiKey: "lm-studio",
    models: [
      {
        id: "google/gemma-4-26b-a4b-qat",
        name: "Gemma 4 26B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
      {
        id: "google/gemma-4-31b-qat",
        name: "Gemma 4 31B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
      {
        id: "qwen/qwen3-vl-4b",
        name: "Qwen3 VL 4B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 131_072,
        maxTokens: 16_384,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
    ],
  },

  // "openrouter": {
  //   baseUrl: "https://openrouter.ai/api/v1",
  //   api: "openai-completions",
  //   apiKey: { env: "OPENROUTER_API_KEY" },
  //   models: [
  //     { id: "google/gemma-2-9b-it:free",          name: "Gemma 2 9B (OR free)",   reasoning: false, input: ["text"], contextWindow: 8_192,  maxTokens: 4_096 },
  //     { id: "mistralai/mistral-nemo:free",         name: "Mistral Nemo (OR free)", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096 },
  //     { id: "deepseek/deepseek-chat-v3-0324:free", name: "DeepSeek V3 (OR free)",  reasoning: false, input: ["text"], contextWindow: 64_000,  maxTokens: 8_192 },
  //   ],
  // },

};

/** Resolve an ApiKey spec: a literal string, or {env} → process.env ("" if unset). */
export function resolveApiKey(key: ApiKey, env: Record<string, string | undefined> = process.env): string {
  if (typeof key === "string") return key;
  return env[key.env] ?? "";
}

/**
 * Register every PROVIDERS entry onto a live ModelRegistry via its real
 * registerProvider(name, config). Pure aside from the registry mutation the
 * caller passes in — shared by the pre-load-providers monkey-patch
 * (./patches/pre-load-providers-patch.ts) AND pi-agent-cli's programmatic
 * session builder (bun-apps/pi-agent-cli/src/sessions/shared.ts), so the
 * "baked provider catalog → registerProvider calls" logic exists in exactly
 * one place.
 */
export function registerAllProviders(
  registry: { registerProvider(name: string, config: unknown): void },
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, entry] of Object.entries(PROVIDERS)) {
    registry.registerProvider(name, {
      ...entry,
      apiKey: resolveApiKey(entry.apiKey, env),
      models: entry.models.map((m) => ({ ...m, cost: ZERO_COST })),
    });
  }
}
```

- [ ] **Step 4: Create the patch module**

Create `bun-apps/pi-agent/src/patches/pre-load-providers-patch.ts`:

```ts
/**
 * pre-load-providers-patch — monkey-patches ModelRegistry.prototype.loadModels
 * to register pi-agent's baked PROVIDERS catalog.
 *
 * HOW IT WORKS
 * ------------
 * ModelRegistry's constructor calls the private loadModels(), not refresh().
 * We wrap loadModels() so that after the built-in catalog loads, we call the
 * real registerProvider() for every PROVIDERS entry (via registerAllProviders,
 * shared with pi-agent-cli). registerProvider() stores the config in
 * registeredProviders, so any later refresh() replays it automatically.
 *
 * Side-effecting — only ever imported from applyPatches() (./index.ts), gated
 * by BUN_PI_PRE_LOAD_PROVIDERS. Never import this from the library barrel
 * (../index.ts) or anywhere PROVIDERS/resolveApiKey/registerAllProviders alone
 * would suffice — see ../pre-load-providers.ts's header for why.
 */
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { registerAllProviders } from "../pre-load-providers.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Proto = ModelRegistry.prototype as any;

// Capture the real method before any other patch can touch it.
const _realLoadModels = Proto.loadModels as (this: unknown) => void;
const _realRegisterProvider = Proto.registerProvider as (
  this: unknown,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Proto.loadModels = function (this: any) {
  _realLoadModels.call(this);
  registerAllProviders({
    registerProvider: (name, config) => _realRegisterProvider.call(this, name, config),
  });
};

export const preLoadProvidersPatchApplied = true;
```

- [ ] **Step 5: Point `applyPatches()` at the new patch file**

In `bun-apps/pi-agent/src/patches/index.ts`, change (around line 147-149):

```ts
      case "pre-load-providers":
        await import("../pre-load-providers.ts");
        break;
```

to:

```ts
      case "pre-load-providers":
        await import("./pre-load-providers-patch.ts");
        break;
```

- [ ] **Step 6: Drop the risky namespace re-export from the library barrel**

In `bun-apps/pi-agent/src/index.ts`, remove this line (nothing in the monorepo imports the `providers` namespace — only the named `PROVIDERS`/`resolveApiKey` exports are consumed):

```ts
export * as providers from "./pre-load-providers.ts";
```

Update the header comment's "providers" bullet (currently `providers  : the baked LLM provider catalog (PROVIDERS) + apiKey resolver`) — it's still accurate, leave it. The file should now start:

```ts
export {
	PROVIDERS,
	resolveApiKey,
	registerAllProviders,
	type ApiKey,
} from "./pre-load-providers.ts";
```

(add `registerAllProviders` to the existing named-export list right after the header comment, replacing the `export * as providers ...` line that preceded it).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent && bun test src/pre-load-providers.test.ts )`
Expected: PASS — all tests including the new purity + registerAllProviders tests.

- [ ] **Step 8: Update `pi-agent-cli`'s `shared.ts` to use the shared helper**

In `bun-apps/pi-agent-cli/src/sessions/shared.ts`, change the import (around line 38-43):

```ts
// The baked provider CATALOG (lm-studio) is sourced from `pi-agent` — single
// source of truth across both CLIs. We register it explicitly here (the
// programmatic-session path) rather than via pi-agent's main()-oriented
// pre-load-providers monkey-patch, which splices process.argv and is wrong for
// this entry point. See bun-apps/pi-agent/src/pre-load-providers.ts.
import { PROVIDERS, resolveApiKey } from "@repo/pi-agent";
```

to:

```ts
// The baked provider CATALOG (lm-studio) is sourced from `pi-agent` — single
// source of truth across both CLIs. We register it explicitly here (the
// programmatic-session path) via the shared registerAllProviders() helper,
// rather than pi-agent's main()-oriented pre-load-providers PATCH (which
// splices process.argv and is wrong for this entry point — see
// bun-apps/pi-agent/src/patches/pre-load-providers-patch.ts). Importing
// registerAllProviders here is safe: pi-agent/src/pre-load-providers.ts has no
// import-time side effects, so this never applies that patch.
import { registerAllProviders } from "@repo/pi-agent";
```

Remove the now-unused `ZERO_COST` const (around line 172):

```ts
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
```

Replace the registration loop in `buildBakedRegistry()` (around line 245-253):

```ts
	const modelRegistry = new ModelRegistry(modelRuntime);
	for (const [name, entry] of Object.entries(PROVIDERS)) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		modelRegistry.registerProvider(name, {
			...entry,
			apiKey: resolveApiKey(entry.apiKey),
			models: entry.models.map((m) => ({ ...m, cost: ZERO_COST })),
		} as any);
	}
	return { modelRuntime, modelRegistry };
```

with:

```ts
	const modelRegistry = new ModelRegistry(modelRuntime);
	registerAllProviders(modelRegistry);
	return { modelRuntime, modelRegistry };
```

- [ ] **Step 9: Run both packages' test suites**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS, 0 fail.

Run: `( cd bun-apps/pi-agent-cli && bun test )`
Expected: PASS, 0 fail. If `shared.ts` has its own tests exercising `buildBakedRegistry()`, confirm they still assert `lm-studio` is registered (behavior unchanged, only the double-registration removed).

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent/src/pre-load-providers.ts bun-apps/pi-agent/src/pre-load-providers.test.ts bun-apps/pi-agent/src/patches/pre-load-providers-patch.ts bun-apps/pi-agent/src/patches/index.ts bun-apps/pi-agent/src/index.ts bun-apps/pi-agent/src/__tests__/fixtures/check-pre-load-providers-pure.ts bun-apps/pi-agent-cli/src/sessions/shared.ts
git commit -m "fix(pi-agent): stop pre-load-providers.ts from patching ModelRegistry as an import side effect"
```

---

### Task 2: Fix `tool-gate.ts`'s allow-list gap and per-turn tool deactivation

**Files:**
- Modify: `bun-apps/pi-agent/extensions/tool-gate.ts`
- Test: `bun-apps/pi-agent/extensions/tool-gate.test.ts` (new)

**Bugs:**
1. `computeActiveTools()` returns `allToolNames.filter((name) => active.has(name))` — an *intersection* against a hardcoded `CORE_TOOLS ∪ GATES[].names` allow-list. Any real tool not named in either set (the file's own header claims 41 total tools; `CORE_TOOLS` + `GATES` names only account for 36) can never be activated for any prompt, with no error surfaced.
2. `before_agent_start` recomputes the active set from *only the current turn's prompt*, discarding whatever a previous turn already activated — a tool a workflow is mid-way through using can vanish because the next turn's prompt doesn't repeat the trigger keyword.

**Fix:** Make gating fail-open for tools the file doesn't know about, and make gate activation sticky for the session (once triggered, a gate's tools stay active). Refactor `computeActiveTools` into an exported pure function (taking the tool list and the accumulator as parameters) so both bugs are directly unit-testable.

- [ ] **Step 1: Write the failing tests**

Create `bun-apps/pi-agent/extensions/tool-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeActiveTools, CORE_TOOLS } from "./tool-gate.ts";

describe("computeActiveTools", () => {
  test("a tool not listed in CORE_TOOLS or any gate is always active (fail-open)", () => {
    const allTools = [...CORE_TOOLS, "some_future_tool_not_in_any_gate"];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("", allTools, sticky);
    expect(active).toContain("some_future_tool_not_in_any_gate");
  });

  test("a gate stays active across turns even when a later prompt doesn't mention it", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    const turn1 = computeActiveTools("generate an image of a cat", allTools, sticky);
    expect(turn1).toContain("flux2");
    const turn2 = computeActiveTools("make it bigger", allTools, sticky);
    expect(turn2).toContain("flux2");
    expect(turn2).toContain("flux2_help");
  });

  test("a gate never mentioned by any prompt stays inactive", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("what's the weather", allTools, sticky);
    expect(active).not.toContain("flux2");
    expect(active).not.toContain("flux2_help");
  });

  test("CORE_TOOLS are always active regardless of prompt", () => {
    const allTools = [...CORE_TOOLS];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("irrelevant prompt", allTools, sticky);
    for (const t of CORE_TOOLS) expect(active).toContain(t);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test extensions/tool-gate.test.ts )`
Expected: FAIL — `computeActiveTools` and `CORE_TOOLS` are not exported yet.

- [ ] **Step 3: Refactor `tool-gate.ts` to fix both bugs**

Replace the `computeActiveTools` function and the `CORE_TOOLS` declaration in `bun-apps/pi-agent/extensions/tool-gate.ts`. First, export `CORE_TOOLS` (change `const CORE_TOOLS` to `export const CORE_TOOLS`, no other change to its contents).

Then replace the whole extension-entry section (from `// ── Extension entry ──` to the end of the file) with:

```ts
// ── Extension entry ──────────────────────────────────────────────

/**
 * Compute which tools should be active for this turn.
 *
 * `sticky` is the accumulator of every tool activated so far THIS SESSION —
 * it starts as a copy of CORE_TOOLS and callers mutate it in place across
 * turns, so a gate that fires once stays active for the rest of the session
 * (a workflow using flux2 must not lose the tool mid-task just because a
 * follow-up prompt like "make it bigger" doesn't repeat the trigger keyword).
 *
 * Fail-open for UNKNOWN tools: only tools this file explicitly tracks (in
 * CORE_TOOLS or a GATES entry) are ever gated off. A tool from a new/renamed
 * extension that this file hasn't been updated for is never hidden — gating
 * is an opt-in allowlist for a KNOWN heavy set, not a default-deny for
 * everything else.
 */
export function computeActiveTools(
  prompt: string,
  allToolNames: string[],
  sticky: Set<string>,
): string[] {
  const promptLower = prompt.toLowerCase();

  const known = new Set(CORE_TOOLS);
  for (const gate of GATES) for (const name of gate.names) known.add(name);

  for (const gate of GATES) {
    const matches = gate.keywords.some((kw) => promptLower.includes(kw));
    if (matches) {
      for (const name of gate.names) sticky.add(name);
    }
  }

  return allToolNames.filter((name) => !known.has(name) || sticky.has(name));
}

export default function toolGateExtension(pi: ExtensionAPI) {
  let allToolNames: string[] = [];
  let sticky = new Set<string>(CORE_TOOLS);

  // ── On session start: capture full tool list and gate ──
  pi.on("session_start", async (_event, ctx) => {
    allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);
    sticky = new Set(CORE_TOOLS);

    const active = computeActiveTools("", allToolNames, sticky);
    pi.setActiveTools(active);

    const gatedCount = allToolNames.length - active.length;
    const saved = GATES.filter(
      (g) => !g.names.some((n) => active.includes(n)),
    ).reduce((sum, g) => sum + g.savedTokens, 0);
    void gatedCount;

    ctx.ui.notify(
      `🔧 Tool gate: ${active.length}/${allToolNames.length} active (saves ~${saved} tok/req)`,
      "info",
    );
  });

  // ── Per-turn: re-evaluate gates based on prompt (sticky — never un-gates) ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const prompt = event.prompt ?? "";
    const active = computeActiveTools(prompt, allToolNames, sticky);
    pi.setActiveTools(active);
  });
}
```

(`gatedCount` was already computed only for the log line's math via `saved`; keeping the `void gatedCount;` avoids an unused-var lint since it's no longer separately logged — if the project's lint config doesn't flag unused locals, this line is unnecessary but harmless. Check `bun run lint` output in Step 5 and drop it if unneeded.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test extensions/tool-gate.test.ts )`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Run the full pi-agent test suite + lint**

Run: `( cd bun-apps/pi-agent && bun test && bun run lint 2>/dev/null || true )`
Expected: PASS, 0 fail. If lint flags the `void gatedCount;` line as unnecessary, remove it.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/extensions/tool-gate.ts bun-apps/pi-agent/extensions/tool-gate.test.ts
git commit -m "fix(pi-agent): tool-gate fail-open for unknown tools + sticky gate activation"
```

---

### Task 3: Include transitive `@repo/*` workspace deps in the warm-deploy hash cache

**Files:**
- Create: `bun-apps/pi-agent/scripts/lib/ext-hash.ts`
- Create: `bun-apps/pi-agent/scripts/lib/ext-hash.test.ts`
- Modify: `bun-apps/pi-agent/scripts/build-extensions.ts`

**Bug:** `hashExtInputs()`/`collectPackageSources()` (currently `scripts/build-extensions.ts:227-276`) only walk the extension's own `pkgDir` tree. If extension A imports `@repo/some-shared-util` and a bugfix lands in that shared package, re-running `build-extensions.ts` for A still hashes only A's own directory, gets the same digest as before, and logs `skipped (hash match)` — shipping a stale bundle.

**Fix:** Extract the hashing logic into its own pure, testable module and make it walk every `@repo/*` workspace package reachable (transitively, via each `package.json`'s `dependencies`/`devDependencies`/`peerDependencies`) from the extension's own directory, hashing all of them together.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/scripts/lib/ext-hash.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashExtInputs, collectWorkspaceDepDirs } from "./ext-hash.ts";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ext-hash-test-"));
  const workspaceRoot = join(root, "bun-apps");
  const extDir = join(workspaceRoot, "my-ext");
  const sharedDir = join(workspaceRoot, "shared-util");
  mkdirSync(extDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });

  writeFileSync(
    join(extDir, "package.json"),
    JSON.stringify({ name: "@repo/my-ext", dependencies: { "@repo/shared-util": "*" } }),
  );
  writeFileSync(join(extDir, "index.ts"), "export const x = 1;\n");

  writeFileSync(join(sharedDir, "package.json"), JSON.stringify({ name: "@repo/shared-util" }));
  writeFileSync(join(sharedDir, "util.ts"), "export const util = 1;\n");

  return { root, workspaceRoot, extDir, sharedDir };
}

const baseOpts = {
  thin: true,
  minifyCfg: "whitespace,identifiers,syntax",
  thinExternals: ["typebox"],
  bunVersion: "1.3.0",
};

describe("collectWorkspaceDepDirs", () => {
  test("finds a direct @repo/* dependency", () => {
    const { workspaceRoot, extDir, sharedDir, root } = makeFixture();
    try {
      const dirs = collectWorkspaceDepDirs(extDir, workspaceRoot);
      expect(dirs).toContain(sharedDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hashExtInputs", () => {
  test("changes when a transitive @repo/* dependency's source changes", () => {
    const { workspaceRoot, extDir, sharedDir, root } = makeFixture();
    try {
      const entry = join(extDir, "index.ts");
      const before = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });

      writeFileSync(join(sharedDir, "util.ts"), "export const util = 2; // changed\n");

      const after = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });
      expect(after).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is stable when nothing changes", () => {
    const { workspaceRoot, extDir, root } = makeFixture();
    try {
      const entry = join(extDir, "index.ts");
      const a = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });
      const b = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });
      expect(a).toBe(b);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test scripts/lib/ext-hash.test.ts )`
Expected: FAIL — `./ext-hash.ts` does not exist yet.

- [ ] **Step 3: Create `scripts/lib/ext-hash.ts`**

```ts
/**
 * ext-hash — pure functions for computing an extension's warm-deploy cache key.
 * Extracted from build-extensions.ts so the hashing logic (including transitive
 * @repo/* workspace dependency coverage) is independently testable without
 * executing the rest of the build script.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SOURCE_GLOBS = /\.(ts|tsx|js|jsx|json)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__tests__"]);

/** Every source file under `dir` (recursive), as [relativePath, content]. */
export function collectPackageSources(dir: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	if (!existsSync(dir)) return out;
	const walk = (cur: string) => {
		let entries: string[];
		try {
			entries = readdirSync(cur);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(cur, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (SKIP_DIRS.has(name)) continue;
				walk(full);
			} else if (st.isFile() && SOURCE_GLOBS.test(name) && !/\.d\.ts$|\.test\.[jt]s$/.test(name)) {
				try {
					out.push([full.slice(dir.length), readFileSync(full, "utf8")]);
				} catch {
					/* unreadable — skip */
				}
			}
		}
	};
	walk(dir);
	return out;
}

/**
 * Every `@repo/*` workspace package dir reachable (transitively) from
 * `pkgDir`'s package.json `dependencies`/`devDependencies`/`peerDependencies`.
 * `workspaceRoot` is the dir each `@repo/<name>` maps to (`<workspaceRoot>/<name>`).
 * Cycle-safe via the shared `visited` set.
 */
export function collectWorkspaceDepDirs(
	pkgDir: string,
	workspaceRoot: string,
	visited: Set<string> = new Set(),
): string[] {
	if (visited.has(pkgDir)) return [];
	visited.add(pkgDir);
	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) return [];
	let pkgJson: {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	try {
		pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
	} catch {
		return [];
	}
	const deps = {
		...pkgJson.dependencies,
		...pkgJson.devDependencies,
		...pkgJson.peerDependencies,
	};
	const out: string[] = [];
	for (const dep of Object.keys(deps)) {
		if (!dep.startsWith("@repo/")) continue;
		const depDir = join(workspaceRoot, dep.slice("@repo/".length));
		if (visited.has(depDir) || !existsSync(depDir)) continue;
		out.push(depDir);
		out.push(...collectWorkspaceDepDirs(depDir, workspaceRoot, visited));
	}
	return out;
}

/** Hash the inputs that determine an ext bundle's output. Stable across runs;
 *  includes every transitive `@repo/*` workspace dependency's source tree, so
 *  a shared-package change invalidates every extension that consumes it. */
export function hashExtInputs(opts: {
	entry: string;
	pkgDir: string;
	thin: boolean;
	workspaceRoot: string;
	minifyCfg: string;
	thinExternals: readonly string[];
	bunVersion: string;
}): string {
	const h = createHash("sha256");
	h.update(`thin=${opts.thin}\n`);
	h.update(`minify=${opts.minifyCfg}\n`);
	h.update(`bun=${opts.bunVersion}\n`);
	if (opts.thin) h.update(`externals=${opts.thinExternals.join(",")}\n`);
	// entry is inside pkgDir, so it's covered by the tree walk; pin pkgDir identity.
	h.update(`pkgDir=${opts.pkgDir}\n`);

	const depDirs = collectWorkspaceDepDirs(opts.pkgDir, opts.workspaceRoot);
	const allDirs = [opts.pkgDir, ...depDirs].sort();
	for (const dir of allDirs) {
		const sources = collectPackageSources(dir).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		for (const [rel, content] of sources) {
			h.update(`${dir}:${rel}\n${content}\n`);
		}
	}
	return h.digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test scripts/lib/ext-hash.test.ts )`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Wire `build-extensions.ts` to the new module**

In `bun-apps/pi-agent/scripts/build-extensions.ts`:

1. Remove `statSync` and `createHash` from the top-of-file imports (they're only used by the code being extracted):

Change:
```ts
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
```
to:
```ts
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { hashExtInputs } from "./lib/ext-hash.ts";
```

2. Delete the old local `collectPackageSources` and `hashExtInputs` functions (the block from `function collectPackageSources(pkgDir: string): Array<[string, string]> {` through the closing `}` of `hashExtInputs` — currently lines 227-276).

3. Update both call sites. First (around the old line 588):

```ts
		const inputsHash = hashExtInputs({ entry, pkgDir, thin });
```
becomes:
```ts
		const inputsHash = hashExtInputs({
			entry,
			pkgDir,
			thin,
			workspaceRoot: join(REPO_ROOT, "bun-apps"),
			minifyCfg: MINIFY_CFG,
			thinExternals: THIN_EXTERNALS,
			bunVersion: Bun.version,
		});
```

Second (around the old line 616):
```ts
	writeFileSync(hashFile, hashExtInputs({ entry, pkgDir, thin }) + "\n");
```
becomes:
```ts
	writeFileSync(
		hashFile,
		hashExtInputs({
			entry,
			pkgDir,
			thin,
			workspaceRoot: join(REPO_ROOT, "bun-apps"),
			minifyCfg: MINIFY_CFG,
			thinExternals: THIN_EXTERNALS,
			bunVersion: Bun.version,
		}) + "\n",
	);
```

- [ ] **Step 6: Run the full pi-agent test suite + a real build**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS, 0 fail.

Run: `( cd bun-apps/pi-agent && bun scripts/build-extensions.ts )`
Expected: completes without error (a normal warm/cold build run — confirms `build-extensions.ts` still parses and runs end-to-end with the extracted module).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent/scripts/lib/ext-hash.ts bun-apps/pi-agent/scripts/lib/ext-hash.test.ts bun-apps/pi-agent/scripts/build-extensions.ts
git commit -m "fix(pi-agent): warm-deploy hash cache covers transitive @repo/* workspace deps"
```

---

### Task 4: `doctor.ts`'s `checkHostDeps` under-checks what extensions actually need

**Files:**
- Modify: `bun-apps/pi-agent/src/doctor.ts`
- Test: `bun-apps/pi-agent/src/doctor.test.ts`

**Bug:** `checkHostDeps()` only probes `typebox` and `@earendil-works/pi-coding-agent`. But `ensure-extension-deps.ts` (the patch this check exists to validate the effects of) also symlinks `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. A deploy missing only one of those two reports `host deps: pass` even though a dependent extension will fail to load at runtime.

**Fix:** Add the two missing package specs to the `need` list.

- [ ] **Step 1: Write the failing tests**

In `bun-apps/pi-agent/src/doctor.test.ts`, inside the existing `describe("checkHostDeps (mode-aware severity)", ...)` block, add:

```ts
	test("fails (portable) when @earendil-works/pi-agent-core is missing, even though typebox + pi-coding-agent resolve", () => {
		const depInstalled = (spec: string) => spec !== "@earendil-works/pi-agent-core";
		const r = checkHostDeps(ctx({ mode: "portable", depInstalled }));
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("@earendil-works/pi-agent-core");
	});

	test("warns (bundle) when @earendil-works/pi-ai is missing", () => {
		const depInstalled = (spec: string) => spec !== "@earendil-works/pi-ai";
		const r = checkHostDeps(ctx({ mode: "bundle", depInstalled }));
		expect(r.status).toBe("warn");
		expect(r.detail).toContain("@earendil-works/pi-ai");
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent && bun test src/doctor.test.ts )`
Expected: FAIL — both new tests get `status: "pass"` (the current `need` list never asks about the two missing specs, so `missing` is always empty for these fake `depInstalled` functions).

- [ ] **Step 3: Fix `checkHostDeps`**

In `bun-apps/pi-agent/src/doctor.ts`, change (around line 169):

```ts
	const need = ["typebox", "@earendil-works/pi-coding-agent"];
```

to:

```ts
	const need = [
		"typebox",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
	];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent && bun test src/doctor.test.ts )`
Expected: PASS, including the two new tests and every pre-existing `checkHostDeps`/`runChecks`/`planFixes` test (the `need` list only grew — no removed entries — so an existing `depInstalled: () => true` fixture still reports `pass`, and an existing `depInstalled: () => false` fixture still reports `fail`/`warn` since it was already false for everything).

- [ ] **Step 5: Run the full pi-agent test suite**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/src/doctor.ts bun-apps/pi-agent/src/doctor.test.ts
git commit -m "fix(pi-agent): doctor checkHostDeps also verifies pi-agent-core + pi-ai"
```

---

### Task 5: Fix unescaped JSON injection in `run-self-improve-loop.sh`

**Files:**
- Modify: `bun-apps/pi-agent/scripts/run-self-improve-loop.sh`
- Test: `bun-apps/pi-agent/src/__tests__/run-self-improve-loop.test.ts` (new)

**Bug:** `ARGS="$ARGS,\"prompts\":[\"$PROMPT\"]}"` (line 91) splices the raw `--prompt` value into a JSON string literal with no escaping. A prompt containing `"` or `\` produces malformed JSON, breaking the driver call at runtime instead of failing early with a clear error.

**Fix:** Use `jq -Rs` (already a dependency of this script — used at lines 101/103) to safely JSON-encode the prompt.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/src/__tests__/run-self-improve-loop.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "run-self-improve-loop.sh");

function dryRunArgs(promptText: string): unknown {
	const proc = spawnSync("bash", [SCRIPT, "--prompt", promptText, "--dry-run"], { encoding: "utf8" });
	expect(proc.status).toBe(0);
	const argsLine = proc.stdout.split("\n").find((l) => l.startsWith("   args:   "));
	expect(argsLine).toBeDefined();
	const jsonText = argsLine!.slice("   args:   ".length);
	return JSON.parse(jsonText);
}

describe("run-self-improve-loop.sh --dry-run", () => {
	test("a plain prompt round-trips", () => {
		const parsed = dryRunArgs("a red apple") as { prompts: string[] };
		expect(parsed.prompts).toEqual(["a red apple"]);
	});

	test("a prompt containing double quotes produces valid JSON", () => {
		const parsed = dryRunArgs('a "red" apple') as { prompts: string[] };
		expect(parsed.prompts).toEqual(['a "red" apple']);
	});

	test("a prompt containing a backslash produces valid JSON", () => {
		const parsed = dryRunArgs("a\\red apple") as { prompts: string[] };
		expect(parsed.prompts).toEqual(["a\\red apple"]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test src/__tests__/run-self-improve-loop.test.ts )`
Expected: FAIL on the double-quote and backslash cases — `JSON.parse` throws on the malformed args line.

- [ ] **Step 3: Fix the script**

In `bun-apps/pi-agent/scripts/run-self-improve-loop.sh`, change (line 89-91):

```bash
if [ -n "$PROMPT" ]; then
  # Holistic-score loop (non-pose).
  ARGS="$ARGS,\"prompts\":[\"$PROMPT\"]}"
```

to:

```bash
if [ -n "$PROMPT" ]; then
  # Holistic-score loop (non-pose). jq -Rs safely JSON-encodes PROMPT (quotes,
  # backslashes, newlines) instead of splicing it raw into the JSON string.
  PROMPT_JSON="$(printf '%s' "$PROMPT" | jq -Rs '.')"
  ARGS="$ARGS,\"prompts\":[$PROMPT_JSON]}"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/__tests__/run-self-improve-loop.test.ts )`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Run the full pi-agent test suite**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/scripts/run-self-improve-loop.sh bun-apps/pi-agent/src/__tests__/run-self-improve-loop.test.ts
git commit -m "fix(pi-agent): safely JSON-encode --prompt in run-self-improve-loop.sh"
```

---

### Task 6: Fix `ext-doctor.ts`'s broken `file://` URL decoding

**Files:**
- Modify: `bun-apps/pi-agent/src/ext-doctor.ts`
- Test: `bun-apps/pi-agent/src/ext-doctor.test.ts` (new)

**Bug:** `import.meta.url.replace("file://", "")` (line 17) doesn't decode percent-escapes. A repo checkout under a path with a space (e.g. `/Users/John Doe/proj/...`, common on macOS) leaves a literal `%20` in `PI_AGENT_DIR`/`MANIFEST_PATH`, so `readFileSync(MANIFEST_PATH)` throws ENOENT. `doctor.ts`'s `realContext()` does this correctly via `fileURLToPath` in the same package.

**Fix:** Extract the URL→path resolution into a small exported pure function (mirroring `doctor.ts`'s `realContext(moduleUrl, ...)` pattern) using `fileURLToPath`, so it's directly unit-testable with a synthetic percent-encoded URL.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/src/ext-doctor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolvePiAgentDir } from "./ext-doctor.ts";

describe("resolvePiAgentDir", () => {
	test("decodes percent-encoded characters (e.g. spaces) in the module URL", () => {
		const dir = resolvePiAgentDir("file:///Users/John%20Doe/proj/bun-apps/pi-agent/src/ext-doctor.ts");
		expect(dir).toBe("/Users/John Doe/proj/bun-apps/pi-agent");
		expect(dir).not.toContain("%20");
	});

	test("plain paths (no special characters) resolve unchanged", () => {
		const dir = resolvePiAgentDir("file:///Users/ziyu/proj/bun-apps/pi-agent/src/ext-doctor.ts");
		expect(dir).toBe("/Users/ziyu/proj/bun-apps/pi-agent");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test src/ext-doctor.test.ts )`
Expected: FAIL — `resolvePiAgentDir` is not exported yet.

- [ ] **Step 3: Fix `ext-doctor.ts`**

Change the imports and the `PI_AGENT_DIR` line (around lines 13-18) in `bun-apps/pi-agent/src/ext-doctor.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseManifestEntries } from "../run-dir/manifest-types.ts";

const PI_AGENT_DIR = resolve(dirname(import.meta.url.replace("file://", "")), "..");
const REPO_ROOT = resolve(PI_AGENT_DIR, "../..");
const MANIFEST_PATH = join(PI_AGENT_DIR, "run-dir", "manifest.json");
```

to:

```ts
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestEntries } from "../run-dir/manifest-types.ts";

/** Resolve pi-agent's package root from this module's URL. Uses fileURLToPath
 *  (not a naive `.replace("file://", "")`) so percent-encoded characters —
 *  e.g. a space in the checkout path — are decoded correctly. Exported for
 *  direct unit testing without needing a real special-character checkout. */
export function resolvePiAgentDir(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

const PI_AGENT_DIR = resolvePiAgentDir(import.meta.url);
const REPO_ROOT = resolve(PI_AGENT_DIR, "../..");
const MANIFEST_PATH = join(PI_AGENT_DIR, "run-dir", "manifest.json");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/ext-doctor.test.ts )`
Expected: PASS, both tests.

- [ ] **Step 5: Run the full pi-agent test suite**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/src/ext-doctor.ts bun-apps/pi-agent/src/ext-doctor.test.ts
git commit -m "fix(pi-agent): ext-doctor decodes percent-encoded file:// URLs correctly"
```

---

### Task 7: Fix `cli.ts`'s `--doctor` flag hijacking a literal prompt

**Files:**
- Create: `bun-apps/pi-agent/src/cli-argv.ts`
- Create: `bun-apps/pi-agent/src/cli-argv.test.ts`
- Modify: `bun-apps/pi-agent/src/cli.ts`

**Bug:** `argv[0] === "doctor" || argv.includes("--doctor")` (line 49) checks raw unparsed argv. `bun src/cli.ts -p "--doctor"` — a legitimate print-mode call whose prompt text is literally the string `--doctor` — is silently redirected into doctor mode instead of running the prompt. Repo-wide grep confirms `--doctor` (the flag form) is never actually used anywhere — every doc, script, and test invokes the documented `doctor` subcommand form (`bun src/cli.ts doctor [--json]` / `./run.sh doctor`) — so the `argv.includes("--doctor")` branch is both unused and the source of the bug.

**Fix:** Extract the intercept predicates into a small pure module (cli.ts itself has top-level side effects on import, so it can't be unit-tested directly) and drop the `--doctor`-anywhere-in-argv check, keeping only the documented `doctor` subcommand form.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/src/cli-argv.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isDoctorCommand, isExtDoctorCommand } from "./cli-argv.ts";

describe("isDoctorCommand", () => {
	test("true for the `doctor` subcommand", () => {
		expect(isDoctorCommand(["doctor"])).toBe(true);
		expect(isDoctorCommand(["doctor", "--json"])).toBe(true);
	});

	test("false when argv[0] is not doctor", () => {
		expect(isDoctorCommand(["-p", "hello"])).toBe(false);
	});

	test("a literal '--doctor' prompt passed to -p is NOT hijacked", () => {
		expect(isDoctorCommand(["-p", "--doctor"])).toBe(false);
	});
});

describe("isExtDoctorCommand", () => {
	test("true for `ext doctor`", () => {
		expect(isExtDoctorCommand(["ext", "doctor"])).toBe(true);
	});

	test("false otherwise", () => {
		expect(isExtDoctorCommand(["doctor"])).toBe(false);
		expect(isExtDoctorCommand(["ext"])).toBe(false);
		expect(isExtDoctorCommand(["ext", "something-else"])).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )`
Expected: FAIL — `./cli-argv.ts` does not exist yet.

- [ ] **Step 3: Create `cli-argv.ts`**

```ts
/**
 * cli-argv — pure argv-classification helpers for cli.ts's pre-patch
 * intercepts (doctor / ext doctor). Extracted so the decision logic is
 * testable without executing cli.ts's side effects (applyPatches, main()).
 */

/**
 * True iff argv should route into `doctor` mode. Only the documented `doctor`
 * subcommand (argv[0]) triggers it — matching a `--doctor` flag ANYWHERE in
 * argv would also match a literal prompt string passed to `-p`/`--print`
 * (e.g. `-p "--doctor"`), silently hijacking it instead of running the prompt.
 */
export function isDoctorCommand(argv: string[]): boolean {
	return argv[0] === "doctor";
}

/** True iff argv should route into `ext doctor` mode. */
export function isExtDoctorCommand(argv: string[]): boolean {
	return argv[0] === "ext" && argv[1] === "doctor";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Wire `cli.ts` to the new module**

In `bun-apps/pi-agent/src/cli.ts`, add the import (near the top, with the other imports):

```ts
import { main } from "@earendil-works/pi-coding-agent";
import { applyPatches } from "./patches/index.ts";
import { runDoctor } from "./doctor.ts";
import { isDoctorCommand, isExtDoctorCommand } from "./cli-argv.ts";
```

Change the two intercept conditions (around lines 49 and 65):

```ts
if (argv[0] === "doctor" || argv.includes("--doctor")) {
```
to:
```ts
if (isDoctorCommand(argv)) {
```

```ts
if (argv[0] === "ext" && argv[1] === "doctor") {
```
to:
```ts
if (isExtDoctorCommand(argv)) {
```

- [ ] **Step 6: Run the full pi-agent test suite**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS, 0 fail. (Every existing e2e test spawns `doctor`/`doctor --smoke`/`doctor --json` as argv[0] — the subcommand form — so none of them exercise the removed `--doctor`-anywhere branch.)

- [ ] **Step 7: Manual smoke check of the actual fix**

Run: `( cd bun-apps/pi-agent && bun src/cli.ts doctor --json | head -5 )`
Expected: prints a JSON doctor report (unaffected — subcommand form still works).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent/src/cli-argv.ts bun-apps/pi-agent/src/cli-argv.test.ts bun-apps/pi-agent/src/cli.ts
git commit -m "fix(pi-agent): stop --doctor from hijacking a literal -p prompt of that text"
```

---

### Task 8: Self-heal an interrupted `deploy.ts` atomic swap

**Files:**
- Create: `bun-apps/pi-agent/scripts/lib/deploy-swap.ts`
- Create: `bun-apps/pi-agent/scripts/lib/deploy-swap.test.ts`
- Modify: `bun-apps/pi-agent/scripts/deploy.ts`

**Bug:** The "atomic swap" at the end of `deploy.ts` (lines 372-380) is actually two separate `renameSync` calls (`FINAL_OUTDIR → FINAL_OUTDIR.prev`, then `OUTDIR → FINAL_OUTDIR`) with a window between them where `FINAL_OUTDIR` doesn't exist on disk. POSIX `rename()` can't atomically replace a non-empty directory in one syscall, so true single-step atomicity isn't achievable here without a larger symlink-indirection redesign (out of scope for this fix). A process kill landing exactly in that window leaves `FINAL_OUTDIR` missing indefinitely — nothing currently detects or repairs it.

**Fix:** Add a crash-safe self-heal check that runs before any build work starts: if `FINAL_OUTDIR` is missing but `FINAL_OUTDIR.prev` exists, restore it. This doesn't make the swap atomic, but it closes the "missing indefinitely" gap — the very next `deploy.ts` run repairs itself instead of requiring manual intervention.

- [ ] **Step 1: Write the failing tests**

Create `bun-apps/pi-agent/scripts/lib/deploy-swap.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healInterruptedSwap } from "./deploy-swap.ts";

describe("healInterruptedSwap", () => {
	test("restores FINAL_OUTDIR from .prev when a prior swap was interrupted", () => {
		const root = mkdtempSync(join(tmpdir(), "deploy-swap-test-"));
		try {
			const finalOutdir = join(root, "pi-agent-bundle");
			const prev = `${finalOutdir}.prev`;
			mkdirSync(prev, { recursive: true });
			writeFileSync(join(prev, "marker.txt"), "last-good-deploy");

			const healed = healInterruptedSwap(finalOutdir);

			expect(healed).toBe(true);
			expect(existsSync(finalOutdir)).toBe(true);
			expect(existsSync(join(finalOutdir, "marker.txt"))).toBe(true);
			expect(existsSync(prev)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("is a no-op when FINAL_OUTDIR already exists", () => {
		const root = mkdtempSync(join(tmpdir(), "deploy-swap-test-"));
		try {
			const finalOutdir = join(root, "pi-agent-bundle");
			mkdirSync(finalOutdir, { recursive: true });
			const healed = healInterruptedSwap(finalOutdir);
			expect(healed).toBe(false);
			expect(existsSync(finalOutdir)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("is a no-op when neither dir exists (first-ever deploy)", () => {
		const root = mkdtempSync(join(tmpdir(), "deploy-swap-test-"));
		try {
			const finalOutdir = join(root, "pi-agent-bundle");
			expect(healInterruptedSwap(finalOutdir)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent && bun test scripts/lib/deploy-swap.test.ts )`
Expected: FAIL — `./deploy-swap.ts` does not exist yet.

- [ ] **Step 3: Create `scripts/lib/deploy-swap.ts`**

```ts
/**
 * deploy-swap — crash-safe directory swap helpers for deploy.ts.
 * Extracted so the self-heal logic is unit-testable without running a full
 * deploy.
 */
import { existsSync, renameSync } from "node:fs";

/**
 * If a prior deploy.ts run crashed between the two renames of its atomic
 * swap (FINAL_OUTDIR -> FINAL_OUTDIR.prev, then OUTDIR -> FINAL_OUTDIR),
 * FINAL_OUTDIR is left missing while the last-good deploy sits at
 * FINAL_OUTDIR.prev. Detect that and restore it. No-op otherwise (including
 * the first-ever deploy, where neither path exists). Returns true if it healed.
 */
export function healInterruptedSwap(finalOutdir: string): boolean {
	const prev = `${finalOutdir}.prev`;
	if (!existsSync(finalOutdir) && existsSync(prev)) {
		renameSync(prev, finalOutdir);
		return true;
	}
	return false;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent && bun test scripts/lib/deploy-swap.test.ts )`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Wire `deploy.ts` to call it at startup**

In `bun-apps/pi-agent/scripts/deploy.ts`, add the import near the top (with the other local imports) and call it right after `OUTDIR` is defined (around line 131, before `const piAgentDir = ...`):

```ts
import { healInterruptedSwap } from "./lib/deploy-swap.ts";
```

```ts
const OUTDIR = `${FINAL_OUTDIR}.staging`;

// Crash recovery: a process kill between the two renameSync calls in the
// atomic-swap section below (on a PRIOR run) can leave FINAL_OUTDIR missing
// while the last-good deploy sits at `${FINAL_OUTDIR}.prev`. Self-heal here,
// before any build work starts, so a half-swapped deploy is never left
// missing indefinitely.
if (healInterruptedSwap(FINAL_OUTDIR)) {
	console.log(`\x1b[33m⚠\x1b[0m detected an interrupted deploy swap from a prior run — restored ${FINAL_OUTDIR} from ${FINAL_OUTDIR}.prev`);
}
```

- [ ] **Step 6: Run the full pi-agent test suite + a real deploy**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS, 0 fail.

Run: `( cd bun-apps/pi-agent && bun scripts/deploy.ts --writable )`
Expected: completes without error (confirms `deploy.ts` still parses and runs end-to-end with the new import/check).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent/scripts/lib/deploy-swap.ts bun-apps/pi-agent/scripts/lib/deploy-swap.test.ts bun-apps/pi-agent/scripts/deploy.ts
git commit -m "fix(pi-agent): deploy.ts self-heals an interrupted atomic swap on next run"
```

---

## Final verification (after all 8 tasks)

- [ ] Run the full tiered suite: `bash bun-apps/pi-agent/run-test.sh high`
Expected: all unit + patches + deploy e2e tests pass, 0 fail (matches the baseline in PRD.md's "Latest verified result" table, now with 8 additional regression tests).

- [ ] Run pi-agent-cli's suite (Task 1 touched it): `( cd bun-apps/pi-agent-cli && bun test )`
Expected: PASS, 0 fail.
