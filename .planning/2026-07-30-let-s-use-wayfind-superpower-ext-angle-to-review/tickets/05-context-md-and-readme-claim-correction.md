## Question

Bring tool-gate's surface docs up to the wayfind/superpowers bar:

1. **Write `CONTEXT.md`** — the domain model the package currently lacks: the
   CORE_TOOLS set, the GATES (names + trigger model: keyword vs `requires`
   co-occurrence), the sticky lifecycle (fire-once-stays-active), the
   `enable_tool` escape hatch, the `TOOL_GATE_LOG` telemetry kinds, and the
   savings measurement (`bun run qa`). One-stop orientation for any session
   entering the package.
2. **Correct the savings claim** — the prior QA measured **5,554 tok/req (38.6%)**,
   not ~8,500. Fix both (a) `README.md` and (b) the `extensions/tool-gate.ts`
   file-header comment (currently "saves ~8,050 tok/turn, ~48%" / "~8,600 ...
   saves ~8,050"). Use the measured number + cite `bun run qa:savings`.

**Acceptance:** `CONTEXT.md` exists + orients a fresh reader; the savings claim
matches `bun run qa:savings` output wherever it appears.

**type:** task
**claimed:** wayfind-session (2026-07-30) — ✅ CLOSED

## Resolution — done: CONTEXT.md + honest claim refresh (false premise corrected)

Wrote `CONTEXT.md` — the domain model the package lacked (ubiquitous language, per-turn pipeline, boundaries, key files). **Corrected a false premise:** verification (`bun run qa:savings`) showed the README claim was **not** overstated — current savings = 7,938 gross / 7,695 net (47.7% / 46.2%), only ~112 tok (1.4%) below the README's ~8,050; the prior QA's "5.5k" was stale (the tool set has grown since, *increasing* savings). Refreshed the README headline + code block + the `tool-gate.ts` header comment to the current numbers (kept the "re-run `bun run qa:savings` for live figures" note). The README was already honest (it defers to `qa:savings`); this is a precision refresh, not a correction of a real overstatement.
