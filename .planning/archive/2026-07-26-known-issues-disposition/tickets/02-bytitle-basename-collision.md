---
type: grilling
blocked by: []
status: closed
resolved: 2026-07-26 (accept-as-wontfix; PR pending)
---

# 02 — byTitle basename collision policy

## Decision

**accept-as-wontfix** (grilled 2026-07-26; user accepted recommendation).
The collision is inherent to `Map<string, string>` (one path per key). All
non-accept options are disproportionately costly for a ~0.2%-of-basenames
scenario that only bites boilerplate files (README/Index/progress), never
Zettelkasten notes (zk_card's 4-layer dup check enforces unique titles). The
`unindexNote` guard (line 442) already prevents the worst variant (loser
clobbering winner). Path-qualified links are always a correct workaround.

## Fact-finding (2026-07-26, branch synced to 9d77c3e0)

### Mechanism (confirmed in code)

`titleKeysFor(meta)` (`src/lib/index.ts:388`) registers a note under THREE key
kinds: its lowercased H1 title, its lowercased path-without-ext, AND its bare
basename. So `A/Foo.md` (title "Foo") and `B/Foo.md` (title "Foo Too") both
register the bare key `"foo"` → **last-indexed-wins** (a single `Map<string,string>`).

`resolveLink(idx, target)` (line 468): exact → basename fallback. A bare `[[Foo]]`
on a collision returns ONE note — no way to tell the caller "ambiguous".

### Empirical repro (bun script, `index.ts` in isolation)

Two notes `A/Foo.md` (# Foo) + `B/Foo.md` (# Foo Too):
- `byTitle["foo"]` = `B/Foo.md` (last indexed wins)
- `byTitle["a/foo"]` = `A/Foo.md`, `byTitle["b/foo"]` = `B/Foo.md` (path keys safe)
- `resolveLink("Foo")` → `B/Foo.md` (ambiguous, single winner silently picked)
- `resolveLink("A/Foo")` → `A/Foo.md` (path-qualified always correct)

**Steal scenario (ticket claim 1):** reindexing `B/Foo` does NOT steal the key
from A in the build order I tested — B was already the winner. ✅ the ticket's
"reindexing one can steal the key" is real but only in the direction
loser→winner; the `unindexNote` guard (`if (byTitle.get(k) === path)` line 442)
correctly avoids a reindexed loser clobbering the winner.

**Orphan scenario (ticket claim 2):** deleting the winner (`B/Foo`) leaves
`byTitle["foo"]` = undefined even though `A/Foo` still exists. ✅ CONFIRMED:
`resolveLink("Foo")` returns undefined — survivor is **unresolvable by bare
basename** until a full rebuild. Path-qualified `resolveLink("A/Foo")` still
works.

### Frequency in real vaults (severity calibration)

| vault | total .md | basenames with collisions |
|---|---|---|
| study-news | 100 | 1 (`SKILL.md` ×6) |
| pi-agent-vault | 2333 | 5 (`progress.md` ×4, `README.md` ×2, `Index.md` ×2) |

Collisions are **rare in the knowledge vault** (~0.2% of basenames) and involve
boilerplate files (`README`, `Index`, `progress`) — not Zettelkasten notes,
which are named uniquely by design (`zk_card`'s 4-layer dup check enforces
unique titles). The collision class is real but low-severity in practice.

### What actually breaks

1. **reverse-adjacency / backlinks** (`rebuildReverseAdjacency` line 235): a
   `[[Foo]]` link in a third note resolves to the winner; the loser never gets
   that backlink. Silent — user sees incomplete backlinks for the loser.
2. **dead-link scan** (`zettel.ts:64`): a bare-basename link to the SURVIVOR
   after the winner is deleted reads as "dead" even though the note exists.
3. **graph traversal** (`graph.ts`): same — wrong or missing target.

Path-qualified links (`[[A/Foo]]`, `[[folder/Foo]]`) are always correct — the
collision only bites bare-basename links.

## Question

**Decision: fix / mitigate / accept-as-wontfix?**

The collision is INHERENT to storing `Map<string, string>` (one path per key).
The only non-accept options trade complexity for a low-severity, rare scenario:

- **disambiguation set**: `byTitle: Map<string, Set<string>>` + `resolveLink`
  returns `string[]` → ripples through 6 consumers (graph, zettel, 3 index
  sites) + breaks the `resolveLink: string | undefined` contract.
- **warn on collision** at index time: cheap, surfaces the issue, no behavior
  change. Low value if the scenario is already rare.
- **scope byTitle to title-only** (drop basename keys): breaks the documented
  basename-fallback feature (`vaultIndex.test.mjs:65` asserts it) — regression.

My read: **accept-as-wontfix** with the empirical data recorded (like 01). The
scenario is real, rare (~0.2% of basenames, boilerplate files not notes), and
all non-accept options are disproportionately costly for the severity. The
`unindexNote` guard already prevents the worst variant (loser clobbering
winner). Document the orphan-survivor caveat + "use path-qualified links" as
the workaround.

→ **ACCEPTED.** KNOWN-ISSUES entry updated with the orphan-survivor caveat +
path-qualified workaround + the empirical frequency data.
