---
type: grilling
status: closed
blocked by: [00]
claimed: pi-session-2026-07-23
---

## Question

**Scrutinize and slim the three large `_help` schemas** — `flux2_help` (307 tok), `ltx_help` (316), `movie_help` (284) = **~907 tok** paid on every fired turn for those gates. Ticket 00 established the split is worth keeping (neutral-to-beneficial), but these three `_help` tools carry substantial *parameter* schemas whose necessity is unexamined. Decide per tool: is the schema earning its keep, or is it bloated/redundant with `main`?

**Method (per `_help` tool).** Open the tool definition (e.g. `bun-apps/pi-agent-ext-flux2/extensions/flux2.ts:354`). The `_help` tool's job is to *return detailed guidance at call time* — its own schema should be tiny ("ask for help about X"). If its `parameters` carry large option enums or its `description` duplicates `main`'s, that's slimmable without losing the on-demand-help behavior. Compare against the lean `_help` shapes: `krea2_help` (82 tok), `obsidian_help` (52) — those are the target profile.

**Resolve by grilling:**
1. For each of the three, is the large schema from `description` (prose) or `parameters` (TypeBox)? Prose → trim to a one-liner + defer detail to the response. Parameters → are the options actually needed pre-call, or could they move into the help *response*?
2. Is there a shared `_help` schema template these three drifted from? If so, fix at the template level (prevents regression).

**Acceptance.** Each slimmed `_help` ≤ ~120 tok (krea2_help's profile); `bun run qa:savings` per-gate numbers drop accordingly; no behavior change (the help *response* content is untouched — only the tool's own schema). Cross-check the 07-08 "MEASURE first" rule: re-run the split delta after slimming to confirm the split still pays.

**Lower priority than 04** (04 is ~1,104 tok pure win; this is ~907 tok of scrutiny work with behavior-preservation risk). Sequence after 04.

## Resolution (2026-07-23)

**Done — COMMAND_ENUM duplication removed; −533 tok; all green; no behavior change.**

**Root cause of the bloat.** All three `_help` tools declared `command: Type.Optional(COMMAND_ENUM)` — but the **main** tool (`flux2`/`ltx`/`movie`) ALREADY carries the full `command: COMMAND_ENUM` in its own schema, and main + `_help` are always co-active (gated together, or self-promoted together). So the enum in `_help` was a **pure duplicate**. Replaced with a free `Type.String` whose description points at the main tool's enum; the runtime `Unknown command → known list` fallback was already in place, so no execute-path change.

**Measured (`qa/research-cost.ts`, per-tool `(desc+params)/4`):**

| _help | before | after | Δ |
|-------|-------:|------:|---:|
| flux2_help | 307 | 144 | −163 |
| ltx_help | 316 | 147 | −169 |
| movie_help | 284 | **83** | −201 |
| **total** | | | **−533** |

`movie_help` hit the ≤120 target (83 ≈ krea2_help's 82). `flux2_help`/`ltx_help` landed at 144/147 — the residual is the **retained `topic: HELP_TOPIC_ENUM`** lookup (a `_help`-only feature krea2 lacks: scene-pipeline/self-improve, native-vs-prod/shot-language); the COMMAND_ENUM dedup was the bulk. Gutting `topic` too would net only ~−5 tok each (the enum is ~30 tok, the free-string replacement ~25) — not worth losing the feature, so kept deliberately.

**Verification (all green):** `bun test` flux2 133/0 · ltx 160/0 · movie 716/0 · tool-gate 189/0; `bun run qa --strict` GREEN (0 task-breaking). No behavior change: help *responses* untouched; main tools still expose the command enum. **Split still pays (ticket 00 invariant) — strengthened**, since the `_help` side is now smaller.

**Important nuance — where this saving lands.** `qa:savings` ON-startup (7,637) is **unchanged** because these `_help` tools are gated-dormant at session start; the SAVED % even dipped (48.1% → 46.1%) only because the OFF baseline shrank too (less to gate). The −533 pays off **when a gate fires**, and — per the discovery below — **every turn at runtime if the self-promotion (ticket 06) keeps flux2/ltx always-active**.

**Discovery → graduates ticket 06.** flux2 + ltx extensions self-promote to always-active in their own `session_start`, potentially defeating tool-gate's flux2/ltx gates at runtime. If confirmed, 05's −533 is a per-turn runtime win AND the self-promotion removal could recover ~1,509 tok more — see ticket 06.

**Files changed:** `pi-agent-ext-flux2/extensions/flux2.ts`, `pi-agent-ext-ltx/extensions/ltx.ts`, `pi-agent-ext-movie-director/extensions/movie-director.ts` (each: `_help` `command` param COMMAND_ENUM → free `Type.String`).
