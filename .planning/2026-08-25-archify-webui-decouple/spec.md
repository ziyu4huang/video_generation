# spec — archify-webui-decouple

Status: active (user directive 2026-08-25). Scope locked by map.md Decisions D1–D3.

## 1. Problem

ext-archify is a deploy-shipped extension; ext-webui is a local-operator-only UI.
They are coupled in exactly two places, neither a hard import:

1. **Registration**: webui sits in the STATIC registration set
   (`registry-config.ts:349-367` → generated `static-extensions.ts:104,133`), so the
   s2-agent static bundle imports webui code even though the deploy tree excludes it.
2. **Naming**: archify's announce channels are `webui:*`-prefixed and its
   comments/help text describe features "for a webui" — the contract reads
   webui-owned when the data flow is archify→webui.

## 2. Target design

### 2.1 Registry (D1)

One data change in `bun-apps/s2-agent/src/registry-config.ts`:

```diff
   {
     name: "webui",
     package: "s2-agent-ext-webui",
     entry: "extensions/webui.ts",
-    load: "static",
+    load: "dynamic",
     skills: true,
     enabled: true,
     excludeReason: "local-operator browser UI; no operator on the portable target",
     …
   }
```

Followed by `bun run --cwd bun-apps/s2-agent regen:manifest` (+ `regen:static`),
which must drop the webui import/factory row from `static-extensions.ts` and move
the package from `manifest.json` `staticExtensions[]` to the dynamic set. No
deploy-block change (webui stays excluded); no `enabled` change (source mode keeps
loading it via `-e`).

### 2.2 Contract documentation (D2)

The channel trio `webui:open` / `webui:present` / `webui:deck` is declared an
**archify-owned announce contract with frozen names**:

- archify side: `src/open-announce.ts` header documents the trio as this package's
  outbound contract (emitters stay at `:24`, `:27`, `:94` — unchanged).
- webui side: `CONTEXT.md` (ubiquitous-language glossary) gains a Term entry naming
  the trio as an INBOUND dependency subscribed at `webui-wiring.ts:1019,1033,1082`,
  with `_Avoid:` renaming the channels (replay stranding, per protocol.ts:150).
- No string literal changes; no behavior change.

### 2.3 Non-goals

- No channel rename (D2), no removal of `--no-webui`/`--webui-port` (D3), no change
  to webui internals, no re-inclusion in deploy.

## 3. Gates

- `bun run --cwd bun-apps/s2-agent regen:manifest` + `regen:static`; `manifest.json`
  freshness-gated (never hand-edited).
- schema-cost canary (webui stays registered ⇒ stays measured; expect no drift).
- Canonical gates: s2-agent, s2-agent-ext-archify, s2-agent-ext-webui.
- devops `local_ci`; deploy + `verify-deploy-e2e` (webui deploy-excluded as today;
  E2E must stay green unchanged).
