type: research

## Question

Does ANY path still inject a SECOND copy of the forced `<response_language>`
block, producing duplicate / competing blocks in one system prompt?

**Context (chart-time):**
- #979 dropped `ctx.reload()` from the `/response-language` command — it now
  only writes `settings.json`; the patch re-reads fresh each turn.
- The per-turn injection is **idempotent** (`WeakSet` per-proto + `WRAP_TAG`
  per-agent — the "idempotent per-agent" unit test is green). So the NEW
  mechanism itself can't double-up.

**Open question:** is there a SECOND, older source still active? Candidate sites:
- The prose rule still present in `AGENTS.md` / `CLAUDE.md` (low-priority
  `<project_context>` file) — does it emit a *forced block*, or just prose?
- Any residual `--append-system-prompt` / context-file path that injects the
  block text verbatim.
- An older append path the per-turn wrap superseded but didn't remove.

Resolve by reading the patch header's "previously lived as prose" claim against
the current context-file / append-system-prompt machinery (resource-loader.js +
the `--append-system-prompt` flow). **Outcome:** "no second source (closed)" or
"second source X still active → graduate a fix/mitigate ticket."
