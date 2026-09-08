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

- [ ] docs updated and consistent with the tests
- [ ] PR via devops CLIs (branch prepared, local_ci green, squash-merge,
      merge scope verified)
- [ ] map closed: Shipped-as filled, tickets resolved
- [ ] successor `output/next-goal-<ts>.md` written + validated +
      LATEST re-pointed BEFORE reporting done (self-reflect-next-goal v2)
