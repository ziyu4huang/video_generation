# s2-agent-ext-compact

The ubiquitous language of s2-agent-ext-compact — Claude Code-style `/compact` for s2-agent. The extension replaces only the *summary content* of the host's built-in compaction; every mechanical concern (cut point, session tree, failure handling) stays with the host. See README.md for knobs and the A/B harness.

## Language

**Compaction**:
The host operation that replaces a session's context with a summary at a cut point. Owned by the host; this extension customizes one input to it.
_Avoid_: summarization, truncation (compaction is the host's whole context-replacement operation, not the LLM call)

**Summary content**:
The markdown summary this extension produces — the ONLY thing it owns within compaction. Nine Claude Code sections ("Primary Request and Intent" … "Optional Next Step"), built by one LLM call over deterministic ground truth.
_Avoid_: the summary, the context (it is the CC-sectioned content block, not the whole compacted context)

**Preparation values**:
The cut-point facts the host computes before the hook runs (first kept entry, tokens before). Reused verbatim by the summary; never recomputed or touched.
_Avoid_: metadata, state (they are host-owned authoritative values with exactly one source)

**Verified files**:
The file/code references extracted deterministically from actual tool calls in the kept session span. The only permitted source for the "Files and Code Sections" summary section.
_Avoid_: file list, mentioned files (a file in prose is not a verified file; verified means extracted from a tool call)

**Session type**:
The inferred classification of the session (implementation / debugging / review / discussion) that shapes the summary's emphasis.
_Avoid_: mode, category (it is a four-value inference over the session, not a setting)

**Degradation guarantee**:
The invariant that any failure inside the hook (no model, no key, LLM error, thrown exception) yields `undefined`, so the host falls back to its built-in compaction — `/compact` never breaks.
_Avoid_: fallback mode, error handling (it is a specific always-safe contract with the host, not a general strategy)
