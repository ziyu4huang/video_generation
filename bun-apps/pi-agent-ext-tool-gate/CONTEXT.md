# CONTEXT — pi-agent-ext-tool-gate

> Domain model for the dynamic tool-gate extension. For usage / how-to see [README.md](./README.md); for architectural decisions see [docs/adr/](./docs/adr/).

## What it is

An always-on extension that **gates heavy domain tools** (image/video/movie/research/deploy generators — large API schemas, rarely needed in any one session) behind prompt keyword matching, keeping lightweight **core tools** always active. Purpose: cut the per-request tools-schema token overhead — **~22k → ~5.7k tok/req (~74%; gross ~16,290 saved)**, measured by `bun run qa:savings` (re-run it for live numbers; the figure drifts as the gate set changes).

## Ubiquitous language

| Term | Meaning |
|---|---|
| **CORE_TOOLS** | The always-active set (`read`/`write`/`edit`/`bash`/`memory`/`web_*`/`obsidian`/`zk_*`/… + `enable_tool`). Never gated. |
| **GATE** | A group: `names` (tools it controls) + `keywords` (triggers) + optional `requires` (noun∧verb co-occurrence) + `description`. |
| **GATES** | The array of all gates in `extensions/tool-gate.ts`. |
| **sticky** | A `Set<string>` accumulator (starts as a copy of CORE_TOOLS). A fired gate adds its names; they **never leave**. |
| **TRACKED_TOOLS** | `CORE_TOOLS ∪ all gate names` — the set this extension explicitly manages. Untracked tools are always active (fail-open). |
| **fire** | A gate matches the prompt (keyword OR `requires` co-occurrence) → its names enter `sticky`. |
| **dormant** | A gate whose tools are not yet all in `sticky` — hidden from the active set. |
| **enable_tool** | The always-active escape-hatch tool: activates a dormant gate by `intent` / `name` / `list`. |
| **miss_candidate** | A turn that fired no gate but has ≥1 dormant gate — the dormant-tool miss-rate signal (logged when telemetry is on). |

## Architecture

**Per-turn pipeline** (the `session_start` + `before_agent_start` hooks):

1. `updateSticky(prompt, sticky)` — **mutate**: fire gates whose keywords / co-occurrence match the prompt; add their names to `sticky`.
2. `filterActive(allToolNames, sticky)` — **pure**: keep a tool if it is untracked (fail-open) OR present in `sticky`.
3. `pi.setActiveTools(active)` — apply.

The **mutate/pure split** is deliberate: `enable_tool` calls `filterActive` directly — it must NOT re-evaluate gates against a stale prompt and silently activate unrelated gates (the F1 fix).

**Sticky semantics** — fire-once, stays-active-for-the-session. A workflow using `flux2` must not lose the tool mid-task when a follow-up like *"make it bigger"* drops the trigger keyword.

**Fail-open** — any tool not in `TRACKED_TOOLS` is always active, so new tools from other extensions are never accidentally hidden.

**Telemetry** (`emitToolGateLog`, opt-in via `TOOL_GATE_LOG=1` or `TOOL_GATE_LOG_PATH=<file>`): emits `turn` / `activate` / `miss_candidate` JSONL events. Quantifies the dormant-tool miss rate so the escape-hatch risk is measurable instead of invisible.

## Keyword matching (S2)

- **Single ASCII token** (`^[a-z0-9]+$`): word-boundary regex — `flux` matches "use flux" but not "conflux".
- **Multi-word phrase / CJK**: substring — Unicode word boundaries need a segmenter; phrases are specific enough.
- **`requires` co-occurrence**: for core nouns (`image`/`video`/`pdf`) whose bare form false-fires ("docker image", "video call") but whose recall on real intents ("generate an image") must survive — the gate fires only with ≥1 noun AND ≥1 verb.

## Boundaries

- **In scope**: the GATES set, keyword/co-occurrence matching, the sticky lifecycle, the `enable_tool` escape hatch, the startup banner widget, telemetry, the `bun run qa` verdict harness.
- **Out of scope**: the gating MECHANISM (keyword/co-occurrence) is not redesigned here — a semantic/embedding or declarative-DSL redesign is a separate effort. The gated tools themselves are owned by their own extensions; tool-gate only controls their visibility.

## Key files

- `extensions/tool-gate.ts` — all logic: `CORE_TOOLS`, `GATES`, `matchesKeyword`/`gateFires`/`matchIntent`, `updateSticky`/`filterActive`, `enable_tool`, telemetry, the banner, the factory.
- `extensions/tool-gate.test.ts` + `__tests__/tool-gate-banner.test.ts` + `qa/*.test.ts` — unit + QA tests.
- `qa/run.ts` — the encoded verdict (`SAVINGS_FLOOR` ≥15%+2k, L1 intended-behavior corpus, `--strict` task-breaking gates). `bun run qa` is the CI gate (exits non-zero on regression).

## Cross-extension notes

- `subagent` + `workflow` are **gated** (the `workflow` gate), not in CORE_TOOLS. Research (effort `2026-07-30-…`, ticket 00) found empirical friction ZERO — they fire on explicit prompts or the agent escape-hatches via the always-present `enable_tool`. Re-evaluate only if `TOOL_GATE_LOG` telemetry shows workflow-gate `activate` events.
- Registered as a dynamic extension in `bun-apps/pi-agent/run-dir/manifest.json`; standardized on `peerDependencies`.
