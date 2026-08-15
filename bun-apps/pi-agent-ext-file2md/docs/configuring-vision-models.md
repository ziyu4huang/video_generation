# Configuring vision models in `~/.pi/`

Vision models are **not** hard-coded into the extension. They are registered in
`~/.pi/agent/models.json` and selected at runtime by `resolveLLM()` (precedence:
tool params → `PI_*` env → built-in default). This doc shows the config shape,
how to add a second vision backend, how to switch between them, and exactly what
JSON each backend emits on the wire.

> See [architecture.md](./architecture.md) for the full call chain. This page
> focuses on the **config surface** and the **per-backend wire format**.

## 1. Where vision models are configured

`~/.pi/agent/models.json` — top-level `providers` object, keyed by provider name.
Each provider entry carries a `baseUrl`, an **`api`** (the adapter selector), an
`apiKey`, and a `models[]` list.

### Current state (this machine)

```jsonc
{
  "providers": {
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",          // ← selects the pi-ai adapter
      "apiKey": "lm-studio",                 // dummy; LM Studio ignores it
      "models": [
        { "id": "google/gemma-4-12b" },  // ← the built-in DEFAULT_MODEL
        { "id": "google/gemma-4-12b" }
      ]
    }
  }
}
```

That single entry is what makes `vision_ask` work out of the box: the built-in
default target (`lm-studio/google/gemma-4-12b`) resolves against this
provider, which is served by your local LM Studio on `:1234`.

## 2. The `api` field is the adapter selector

The provider's `api` value decides **which pi-ai adapter** serializes messages —
and therefore **what the image looks like on the wire**. Legal values:

| `api` | Typical provider | Image wire format |
|---|---|---|
| `openai-completions` | lm-studio, openrouter, openai-compat | `image_url: { url: "data:<mime>;base64,…" }` |
| `openai-responses` | OpenAI Responses API | `image_url` data URL (Responses shape) |
| `azure-openai-responses` | Azure OpenAI | `image_url` data URL |
| `anthropic-messages` | Anthropic Claude | `{ type:"image", source:{ type:"base64", media_type, data } }` |
| `bedrock-converse-stream` | AWS Bedrock | Converse `image` block |
| `google-generative-ai` | Gemini | `inline_data` block |
| `google-vertex` | Vertex AI Gemini | `inline_data` block |
| `mistral-conversations` | Mistral | `image_url` data URL |
| `openai-codex-responses` | OpenAI Codex | (text-first; image support varies) |

The neutral image part built by `askImage()` (`{type:"image", data, mimeType}`)
is identical regardless of provider; **only the serialization differs**, and it
is dispatched purely by this `api` field. (Union source: `pi-ai/dist/types.d.ts:13`.)

## 3. Adding a second vision backend

Two realistic additions:

### 3a. Another local LM Studio model (zero-config switch)

Both Gemma variants are already registered above. To run the 26B instead of the
12B, you don't touch models.json at all — just override the selection (§4).

### 3b. A cloud provider (e.g. Anthropic Claude vision)

Add a sibling entry under `providers`. The provider key is arbitrary but becomes
the `provider/` prefix you select with; `api` must match the backend's protocol:

```jsonc
{
  "providers": {
    "lm-studio": { "/* …as above… */ },

    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "api": "anthropic-messages",
      "apiKey": "sk-ant-…",                  // or via env / pi credential store
      "models": [
        { "id": "claude-opus-4-1" },
        { "id": "claude-sonnet-4-5" }
      ]
    },

    "google": {
      "api": "google-generative-ai",
      "apiKey": "AIza…",
      "models": [ { "id": "gemini-2.5-flash-image" } ]
    }
  }
}
```

After this edit, the same `vision_ask` call can target any of the three
backends — the only thing that changes is which `api` adapter runs (§2), so the
identical image gets serialized three different ways on the way out.

> **Auth note:** `apiKey` inline is fine for local dev. For anything shared,
> prefer pi's credential store (`/login <provider>`) and omit `apiKey`. The
> agent-session preflight (`hasConfiguredAuth` / `checkAuth`) gates the call and
> throws a clear "no API key" / "run /login" error if missing.

## 4. Switching the active VLM at runtime

Selection lives in `resolveLLM()` (`src/sessions.ts`). Precedence
(high → low): **tool params → `PI_*` env → built-in default**.

### 4a. Per-call, via the tool params (highest precedence)

```
vision_ask({
  image: "sample.png",
  question: "What does this show?",
  model: "anthropic/claude-sonnet-4-5",   // "provider/modelId"
})
```

Shorthand accepted in `model`:
- `provider/modelId` — split on **first** `/`.
- `provider/modelId:thinking` — append a level from
  `off|minimal|low|medium|high|xhigh`.
- `provider` and `thinking` can also be passed as separate params.

### 4b. Session-wide, via env vars

```bash
# Target the cloud Claude backend for this shell:
export PI_MODEL="anthropic/claude-sonnet-4-5"
export PI_THINKING="low"          # optional

# Or the bigger local Gemma:
export PI_MODEL="lm-studio/google/gemma-4-12b"
```

`PI_PROVIDER` is only consulted when `PI_MODEL` has **no slash**; a slash in the
model string re-sets the provider (test-pinned in `__tests__/sessions.test.ts`).

### 4c. Built-in default (no override)

Drops to `provider=lm-studio`, `modelId=google/gemma-4-12b`, `thinking=off`.

## 5. Worked example — one image, three backends

Given `sample.png` and the models.json from §3b, here is exactly what leaves the
machine for each selection. The neutral part is always
`{ type:"image", data:"iVBOR…", mimeType:"image/png" }`.

### Backend 1 — `lm-studio/...` → `api: openai-completions` (default)

POST `http://localhost:1234/v1/chat/completions`:
```jsonc
{ "role": "user", "content": [
  { "type": "text", "text": "What does this show?" },
  { "type": "image_url",
    "image_url": { "url": "data:image/png;base64,iVBOR…" } }   // ← data URL
]}
```

### Backend 2 — `anthropic/claude-sonnet-4-5` → `api: anthropic-messages`

POST `https://api.anthropic.com/v1/messages`:
```jsonc
{ "role": "user", "content": [
  { "type": "text", "text": "What does this show?" },
  { "type": "image",
    "source": { "type": "base64", "media_type": "image/png", "data": "iVBOR…" } }  // ← split fields
]}
```

### Backend 3 — `google/gemini-2.5-flash-image` → `api: google-generative-ai`

Serialized to Gemini's `inline_data` block by that adapter (same neutral part,
third shape).

In all three cases the only code that changes is the `model`/`PI_MODEL` you pass;
`vision_ask`, `askImage`, and the session factory are identical. The provider's
`api` field does all the routing.

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Model "<provider>/<id>" not found. Available (…)` | `resolveModel()` couldn't match. Either the provider key or the model `id` in models.json doesn't match what you selected. Names are matched exact-first, then case-insensitive substring. |
| `No API key found for "<provider>"` | Provider configured but unauthenticated. Add `apiKey` or run `/login <provider>`. |
| `vision_ask failed: <network>` for lm-studio | LM Studio not serving on `:1234`, or the named model isn't loaded into it. Open LM Studio → load the model → confirm the server tab is "Running". |
| Image sent but model returns text-only / ignores it | The model isn't actually a vision model, or its `input` capability isn't `image`. pi-ai gates image-bearing tool results on `model.input.includes("image")` for some adapters; register a genuine VLM `id`. |
| Switched `PI_MODEL` but still hits lm-studio | A slash in `PI_MODEL` re-sets the provider and overrides `PI_PROVIDER`; check there's no stale `PI_MODEL` exported in your shell. |
