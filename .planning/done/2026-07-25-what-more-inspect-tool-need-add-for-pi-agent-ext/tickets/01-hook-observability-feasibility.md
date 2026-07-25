type: research → prototype
claimed: pi-session-2026-07-25
status: closed (2026-07-25)

## Question

Can hook observability — "which extensions registered which `pi.on(event,
handler)` handlers, and did they fire this session?" — be built **without an
upstream SDK change**, using only the power-tool extension's own capabilities?

This is the keystone ticket: the whole verdict ([03]) turns on whether the one
open gap (activity 5 — hook observability) is closeable. It is **not** a build
ticket — produce a decision + a cheap proof, not a shipped tool.

## Findings so far (chart-time fact-gathering, not yet a resolution)

- **SDK gap confirmed (pi-coding-agent 0.82.0):** `ExtensionAPI` exposes
  `getAllTools(): ToolInfo[]` (tools are enumerable) but has **no**
  `getAllHandlers()` / `getHooks()` / `getRegisteredHandlers()` / equivalent.
  Hook registrations are not readable back through any public API. → the gap is
  real at the SDK level, not just an unbuilt tool.
- **Feasible path identified (by analogy):** power-tool's factory can wrap
  `pi.on()` at load time, recording each `(extension, event, handler)` into a
  bounded accumulator — the identical technique already proven twice in this
  codebase:
  - `sdk-patch.ts` wraps `ExtensionRunner.prototype.createContext` to add
    `getSystemPromptOptions()` (monkey-patch at import time).
  - `inspect_pathology` instruments `tool_execution_start` / `_end` via its own
    `pi.on(...)` registration into an accumulator.

## What this ticket must resolve

1. **Load-order guarantee.** To capture *other* extensions' `pi.on` calls,
   power-tool must wrap `pi.on` **before** they register. power-tool is static
   (registered in `static-extensions.ts`, loads early) — confirm the dynamic
   extensions (manifest) register strictly *after*, so the wrap sees them. If
   not, what's the fallback (wrap at the runner level, like sdk-patch)?
2. **Firing observability.** Registration capture is half; *did the handler
   fire* is the other. Can the wrap also record invocations (wrap the handler
   itself, not just the registration)? Cost / overhead?
3. **Source attribution.** Can the wrap attribute each registration to the
   *extension* that made it (not just "someone called pi.on")? `ExtensionAPI`
   is per-extension at factory time — is that enough to attribute?
4. **Cheap spike.** Build a throwaway ~40-line spike that wraps `pi.on` in the
   power-tool factory, logs `(event, sourceHint)` for every registration across
   a real session, and confirms it captures tool-gate's `before_agent_start`,
   obsidian's hooks, etc. The spike proves (1)–(3); it is NOT the shipped tool.

## Resolution (2026-07-25)

**FEASIBLE — no upstream SDK change needed.** The "wrap `pi.on` at factory
start" hypothesis above is **superseded** by a cleaner approach discovered by
reading the SDK source: **read the already-aggregated handler store directly.**

### How the SDK actually stores hooks (pi-coding-agent 0.82.0)

- `createExtensionAPI(extension, runtime, …)` (loader.js) builds a
  **per-extension** `api` whose `on(event, handler)` pushes into
  `extension.handlers` — a `Map<event, handler[]>` **on the extension object**.
  → *each extension's `on` is a per-instance closure*, so wrapping power-tool's
  own `pi.on` would capture ONLY power-tool's registrations, not others'.
  **(This is why the original "wrap pi.on" idea fails — confirmed.)**
- `ExtensionRunner` (runner.js:121, 149–150) holds `this.extensions` — the
  collection of **all** loaded extension objects, each carrying its own
  `.handlers` Map.
- Event dispatch (runner.js:371–372, 572–578) is literally:
  `for (const ext of this.extensions) { const handlers = ext.handlers.get(eventType); … await handler(event, ctx); }`
  — i.e. the runner walks every extension's handlers map on every event.

### The feasible approach (proven pattern, already in this codebase)

**Extend the `sdk-patch.ts` `createContext` polyfill** — which already captures
`this` (the runner instance) — to also expose a `getHooks()` on the tool ctx,
mirroring the existing `getSystemPromptOptions()` polyfill exactly. `inspect_hooks`
then reads `runner.extensions.flatMap(ext => […ext.handlers].map(([event, hs]) =>
({ extension: ext.path, event, count: hs.length })))`.

Resolves the four sub-questions:
1. **Load-order: IRRELEVANT.** Reading `runner.extensions` at *tool-call time*
   sees every extension regardless of registration order — no wrap-before-they-
   register race. (This retired the original load-order worry.)
2. **Firing observability: feasible, phase 2.** Walk `extensions[].handlers` at
   the same patch point and wrap each handler with a counter (`fn = (…args) =>
   { count++; return orig(…args) }`). One increment per fire — negligible
   overhead. More invasive than listing, so ship listing first, firing second.
3. **Source attribution: FREE.** `ext.path` / `ext.sourceInfo` already groups
   each handler by its owning extension — no inference needed.
4. **Spike: NOT BUILT — intentionally.** The SDK source is conclusive proof (the
   dispatch loop reads `ext.handlers.get(event)` verbatim; `sdk-patch.ts` proves
   `ExtensionRunner.prototype.createContext` is patchable and `this` = runner is
   captured). A spike would only re-confirm what the source states. The actual
   `inspect_hooks` build (graduated by [03]) will implicitly confirm.

### Feasibility verdict (feeds [03])

- **Registration observability** (the #1 need — "did my handler register / did I
  typo the event name"): **near-trivial, no SDK change, order-independent.**
- **Firing observability**: **feasible** with handler-wrapping (phase 2).
- **Net: feasible without an upstream SDK change.** → per [02]'s locked decision
  rule (HIGH + feasible-no-SDK-change → NO-GO), the [03] verdict is now
  **determined: NO-GO → graduate `inspect_hooks` to a fresh effort.**
