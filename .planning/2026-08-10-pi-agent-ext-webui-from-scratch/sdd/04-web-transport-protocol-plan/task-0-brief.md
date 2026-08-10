### Task 0 — Schema layer (`protocol.ts`) + TypeBox wiring

**Goal:** Land the schema foundation for the wire protocol — TypeBox schemas for both directions + the pure outbound frame-builder — so the deep module (`web-transport.ts`, Task 1) and the wiring (Task 3) build on schema-derived types. This is the only task that touches `package.json`. The mutex modules from ticket 03 stay **untouched**. Governing spec: `specs/04-web-transport-protocol.md` §4 (wire schema), §3 (`toWebFrame` purity / type-only `ExtensionEvent`).

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/package.json` (add `"typebox": "^1.3.7"` to `devDependencies`).
- Create: `bun-apps/pi-agent-ext-webui/src/protocol.ts`.
- Create: `bun-apps/pi-agent-ext-webui/tests/protocol.test.ts`.

**TDD test list (RED first — write every test before implementing):**
- `validateInbound` — accepts each valid agentic command (`prompt`/`steer`/`followUp` with `text`); accepts `abort` / `appexec` / `subscribe` / `unsubscribe`; **rejects** unknown type; rejects `prompt` without `text`; rejects `prompt` with non-string `text`; rejects `null` / strings / empty object.
- `toWebFrame` — forwards each stream event type intact (`message_start/update/end`, `turn_start/end`, `agent_settled`, `session_compact`, `session_before_compact`); forwards `tool_execution_*` with `toolName` + `details`; forwards `tool_result` `.details` **verbatim** (no field drop, nested objects preserved); maps an unknown-but-reachable event shape to a generic frame **without throwing** (forward-compat, spec §6).

**Implementation notes:**
- **Validation lib = TypeBox.** Spec §4 evidence: `typebox` appears across the pi ecosystem (`pi-agent` `scripts/lib/build-extensions.ts`, `src/doctor.ts`, `run-dir/resolve.ts`; `pi-agent-cli` `src/commands/schema-cost.ts`, `tools-metrics.ts`); repo-wide grep for `zod` returns zero. The package is published as **`typebox`** (v1.x — NOT legacy `@sinclair/typebox`), declared `"typebox": "^1.3.7"` in `pi-agent-cli/package.json`, and kept **external** in thin bundles (`pi-agent/scripts/lib/build-extensions.ts` `EXTERNAL[]`). webui declares it as a devDependency so its **own** `tsc` + `bun test` resolve it; at runtime inside pi-agent it resolves from the host.
- **TypeBox v1 API:** `import { Type, type Static } from "typebox"` for schemas; `import { Value } from "typebox/value"` for `Value.Check(schema, value)`. Define `InboundCommandSchema` as a `Type.Union([...])` over the agentic-with-text / abort / appexec / control shapes; derive `type ClientFrame = Static<typeof InboundCommandSchema>`.
- **Keep `protocol.ts` pure — no I/O, no `Bun`, no runtime pi.** The reachable `ExtensionEvent` union is mirrored as a **structural** `interface EventLike { type: string; toolName?: string; details?: unknown; [k: string]: unknown }`. This is the type-only reference that erases at compile time (spec §3) — `protocol.ts` never imports `@earendil-works/pi-coding-agent`.
- **`toWebFrame` must forward `.details` intact** (spec §2: `tool_result`/`tool_execution_end` carry typed `.details`; ticket 05/06 render them). Do NOT enumerate/whitelist detail fields — spread whatever the event carries.
- **`DispatchAction` lives here** (the union `parseCommand` returns — spec §3): `agentic { op, text?, source:"extension" } | appexec { op, … } | control { op }`.

**Seams produced (consumed downstream):**
- `WebFrame`, `ClientFrame`, `DispatchAction`, `EventLike`, `validateInbound`, `toWebFrame` → Task 1 (`web-transport.ts`) and Task 3 (`extensions/webui.ts`).

**Acceptance criteria:**
- `( cd bun-apps/pi-agent-ext-webui && bun test tests/protocol.test.ts )` green.
- `( cd bun-apps/pi-agent-ext-webui && bun run build )` exits 0; `dist/protocol.{js,d.ts}` emitted.
- `grep -nE "from \"bun\"|from \"@earendil" src/protocol.ts` returns nothing (purity).
- `typebox` is resolvable from the package (`bun-apps/pi-agent-ext-webui/node_modules/typebox` exists after `bun install`).

**Pitfalls:**
- Import specifier is **`"typebox"`**, never `"@sinclair/typebox"` (that is the pre-v1 name and will not resolve).
- Do NOT import the SDK `ExtensionEvent` at runtime — only the structural `EventLike`. A runtime import would break the purity invariant and the Path-B migration seam.
- Do NOT drop unknown fields on `toWebFrame` — ticket 05/06 depend on `.details` fidelity. The forward-compat branch (unknown `type`) must not throw.
- The mutex modules (`mutex.ts`, `mutex-controller.ts`) are **consumed**, never edited, in this task.
