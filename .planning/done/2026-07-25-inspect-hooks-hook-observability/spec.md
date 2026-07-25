# Spec: inspect_hooks — hook observability for extension development

**Date:** 2026-07-25
**Origin:** graduated from wayfinder map `2026-07-25-what-more-inspect-tool-need-add-for-pi-agent-ext` (verdict NO-GO)
**Status:** design approved (5 decisions resolved 2026-07-25) → ready for writing-plans
**Predecessor findings:** tickets 01 (feasibility) + 02 (HIGH impact) in that map.

## Problem

power-tool's inspect-* surface covers tools (`inspect_extensions`), context
tokens (`inspect_context`), state (`inspect_agent`), failure patterns
(`inspect_pathology`), and TUI widgets (`inspect_tui`). It does NOT cover
**lifecycle hooks** — the `pi.on(event, handler)` registrations that are an
extension's other main coupling point to pi.

An extension author wiring a hook has **zero signal** that it registered or
fired: a typo'd event name, a factory-time throw before `pi.on(...)`, or a
load-order miss silently disables the handler with no diagnostic. This is the
single highest-frequency unguarded failure mode for extension development
(classified **HIGH** impact in the predecessor map, cold-set).

## What's settled (source-verified, pi 0.82.0)

### The SDK already aggregates hooks in a readable form

- `createExtensionAPI(extension, runtime, …)` — the per-extension
  `on(event, handler)` pushes into `extension.handlers`, a `Map<event,
  handler[]>` **on the extension object**. (`on` is a per-instance closure, so
  wrapping power-tool's own `pi.on` captures only its own — that approach is
  rejected.)
- `ExtensionRunner` (runner.js:121, 149) holds `this.extensions` — **all**
  loaded extension objects.
- Dispatch (runner.js:371, 572) walks `for (ext of this.extensions) handlers =
  ext.handlers.get(eventType)`.

→ The full hook inventory is already aggregated on the runner. **No
instrumentation race, no load-order dependency** — reading it at tool-call time
sees every extension.

### The feasible approach (proven pattern in this codebase)

Extend `sdk-patch.ts`'s `createContext` polyfill — which **already captures
`this` (the runner)** — to also expose a `getHooks()` on the tool ctx, mirroring
the existing `getSystemPromptOptions()` polyfill. `inspect_hooks` reads
`runner.extensions[].handlers`.

## Design decisions (resolved 2026-07-25)

### D1 — Contract: fact-finder, not a linter (mirror `inspect_extensions`)

`inspect_hooks` is a **deterministic fact-layer**: it reports what hooks are
registered (and later, fired), with conservative severity. It does NOT make
context-dependent "does this hook matter here?" judgments — that stays the
`extension-auditor` subagent's job (the established layering from the
extension-analyzer PRD). This keeps the tool's output stable, cheap, and
JSON-consumable by the subagent — the same contract `inspect_extensions` holds.

It MAY emit **objective** findings (a fact, not a judgment) — see D4.

### D2 — Surface: every registered event, grouped by extension (default)

List **all** registered events (not a curated "high-value subset") — a
fact-finder's job is to show what IS registered, including the typo'd one.
Curating would hide the exact bug the tool exists to catch.

- **Default grouping:** by extension → each extension's registered events with
  handler counts.
- **`by_event: true`:** reverse view — by event → which extensions registered it
  (useful for "who listens on `before_agent_start`?").
- **Known-events reference set:** maintain pi's canonical event list (derived
  from the SDK's `on()` overload signatures — ~40 types: `session_start`,
  `before_agent_start`, `tool_execution_start`/`_end`, `turn_end`, `context`,
  `message_*`, etc.) to power the unknown-event check (D4). Versioned with the
  SDK; if an event is added upstream, the list updates.

### D3 — Output: text report + JSON mode (mirror `inspect_extensions`)

Text report: header → summary line → (default) per-extension sections
(`event → count`) OR (`by_event`) per-event sections (`extension → count`) →
objective findings section → optional phase-2 firing detail.

`return_json: true` → `{ extensions: [{path, hooks:[{event,count,fired?}]}],
findings: Finding[], summary }` — same shape contract as `inspect_extensions`'s
JSON, so the `extension-auditor` subagent consumes both uniformly.

### D4 — Objective findings (fact-layer checks, severity-ranked)

Reuses the shared `Severity` framework (`high`/`medium`/`low`/`info`) from
`inspect_extensions` / `inspect_pathology`.

| Phase | Sev | Check | Flags |
|---|---|---|---|
| 1 | 🟡 medium | `unknown-event-name` | A handler registered on an event NOT in pi's known-events set → almost certainly a typo / dead handler (it can never match the dispatch loop's real `eventType`). Medium, not high: allows for intentional forward-compat registrations. |
| 2 | 🟢 low | `never-fired` | A handler registered on a REAL event that did not fire this session → maybe just didn't occur, maybe dead. Session-dependent; low. |
| — | ℹ️ info | `hook-stats` | N extensions, M hooks registered, K unique events — awareness only, never actionable (mirrors `session-stats`). |

No `no-hooks` finding (an extension registering zero hooks is fine — info at
most, likely omitted like `no-guidelines`).

### D5 — Phasing

- **Phase 1 (ships first): registration listing + `unknown-event-name` check.**
  Reads the aggregate only — **zero handler-wrapping, zero runtime behavior
  change.** Lowest risk, delivers the core value (did my handler register / did
  I typo the event).
- **Phase 2: firing counts + `never-fired` finding.** Wraps each handler with a
  counter at the same `createContext` patch point
  (`orig => (...a) => { count++; return orig(...a) }`). Negligible overhead.
  Adds the highest-signal combined finding: registered-but-never-fired.

This spec + writing-plans covers **phase 1**; phase 2 is a follow-up plan under
the same effort (the patch point is shared, so the scaffolding lands once).

### D6 — `getHooks()` polyfill: independent graceful fail

The `sdk-patch.ts` `createContext` wrapper already adds `getSystemPromptOptions()`
+ `getSystemPrompt()`. Add `getHooks()` as a **separate**, independently
`try/catch`-guarded addition — if it can't reach `runner.extensions` (SDK
restructured), `inspect_hooks` reports *"hooks unavailable (SDK context shape
changed)"* and **does not** take `inspect_context` / `inspect_extensions` down
with it. Mirrors sdk-patch's existing warn-and-skip discipline.

## Tool signature (phase 1)

```ts
defineTool({
  name: "inspect_hooks",
  description: "List every loaded extension's registered lifecycle hooks " +
    "(pi.on handlers) — which events each extension listens on, handler counts, " +
    "and any handler registered against an unknown event name (likely a typo / " +
    "dead handler). Fact-finder companion to inspect_extensions. Phase-2 adds " +
    "firing counts.",
  parameters: Type.Object({
    by_event: Type.Optional(Type.Boolean({ description: "Group by event instead of by extension (who listens on X?)" })),
    return_json: Type.Optional(Type.Boolean({ description: "Machine-readable JSON instead of text report" })),
    self_test: Type.Optional(Type.Boolean({ description: "Deterministic mock output, no live session" })),
  }),
})
```

## Out of scope (carried from the predecessor map)

- **LLM-judged pathology** (goal-drift) — different destination (agent
  self-monitoring), blocked on offline-local-model architecture.
- **Tool-Search lazy dispatcher for `inspect_*`** (candidate D) — closed/rejected.
- **Phase-2 firing observability** — designed here (D5) but built as a follow-up
  plan; this spec's writing-plans covers phase 1 only.

## Files (phase 1)

| File | Action | Notes |
|---|---|---|
| `pi-agent-ext-power-tool/src/sdk-patch.ts` | EDIT | Add `getHooks()` to the `createContext` polyfill — independent try/catch, reads `runnerThis.extensions[].handlers`. Also extend the module-augmentation `declare module` so the type is visible without casts. |
| `pi-agent-ext-power-tool/src/tools/inspect-hooks.ts` | NEW | The tool. Pure `analyzeHooks(input)` + `formatHooksReport(findings)` (mirror `analyzeExtensions`/`formatExtensionReport`) so it's unit-testable without the SDK. Registered from the factory. |
| `pi-agent-ext-power-tool/src/index.ts` | EDIT (1 line) | `pi.registerTool(makeInspectHooksTool(getHooks))` in the factory — **do NOT inline the tool body here** (index.ts is already 1,241 lines / 50 KB). |
| `pi-agent-ext-power-tool/src/__tests__/inspect-hooks.test.ts` | NEW | Pure-logic tests over a fake `extensions[].handlers` fixture: grouping both ways, `unknown-event-name` detection, JSON shape, `self_test` deterministic output. |
| `pi-agent-ext-power-tool/README.md` + `PRD.md` | EDIT | Document the new tool + the known-events reference set. |

## Verification (phase 1)

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test )          # incl. new inspect-hooks tests
bun bun-apps/pi-agent/src/cli.ts -p "call inspect_hooks"     # against the real repo's extensions
bun bun-apps/pi-agent/src/cli.ts -p "call inspect_hooks by_event=true"
bun bun-apps/pi-agent/src/cli.ts -p "call inspect_hooks return_json=true"
```

Success criteria:
- Every loaded extension's registered events + counts are listed (default:
  grouped by extension).
- A deliberately-typo'd `pi.on("before_agent_starts", …)` (stray `s`) surfaces
  as an `unknown-event-name` finding (it's not in the known-events set).
- `getHooks()` failure path: if the polyfill can't reach `runner.extensions`,
  `inspect_hooks` returns *"hooks unavailable"* and `inspect_context` still
  works (independent degradation — D6).
- `self_test=true` returns deterministic mock output (no live session), mirroring
  the other inspect tools.
