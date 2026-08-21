# compact — Claude Code-style /compact for s2-agent

## Scope
Replaces the *summary content* of built-in /compact via the `session_before_compact`
hook. Cut point, session tree, and all failure handling stay with the host.

## Seams
- IN: `session_before_compact` event (preparation, customInstructions, reason, signal).
- OUT: `{ compaction: { summary, firstKeptEntryId, tokensBefore, … } }`; any error →
  `undefined` → host built-in compaction (verified: runner.js emit swallows throws).
- CONFIG: `BUN_PI_COMPACT=0` off; `COMPACT_MODEL=provider/id[:thinking]` override;
  `COMPACT_MAX_TOKENS_FACTOR` (default 0.8, clamped to [0.1, 1]).

## Invariants
- Never touch `firstKeptEntryId` / `tokensBefore` — reuse host preparation values.
- Files in "Files and Code Sections" come only from the deterministic
  `<verified-files>` extraction, never LLM invention.
- No "Done" without evidence (passing test or user confirmation).

## Decisions
See docs/adr/ when added; upstream lessons: docs/UPSTREAM-LESSONS.md.
