type: task
claimed: wayfind-session (interactive, 2026-08-04)
status: closed
blocked by: 01-subagents-gate-or-alwayson, 02-sweep-branches-gate-or-alwayson, 03-memory-supersede-gate-or-alwayson, 04-await-pr-merge-gate-or-alwayson, 05-wayfind-effort-gate-or-alwayson

## Question

Apply the 5 gating declarations resolved in tickets 01–05 to their tool definitions, then run the strict QA and confirm the verdict is `✅ PASS` (i.e. `coverage.ungated.length === 0`).

Acceptance:
- Each tool's `gating:` field set per its ticket's resolution, at the file:line noted in that ticket.
- From repo root: `( cd bun-apps/pi-agent-ext-tool-gate && bun run qa --strict )` exits green.
- No new ungated heavy tool surfaces (corpus is fixed, so this should not happen; if it does, graduate a fresh ticket and leave this one open).

Resolution records: the final qa verdict line + the file changes applied (and commit hash if/when committed — committing is a separate, user-controlled step, not part of this ticket).

## Resolution

**Done — `bun run qa --strict` is GREEN** (2026-08-04):
```
✅ PASS — savings floor met + L1 intended-behavior holds
coverage:  0 ungated heavy tool(s) · 26 gated-heavy   [✅ --strict gates]
savings:   9,791 tok/req (52.1%)   L1: must-fire 40/40 · must-not-fire 24/24
```
The 5 gating declarations from tickets 01–05 were necessary but not sufficient: `qa/evaluate.ts` built its tracked set from a hard-coded registrar list that omitted devops/wayfind/memory_supersede, so those tools' source `gating:` was never read. Ticket 07 wired those registrars in (reversing the deliberate `memory_supersede` omission, required by the destination) + fixed the wayfind `package.json` exports map + added 6 L1 probe rows for the new gates. Two `bun test` failures remain as side-effects — tracked as tickets 08 (stale gate count) and 09 (sanctioned-savings prose drift), separate from this ticket's qa-green acceptance.

Source files changed (uncommitted, user controls commit): the 5 gating files (`subagents-tool.ts`, `devops.ts`, `memory-supersede-tool.ts`, `effort-tool.ts`) + `qa/evaluate.ts` + `pi-agent-ext-wayfind/package.json` + `qa/probes.ts`.
