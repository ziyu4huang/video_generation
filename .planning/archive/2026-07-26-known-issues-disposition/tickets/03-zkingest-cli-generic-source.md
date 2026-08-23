---
type: grilling
blocked by: []
status: closed
resolved: 2026-07-26 (PR pending)
---

# 03 — zk-ingest CLI --source generic surface gap

## Decision

**fix.** (Grilled 2026-07-26; user accepted the fix recommendation after first
leaning accept — settled on fix.)

## Findings (fact-finding, branch behind:0)

- `SourceFamily = "workflow-jsonl" | "hermes" | "auto-memory" | "generic"`
  (`pi-agent-ext-knowledge-card/src/ingest.ts:94`) — 4 values.
- Tool path (`host-fns.ts:110`) + `adaptGenericMarkdown` (`ingest.ts:584`) fully
  support `generic`.
- CLI `bun-apps/pi-agent-cli/src/commands/zk-ingest.ts:24` — `KNOWN_SOURCES`
  lists only **3** (`workflow-jsonl | hermes | auto-memory`); `generic` omitted.
- CLI dispatch (`run()`): `hermes` / `auto-memory` have dedicated branches; a
  `generic` value would **fall through to `parseKnowledgeJsonl`** (wrong — generic
  `.md` is not jsonl). So the gap is **two sites**: the set AND the dispatch,
  plus 2 help-text spots.
- `adaptGenericMarkdown(content, filePath)` → `KnowledgeRecord | null`,
  **one-record-per-file** (mirrors `auto-memory`, not `hermes`). Returns null
  only for truly empty files.

## Spec (fix — no open design choices remain)

1. `KNOWN_SOURCES` ← add `"generic"`.
2. `import { adaptGenericMarkdown }` alongside the existing
   `adaptAutoMemoryMarkdown` / `adaptHermesMarkdown`.
3. dispatch: add `else if (source === "generic")` branch **mirroring
   `auto-memory`** (one record per file; null → parseError), differing only in:
   call `adaptGenericMarkdown(content, abs)` (passes the abs path for slug/title
   fallback), null message ~ "not a markdown file with content".
4. help text ×2: the `--source` flag comment (line ~31) + the Options block in
   `details` — append `| generic`.
5. test: CLI accepts `--source generic` (no throw) AND routes correctly — feed a
   plain `.md` (not jsonl, not hermes, not auto-memory shape) → yields a card via
   the generic adapter, not swallowed/mis-parsed by `parseKnowledgeJsonl`.

## Proof bar

disable→fail→restore→pass (same as #839/#841/#843/#850): with the dispatch
branch removed, the test must fail (generic `.md` mis-routed to jsonl parser →
no/wrong records); with it restored, pass.
