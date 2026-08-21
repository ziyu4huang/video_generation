# Upstream lessons from pi-smart-compact

This extension borrows design ideas from
[`pi-smart-compact`](https://github.com/alpertarhan/pi-smart-compact) (studied at
`~/proj/pi-smart-compact`, read-only) — a verification-oriented compaction
pipeline for the Pi Coding Agent. That project is far larger in scope; this
document records what we took, what we deliberately left behind, and why.

## EESV ten-stage layering → one LLM call here

Upstream threads a typed stage machine through **ten stages**
(`ARCHITECTURE.md`: extract → window → … → verify → persist, each stage adding a
`_prepared` / `_windowed` / … discriminator so reordering is a type error). The
top-level shape is EESV: **Extract** (0 LLM calls, deterministic ground truth) →
**Explore** (adaptive, thorough-mode only) → **Synthesize** (single-pass or
bounded hierarchical) → **Verify** (+ repair to a fixed point).

We keep the *ordering principle* — facts first, synthesis second — but collapse
it to one LLM call: the deterministic extractors (`file-ops`, `user-messages`,
`session-type`) run first and are injected into the prompt as ground truth
(`<verified-files>`, `<user-messages>`), then a single `completeSimple` call
produces the summary. No Explore stage, no hierarchical synthesis, no LLM
repair pass. Why that suffices here: s2-agent sessions are single-branch and
moderately sized, and the host (not us) owns the cut point and retry policy, so
the marginal quality of extra stages buys complexity we cannot pay down at this
package's ambition level.

## Yield gate — deliberately not ported

Upstream refuses the *whole* custom compaction unless the final summary meets
its mode target and at least **10% estimated net savings**, measured both before
synthesis and after the summary is produced — preferring a deterministic
zero-gap fallback over unverifiable model output. We do not port this. Our
degradation contract is coarser and host-mediated: any failure inside the hook
returns `undefined` and the host runs its built-in compaction. A summary that
compresses poorly but is *accurate* is still better than discarding it, and
token budgets are already enforced via `maxTokens = COMPACT_MAX_TOKENS_FACTOR ×
reserveTokens`. If the A/B harness later shows systematically worse compression,
a yield gate is the natural follow-up — measured from the report data, not
guessed.

## Canonical structured-section parsing vs substring checks

Upstream's canonical summaries use a fixed H1/H2/H3-aware structure with section
constants (e.g. `SECTION_GOAL = "## Goal"` in `src/constants.ts`), and its
verifiers match against those canonical headings — as opposed to fragile
`includes("## goal")` substring checks that accept any casing/position. We adopt
the same lesson on both ends: the prompt enumerates the nine exact section
titles (`SECTION_TITLES` in `src/prompt.ts`) and asks for `<analysis>` then
`<summary>` tags, and the extractor (`extractSummary`) pulls the summary from
the `<summary>…</summary>` tag pair rather than substring-matching headings.
Falling back to the raw response when the tag is absent keeps degradation
graceful instead of failing the whole compaction.

## Pending-slot / branch-provenance tracking

Upstream maintains a `PendingSlot` — a short-lived staged summary committed only
after the matching native `session_compact` event — plus immutable
project/session/branch-head snapshots so sibling branches never inherit a
last-writer identity, and cross-session recall scoped to the exact branch
ancestry. We do none of that. s2-agent's `session_before_compact` is
synchronous-with-await: whatever we return is applied by the host in the same
compaction, so there is nothing to stage or later reconcile. Branch continuity
is handled by recording what the host needs to introspect — `details.engine`
(`"cc-style"`), `sessionType`, file counts, user-message count — on the
compaction entry the host appends. If multi-branch sessions with divergent
compactions become a real workload, upstream's pending-slot state machine is the
reference design.

## If A/B shows hallucination pressure: verify/repair loop

The A/B harness (`scripts/ab.ts`) emits, per session, a deterministic `factSet`
(paths, user requests, error strings) that both summaries should recall — the
input for offline blind judging. If judging shows the CC-style arm inventing
paths or claiming unverified "Done", the data-backed follow-up is upstream's
Verify stage in miniature: deterministically diff the summary against the
extracted ground truth (`file-ops`, `user-messages`), strip or demote
unsupported claims (fabricated paths to "Pending Tasks", unsupported "Done" to
in-progress), and only if gaps remain, retry once with the violations quoted
back into the prompt. Upstream's finding that deterministic repair resolves
most gaps for free — the LLM patch is a last resort — should carry over.

## Summary table

| Upstream mechanism | Here |
| --- | --- |
| Ten-stage typed EESV pipeline | Deterministic extract → 1 LLM call (`summarizeCcStyle`) |
| ≥10% net-savings yield gate | Not ported; host fallback on any failure |
| Canonical section structure + verifier | Exact `SECTION_TITLES` + `<summary>` tag extraction |
| PendingSlot + branch provenance | `details.engine` on the host-appended compaction entry |
| Verify/repair to fixed point | Follow-up only, gated on A/B `factSet` evidence |
