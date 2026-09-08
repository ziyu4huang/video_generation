# Ticket 07 — docs + close-out

## Goal

Docs truth-synced with the shipped lanes; PR through the devops chain; arc
closed per the hands-off gate.

## Files

- `skills/file2md/SKILL.md` (format × mode matrix incl. svg/html-figures/pptx
  rows; truth rules: renderer availability, vision = interpretation not
  ground truth, auto = no VLM)
- `docs/architecture.md`, `docs/configuring-vision-models.md` (glm-5.3-flash
  tier example), `extensions/file2md.ts` (tool description formats list)
- `.planning/2026-09-08-file2md-svg-pptx-vision/map.md` (close-out +
  Shipped-as + reciprocal back-links)

## Done when

- [x] docs updated and consistent with the tests
- [x] PR via devops CLIs (branch prepared, local_ci green, squash-merge,
      merge scope verified)
- [x] map closed: Shipped-as filled, tickets resolved
- [x] successor `output/next-goal-<ts>.md` written + validated +
      LATEST re-pointed BEFORE reporting done (self-reflect-next-goal v2)

## Resolution

closed: 2026-09-08 — SKILL.md (mode/format tables, visual-formats section,
truth rules incl. the cloud-vision exception), docs/architecture.md (pipeline
diagram + render-seam paragraph), docs/configuring-vision-models.md (glm-5.3
-flash cloud section), extension tool description. Independent reviewer
APPROVE (12 nits, 6 fixed in-branch — recorded in map Shipped-as). local_ci
change-scoped PASS (ADR-citation + skill-frontmatter failures fixed en
route: qualified ADR citations, YAML colon in frontmatter). PR #2220
squash-merged CLEAN; verify-merge CLEAN. Close-out docs PR follows; successor
next-goal written + validated per the hands-off gate.
