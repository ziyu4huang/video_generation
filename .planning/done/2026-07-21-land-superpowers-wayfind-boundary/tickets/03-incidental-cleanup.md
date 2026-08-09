# 03 — Incidental cleanup (package.json manifest + sync-source docs)

---
type: task
status: closed
---

## Question

Two small, independent hygiene fixes surfaced by the boundary audit, both in
`pi-agent-ext-superpowers`: a dead `package.json` manifest path, and an
undocumented sync-source relationship.

## What to build

1. **`package.json` manifest path** — `pi.extensions` currently points at
   `["./extensions/index.ts"]`, a file that does not exist (only
   `extensions/superpowers.ts` does). The extension is static-registered in
   `pi-agent/src/static-extensions.ts`, so the manifest entry is never read —
   but it's stale and violates the repo convention
   (`extensions/<X>.ts`, never `index.ts`). Correct it to
   `["./extensions/superpowers.ts"]` (matches the static-import path).

2. **Sync-source documentation** — `scripts/update-superpowers.sh` syncs from
   the Claude plugin cache (`~/.claude-glm/plugins/cache/...`); the git origin
   `obra/superpowers` is checked out at `../superpowers/` for reference only
   (used by research, never a sync source). Add:
   - a comment block at the top of `update-superpowers.sh` stating the plugin
     cache is the canonical sync source and `../superpowers/` is reference-only;
   - a one-line note in the package `README.md` to the same effect, so no one
     later treats the git checkout as the sync source.

## Acceptance

- [ ] `package.json` `pi.extensions` → `["./extensions/superpowers.ts"]`;
      the path exists on disk; `bun run check` green
- [ ] `update-superpowers.sh` carries the canonical-source comment
- [ ] `README.md` carries the reference-only note
- [ ] No behavioral change (static registration unchanged; sync script logic
      unchanged — docs only)
