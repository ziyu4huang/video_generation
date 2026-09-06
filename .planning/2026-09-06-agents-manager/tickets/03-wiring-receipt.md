# 03 — wiring, guards, tui-drive receipt

## Done when
- Command registered with a description consistent with /subagents; shadow
  check (host builtin claiming `/agents` → fall back `/agent-types`,
  recorded in the map's fog-of-war).
- tui-drive gains `--scenario agents`: seeds a scratch project with one
  `.pi/agents/probe.md`, opens `/agents`, asserts the grouped row renders,
  enters detail, creates a second definition via the form, edits it,
  deletes it — receipt.json pass gates on those checks.
- Real-pty receipt run against BOTH the source tree and the deployed
  `current` (the loop's develop→deploy→drive receipt discipline).
