# movie-director gating hygiene (Spec B)

Date: 2026-08-10
Branch: `movie-director-gating-hygiene`
Predecessor: Spec A — tool-gating contract collapse (PR #1221, merged `31984859`)
Source: `.planning/specs/2026-08-10-tool-gating-contract-collapse-design.md` §"Spec B"

## Problem

Owner-declared `gating` objects are the unit of tool activation. `tool-gate`'s
`gatesWithSameGating` (`extensions/tool-gate.ts:350`) groups tools into
co-firing **sibling groups** by *fingerprint equality* — a JSON of the sorted
keywords plus sorted `requires.nouns` / `requires.verbs`
(`gateGatingKey`, `tool-gate.ts:330`).

Sibling membership is therefore maintained by **copy-paste**. Editing one
member's keyword list silently drops it out of its group: no type error, no
test failure, no runtime warning. The tool simply stops co-activating with its
siblings, and the only symptom is a tool that fails to appear when the user
expects it.

`movie` (`movie-director.ts:48`) and `movie_help` (`:90`) carry the same
16-keyword / 10-noun / 11-verb object duplicated verbatim in one file.

### Measured scope of the class

A pairwise probe over every non-core gated tool captured through
`MIGRATED_EXTENSIONS` (29 tools, 10 fingerprint groups) found the keyword
overlap distribution to be strictly **bimodal**: every overlapping pair is
fingerprint-identical (Jaccard 1.000, cover 1.000); every non-sibling pair
shares **zero** keywords. There are no partial overlaps today.

| Fingerprint group | Members |
| --- | --- |
| power-tool | `inspect_context` / `_agent` / `_extensions` / `_hooks` / `_pathology` / `_tui` |
| file2md | `file2md`, `vision_ask` |
| flux2 | `flux2`, `flux2_help` |
| krea2 | `krea2`, `krea2_help` |
| ltx | `ltx`, `ltx_help` |
| movie-director | `movie`, `movie_help` |
| research-tool (vault) | `collect_videos`, `organize_vault_notes`, `import_memory_to_vault` |
| research-tool (arxiv) | `arxiv_search`, `arxiv_paper`, `arxiv_fetch2md` |
| workflow + subagent | `workflow`, `workflow_help`, `workflow_control`, `subagent`, `subagents` |
| zai-mcp | `zai_web_search_web_search_prime`, `zai_web_reader_webReader` |

The movie pair is the *easiest* instance (both copies in one file). The
**workflow + subagent** group is the dangerous one: five members maintained by
copy-paste across **two packages**, where editing one side produces no signal
in the other.

### Secondary findings

- **`cost` prototype is permanently unwireable in its current form.**
  `extensions/movie-director-cost.ts` declares no `gating` and is absent from
  `bun-apps/pi-agent/run-dir/manifest.json`. Its dormancy is not an oversight —
  it is *locked* by `pi-agent-cli/src/__tests__/schema-cost.test.ts:224`
  (`expect(sources.has("movie-director-cost")).toBe(false)`) with a "do NOT
  re-add until wired" note. Separately, CLAUDE.md mandates exactly one
  registered extension per `pi-agent-ext-<X>/` folder, so this file can never
  become a second registered entry. `movie` already exposes
  `cost-estimate` / `-reserve` / `-reconcile` / `-snapshot`.
- **Stale `ungatedByDesign` exemption.** `drift-guard.test.ts` exempts
  `subagents` as "UNGATED before this migration and stays ungated to preserve
  behavior". That is now false: `subagents-tool.ts:216` declares the workflow
  family's gating. The exemption suppresses validation of a tool that *is*
  gated, and documents the opposite of reality. (`subagent_runs` genuinely has
  no gating; its exemption is correct.)
- **Stale schema-cost claim.** `src/dispatch.ts:320` asserts `movie` "is
  consistently the #1 schema-cost tool". Measured during Spec A: `movie` = 371
  tok (rank ~25), `movie_help` = 83, together 2.1% of the 21,124-token total,
  and both are gated so their cost at rest is zero.

## Design

### Unit 1 — movie-director local de-duplication

Extract a module-level `MOVIE_GATING` constant in
`extensions/movie-director.ts`; both `makeMovieTool()` and
`makeMovieHelpTool()` reference it. The explanatory comment collapses to one
copy on the constant.

The two tool defs then share one object *reference*. Before relying on that,
verify no consumer mutates `gating` in place (`gateGatingKey` copies via
spread, but the whole read path must be checked). If any mutation exists, use
`Object.freeze` and a defensive copy at the second call site instead.

Content reaching `defineTool` is byte-identical to today; no runtime number
changes.

### Unit 2 — delete the `cost` prototype

Remove `extensions/movie-director-cost.ts`,
`extensions/movie-director-cost.test.ts`, and `src/cost-dispatch.ts`; then
remove the scaffolding that exists only to hold it dormant:

- `pi-agent-cli/src/commands/schema-cost.ts:143` NOTE
- `pi-agent-cli/src/__tests__/schema-cost.test.ts:219-224` assertion
- `pi-agent-ext-tool-gate/qa/savings.ts:123` reference

Grep for remaining importers before deleting.

### Unit 3 — sibling-group drift guard (the substantive addition)

A new guard groups every non-core gate by fingerprint, then asserts that **no
two distinct groups share more than half of the smaller group's keywords**
(`cover = |A ∩ B| / min(|A|, |B|)` must be `< 0.5`).

- Catches the Spec B failure mode: editing `movie` but not `movie_help` leaves
  15 of 16 keywords shared across two now-distinct groups → cover 0.94 → fail,
  with a message naming both tools and stating they were previously siblings.
- Catches cross-package drift in the workflow + subagent group without
  introducing any new package dependency edge.
- Green today at 0 violations (all real overlaps are cover 1.0 *within* a
  group; all cross-group overlaps are 0).
- `0.5` rather than "any overlap fails" leaves room for two unrelated gates to
  legitimately share a keyword or two in future without an explicit exemption.

**Prerequisite refactor (empirically required).** `MIGRATED_EXTENSIONS` and
`captureRegisteredTools` currently live inside `drift-guard.test.ts`.
Importing that file from another test file was measured to **re-execute its 26
tests** inside the importer. So the new guard cannot import it.

Extract both into a non-test module `extensions/migrated-extensions.ts`
(exporting `MIGRATED_EXTENSIONS`, `captureRegisteredTools`, and the `ToolDef` /
`MigratedExtension` types). `drift-guard.test.ts` imports from it and re-exports
`MIGRATED_EXTENSIONS` for any existing consumer. The new guard lives in
`extensions/gating-siblings.test.ts`. This also splits the 564-line
`drift-guard.test.ts` along a real seam.

### Unit 4 — correct the stale exemption

Drop `subagents` from `drift-guard.test.ts`'s `ungatedByDesign` so the net
validates it, and rewrite the comment to state that `subagents` joined the
workflow fingerprint group. Keep `subagent_runs` exempt.

### Unit 5 — correct the stale schema-cost comment

Rewrite the `ROUTING_DESCRIPTION` doc comment at `src/dispatch.ts:320` with the
measured figures, and state the reason the slim routing description should
*stay* slim (the dispatcher/help split keeps the on-demand reference out of the
always-loaded schema) rather than the stale "#1 cost" justification.

## Testing

- `bun test` in `pi-agent-ext-tool-gate`, `pi-agent-ext-movie-director`,
  `pi-agent-ext-subagent`, `pi-agent-cli`.
- The new guard's own negative case: a synthetic pair of gates at cover ≥ 0.5
  with differing fingerprints must fail, proving the guard is not vacuous —
  the same mistake found in Spec A's dead acyclicity check.
- `bun run --cwd bun-apps/pi-agent-cli` schema-cost canary after the `cost`
  deletion.

## Known-unrelated baseline red

`file2md` 34 failing tests, `wayfind` 1, `hermes-memory` 1 — all pre-existing
as of 2026-08-10 and unrelated to this branch. Compared item-by-item against
the pre-change baseline to confirm unchanged; not fixed here.

## Out of scope

Full cross-package de-duplication of the workflow + subagent gating literal
into a shared constant.

**Not** because a dependency edge is missing — that edge already exists.
`bun-apps/pi-agent-ext-workflow/package.json:76` declares
`"@repo/pi-agent-ext-subagent": "workspace:*"`, and workflow already imports
RUNTIME values across it (`homeDir` in `src/workflow-paths.ts:11`;
`isWorkflowError` / `WorkflowError` / `WorkflowErrorCode` in
`src/host-fn-helpers.ts:10`; `activityGlyph` / `NO_THEME` / `shorten` in
`src/display.ts:8`). A shared gating constant could be imported the same way
today. (Recorded explicitly so a future reader does not re-derive this as a
blocker — an earlier draft of this section stated it as one, and it was wrong.)

The real reasons it is out of scope: the repo owner explicitly chose the
narrower option — the movie-local fix plus a repo-wide guard — over full
cross-package de-duplication when this scope was decided; doing it would edit
two other packages' tool declarations; and the Unit 3 guard makes the drift
detectable without it.
