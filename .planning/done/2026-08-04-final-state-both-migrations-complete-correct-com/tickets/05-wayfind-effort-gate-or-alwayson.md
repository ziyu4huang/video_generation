type: grilling
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

Should **`wayfind_effort`** (`bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts:200`, ~300 tok/req) be **gated** or **always-on**?

Context:
- Wayfind effort-management tool (create/list/close effort-map entries); the lightest of the 5 (sits exactly at the 300 tok/req heavy threshold).
- Consider whether wayfind effort ops are routine enough to be always-on, or deserve a gate consistent with other planning-lifecycle tools.
- Options: keyword gate, or `core: true` if always-on is intended.

Resolution records: the chosen `gating:` value (verbatim, to paste at `effort-tool.ts:200`).

## Resolution

**Decision: core: true (always-on)** (chosen 2026-08-04). Lightest of the 5 (sits exactly at the 300 tok/req heavy threshold); routine effort-map bookkeeping (create/list/close entries); benign. Owner-declared always-on.

Proposed gating (apply at ticket 06):
```ts
gating: { core: true }
```
Target: `bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts:200`.
