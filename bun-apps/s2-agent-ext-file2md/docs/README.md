# pi-file2md — internal docs

Deep-dive documentation for the `vision_ask` / `file2md` tools. These docs describe
**how the tools actually run** (traced against the installed `@earendil-works/pi-coding-agent`
+ `@earendil-works/pi-ai`), so future changes to the call chain can be re-verified
against the source references cited inline.

> Ground truth versions at time of writing:
> - `pi-coding-agent` 0.80.10 (`dist/core/agent-session.js`)
> - `pi-ai` 0.80.6 (`dist/api/{openai-completions,anthropic-messages}.js`, `dist/types.d.ts`)
>
> File:line citations are stable within a minor bump; re-grep by symbol name if a
> citation drifts.

## Pages

| Doc | What it covers |
|---|---|
| [architecture.md](./architecture.md) | End-to-end call chain of `vision_ask`: sequence diagram, model resolution (`resolveLLM`), how an image part flows through `session.prompt()` and is serialized to the provider wire format by the pi-ai adapter. |
| [configuring-vision-models.md](./configuring-vision-models.md) | How to register vision models in `~/.pi/agent/models.json` and switch the active VLM at runtime (`PI_MODEL`, tool params). Includes the per-`api` image wire-format comparison so you know exactly what JSON leaves the machine. |

## TL;DR

`vision_ask` never calls an LLM HTTP API itself. It builds one neutral image
content-part, opens a **one-shot disposable s2-agent session**, and subscribes to
its text stream. The actual network request — including the provider-specific
serialization of the image — is emitted by the **pi-ai adapter** that the
session's `model.provider` resolves to, driven by the `api` field of that
provider's entry in `~/.pi/agent/models.json`.

```
vision_ask.execute(params)
  └─ askImage()                              src/vlm/ask.ts
       ├─ resolveLLM({model,provider,thinking})  src/sessions.ts     (pure parser)
       ├─ createSharedSession(llm)               src/session-factory.ts
       │     └─ createAgentSessionFromServices()  ← @earendil-works/pi-coding-agent
       ├─ session.subscribe("text_delta")        (accumulate reply)
       ├─ session.prompt(question, {images})     dist/core/agent-session.js
       └─ session.dispose()                      (one-shot, dropped)
                   │
                   ▼  provider adapter (selected by models.json `api` field)
        ┌──────────┴───────────┐
   openai-completions     anthropic-messages      …
   image_url: data URL    image.source.base64
```
