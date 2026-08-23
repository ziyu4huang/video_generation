---
name: s2-agent-model-catalog-update
description: Use when adding, changing, or debugging a model or provider in s2-agent's baked model catalog — the PROVIDERS entries in bun-apps/s2-agent/src/pre-load-providers.ts, registered at runtime on top of pi-ai's baked catalog. Triggers include "add <provider> model", "model not in --list-models", "provider not configured", "model id rejected with 400", "thinking/vision flags wrong in --list-models", "vision model", "model ids with [1m]/suffix aliases", "deploy then check --list-models". Not for per-machine personal overrides (use ~/.pi/agent/models.json instead — see Alternative).
---

# Updating s2-agent's Model Catalog

## Overview

A model in s2-agent comes from one of two layers: **pi-ai's baked catalog** (`node_modules` — read-only, ships zai/deepseek/huggingface/…) or a **PROVIDERS entry** in `pre-load-providers.ts`, registered at runtime via `registerProvider`. Two facts govern the whole job:

1. **Providing a provider's model list REPLACES that provider's baked list — it does not merge.** Registering `"deepseek"` with one model silently drops every other `deepseek` model from `--list-models`.
2. **The config file proves nothing.** An id, compat flag, or context budget is only true after a live API probe and a live runtime stream.

## When to use

- Adding a model to s2-agent (e.g. "add deepseek vision exp").
- `--list-models` misses a model, or shows wrong flags (images/thinking).
- A model id is rejected by the API (400) or the provider shows "not configured".
- Verifying after deploy that the shipped dist exposes the model.

**When NOT:** personal, one-machine overrides → `~/.pi/agent/models.json` — this AUGMENTS the baked list (pushes models instead of replacing; same job but no repo change). Only bake a provider into `pre-load-providers.ts` when it must ship with the package.

## Core pattern

```
suspect → probe the live API → read the baked catalog + adapter source → write entry → prove with gates → prove with a live runtime stream → deploy + prove dist
```

Every arrow is a verification, not a confidence. A model entry becomes correct only when a real completion streams back through `ModelRuntime.create()`.

## Quick reference

| Layer | Where | Role |
|---|---|---|
| Baked catalog | `find ~/.bun/install/cache -path "*pi-ai@<pkg-version>*dist/providers/data" -type d\| head -1` — cache dirs carry a `@@@1` dedupe suffix (`pi-ai@0.84.2@@@1`), never the bare `pi-ai@<version>`; `<pkg-version>` from `bun-apps/s2-agent/package.json` | Copy `id` / `api` / `baseUrl` / `compat` / `thinkingLevelMap` / `cost` from here |
| Adapter semantics | same cache: `dist/api/openai-completions.js` — `buildParams()` per `compat.thinkingFormat` branch, `detectCompat()` | Which compat keys produce which request params |
| Registration | `pre-load-providers.ts` `PROVIDERS` → `registerAllProviders` → pi `registerProvider` | Extension models REPLACE; provider compat folds per-model; costs forced `ZERO_COST` |
| Config overlay | `~/.pi/agent/models.json` | Augments baked list — alternative for personal models |

## Implementation

### 1. Probe the live API before writing anything

`GET <baseUrl>/models` (or a 1-token completion) with the key header only — never echo the key:

```bash
curl -s -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" https://api.deepseek.com/v1/models
```

Two endpoints may diverge: `[1m]`-style aliases are often **gateway-only** (measured 2026-08-23: OpenAI-style `/v1/chat/completions` → 400 on `deepseek-v4-flash-vision-exp[1m]`, 200 on the plain id; `/anthropic/v1/messages` accepts the alias). The API's own "supported API model names are …" 400 message is the authoritative id list — use the id it names.

### 2. Read the baked catalog and the adapter branch

- Baked entry for the same provider model (e.g. `deepseek-v4-flash`) gives the true `compat` and `thinkingLevelMap` — copy them. **If the model has NO baked sibling** (it's new to the provider), derive compat / `thinkingLevelMap` / contextWindow / maxTokens from the nearest sibling and say so in the entry comment — the entry itself is the only record of where those numbers came from.
- `buildParams()` in `openai-completions.js`: `thinkingFormat: "deepseek"` + `supportsReasoningEffort: true` + `thinkingLevelMap` → `thinking: {type:"enabled"}` + `reasoning_effort`. `detectCompat()` infers most of this from `provider` id + `baseUrl` — pinning explicitly only buys stability across pi-ai upgrades.
- **Always-on reasoning + shared budget**: deepseek/deepseek-style servers return `content: ""` and `finish_reason: "length"` when `maxTokens` is small (all budget goes to `reasoning_content`). Keep sibling headroom (382-384K), never a small cap.

### 3. Write the entry

One worked example (the deepseek vision addition — the only correct shape):

```ts
"deepseek": {
  baseUrl: "https://api.deepseek.com",
  api: "openai-completions",
  // pi template form: env-resolved at request time → truthful "not configured"
  // when unset. { env: ... } freezes the literal at registration and claims
  // configured even with an empty key.
  apiKey: "$DEEPSEEK_API_KEY",
  compat: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
    maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
  },
  models: [
    // RE-LIST the wrapped provider's baked models — registration replaces them.
    { id: "deepseek-v4-flash", /* copy of baked entry */ },
    { id: "deepseek-v4-pro",   /* copy of baked entry */ },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision EXP",
      reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 384_000,
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" } },
  ],
}
```

Rules: models listed = the complete set (`--list-models` is the witness). Vision → `input: ["text","image"]`. Costs stay zero (registration convention; the contract test asserts it). Extend `ModelEntry`/`Compat` interfaces only when the new knob needs a type.

**Update the contract test in the same change**: `pre-load-providers.test.ts` re-list guard (`arrayContaining([...])` + vision assertion) exists BECAUSE of the replace trap — a new model with no test addition leaves the guard stale. Then audit references: grep the provider's model ids (`deepseek/deepseek-v4-flash`, `zai/...`) across `BUILTIN_MODEL_DEFAULT.obsidianSubagentFloor`, `DEFAULT_MODEL_TIER_CONFIG`, `~/.pi/workflows/model-tiers.json` seeds, and settings — the re-list must keep every one alive.

### 4. Prove with the machines

```bash
# fresh worktrees: node_modules may be absent — install from bun-apps only
( cd bun-apps && bun install )
( cd bun-apps/s2-agent && bun test src/pre-load-providers.test.ts && bun test && bun run typecheck )
( cd bun-apps/s2-agent && bun src/cli.ts --list-models )   # model present, images=yes
```

### 5. Prove with a LIVE runtime stream (the step red runs skip)

pi-ai `Message` uses `content` (string | blocks) **not** `text`, and events are `text_delta` / `thinking_delta` with a `delta` field — the two shapes that make naive probes fail ("Empty input messages" 400; silence):

```ts
// /tmp/probe-<provider>.ts — TRANSIENT; delete after the run.
// Import with an ABSOLUTE path — the bare `bun-apps/...` specifier fails
// ("Cannot find module"), and `./bun-apps/...` only resolves from repo root.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { registerAllProviders } from "/<abs>/bun-apps/s2-agent/src/pre-load-providers.ts";
const rt = await ModelRuntime.create({ modelsStore: new InMemoryModelsStore() });
registerAllProviders(rt);
const model = rt.getModel("deepseek", "deepseek-v4-flash-vision-exp")!;
const ev = rt.stream(model, {
  systemPrompt: "Reply with exactly: PONG",
  messages: [{ role: "user", content: "ping", timestamp: Date.now() } as any],
  tools: [],
} as any, { reasoningEffort: "high" } as any);
let text = "", thinking = "";
for await (const e of ev) {
  if (e.type === "text_delta") text += e.delta;
  else if (e.type === "thinking_delta") thinking += e.delta;
  else if (e.type === "error") { console.error(e); process.exit(2); }
}
if (!text.includes("PONG")) process.exit(3);
```

`PONG` through a real runtime = the whole chain (catalog → compose → adapter → auth → API → events) is true. `bun install` on the way in may report "no changes" (globalStore warm) — that is success, not a skipped step.

### 6. Deploy + prove the dist

```bash
bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts        # boots E2E after each deploy
( cd ~/proj/dist/s2-agent-sh/current && ./s2-agent --list-models | grep <provider> )
```

Deploy trap: without a mirrored `bun-apps/s2-agent-ext-sv-analyzer/wasm/sv-analyzer.wasm` the deploy aborts. The wasm is a gitignored regenerated artifact — mirror the byte-identical one from an earlier deployed version (`~/proj/dist/s2-agent-sh/<v>/ext/sv-analyzer/wasm/sv-analyzer.wasm`, verify with `shasum`) or run `dsh-plugin/sv-analyzer/build.sh` (full cargo+zig rebuild, slow).

## Common mistakes

| Mistake | Reality |
|---|---|
| Register under the baked provider id with only the new model | Extension models REPLACE the baked list — re-list every model; guard with the contract test |
| Using a `[1m]`/suffix alias on the OpenAI-style endpoint | 400; aliases are gateway-specific — probe; use the id the API's error message names |
| `{ env: "KEY" }` apiKey | Frozen at registration; unset env still claims "configured". Use `"$KEY"` template form |
| Small `maxTokens` for always-on-reasoning models | Empty content, `finish_reason: "length"` — sibling headroom |
| Probe messages with `text:` / expecting `text` events | pi-ai uses `content`; events are `*_delta` with `delta` |
| Verifying only with curl / `getModel()` | Doesn't exercise the adapter; run the live stream probe |
| Adding real `cost` fields | Registration convention zeroes costs and the contract test asserts it |
| Skipping `bun install` in a fresh worktree | All `bun` commands die on missing workspace modules (127 / resolve errors) |

## Verification recipe (minimum bar)

1. `bun test` + `typecheck` green for the touched package.
2. `--list-models` shows the model with right vision/thinking flags.
3. Live stream probe returns real content (not an error event).
4. Reference audit: every pre-existing `provider/model` id still resolves (obsidian floor, tiers, settings).
5. Deployed dist `--list-models` greps the provider after `deploy-cli.ts` reports pass.
6. Probe file deleted (transient by design).
