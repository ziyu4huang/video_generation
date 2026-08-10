# 03 — Agentic mutex design

type: prototype
blocked by: 02
status: open

## Question

What is the precise design of the agentic mutex that makes web and TUI turns mutually exclusive while leaving pure app-logic lock-free — the `driver` state machine, blocked-side presentation, sibling-attribution, and failure modes (abort / crash / timeout)?

## Context (02 resolved — the gate is the `input` event, zero patch)

- **The gate**: `pi.on("input", handler)` fires for EVERY `prompt()` (TUI=`source:"interactive"`, web=`source:"extension"`, rpc=`source:"rpc"`) BEFORE the `isStreaming` guard (agent-session.js:814-826). `{action:"handled"}` BLOCKS the submission (prompt returns immediately, no turn); `{action:"transform"}` rewrites; `{action:"continue"}` passes through. The handler is the single chokepoint covering TUI + web + rpc uniformly — **no monkey-patch** (none of the 15 patches in `bun-apps/pi-agent/src/patches/` touch input/prompt).
- **The idle-race fix**: maintain a module-level `driver: "tui" | "web" | null` and check-and-set it **synchronously before the first `await`** in the handler — JS single-threading makes that atomic, so the losing submission returns `{action:"handled"}`.
- **Lock scope**: acquired on turn-injecting calls (`prompt`/`steer`/`followUp` via `sendUserMessage`) from EITHER side; NOT acquired by pure app-logic (pipeline / generation / local UI ops) — those never hit `prompt()`.
- **Attribution**: `event.source` gives sibling-attribution for free. Blocked TUI → `pi.ui.notify(...)` / status widget + `{action:"handled"}`; blocked web → WS response carries "TUI is driving". (Capture `source` in the handler if you need origin after `input` — downstream events carry none.)
- **Fallback**: the TUI already auto-routes Enter to `steer` when `isStreaming` (interactive-mode.js:2455) — but steering injects into the *other* frontend's turn; prefer explicit block/defer unless queued-steer is the desired UX.
- **Release / failure modes**: how is `driver` cleared — on `agent_settled`? `turn_end`? Tie release to a reliable terminal event + a watchdog (web-access's `setInterval(1000)` idle/stale pattern is a reference), NOT just the call's promise. Handle: `ctx.abort()`, crashed/errored turn, hung turn (timeout). `queue_update` is NOT observable from an extension (ticket 01) — if queue depth matters for the lock, that's a patch.

## What resolving looks like

A prototype of the `driver` state machine + two-side blocked presentation, with abort/crash/timeout release paths specified and tested. The riskiest piece — prototype early; it's the heart of the co-driving requirement.
