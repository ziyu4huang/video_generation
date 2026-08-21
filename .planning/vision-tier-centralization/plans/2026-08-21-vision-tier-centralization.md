# Vision-Tier Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensions never hardcode LLM provider/model ids — every vision/LLM call resolves through the central tier config (`~/.pi/workflows/model-tiers.json`), which now supports vision tiers (`vision-large/medium/small`) in addition to `vision`.

**Architecture:** The single resolution leaf stays `resolveModelRole()` in `s2-agent-core-runtime/src/model-role-config.ts`. We add dashed-capability fallback (`vision-large` → `vision`) so existing single-slot configs keep working, seed tiered vision keys in the host default + presets, then rewire the four bypass packages (movie-director, flux2, file2md `vision_ask`, knowledge-card) to consult it. Terminal hardcoded fallbacks are removed where the contract allows a throw, kept (documented, last-resort) only where an existing error-tolerance contract forbids throwing (knowledge-card `chatJson`).

**Tech Stack:** Bun workspace (bun-apps/), TypeScript, bun test. Packages touched: `s2-agent-core-runtime`, `s2-agent`, `s2-agent-ext-subagent`, `s2-agent-ext-file2md`, `s2-agent-ext-flux2`, `s2-agent-ext-movie-director`, `s2-agent-ext-knowledge-card`.

**Spec:** This plan (audit findings 2026-08-21, session on origin/main b99e4ec4b). Out of scope: web-access cloud search-API model ids (separate follow-up — those target cloud search APIs, not the local tier system); movie-director TTS defaults; knowledge-card `semantic.ts` embedding endpoint (embeddings ≠ LLM tiers).

## Global Constraints

- Bun workspace: `bun install` only from `bun-apps/`; deps via `bun add` inside `bun-apps/<pkg>` or a manual `package.json` edit + `bun install` from `bun-apps/`.
- Never top-level `cd` — use `( cd <dir> && ... )` or `bun run --cwd`.
- Run each package's canonical gate: `s2-agent-core-runtime` / `s2-agent-ext-file2md` / `s2-agent-ext-flux2` / `s2-agent-ext-knowledge-card` / `s2-agent` → `bun test` (plus `bun run check` where that is tsc); `s2-agent-ext-movie-director` → `bun test`. Cross-package typecheck via s2-agent's `bun run typecheck` red-lights the whole repo — run it before the final commit.
- Written output (code comments, commits, docs) in English.
- Model-spec format everywhere: `"provider/model-id[:thinking]"`. LM Studio model ids keep their own inner slash (`lm-studio/google/gemma-4-12b` → provider `lm-studio`, model `google/gemma-4-12b`).
- Tier vocabulary: text tiers are `small` / `medium` / `big` (existing config keys — NOT renamed); vision tiers use capability keys `vision-large` / `vision-medium` / `vision-small`, falling back to `vision`.

---

### Task 1: core-runtime — dashed-capability fallback in `resolveModelRole`

**Files:**
- Modify: `bun-apps/s2-agent-core-runtime/src/model-role-config.ts:78-86`
- Test: `bun-apps/s2-agent-core-runtime/tests/model-role-config.test.ts` (append)

**Interfaces:**
- Produces (unchanged signature, new behavior): `resolveModelRole({ capability?: string; tier?: string }, config | null): string | undefined` — for `capability: "vision-large"` returns `capabilities["vision-large"]` if set, else `capabilities["vision"]`, else undefined. Same for `-medium`/`-small`. Exact keys still win over fallback.

- [ ] **Step 1: Write the failing tests**

Append to `tests/model-role-config.test.ts`:

```ts
describe("resolveModelRole capability fallback", () => {
  const cfg = {
    tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
    capabilities: { vision: "lm-studio/google/gemma-4-12b" },
  };
  const tiered = {
    ...cfg,
    capabilities: {
      vision: "lm-studio/google/gemma-4-12b",
      "vision-large": "lm-studio/google/gemma-4-27b",
    },
  };

  test("vision-large falls back to vision when tiered key absent", () => {
    expect(resolveModelRole({ capability: "vision-large" }, cfg)).toBe("lm-studio/google/gemma-4-12b");
  });

  test("vision-large exact key wins over vision fallback", () => {
    expect(resolveModelRole({ capability: "vision-large" }, tiered)).toBe("lm-studio/google/gemma-4-27b");
  });

  test("vision-medium still falls back when only vision-large is tiered", () => {
    expect(resolveModelRole({ capability: "vision-medium" }, tiered)).toBe("lm-studio/google/gemma-4-12b");
  });

  test("unknown capability without dash returns undefined", () => {
    expect(resolveModelRole({ capability: "vision" }, cfg)).toBe("lm-studio/google/gemma-4-12b");
    expect(resolveModelRole({ capability: "audio" }, cfg)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `( cd bun-apps/s2-agent-core-runtime && bun test tests/model-role-config.test.ts )`
Expected: FAIL — `vision-large` resolves to `undefined` (no fallback yet).

- [ ] **Step 3: Implement the fallback**

Replace the body of `resolveModelRole` in `src/model-role-config.ts`:

```ts
export function resolveModelRole(
  opts: { tier?: string; capability?: string },
  config: ModelTierConfig | null,
): string | undefined {
  if (!config) return undefined;
  if (opts.capability) {
    const direct = config.capabilities?.[opts.capability];
    if (direct) return direct;
    // Tiered-capability fallback: "vision-large" → "vision" when the tiered
    // key isn't configured separately. Single-slot configs keep working for
    // every tier; an exact tiered key always wins.
    const dash = opts.capability.lastIndexOf("-");
    if (dash > 0) return config.capabilities?.[opts.capability.slice(0, dash)];
    return undefined;
  }
  if (opts.tier) return config.tiers[opts.tier];
  return undefined;
}
```

Also extend the doc comment on `ModelTierConfig.capabilities` (line ~21): change `(e.g. { vision: "lmstudio/google/gemma-4-12b" })` to mention tiered keys: `Capability → model-spec. Supports tiered keys ("vision-large"/"vision-medium"/"vision-small") that fall back to the un-suffixed capability ("vision") when not set separately.`

- [ ] **Step 4: Run to verify pass**

Run: `( cd bun-apps/s2-agent-core-runtime && bun test tests/model-role-config.test.ts && bun run check )`
Expected: PASS (check is tsc for this package — verify `package.json` scripts first; if `check` is not tsc here, run the tsc-bearing script).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-core-runtime/src/model-role-config.ts bun-apps/s2-agent-core-runtime/tests/model-role-config.test.ts
git commit -m "feat(core-runtime): resolveModelRole dashed-capability fallback (vision-large → vision)"
```

---

### Task 2: host seed + presets — tiered vision keys

**Files:**
- Modify: `bun-apps/s2-agent/src/model-tiers-default.ts:13-20`
- Modify: `bun-apps/s2-agent-ext-subagent/src/presets.ts:36-72`
- Test: `bun-apps/s2-agent/src/models-store-default.test.ts` or the test that pins `buildModelTiersJson` output (find it: `grep -rn buildModelTiersJson bun-apps/s2-agent/src --include='*.test.ts'`); `bun-apps/s2-agent-ext-subagent/tests/models-preset-command.test.ts`

**Interfaces:**
- Consumes: Task 1 fallback semantics.
- Produces: `DEFAULT_MODEL_TIER_CONFIG.capabilities` widened from `{ vision: string }` to `Record<string, string>` containing `vision`, `vision-large`, `vision-medium`, `vision-small`. Preset configs get the same four keys. Downstream readers are generic (`Record<string, string>`) — no consumer changes needed.

- [ ] **Step 1: Update the pinned-output tests first**

In the s2-agent test pinning `buildModelTiersJson` / `DEFAULT_MODEL_TIER_CONFIG`, update the expected capabilities object to:

```ts
capabilities: {
  vision: "lm-studio/google/gemma-4-12b",
  "vision-large": "lm-studio/google/gemma-4-12b",
  "vision-medium": "lm-studio/google/gemma-4-12b",
  "vision-small": "lm-studio/google/gemma-4-12b",
},
```

In `bun-apps/s2-agent-ext-subagent/tests/models-preset-command.test.ts`, update every preset-config expectation to include the same four capability keys (values: all `"lm-studio/google/gemma-4-12b"` — every current preset uses gemma for vision).

- [ ] **Step 2: Run to verify failure**

Run: `( cd bun-apps/s2-agent && bun test )` and `( cd bun-apps/s2-agent-ext-subagent && bun test tests/models-preset-command.test.ts )`
Expected: FAIL — expected objects now include tiered keys the source doesn't produce yet.

- [ ] **Step 3: Implement**

`bun-apps/s2-agent/src/model-tiers-default.ts` — widen the interface and extend the constant:

```ts
export interface ModelTierConfig {
	tiers: { small: string; medium: string; big: string };
	capabilities: Record<string, string>;
}

export const DEFAULT_MODEL_TIER_CONFIG: ModelTierConfig = {
	tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
	capabilities: {
		vision: "lm-studio/google/gemma-4-12b",
		"vision-large": "lm-studio/google/gemma-4-12b",
		"vision-medium": "lm-studio/google/gemma-4-12b",
		"vision-small": "lm-studio/google/gemma-4-12b",
	},
};
```

In `bun-apps/s2-agent-ext-subagent/src/presets.ts`, extend every preset's `capabilities` to the same four-key shape (all values `"lm-studio/google/gemma-4-12b"`). Update each preset's `summary` string to mention `vision tiers: large/medium/small`.

- [ ] **Step 4: Run to verify pass**

Run: `( cd bun-apps/s2-agent && bun test )` and `( cd bun-apps/s2-agent-ext-subagent && bun test )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent/src/model-tiers-default.ts bun-apps/s2-agent/src/*.test.ts bun-apps/s2-agent-ext-subagent/src/presets.ts bun-apps/s2-agent-ext-subagent/tests/models-preset-command.test.ts
git commit -m "feat(s2-agent,subagent): seed tiered vision capability keys (vision-large/medium/small)"
```

---

### Task 3: file2md — `resolveVisionLLM` tier opt + `vision_ask` fix

**Files:**
- Modify: `bun-apps/s2-agent-ext-file2md/src/sessions.ts:69-86`
- Modify: `bun-apps/s2-agent-ext-file2md/extensions/file2md.ts:290-299`
- Test: `bun-apps/s2-agent-ext-file2md/__tests__/resolve-vision-llm.test.ts` (append; follow its existing config-injection/mocking pattern — note repo memory: mock.module flips need lockstep)

**Interfaces:**
- Consumes: Task 1 fallback.
- Produces: `resolveVisionLLM(opts?: { model?: string; provider?: string; thinking?: string; tier?: "large" | "medium" | "small" }): ResolvedLLM` — `tier` maps to capability `vision-${tier}` (falls back to `vision` via Task 1). Callers passing no opts are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/resolve-vision-llm.test.ts` (mirror the file's existing tier-config stubbing helper):

```ts
describe("resolveVisionLLM tier opt", () => {
  test("tier: 'large' resolves capabilities.vision-large", () => {
    stubTierConfig({
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b", "vision-large": "lm-studio/google/gemma-4-27b" },
    });
    const llm = resolveVisionLLM({ tier: "large" });
    expect(llm.provider).toBe("lm-studio");
    expect(llm.modelId).toBe("google/gemma-4-27b");
  });

  test("tier falls back to capabilities.vision when tiered key absent", () => {
    stubTierConfig({
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    });
    const llm = resolveVisionLLM({ tier: "small" });
    expect(llm.modelId).toBe("google/gemma-4-12b");
  });
});
```

(Adapt `stubTierConfig` to whatever the existing tests in this file use — do not invent a second stubbing mechanism.)

Also add one test that the `vision_ask` tool path uses the vision resolver — follow the existing `vlm-ask-tool.test.ts` pattern, asserting that with no `params.model` and a tier config present, the resolved model comes from `capabilities.vision` rather than throwing the PI_MODEL error.

- [ ] **Step 2: Run to verify failure**

Run: `( cd bun-apps/s2-agent-ext-file2md && bun test __tests__/resolve-vision-llm.test.ts )`
Expected: FAIL — `resolveVisionLLM` ignores `opts.tier` (first test returns gemma-4-12b, not 4-27b).

- [ ] **Step 3: Implement**

In `src/sessions.ts`, change the signature and the capability lookup:

```ts
export function resolveVisionLLM(
  opts: { model?: string; provider?: string; thinking?: string; tier?: "large" | "medium" | "small" } = {},
): ResolvedLLM {
  if (opts.model) {
    logModelDecision("file2md-vision", { branch: "explicit-model", spec: opts.model });
    return resolveLLM(opts);
  }
  const capability = opts.tier ? `vision-${opts.tier}` : "vision";
  const spec = resolveModelRole({ capability }, loadModelTierConfig());
  if (spec) {
    logModelDecision("file2md-vision", { branch: `capabilities.${capability}`, spec });
    return resolveLLM({ ...opts, model: spec });
  }
  logModelDecision("file2md-vision", { branch: "env/throw", spec: process.env.PI_MODEL });
  return resolveLLM(opts);
}
```

In `extensions/file2md.ts` (~line 290), change the `vision_ask` execute body from `resolveLLM` to `resolveVisionLLM`:

```ts
      const { resolveVisionLLM } = await import("../src/sessions.ts");
      // ...
      const llm = resolveVisionLLM({
        model: params.model,
        provider: params.provider,
        thinking: params.thinking,
      });
```

(Keep the dynamic-import style already used there; only the imported symbol and call change.)

- [ ] **Step 4: Run to verify pass**

Run: `( cd bun-apps/s2-agent-ext-file2md && bun test )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-file2md/src/sessions.ts bun-apps/s2-agent-ext-file2md/extensions/file2md.ts bun-apps/s2-agent-ext-file2md/__tests__/
git commit -m "fix(file2md): vision_ask + resolveVisionLLM honor central vision tiers"
```

---

### Task 4: flux2 — `resolveVlmLLM` routes through the central vision slot

**Files:**
- Modify: `bun-apps/s2-agent-ext-flux2/src/vlm.ts:59-62`
- Test: `bun-apps/s2-agent-ext-flux2/extensions/flux2.test.ts` (or the package's vlm test home — locate with `grep -rn resolveVlmLLM bun-apps/s2-agent-ext-flux2 --include='*.test.ts'`)

**Interfaces:**
- Consumes: Task 3 `resolveVisionLLM`.
- Produces: unchanged `resolveVlmLLM(modelOverride?: string): ResolvedLLM` — behavior changes from "PI_MODEL env or throw" to "central `capabilities.vision` (→ env → throw)".

- [ ] **Step 1: Write the failing test**

```ts
test("resolveVlmLLM resolves the central vision capability", () => {
  // stub the tier config the same way file2md's resolve-vision-llm tests do
  // (mock.module on the subagent barrel's loadModelTierConfig — lockstep with
  // file2md's mock flips), then:
  const llm = vlm.resolveVlmLLM();
  expect(llm.modelId).toBe("google/gemma-4-12b");
  expect(llm.provider).toBe("lm-studio");
});
```

If mocking the barrel cross-package proves brittle, test the seam instead: assert `resolveVlmLLM` delegates to file2md's `resolveVisionLLM` via `mock.module("../src/vlm.ts")`-style spy, or set `process.env.PI_MODEL = "lm-studio/google/gemma-4-12b"` in the test and assert the resolved LLM — the delegation (import of `resolveVisionLLM`) is the contract; the tier math is already covered by Task 3's tests.

- [ ] **Step 2: Run to verify failure**

Run: `( cd bun-apps/s2-agent-ext-flux2 && bun test )`
Expected: FAIL (pre-change code calls `resolveLLM`, so a spy on `resolveVisionLLM` sees nothing / env-only resolution differs).

- [ ] **Step 3: Implement**

In `src/vlm.ts` (line ~59), replace:

```ts
/** Default: lm-studio/google/gemma-4-12b (per pi-file2md's resolveLLM default). */
export function resolveVlmLLM(modelOverride?: string): ResolvedLLM {
  return resolveLLM(modelOverride ? { model: modelOverride } : {});
}
```

with:

```ts
/** Central vision slot: capabilities.vision from ~/.pi/workflows/model-tiers.json
 *  (via file2md's resolveVisionLLM — explicit override > tier config > deprecated
 *  PI_MODEL env > actionable throw). */
export function resolveVlmLLM(modelOverride?: string): ResolvedLLM {
  return resolveVisionLLM(modelOverride ? { model: modelOverride } : {});
}
```

and update the file2md import at the top of `vlm.ts` from `resolveLLM` to `resolveVisionLLM` (keep `askImage`, `ResolvedLLM`).

- [ ] **Step 4: Run to verify pass**

Run: `( cd bun-apps/s2-agent-ext-flux2 && bun test )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-flux2/src/vlm.ts bun-apps/s2-agent-ext-flux2/extensions/flux2.test.ts
git commit -m "fix(flux2): VLM resolution goes through central capabilities.vision"
```

---

### Task 5: movie-director — gemma brain seeds from the central vision slot

**Files:**
- Modify: `bun-apps/s2-agent-ext-movie-director/src/lmstudio.ts:74-99`
- Modify: `bun-apps/s2-agent-ext-movie-director/package.json` (add dep)
- Test: `bun-apps/s2-agent-ext-movie-director/src/lmstudio.test.ts`

**Interfaces:**
- Consumes: `loadModelTierConfig`, `resolveModelRole` from `@repo/s2-agent-core-runtime` (new direct dep — same pattern as knowledge-card).
- Produces: `resolveDefaultModel(apiUrl?: string, fetchImpl?: typeof fetch, config?: ModelTierConfig | null): Promise<string>` — third param optional (defaults to `loadModelTierConfig()`), injected for tests. Existing two-arg callers unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/lmstudio.test.ts`:

```ts
test("resolveDefaultModel prefers the central capabilities.vision model", async () => {
  const cfg = {
    tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
    capabilities: { vision: "lm-studio/qwen/qwen3-vl-8b" },
  };
  const fetchImpl = fakeFetchWithLoadedModels(["qwen/qwen3-vl-8b"]); // reuse the file's existing loaded-keys fake; adapt name
  const model = await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, cfg);
  expect(model).toBe("qwen/qwen3-vl-8b");
});

test("resolveDefaultModel strips the provider prefix from the central spec", async () => {
  const cfg = {
    tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
    capabilities: { vision: "lm-studio/google/gemma-4-12b" },
  };
  const fetchImpl = fakeFetchWithLoadedModels(["google/gemma-4-12b"]);
  const model = await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, cfg);
  expect(model).toBe("google/gemma-4-12b"); // "google/" survives — only "lm-studio/" is stripped
});

test("resolveDefaultModel keeps legacy probe behavior when no tier config exists", async () => {
  const fetchImpl = fakeFetchWithLoadedModels(["google/gemma-4-12b"]);
  const model = await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, null);
  expect(model).toBe("google/gemma-4-12b");
});
```

Adapt `fakeFetchWithLoadedModels` to the existing fake in the file (it already stubs `/models` responses for `catalogModelKeys`/`loadedModelKeys` — check which endpoint the loaded-keys probe uses and stub that).

- [ ] **Step 2: Run to verify failure**

Run: `( cd bun-apps/s2-agent-ext-movie-director && bun test src/lmstudio.test.ts )`
Expected: FAIL — `resolveDefaultModel` takes no third argument / ignores config.

- [ ] **Step 3: Implement**

Add the dependency (edit `package.json` `"dependencies"`, insert alphabetically):

```json
    "@repo/s2-agent-core-runtime": "workspace:*",
```

then `( cd bun-apps && bun install )`.

In `src/lmstudio.ts`, add near the top imports:

```ts
import { loadModelTierConfig, resolveModelRole, type ModelTierConfig } from "@repo/s2-agent-core-runtime";
```

and replace the resolver block (lines ~74-99) with:

```ts
/**
 * The gemma brain resolver (mirrors caption.py's `resolve_default_model` /
 * `_resolve_model` with no explicit `--model`): the PREFERRED model is the
 * central vision slot from ~/.pi/workflows/model-tiers.json
 * (capabilities.vision — provider prefix stripped, so LM Studio ids keep their
 * own "google/" prefix). When that isn't configured, fall back to the legacy
 * local probe: any already-loaded model, then the auto-load default if it's
 * downloaded, then DEFAULT_MODEL as terminal fallback.
 */
const PREFERRED_MODELS = ["google/gemma-4-12b"];
const DEFAULT_MODEL = "google/gemma-4-12b";
const FALLBACK_MODELS: string[] = [];

/** Central vision slot → LM Studio model id (provider prefix stripped), or null. */
export function centralVisionModel(config: ModelTierConfig | null = loadModelTierConfig()): string | null {
  const spec = resolveModelRole({ capability: "vision" }, config);
  if (!spec) return null;
  const slash = spec.indexOf("/");
  return slash === -1 ? spec : spec.slice(slash + 1);
}

export async function resolveDefaultModel(
  apiUrl: string = DEFAULT_API_URL,
  fetchImpl: typeof fetch = fetch,
  config: ModelTierConfig | null = loadModelTierConfig(),
): Promise<string> {
  const central = centralVisionModel(config);
  const loaded = (await loadedModelKeys(apiUrl, fetchImpl)) ?? new Set<string>();
  const preferred = central ? [central, ...PREFERRED_MODELS] : [...PREFERRED_MODELS];
  for (const candidate of preferred) {
    if (loaded.has(candidate)) return candidate;
  }
  if (loaded.size > 0) {
    if (loaded.has(DEFAULT_MODEL)) return DEFAULT_MODEL;
    return [...loaded][0]!;
  }
  const catalog = (await catalogModelKeys(apiUrl, fetchImpl)) ?? new Set<string>();
  if (central && catalog.has(central)) return central;
  if (catalog.has(DEFAULT_MODEL)) return DEFAULT_MODEL;
  for (const fb of FALLBACK_MODELS) {
    if (catalog.has(fb)) return fb;
  }
  return central ?? DEFAULT_MODEL;
}
```

Note: `DEFAULT_MODEL` stays as a documented terminal fallback for standalone (no-config) runs — the central slot always wins when the config exists (which it does under any s2-agent host, via the ensure-model-tiers seed).

- [ ] **Step 4: Run to verify pass**

Run: `( cd bun-apps/s2-agent-ext-movie-director && bun test )`
Expected: PASS (existing tests pinning probe behavior keep passing — config default in tests without injection may read the developer's real `~/.pi/workflows/model-tiers.json`; if an existing test asserts probe-order outcomes that the real config would perturb, pass `null` explicitly in that test).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-movie-director/src/lmstudio.ts bun-apps/s2-agent-ext-movie-director/src/lmstudio.test.ts bun-apps/s2-agent-ext-movie-director/package.json bun-apps/bun.lock
git commit -m "feat(movie-director): gemma brain resolves central capabilities.vision first"
```

---

### Task 6: knowledge-card — `chatJson` + distill subagent model via tier config

**Files:**
- Modify: `bun-apps/s2-agent-ext-knowledge-card/src/llm-chat.ts:77-82`
- Modify: `bun-apps/s2-agent-ext-knowledge-card/src/zk-task-config.ts:53-56`
- Test: `bun-apps/s2-agent-ext-knowledge-card/__tests__/` (new: `central-model-resolution.test.ts`)

**Interfaces:**
- Consumes: `loadModelTierConfig`, `resolveModelRole` from `@repo/s2-agent-core-runtime` (already a dependency).
- Produces:
  - `resolveKgModel(config?: ModelTierConfig | null): string` (exported from `llm-chat.ts`) — env `PI_KG_LLM_MODEL` > `capabilities.vision` (prefix-stripped) > terminal `"google/gemma-4-12b"` (chatJson's tolerance contract forbids throwing).
  - `resolveDistillModel(explicit?: string, config?: ModelTierConfig | null): string` (signature extended, optional param) — explicit > `KC_SUBAGENT_MODEL` env > `tiers.small` > throw with actionable message.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/central-model-resolution.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveKgModel } from "../src/llm-chat.ts";
import { resolveDistillModel } from "../src/zk-task-config.ts";
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";

const CFG: ModelTierConfig = {
  tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
  capabilities: { vision: "lm-studio/google/gemma-4-12b" },
};

describe("knowledge-card central model resolution", () => {
  test("resolveKgModel strips provider prefix from capabilities.vision", () => {
    delete process.env.PI_KG_LLM_MODEL;
    expect(resolveKgModel(CFG)).toBe("google/gemma-4-12b");
  });

  test("resolveKgModel env wins over tier config", () => {
    process.env.PI_KG_LLM_MODEL = "google/gemma-4-27b";
    try {
      expect(resolveKgModel(CFG)).toBe("google/gemma-4-27b");
    } finally {
      delete process.env.PI_KG_LLM_MODEL;
    }
  });

  test("resolveDistillModel uses tiers.small from central config", () => {
    delete process.env.KC_SUBAGENT_MODEL;
    expect(resolveDistillModel(undefined, CFG)).toBe("zai/glm-4.7");
  });

  test("resolveDistillModel throws actionable error with no config and no env", () => {
    delete process.env.KC_SUBAGENT_MODEL;
    expect(() => resolveDistillModel(undefined, null)).toThrow(/model-tiers|KC_SUBAGENT_MODEL/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `( cd bun-apps/s2-agent-ext-knowledge-card && bun test __tests__/central-model-resolution.test.ts )`
Expected: FAIL — `resolveKgModel` not exported; `resolveDistillModel` ignores config.

- [ ] **Step 3: Implement**

In `src/llm-chat.ts`, replace `defaultModel()` (lines ~80-82) with an exported resolver (keep the private call site `opts.model ?? resolveKgModel()`):

```ts
import { loadModelTierConfig, resolveModelRole, type ModelTierConfig } from "@repo/s2-agent-core-runtime";

/**
 * Model for local chat-JSON calls. Precedence: PI_KG_LLM_MODEL env >
 * central capabilities.vision (provider prefix stripped — this package talks
 * to the local LM Studio OpenAI-compatible endpoint) > terminal local default.
 * The terminal default stays because chatJson's contract is ALL-failures→null;
 * model resolution must not throw.
 */
export function resolveKgModel(config: ModelTierConfig | null = loadModelTierConfig()): string {
  const env = process.env.PI_KG_LLM_MODEL;
  if (env) return env;
  const spec = resolveModelRole({ capability: "vision" }, config);
  if (spec) {
    const slash = spec.indexOf("/");
    return slash === -1 ? spec : spec.slice(slash + 1);
  }
  return "google/gemma-4-12b";
}
```

Delete the old `defaultModel()` and update its call site (line ~58) to `resolveKgModel()`.

In `src/zk-task-config.ts`, replace lines ~53-56:

```ts
import { loadModelTierConfig, resolveModelRole, type ModelTierConfig } from "@repo/s2-agent-core-runtime";

export function resolveDistillModel(explicit?: string, config: ModelTierConfig | null = loadModelTierConfig()): string {
  if (explicit) return explicit;
  const env = process.env.KC_SUBAGENT_MODEL;
  if (env) return env;
  const spec = resolveModelRole({ tier: "small" }, config);
  if (spec) return spec;
  throw new Error(
    "[knowledge-card] No distill model configured. Set model-tiers.json tiers.small (via /models-preset or /workflows-models) or export KC_SUBAGENT_MODEL.",
  );
}
```

Delete `DISTILL_MODEL_DEFAULT` and update the comment block above (precedence list: 3. central `tiers.small`). Grep for `DISTILL_MODEL_DEFAULT` consumers (`grep -rn DISTILL_MODEL_DEFAULT bun-apps --include='*.ts' | grep -v test`) and migrate any importer to `resolveDistillModel()`; update the tool-param descriptions in `extensions/knowledge-card.ts:377,600` from "Default: google/gemma-4-12b (local LM Studio)" to "Default: central tiers.small (model-tiers.json); override session-wide via KC_SUBAGENT_MODEL".

- [ ] **Step 4: Run to verify pass**

Run: `( cd bun-apps/s2-agent-ext-knowledge-card && bun test )`
Expected: PASS. Existing tests referencing gemma defaults in zk tool descriptions may need expectation updates.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-knowledge-card/
git commit -m "feat(knowledge-card): chat + distill models resolve central tier config"
```

---

### Task 7: cross-package verification + devops finish

**Files:** none (verification only)

- [ ] **Step 1: Cross-package typecheck**

Run: `bun run --cwd bun-apps/s2-agent typecheck` (red-lights the whole repo)
Expected: PASS.

- [ ] **Step 2: local_ci via devops**

Run: `bun bun-apps/s2-agent-ext-devops/src/local-ci-cli.ts` (or the s2-agent wrapper). Budget ≤5 min.
Expected: PASS. If hermes/archify/power-tool/subagent tests exit 124, check whether another s2-agent session is running (known starvation issue) before touching code.

- [ ] **Step 3: Drift re-scan**

Run the audit grep to confirm the four packages now reference the central resolver:

```bash
grep -rn 'resolveModelRole\|resolveVisionLLM' bun-apps/s2-agent-ext-movie-director/src bun-apps/s2-agent-ext-flux2/src bun-apps/s2-agent-ext-file2md bun-apps/s2-agent-ext-knowledge-card/src --include='*.ts' | grep -v '\.test\.'
```

Expected: hits in `lmstudio.ts`, `vlm.ts` (flux2), `sessions.ts`/`file2md.ts`, `llm-chat.ts`/`zk-task-config.ts`.

- [ ] **Step 4: PR via devops**

Use the devops tool chain (`prepare_feature_branch` was run at session start; `merge_pr_after_local_ci`). PR title suggestion: `feat(tiers): centralize all ext LLM selection — vision-large/medium/small + 4 package rewires`. Commit `.planning/vision-tier-centralization/` with the PR (standing rule: planning artifacts are committed).

---

## Self-Review

- **Spec coverage:** audit items 1-4 → Tasks 1-6; item 5 (web-access) explicitly out of scope; TTS/embedding exclusions documented in header. ✔
- **Placeholder scan:** two test steps reference "reuse the file's existing fake/stub helper" — that is a deliberate instruction to reuse an existing named fixture rather than placeholder code; the assertion logic is fully specified. ✔
- **Type consistency:** `ModelTierConfig` (core-runtime shape, `tiers: Record<string,string>` + optional `capabilities`) used in Tasks 1, 5, 6; `resolveVisionLLM` tier opt defined Task 3, consumed Task 4; `resolveDistillModel` signature extended (optional param — back-compat). ✔
