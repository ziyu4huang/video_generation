# Custom LLM providers & default model-id: baked vs runtime

> **Tech note** — recorded 2026-07-03.

How pi-agent adds a custom LLM provider / model, and why neither touches
`~/.pi/` for the **catalog** (it's baked into the artifact) while the
**default selection** does route through `~/.pi/` or env. This split is also
what makes a read-only deploy viable.

Two independent concerns; do not conflate them:

| Concern | Source | When it's fixed | Touches `~/.pi/`? |
|---|---|---|---|
| **Provider catalog** (which providers/models exist) | `src/pre-load-providers.ts` `PROVIDERS` | **build time** (baked into bundle) | no |
| **Default model** (which one is selected) | `~/.pi/agent/settings.json` **or** `PI_MODEL`/`PI_PROVIDER`/`PI_THINKING` env | runtime | yes (settings) / no (env) |

---

## 1. Provider catalog — baked into the artifact

The provider list lives in source: `src/pre-load-providers.ts` (the `PROVIDERS`
record). It is injected into pi's `ModelRegistry` by a monkey-patch on
`ModelRegistry.prototype.loadModels`:

```ts
Proto.loadModels = function () {
  _realLoadModels.call(this);                        // built-in catalog first
  for (const [name, entry] of Object.entries(PROVIDERS)) {
    _realRegisterProvider.call(this, name, {
      ...entry,
      apiKey: resolveApiKey(entry.apiKey),
      models: entry.models.map((m) => ({ ...m, cost: ZERO_COST })),
    });
  }
};
```

Because this is **source-level**, every deploy mode (bundle / release /
portable) compiles `PROVIDERS` into the artifact. Adding a provider (e.g.
uncommenting the `openrouter` block) means editing that file and rebuilding —
**no `~/.pi/` involvement**. The constructor calls the private `loadModels()`
(not `refresh()`); `registerProvider()` stores configs in
`registeredProviders`, so any later `refresh()` replays them automatically.

### API key resolution is mixed

`resolveApiKey()` resolves the `apiKey` field two ways:

- `apiKey: "lm-studio"` — literal string, hardcoded (fine for local servers
  with a fake key).
- `apiKey: { env: "OPENROUTER_API_KEY" }` — read from `process.env` at runtime
  (empty string if unset).

So a baked provider with an `{ env }` key still works on a read-only deploy,
because the key is read from the process environment, not a file.

---

## 2. Default model selection — runtime, two paths

`src/patches/default-model-env.ts` bridges three env vars into pi's argv:

```ts
BRIDGES = [
  { env: "PI_MODEL",    flag: "--model" },
  { env: "PI_PROVIDER", flag: "--provider" },
  { env: "PI_THINKING", flag: "--thinking" },
];
```

**Why the patch exists:** pi's native TUI resolves its default model ONLY from
`~/.pi/agent/settings.json` (`defaultModel` / `defaultProvider`); it does NOT
read `PI_MODEL` / `PI_PROVIDER` / `PI_THINKING` (zero hits in the
pi-coding-agent dist). The `pi-agent cli` namespace honors those env vars
directly; the TUI path wraps the real pi, so without this bridge the same
`PI_MODEL=...` that worked for `pi-agent cli` was silently ignored. The patch splices the env value into argv
(`--model <val>`) when the user hasn't passed the flag explicitly. The values
still pass through pi's own parser, so pi validates them.

So the default model has two runtime sources, neither of which requires
touching the bundle:

1. `~/.pi/agent/settings.json` — `defaultModel` / `defaultProvider` (pi native).
2. `PI_MODEL` / `PI_PROVIDER` / `PI_THINKING` env (bridged by the patch).

---

## 3. Why this matters for read-only deploys

This two-layer design is exactly why a frozen deploy (`chmod a-w`, the default
since 2026-07-03 — see `docs/deploy-readonly.md` / the `pi-agent-readonly-deploy`
memory) costs nothing at runtime:

- **Catalog is in the artifact** → read-only is fine; nothing writes it.
- **Selection + key live in `~/.pi/agent` or the env** → already decoupled from
  the deploy tree. No file in the frozen tree needs to change to switch models.

The one caveat: a provider whose `apiKey` is a literal string is fully baked
into the artifact — rotating it requires a rebuild. Prefer `{ env: "..." }` for
any real secret so rotation stays a runtime concern.

---

## Open enhancement (not implemented)

`PROVIDERS` is currently **only** baked. A future enhancement could let a
read-only deploy gain providers without rebuilding, by merging a
`~/.pi/agent/providers.json` (catalog source becomes `baked ∪ ~/.pi`). The
`loadModels` patch would read that file and `registerProvider()` each entry
after the baked set, mirroring how settings.json already overlays the default
model. Not built today; recorded here as a candidate.
