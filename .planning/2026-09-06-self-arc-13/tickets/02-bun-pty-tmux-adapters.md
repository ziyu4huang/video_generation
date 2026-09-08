---
id: t02
effort: 2026-09-06-self-arc-13
status: open
phase: 1 — build
estimate: M
depends: t01
---

# t02 — bun-pty (script(1) raw lane) + tmux adapters

## Goal

The two alternative screen lanes, each green on `boot-to-ready` + `trivial-ask` against
the deployed launcher, with their quirks documented as evidence (snaps + adapter headers)
and fog resolved in the map.

## Scope

- `adapters/bun-pty.ts` (D1): `Bun.spawn(["script","-q","/dev/null", <sh>], …)` with
  plain stdio pipes — NO Bun terminal API anywhere in this adapter. Bytes flow through
  the same `screen.ts` xterm-headless stack. Investigate + document: CRLF translation,
  relay pacing (does the 64B rule need to apply to our stdin, or only the xterm feed?),
  exit-status propagation, `-q` semantics on macOS BSD script. If the lane is unusable,
  invoke D1 arbitration: mark N/A with receipt evidence, do not reinterpret.
- `adapters/tmux.ts`: `tmux new-session -d -x 120 -y 40 -s bench13-<ts> <sh>` (+ scratch
  tmux.conf: `default-terminal xterm-256color`, `remain-on-exit on`), drive via
  `send-keys -l`, read via `capture-pane -p` (plain-text latches) or `-p -e` fed to
  xterm-headless — pick one, record why in the adapter header. Settle = D4 screen
  semantics PLUS two consecutive stable captures ≥300 ms apart. Precedent:
  `scripts/tui-e2e-lane.ts:77–142` (send-keys/capture/new-session/extended-keys/kill-session;
  exit-2 SKIPPED pattern when tmux missing — reuse it).
- Both adapters: same `env.ts` scratch seeding + ZAI key injection; `evidenceLanes`
  descriptors filled for the capability matrix.
- Unit tests (no LLM): tmux capture-diff settle logic against synthetic churn fixtures;
  script(1) arg builder; CR-stripping helper.

## Done-when

- Per lane: deployed `--case boot` + `--case trivial-ask` receipts PASS (or bun-pty N/A
  with evidence per D1 arbitration) under `output/bench13-<tech>-*/`.
- Quirk findings appended to the map (Fog of war resolutions): tmux settle verdict,
  script(1) behavior notes.
- Gates green (ext-subagent full set; devops untouched this ticket).

## Out-of-scope

rpc lane, matrix run, any change to tui-e2e-lane.ts (precedent is read-only).
