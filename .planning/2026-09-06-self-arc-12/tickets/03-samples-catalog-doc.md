# Ticket 03 — CC-parity samples catalog doc

Status: open · Phase 2 · Rides the implementation PR (documents shipped samples)

## Goal

ONE committed markdown doc that is the user-facing map of the deliverable: every
sample → the exact CC doc section/pattern it mirrors (with URLs), how to run it,
and which receipt proves parity.

## Location (map D4)

`bun-apps/s2-agent/docs/cc-parity-samples.md` + one-line cross-links added to
`bun-apps/s2-agent-ext-subagent/README.md` and
`bun-apps/s2-agent-ext-ultracode/README.md`.

## Shape

- Header: what parity means here (green named assertions + live receipts, not prose).
- Two tables (subagents / workflows), one row per sample:
  `id · file path · CC pattern + doc section + URL · run command · parity receipt`.
  - Run commands: `( cd bun-apps/s2-agent-ext-subagent && bun test tests/cc-parity-subagent.test.ts )`
    etc.; Suite B scripts also show the `samples/run.ts` headless form.
  - Parity receipt = the specific assertion(s) (Suite A/B) or receipt.json checks
    (ticket 04) that fail if the pattern regresses.
- Descoped-row section: B3 (batch read-only constraint — s2-agent deviation, map D3)
  and B6 (mapped to existing `samples/kcard-converge-loop.js`).
- CC doc sections referenced (URLs):
  - https://code.claude.com/docs/en/sub-agents — "Common patterns" (isolate
    high-volume ops / parallel research / chaining), canonical code-reviewer
    example, background subagents, SendMessage resume, nesting ≤3.
  - https://code.claude.com/docs/en/workflows — the six example workflow prompts
    and the script primitives (`agent()`, `pipeline()`, `parallel()`, `phase()`,
    `log()`, `args`, `meta`, null-for-stopped).
- A short "not covered here" line for the CC features that are UI/policy rather
  than patterns (background notifications, nesting-depth limit) pointing at where
  they ARE covered (viewer/background-run-manager tests) — honest scope.

## Gates

Doc-only within this ticket; PR-level gates of whatever packages it rides with.
Links must be real paths (verify each file path cited exists in the PR tree).

## Done when

Every sample from tickets 01/02 and the t04 live receipt appears in a row; every
row's run command works verbatim from repo root.
