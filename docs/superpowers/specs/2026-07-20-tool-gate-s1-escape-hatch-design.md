# Tool-Gate S1 — Escape Hatch + Coverage + Telemetry (design)

- **Date:** 2026-07-20
- **Status:** Design (awaiting plan)
- **Scope:** `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts`
- **Sub-project:** S1 of three (S1 → S2 keyword precision → S3 full telemetry)

---

## 1. Context

A code review of `pi-agent-ext-tool-gate` surfaced a categorized issue list. The user
selected three categories to fix; this spec covers **S1** (correctness holes), with a
minimal telemetry stub baked in so the highest-risk issue becomes measurable.

The Dynamic Tool Gate keeps heavy domain tools (flux2, ltx, krea2, movie, …) out of the
API tool schema until a prompt keyword activates them, then keeps them active (sticky) for
the rest of the session. This saves ~8.5k tok/req on paper. The issues S1 addresses:

| ID | Issue | Severity |
|----|-------|----------|
| **A** | Dormant tools are invisible to the model. If a prompt hits no keyword, the model can never select the right tool — there is no recovery path. | HIGH (structural; see §2.5 for observed-impact evidence) |
| **B** | `movie` / `movie_help` are not in `CORE_TOOLS` or any `GATE`. Fail-open ⇒ the heaviest orchestrator tool is always active, saving nothing. | HIGH |
| **C** | `inspect` gate keywords `"context"` / `"token"` / `"debug"` match almost every dev conversation ⇒ inspect is effectively always-on; its 770 tok "saving" never materializes. | HIGH |
| **D** | `allToolNames` is captured once at `session_start` and never refreshed ⇒ dynamically-registered or renamed tools silently fall through fail-open. | MED |
| **G** | Banner `saved` sums `savedTokens` for every gate whose tools aren't active — including tools not even loaded this session (phantom over-report). | MED |

### 1.5 Evidence gathered during design (not speculation)

- **Prefix-cache cost of per-turn `setActiveTools` is ≈0.** Multi-entry prefix cache proven on
  both z.ai cloud and LM Studio/MLX local (2026-07-08/09, captured in project memory). The
  "per-turn tool-toggle invalidates the cache" fear is moot. ⇒ per-turn re-evaluation is free.
- **`savedTokens` are STALE.** `schema-cost` measured `flux2 = 654 tok` on 2026-07-20;
  `tool-gate.ts` hardcodes `1411`. Concrete proof that the headline savings numbers drift.
  S3 will replace all hardcoded values with measured ones; S1 only adds the movie value and
  flags the rest as stale.
- **Observed-impact of A: no smoking-gun incident found** in indexed session history. The
  problem is structural-but-latent (the model silently uses a worse tool or gives up; the user
  may not notice). This justifies a **lightweight preventive** escape hatch plus telemetry to
  finally quantify the miss rate — rather than a heavy mechanism built on unmeasured assumptions.
- **Cross-extension tool-scope manipulation is real.** `pi-agent-ext-movie-director` already
  manipulates tool scope (`MD_TOOL_SCOPE_DENY`). The escape hatch coexists with it: it only
  ever *adds* to the active set (additive, sticky), never removes.

---

## 2. Design

### 2.1 Architecture overview

All changes in one file, `extensions/tool-gate.ts`:

1. A new always-on tool **`enable_tool`** registered via `pi.registerTool(...)`, added to
   `CORE_TOOLS` so it is never gated. Its `execute` closure captures the extension's `sticky`
   set, the current `allToolNames`, the most recent prompt, and `pi`, so it can activate
   dormant gates and call `pi.setActiveTools`. (The extension already stores `sticky` and
   `allToolNames` as closure vars; it additionally records the last prompt in a closure var
   updated each `before_agent_start`.)
2. Each `GATE` gains a one-line `description` field (used for intent matching and `list` output).
3. New **movie** gate (B); **inspect** keywords narrowed (C).
4. `allToolNames` refreshed every `before_agent_start` (D).
5. Telemetry to stderr by default, optional file via env (S3-lite, baked in); banner `saved`
   fixed to count only loaded tools (G).

### 2.2 The `enable_tool` tool

Always-on meta-tool — the escape hatch. Self-documenting: its `description` IS the prompt hint,
so no separate system-prompt injection is needed.

| Field | Value |
|-------|-------|
| `name` | `enable_tool` |
| `promptSnippet` | `Enable a gated heavy tool (video/image/movie/...) by intent or name.` |
| `description` | Explains gating + three usage modes (`intent` / `name` / `list`) with per-gate examples (video→ltx, image→flux2, orchestrate→movie). States: "If you need a capability not in your tool list, call this first." |
| `promptGuidelines` | 1–2 lines, kept minimal because the tool is permanently active (permanent cost must stay low). |
| `parameters` (TypeBox) | `intent?: string`, `name?: string`, `list?: boolean` — exactly one of the three (validated in `execute`). |

**`execute(toolCallId, params, signal, onUpdate, ctx)` flow** — wrapped end-to-end in
`try/catch`; the escape hatch must never throw:

1. `list: true` → return the currently **dormant** gates (those whose `names` are not all in
   `sticky`) with each gate's `description` + `keywords`.
2. `name: "ltx"` → find the gate containing that tool name → activate.
3. `intent: "做個會動的版本"` → lowercase substring match against every gate's
   **keywords only** (not description — see §2.3). **Match rule: a gate matches if
   any keyword is a substring of the intent; all matching dormant gates are
   activated** (no fuzzy scoring or threshold — activation is sticky, so
   over-activation is harmless and the rule stays trivially testable).
4. **Activate(gate)** = `gate.names.forEach(n => sticky.add(n))` for each matched gate, then
   `pi.setActiveTools(computeActiveTools(lastPrompt, allToolNames, sticky))`.
5. Return a structured `AgentToolResult`: which tools were activated, and a usage hint.
6. **No match** → non-error result: `"no dormant tool matched '{intent}'. Call enable_tool
   with list:true to see available tools."`

**Activation timing (see §2.6).** Returns a message worded for both cases: "✓ activated
ltx, ltx_help — they are available now (this turn if the runtime refreshes tools per
iteration; otherwise on your next message)."

### 2.3 Intent matching — new pure function `matchIntent`

To keep this unit-testable and independent of `pi`, extraction:

```ts
export function matchIntent(
  intent: string,
  gates: ToolGate[],
  sticky: Set<string>,
): ToolGate[]   // dormant gates whose KEYWORDS substring-match the intent; declaration order (empty = no match)
```

Lowercase substring match over **keywords only**; a gate is "dormant" iff
`!gate.names.every(n => sticky.has(n))`. This is the seam the tests target
(e.g. `"make a video" → ltx`, `"generate an image of a cat" → flux2`,
`"describe this picture" → file2md`).

**Why not keywords∪description?** Description-word matching was prototyped and
rejected during plan verification: prose words like `image`/`pipeline` appear in
several gates' one-line descriptions and over-match (krea2 fired on an image
intent via the word "image" in its description; movie fired on a workflow intent
via "pipeline"). The curated `keywords` list is the right match surface; `description`
stays valuable for the human-readable `list` output (§2.2 step 1) and a future
semantic matcher, but not for substring matching.

### 2.4 Gate data changes

**B — new movie gate** (keywords chosen to avoid the over-broad single-word trap; phrase-y
where useful):

```ts
{
  names: ["movie", "movie_help"],
  keywords: ["movie", "montage", "orchestrat", "preflight", "compose",
             "storyboard", "分鏡", "剪輯", "影片製作", "導演"],
  description: "Movie orchestrator — idea→script→scene→assets→edit→compose pipeline",
  savedTokens: MEASURE_AT_IMPL_STEP_1,  // run schema-cost full report, record movie's tok here
}
```

**C — inspect narrowing.** Remove the over-broad `"context"`, `"token"`, `"debug"` (they fire
on nearly every dev turn). Keep/narrow to: `"inspect"`, `"schema cost"`, `"pathology"`,
`"extension health"`, `"工具開銷"`, `"context window"`, `"token usage"`. Effect: inspect
becomes genuinely dormant unless the user wants introspection.

> **Note on S2:** broader keyword precision (word boundaries for `image`/`video`/`pdf`, CJK
> expansion) is deferred to S2. S1 only narrows the inspect gate because that gate is
> effectively dead weight today; the others' false-positives are handled by the new escape
> hatch as a safety net.

### 2.5 Activation timing — residual uncertainty, designed to be correct either way

The "same-turn" claim depends on whether the (externally-injected) agent core calls
`agent.prepareNextTurnWithContext` **per model iteration** within a user turn, or only between
user turns. Verified facts:

- `AgentSession._installAgentNextTurnRefresh` (agent-session.js:262) installs
  `prepareNextTurnWithContext`, which returns `tools: this.agent.state.tools.slice()` fresh.
- `setActiveToolsByName` sets `this.agent.state.tools` and rebuilds the base system prompt
  immediately.
- `before_agent_start` fires per user-turn (agent-session.js:887, inside per-turn message build).

The hook's shape (returns fresh tools + systemPrompt, named "prepareNextTurn") strongly implies
per-iteration refresh, **but** the `setActiveToolsByName` docstring "Changes take effect on the
next agent turn" leaves a per-user-turn reading open. The agent core is an injected dependency
not present in the readable dist, so this cannot be 100% confirmed by static reading.

**Design decision: the escape hatch is correct under both interpretations.**

- If per-iteration: model calls `enable_tool` → next iteration in the same turn sees the
  activated tools → model calls them immediately. (Best case.)
- If per-user-turn: `enable_tool` activates and returns a message asking the model to
  continue/restate; the tools are available on the next user message. (Acceptable fallback.)

**Implementation must verify which case holds** via a throwaway probe extension (dump to stderr
whether a tool registered mid-`execute` appears in the next iteration's tool list), per project
memory's "verify registration via a probe extension … NOT the model's self-report." The
`enable_tool` return message is worded to be accurate in both cases, so no rework is needed if
the fallback case holds.

### 2.6 D — `allToolNames` refresh

In `before_agent_start`, re-fetch `allToolNames = pi.getAllTools().map(t => t.name)` each turn
(cheap — registry read). `session_start` keeps its one-shot capture for the banner. This handles
dynamic registration and renamed tools (a renamed gated tool no longer silently falls through
fail-open).

### 2.7 Telemetry (S3-lite, baked in) + G fix

- **Sink:** stderr by default (observable in print/RPC, like the debug banner). Opt-in file via
  `TOOL_GATE_LOG_PATH=<file>` (append-only JSONL). Disable via `TOOL_GATE_LOG=0`.
- `ExtensionContext.cwd` is available (verified in types.d.ts:208) as a fallback for resolving
  a default path, but the default stays stderr to avoid polluting every project repo.
- **Entries** (one JSON per line):
  - `{kind:"turn", ts, turn, promptLen, gatesFired:[], dormantGates:[], activeCount, totalCount}`
    — every non-empty-prompt turn.
  - `{kind:"activate", ts, via:"intent"|"name"|"list", intent?, matchedGate?, activated:[]}`
    — every `enable_tool` call.
  - `{kind:"miss_candidate", ts, dormantGates:[], promptHead: <first 80 chars>}` — a turn with
    non-empty prompt, **no** gate fired, and ≥1 gate dormant. This is the A-risk signal the
    telemetry exists to quantify.
- **G fix:** banner `saved` is computed only over gates whose `names` intersect `allToolNames`
  (no phantom tools). The displayed number is still the theoretical max at `session_start`
  (acceptable; a live-updating banner is S3).

### 2.8 Error handling

- `enable_tool.execute` is fully `try/catch`'d; on any failure it returns an error string
  result, never throws (an escape hatch that crashes the turn defeats its purpose).
- Telemetry write failures are swallowed (non-essential).
- The existing banner stale-`ctx` guards (`try/catch` around both `setWidget` timers) are
  untouched.

### 2.9 Testing

- **Keep:** the 4 existing `computeActiveTools` tests + 4 banner tests (all still pass).
- **New unit — `matchIntent`** (S1-accurate; keyword narrowing of `image` is deferred to S2 per §2.4, so `matchIntent` uses the *current* keyword set): `"make a video" → [ltx]`; `"generate an image of a cat" → [flux2]`; `"describe this picture" → [file2md]`; `"orchestrate a montage" → [movie]`; `"docker image cleanup" → [flux2]` (**pins S1's over-broad `image` behavior** — S2 will flip this to `[]` via word boundaries); `"what's the weather" → []`; dormant-skip: with `ltx` already in `sticky`, `"make a video" → []`.
- **New unit — `enable_tool.execute` (mock `pi`):** activation mutates `sticky`; calls
  `pi.setActiveTools`; `list` returns only dormant gates; no-match returns a non-error result.
- **New unit — gates:** movie fires on `"分鏡"` / `"movie"`; inspect does **not** fire on
  `"debug the docker context"` but does on `"inspect extension health"`.
- **New unit — telemetry:** `miss_candidate` entry is emitted exactly when (non-empty prompt ∧
  no gate fired ∧ ≥1 dormant); format is valid JSONL.
- **New unit — allToolNames refresh:** a tool registered after `session_start` is reflected in
  the next turn's active computation.
- **Mutation guard:** a test that forces `enable_tool.execute` down an exception path MUST still
  yield a non-throwing error result (proves the `try/catch` is a guard, not decoration).

---

## 3. Correctness review (performed before writing this spec)

| Claim | Verdict |
|-------|---------|
| `before_agent_start` fires per user-turn incl. first | ✅ Verified (agent-session.js:887) |
| `pi.registerTool` exists; `execute` closure can capture `sticky`/`pi` | ✅ Verified (types.d.ts:874; JS closure over `let` bindings read live) |
| `enable_tool` stays always-active (registered + in CORE + in registry) | ✅ Verified (`setActiveToolsByName` only includes registry tools; name in CORE ⇒ in sticky) |
| Same-turn activation | ⚠️ Strongly implied; residual uncertainty — designed correct either way (§2.5) |
| `ExtensionContext.cwd` available for telemetry path | ✅ Verified (types.d.ts:208) |
| Per-turn `setActiveTools` cache cost | ✅ De-risked (multi-entry prefix cache, project memory) |

No design claim is left hanging on an unverified assumption; the one residual uncertainty has
an explicit fallback that requires no rework.

---

## 4. Out of scope (deferred)

- **S2 — keyword precision** (word boundaries, CJK expansion, narrowing `image`/`video`/`pdf`).
  The escape hatch is the safety net that makes deferring S2 safe.
- **S3 — full telemetry**: live-updating banner, replacing all `savedTokens` with measured
  values (the stale-flux2 evidence motivates this), per-session miss-rate dashboards.
- **H — cross-extension `setActiveTools` last-writer-wins:** not addressed here; the escape
  hatch is additive so it does not worsen H, but H itself needs a separate coordination design.

---

## 5. Next step

Invoke the **writing-plans** skill to turn this spec into an implementation plan (TDD: tests
for `matchIntent` and `enable_tool.execute` first, then the gate-data changes, then telemetry,
then the activation-timing probe verification).
