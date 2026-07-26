# Unify Subagent Model-Config — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify model-configuration so a tier AND a capability (e.g. `vision`) resolve through one config (`~/.pi/workflows/model-tiers.json`) + one resolver; file2md reads `capabilities.vision` instead of env vars.

**Architecture:** Extend the subagent package's model-tier config with a `capabilities` map + a pure `resolveModelRole` resolver in a new leaf module (no `agent.js` import, so lightweight consumers like file2md don't pull the WorkflowAgent machinery). spawnSubagent + the `subagent` tool gain a `capability` option; file2md's vision resolution routes through the resolver (env becomes a deprecated fallback).

**Tech Stack:** TypeScript, bun workspace, typebox (tool schemas), `@earendil-works/pi-coding-agent`, biome.

## Global Constraints

- **Extension-only** — no `pi-coding-agent` core edits (project convention: prefer extension over patching upstream).
- **Bun workspace** — `bun install` from `bun-apps/`, never repo root. Add deps with `bun add` inside `bun-apps/`.
- **Build** — `( cd bun-apps/<pkg> && bun run build )` (= `bunx tsc`); tests `( cd bun-apps/<pkg> && bun test )`.
- **Biome** — `( cd bun-apps/<pkg> && bun run check )` must exit 0.
- **No top-level `cd`** — use `( cd <dir> && … )` (no-cd-drift.sh).
- **Phase 1 keeps file2md's session-factory** — only the model-spec SOURCE changes (env → resolver). Runner migration is Phase 2 (separate plan).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `pi-agent-ext-subagent/src/model-role-config.ts` | **Create** | Leaf resolver: `ModelTierConfig` type (+`capabilities`), load/save, `resolveTierModel`, `resolveModelRole`, `sortedTierNames`. No `agent.js` import. |
| `pi-agent-ext-subagent/src/model-tier-config.ts` | **Modify** | Re-export from the leaf; keep `buildDefaultTierConfig` (needs `agent.js`). Existing importers unchanged. |
| `pi-agent-ext-subagent/src/spawn-subagent.ts` | **Modify** | Add `capability?` to `SpawnSubagentOptions`; resolve → effectiveModel (precedence model > capability > tier > mainModel); warn on unconfigured capability. |
| `pi-agent-ext-subagent/src/subagent-tool.ts` | **Modify** | Add `capability` to tool schema + render slot; thread through to run. |
| `pi-agent-ext-subagent/tests/model-role-config.test.ts` | **Create** | Resolver unit tests. |
| `pi-agent-ext-file2md/src/sessions.ts` | **Modify** | Add `resolveVisionLLM` helper (resolver → `resolveLLM` parser; env deprecation fallback). |
| `pi-agent-ext-file2md/src/vlm/classify-vlm.ts` | **Modify** | `resolveLLM({})` → `resolveVisionLLM()`. |
| `pi-agent-ext-file2md/src/pipeline.ts` | **Modify** | `resolveLLM({model,provider,thinking})` → `resolveVisionLLM({...})`. |
| `pi-agent-ext-file2md/src/vlm/ask.ts` | **Modify** | `resolveLLM({})` → `resolveVisionLLM()`. |
| `pi-agent-ext-file2md/package.json` | **Modify** | Add `@repo/pi-agent-ext-subagent: workspace:*` dep. |

---

### Task 1: Leaf resolver module (`model-role-config.ts`)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/model-role-config.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/model-tier-config.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/model-role-config.test.ts`

**Interfaces:**
- Produces: `ModelTierConfig` (now with optional `capabilities`), `loadModelTierConfig`, `saveModelTierConfig`, `resolveTierModel`, `resolveModelRole({tier?,capability?}, config) → string | undefined`, `sortedTierNames`, `getModelTierConfigPath`.

- [ ] **Step 1: Create the leaf module**

`bun-apps/pi-agent-ext-subagent/src/model-role-config.ts`:

```ts
/**
 * Model-role configuration — the LEAF resolver for tier + capability → model-spec.
 *
 * Split from model-tier-config.ts so lightweight consumers (file2md) can resolve
 * a model role WITHOUT pulling in agent.js (WorkflowAgent machinery). Import via
 * the src subpath: @repo/pi-agent-ext-subagent/src/model-role-config.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_TIERS_FILE } from "./config.js";
import { homeDir } from "./home.js";

/**
 * Model tier + capability configuration. `tiers` maps size names
 * (small/medium/big) → model-spec; `capabilities` maps capability names
 * (vision, …) → model-spec. Both are "provider/model-id[:thinking]" strings.
 */
export interface ModelTierConfig {
  tiers: Record<string, string>;
  /** Capability → model-spec (e.g. { vision: "lmstudio/qwen2-vl-7b" }). Optional. */
  capabilities?: Record<string, string>;
}

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homeDir(), MODEL_TIERS_FILE);
}

/** Load the config from disk. Returns null if absent or unparseable. */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.tiers || typeof parsed.tiers !== "object") return null;
    for (const val of Object.values(parsed.tiers)) {
      if (typeof val !== "string") return null;
    }
    if (parsed.capabilities != null) {
      if (typeof parsed.capabilities !== "object") return null;
      for (const val of Object.values(parsed.capabilities)) {
        if (typeof val !== "string") return null;
      }
    }
    return parsed as ModelTierConfig;
  } catch {
    return null;
  }
}

/** Save a config to disk, creating parent dirs. */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

/** Resolve a tier name to its model-spec, or undefined if not configured. */
export function resolveTierModel(tier: string, config: ModelTierConfig): string | undefined {
  return config.tiers[tier];
}

/**
 * Resolve a model ROLE (a tier OR a capability) to its configured model-spec
 * string ("provider/model-id[:thinking]"), or undefined if not configured.
 * If both tier and capability are given, capability wins (callers pass one).
 */
export function resolveModelRole(
  opts: { tier?: string; capability?: string },
  config: ModelTierConfig | null,
): string | undefined {
  if (!config) return undefined;
  if (opts.capability) return config.capabilities?.[opts.capability];
  if (opts.tier) return config.tiers[opts.tier];
  return undefined;
}

/** Tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
```

- [ ] **Step 2: Make `model-tier-config.ts` re-export the leaf**

Replace the entire body of `bun-apps/pi-agent-ext-subagent/src/model-tier-config.ts` with:

```ts
/**
 * Model tier configuration — re-exports the leaf resolver (model-role-config.ts)
 * for back-compat, and keeps buildDefaultTierConfig (which needs agent.js's
 * listAvailableModelSpecs). Lightweight consumers import model-role-config.ts
 * directly to avoid pulling agent.js.
 */
import { listAvailableModelSpecs } from "./agent.js";
import type { ModelTierConfig } from "./model-role-config.js";

export {
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveModelRole,
  resolveTierModel,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-role-config.js";
export type { ModelTierConfig } from "./model-role-config.js";

/**
 * Build a default tier config where every tier points at a single model —
 * the user's currently active Pi model when known, else the first available.
 */
export async function buildDefaultTierConfig(currentModelSpec?: string): Promise<ModelTierConfig> {
  const model = currentModelSpec ?? (await listAvailableModelSpecs())[0] ?? "";
  return { tiers: { small: model, medium: model, big: model } };
}
```

- [ ] **Step 3: Write the failing resolver tests**

`bun-apps/pi-agent-ext-subagent/tests/model-role-config.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  loadModelTierConfig,
  resolveModelRole,
  resolveTierModel,
  saveModelTierConfig,
  type ModelTierConfig,
} from "../src/model-role-config.js";

function tmpConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "model-role-"));
  const p = join(dir, "model-tiers.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test("loadModelTierConfig loads tiers + capabilities", () => {
  const p = tmpConfig({ tiers: { small: "openai/gpt-4.1-mini" }, capabilities: { vision: "lmstudio/qwen-vl" } });
  const cfg = loadModelTierConfig(p);
  expect(cfg?.tiers.small).toBe("openai/gpt-4.1-mini");
  expect(cfg?.capabilities?.vision).toBe("lmstudio/qwen-vl");
});

test("loadModelTierConfig accepts legacy tiers-only file (backward compat)", () => {
  const p = tmpConfig({ tiers: { small: "openai/x", medium: "openai/y" } });
  const cfg = loadModelTierConfig(p);
  expect(cfg?.capabilities).toBeUndefined();
  expect(resolveTierModel("medium", cfg!)).toBe("openai/y");
});

test("loadModelTierConfig rejects non-string capability values", () => {
  const p = tmpConfig({ tiers: { small: "openai/x" }, capabilities: { vision: 123 } });
  expect(loadModelTierConfig(p)).toBeNull();
});

test("resolveModelRole resolves a capability", () => {
  const cfg: ModelTierConfig = { tiers: { small: "a" }, capabilities: { vision: "lmstudio/v" } };
  expect(resolveModelRole({ capability: "vision" }, cfg)).toBe("lmstudio/v");
});

test("resolveModelRole resolves a tier", () => {
  const cfg: ModelTierConfig = { tiers: { small: "a" } };
  expect(resolveModelRole({ tier: "small" }, cfg)).toBe("a");
});

test("resolveModelRole returns undefined for unconfigured capability", () => {
  const cfg: ModelTierConfig = { tiers: { small: "a" } };
  expect(resolveModelRole({ capability: "vision" }, cfg)).toBeUndefined();
});

test("resolveModelRole returns undefined when config is null", () => {
  expect(resolveModelRole({ capability: "vision" }, null)).toBeUndefined();
});

test("saveModelTierConfig round-trips capabilities", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-role-"));
  const p = join(dir, "model-tiers.json");
  saveModelTierConfig({ tiers: { small: "a" }, capabilities: { vision: "v" } }, p);
  const cfg = loadModelTierConfig(p);
  expect(cfg?.capabilities?.vision).toBe("v");
});
```

- [ ] **Step 4: Run tests — expect PASS (leaf is implemented)**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/model-role-config.test.ts )`
Expected: 8 pass.

- [ ] **Step 5: Verify existing model-tier-config tests still pass (re-export didn't break them)**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/model-tier-config.test.ts )`
Expected: existing tests PASS (importing from model-tier-config.ts still works via re-export).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/model-role-config.ts \
        bun-apps/pi-agent-ext-subagent/src/model-tier-config.ts \
        bun-apps/pi-agent-ext-subagent/tests/model-role-config.test.ts
git commit -m "feat(subagent): add model-role resolver + capabilities config (Phase 1)"
```

---

### Task 2: spawnSubagent gains `capability`

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts`
- Test: extend `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts`

**Interfaces:**
- Consumes: `loadModelTierConfig`, `resolveModelRole` (Task 1).
- Produces: `SpawnSubagentOptions.capability?: string`.

- [ ] **Step 1: Add `capability` to `SpawnSubagentOptions`**

In `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts`, add this field to the `SpawnSubagentOptions` interface, immediately after the `tier?: string;` field:

```ts
  /**
   * Model capability for the child (e.g. "vision"), resolved from the
   * capabilities map in model-tiers config. Precedence: model > capability >
   * tier > mainModel. An unconfigured capability warns and falls back.
   */
  capability?: string;
```

- [ ] **Step 2: Resolve capability into effectiveModel + warn**

In the same file, add the import at the top (with the other `./` imports):

```ts
import { loadModelTierConfig, resolveModelRole } from "./model-role-config.js";
```

Replace the line:

```ts
  const effectiveModel = opts.model ?? (opts.tier ? undefined : opts.mainModel);
```

with:

```ts
  // Resolve a capability (e.g. "vision") to a model-spec. Precedence:
  // explicit model > capability > tier > mainModel. An unconfigured capability
  // warns and falls through to tier/mainModel (mirrors agent.ts unknown-tier).
  const capabilitySpec = opts.capability
    ? resolveModelRole({ capability: opts.capability }, loadModelTierConfig())
    : undefined;
  if (opts.capability && !capabilitySpec) {
    const cfg = loadModelTierConfig();
    const known = cfg?.capabilities ? Object.keys(cfg.capabilities).join(", ") || "(none)" : "(none)";
    console.error(
      `[subagent] unknown capability "${opts.capability}" — falling back. Configured capabilities: ${known}. Manage them via /workflows-models.`,
    );
  }
  const effectiveModel = opts.model ?? capabilitySpec ?? (opts.tier ? undefined : opts.mainModel);
```

- [ ] **Step 3: Write the failing test (capability resolves; precedence)**

Append to `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts`:

```ts
import { saveModelTierConfig } from "../src/model-role-config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("capability resolves to the configured model-spec and is passed to the runner", async () => {
  // Point MODEL_TIERS at a temp config with capabilities.vision set.
  const dir = mkdtempSync(join(tmpdir(), "spawn-cap-"));
  const homeBackup = process.env.HOME;
  process.env.HOME = dir;
  saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lmstudio/qwen-vl" } });
  try {
    let receivedModel: string | undefined;
    await spawnSubagent({
      task: "describe the image",
      capability: "vision",
      agent: { run: async (_t, o) => { receivedModel = o?.model; return "ok"; } } as any,
    });
    expect(receivedModel).toBe("lmstudio/qwen-vl");
  } finally {
    process.env.HOME = homeBackup;
  }
});

test("explicit model wins over capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawn-cap-"));
  const homeBackup = process.env.HOME;
  process.env.HOME = dir;
  saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lmstudio/qwen-vl" } });
  try {
    let receivedModel: string | undefined;
    await spawnSubagent({
      task: "t",
      model: "openai/explicit",
      capability: "vision",
      agent: { run: async (_t, o) => { receivedModel = o?.model; return "ok"; } } as any,
    });
    expect(receivedModel).toBe("openai/explicit");
  } finally {
    process.env.HOME = homeBackup;
  }
});
```

> **Note:** the existing `spawnSubagent` test file already constructs `agent: { run: ... }` mocks — follow that pattern. If the file sets `HOME` differently, adapt; the key assertion is `receivedModel`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/spawn-subagent.test.ts )`
Expected: all PASS (including the 2 new).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts \
        bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts
git commit -m "feat(subagent): spawnSubagent gains capability option (Phase 1)"
```

---

### Task 3: `subagent` tool gains `capability` param

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`
- Test: extend `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts`

**Interfaces:**
- Consumes: `capability` threading into the run call (the tool's run handler passes args to `WorkflowAgent`/`spawnSubagent`-equivalent alongside `tier`).
- Produces: `capability` tool param (LLM-facing) + render slot.

- [ ] **Step 1: Add `capability` to the tool param schema**

In `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`, immediately after the `tier: Type.Optional( … )` block (around line 91–95), add:

```ts
  capability: Type.Optional(
    Type.String({
      description:
        "Model capability for the child (e.g. 'vision'), resolved from the capabilities map in the model-tiers config. Omit to inherit the session's current model. Precedence: model > capability > tier.",
    }),
  ),
```

- [ ] **Step 2: Thread `capability` through to the run call**

Locate where the tool's run handler passes `tier` to the runner (grep `tier:` in this file). Add `capability: args.capability` alongside the `tier` pass-through so the runner receives it. (The runner-side `SpawnSubagentOptions.capability` from Task 2 consumes it.)

- [ ] **Step 3: Update the render slot to show capability**

In `renderSubagentCall` (around line 283–289), update the `args` type and the `slot` precedence:

```ts
  args: { agent?: string; model?: string; capability?: string; tier?: string; task: string; resolvedModel?: string },
```

```ts
  // Requested-model slot: explicit model, else capability, else tier, else "default".
  const slot = args.model ?? (args.capability ? `capability:${args.capability}` : args.tier ? `tier:${args.tier}` : "default");
```

- [ ] **Step 4: Write the failing test (param present + slot renders)**

Append to `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts`:

```ts
test("subagent tool schema declares a capability param", () => {
  // subagentToolFactory / the exported schema — adapt to the file's export name.
  const params = subagentTool.inputSchema.properties; // adjust accessor to match the export
  expect(params.capability).toBeDefined();
  expect(params.capability.type).toBe("string");
});

test("renderSubagentCall shows capability:<name> slot", () => {
  const out = renderSubagentCall({ capability: "vision", task: "x" } as any, stubTheme);
  expect(out).toContain("capability:vision");
});
```

> **Note:** adapt `subagentTool.inputSchema.properties`, `renderSubagentCall`, and `stubTheme` to the actual exports/fixtures the test file already uses (grep the file for `renderSubagentCall` + the tool factory name).

- [ ] **Step 5: Run tests — expect PASS**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts
git commit -m "feat(subagent): subagent tool gains capability param (Phase 1)"
```

---

### Task 4: file2md reads `capabilities.vision`

**Files:**
- Modify: `bun-apps/pi-agent-ext-file2md/package.json`
- Modify: `bun-apps/pi-agent-ext-file2md/src/sessions.ts`
- Modify: `bun-apps/pi-agent-ext-file2md/src/vlm/classify-vlm.ts:55`
- Modify: `bun-apps/pi-agent-ext-file2md/src/pipeline.ts:218`
- Modify: `bun-apps/pi-agent-ext-file2md/src/vlm/ask.ts`
- Test: `bun-apps/pi-agent-ext-file2md/__tests__/resolve-vision-llm.test.ts` (create)

**Interfaces:**
- Consumes: `loadModelTierConfig`, `resolveModelRole` from `@repo/pi-agent-ext-subagent/src/model-role-config.ts` (Task 1).
- Produces: `resolveVisionLLM(opts?) → ResolvedLLM` in `sessions.ts`.

- [ ] **Step 1: Add the subagent workspace dep**

Run: `( cd bun-apps/pi-agent-ext-file2md && bun add @repo/pi-agent-ext-subagent@workspace:* )`
Expected: `package.json` gains `"@repo/pi-agent-ext-subagent": "workspace:*"` under `dependencies`; `bun-apps/bun.lock` updated.

- [ ] **Step 2: Add `resolveVisionLLM` to `sessions.ts`**

In `bun-apps/pi-agent-ext-file2md/src/sessions.ts`, add the import + helper (after the existing `resolveLLM`):

```ts
import { loadModelTierConfig, resolveModelRole } from "@repo/pi-agent-ext-subagent/src/model-role-config.ts";
```

```ts
/**
 * Resolve the vision LLM from the unified model-tiers config (capabilities.vision),
 * falling back to PI_MODEL/PI_PROVIDER env (deprecated) when the capability is not
 * configured. Explicit opts (model/provider/thinking) always win. Uses resolveLLM
 * as the spec-string parser, so "provider/modelId[:thinking]" shorthand still works.
 */
export function resolveVisionLLM(opts: { model?: string; provider?: string; thinking?: string } = {}): ResolvedLLM {
  if (opts.model) return resolveLLM(opts);
  const spec = resolveModelRole({ capability: "vision" }, loadModelTierConfig());
  if (spec) return resolveLLM({ ...opts, model: spec });
  console.error(
    "[file2md] capabilities.vision not set in model-tiers config — falling back to PI_MODEL/PI_PROVIDER env (deprecated). Set capabilities.vision via /workflows-models.",
  );
  return resolveLLM(opts);
}
```

- [ ] **Step 3: Rewire the three call sites**

- `bun-apps/pi-agent-ext-file2md/src/vlm/classify-vlm.ts:55` — replace `const llm = llmOverride ?? resolveLLM({});` with:

```ts
  const llm = llmOverride ?? resolveVisionLLM();
```

(add `resolveVisionLLM` to the existing `import { … } from "../sessions.ts"`).

- `bun-apps/pi-agent-ext-file2md/src/pipeline.ts:218` — replace:

```ts
  const llm: ResolvedLLM = resolveLLM({
    model: opts.model,
    provider: opts.provider,
    thinking: opts.thinking,
  });
```

with:

```ts
  const llm: ResolvedLLM = resolveVisionLLM({
    model: opts.model,
    provider: opts.provider,
    thinking: opts.thinking,
  });
```

(update the `import { resolveLLM, … }` to `resolveVisionLLM`).

- `bun-apps/pi-agent-ext-file2md/src/vlm/ask.ts` — replace the `resolveLLM({})` default call (around line 50) with `resolveVisionLLM()` (update the import).

- [ ] **Step 4: Write the failing test**

`bun-apps/pi-agent-ext-file2md/__tests__/resolve-vision-llm.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveModelTierConfig } from "@repo/pi-agent-ext-subagent/src/model-role-config.ts";
import { expect, test } from "bun:test";
import { resolveVisionLLM } from "../src/sessions.ts";

test("resolveVisionLLM reads capabilities.vision", () => {
  const dir = mkdtempSync(join(tmpdir(), "f2m-vis-"));
  const homeBackup = process.env.HOME;
  process.env.HOME = dir;
  saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lmstudio/qwen-vl:medium" } });
  try {
    const llm = resolveVisionLLM();
    expect(llm.provider).toBe("lm-studio");
    expect(llm.modelId).toBe("qwen-vl");
    expect(llm.thinkingLevel).toBe("medium");
  } finally {
    process.env.HOME = homeBackup;
  }
});

test("resolveVisionLLM: explicit model wins over capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "f2m-vis-"));
  const homeBackup = process.env.HOME;
  process.env.HOME = dir;
  saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lmstudio/qwen-vl" } });
  try {
    const llm = resolveVisionLLM({ model: "openai/explicit" });
    expect(llm.provider).toBe("openai");
    expect(llm.modelId).toBe("explicit");
  } finally {
    process.env.HOME = homeBackup;
  }
});
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `( cd bun-apps/pi-agent-ext-file2md && bun test __tests__/resolve-vision-llm.test.ts )`
Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-file2md/package.json bun-apps/bun.lock \
        bun-apps/pi-agent-ext-file2md/src/sessions.ts \
        bun-apps/pi-agent-ext-file2md/src/vlm/classify-vlm.ts \
        bun-apps/pi-agent-ext-file2md/src/pipeline.ts \
        bun-apps/pi-agent-ext-file2md/src/vlm/ask.ts \
        bun-apps/pi-agent-ext-file2md/__tests__/resolve-vision-llm.test.ts
git commit -m "feat(file2md): resolve vision model from capabilities.vision (Phase 1)"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify (if it documents the config shape): `bun-apps/pi-agent-ext-workflow/README.md` or the `/workflows-models` command help — note `capabilities` is now supported.

- [ ] **Step 1: Document the `capabilities` field**

Find where `model-tiers.json` shape is documented (grep `tiers` in workflow README / the `/workflows-models` command source). Add a one-line note that `capabilities` (e.g. `vision`) is an optional map alongside `tiers`. If no such doc surface exists, skip.

- [ ] **Step 2: Schema-cost canary (the new tool param is measured)**

Run: `( cd bun-apps/pi-agent-cli && bun run src/commands/schema-cost.ts )` (or the repo's schema-cost invocation). Confirm the `subagent` tool is measured + the run does not regress unexpectedly.

- [ ] **Step 3: Build + test both packages**

Run:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build && bun test )
( cd bun-apps/pi-agent-ext-file2md && bun run check && bun run build && bun test )
```
Expected: both PASS, 0 fail, biome exit 0, tsc clean.

- [ ] **Step 4: Commit**

```bash
git add <docs files touched>
git commit -m "docs: note capabilities map in model-tiers config (Phase 1)"
```

---

## Self-Review (completed)

- **Spec coverage:** ① config schema → Task 1 (capabilities field + load validation). ② resolver → Task 1 (`resolveModelRole`). ③ consumers → Task 2 (spawnSubagent), Task 3 (tool), Task 4 (file2md). ④ backward-compat → Task 4 (env deprecation fallback) + Task 1 (legacy tiers-only loads). Phase 2 items (spawnSubagent `modelRuntime` seam, file2md session-factory removal) are correctly ABSENT — they belong to the Phase 2 plan.
- **Placeholder scan:** no TBD/TODO. Two test snippets flag "adapt the accessor/export to the file" (Tasks 2–3) — these are locate-hints for symbols whose exact export name varies, with the assertion logic fully specified (not placeholders).
- **Type consistency:** `resolveModelRole({tier?,capability?}, config) → string | undefined` used identically in Tasks 1/2/4. `ModelTierConfig` shape (`tiers` + optional `capabilities`) consistent across tasks. `resolveVisionLLM` signature consistent between definition (Task 4) + call sites.

## Open (Phase 2 — separate plan, after this lands)

- spawnSubagent `modelRuntime?`/`services?` injection seam (de-risk by reading `agent.ts` session construction).
- file2md full migration to `spawnSubagent` (delete `session-factory.ts` + `resolveLLM`); vision runs observable in `/subagents`.
- Remove the env fallback (breaking) once `capabilities.vision` is the documented path.
