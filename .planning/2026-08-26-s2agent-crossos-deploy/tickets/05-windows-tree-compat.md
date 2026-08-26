---
type: task
status: open
blocked by: 03
---

# 05 — Windows tree-layout compatibility

## Question

Which deploy-tree mechanics break on Windows and what replaces each:
`current` symlink (junction? directory copy?), colon-PATH (`:280`), `$HOME`
fallback (`:257`), `chmod a-w` freeze (`fs.ts:41-44`), `env(1)` exec,
`cp -cR` clone (BSD-only, has fallback), hardlink caches (`.cores`/`.buns`
— NTFS hardlinks exist for files), launcher exec perms?

## Notes for the resolver

- Split the work: BUILD-side mechanics (hardlinks, cp -c, freeze) run on the
  mac host and mostly stand; TREE-side mechanics (what the target OS touches
  at runtime) are the real port surface — classify each hit before changing
  anything.
- `verify-portability.ts` already scans for `C:\Users\` leaks — keep it
  green for the Windows templates.
- Gate 5a (no symlink resolves outside tree) needs a junction-aware reading.
