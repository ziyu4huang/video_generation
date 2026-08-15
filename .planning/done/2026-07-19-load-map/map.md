> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-19-load-map

## Destination

Hand off wayfind to superpowers — document their relationship as a purely conceptual dependency, with no code integration.

## Notes

Domain: documentation-only. Skills: none needed beyond basic file editing. Effort is small — two README updates across sibling packages in the monorepo.

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then open the link for the detail the ticket holds -->

- [Document wayfind README with superpowers umbrella](tickets/01-document-wayfind-readme-with-superpowers-umbrella.md) — added a blockquote "Part of the Superpowers ecosystem" line under the title; linked sibling README via relative path
- [Document superpowers README with wayfind reference](tickets/02-document-superpowers-readme-with-wayfind-reference.md) — added a `## Related packages` section between "How it works" and "Layout" linking to wayfind

## Not yet specified

<!-- Fog — work you can tell is coming but can't yet ticket precisely -->

_(none — scope is fully captured by the two tickets below)_

## Out of scope

<!-- work ruled beyond the destination; closed tickets that fell out of scope -->

- Code integration or runtime coupling
- Moving skills between packages
- Merging packages
- Adding npm dependencies
- Any changes to `src/`, `extensions/`, or `skills/` content
- Cross-package CONTEXT.md alignment
- Automated tests
