---
type: grilling
blocked by: []
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (DO — L2 reviews all changed paths, drop the tsJs ternary)
---

# 05 — Decide: L2 input file set (tsJs-scope oddity)

> Surfaced 2026-07-31 while grounding ticket 04 (L2 large-diff curation). It is a
> distinct L2 **coverage** bug — not truncation — so it gets its own ticket.

## Question

`watchdog.ts` builds the L2 input as:

```ts
const tsJs = changedTsJsPaths(input.before, after);
const diffText = diffTextForReview(input.cwd, tsJs.length ? tsJs : after.changedPaths);
```

So when **any** TS/JS file changed, L2 reviews **only** the TS/JS diff — non-TS/JS
**code** changes (Python, etc.) are **invisible to L2**. L2 only sees *all* changed
paths when *zero* TS/JS changed. For this polyglot repo (Python ML pipeline in
`python/mlx-movie-director/`), a mixed TS/JS+Python change → the Python edit is
unseen by L2. (L1 has the same language gap — ticket 02 fixes that for L1.)

Decide `do / defer / skip` + what file set L2 should review. L2 is a **model**
(language-agnostic), so the constraint here is intent, not capability:

- **(a) All changed paths** (`after.changedPaths`) — review everything that changed.
- **(b) Code-only set** — TS/JS + Python + other code langs, excluding docs/config
  (`.md`, `.json` configs, etc.). Needs a code-ext set broader than `TS_JS_EXT`.
- **(c) Status quo** (`tsJs.length ? tsJs : after.changedPaths`) — defer.

Note `changedTsJsPaths` stays correct for **L1** (L1 is a language server, TS/JS-only
until 02 generalizes it) — this ticket is only about **L2's** input set.

## Resolution (grilled 2026-07-31)

**Decision: DO — L2 reviews all changed paths (`after.changedPaths`); drop the
`tsJs.length ? tsJs : ` ternary.**

### Grounding (read `watchdog.ts` L58-71)

- L71 `diffTextForReview(input.cwd, tsJs.length ? tsJs : after.changedPaths)`: on a
  **mixed** TS/JS + Python change, `tsJs` is non-empty → L2 sees **only** the
  TS/JS diff → Python invisible. Pure-Python change → `tsJs` empty → the fallback
  shows all (accidentally correct). So the bug bites mixed changes — common here
  (subagent editing a bun-app **and** the python ML pipeline together).
- L2 is a **model** (language-agnostic) — there is no capability reason to filter
  by language; the `tsJs` filter is a TS/JS-centric legacy from the pi-subagents
  port. L1 (L62) uses `tsJs` and **stays** — L1 is language-specific (tsserver;
  after 02, the LSP-provider registry), and its set is 02's concern, not 05's.

### Spec (handoff)

1. **Drop the ternary**: `diffTextForReview(input.cwd, after.changedPaths)`. L2
   reviews everything that changed, any language.
2. **L1 unchanged**: still `runLspDiagnostics({ changedPaths: tsJs })`.
3. **Coherence with 02**: after 02 (pyright) + 05, Python gets **both** L1
   (pyright types) **and** L2 (model diff) — symmetric with TS/JS today.
4. **Docs/config ↔ 04 budget**: docs (`.md`) and configs (`.json`/`.yaml`/`.toml`)
   now reach L2. They are bounded by **04's per-file budget** (1/N each — can't
   monopolize). If they prove wasteful, **expand 04's conservative noise filter**
   (deny-list: add docs/config) at impl time — that is a **04 refinement, not a 05
   decision**. (Deny-list preferred over a positive code-ext set — future-proof
   for new languages; avoids the "forgot to add `.rs`" trap.)

### Acceptance criteria (for the implementer)

- (a) **Mixed** TS/JS + Python change → L2 reviews **both** the TS/JS AND the
  Python diff (the regression 05 exists to fix).
- (b) Pure TS/JS change → L2 reviews the TS/JS (unchanged — `after.changedPaths`
  includes them).
- (c) Pure Python change → L2 reviews the Python (unchanged — the old fallback
  already did this).
- (d) L1 still uses `tsJs` (no regression to L1's language-specific dispatch).

### Graduates / defers

- **Docs/config budget** — deferred to a 04 noise-filter refinement (deny-list)
  if wasteful when 04+05 are implemented together.
- No new fog — the coverage axis is now fully specified.
