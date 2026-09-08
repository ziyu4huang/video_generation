---
id: t03
effort: 2026-09-06-self-arc-13
status: open
phase: 1 — build
estimate: M/L
depends: t01
---

# t03 — rpc adapter (`--mode rpc`, JSONL protocol)

## Goal

The structured lane: spawn the deployed launcher with `--mode rpc`, speak the JSONL
protocol, and prove boot/state/prompt-roundtrip/subagent-dispatch with protocol evidence —
plus an explicit, evidence-backed list of TUI surfaces this lane cannot reach.

## Scope

1. **Discovery FIRST** (learning: verify the deployed artifact, not the label): spawn
   `<sh> --mode rpc`, send `get_state`, capture ≥20 real response/event lines; commit
   them as `tests/fixtures/rpc/deployed-samples.jsonl` + a short
   `rpc-protocol.notes.md` (message envelopes, event names, turn-completion signal,
   notification event for background children — or their absence). Reconcile against the
   upstream recon list (map Context); divergences recorded, not assumed away.
2. `adapters/rpc.ts`: line-delimited JSON framing (id counter, pending-response map,
   event fan-out), child env with ZAI key, no tty assumptions.
3. Cases via protocol evidence (spec §3 rpc column):
   - boot: process up + first `get_state` success;
   - trivial-ask: `prompt` roundtrip → turn-completion event → `get_last_assistant_text`
     contains the sentinel;
   - state-probe: `get_state` model field = glm-5.3 (flash BY NAME = FAIL, D5);
   - subagent-dispatch: dispatch via prompt; await completion notification event OR
     `get_entries` delta. If run-dir extensions do not load under rpc (probe: does the
     seeded hard-problem agentType resolve?), record N/A with evidence (D8) — that is a
     capability-matrix cell, not a failure;
   - tui-gesture: `verdict: "unreachable"` receipt listing the TUI-only surfaces
     (/subagents viewer, /workflows navigator, task panel rows, wf badge glyphs).
4. Unit tests on the committed fixtures: line parser, envelope routing, timeout paths.

## Done-when

- Deployed receipts under `output/bench13-rpc-*/`: boot + state-probe + trivial-ask PASS;
  subagent-dispatch PASS or N/A-with-evidence; tui-gesture unreachable-receipt present.
- `rpc-protocol.notes.md` + fixtures committed; divergences from upstream recon listed.
- Gates green (ext-subagent full set).

## Out-of-scope

matrix run; any rpc-mode behavior change (deployed tree is read-only — D9).
