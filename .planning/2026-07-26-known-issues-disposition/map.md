# Wayfinder map: 2026-07-26-known-issues-disposition

## Destination

A settled **disposition** for each of the 5 open observations recorded in
`bun-apps/pi-agent-ext-obsidian/docs/KNOWN-ISSUES.md` ("Remaining non-bug notes",
2026-07 deep audit) — for each: **fix** (spec to one-PR granularity) / **mitigate**
(partial or doc) / **accept-as-wontfix** (one-line rationale). **Planning only —
this map decides, it does not build.** Ends when all 5 tickets are closed and the
dispositions are reflected back into KNOWN-ISSUES.md as either Resolved or Accepted.

## Notes

- **Scope origin**: the 5 observations were surfaced by the 2026-07 parallel deep
  audit. The confirmed BUGS already merged as #839 / #841 / #843 / #845 / #850;
  these 5 are the remaining DESIGN observations, explicitly *not* bugs.
- **Two are flagged inherent** (basename collision, asymmetric re-ingest edges) —
  their likely disposition is accept/mitigate, but each ticket investigates
  honestly before locking.
- **Skills every session should consult**: `grilling` + `domain-modeling` (each
  ticket is a HITL decision, resolved one at a time).
- **Bar for any "fix" disposition**: test-proven (disable→fail→restore→pass),
  one-observation-per-PR, matching #839 / #841 / #843.
- **Convention**: project decisions live here in `.planning/` (wayfinder), not the
  `memory` tool.
- Conversational language: 繁體中文; all written artifacts: English.
- **Slug note**: the invocation auto-derived its slug from the (already-completed)
  follow-up text; renamed to `known-issues-disposition` to avoid a false-premise map.

## Decisions so far

- **01 = accept-by-design** (grilled 2026-07-26): the `saveIndex` persist gap
  is a non-issue once measured. `loadCachedIndex` mtime-validates every note and
  re-reads only changed files — it does NOT re-scan (the ticket draft's
  assumption was wrong). Bench (3000 notes): typical 1%-stale cold start = 49ms
  vs 47ms fresh = **~2ms cost**, below noise; even 100%-stale = 155ms ≈ full
  build (persistence wouldn't help there either). Fixing needs throttling + a
  coherence test for <5ms — not worth it. KNOWN-ISSUES wording corrected to say
  "re-read changed files" not "re-scan" + bench numbers recorded. No code
  change; doc-only.
- **03 = fix** (grilled 2026-07-26): `zk-ingest` CLI gains `generic` in
  `KNOWN_SOURCES` + a dispatch branch mirroring `auto-memory`
  (one-record-per-file via `adaptGenericMarkdown`) + help text ×2 + a CLI test.
  Fact-finding found the gap is **two sites** (set + dispatch), not the
  single-line the map draft assumed — `generic` would otherwise fall through to
  `parseKnowledgeJsonl`. Merged as PR #858 (commit 52cd5fdb).
- **05 = fix** (grilled 2026-07-26): `distill/state.ts:readState` wrapped its
  bare `JSON.parse` in try/catch — a corrupt `.distill-state.json` used to throw
  *after* `runConverge` had already written cards (partial converge + no result
  returned). Recovery = **reset to empty default** (same as a missing file);
  converge completes and the subsequent `writeState` overwrites the corrupt
  file → self-healing, mirroring `loadCachedIndex`'s mtime philosophy (01).
  Proof: corrupt-file test fails with `SyntaxError` when fix removed. Executing
  as its own PR.

## Not yet specified

- If two or more "fix" dispositions touch the same module (e.g. #01 saveIndex +
  #02 byTitle both in `index.ts`), whether to batch into one PR or keep strict
  one-per-PR — defer until dispositions land.
- Whether accepted/wontfix items get a distinct `## Accepted` section in
  KNOWN-ISSUES.md vs folding into `## Resolved (history)` — defer to the closing
  session.

## Out of scope

- **Re-running the deep audit for new bugs** — this map dispositions the 5
  already-recorded observations only. New findings ⇒ a fresh effort.
- **Executing the fixes** — decision-first per the grilled destination; any "fix"
  disposition hands off to a build session as a spec, not carried in this map.
