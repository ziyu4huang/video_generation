# 05 — package.json manifest entry points at a non-existent file

---
type: grilling
blocked by:
status: closed
claimed: pi-session (2026-07-21)
---

## Question

`package.json` declares `"pi": { "extensions": ["./extensions/index.ts"] }`,
but `extensions/` contains only `superpowers.ts` — there is no `index.ts`.
It's a latent bug that doesn't bite at runtime: the extension is
**static-registered** in `pi-agent/src/static-extensions.ts`
(`import superpowersExtension from "../../pi-agent-ext-superpowers/extensions/superpowers.ts"`),
so the `pi.extensions` manifest entry is never read. But it's stale and
violates the repo's own convention (CLAUDE.md: canonical entry is
`extensions/<X>.ts`, never `extensions/index.ts`).

Decide the fix:

- **Correct the path** — `["./extensions/superpowers.ts"]` (aligns with the
  convention and the static-import path).
- **Remove the entry** — static registration is the source of truth; drop
  `pi.extensions` entirely so there's one place, not two.

Small decision; recommend correcting the path (keeps the manifest honest for
any future dynamic-load consumer, and matches the convention).

## Resolution

**Correct the path** to `["./extensions/superpowers.ts"]`. Keeps the
`package.json` manifest honest (a real file, matching the static-import path in
`pi-agent/src/static-extensions.ts`), aligns with the repo convention
(`extensions/<X>.ts`), and works for any future dynamic-load consumer without
changing the live static-registration path. Execution: one-line edit in
`package.json` `pi.extensions` — folds into the downstream execution effort.
