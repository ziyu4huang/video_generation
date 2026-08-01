---
type: prototype
claimed: pi-agent (2026-08-01)
status: closed
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

## Resolution (closed)

**Winner: Candidate A — per-turn injection (no trigger).** Implemented + merged (PR #979).

Candidate B was unreachable (ticket 02: `ctx` exposes no cheap prompt-rebuild handle — only `reload()`). Keeping both A+C was rejected: it would produce *conflicting* duplicate blocks on a mid-session language change (cached base holds the old block while per-turn prepends the new). So the cached `_rebuildSystemPrompt` wrap was **replaced** by a per-turn wrap — single source, no double-injection.

**Mechanism:** `wrapInstallAgentNextTurnRefresh` wraps `AgentSession.prototype._installAgentNextTurnRefresh` (called in every AgentSession constructor, `agent-session.js:156`) to re-wrap `this.agent.prepareNextTurnWithContext`, prepending the forced block on every turn (re-reading `settings.json` fresh). The `/response-language` command drops `ctx.reload()` — the next turn picks up the new block. Per-agent idempotency via a **function tag** (the original re-assigns the per-turn fn, so re-wrapping the untagged original beats a WeakSet skip).

**A/B result:** A wins on correctness + robustness + latency (the post-write step is now just a settings-file write — structurally near-zero vs `ctx.reload()`'s full runtime rebuild). Fallback (C) not needed. TDD; 92 patch + 26 extension tests green, typecheck clean.
