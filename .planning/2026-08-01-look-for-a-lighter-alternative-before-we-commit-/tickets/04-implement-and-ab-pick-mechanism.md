---
type: prototype
claimed:
blocked by: [01, 02, 03]
---
## Question

Given the per-turn seam shortlist (01), the cheap-trigger reachability verdict (02),
and the session-type matrix (03): **implement the candidate mechanism(s) and A/B
pick the winner** — the lightest one proven correct across all session types.

### Approach

- Candidate A — **per-turn injection** (no trigger): wrap the winning seam from 01;
  the command drops `ctx.reload()` and only writes `settings.json`. Lightest.
- Candidate B — **cheap explicit trigger** (if 02 says reachable): replace
  `ctx.reload()` with the prompt-only rebuild handle.
- Candidate C — **baseline**: keep `ctx.reload()` (the fallback).

### A/B criteria (must satisfy "works for all")

1. **Correctness:** every session type in the 03 matrix flips to the new language
   as expected; `_systemPromptOverride` precedence + compaction survival preserved.
2. **Latency:** measured wall-clock of the command's post-write step — A and B must
   beat C meaningfully (C = full runtime rebuild).
3. **Robustness:** the patch is idempotent (WeakSet), survives reload, and degrades
   gracefully if the seam shape changes (mirrors `force-response-language.ts`).

### Resolve

Pick the winner; if neither A nor B is robust/correct, invoke the fallback (keep
`ctx.reload()`, document cost). Record the decision + the measured latencies.

### Deliverable

The chosen mechanism implemented in `force-response-language.ts` (or a new patch) +
the command updated; A/B table (correctness × latency × robustness) recorded here.
