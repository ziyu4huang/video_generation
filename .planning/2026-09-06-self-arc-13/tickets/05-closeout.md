---
id: t05
effort: 2026-09-06-self-arc-13
status: open
phase: 3 — close-out
estimate: S
depends: t04
---

# t05 — close-out: Shipped-as, cross-links, docs note, successor next-goal

## Scope

- Map: `status: done`, `## Shipped-as` (implementation PR # + docs PR #, artifact paths,
  receipt sweep paths, gates result); reciprocal Cross-effort links added to
  `2026-09-06-subagent-tui-cc-parity-2`, `2026-09-06-learnings-hardening`,
  `2026-09-06-self-arc-12`, `2026-09-06-self-arc-9` maps.
- Docs close-out PR (separate, as always): a short note ONLY if the recommendation
  warrants durable docs (e.g. one paragraph in ext-subagent README's harness section
  pointing at the bench + results); otherwise map-only.
- Successor next-goal (strict v2, validated, `LATEST-next-goal.md` repointed): if the
  incumbent won → next arc per the loop's queue; if a challenger won → the goal IS the
  migration recommendation (production harness port, its own effort) — NOT an in-arc
  rewrite (D7).
- Learnings skill: append dated entries for any NEW confirmed quirk (expected candidates:
  script(1) relay behavior, tmux capture-settle, deployed rpc divergences).
- Memory retention per session-closeout-sop.

## Done-when

Implementation PR merged (devops CLI flow), docs PR merged, map done + Shipped-as,
back-links present on all four referenced maps, successor next-goal passes the validator,
no untracked `.planning/2026-09-06-self-arc-13/` residue.
