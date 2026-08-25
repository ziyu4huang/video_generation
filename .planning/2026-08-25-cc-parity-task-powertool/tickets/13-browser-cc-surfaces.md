# Ticket 13 — Browser CC surfaces: find, dialogs, network

Status: pending

## Why

The `browser` tool is ahead of CC's playwright MCP on token economy
(compression, prune modes, refuse-not-truncate, diff store, audit trail)
but lacks three CC surfaces: `browser_find` (cheap substring search over
the last snapshot instead of re-reading the whole tree), first-class dialog
handling (a `page.on("dialog")` handler must be registered inside one-shot
user code BEFORE the triggering action — invisible and error-prone), and
network-request inspection (`page.on("response")` callbacks don't feed the
single returned value cleanly).

## Scope

1. **find**: an option on `snapshot` (or a `find(text)` global) over the
   per-(page,scope) snapshot store (browser-tool.ts:298-303) — substring or
   regex, returns matching lines with refs + count, never re-renders the
   tree; priced like a scoped re-read.
2. **Dialogs**: install a persistent `dialog` handler at page creation
   recording the latest pending dialog into tool state; `snapshot` output
   gains a `⚠ dialog: <message>` header line while one is pending; a
   `handleDialog(accept, promptText?)` global resolves it. No auto-accept.
3. **Network**: a bounded per-page request log (method, url, status,
   resource-type; cap N=200, ring semantics like pathology's accumulator);
   a `requests(filter?)` global returning the tail; optional
   `await responseBody(index)` for one entry with a size cap.
4. **Skill doc**: one "when to use which" line in
   `skills/playwright-cli/SKILL.md` (the parallel stack stays — deliberate
   per its frontmatter — but the overlap gets a routing sentence).
5. Tests: Chrome-gated integration for each surface (the existing
   browser-tool.test.ts shapes) + pure seams where extractable (filter
   matching, log ring).

Not in scope: the playwright-cli skill's own machinery; snapshot
compression changes; browser download/upload flows.

## Done-when

- [ ] find / dialog header + handleDialog / requests tail all work in
      Chrome-gated integration tests on this box.
- [ ] Skill doc carries the routing line.
- [ ] Canonical gates green; spec.md §1 browser row updated; PR merged
      CLEAN.
