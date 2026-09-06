# 02 — ctrl+o discoverability on the live collapsed row (G6)

## Done when
- The collapsed streaming partial's second line reads
  `↳ 12.3s elapsed · 4 tool calls · ctrl+o to expand` (hint appended at the
  display seam in renderSubagentResult's isPartial branch — the shared
  formatSubagentProgress stays untouched; other callers unaffected).
- Hint suppressed on narrow widths (< 60 cols).
- Real-pty receipt shows the hint while a subagent runs.

## Why
CC renders "(ctrl+o to expand)" next to live agent rows; s2's expand affordance
was only in pi's global hint bar, so users (and the emulated-human driver)
could not discover the live trace.
Note: elapsed+tool-calls already live on the collapsed row (G2 closed by prior
wave — verified in the probe snapshots, `↳ … elapsed · N tool calls`).
