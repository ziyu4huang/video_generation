# CONTEXT — s2-agent-ext-tool-gate

> Domain model for the dynamic tool-gate extension. For usage / how-to see [README.md](./README.md); for architectural decisions see [docs/adr/](./docs/adr/).

## What it is

An always-on extension that **gates heavy domain tools** (image/video/movie/research/deploy generators — large API schemas, rarely needed in any one session) behind prompt keyword matching, keeping a lean, audited **core** always active. Purpose: cut the per-request tools-schema token overhead — **~22k → ~6.8k tok/req (~69%; gross ~15,186 saved)**, measured by `bun run qa:savings` (re-run it for live numbers; the figure drifts as the gate set changes).

The core is a **first-class, auditable gating contract** (wayfinder ticket 01): every gate family is declared once by id in the shared `GATE_DEFS` registry; tools reference it via `gating: { gate: "<id>" }` on their `ToolDefinition`. The always-active core was re-triaged (ticket 02) and diagnostics un-gated (ticket 06).

## Ubiquitous language

| Term | Meaning |
|---|---|
| **GATE_DEFS** | The shared gate registry (`@repo/s2-agent-core-interface`) — each family declared ONCE by id (`{ id, keywords?, requires?, description }`). Populated by the owning extension at module load. |
| **gate** | A co-firing family: one id, all sibling tools referencing it. `keywords` (triggers) + optional `requires` (noun∧verb co-occurrence) + `description`. |
| **core** | Tools whose `gating: { core: true }` makes them always active — file I/O, memory, HITL interaction, diagnostics. Never gated. |
| **sticky** | A per-session `Set<string>` accumulator (starts as a copy of core, keyed by `sessionManager.getSessionId()`). A fired gate adds its names; they **never leave**. |
| **tracked** | `core ∪ all gate names` — the set tool-gate explicitly manages. Untracked tools are always active (fail-open). |
| **fire** | A gate matches the prompt (keyword OR `requires` co-occurrence) → its names enter `sticky`. |
| **dormant** | A gate whose tools are not yet all in `sticky` — hidden from the active set. |
| **enable_tool** | The always-active escape-hatch tool: activates a dormant gate by `intent` / `name` / `list`. |
| **miss_candidate** | A turn that fired no gate but has ≥1 dormant gate — the dormant-tool miss-rate signal (logged when telemetry is on). |

## Architecture

**Per-turn pipeline** (the `session_start` + `before_agent_start` hooks):

1. `session_start` — **the one full rebuild**: discover tools → `buildEffectiveGates` → measure token costs → store per-session state. (Ticket 05: per-turn path does NOT rebuild.)
2. `before_agent_start` — `updateSticky(prompt, sticky, gates)` (**mutate**: fire matching gates → add names to `sticky`) → `filterActive(allToolNames, sticky, tracked)` (**pure**: keep untracked OR sticky) → `pi.setActiveTools(active)`.
3. `session_shutdown` — drop the session's gate state.

The **mutate/pure split** is deliberate: `enable_tool` calls `filterActive` directly — it must NOT re-evaluate gates against a stale prompt and silently activate unrelated gates (the F1 fix).

**Per-session state (ticket 05)** — one `SessionGateState` per session id: a parent session and its in-process subagent children (which skip `session_start`) each own independent `sticky`/gates; a child seeds its own on first `before_agent_start`.

**Sticky semantics** — fire-once, stays-active-for-the-session. A workflow using `flux2` must not lose the tool mid-task when a follow-up like *"make it bigger"* drops the trigger keyword.

**Fail-open** — any tool not in `tracked` is always active, so new tools from other extensions are never accidentally hidden.

**Introspection (ticket 06)** — tool-gate publishes a `__piToolGateStatus` seam (live per-gate fired/dormant + token cost + sticky); power-tool's `inspect_context` renders a "▶ Tool gate (live state)" section from it.

**Telemetry** (`emitToolGateLog`, opt-in via `TOOL_GATE_LOG=1` or `TOOL_GATE_LOG_PATH=<file>`): emits `turn` / `activate` / `miss_candidate` JSONL events. Quantifies the dormant-tool miss rate so the escape-hatch risk is measurable instead of invisible.

## Keyword matching (S2)

- **Single ASCII token** (`^[a-z0-9]+$`): word-boundary regex — `flux` matches "use flux" but not "conflux".
- **Multi-word phrase / CJK**: substring — Unicode word boundaries need a segmenter; phrases are specific enough.
- **`requires` co-occurrence**: for core nouns (`image`/`video`/`pdf`) whose bare form false-fires ("docker image", "video call") but whose recall on real intents ("generate an image") must survive — the gate fires only with ≥1 noun AND ≥1 verb.

## Boundaries

- **In scope**: the GATE_DEFS registry resolution, keyword/co-occurrence matching, the sticky lifecycle, the `enable_tool` escape hatch, the startup banner widget, telemetry, the `bun run qa` verdict harness.
- **Out of scope**: the gating MECHANISM (keyword/co-occurrence) is not redesigned here — a semantic/embedding or declarative-DSL redesign is a separate effort (settled by evidence in wayfinder ticket 00: keyword matching passes 46/46 must-fire + 20/20 gate-recall with zero task-breaking; a semantic fallback stays fog until `qa:miss` shows a real miss-rate). The gated tools themselves are owned by their own extensions; tool-gate only controls their visibility.

## Key files

- `extensions/tool-gate.ts` — all logic: `buildEffectiveGates` (id-referenced resolution), `matchesKeyword`/`gateFires`/`matchIntent`, `updateSticky`/`filterActive`, per-session state, `enable_tool`, telemetry, the banner, the `__piToolGateStatus` seam, the factory.
- `extensions/tool-gate-status.test.ts` + `extensions/tool-gate.test.ts` + `extensions/drift-guard.test.ts` + `qa/*.test.ts` — unit + guard + QA tests.
- `qa/run.ts` — the encoded verdict (`SAVINGS_FLOOR` ≥15%+2k, L1 intended-behavior corpus, `--strict` task-breaking gates + coverage). `bun run qa` is the CI gate (exits non-zero on regression).
- `@repo/s2-agent-core-interface` `src/gates.ts` + `src/tool-gating.d.ts` — the gate contract: `Gate` type, `GATE_DEFS` registry, `Gating` field type. **The single shared source of truth** — owning extensions populate `GATE_DEFS`; tool-gate resolves it.

## No-drift invariant

> **The gating MODEL is owned by this contract, not by docs.** `README.md` / `PRD.md` / `CONTEXT.md` describe the id-referenced `GATE_DEFS` contract + the re-triaged core — there is no hardcoded `GATES` array or `CORE_TOOLS` set anymore (both deleted in earlier rollouts). The `qa/savings-prose-lock.test.ts` + `qa/savings.test.ts` drift-band tests lock every savings figure in prose to `qa:savings` measurement. **Any change to the gate model (new declaration form, core re-triage, mechanism change) requires a docs ticket** — update these three files + the savings claim in the same change, or CI fails.

## Cross-extension notes

- `subagent` + `workflow` are **gated** (the cross-package `workflow` family), not core. Research (effort `2026-07-30-…`, ticket 00) found empirical friction ZERO — they fire on explicit prompts or the agent escape-hatches via the always-present `enable_tool`. Re-evaluate only if `TOOL_GATE_LOG` telemetry shows workflow-gate `activate` events.
- Registered as a dynamic extension in `bun-apps/s2-agent/run-dir/manifest.json`; standardized on `peerDependencies`.
