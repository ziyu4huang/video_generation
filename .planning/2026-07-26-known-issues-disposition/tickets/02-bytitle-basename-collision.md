---
type: grilling
blocked by: []
status: open
---

# 02 — byTitle basename collision policy

## Question

`byTitle` maps a title/basename key to a SINGLE path. Two notes sharing a
basename (`A/Foo.md`, `B/Foo.md`) alias to one `byTitle["foo"]` slot —
last-indexed-wins; reindexing one can steal the key, and deleting the winner then
leaves the survivor **unresolvable by basename**. KNOWN-ISSUES flags this as
inherent ambiguity of basename/title linking.

**Decision: fix / mitigate / accept-as-wontfix?**

- Candidates if not pure accept: resolve basename collisions to a
  **disambiguation set** (return the list, let the caller pick); **warn** on
  collision at index time; or scope `byTitle` to title-only (drop basename keys).
- If **accept**: one-line rationale.

## Read first

- `src/lib/index.ts`: how `byTitle` is BUILT (title vs basename keys) and where
  it's CONSUMED.
- `resolveWikiLink` + the `[[link]]` resolution path: does a basename collision
  actually surface to the user (wrong target / dangling), and how often in
  practice?
- Whether any test already exercises a basename collision.
