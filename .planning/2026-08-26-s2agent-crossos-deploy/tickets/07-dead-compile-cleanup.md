---
type: task
status: open
---

# 07 — Dead `--compile` compat-code cleanup on the deploy path

## Question

Can the ~14 source sites carrying `--compile`-mode compatibility be deleted
now that no producer builds compiled artifacts (retired 2026-08-23 #1866) —
and does their removal simplify the cross-OS work (fewer execPath/bunfs
assumptions to audit for Windows)?

## Notes for the resolver

- Recon-cited sites: `mode.ts:21` "binary" mode, `superpowers.ts:100-112`
  $bunfs detection, `spawn-subagent-subprocess.ts:60-94`, `ext-deps.ts:14`,
  `static-extensions.ts:3`, `host-modules.ts:75-78`,
  `ultracode workflow-pack.ts:156` + ADR-0003, `archify run.ts:67`.
- SAFETY: verify each site is truly dead (grep for producers of the
  "binary"/compiled shape — the 2026-08-23 effort deleted the last ones;
  retention dirs on disk are not producers). Anything with a live test
  pinned to it gets its test updated or the site kept with a citation.
- This is the effort's simplification fold-in per D1 — deploy-path sites
  only; do not scope-creep into the broader monorepo weight items.
