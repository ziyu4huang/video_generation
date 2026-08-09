---
effort: 2026-08-02-improve-wayfind-tui
created: 2026-08-02
last: 2026-08-09
status: complete
---

# Wayfinder map: 2026-08-02-improve-wayfind-tui

> **Status: SEALED (2026-08-02)** — the original placement + history destination is fully decided and handed to `writing-plans` (see [Handoff](#handoff-to-writing-plans) below). Ticket [07](tickets/07-interactive-selectable-wayfind-widget.md) (interactive selectable widget) is scope expansion, **deferred to a future effort** — it seeds a fresh `.planning/<date>-wayfind-interactive-widget/` map when pursued.

## Destination

A clearer, more claude-code-like wayfind TUI, with every decision resolved so implementation is unambiguous:

- **Placement** — the composite status widget (`pi-core-task` = goal + loop + todo + wayfind) moved **below** the chat input via `placement: "belowEditor"`, visually confirmed to read better and not crowd the footer.
- **Input history** — the Up/Down history behavior audited against claude-code, with any gaps (cross-session persistence, trigger ergonomics, discoverability) decided and specified.

The map is done when the frontier is clear and someone can write a plan with no open decisions.

## Notes

**Skills every session consults:** `grilling`, `domain-modeling`.

**Decisive facts gathered this session (trust these — don't re-dig):**

- Input history **already works** — pi-tui `Editor` has `addToHistory` / `navigateHistory`; **Up** (on the first visual line / empty editor) recalls older prompts, **Down** (while browsing, on the last line) moves forward and restores the draft. `pi-tui/dist/components/editor.js:664-682`. This *is* the shell/claude-code pattern.
- History is **in-memory only** — no disk persistence anywhere in `pi-coding-agent/dist` (no history-file I/O). Per-session. Likely a gap vs claude-code.
- The "browse history" hint **exists** but only inside the keybindings help table (`interactive-mode.js:4850`: `Move cursor / browse history`), not in the startup hint strip.
- The composite status widget is **one key** (`pi-core-task`), hardcoded `{ placement: "aboveEditor" }` in `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts`. The one-key design **fixes a Map-insertion-order flicker bug** — do NOT split it into multiple keys.
- Core TUI layout, top → bottom: `chat → status → widgetContainerAbove → EDITOR (chat input) → widgetContainerBelow → footer (cwd/tokens)`. So `belowEditor` renders **between the input and the footer** — the claude-code-ish spot. The SDK's `setWidget` already accepts `widgetPlacement?: "aboveEditor" | "belowEditor"`.

**Standing preference:** changes land in `bun-apps/pi-agent-ext-*` via the extension / SDK surface. The core `pi-coding-agent` SDK is a compiled dep — don't edit it directly; a core change is a separate effort if required.

## Decisions so far

- [Move whole composite status below the editor](tickets/01-move-composite-status-below-editor.md) — placement path = flip `pi-core-task` to `placement: "belowEditor"`; keep the single key (do NOT split wayfind out — that re-opens the flicker bug).
- [History claude-code comparison](tickets/03-history-claude-code-comparison.md) — pi already matches claude-code's *intended* Up/Down trigger; real gaps are `Ctrl+R` reverse search + discoverability (don't "relax" the trigger — that's claude-code's bug).
- [History persistence status](tickets/04-history-persistence-status.md) — claude-code persists input history per-directory; pi doesn't (in-memory only). Real gap.
- [History persistence policy](tickets/05-history-persistence-policy.md) — **ship cwd-scoped persistence**: per-cwd `history.jsonl`, capture via the `input` event (exclude `!` bash), restore via a monkey-patch into `addToHistory` on `session_start`. Cap 100 + dedup. Implementation is a `writing-plans` handoff.
- [Prototype below-editor placement](tickets/02-prototype-below-editor-placement.md) — **verdict: keep `belowEditor`.** The composite (goal + loop + todo + wayfind) reads better between the chat input and the footer — the claude-code spot. The 1-line flip (`status-widget.ts:99`) stays as the implementation.
- [History trigger + Ctrl+R + hints](tickets/06-history-trigger-and-hints.md) — **keep the Up/Down trigger** (claude-code's straight-jump is a bug); **surface `↑/↓ browse history` in the startup hint strip** (lands via the patch flow; strip is compiled core); **defer Ctrl+R** reverse search; Ctrl+P/N aliases are dead (both keys taken in main mode).

## Not yet specified

- _(graduated)_ claude-code history parity → now [ticket 06](tickets/06-history-trigger-and-hints.md): `Ctrl+R` reverse search + startup discoverability hint.
- **Token-footer interaction.** If status-below-input crowds the footer (cwd/tokens), should the footer restyle or relocate too? Graduates from the [prototype](tickets/02-prototype-below-editor-placement.md).
- **Full-screen overlay collision.** Does `belowEditor` clash with the ask_user_question modal / model / theme selectors? Sharpens during the prototype.
- **Configurable history scope** (`historyScope`: cwd | session | global) — deferred from the persistence MVP ([05](tickets/05-history-persistence-policy.md) ships cwd-only); add the knob only if wanted.
- _(graduated from [02](tickets/02-prototype-below-editor-placement.md))_ **Interactive selectable wayfind widget** — cursor-down to focus the status block, Enter to open a wayfind detail panel. `setWidget` is render-only and the focus model is editor↔modal (no inline-widget focus), so this forks into inline-focus (core patch) vs keybind→detail-panel (feasible today) → [ticket 07](tickets/07-interactive-selectable-wayfind-widget.md). **→ deferred to a future effort** (scope expansion; this map sealed for placement+history).
- **Ctrl+R reverse-incremental history search** — deferred from [06](tickets/06-history-trigger-and-hints.md) (user took the cheap discoverability win). Ctrl+R is free in main mode; ~medium effort via the patch flow (search-mode overlay). Would also search the persisted history from [05](tickets/05-history-persistence-policy.md). Revisit if wanted.

## Out of scope

- Splitting wayfind into its own widget key — rejected by the placement decision (re-introduces the Map-insertion flicker bug).
- Rewriting the SDK widget registry for ordered multi-key widgets — only needed for the rejected split.
- A full claude-code UI clone beyond status placement + input history.
- Direct edits to the compiled `pi-coding-agent` SDK core.
- Ctrl+P / Ctrl+N as history aliases — both taken in main mode (`Ctrl+P` = model cycling, `Ctrl+N` = named session filter); can't rebind without disrupting core keys.

## Handoff to writing-plans

The placement + history destination is sealed with zero open decisions. Implementation units:

1. **Placement flip** ([01](tickets/01-move-composite-status-below-editor.md), [02](tickets/02-prototype-below-editor-placement.md)) — **DONE in the working tree**: `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts:99` flipped `aboveEditor`→`belowEditor`. No rebuild (jiti loads `.ts`). *Action: commit.* Acceptance: composite (goal+loop+todo+wayfind) renders between the chat input and the footer.
2. **cwd-scoped input-history persistence** ([05](tickets/05-history-persistence-policy.md)) —
   - *Capture:* extension hook on the `input` event (`InputEvent.text`, `source === "interactive"`); exclude `!` bash; append to per-cwd `history.jsonl` under the pi agent dir. Cap 100, skip-dup-of-most-recent.
   - *Restore:* monkey-patch in `bun-apps/pi-agent/src/patches/` to feed persisted entries into the editor's `addToHistory` on `session_start`.
   - Acceptance: prompts persist across restarts per-cwd; Up/Down recalls them; bash excluded; cap/dedup enforced.
3. **History discoverability hint** ([06](tickets/06-history-trigger-and-hints.md)) — add `↑/↓ browse history` to the startup keybinding hint strip (`interactive-mode.js:506-522`) via the patch flow (compiled core); hardcoded `keyHint` entry since Up/Down isn't a named keybinding. *Open implementation question for the plan:* does an extension hook to contribute startup hints exist (would avoid the patch)?

**Implementation surfaces:** `status-widget.ts` (done) · a persistence module (new — owner TBD: core-task ext vs a patch in pi-agent) · `bun-apps/pi-agent/src/patches/` (restore-to-editor + startup-hint patches). **Suggested sequence:** placement (commit) → hint (trivial) → persistence (capture + restore).

**Deferred (NOT in this handoff):** [07](tickets/07-interactive-selectable-wayfind-widget.md) interactive widget (future effort) · Ctrl+R reverse search · `historyScope` knob.
